import { CONFIG } from '../config.js';
import { dbService } from '../database/DatabaseService.js';
import { commandLogRepository } from '../database/repositories/CommandLogRepository.js';

const ICONS = { ok: '✅', recibido: '📥', denegado: '⛔', error: '❌', uso: '⚠️', ignorado: '➖', desconocido: '❓' };
const SOURCE_LABEL = { whatsapp: 'WHATSAPP', consola: 'CONSOLA', discord: 'DISCORD', sistema: 'SISTEMA' };
const PURGE_EVERY_MS = 6 * 60 * 60 * 1000;

const clip = (value, max) => {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** Línea de texto legible para la consola. */
export function formatCommandLog(e) {
  const icon = ICONS[e.status] || '•';
  const who = e.actorName ? `${e.actorName} (${e.actorId || '?'})` : (e.actorId || '?');
  const where = e.chatId ? ` en ${e.chatId}` : '';
  const args = e.args ? ` ${e.args}` : '';
  const detail = e.detail ? ` → ${e.detail}` : '';
  return `📝 [CMD:${SOURCE_LABEL[e.source] || e.source}] ${icon} ${e.status.toUpperCase()} | ${who}${where} | ${e.command}${args}${detail}`;
}

export class CommandLogService {
  constructor() {
    this.lastPurge = 0;
    this.warnedDb = false;
  }

  /**
   * Registra un comando en la consola y, si hay MariaDB, en la tabla command_logs.
   * Nunca lanza: registrar no puede romper el comando.
   * @param {{ source: 'whatsapp'|'consola'|'discord'|'sistema', actorId?: string, actorName?: string, chatId?: string,
   *   command: string, args?: string, status: string, detail?: string }} entry
   */
  log(entry) {
    const e = {
      source: entry.source,
      actorId: clip(entry.actorId, 128),
      actorName: clip(entry.actorName, 128),
      chatId: clip(entry.chatId, 128),
      command: clip(entry.command, 64) || '?',
      args: clip(entry.args, 500),
      status: clip(entry.status, 16) || 'ok',
      detail: clip(entry.detail, 255),
    };
    console.log(formatCommandLog(e));
    void this.persist(e);
    return e;
  }

  async persist(e) {
    if (!CONFIG.commandLog.toDatabase || !dbService.isConnected) return;
    try {
      await commandLogRepository.insert(e);
      await this.purgeIfDue();
    } catch (err) {
      if (!this.warnedDb) {
        this.warnedDb = true;
        console.warn(`⚠️ [CommandLog] No se pudo guardar en la base de datos: ${err.message}`);
      }
    }
  }

  async purgeIfDue() {
    const now = Date.now();
    if (now - this.lastPurge < PURGE_EVERY_MS) return;
    this.lastPurge = now;
    await commandLogRepository.purgeOlderThan(CONFIG.commandLog.retentionDays);
  }
}

export const commandLogService = new CommandLogService();
