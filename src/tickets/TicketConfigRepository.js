import { dbService } from '../database/DatabaseService.js';

const json = (text) => { try { return JSON.parse(text || '[]'); } catch { return []; } };

export const GUILD_DEFAULTS = Object.freeze({
  defaultCategoryChannelId: null, logChannelId: null, transcriptFormat: 'html', maxOpenPerUser: 3,
  staffRoleIds: [], deleteDelaySeconds: 5, renameOnPriority: true, requireLinkedWeb: true,
});

// Campo JS → columna. Solo estas columnas se pueden cambiar desde los comandos.
const GUILD_COLUMNS = {
  defaultCategoryChannelId: 'default_category_channel_id', logChannelId: 'log_channel_id', transcriptFormat: 'transcript_format',
  maxOpenPerUser: 'max_open_per_user', staffRoleIds: 'staff_role_ids', deleteDelaySeconds: 'delete_delay_seconds',
  renameOnPriority: 'rename_on_priority', requireLinkedWeb: 'require_linked_web',
};
const CATEGORY_COLUMNS = {
  slug: 'slug', label: 'label', description: 'description', emoji: 'emoji', buttonStyle: 'button_style', baseCategory: 'base_category',
  discordCategoryId: 'discord_category_id', staffRoleIds: 'staff_role_ids', defaultPriority: 'default_priority',
  pingRoles: 'ping_roles', welcomeMessage: 'welcome_message', sortOrder: 'sort_order', enabled: 'enabled',
};
const PANEL_COLUMNS = { title: 'title', description: 'description', color: 'color', mode: 'mode', categoryIds: 'category_ids' };

/** Convierte cambios JS en columnas; los arrays se guardan como JSON. */
function columnsFor(map, changes) {
  const entries = Object.entries(changes).filter(([k, v]) => map[k] && v !== undefined);
  return { names: entries.map(([k]) => map[k]), values: entries.map(([, v]) => (Array.isArray(v) ? JSON.stringify(v) : v)) };
}

const toGuild = (r) => (r ? {
  guildId: r.guild_id, defaultCategoryChannelId: r.default_category_channel_id, logChannelId: r.log_channel_id,
  transcriptFormat: r.transcript_format, maxOpenPerUser: Number(r.max_open_per_user), staffRoleIds: json(r.staff_role_ids),
  deleteDelaySeconds: Number(r.delete_delay_seconds), renameOnPriority: Boolean(r.rename_on_priority), requireLinkedWeb: Boolean(r.require_linked_web),
} : null);
const toCategory = (r) => (r ? {
  id: r.id, guildId: r.guild_id, slug: r.slug, label: r.label, description: r.description, emoji: r.emoji, buttonStyle: r.button_style,
  baseCategory: r.base_category, discordCategoryId: r.discord_category_id, staffRoleIds: json(r.staff_role_ids),
  defaultPriority: r.default_priority, pingRoles: Boolean(r.ping_roles), welcomeMessage: r.welcome_message,
  sortOrder: r.sort_order, enabled: Boolean(r.enabled),
} : null);
const toPanel = (r) => (r ? {
  id: r.id, guildId: r.guild_id, channelId: r.channel_id, messageId: r.message_id, title: r.title, description: r.description,
  color: r.color, mode: r.mode, categoryIds: r.category_ids ? json(r.category_ids) : null,
} : null);

/** Configuración de tickets de Discord por servidor: siempre en la MariaDB del bot, también en modo web. */
export class TicketConfigRepository {
  constructor(db = dbService) { this.db = db; }

  async guild(guildId) {
    const [row] = await this.db.query('SELECT * FROM support_guild_configs WHERE guild_id = ?', [guildId]);
    return toGuild(row) || { guildId, ...GUILD_DEFAULTS, staffRoleIds: [] };
  }

  async updateGuild(guildId, changes) {
    const { names, values } = columnsFor(GUILD_COLUMNS, changes);
    if (names.length) {
      await this.db.query(
        `INSERT INTO support_guild_configs (guild_id, ${names.join(', ')}) VALUES (?, ${names.map(() => '?').join(', ')})
         ON DUPLICATE KEY UPDATE ${names.map((n) => `${n} = VALUES(${n})`).join(', ')}`,
        [guildId, ...values],
      );
    }
    return this.guild(guildId);
  }

  async categories(guildId, { enabledOnly = false } = {}) {
    const rows = await this.db.query(
      `SELECT * FROM support_categories WHERE guild_id = ? ${enabledOnly ? 'AND enabled = TRUE' : ''} ORDER BY sort_order, id`, [guildId]);
    return rows.map(toCategory);
  }
  async category(id) { return toCategory((await this.db.query('SELECT * FROM support_categories WHERE id = ?', [id]))[0]); }
  async categoryBySlug(guildId, slug) {
    return toCategory((await this.db.query('SELECT * FROM support_categories WHERE guild_id = ? AND slug = ?', [guildId, slug]))[0]);
  }
  async createCategory(guildId, data) {
    const { names, values } = columnsFor(CATEGORY_COLUMNS, data);
    const result = await this.db.query(
      `INSERT INTO support_categories (guild_id, ${names.join(', ')}) VALUES (?, ${names.map(() => '?').join(', ')})`, [guildId, ...values]);
    return this.category(Number(result.insertId));
  }
  async updateCategory(id, changes) {
    const { names, values } = columnsFor(CATEGORY_COLUMNS, changes);
    if (names.length) await this.db.query(`UPDATE support_categories SET ${names.map((n) => `${n} = ?`).join(', ')} WHERE id = ?`, [...values, id]);
    return this.category(id);
  }
  async deleteCategory(id) { await this.db.query('DELETE FROM support_categories WHERE id = ?', [id]); }

  async savePanel(guildId, data) {
    const { names, values } = columnsFor(PANEL_COLUMNS, data);
    await this.db.query(
      `INSERT INTO support_panels (guild_id, channel_id, message_id, ${names.join(', ')}) VALUES (?, ?, ?, ${names.map(() => '?').join(', ')})`,
      [guildId, data.channelId, data.messageId, ...values]);
    return this.panel(data.messageId);
  }
  async updatePanel(messageId, changes) {
    const { names, values } = columnsFor(PANEL_COLUMNS, changes);
    if (names.length) await this.db.query(`UPDATE support_panels SET ${names.map((n) => `${n} = ?`).join(', ')} WHERE message_id = ?`, [...values, messageId]);
    return this.panel(messageId);
  }
  async panel(messageId) { return toPanel((await this.db.query('SELECT * FROM support_panels WHERE message_id = ?', [messageId]))[0]); }
  async panels(guildId) { return (await this.db.query('SELECT * FROM support_panels WHERE guild_id = ?', [guildId])).map(toPanel); }
  async deletePanel(messageId) { await this.db.query('DELETE FROM support_panels WHERE message_id = ?', [messageId]); }

  async participants(key) {
    return (await this.db.query('SELECT target_id AS id, target_type AS type FROM support_participants WHERE ticket_key = ?', [key]));
  }
  async addParticipant(key, id, type, addedBy) {
    await this.db.query(
      'INSERT INTO support_participants (ticket_key, target_id, target_type, added_by) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE target_type = VALUES(target_type)',
      [key, id, type, addedBy]);
  }
  async removeParticipant(key, id) { await this.db.query('DELETE FROM support_participants WHERE ticket_key = ? AND target_id = ?', [key, id]); }
}

export const ticketConfigRepository = new TicketConfigRepository();
