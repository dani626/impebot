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
}

export const userMappingRepository = new UserMappingRepository();
