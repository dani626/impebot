/**
 * Utilidades para normalizar y extraer información de mensajes de WhatsApp (Baileys).
 */

/**
 * Extrae de forma exhaustiva el texto o pie de foto (caption) de un mensaje de WhatsApp.
 * Soporta conversation, extendedTextMessage, captions de multimedia y mensajes efímeros/viewOnce.
 * @param {object} msg Mensaje WAMessage completo o su contenido msg.message
 * @returns {string} Texto limpio sin espacios sobrantes
 */
export function extractWaText(msg) {
  if (!msg) return '';
  const message = msg.message || msg;

  const text = (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    message.documentMessage?.caption ||
    message.viewOnceMessage?.message?.imageMessage?.caption ||
    message.viewOnceMessage?.message?.videoMessage?.caption ||
    message.viewOnceMessageV2?.message?.imageMessage?.caption ||
    message.viewOnceMessageV2?.message?.videoMessage?.caption ||
    ''
  );

  return typeof text === 'string' ? text.trim() : '';
}

/**
 * Normaliza y extrae el timestamp en segundos (Unix epoch) de un mensaje de Baileys.
 * Soporta números primitivos, objetos Long de protobuf ({ low, high }) y timestamps numéricos.
 * @param {object|number} msg WAMessage o messageTimestamp directamente
 * @returns {number} Timestamp en segundos
 */
export function parseWaTimestamp(msg) {
  if (msg === null || msg === undefined) {
    return Math.floor(Date.now() / 1000);
  }

  const raw = typeof msg === 'object' && ('messageTimestamp' in msg) ? msg.messageTimestamp : msg;

  if (typeof raw === 'number') {
    return raw;
  }
  if (raw && typeof raw === 'object' && typeof raw.low === 'number') {
    return raw.low;
  }
  const num = Number(raw);
  return !isNaN(num) && num > 0 ? num : Math.floor(Date.now() / 1000);
}

/**
 * Obtiene el objeto contextInfo de cualquier tipo de mensaje que lo contenga.
 * @param {object} msg WAMessage o su contenido msg.message
 * @returns {object|null}
 */
export function getContextInfo(msg) {
  if (!msg) return null;
  const message = msg.message || msg;

  return (
    message.extendedTextMessage?.contextInfo ||
    message.imageMessage?.contextInfo ||
    message.videoMessage?.contextInfo ||
    message.documentMessage?.contextInfo ||
    message.audioMessage?.contextInfo ||
    message.stickerMessage?.contextInfo ||
    null
  );
}

/**
 * Normaliza un identificador de presencia a los valores soportados por Baileys ('available' | 'unavailable').
 * @param {string} mode Texto o alias de presencia
 * @returns {'available'|'unavailable'|null}
 */
export function normalizePresence(mode) {
  if (!mode || typeof mode !== 'string') return null;
  const m = mode.trim().toLowerCase();
  if (m === 'online' || m === 'available' || m === 'on') return 'available';
  if (m === 'offline' || m === 'unavailable' || m === 'off' || m === 'invisible') return 'unavailable';
  return null;
}

/**
 * Mensajes estándar de respuesta para cambios o consultas de presencia.
 */
export const PRESENCE_TEXTS = {
  available: '🟢 *WhatsApp:* Modo cambiado a *ONLINE* (En línea / Visible).',
  unavailable: '⚪ *WhatsApp:* Modo cambiado a *OFFLINE* (Invisible / Desconectado).',
  getStatus(label, prefix = '!') {
    const isOnline = label === 'online' || label === 'available';
    return (
      `📱 *Estado actual en WhatsApp:* ${isOnline ? '🟢 ONLINE' : '⚪ OFFLINE (invisible)'}\n\n` +
      `💡 *Para cambiarlo usa:*\n` +
      `• \`${prefix}presence online\`\n` +
      `• \`${prefix}presence offline\``
    );
  },
};

/**
 * Detecta si un mensaje recibido corresponde a una revocación / eliminación ("eliminar para todos").
 * Extrae la clave del mensaje que fue revocado si aplica.
 * @param {object} msg Mensaje WAMessage de Baileys
 * @returns {{ isRevoke: boolean, revokedKey?: { id: string, remoteJid?: string, fromMe?: boolean, participant?: string } }}
 */
export function extractRevokedMessageKey(msg) {
  if (!msg) return { isRevoke: false };

  const message = msg.message;
  const protocolMsg =
    message?.protocolMessage ||
    message?.ephemeralMessage?.message?.protocolMessage ||
    message?.viewOnceMessage?.message?.protocolMessage ||
    message?.viewOnceMessageV2?.message?.protocolMessage;

  // ProtocolMessage.Type.REVOKE es 0
  if (protocolMsg && protocolMsg.type === 0 && protocolMsg.key?.id) {
    return {
      isRevoke: true,
      revokedKey: {
        id: protocolMsg.key.id,
        remoteJid: protocolMsg.key.remoteJid || msg.key?.remoteJid,
        fromMe: Boolean(protocolMsg.key.fromMe),
        participant: protocolMsg.key.participant || msg.key?.participant,
      },
    };
  }

  return { isRevoke: false };
}


