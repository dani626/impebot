import { dbService } from '../DatabaseService.js';

export class ModerationRepository {
  /** Guarda un baneo con todos los identificadores conocidos de la persona (LID y número). */
  async addBan(groupJid, userJids, { reason = null, bannedBy = null } = {}) {
    const ids = [...new Set(userJids.filter(Boolean))];
    if (!ids.length) return;
    const primary = ids[0];
    for (const id of ids) {
      await dbService.query(
        `INSERT INTO wa_bans (group_jid, user_jid, primary_jid, reason, banned_by) VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE reason = VALUES(reason), banned_by = VALUES(banned_by), primary_jid = VALUES(primary_jid)`,
        [groupJid, id, primary, reason, bannedBy]
      );
    }
  }

  /** Filas de baneo del grupo (una por identificador). */
  async getBans(groupJid) {
    return await dbService.query(
      'SELECT user_jid, primary_jid, reason, banned_by, created_at FROM wa_bans WHERE group_jid = ? ORDER BY id ASC',
      [groupJid]
    );
  }

  /** Elimina todos los identificadores de las personas indicadas. @returns {Promise<number>} filas borradas */
  async removeBansByPrimary(groupJid, primaryJids) {
    if (!primaryJids.length) return 0;
    const res = await dbService.query(
      `DELETE FROM wa_bans WHERE group_jid = ? AND primary_jid IN (${primaryJids.map(() => '?').join(',')})`,
      [groupJid, ...primaryJids]
    );
    return Number(res?.affectedRows ?? 0);
  }
}

export const moderationRepository = new ModerationRepository();
