import { dbService } from '../DatabaseService.js';

export class ChannelMappingRepository {
  /**
   * Obtiene un mapeo de canal por WhatsApp JID.
   * @param {string} whatsappJid 
   * @returns {Promise<{id: number, whatsapp_jid: string, discord_channel_id: string, webhook_url: string|null, webhook_id: string|null}|null>}
   */
  async getByWhatsAppJid(whatsappJid) {
    const rows = await dbService.query(
      'SELECT id, whatsapp_jid, discord_channel_id, webhook_url, webhook_id FROM channel_mappings WHERE whatsapp_jid = ? LIMIT 1',
      [whatsappJid]
    );
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Obtiene un mapeo de canal por su ID interno en la base de datos.
   * @param {number} id 
   * @returns {Promise<{id: number, whatsapp_jid: string, discord_channel_id: string, webhook_url: string|null, webhook_id: string|null}|null>}
   */
  async getById(id) {
    if (!id) return null;
    const rows = await dbService.query(
      'SELECT id, whatsapp_jid, discord_channel_id, webhook_url, webhook_id FROM channel_mappings WHERE id = ? LIMIT 1',
      [id]
    );
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Obtiene un mapeo de canal por Discord Channel ID.
   * @param {string} discordChannelId 
   * @returns {Promise<{id: number, whatsapp_jid: string, discord_channel_id: string, webhook_url: string|null, webhook_id: string|null}|null>}
   */
  async getByDiscordChannelId(discordChannelId) {
    const rows = await dbService.query(
      'SELECT id, whatsapp_jid, discord_channel_id, webhook_url, webhook_id FROM channel_mappings WHERE discord_channel_id = ? LIMIT 1',
      [discordChannelId]
    );
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Obtiene todos los mapeos de canales registrados.
   * @returns {Promise<Array<{id: number, whatsapp_jid: string, discord_channel_id: string, webhook_url: string|null, webhook_id: string|null}>>}
   */
  async getAll() {
    return await dbService.query(
      'SELECT id, whatsapp_jid, discord_channel_id, webhook_url, webhook_id FROM channel_mappings ORDER BY id ASC'
    );
  }

  /**
   * Inserta o actualiza un mapeo de canal.
   * @param {string} whatsappJid 
   * @param {string} discordChannelId 
   * @param {string|null} webhookUrl 
   * @param {string|null} webhookId 
   */
  async save(whatsappJid, discordChannelId, webhookUrl = null, webhookId = null) {
    const sql = `
      INSERT INTO channel_mappings (whatsapp_jid, discord_channel_id, webhook_url, webhook_id)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        discord_channel_id = VALUES(discord_channel_id),
        webhook_url = VALUES(webhook_url),
        webhook_id = VALUES(webhook_id),
        updated_at = CURRENT_TIMESTAMP
    `;
    return await dbService.query(sql, [whatsappJid, discordChannelId, webhookUrl, webhookId]);
  }
}

export const channelMappingRepository = new ChannelMappingRepository();
