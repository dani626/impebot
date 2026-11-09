import { randomUUID } from 'node:crypto';
import mariadb from 'mariadb';
import { CONFIG } from '../config.js';
import {
  buildPermissionMap, checkPermission, digitsOf, encodeMessengerMessage, indexGroups, isNodeActive, metaNode,
} from './resolver.js';

const marks = (list) => list.map(() => '?').join(', ');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Conexión directa a la base MySQL de LuckPerms.
 *
 * - Identidad: el jugador se reconoce por su meta `whatsapp` o `discord`
 *   (`/lp user Steve meta set whatsapp 51987654321`).
 * - Permisos: se calculan con las mismas reglas que LuckPerms (ver resolver.js).
 * - Sincronización: el bot lee el messaging service SQL (`luckperms_messenger`) como un servidor más;
 *   cuando alguien cambia un rango, se borra la caché. Lo que escribe el bot se anuncia
 *   igual que lo haría un servidor, así que la red lo recarga al momento.
 */
export class LuckPermsService {
  constructor({ config = CONFIG.luckperms, createPool = (o) => mariadb.createPool(o), now = () => Date.now() } = {}) {
    this.config = config;
    this.createPool = createPool;
    this.now = now;
    this.pool = null;
    this.ready = false;
    this.lastMessageId = 0;
    this.pollTimer = null;
    this.polling = false;
    this.lastPollError = 0;
    this.sentIds = new Set();
    this.users = new Map(); // uuid → { at, permissions, groups }
    this.identities = new Map(); // "whatsapp:519..." → { at, player|null }
    this.groups = null; // { at, index }
    const prefix = String(config?.tablePrefix || 'luckperms_');
    if (!/^[A-Za-z0-9_]+$/.test(prefix)) throw new Error('LUCKPERMS_TABLE_PREFIX solo admite letras, números y _.');
    this.t = (name) => `\`${prefix}${name}\``;
    // Vínculos Discord ↔ Minecraft de DiscordSRV (tabla <prefijo>_accounts), opcional.
    this.dsrvPool = null;
    const dsrvPrefix = String(config?.discordsrv?.tablePrefix || 'discordsrv');
    if (!/^[A-Za-z0-9_]+$/.test(dsrvPrefix)) throw new Error('DISCORDSRV_TABLE_PREFIX solo admite letras, números y _.');
    this.dsrvAccounts = `\`${dsrvPrefix}_accounts\``;
  }

  get enabled() {
    return Boolean(this.config?.enabled);
  }

  get servers() {
    return this.config.servers || [];
  }

  async start() {
    if (!this.enabled || this.pool) return;
    const { db } = this.config;
    this.pool = this.createPool({
      host: db.host, port: db.port, user: db.user, password: db.password, database: db.database,
      connectionLimit: 3, acquireTimeout: 5000, connectTimeout: 5000,
    });
    try {
      const rows = await this.query(`SELECT MAX(\`id\`) AS latest FROM ${this.t('messenger')}`);
      this.lastMessageId = Number(rows[0]?.latest) || 0;
      this.ready = true;
      console.log(`✅ [LuckPerms] Conectado a ${db.database}@${db.host}:${db.port} (contextos: global, ${this.servers.join(', ') || '—'})`);
    } catch (err) {
      // Sin LuckPerms el bot sigue funcionando con las reglas de siempre (WA_STAFF_IDS, admins).
      console.error(`❌ [LuckPerms] No se pudo conectar: ${err.message}. Se usarán los permisos por defecto.`);
    }
    const dsrv = this.config.discordsrv;
    if (dsrv?.enabled) {
      this.dsrvPool = this.createPool({
        host: dsrv.db.host, port: dsrv.db.port, user: dsrv.db.user, password: dsrv.db.password, database: dsrv.db.database,
        connectionLimit: 2, acquireTimeout: 5000, connectTimeout: 5000,
      });
      try {
        const [row] = await this.dsrvPool.query(`SELECT COUNT(*) AS n FROM ${this.dsrvAccounts}`);
        console.log(`✅ [LuckPerms] Vínculos de DiscordSRV: ${Number(row?.n) || 0} cuentas (${dsrv.db.database}).`);
      } catch (err) {
        console.error(`❌ [LuckPerms] No se pudo leer DiscordSRV: ${err.message}. Solo se usarán vínculos de LuckPerms.`);
      }
    }
    if (this.config.pollIntervalMs > 0) {
      this.pollTimer = setInterval(() => void this.pollMessenger(), this.config.pollIntervalMs);
      this.pollTimer.unref?.();
    }
  }

  async stop() {
    clearInterval(this.pollTimer);
    this.pollTimer = null;
    const pools = [this.pool, this.dsrvPool];
    this.pool = null;
    this.dsrvPool = null;
    this.ready = false;
    await Promise.all(pools.map((p) => p?.end().catch(() => {})));
  }

  async query(sql, params = []) {
    if (!this.pool) throw new Error('LuckPerms no está conectado.');
    return this.pool.query(sql, params);
  }

  clearCache() {
    this.users.clear();
    this.identities.clear();
    this.groups = null;
  }

  fresh(entry) {
    return entry && this.now() - entry.at < this.config.cacheTtlMs;
  }

  // ---------------------------------------------------------------- mensajería

  /** Lee los avisos nuevos de la red y borra lo que haya quedado desactualizado. */
  async pollMessenger() {
    if (!this.pool || this.polling) return;
    this.polling = true;
    try {
      const rows = await this.query(
        `SELECT \`id\`, \`msg\` FROM ${this.t('messenger')} WHERE \`id\` > ? ORDER BY \`id\``, [this.lastMessageId],
      );
      if (!this.ready) {
        this.ready = true;
        this.clearCache();
        console.log('✅ [LuckPerms] Conexión recuperada.');
      }
      for (const row of rows) {
        this.lastMessageId = Math.max(this.lastMessageId, Number(row.id));
        this.handleMessage(row.msg);
      }
    } catch (err) {
      // Mientras no responda, se usan las reglas por defecto en vez de dejar a todos sin permisos.
      this.ready = false;
      if (this.now() - this.lastPollError > 60000) {
        this.lastPollError = this.now();
        console.error(`⚠️ [LuckPerms] Error leyendo luckperms_messenger: ${err.message}`);
      }
    } finally {
      this.polling = false;
    }
  }

  handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || this.sentIds.delete(msg.id)) return; // aviso propio
    if (msg.type === 'update') {
      this.clearCache();
    } else if (msg.type === 'userupdate') {
      const uuid = String(msg.content?.userUuid || '').toLowerCase();
      this.users.delete(uuid);
      // La meta (número vinculado) pudo cambiar: la identidad se vuelve a buscar.
      this.identities.clear();
    }
  }

  /** Anuncia a la red que un jugador cambió, igual que un servidor con messaging-service: sql. */
  async announceUserUpdate(uuid) {
    const id = randomUUID();
    this.sentIds.add(id);
    if (this.sentIds.size > 200) this.sentIds.delete(this.sentIds.values().next().value);
    await this.query(
      `INSERT INTO ${this.t('messenger')} (\`time\`, \`msg\`) VALUES (NOW(), ?)`,
      [encodeMessengerMessage(id, 'userupdate', { userUuid: uuid })],
    );
  }

  // ---------------------------------------------------------------- identidad

  /**
   * Jugador vinculado a cualquiera de estos identificadores.
   * @param {'whatsapp'|'discord'} platform
   * @param {string[]} ids números, LIDs o IDs de Discord
   * @returns {Promise<{ uuid: string, username: string, primaryGroup: string } | null>}
   */
  async findPlayer(platform, ids) {
    const key = this.config.metaKeys[platform];
    const values = [...new Set(ids.map(digitsOf).filter(Boolean))];
    if (!key || !values.length) return null;
    const cacheKey = `${platform}:${values.sort().join(',')}`;
    const cached = this.identities.get(cacheKey);
    if (this.fresh(cached)) return cached.player;

    const nodes = values.map((v) => metaNode(key, v));
    const rows = await this.query(
      `SELECT u.\`uuid\`, u.\`server\`, u.\`world\`, u.\`expiry\`, u.\`contexts\`, p.\`username\`, p.\`primary_group\`
       FROM ${this.t('user_permissions')} u LEFT JOIN ${this.t('players')} p ON p.\`uuid\` = u.\`uuid\`
       WHERE u.\`permission\` IN (${marks(nodes)}) AND u.\`value\` = 1`,
      nodes,
    );
    const opts = { servers: this.servers, now: Math.floor(this.now() / 1000) };
    const matches = [...new Map(rows.filter((r) => isNodeActive(r, opts)).map((r) => [r.uuid, r])).values()];
    if (matches.length > 1) {
      console.warn(`⚠️ [LuckPerms] ${platform} ${values.join('/')} está vinculado a varios jugadores (${matches.map((m) => m.username || m.uuid).join(', ')}). Se usa el primero.`);
    }
    const hit = matches[0];
    let player = hit ? { uuid: hit.uuid, username: hit.username || hit.uuid, primaryGroup: hit.primary_group || 'default', source: 'luckperms' } : null;
    // Un vínculo forzado en LuckPerms manda; si no hay, se usa el de DiscordSRV (/discord link en el juego).
    if (!player && platform === 'discord' && this.dsrvPool) player = await this.findDiscordSrvPlayer(values);
    this.identities.set(cacheKey, { at: this.now(), player });
    return player;
  }

  /** Jugador vinculado con DiscordSRV a alguno de estos IDs de Discord. */
  async findDiscordSrvPlayer(discordIds) {
    const rows = await this.dsrvPool.query(
      `SELECT \`uuid\` FROM ${this.dsrvAccounts} WHERE \`discord\` IN (${marks(discordIds)}) LIMIT 1`, discordIds,
    );
    const uuid = rows[0]?.uuid;
    if (!uuid) return null;
    const player = await this.findPlayerByName(uuid);
    // Vinculado en DiscordSRV pero sin datos en LuckPerms: se trata como jugador "default".
    return { ...(player || { uuid: String(uuid).toLowerCase(), username: uuid, primaryGroup: 'default' }), source: 'discordsrv' };
  }

  async findPlayerByName(name) {
    const clean = String(name || '').trim();
    if (!clean) return null;
    const where = UUID_RE.test(clean) ? '`uuid` = ?' : '`username` = ?';
    const rows = await this.query(
      `SELECT \`uuid\`, \`username\`, \`primary_group\` FROM ${this.t('players')} WHERE ${where} LIMIT 1`,
      [clean.toLowerCase()],
    );
    const r = rows[0];
    return r ? { uuid: r.uuid, username: r.username, primaryGroup: r.primary_group || 'default' } : null;
  }

  // ---------------------------------------------------------------- permisos

  async loadGroups() {
    if (this.fresh(this.groups)) return this.groups.index;
    const rows = await this.query(
      `SELECT \`name\`, \`permission\`, \`value\`, \`server\`, \`world\`, \`expiry\`, \`contexts\` FROM ${this.t('group_permissions')}`,
    );
    this.groups = { at: this.now(), index: indexGroups(rows) };
    return this.groups.index;
  }

  async loadUser(uuid) {
    const cached = this.users.get(uuid);
    if (this.fresh(cached)) return cached;
    const [rows, groups] = await Promise.all([
      this.query(
        `SELECT \`permission\`, \`value\`, \`server\`, \`world\`, \`expiry\`, \`contexts\` FROM ${this.t('user_permissions')} WHERE \`uuid\` = ?`,
        [uuid],
      ),
      this.loadGroups(),
    ]);
    const built = buildPermissionMap(rows, groups, { servers: this.servers, now: Math.floor(this.now() / 1000) });
    const entry = { at: this.now(), ...built };
    this.users.set(uuid, entry);
    return entry;
  }

  /**
   * ¿Tiene permiso la persona con estos identificadores?
   * Nunca lanza: si LuckPerms no responde se devuelve `undefined` y el bot usa sus reglas por defecto.
   * `available` indica si LuckPerms respondió: solo entonces su respuesta manda
   * (un jugador sin vincular queda sin permisos).
   * @returns {Promise<{ result: true|false|undefined, player: object|null, available: boolean, groups?: string[] }>}
   */
  async check(platform, ids, node) {
    if (!this.enabled || !this.pool || !this.ready) return { result: undefined, player: null, available: false };
    try {
      const player = await this.findPlayer(platform, ids);
      if (!player) return { result: undefined, player: null, available: true };
      const user = await this.loadUser(player.uuid);
      return { result: checkPermission(user.permissions, node), player, groups: user.groups, available: true };
    } catch (err) {
      console.error(`⚠️ [LuckPerms] No se pudo comprobar ${node}: ${err.message}`);
      return { result: undefined, player: null, available: false };
    }
  }

  // ---------------------------------------------------------------- vinculación

  /**
   * Vincula identificadores (número/LID de WhatsApp o ID de Discord) a un jugador como meta global.
   * Si otro jugador tenía alguno de esos identificadores, se le quita. Toda la red recarga a los afectados.
   * @returns {Promise<string[]>} valores guardados
   */
  async link(uuid, platform, ids) {
    const key = this.config.metaKeys[platform];
    const values = [...new Set(ids.map(digitsOf).filter(Boolean))];
    if (!values.length) throw new Error('No hay ningún identificador válido para vincular.');
    const nodes = values.map((v) => metaNode(key, v));
    const conn = await this.pool.getConnection();
    const affected = new Set([uuid]);
    try {
      await conn.beginTransaction();
      const previous = await conn.query(
        `SELECT DISTINCT \`uuid\` FROM ${this.t('user_permissions')} WHERE \`permission\` IN (${marks(nodes)}) AND \`uuid\` <> ?`, [...nodes, uuid],
      );
      for (const r of previous) affected.add(r.uuid);
      await conn.query(`DELETE FROM ${this.t('user_permissions')} WHERE \`permission\` IN (${marks(nodes)})`, nodes);
      for (const node of nodes) {
        await conn.query(
          `INSERT INTO ${this.t('user_permissions')} (\`uuid\`, \`permission\`, \`value\`, \`server\`, \`world\`, \`expiry\`, \`contexts\`)
           VALUES (?, ?, 1, 'global', 'global', 0, '{}')`,
          [uuid, node],
        );
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      conn.release();
    }
    await this.afterWrite(affected);
    return values;
  }

  /** Quita todos los vínculos de una plataforma a un jugador. @returns {Promise<number>} filas borradas */
  async unlink(uuid, platform) {
    const key = this.config.metaKeys[platform];
    const prefix = `${metaNode(key, 'x').slice(0, -1)}`; // "meta.whatsapp."
    const result = await this.query(
      `DELETE FROM ${this.t('user_permissions')} WHERE \`uuid\` = ? AND \`permission\` LIKE CONCAT(?, '%')`,
      [uuid, prefix.replace(/[\\%_]/g, (c) => `\\${c}`)],
    );
    const removed = Number(result?.affectedRows) || 0;
    if (removed) await this.afterWrite(new Set([uuid]));
    return removed;
  }

  /** Identificadores vinculados a un jugador. */
  async linkedIds(uuid, platform) {
    const key = this.config.metaKeys[platform];
    const prefix = metaNode(key, 'x').slice(0, -1);
    const rows = await this.query(
      `SELECT \`permission\` FROM ${this.t('user_permissions')} WHERE \`uuid\` = ? AND \`value\` = 1 AND \`permission\` LIKE CONCAT(?, '%')`,
      [uuid, prefix.replace(/[\\%_]/g, (c) => `\\${c}`)],
    );
    return rows.map((r) => r.permission.slice(prefix.length));
  }

  // ---------------------------------------------------------------- códigos del juego (/whatsapp link)

  get codeKey() {
    return this.config.metaKeys?.code || 'impebotcode';
  }

  /**
   * Jugadores con este código vigente (meta impebotcode que guarda ImpeGeo, temporal).
   * Normalmente uno; si por casualidad dos tienen el mismo, el código no se acepta.
   * @returns {Promise<Array<{ uuid: string, username: string, primaryGroup: string }>>}
   */
  async findCodeOwners(code) {
    const node = metaNode(this.codeKey, code);
    const rows = await this.query(
      `SELECT u.\`uuid\`, u.\`server\`, u.\`world\`, u.\`expiry\`, u.\`contexts\`, p.\`username\`, p.\`primary_group\`
       FROM ${this.t('user_permissions')} u LEFT JOIN ${this.t('players')} p ON p.\`uuid\` = u.\`uuid\`
       WHERE u.\`permission\` = ? AND u.\`value\` = 1`,
      [node],
    );
    const opts = { servers: this.servers, now: Math.floor(this.now() / 1000) };
    const active = [...new Map(rows.filter((r) => isNodeActive(r, opts)).map((r) => [r.uuid, r])).values()];
    return active.map((r) => ({ uuid: r.uuid, username: r.username || r.uuid, primaryGroup: r.primary_group || 'default' }));
  }

  /**
   * Borra el código de ese jugador. Solo una llamada lo consigue (true): así un código vale una sola vez
   * aunque llegue dos veces a la vez. El aviso a la red lo hace link() a continuación.
   */
  async consumeCode(uuid, code) {
    const node = metaNode(this.codeKey, code);
    const result = await this.query(
      `DELETE FROM ${this.t('user_permissions')} WHERE \`uuid\` = ? AND \`permission\` = ?`, [uuid, node],
    );
    return Number(result?.affectedRows) > 0;
  }

  /**
   * Anula códigos publicados donde no debían (un grupo): se borran de quien los tenga y se avisa a la red,
   * con lo que ImpeGeo le dice al jugador que genere otro. @returns {Promise<number>} códigos borrados
   */
  async burnCodes(codes) {
    const nodes = [...new Set(codes)].map((c) => metaNode(this.codeKey, c));
    if (!nodes.length) return 0;
    const owners = await this.query(
      `SELECT DISTINCT \`uuid\` FROM ${this.t('user_permissions')} WHERE \`permission\` IN (${marks(nodes)})`, nodes,
    );
    if (!owners.length) return 0;
    const result = await this.query(`DELETE FROM ${this.t('user_permissions')} WHERE \`permission\` IN (${marks(nodes)})`, nodes);
    await this.afterWrite(new Set(owners.map((r) => r.uuid)));
    return Number(result?.affectedRows) || 0;
  }

  async afterWrite(uuids) {
    this.identities.clear();
    for (const uuid of uuids) {
      this.users.delete(uuid);
      await this.announceUserUpdate(uuid).catch((err) => console.error(`⚠️ [LuckPerms] No se pudo avisar a la red: ${err.message}`));
    }
  }
}

export const luckPermsService = new LuckPermsService();
