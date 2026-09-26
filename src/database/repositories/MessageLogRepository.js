import { dbService } from '../DatabaseService.js';

export class MessageLogRepository {
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

    const sql = `SELECT id FROM message_logs WHERE ${conditions.join(' OR ')} LIMIT 1`;
    const rows = await dbService.query(sql, params);
    return rows.length > 0;
  }

  /**
   * Obtiene el registro de log que contiene un ID de mensaje de WhatsApp.
   * @param {string} waMessageId 
   * @returns {Promise<{ id: number, wa_message_id: string, discord_message_id: string, channel_mapping_id: number, direction: string }|null>}
   */
  async getByWaMessageId(waMessageId) {
    if (!waMessageId) return null;
    const sql = `
      SELECT id, wa_message_id, discord_message_id, channel_mapping_id, direction 
      FROM message_logs 
      WHERE wa_message_id = ? 
      ORDER BY id DESC 
      LIMIT 1
    `;
    const rows = await dbService.query(sql, [waMessageId]);
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Registra un mensaje retransmitido para prevenir bucles futuros.
   * @param {string|null} waMessageId 
   * @param {string|null} discordMessageId 
   * @param {number|null} channelMappingId 
   * @param {'wa_to_discord'|'discord_to_wa'} direction 
   */
  async logMessage(waMessageId, discordMessageId, channelMappingId, direction) {
    const sql = `
      INSERT INTO message_logs (wa_message_id, discord_message_id, channel_mapping_id, direction)
      VALUES (?, ?, ?, ?)
    `;
    return await dbService.query(sql, [waMessageId, discordMessageId, channelMappingId, direction]);
  }

  /**
   * Limpia logs de mensajes más antiguos que las horas especificadas.
   * @param {number} olderThanHours 
   * @returns {Promise<number>} Número de registros eliminados
   */
  async cleanup(olderThanHours = 24) {
    const sql = `
      DELETE FROM message_logs
      WHERE created_at < DATE_SUB(NOW(), INTERVAL ? HOUR)
    `;
    const result = await dbService.query(sql, [olderThanHours]);
    return result.affectedRows || 0;
  }
}

export const messageLogRepository = new MessageLogRepository();
