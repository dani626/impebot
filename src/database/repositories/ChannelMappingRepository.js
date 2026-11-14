import { dbService } from '../DatabaseService.js';

const COLUMNS = 'id, whatsapp_jid, discord_channel_id, discord_guild_id, alias, direction, enabled, settings, webhook_url, webhook_id';

/**
 * Vínculo grupo de WhatsApp ↔ canal de Discord.
 * @typedef {{id: number, whatsapp_jid: string, discord_channel_id: string, discord_guild_id: string, alias: string|null,
 *   direction: 'both'|'wa_to_dc'|'dc_to_wa', enabled: number, settings: object|string|null,
 *   webhook_url: string|null, webhook_id: string|null}} ChannelMapping
 */
export class ChannelMappingRepository {
  /**
   * Vínculo más antiguo de un chat de WhatsApp, sin mirar dirección ni estado.
   * Para reenviar mensajes usa getOutboundForJid.
   * @param {string} whatsappJid
   * @returns {Promise<ChannelMapping|null>}
   */
  async getByWhatsAppJid(whatsappJid) {
    const rows = await dbService.query(
      `SELECT ${COLUMNS} FROM channel_mappings WHERE whatsapp_jid = ? ORDER BY id ASC LIMIT 1`,
      [whatsappJid]
    );
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * @param {number} id
   * @returns {Promise<ChannelMapping|null>}
   */
  async getById(id) {
    if (!id) return null;
    const rows = await dbService.query(`SELECT ${COLUMNS} FROM channel_mappings WHERE id = ? LIMIT 1`, [id]);
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Vínculo más antiguo de un canal de Discord, sin mirar dirección ni estado.
   * Para reenviar mensajes usa getInboundForChannel.
   * @param {string} discordChannelId
   * @returns {Promise<ChannelMapping|null>}
   */
  async getByDiscordChannelId(discordChannelId) {
    const rows = await dbService.query(
      `SELECT ${COLUMNS} FROM channel_mappings WHERE discord_channel_id = ? ORDER BY id ASC LIMIT 1`,
      [discordChannelId]
    );
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * @param {string} whatsappJid
   * @param {string} discordChannelId
   * @returns {Promise<ChannelMapping|null>}
   */
  async getByPair(whatsappJid, discordChannelId) {
    const rows = await dbService.query(
      `SELECT ${COLUMNS} FROM channel_mappings WHERE whatsapp_jid = ? AND discord_channel_id = ? LIMIT 1`,
      [whatsappJid, discordChannelId]
    );
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * WhatsApp → Discord: todos los canales activos que reciben los mensajes de un chat.
   * Nunca devuelve vínculos dc_to_wa ni pausados. El más antiguo va primero.
   * @param {string} whatsappJid
   * @returns {Promise<ChannelMapping[]>}
   */
  async getOutboundForJid(whatsappJid) {
    return await dbService.query(
      `SELECT ${COLUMNS} FROM channel_mappings
       WHERE whatsapp_jid = ? AND enabled = 1 AND direction IN ('both', 'wa_to_dc')
       ORDER BY id ASC`,
      [whatsappJid]
    );
  }

  /**
   * Discord → WhatsApp: el vínculo activo por el que un canal escribe a WhatsApp.
   * Nunca devuelve vínculos wa_to_dc ni pausados. Como mucho hay uno por canal (uk_inbound).
   * @param {string} discordChannelId
   * @returns {Promise<ChannelMapping|null>}
   */
  async getInboundForChannel(discordChannelId) {
    const rows = await dbService.query(
      `SELECT ${COLUMNS} FROM channel_mappings
       WHERE discord_channel_id = ? AND enabled = 1 AND direction IN ('both', 'dc_to_wa')
       ORDER BY id ASC LIMIT 1`,
      [discordChannelId]
    );
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * ¿El chat ya tiene un vínculo en ese servidor de Discord? Cuenta también los pausados:
   * pausar un canal no debe hacer que el bot cree otro.
   * @param {string} whatsappJid
   * @param {string} discordGuildId
   * @returns {Promise<boolean>}
   */
  async existsInGuild(whatsappJid, discordGuildId) {
    const rows = await dbService.query(
      // '' = vínculo insertado a mano sin servidor: se da por hecho que es del hub para no duplicar su canal.
      "SELECT id FROM channel_mappings WHERE whatsapp_jid = ? AND discord_guild_id IN (?, '') LIMIT 1",
      [whatsappJid, discordGuildId]
    );
    return rows.length > 0;
  }

  /**
   * @returns {Promise<ChannelMapping[]>}
   */
  async getAll() {
    return await dbService.query(`SELECT ${COLUMNS} FROM channel_mappings ORDER BY id ASC`);
  }

  /**
   * Inserta o actualiza un mapeo de canal.
   * @param {string} whatsappJid
   * @param {string} discordChannelId
   * @param {string|null} webhookUrl
   * @param {string|null} webhookId
   * @param {string} discordGuildId servidor de Discord al que pertenece el canal
   */
  async save(whatsappJid, discordChannelId, webhookUrl = null, webhookId = null, discordGuildId = '') {
    // La clave única es la pareja (whatsapp_jid, discord_channel_id): repetirla solo renueva el webhook.
    const sql = `
      INSERT INTO channel_mappings (whatsapp_jid, discord_channel_id, discord_guild_id, webhook_url, webhook_id)
      VALUES (?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        discord_guild_id = VALUES(discord_guild_id),
        webhook_url = VALUES(webhook_url),
        webhook_id = VALUES(webhook_id),
        updated_at = CURRENT_TIMESTAMP
    `;
    return await dbService.query(sql, [whatsappJid, discordChannelId, discordGuildId || '', webhookUrl, webhookId]);
  }
}

export const channelMappingRepository = new ChannelMappingRepository();
