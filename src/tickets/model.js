import { createHash } from 'node:crypto';

export const CATEGORIES = ['soporte', 'compra', 'reporte', 'apelacion', 'bug', 'otro'];
export const STATUSES = ['OPEN', 'PENDING', 'CLOSED'];
export const PRIORITIES = ['LOW', 'NORMAL', 'HIGH', 'URGENT'];

export function ticketError(message, status = 400) {
  return Object.assign(new Error(message), { status });
}

export function validateTicket({ subject, category, message }) {
  if (!CATEGORIES.includes(category)) throw ticketError(`Categoría inválida: ${CATEGORIES.join(', ')}.`);
  if (typeof subject !== 'string' || subject.trim().length < 5 || subject.trim().length > 150) {
    throw ticketError('El asunto debe tener entre 5 y 150 caracteres.');
  }
  validateBody(message);
}

export function validateBody(body) {
  if (typeof body !== 'string' || !body.trim() || body.length > 5000) {
    throw ticketError('El mensaje debe tener entre 1 y 5000 caracteres.');
  }
}

export const isPrivateJid = (jid) => /@(s\.whatsapp\.net|lid)$/.test(jid || '');

export const waEventId = (jid, messageId) => `wa:${createHash('sha256').update(`${jid}\0${messageId}`).digest('hex')}`;

export function parseOpening(text) {
  const [category, subject, ...message] = text.split('|').map((s) => s.trim());
  const data = { category, subject, message: message.join(' | ') };
  validateTicket(data);
  return data;
}


export const ORIGINS = ['whatsapp', 'discord', 'web'];

/** Aspecto de cada prioridad en Discord (embed, selector y prefijo del canal). */
export const PRIORITY_META = {
  LOW: { emoji: '🟢', color: 0x57f287, label: 'Baja', prefix: '🟢-' },
  NORMAL: { emoji: '🔵', color: 0x5865f2, label: 'Normal', prefix: '🔵-' },
  HIGH: { emoji: '🟠', color: 0xf0b232, label: 'Alta', prefix: '🟠-' },
  URGENT: { emoji: '🔴', color: 0xed4245, label: 'Urgente', prefix: '🔴-' },
};

/** Texto → fragmento válido de nombre de canal (a-z0-9-). */
export const sanitizeChannelName = (text, max = 100) => String(text).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, max);

export const normalizeSlug = (text) => sanitizeChannelName(text, 40);

/** Nombre del canal con el prefijo de prioridad; quita el prefijo anterior si lo había. */
export function priorityChannelName(currentName, priority) {
  const base = Object.values(PRIORITY_META).reduce((name, meta) => (name.startsWith(meta.prefix) ? name.slice(meta.prefix.length) : name), currentName);
  return `${PRIORITY_META[priority].prefix}${base}`.slice(0, 100);
}

export const isSnowflake = (id) => /^\d{16,24}$/.test(String(id || ''));
