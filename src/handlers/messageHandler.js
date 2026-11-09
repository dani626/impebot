import { CONFIG } from '../config.js';
import { getMediaFromMessage, createSticker } from '../services/stickerService.js';
import { whatsAppService } from '../services/WhatsAppService.js';
import { extractWaText, parseWaTimestamp, normalizePresence, PRESENCE_TEXTS } from '../utils/whatsappMessage.js';
import { parseCommand } from '../utils/commands.js';
import { moderationService } from '../services/ModerationService.js';
import { commandLogService } from '../services/CommandLogService.js';

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

    const { prefix, command, invoked, args, restText } = parsed;

    // Ignorar comandos provenientes de sincronización offline antigua (más de 3 minutos)
    const timestampSec = parseWaTimestamp(msg);
    const ageSeconds = Math.floor(Date.now() / 1000) - timestampSec;
    if (ageSeconds > 180) {
      return;
    }

    // Registro de auditoría: cada comando queda en consola y en la base de datos con su resultado.
    const audit = { status: 'ok', detail: null };
    try {
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

      case 'borrar':
      case 'ban':
      case 'desban':
      case 'bans':
      case 'kick':
      case 'warn':
      case 'warns':
      case 'unwarn': {
        try {
          const result = await moderationService.handle({ sock, msg, command, args, prefix });
          audit.status = result.status;
          audit.detail = result.detail || null;
        } catch (modErr) {
          audit.status = 'error';
          audit.detail = modErr.message;
          await sock.sendMessage(jid, { text: '❌ No se pudo completar la acción. Revisa que el bot sea administrador del grupo.' }, { quoted: msg }).catch(() => {});
        }
        break;
      }

      case 'help':
      case 'menu':
      case 'bot': {
        const p = prefix;
        const helpMessage = `🤖 *${CONFIG.botName}* 🤖\n_Cada comando funciona en español e inglés / Every command works in Spanish and English_\n\n` +
          (CONFIG.tickets.enabled ? `🎫 *Soporte / Support* (privado):\n• ${p}ticket · ${p}tickets / ${p}mytickets\n• ${p}responder / ${p}reply N | mensaje\n• ${p}cerrar / ${p}close N\n• ${p}vincular / ${p}link CODIGO\n• ${p}cancelar / ${p}cancel\n\n` : '') +
          `✨ *Stickers:*\n` +
          `• ${p}s / ${p}sticker : sticker completo / full sticker\n` +
          `• ${p}scrop / ${p}srecorte : cuadrado / square\n` +
          `• ${p}scircle / ${p}scirculo : círculo / circle\n` +
          `• ${p}sround / ${p}sredondo : bordes redondeados / rounded\n` +
          `• ${p}s Mi Pack | Mi Nombre : metadatos / metadata\n\n` +
          `🛡️ *Moderación / Moderation* (admins/staff, en grupos):\n` +
          `• ${p}borrar / ${p}delete : responde a un mensaje / reply to a message\n` +
          `• ${p}kick / ${p}expulsar @usuario : expulsa / removes\n` +
          `• ${p}ban / ${p}banear @usuario motivo : expulsa y bloquea / removes and blocks\n` +
          `• ${p}desban / ${p}unban @usuario\n` +
          `• ${p}bans / ${p}baneados : lista / list\n` +
          `• ${p}warn / ${p}advertir @usuario motivo : advertencia / warning\n` +
          `• ${p}warns / ${p}advertencias [@usuario]\n` +
          `• ${p}unwarn / ${p}quitaradvertencia @usuario [all]\n\n` +
          `⚙️ *Estado / Status:*\n` +
          `• ${p}presence / ${p}presencia [online|offline]\n` +
          `• ${p}online / ${p}enlinea · ${p}offline / ${p}desconectado\n` +
          `• ${p}help / ${p}ayuda / ${p}menu`;

        await sock.sendMessage(jid, { text: helpMessage }, { quoted: msg });
        break;
      }
    }
    } catch (cmdError) {
      audit.status = 'error';
      audit.detail = cmdError.message;
      throw cmdError;
    } finally {
      commandLogService.log({
        source: 'whatsapp',
        actorId: msg.key.participant || jid,
        actorName: msg.pushName || null,
        chatId: jid,
        command: `${prefix}${invoked || command}`,
        args: restText,
        status: audit.status,
        detail: audit.detail,
      });
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
