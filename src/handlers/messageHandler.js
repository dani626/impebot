import { CONFIG } from '../config.js';
import { getMediaFromMessage, createSticker } from '../services/stickerService.js';
import { whatsAppService } from '../services/WhatsAppService.js';
import { extractWaText, parseWaTimestamp, normalizePresence, PRESENCE_TEXTS } from '../utils/whatsappMessage.js';
import { parseCommand, resolveCommandName } from '../utils/commands.js';
import { moderationService, MODERATION_COMMANDS, participantIds, userPart } from '../services/ModerationService.js';
import { luckPermsService } from '../luckperms/LuckPermsService.js';
import { decide, deniedText, shouldShowLinkHint, WHATSAPP_COMMAND_PERMISSIONS, whatsappSenderIds } from '../luckperms/permissions.js';
import { handleAccountCommand } from '../luckperms/accountCommands.js';
import { gameLinkService, isGameCode } from '../luckperms/gameLink.js';
import { commandLogService } from '../services/CommandLogService.js';
import { linkHintService } from '../services/LinkHintService.js';

/** Comandos para los que se avisa de que falta vincular la cuenta (alias resueltos al nombre canónico). */
const LINK_HINT_COMMANDS = new Set(CONFIG.linkHint.commands.map((c) => resolveCommandName(c) || c));

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

    // Un código de /whatsapp link publicado en un grupo deja de valer (!vincular lo trata más abajo).
    if (jid.endsWith('@g.us') && luckPermsService.enabled && !(parsed.isCommand && parsed.command === 'vincular')) {
      await gameLinkService.burnLeaked({ sock, msg, jid, text })
        .catch((err) => console.error('⚠️ [Vincular] No se pudo anular un código publicado:', err.message));
    }
    if (!parsed.isCommand) {
      // Comando que no existe: el bot no contesta, solo queda en la consola.
      const unknown = text.trim().match(/^([!/.])([A-Za-zÁÉÍÓÚáéíóúÑñ]{2,24})(?:s|$)/);
      if (unknown && CONFIG.prefixes.includes(unknown[1])) {
        commandLogService.log({
          source: 'whatsapp',
          actorId: msg.key.participant || jid,
          actorName: msg.pushName || null,
          chatId: jid,
          command: `${unknown[1]}${unknown[2].toLowerCase()}`,
          args: text.trim().slice(unknown[0].length),
          status: 'desconocido',
          detail: 'el comando no existe',
        });
      }
      return;
    }

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
    // Permisos tipo plugin: LuckPerms decide; WA_STAFF_IDS siempre puede (acceso de emergencia).
    // La moderación hace su propia comprobación (también acepta administradores del grupo).
    let senderIds = whatsappSenderIds(msg);
    const perm = WHATSAPP_COMMAND_PERMISSIONS[command];
    const gameCode = command === 'vincular' && luckPermsService.enabled && isGameCode(args[0]);
    if ((perm || gameCode) && jid.endsWith('@g.us') && luckPermsService.enabled) {
      // En grupos el mensaje puede traer solo el LID: se añade el número desde los participantes.
      const meta = await sock.groupMetadata(jid).catch(() => null);
      const wanted = new Set(senderIds.map(userPart));
      const entry = meta?.participants?.find((p) => participantIds(p).some((id) => wanted.has(userPart(id))));
      if (entry) senderIds = [...new Set([...senderIds, ...participantIds(entry)])];
    }
    const isStaff = senderIds.some((id) => CONFIG.moderation.staff.includes(userPart(id)));
    if (perm && !MODERATION_COMMANDS.has(command)) {
      const lp = await luckPermsService.check('whatsapp', senderIds, perm.node);
      if (!decide(perm, lp, { staff: isStaff })) {
        audit.status = 'denegado';
        audit.detail = `sin ${perm.node}`;
        // Normalmente no se responde (solo queda en la consola); la excepción es la lista blanca de avisos.
        await linkHintService.ensureLoaded();
        if (shouldShowLinkHint(lp, { jid, command, groups: linkHintService.groupIds(), commands: LINK_HINT_COMMANDS })) {
          await sock.sendMessage(jid, { text: deniedText(lp, prefix) }, { quoted: msg });
        }
        return;
      }
    }

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

      case 'vincular': {
        // Código del juego (8 cifras, /whatsapp link). El de la web (32 caracteres) lo atienden los tickets.
        if (!gameCode) break;
        try {
          const result = await gameLinkService.handleCommand({ sock, msg, jid, code: args[0], senderIds, prefix });
          audit.status = result.status;
          audit.detail = result.detail || null;
        } catch (linkErr) {
          audit.status = 'error';
          audit.detail = linkErr.message;
          await sock.sendMessage(jid, { text: '❌ No se pudo vincular ahora. Inténtalo más tarde. / Could not link right now.' }, { quoted: msg }).catch(() => {});
        }
        break;
      }

      case 'mc':
      case 'mcvincular':
      case 'mcdesvincular': {
        try {
          const result = await handleAccountCommand({ sock, msg, command, args, prefix, senderIds, isStaff });
          audit.status = result.status;
          audit.detail = result.detail || null;
        } catch (lpErr) {
          audit.status = 'error';
          audit.detail = lpErr.message;
          await sock.sendMessage(jid, { text: '❌ No se pudo consultar LuckPerms. Inténtalo más tarde. / Could not reach LuckPerms.' }, { quoted: msg }).catch(() => {});
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
          (luckPermsService.enabled ? `🎮 *Minecraft:*\n` +
          `• ${p}vincular / ${p}verificar / ${p}link / ${p}verify CODIGO : vincula tu cuenta, por privado (código de /whatsapp link en el juego o de la web)\n` +
          `• ${p}mc / ${p}minecraft : tu cuenta vinculada / your linked account\n` +
          `• ${p}forzarvinculo / ${p}forcelink Jugador @usuario (admin)\n` +
          `• ${p}quitarvinculo / ${p}unlink Jugador|@usuario (admin)\n\n` : '') +
          `⚙️ *Estado / Status* (staff):\n` +
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
