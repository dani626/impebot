import { dbService } from '../DatabaseService.js';

export class MessageMappingRepository {
  /**
   * Verifica si un mensaje ya ha sido procesado (por ID de WhatsApp o Discord).
   * @param {string|null} waMessageId 
   * @param {string|null} discordMessageId 
   * @returns {Promise<boolean>}
   */
  async exists(waMessageId = null, discordMessageId = null) {
    if (!waMessageId && !discordMessageId) return false;

    const conditions = [];
    const params = [];

    if (waMessageId) {
      conditions.push('wa_message_id = ?');
      params.push(waMessageId);
    }
    if (discordMessageId) {
      conditions.push('discord_message_id = ?');
      params.push(discordMessageId);
    }

    const sql = `SELECT id FROM message_mappings WHERE ${conditions.join(' OR ')} LIMIT 1`;
    const rows = await dbService.query(sql, params);
    return rows.length > 0;
  }

  /**
   * Obtiene el registro de mapeo que contiene un ID de mensaje de WhatsApp.
   * @param {string} waMessageId 
   * @returns {Promise<{ id: number, wa_message_id: string, discord_message_id: string, channel_mapping_id: number, origin_platform: string, sender_name: string, content: string }|null>}
   */
  async getByWaMessageId(waMessageId) {
    if (!waMessageId) return null;
    const sql = `
      SELECT id, wa_message_id, discord_message_id, channel_mapping_id, origin_platform, sender_name, content 
      FROM message_mappings 
      WHERE wa_message_id = ? 
      ORDER BY id DESC 
      LIMIT 1
    `;
    const rows = await dbService.query(sql, [waMessageId]);
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Obtiene el registro de mapeo que contiene un ID de mensaje de Discord.
   * @param {string} discordMessageId 
   * @returns {Promise<{ id: number, wa_message_id: string, discord_message_id: string, channel_mapping_id: number, origin_platform: string, sender_name: string, content: string }|null>}
   */
  async getByDiscordMessageId(discordMessageId) {
    if (!discordMessageId) return null;
    const sql = `
      SELECT id, wa_message_id, discord_message_id, channel_mapping_id, origin_platform, sender_name, content 
      FROM message_mappings 
      WHERE discord_message_id = ? 
      ORDER BY id DESC 
      LIMIT 1
    `;
    const rows = await dbService.query(sql, [discordMessageId]);
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Registra un mensaje mapeado entre plataformas para prevenir bucles y posibilitar citas y eliminaciones.
   * @param {object} params
   * @param {string|null} params.waMessageId 
   * @param {string|null} params.discordMessageId 
   * @param {number|null} params.channelMappingId 
   * @param {string} params.originPlatform 'whatsapp' | 'discord' | etc.
   * @param {string|null} [params.senderName=null]
   * @param {string|null} [params.content=null]
   */
  async save({ waMessageId, discordMessageId, channelMappingId, originPlatform, senderName = null, content = null }) {
    const sql = `
      INSERT INTO message_mappings (
        wa_message_id, 
        discord_message_id, 
        channel_mapping_id, 
        origin_platform, 
        sender_name, 
        content
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `;
    return await dbService.query(sql, [
      waMessageId,
      discordMessageId,
      channelMappingId,
      originPlatform,
      senderName,
      content,
    ]);
  }
}

export const messageMappingRepository = new MessageMappingRepository();
