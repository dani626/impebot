import { dbService } from '../DatabaseService.js';

export const ALL_CHATS = '*';

export class MirrorRepository {
  /** Espejos que aplican a un chat: los específicos y los globales ('*'). */
  async getForJid(whatsappJid) {
    return await dbService.query(
      'SELECT id, whatsapp_jid, discord_channel_id, webhook_url FROM relay_mirrors WHERE whatsapp_jid IN (?, ?) ORDER BY id ASC',
      [whatsappJid, ALL_CHATS]
    );
  }

  async getAll() {
    return await dbService.query(
      'SELECT id, whatsapp_jid, discord_channel_id, webhook_url, created_by FROM relay_mirrors ORDER BY id ASC'
    );
  }

  async add(whatsappJid, discordChannelId, webhookUrl = null, createdBy = null) {
    return await dbService.query(
      `INSERT INTO relay_mirrors (whatsapp_jid, discord_channel_id, webhook_url, created_by)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE webhook_url = VALUES(webhook_url)`,
      [whatsappJid, discordChannelId, webhookUrl, createdBy]
    );
  }

  /** @returns {Promise<number>} filas eliminadas */
  async remove(whatsappJid, discordChannelId) {
    const res = await dbService.query(
      'DELETE FROM relay_mirrors WHERE whatsapp_jid = ? AND discord_channel_id = ?',
      [whatsappJid, discordChannelId]
    );
    return Number(res?.affectedRows ?? 0);
  }
}

export class AliasRepository {
  async resolve(alias) {
    const rows = await dbService.query('SELECT target FROM relay_aliases WHERE alias = ? LIMIT 1', [alias]);
    return rows.length ? rows[0].target : null;
  }

  async getAll() {
    return await dbService.query('SELECT alias, target FROM relay_aliases ORDER BY alias ASC');
  }

  async search(prefix, limit = 25) {
    const escaped = prefix.replace(/[\\%_]/g, '\\$&');
    return await dbService.query(
      'SELECT alias, target FROM relay_aliases WHERE alias LIKE ? ORDER BY alias ASC LIMIT ?',
      [`${escaped}%`, limit]
    );
  }

  async set(alias, target, createdBy = null) {
    return await dbService.query(
      `INSERT INTO relay_aliases (alias, target, created_by) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE target = VALUES(target)`,
      [alias, target, createdBy]
    );
  }

  async remove(alias) {
    const res = await dbService.query('DELETE FROM relay_aliases WHERE alias = ?', [alias]);
    return Number(res?.affectedRows ?? 0);
  }
}

export const aliasRepository = new AliasRepository();
export const mirrorRepository = new MirrorRepository();
