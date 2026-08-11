import { CONFIG } from '../config.js';
import { getMediaFromMessage, createSticker } from '../services/stickerService.js';

/**
 * Manejador principal de mensajes entrantes.
 * @param {import('@whiskeysockets/baileys').WASocket} sock 
 * @param {import('@whiskeysockets/baileys').WAMessage} msg 
 */
export async function handleMessage(sock, msg) {
  try {
    if (!msg.message || msg.key.fromMe) return;

    const jid = msg.key.remoteJid;
    
    // Obtener texto del mensaje (caption o texto de chat)
    const text = (
      msg.message.conversation ||
      msg.message.imageMessage?.caption ||
      msg.message.extendedTextMessage?.text ||
      msg.message.videoMessage?.caption ||
      ''
    ).trim();

    if (!text) return;

    // Verificar si el mensaje comienza con algún prefijo configurado
    const prefix = CONFIG.prefixes.find(p => text.startsWith(p));
    if (!prefix) return;

    const args = text.slice(prefix.length).trim().split(/ +/);
    const command = args.shift()?.toLowerCase();
    const restText = args.join(' ');

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
            text: '⚠️ *Para crear un sticker:*\n\n1. Envía una imagen con el texto `!s` en el comentario (caption).\n2. O responde a una imagen existente con el comando `!s`.\n\n💡 *Tip:* Usa `!scrop` para recortar en cuadrado o `!scircle` para sticker circular.'
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

      case 'help':
      case 'menu':
      case 'bot': {
        const helpMessage = `🤖 *${CONFIG.botName}* 🤖\n\n` +
          `✨ *Comandos de Stickers:*\n` +
          `• \`!s\` : Convierte la imagen a sticker (tamaño completo).\n` +
          `• \`!scrop\` : Sticker recortado en cuadrado.\n` +
          `• \`!scircle\` : Sticker recortado en círculo.\n` +
          `• \`!s Mi Pack | Mi Nombre\` : Personaliza los metadatos del sticker.\n\n` +
          `📌 *¿Cómo usarlo?*\n` +
          `Envía una imagen con el comando en la leyenda, o responde a cualquier foto enviada con el comando \`!s\`.`;

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
    } catch (e) {
      // Ignorar fallo de envío secundario
    }
  }
}
