import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { Sticker, StickerTypes } from 'wa-sticker-formatter';
import { CONFIG } from '../config.js';
import { getContextInfo } from '../utils/whatsappMessage.js';

/**
 * Helper para construir la estructura de mensaje citado para descarga multimedia.
 * @private
 */
function quotedMediaTarget(remoteJid, contextInfo, innerMessage) {
  return {
    mediaMessage: {
      key: {
        remoteJid,
        id: contextInfo.stanzaId,
        participant: contextInfo.participant,
      },
      message: innerMessage,
    },
    type: 'image',
  };
}

/**
 * Obtiene el mensaje multimedia (imagen) ya sea directo o desde una respuesta (quoted).
 * @param {import('@whiskeysockets/baileys').WAMessage} msg 
 * @returns {object|null} El objeto de mensaje multimedia y el tipo.
 */
export function getMediaFromMessage(msg) {
  const message = msg?.message;
  if (!message) return null;

  // 1. Imagen directa
  if (message.imageMessage) {
    return { mediaMessage: msg, type: 'image' };
  }

  // 2. Imagen dentro de viewOnce (Ver una sola vez)
  const viewOnceMsg = message.viewOnceMessage?.message || message.viewOnceMessageV2?.message;
  if (viewOnceMsg?.imageMessage) {
    return { mediaMessage: { message: viewOnceMsg }, type: 'image' };
  }

  // 3. Respuesta a una imagen (Quoted message)
  const contextInfo = getContextInfo(message);
  const quoted = contextInfo?.quotedMessage;
  if (quoted) {
    if (quoted.imageMessage) {
      return quotedMediaTarget(msg.key.remoteJid, contextInfo, quoted);
    }
    const quotedViewOnce = quoted.viewOnceMessage?.message || quoted.viewOnceMessageV2?.message;
    if (quotedViewOnce?.imageMessage) {
      return quotedMediaTarget(msg.key.remoteJid, contextInfo, quotedViewOnce);
    }
  }

  return null;
}

/**
 * Convierte un mensaje de imagen en un buffer de sticker en formato WebP.
 * @param {object} mediaTarget Objeto con { mediaMessage, type }
 * @param {object} options Opciones de metadatos (pack, author, type)
 * @returns {Promise<Buffer>} Buffer del sticker WebP
 */
export async function createSticker(mediaTarget, options = {}) {
  const buffer = await downloadMediaMessage(
    mediaTarget.mediaMessage,
    'buffer',
    {}
  );

  if (!buffer) {
    throw new Error('No se pudo descargar la imagen del mensaje.');
  }

  const pack = options.pack || CONFIG.sticker.packname;
  const author = options.author || CONFIG.sticker.author;

  let stickerType = StickerTypes.FULL;
  if (options.cropType === 'crop') {
    stickerType = StickerTypes.CROP;
  } else if (options.cropType === 'circle') {
    stickerType = StickerTypes.CIRCLE;
  } else if (options.cropType === 'rounded') {
    stickerType = StickerTypes.ROUNDED;
  }

  const sticker = new Sticker(buffer, {
    pack: pack,
    author: author,
    type: stickerType,
    categories: ['🤩', '🎉'],
    quality: 80
  });

  return await sticker.toBuffer();
}
