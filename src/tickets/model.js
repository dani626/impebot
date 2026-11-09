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

