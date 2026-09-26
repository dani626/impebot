import { CONFIG } from '../config.js';
import { getMediaFromMessage, createSticker } from '../services/stickerService.js';
import { whatsAppService } from '../services/WhatsAppService.js';
import { extractWaText, parseWaTimestamp, normalizePresence, PRESENCE_TEXTS } from '../utils/whatsappMessage.js';
import { parseCommand } from '../utils/commands.js';

/**
 * Manejador principal de mensajes entrantes de WhatsApp para comandos y stickers.
 * @param {import('@whiskeysockets/baileys').WASocket} sock 
 * @param {import('@whiskeysockets/baileys').WAMessage} msg 
 */
export async function handleMessage(sock, msg) {
  try {
    if (!msg?.message || msg.key?.fromMe) return;

    const jid = msg.key.remoteJid;
    if (jid?.endsWith('@broadcast') || jid?.endsWith('@newsletter')) return;

    // Obtener texto normalizado del mensaje
    const text = extractWaText(msg);
    if (!text) return;

    // Verificar si el mensaje corresponde a un comando válido del bot
    const parsed = parseCommand(text);
    if (!parsed.isCommand) return;

    const { prefix, command, args, restText } = parsed;

    // Ignorar comandos provenientes de sincronización offline antigua (más de 3 minutos)
    const timestampSec = parseWaTimestamp(msg);
    const ageSeconds = Math.floor(Date.now() / 1000) - timestampSec;
    if (ageSeconds > 180) {
      return;
    }

    console.log(`[COMANDO RECEPCIONADO] JID: ${jid} | Comando: ${prefix}${command}`);

    switch (command) {
      case 's':
      case 'sticker':
      case 'scrop':
      case 'scircle':
      case 'sround': {
        const mediaTarget = getMediaFromMessage(msg);

        if (!mediaTarget) {
          await sock.sendMessage(jid, {
            text: `⚠️ *Para crear un sticker:*\n\n1. Envía una imagen con el texto \`${prefix}s\` en el comentario (caption).\n2. O responde a una imagen existente con el comando \`${prefix}s\`.\n\n💡 *Tip:* Usa \`${prefix}scrop\` para recortar en cuadrado o \`${prefix}scircle\` para sticker circular.`
          }, { quoted: msg });
          return;
        }

        // Reaccionar al mensaje indicando procesamiento
        await sock.sendMessage(jid, { react: { text: '⏳', key: msg.key } });

        // Determinar tipo de recorte
        let cropType = 'full';
        if (command === 'scrop' || args[0] === 'crop') cropType = 'crop';
        if (command === 'scircle' || args[0] === 'circle') cropType = 'circle';
        if (command === 'sround' || args[0] === 'round') cropType = 'rounded';

        // Analizar nombre de pack y autor (ejemplo: !s Mi Pack | Mi Nombre)
        let pack = CONFIG.sticker.packname;
        let author = CONFIG.sticker.author;

        if (restText.includes('|')) {
          const parts = restText.split('|');
          pack = parts[0].trim() || pack;
          author = parts[1].trim() || author;
        } else if (restText && args[0] !== 'crop' && args[0] !== 'circle') {
          pack = restText;
        }

        // Generar y enviar el sticker
        const stickerBuffer = await createSticker(mediaTarget, {
          pack,
          author,
          cropType
        });

        await sock.sendMessage(jid, { sticker: stickerBuffer }, { quoted: msg });
        
        // Reaccionar con éxito
        await sock.sendMessage(jid, { react: { text: '✅', key: msg.key } });
        break;
      }

      case 'presence':
      case 'presencia': {
        const mode = normalizePresence(args[0]);
        if (mode) {
          await whatsAppService.setPresence(mode);
          await sock.sendMessage(jid, { text: PRESENCE_TEXTS[mode] }, { quoted: msg });
        } else {
          const { label } = whatsAppService.getPresence();
          await sock.sendMessage(
            jid,
            { text: PRESENCE_TEXTS.getStatus(label, prefix) },
            { quoted: msg }
          );
        }
        break;
      }

      case 'online': {
        await whatsAppService.setPresence('available');
        await sock.sendMessage(jid, { text: PRESENCE_TEXTS.available }, { quoted: msg });
        break;
      }

      case 'offline': {
        await whatsAppService.setPresence('unavailable');
        await sock.sendMessage(jid, { text: PRESENCE_TEXTS.unavailable }, { quoted: msg });
        break;
      }

      case 'help':
      case 'menu':
      case 'bot': {
        const helpMessage = `🤖 *${CONFIG.botName}* 🤖\n\n` +
          `✨ *Comandos de Stickers:*\n` +
          `• \`${prefix}s\` : Convierte la imagen a sticker (tamaño completo).\n` +
          `• \`${prefix}scrop\` : Sticker recortado en cuadrado.\n` +
          `• \`${prefix}scircle\` : Sticker recortado en círculo.\n` +
          `• \`${prefix}s Mi Pack | Mi Nombre\` : Personaliza los metadatos del sticker.\n\n` +
          `⚙️ *Comandos de Estado:*\n` +
          `• \`${prefix}presence [online|offline]\` : Consulta o cambia visibilidad del bot.\n` +
          `• \`${prefix}online\` / \`${prefix}offline\` : Atajos directos para cambiar estado.\n\n` +
          `📌 *¿Cómo usarlo?*\n` +
          `Envía una imagen con el comando en la leyenda, o responde a cualquier foto enviada con el comando \`${prefix}s\`.`;

        await sock.sendMessage(jid, { text: helpMessage }, { quoted: msg });
        break;
      }
    }
  } catch (error) {
    console.error('Error al procesar el mensaje:', error);
    try {
      await sock.sendMessage(msg.key.remoteJid, {
        text: '❌ Ocurrió un error al intentar crear el sticker. Inténtalo de nuevo con otra imagen.'
      }, { quoted: msg });
    } catch {
      // Ignorar fallo de envío secundario
    }
  }
}
