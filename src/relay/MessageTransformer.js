import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { CONFIG } from '../config.js';
import { messageMappingRepository } from '../database/repositories/MessageMappingRepository.js';
import { extractWaText, getContextInfo } from '../utils/whatsappMessage.js';

const MEDIA_DEFINITIONS = {
  imageMessage: () => ({ ext: 'jpg', prefix: 'image' }),
  videoMessage: (msg) => ({ ext: 'mp4', prefix: 'video', isVideo: true, mimetype: msg.mimetype || 'video/mp4' }),
  audioMessage: (msg) => ({ ext: 'ogg', prefix: msg.ptt ? 'voice' : 'audio' }),
  stickerMessage: () => ({ ext: 'webp', prefix: 'sticker' }),
  documentMessage: (msg) => ({ fileName: msg.fileName || `document_${Date.now()}` }),
};

const MB = 1024 * 1024;
const formatMb = (bytes) => `${(bytes / MB).toFixed(1)} MB`;

export class MediaTooLargeError extends Error {
  constructor(size, limit) {
    super(`${formatMb(size)} supera el límite de ${formatMb(limit)}`);
    this.size = size;
    this.limit = limit;
  }
}

/** fileLength de Baileys puede venir como número, string o Long. */
export function toByteCount(value) {
  if (value === null || value === undefined) return 0;
  const n = typeof value?.toNumber === 'function' ? value.toNumber() : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Tamaño máximo que se descarga de un adjunto. Lo que va directo a Discord no puede superar
 * su límite de subida; los videos que se suben a Catbox admiten RELAY_MAX_MEDIA_MB.
 */
export function mediaSizeLimit(info, config = CONFIG) {
  const direct = config.catbox?.maxDirectUploadBytes || 10 * MB;
  if (info?.isVideo && config.catbox?.enabled) return Math.max(direct, config.relay?.maxMediaBytes || 100 * MB);
  return direct;
}

export class MessageTransformer {
  /**
   * Transforma un mensaje entrante de WhatsApp al formato de Discord.
   * @param {object} waMessageData Datos del mensaje de WhatsApp emitidos por WhatsAppService
   * @param {{ channelId?: string, guildId?: string, mappingId?: number }} [contextOptions={}] Canal/servidor de Discord y vínculo de destino
   * @returns {Promise<{ content: string, files: AttachmentBuilder[], embeds: EmbedBuilder[] }>}
   */
  static async toDiscord(waMessageData, contextOptions = {}) {
    const { rawMessage, text, timestamp, isDelayed } = waMessageData;
    const message = rawMessage.message;
    const files = [];
    let content = text || '';
    /** Copias del mensaje citado y enlace usado, para adaptar la cita a otros canales de destino. */
    let quote = null;

    // Manejo de respuesta citada (quoted context)
    const contextInfo = getContextInfo(message);

    if (contextInfo?.quotedMessage) {
      const quotedSender = contextInfo.participant?.split('@')[0] || 'alguien';
      const quotedText = (extractWaText(contextInfo.quotedMessage) || '[Multimedia]').slice(0, 100);

      // Buscar si el mensaje citado tiene URL en Discord mediante los mapeos de la BD
      let jumpUrl = null;
      const stanzaId = contextInfo.stanzaId;
      if (stanzaId && contextOptions.channelId) {
        try {
          // Con varios canales por chat, el enlace debe apuntar a la copia del canal de destino.
          const copies = await messageMappingRepository.getAllByWaMessageId(stanzaId);
          const logEntry = contextOptions.mappingId
            ? copies.find((row) => Number(row.channel_mapping_id) === Number(contextOptions.mappingId))
            : copies.at(-1);
          if (logEntry?.discord_message_id) {
            const guildId = contextOptions.guildId || CONFIG.discord.guildId || '@me';
            jumpUrl = `https://discord.com/channels/${guildId}/${contextOptions.channelId}/${logEntry.discord_message_id}`;
          }
          quote = { copies, jumpUrl };
        } catch {
          // Ignorar error al buscar registro
        }
      }

      if (jumpUrl) {
        content = `> 💬 **${quotedSender}:** ${quotedText} • [Ver mensaje](${jumpUrl})\n> 🔗 ${jumpUrl}\n${content}`;
      } else {
        content = `> 💬 **${quotedSender}:** ${quotedText}\n${content}`;
      }
    }

    // Identificar y descargar archivos multimedia adjuntos
    let pendingCatboxVideo = null;
    const mediaKey = Object.keys(MEDIA_DEFINITIONS).find((key) => message?.[key]);

    if (mediaKey) {
      const info = MEDIA_DEFINITIONS[mediaKey](message[mediaKey]);
      const limit = mediaSizeLimit(info);
      const declaredBytes = toByteCount(message[mediaKey].fileLength);
      try {
        // No descargar a memoria archivos que de todos modos no se pueden reenviar (documentos de hasta 2 GB).
        if (declaredBytes > limit) throw new MediaTooLargeError(declaredBytes, limit);
        const buffer = await downloadMediaMessage(rawMessage, 'buffer', {});
        // fileLength puede faltar o mentir: comprobar también el tamaño real.
        if (buffer.length > limit) throw new MediaTooLargeError(buffer.length, limit);
        const fileName = info.fileName || `${info.prefix}_${Date.now()}.${info.ext}`;

        if (info.isVideo) {
          const maxDirectBytes = CONFIG.catbox?.maxDirectUploadBytes || 10 * 1024 * 1024;
          const alwaysCatbox = Boolean(CONFIG.catbox?.alwaysUse);

          if (CONFIG.catbox?.enabled && (alwaysCatbox || buffer.length > maxDirectBytes)) {
            pendingCatboxVideo = {
              buffer,
              fileName,
              mimetype: info.mimetype,
              sizeBytes: buffer.length,
            };
          } else {
            files.push(new AttachmentBuilder(buffer, { name: fileName }));
          }
        } else {
          files.push(new AttachmentBuilder(buffer, { name: fileName }));
        }
      } catch (mediaError) {
        if (mediaError instanceof MediaTooLargeError) {
          console.warn(`[MessageTransformer] Adjunto omitido: ${mediaError.message}`);
          content = `${content}\n⚠️ *(Archivo adjunto de ${formatMb(mediaError.size)} omitido: supera el límite de ${formatMb(mediaError.limit)})*`;
        } else {
          console.error('[MessageTransformer] Error descargando multimedia de WhatsApp:', mediaError.message);
          content = `${content}\n⚠️ *(No se pudo descargar el archivo adjunto de WhatsApp)*`;
        }
      }
    }

    // Crear Embed con la fecha y hora original para mensajes recuperados o sincronizados
    const embeds = [];
    const mode = CONFIG.relay?.embedTimestampMode || 'missed';
    const shouldEmbed = mode === 'all' || (mode !== 'none' && isDelayed);

    if (shouldEmbed && timestamp) {
      const msgDate = new Date(timestamp * 1000);
      const embed = new EmbedBuilder()
        .setColor(0x25d366) // Verde oficial de WhatsApp
        .setDescription(`🕒 **Fecha y hora original:** <t:${timestamp}:F> (<t:${timestamp}:R>)`)
        .setTimestamp(msgDate)
        .setFooter({ text: 'WhatsApp • Mensaje recuperado' });

      embeds.push(embed);
    }

    return { content: content.trim(), files, embeds, pendingCatboxVideo, quote };
  }

  /**
   * Transforma un mensaje de Discord al formato de envío para WhatsApp (Baileys).
   * @param {import('discord.js').Message} discordMessage 
   * @returns {Promise<Array<{ content: object, options?: object }>>} Lista de cargas a enviar por Baileys
   */
  static async toWhatsApp(discordMessage) {
    const payloads = [];
    const authorName = discordMessage.member?.displayName || discordMessage.author.username;
    let baseText = discordMessage.cleanContent || '';

    // Manejo de respuesta citada en Discord
    if (discordMessage.reference && discordMessage.reference.messageId) {
      try {
        const repliedMsg = await discordMessage.channel.messages.fetch(discordMessage.reference.messageId);
        if (repliedMsg) {
          const repliedAuthor = repliedMsg.member?.displayName || repliedMsg.author.username;
          const repliedSnippet = (repliedMsg.cleanContent || '[Archivo]').slice(0, 80);
          const replyUrl = repliedMsg.url;
          baseText = `> *${repliedAuthor}:* ${repliedSnippet}\n> 🔗 ${replyUrl}\n${baseText}`;
        }
      } catch (e) {
        // Si no se puede obtener el mensaje citado, continuamos sin contexto
      }
    }

    const header = `*[${authorName}]:*`;

    // Procesar archivos adjuntos de Discord
    if (discordMessage.attachments.size > 0) {
      let isFirst = true;

      for (const [, attachment] of discordMessage.attachments) {
        const caption = isFirst ? (baseText ? `${header} ${baseText}` : header) : undefined;
        isFirst = false;

        const contentType = attachment.contentType || '';
        const url = attachment.url;

        if (contentType.startsWith('image/')) {
          payloads.push({
            content: {
              image: { url },
              caption,
            },
          });
        } else if (contentType.startsWith('video/')) {
          payloads.push({
            content: {
              video: { url },
              caption,
            },
          });
        } else if (contentType.startsWith('audio/')) {
          payloads.push({
            content: {
              audio: { url },
              mimetype: contentType,
            },
          });
          // Si había texto además del audio, enviarlo como mensaje adicional
          if (caption) {
            payloads.push({ content: { text: caption } });
          }
        } else {
          // Documento / archivo general
          payloads.push({
            content: {
              document: { url },
              mimetype: contentType || 'application/octet-stream',
              fileName: attachment.name,
              caption,
            },
          });
        }
      }
    } else if (baseText) {
      // Solo texto
      payloads.push({
        content: {
          text: `${header} ${baseText}`,
        },
      });
    }

    return payloads;
  }
}
