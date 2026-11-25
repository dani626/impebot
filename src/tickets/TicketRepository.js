import { randomUUID } from 'node:crypto';
import { dbService } from '../database/DatabaseService.js';
import { ticketError, validateTicket, validateBody, STATUSES, PRIORITIES } from './model.js';

const iso = (date) => new Date(date).toISOString();
// Un jugador de Discord se identifica por su ID de Discord; el de WhatsApp, por su JID.
const ownerOf = (t, actor) => (actor.platform === 'discord' ? t.owner_discord_id : t.owner_jid);

export class TicketRepository {
  constructor(db = dbService) { this.db = db; this.name = 'local'; }

  async get(number) {
    const [t] = await this.db.query('SELECT * FROM support_tickets WHERE number = ?', [number]);
    if (!t) throw ticketError('Ticket no encontrado.', 404);
    const rows = await this.db.query('SELECT * FROM support_messages WHERE ticket_id = ? ORDER BY sequence', [t.id]);
    return {
      id: t.id, number: t.number, subject: t.subject, category: t.category,
      status: t.status, priority: t.priority,
      user: { id: t.owner_jid || t.owner_discord_id, username: t.user_name },
      origin: t.origin || 'whatsapp', ownerDiscordId: t.owner_discord_id || null, guildId: t.guild_id || null,
      customCategorySlug: t.custom_category_slug || null,
      assignee: t.assignee_id ? { id: t.assignee_id, username: t.assignee_name } : null,
      whatsappJid: t.owner_jid || null, orderId: null, sanctionId: null,
      createdAt: iso(t.created_at), updatedAt: iso(t.updated_at),
      messageCount: rows.length,
      messages: rows.map((m) => ({
        id: m.id, body: m.body, internal: Boolean(m.internal),
        author: { id: m.author_id, username: m.author_name, role: m.author_role },
        createdAt: iso(m.created_at),
      })),
    };
  }

  async list({ after = 0, jid } = {}) {
    const rows = await this.db.query(
      `SELECT number FROM support_tickets WHERE number > ? ${jid ? 'AND owner_jid = ?' : ''} ORDER BY number LIMIT 50`,
      jid ? [after, jid] : [after],
    );
    return Promise.all(rows.map((r) => this.get(r.number)));
  }

  /**
   * Abre un ticket desde WhatsApp (`jid`) o desde Discord (`discordUserId`).
   * `maxOpen` limita los tickets abiertos del dueño (por defecto 1 en WhatsApp y 3 en Discord).
   */
  async create(data) {
    validateTicket(data);
    const discord = !data.jid;
    if (discord && !data.discordUserId) throw ticketError('Falta el creador del ticket.');
    if (data.priority && !PRIORITIES.includes(data.priority)) throw ticketError('Prioridad inválida.');
    const previous = await this.db.query('SELECT ticket_id FROM support_messages WHERE event_id = ?', [data.eventId]);
    if (previous.length) {
      const [t] = await this.db.query('SELECT number FROM support_tickets WHERE id = ?', [previous[0].ticket_id]);
      return this.get(t.number);
    }
    const owner = discord ? data.discordUserId : data.jid;
    const maxOpen = data.maxOpen ?? (discord ? 3 : 1);
    const id = randomUUID();
    let number;
    try {
      number = await this.db.transaction(async (conn) => {
        // FOR UPDATE serializa aperturas simultáneas del mismo dueño (la otra espera o cae por bloqueo).
        // En Discord el cupo es por servidor (<=> también compara NULL).
        const active = discord
          ? await conn.query("SELECT number FROM support_tickets WHERE owner_discord_id = ? AND guild_id <=> ? AND status <> 'CLOSED' FOR UPDATE", [owner, data.guildId || null])
          : await conn.query("SELECT number FROM support_tickets WHERE owner_jid = ? AND status <> 'CLOSED' FOR UPDATE", [owner]);
        if (active.length >= maxOpen) {
          throw ticketError(maxOpen === 1 ? `Ya tienes el ticket #${active[0].number} abierto.` : `Ya tienes ${active.length} tickets abiertos (máximo ${maxOpen}).`, 409);
        }
        const result = await conn.query(
          `INSERT INTO support_tickets (id, subject, category, priority, origin, owner_jid, owner_discord_id, guild_id, custom_category_slug, user_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, data.subject.trim(), data.category, data.priority || (data.category === 'compra' ? 'HIGH' : 'NORMAL'),
            discord ? 'discord' : 'whatsapp', data.jid || null, data.discordUserId || null, data.guildId || null,
            data.customCategorySlug || null, data.username.slice(0, 128)],
        );
        await this.insertMessage(conn, id, { body: data.message, eventId: data.eventId, actor: { id: owner, username: data.username, role: 'USER' } });
        return Number(result.insertId);
      });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw ticketError('Este mensaje ya fue procesado.', 409);
      if (err.code === 'ER_LOCK_DEADLOCK') throw ticketError('Hay otra apertura en curso; inténtalo de nuevo.', 409);
      throw err;
    }
    return this.get(number);
  }

  async insertMessage(conn, ticketId, { body, eventId, internal = false, actor }) {
    await conn.query(
      'INSERT INTO support_messages (id, ticket_id, event_id, body, internal, author_id, author_name, author_role) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [randomUUID(), ticketId, eventId, body.trim(), internal, actor.id, actor.username.slice(0, 128), actor.role],
    );
  }

  async message(number, data) {
    validateBody(data.body);
    await this.db.transaction(async (conn) => {
      const [t] = await conn.query('SELECT * FROM support_tickets WHERE number = ? FOR UPDATE', [number]);
      if (!t) throw ticketError('Ticket no encontrado.', 404);
      const player = data.actor.role === 'USER';
      if (player && (data.actor.id !== ownerOf(t, data.actor) || data.internal)) throw ticketError('No tienes acceso a este ticket.', 403);
      const exists = await conn.query('SELECT ticket_id FROM support_messages WHERE event_id = ?', [data.eventId]);
      if (exists.length) {
        if (exists[0].ticket_id !== t.id) throw ticketError('El mensaje ya pertenece a otro ticket.', 409);
        return;
      }
      if (t.status === 'CLOSED') throw ticketError('El ticket está cerrado.', 409);
      await this.insertMessage(conn, t.id, data);
      await conn.query(
        'UPDATE support_tickets SET status = ?, assignee_id = ?, assignee_name = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?',
        [data.internal ? t.status : player ? 'OPEN' : 'PENDING',
          !player && !data.internal && !t.assignee_id ? data.actor.id : t.assignee_id,
          !player && !data.internal && !t.assignee_id ? data.actor.username : t.assignee_name, t.id],
      );
    });
    return this.get(number);
  }

  async update(number, changes, actor) {
    if (changes.status && !STATUSES.includes(changes.status)) throw ticketError('Estado inválido.');
    if (changes.priority && !PRIORITIES.includes(changes.priority)) throw ticketError('Prioridad inválida.');
    await this.db.transaction(async (conn) => {
      const [t] = await conn.query('SELECT * FROM support_tickets WHERE number = ? FOR UPDATE', [number]);
      if (!t) throw ticketError('Ticket no encontrado.', 404);
      if (actor.role === 'USER' && (actor.id !== ownerOf(t, actor) || Object.keys(changes).some((k) => k !== 'status') || changes.status !== 'CLOSED')) {
        throw ticketError('No tienes permiso para esta acción.', 403);
      }
      const assignee = changes.assigneeId === 'me' ? actor.id : changes.assigneeId === null ? null : t.assignee_id;
      if (changes.assigneeId === null && t.assignee_id !== actor.id && actor.role !== 'MODERATOR') throw ticketError('Solo puedes soltar tus propios tickets.', 403);
      // En WhatsApp el jugador tiene un solo ticket activo: reabrir no puede dejarle dos.
      if (changes.status && changes.status !== 'CLOSED' && t.status === 'CLOSED' && t.owner_jid) {
        const active = await conn.query("SELECT number FROM support_tickets WHERE owner_jid = ? AND status <> 'CLOSED' AND id <> ? FOR UPDATE", [t.owner_jid, t.id]);
        if (active.length) throw ticketError(`El jugador ya tiene el ticket #${active[0].number} abierto.`, 409);
      }
      await conn.query(
        'UPDATE support_tickets SET status = ?, priority = ?, assignee_id = ?, assignee_name = ?, closed_at = ?, updated_at = CURRENT_TIMESTAMP(3) WHERE id = ?',
        [changes.status || t.status, changes.priority || t.priority, assignee,
          changes.assigneeId === 'me' ? actor.username : assignee ? t.assignee_name : null,
          (changes.status || t.status) === 'CLOSED' ? new Date() : null, t.id],
      );
    });
    return this.get(number);
  }

  async route(key) { return (await this.db.query('SELECT * FROM support_routes WHERE ticket_key = ?', [key]))[0] || null; }
  async routeByChannel(id) { return (await this.db.query('SELECT * FROM support_routes WHERE discord_channel_id = ?', [id]))[0] || null; }
  /** Servidor, origen, dueño y categoría solo se escriben al crear la ruta. */
  async saveRoute(key, ticket, channelId, { guildId = null, origin = 'whatsapp', ownerDiscordId = null, categoryId = null } = {}) {
    await this.db.query(
      `INSERT INTO support_routes (ticket_key, ticket_number, discord_channel_id, whatsapp_jid, guild_id, origin, owner_discord_id, category_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE whatsapp_jid = VALUES(whatsapp_jid), updated_at = CURRENT_TIMESTAMP(3)`,
      [key, ticket.number, channelId, ticket.whatsappJid || null, guildId, origin, ownerDiscordId, categoryId],
    );
  }
  async setRouteStatus(key, status, meta) { await this.db.query('UPDATE support_routes SET last_status = ?, last_meta = ? WHERE ticket_key = ?', [status, meta, key]); }
  async setControlMessage(key, messageId) { await this.db.query('UPDATE support_routes SET control_message_id = ? WHERE ticket_key = ?', [messageId, key]); }
  async markChannelDeleted(key) { await this.db.query('UPDATE support_routes SET channel_deleted = TRUE WHERE ticket_key = ?', [key]); }
  async setLastRenamedAt(key) { await this.db.query('UPDATE support_routes SET last_renamed_at = CURRENT_TIMESTAMP(3) WHERE ticket_key = ?', [key]); }
  /** Tickets de Discord abiertos de un usuario en un servidor, en cualquier backend (web o local). */
  async countOpenDiscord(ownerDiscordId, guildId) {
    const [row] = await this.db.query(
      "SELECT COUNT(*) AS n FROM support_routes WHERE owner_discord_id = ? AND guild_id = ? AND origin = 'discord' AND channel_deleted = FALSE AND (last_status IS NULL OR last_status <> 'CLOSED')",
      [ownerDiscordId, guildId],
    );
    return Number(row.n);
  }
  async delivered(key, id, destination) {
    return (await this.db.query('SELECT 1 FROM support_deliveries WHERE ticket_key = ? AND message_id = ? AND destination = ?', [key, id, destination])).length > 0;
  }
  async markDelivered(key, id, destination) {
    await this.db.query('INSERT IGNORE INTO support_deliveries (ticket_key, message_id, destination) VALUES (?, ?, ?)', [key, id, destination]);
  }
}

export const ticketRepository = new TicketRepository();
