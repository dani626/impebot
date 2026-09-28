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

/**
 * Da formato legible de número telefónico internacional a partir de un JID de WhatsApp.
 * Soporta números de Chile, Ecuador, Argentina, México, Colombia, Perú, España, USA, etc.
 * @param {string} jid JID de WhatsApp (ej. 56976751133@s.whatsapp.net)
 * @returns {string} Número con formato internacional (ej. +56 9 7675 1133)
 */
export function formatPhoneNumber(jid) {
  if (!jid || typeof jid !== 'string') return '';
  const rawNumber = jid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
  if (!rawNumber) return jid;

  // Chile +56 9 xxxx xxxx (11 dígitos)
  if (rawNumber.startsWith('56') && rawNumber.length === 11) {
    return `+56 ${rawNumber[2]} ${rawNumber.slice(3, 7)} ${rawNumber.slice(7)}`;
  }
  // Ecuador +593 99 xxx xxxx (12 dígitos)
  if (rawNumber.startsWith('593') && rawNumber.length === 12) {
    return `+593 ${rawNumber.slice(3, 5)} ${rawNumber.slice(5, 8)} ${rawNumber.slice(8)}`;
  }
  // Argentina +54 9 xx xxxx xxxx (13 dígitos) o similar
  if (rawNumber.startsWith('549') && rawNumber.length >= 12) {
    return `+54 9 ${rawNumber.slice(3, 5)} ${rawNumber.slice(5, 9)} ${rawNumber.slice(9)}`;
  }
  // México +52 1 xx xxxx xxxx (12 dígitos)
  if (rawNumber.startsWith('52') && rawNumber.length === 12 && rawNumber[2] === '1') {
    return `+52 1 ${rawNumber.slice(3, 5)} ${rawNumber.slice(5, 9)} ${rawNumber.slice(9)}`;
  }
  // Colombia +57 3xx xxx xxxx (12 dígitos)
  if (rawNumber.startsWith('57') && rawNumber.length === 12) {
    return `+57 ${rawNumber.slice(2, 5)} ${rawNumber.slice(5, 8)} ${rawNumber.slice(8)}`;
  }
  // Perú +51 9xx xxx xxx (11 dígitos)
  if (rawNumber.startsWith('51') && rawNumber.length === 11) {
    return `+51 ${rawNumber.slice(2, 5)} ${rawNumber.slice(5, 8)} ${rawNumber.slice(8)}`;
  }
  // España +34 xxx xx xx xx (11 dígitos)
  if (rawNumber.startsWith('34') && rawNumber.length === 11) {
    return `+34 ${rawNumber.slice(2, 5)} ${rawNumber.slice(5, 7)} ${rawNumber.slice(7, 9)} ${rawNumber.slice(9)}`;
  }
  // USA / Canadá +1 (xxx) xxx-xxxx (11 dígitos)
  if (rawNumber.startsWith('1') && rawNumber.length === 11) {
    return `+1 (${rawNumber.slice(1, 4)}) ${rawNumber.slice(4, 7)}-${rawNumber.slice(7)}`;
  }

  return `+${rawNumber}`;
}

/**
 * Genera el texto descriptivo en español de la acción de entrada o salida de un miembro del grupo.
 * Replica el comportamiento y textos nativos de WhatsApp.
 * @param {object} params
 * @param {'add'|'remove'} params.action Acción principal recibida
 * @param {number|null} [params.stubType] Código numérico WAMessageStubType si está disponible
 * @param {string|null} [params.author] JID de quien ejecutó la acción si aplica
 * @param {string} params.participant JID del miembro afectado
 * @param {string|null} [params.authorName] Nombre resuelto de quien ejecutó la acción
 * @returns {string} Texto explicativo (ej. "se unió a través de un enlace de invitación.")
 */
export function resolveParticipantActionText({ action, stubType, author, participant, authorName }) {
  const isSelf = !author || author === participant;

  if (action === 'add') {
    // 31: GROUP_PARTICIPANT_INVITE
    if (stubType === 31 || (isSelf && !authorName)) {
      return 'se unió a través de un enlace de invitación.';
    }
    // 71: GROUP_PARTICIPANT_ADD_REQUEST_JOIN
    if (stubType === 71) {
      return 'se unió tras la aprobación de su solicitud de ingreso.';
    }
    // Si fue añadido por un administrador o tercero
    if (!isSelf && authorName) {
      return `fue añadido(a) al grupo por **${authorName}**.`;
    }
    return 'se unió al grupo.';
  }

  if (action === 'remove') {
    // 32: GROUP_PARTICIPANT_LEAVE (voluntario)
    if (stubType === 32 || isSelf) {
      return 'salió del grupo.';
    }
    // 28: GROUP_PARTICIPANT_REMOVE (eliminado por admin)
    if (stubType === 28 || (!isSelf && authorName)) {
      return `fue eliminado(a) del grupo por **${authorName}**.`;
    }
    return 'salió del grupo.';
  }

  return action === 'add' ? 'se unió al grupo.' : 'salió del grupo.';
}


