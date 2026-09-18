import { dbService } from '../DatabaseService.js';

export class UserMappingRepository {
  /**
   * Obtiene la identidad asociada a un JID de WhatsApp.
   * @param {string} whatsappJid 
   * @returns {Promise<{id: number, whatsapp_jid: string, discord_user_id: string|null, display_name: string, avatar_url: string|null}|null>}
   */
  async getByWhatsAppJid(whatsappJid) {
    const rows = await dbService.query(
      'SELECT id, whatsapp_jid, discord_user_id, display_name, avatar_url FROM user_mappings WHERE whatsapp_jid = ? LIMIT 1',
      [whatsappJid]
    );
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Obtiene la identidad asociada a un Discord User ID.
   * @param {string} discordUserId 
   * @returns {Promise<{id: number, whatsapp_jid: string, discord_user_id: string|null, display_name: string, avatar_url: string|null}|null>}
   */
  async getByDiscordUserId(discordUserId) {
    const rows = await dbService.query(
      'SELECT id, whatsapp_jid, discord_user_id, display_name, avatar_url FROM user_mappings WHERE discord_user_id = ? LIMIT 1',
      [discordUserId]
    );
    return rows.length > 0 ? rows[0] : null;
  }

  /**
   * Inserta o actualiza un mapeo de usuario.
   * @param {string} whatsappJid 
   * @param {string|null} discordUserId 
   * @param {string} displayName 
   * @param {string|null} avatarUrl 
   */
  async upsert(whatsappJid, discordUserId, displayName, avatarUrl = null) {
    const sql = `
      INSERT INTO user_mappings (whatsapp_jid, discord_user_id, display_name, avatar_url)
      VALUES (?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        discord_user_id = COALESCE(VALUES(discord_user_id), discord_user_id),
        display_name = VALUES(display_name),
        avatar_url = COALESCE(VALUES(avatar_url), avatar_url),
        updated_at = CURRENT_TIMESTAMP
    `;
    return await dbService.query(sql, [whatsappJid, discordUserId, displayName, avatarUrl]);
  }
}

export const userMappingRepository = new UserMappingRepository();
export default userMappingRepository;
