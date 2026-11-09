import { dbService } from '../DatabaseService.js';

export class CommandLogRepository {
  async insert(e) {
    return await dbService.query(
      `INSERT INTO command_logs (source, actor_id, actor_name, chat_id, command, args, status, detail)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [e.source, e.actorId, e.actorName, e.chatId, e.command, e.args, e.status, e.detail]
    );
  }

  async recent(limit = 20) {
    return await dbService.query(
      'SELECT created_at, source, actor_id, actor_name, chat_id, command, args, status, detail FROM command_logs ORDER BY id DESC LIMIT ?',
      [Math.min(Math.max(limit, 1), 100)]
    );
  }

  async purgeOlderThan(days) {
    return await dbService.query('DELETE FROM command_logs WHERE created_at < (NOW() - INTERVAL ? DAY)', [days]);
  }
}

export const commandLogRepository = new CommandLogRepository();
