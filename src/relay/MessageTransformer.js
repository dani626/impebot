import { AttachmentBuilder, EmbedBuilder } from 'discord.js';
import { downloadMediaMessage } from '@whiskeysockets/baileys';
import { CONFIG } from '../config.js';

export class MessageTransformer {
  /**
   * Transforma un mensaje entrante de WhatsApp al formato de Discord.
   * @param {object} waMessageData Datos del mensaje de WhatsApp emitidos por WhatsAppService
   * @returns {Promise<{ content: string, files: AttachmentBuilder[], embeds: EmbedBuilder[] }>}
   */
  static async toDiscord(waMessageData) {
    const { rawMessage, text, timestamp, isDelayed } = waMessageData;
    const message = rawMessage.message;
    const files = [];
    let content = text || '';

    // Manejo de respuesta citada (quoted context)
    const contextInfo = message?.extendedTextMessage?.contextInfo ||
                        message?.imageMessage?.contextInfo ||
                        message?.videoMessage?.contextInfo;

    if (contextInfo?.quotedMessage) {
      const quotedSender = contextInfo.participant?.split('@')[0] || 'alguien';
      const quotedText = (
        contextInfo.quotedMessage.conversation ||
        contextInfo.quotedMessage.extendedTextMessage?.text ||
        contextInfo.quotedMessage.imageMessage?.caption ||
        '[Multimedia]'
      ).slice(0, 100);

      content = `> 💬 **${quotedSender}:** ${quotedText}\n${content}`;
    }

    // Identificar y descargar archivos multimedia adjuntos
    try {
      if (message?.imageMessage) {
        const buffer = await downloadMediaMessage(rawMessage, 'buffer', {});
        const fileName = `image_${Date.now()}.jpg`;
        files.push(new AttachmentBuilder(buffer, { name: fileName }));
      } else if (message?.videoMessage) {
        const buffer = await downloadMediaMessage(rawMessage, 'buffer', {});
        const fileName = `video_${Date.now()}.mp4`;
        files.push(new AttachmentBuilder(buffer, { name: fileName }));
      } else if (message?.audioMessage) {
        const buffer = await downloadMediaMessage(rawMessage, 'buffer', {});
        const isVoice = message.audioMessage.ptt;
        const fileName = `${isVoice ? 'voice' : 'audio'}_${Date.now()}.ogg`;
        files.push(new AttachmentBuilder(buffer, { name: fileName }));
      } else if (message?.stickerMessage) {
        const buffer = await downloadMediaMessage(rawMessage, 'buffer', {});
        const fileName = `sticker_${Date.now()}.webp`;
        files.push(new AttachmentBuilder(buffer, { name: fileName }));
      } else if (message?.documentMessage) {
        const buffer = await downloadMediaMessage(rawMessage, 'buffer', {});
        const fileName = message.documentMessage.fileName || `document_${Date.now()}`;
        files.push(new AttachmentBuilder(buffer, { name: fileName }));
      }
    } catch (mediaError) {
      console.error('[MessageTransformer] Error descargando multimedia de WhatsApp:', mediaError.message);
      content = `${content}\n⚠️ *(No se pudo descargar el archivo adjunto de WhatsApp)*`;
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

    return { content: content.trim(), files, embeds };
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
          baseText = `> *${repliedAuthor}:* ${repliedSnippet}\n${baseText}`;
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
