import { CONFIG } from '../config.js';
import { luckPermsService } from './LuckPermsService.js';
import { digitsOf } from './resolver.js';
import { participantIds, userPart } from '../services/ModerationService.js';

/**
 * Vinculación con el código del juego: el jugador usa /whatsapp link en Minecraft (plugin ImpeGeo), que guarda
 * un código de 8 cifras como meta temporal "impebotcode", y lo envía al bot con !vincular 12345678.
 *
 * - Los códigos de la web (32 hexadecimales) siguen yendo a los tickets; aquí solo se atienden los de 8 cifras.
 * - Por privado siempre; en grupos solo en los de WA_LINK_GROUPS. En un grupo el código queda a la vista, así que
 *   se anula con el primer mensaje que lo contenga aunque no se pueda usar, y el bot borra el mensaje si es admin.
 * - Como mucho WA_LINK_MAX_FAILURES códigos incorrectos por persona y hora (8 cifras se podrían adivinar).
 */
export const GAME_CODE_RE = /^\d{8}$/;
const CODE_IN_TEXT_RE = /(?<!\d)\d{8}(?!\d)/g;

export const isGameCode = (value) => GAME_CODE_RE.test(String(value || '').trim());

export class GameLinkService {
  constructor({ lp = luckPermsService, config = CONFIG.luckperms.gameLink, now = () => Date.now() } = {}) {
    this.lp = lp;
    this.config = config;
    this.now = now;
    /** clave de la persona → marcas de tiempo de sus fallos dentro de la ventana */
    this.failures = new Map();
  }

  /** Clave estable de una persona aunque unas veces llegue con número y otras con LID. */
  personKey(senderIds) {
    return [...new Set(senderIds.map(digitsOf).filter(Boolean))].sort().join(',');
  }

  recentFailures(key) {
    const since = this.now() - this.config.failureWindowMs;
    const list = (this.failures.get(key) || []).filter((t) => t > since);
    if (list.length) this.failures.set(key, list);
    else this.failures.delete(key);
    return list;
  }

  isLimited(key) {
    return this.recentFailures(key).length >= this.config.maxFailures;
  }

  fail(key) {
    this.failures.set(key, [...this.recentFailures(key), this.now()]);
    // Que el mapa no crezca sin límite si muchos números distintos prueban códigos.
    if (this.failures.size > 10000) this.failures.delete(this.failures.keys().next().value);
  }

  /**
   * Canjea un código. No envía nada: devuelve qué pasó.
   * @returns {Promise<{ status: 'linked'|'invalid'|'limited'|'unavailable', player?: object, previous?: object|null }>}
   */
  async redeem(code, senderIds) {
    const key = this.personKey(senderIds);
    if (!key) return { status: 'invalid' };
    if (this.isLimited(key)) return { status: 'limited' };
    if (!this.lp.enabled || !this.lp.ready) return { status: 'unavailable' };

    const owners = await this.lp.findCodeOwners(code);
    if (owners.length !== 1) {
      this.fail(key);
      // Dos jugadores con el mismo código: no se sabe de quién es, se anula para ambos.
      if (owners.length > 1) await this.lp.burnCodes([code]);
      return { status: 'invalid' };
    }
    const [player] = owners;
    if (!(await this.lp.consumeCode(player.uuid, code))) {
      // Otro mensaje lo usó un instante antes.
      this.fail(key);
      return { status: 'invalid' };
    }
    const before = await this.lp.findPlayer('whatsapp', senderIds).catch(() => null);
    await this.lp.link(player.uuid, 'whatsapp', senderIds);
    this.failures.delete(key);
    return { status: 'linked', player, previous: before && before.uuid !== player.uuid ? before : null };
  }

  /**
   * !vincular 12345678 (o !verificar, !link, !verify).
   * @returns {Promise<{ status: string, detail?: string }>} para el registro de comandos
   */
  async handleCommand({ sock, msg, jid, code, senderIds, prefix = '!' }) {
    const reply = (text) => sock.sendMessage(jid, { text }, { quoted: msg });
    const isGroup = jid.endsWith('@g.us');

    if (isGroup && !this.config.groups.includes(jid)) {
      await this.lp.burnCodes([code]).catch((err) => console.error('⚠️ [Vincular] No se pudo anular el código:', err.message));
      const deleted = await this.deleteMessage(sock, msg);
      await sock.sendMessage(jid, {
        text: `⚠️ Ese código ya no vale porque se publicó en el grupo${deleted ? ' (he borrado el mensaje)' : ''}. Genera otro con /whatsapp link en el juego y envíamelo *por privado*. / That code is no longer valid: send a new one in private.`,
      });
      return { status: 'denegado', detail: 'código en grupo no permitido' };
    }

    let result;
    try {
      result = await this.redeem(code, senderIds);
    } finally {
      // En un grupo permitido el mensaje también se borra: el código ya no sirve y no hace falta que quede.
      if (isGroup) await this.deleteMessage(sock, msg);
    }

    const send = isGroup ? (text) => sock.sendMessage(jid, { text }) : reply;
    switch (result.status) {
      case 'linked': {
        const { player, previous } = result;
        const moved = previous ? `\n↪️ Este WhatsApp estaba vinculado a ${previous.username}; ahora es de ${player.username}.` : '';
        await send(`✅ WhatsApp vinculado a *${player.username}* (${player.primaryGroup}). Ya puedes usar los comandos de tu rango. / Linked.${moved}`);
        return { status: 'ok', detail: `vinculado a ${player.username}${previous ? ` (antes: ${previous.username})` : ''}` };
      }
      case 'limited':
        await send('⛔ Demasiados códigos incorrectos. Espera una hora y genera uno nuevo con /whatsapp link. / Too many wrong codes, try again later.');
        return { status: 'denegado', detail: 'límite de intentos' };
      case 'unavailable':
        await send('❌ No se puede vincular ahora mismo. Inténtalo más tarde. / Linking is unavailable right now.');
        return { status: 'error', detail: 'LuckPerms no disponible' };
      default:
        await send(`❌ Código incorrecto o caducado. Escribe /whatsapp link en el juego y envíame \`${prefix}vincular CODIGO\` con el nuevo. / Wrong or expired code.`);
        return { status: 'denegado', detail: 'código incorrecto' };
    }
  }

  /**
   * Mensaje de grupo que no es !vincular pero contiene un posible código: se anula y, si lo era, se borra.
   * @returns {Promise<number>} códigos anulados
   */
  async burnLeaked({ sock, msg, jid, text }) {
    if (!this.lp.enabled || !this.lp.ready || !jid.endsWith('@g.us')) return 0;
    const codes = String(text || '').match(CODE_IN_TEXT_RE);
    if (!codes) return 0;
    const burned = await this.lp.burnCodes(codes);
    if (burned) {
      const deleted = await this.deleteMessage(sock, msg);
      await sock.sendMessage(jid, {
        text: `⚠️ Había un código de vinculación en ese mensaje y lo he anulado${deleted ? ' (y borrado el mensaje)' : ''}. Los códigos se envían al bot *por privado*.`,
      }).catch(() => {});
    }
    return burned;
  }

  /** Borra un mensaje del grupo si el bot es admin (sin serlo WhatsApp lo ignora sin dar error). */
  async deleteMessage(sock, msg) {
    try {
      const meta = await sock.groupMetadata(msg.key.remoteJid);
      const me = new Set([sock.user?.id, sock.user?.lid].filter(Boolean).map(userPart));
      const entry = meta?.participants?.find((p) => participantIds(p).some((id) => me.has(userPart(id))));
      if (!['admin', 'superadmin'].includes(entry?.admin) && !entry?.isAdmin && !entry?.isSuperAdmin) return false;
      await sock.sendMessage(msg.key.remoteJid, { delete: msg.key });
      return true;
    } catch {
      return false;
    }
  }
}

export const gameLinkService = new GameLinkService();
