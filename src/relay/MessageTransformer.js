import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { CONFIG } from '../config.js';
import { messageLogRepository } from '../database/repositories/MessageLogRepository.js';
import { extractWaText, getContextInfo } from '../utils/whatsappMessage.js';

const MEDIA_DEFINITIONS = {
  imageMessage: () => ({ ext: 'jpg', prefix: 'image' }),
  videoMessage: (msg) => ({ ext: 'mp4', prefix: 'video', isVideo: true, mimetype: msg.mimetype || 'video/mp4' }),
  audioMessage: (msg) => ({ ext: 'ogg', prefix: msg.ptt ? 'voice' : 'audio' }),
  stickerMessage: () => ({ ext: 'webp', prefix: 'sticker' }),
  documentMessage: (msg) => ({ fileName: msg.fileName || `document_${Date.now()}` }),
};

export class MessageTransformer {
  /**
   * Transforma un mensaje entrante de WhatsApp al formato de Discord.
   * @param {object} waMessageData Datos del mensaje de WhatsApp emitidos por WhatsAppService
   * @param {{ channelId?: string, guildId?: string }} [contextOptions={}] Opciones de canal/servidor de Discord
   * @returns {Promise<{ content: string, files: AttachmentBuilder[], embeds: EmbedBuilder[] }>}
   */
  static async toDiscord(waMessageData, contextOptions = {}) {
    const { rawMessage, text, timestamp, isDelayed } = waMessageData;
    const message = rawMessage.message;
    const files = [];
    let content = text || '';

    // Manejo de respuesta citada (quoted context)
    const contextInfo = getContextInfo(message);

    if (contextInfo?.quotedMessage) {
      const quotedSender = contextInfo.participant?.split('@')[0] || 'alguien';
      const quotedText = (extractWaText(contextInfo.quotedMessage) || '[Multimedia]').slice(0, 100);

      // Buscar si el mensaje citado tiene URL en Discord mediante los logs de la BD
      let jumpUrl = null;
      const stanzaId = contextInfo.stanzaId;
      if (stanzaId && contextOptions.channelId) {
        try {
          const logEntry = await messageLogRepository.getByWaMessageId(stanzaId);
          if (logEntry?.discord_message_id) {
            const guildId = contextOptions.guildId || CONFIG.discord.guildId || '@me';
            jumpUrl = `https://discord.com/channels/${guildId}/${contextOptions.channelId}/${logEntry.discord_message_id}`;
          }
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
      try {
        const buffer = await downloadMediaMessage(rawMessage, 'buffer', {});
        const info = MEDIA_DEFINITIONS[mediaKey](message[mediaKey]);
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
        console.error('[MessageTransformer] Error descargando multimedia de WhatsApp:', mediaError.message);
        content = `${content}\n⚠️ *(No se pudo descargar el archivo adjunto de WhatsApp)*`;
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

    return { content: content.trim(), files, embeds, pendingCatboxVideo };
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
