import { EventEmitter } from 'events';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { CONFIG } from '../config.js';

export class WhatsAppService extends EventEmitter {
  constructor() {
    super();
    this.sock = null;
    this.isReady = false;
    this.authFolder = 'auth_info_baileys';
  }

  /**
   * Inicia el socket de Baileys y configura los listeners de eventos.
   */
  async start() {
    console.log('==================================================');
    console.log(`🚀 Iniciando ${CONFIG.botName}...`);
    console.log('==================================================');

    const { state, saveCreds } = await useMultiFileAuthState(this.authFolder);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: state,
      generateHighQualityLinkPreview: true,
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
    });

    // Guardar credenciales al cambiar
    this.sock.ev.on('creds.update', saveCreds);

    // Pairing code opcional si no está registrado
    const pairingNumber = process.env.PAIRING_NUMBER || process.env.PHONE_NUMBER;
    if (pairingNumber && !this.sock.authState.creds.registered) {
      setTimeout(async () => {
        try {
          const cleanedNumber = pairingNumber.replace(/[^0-9]/g, '');
          const code = await this.sock.requestPairingCode(cleanedNumber);
          console.log('\n==================================================');
          console.log(`🔑 CÓDIGO DE VINCULACIÓN PARA ${cleanedNumber}:`);
          console.log(`👉 ${code}`);
          console.log('==================================================\n');
        } catch (err) {
          console.error('[WhatsAppService] Error al generar código de vinculación:', err);
        }
      }, 3000);
    }

    // Manejo de conexión
    this.sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && (!pairingNumber || this.sock.authState.creds.registered)) {
        console.log('\n📲 ESCANEA EL CÓDIGO QR EN LA CONSOLA:\n');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'close') {
        this.isReady = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(
          `⚠️ [WhatsAppService] Conexión cerrada. Causa: ${lastDisconnect?.error?.message || statusCode}. Reintentando reconexión: ${shouldReconnect}`
        );

        this.emit('connection.close', { statusCode, shouldReconnect });

        if (shouldReconnect) {
          setTimeout(() => this.start(), 3000);
        } else {
          console.log('❌ [WhatsAppService] Sesión cerrada permanentemente. Elimina auth_info_baileys para volver a escanear.');
        }
      } else if (connection === 'open') {
        this.isReady = true;
        console.log('\n==================================================');
        console.log('✅ ¡Bot conectado exitosamente a WhatsApp!');
        console.log('==================================================\n');
        this.emit('ready', this.sock);
      }

      this.emit('connection.update', update);
    });

    // Eventos de mensajes entrantes
    this.sock.ev.on('messages.upsert', async (m) => {
      try {
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
          if (!msg.message) continue;
          this.emit('rawMessage', msg);

          // Extraer información normalizada del mensaje
          const jid = msg.key.remoteJid;
          const sender = msg.key.participant || msg.participant || jid;
          const pushName = msg.pushName || sender.split('@')[0];
          const isFromMe = Boolean(msg.key.fromMe);

          const text = (
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            msg.message.videoMessage?.caption ||
            msg.message.documentMessage?.caption ||
            ''
          ).trim();

          // Determinar tipo de contenido / multimedia
          const msgType = Object.keys(msg.message)[0] || 'desconocido';
          const chatType = jid?.endsWith('@g.us') ? 'GRUPO' : (jid?.endsWith('@lid') ? 'DIRECTO/LID' : 'DIRECTO');
          const previewText = text ? `"${text.length > 80 ? text.substring(0, 77) + '...' : text}"` : `[${msgType}]`;
          const originTag = isFromMe ? '🤖 [BOT/PROPIO]' : '👤 [USUARIO]';

          console.log(`📩 [WhatsApp ${chatType}] ${originTag} De: ${pushName} (${sender}) | Chat: ${jid} | Tipo: ${msgType} | Contenido: ${previewText}`);

          this.emit('message', {
            rawMessage: msg,
            jid,
            sender,
            pushName,
            text,
            isFromMe,
            messageId: msg.key.id,
            timestamp: msg.messageTimestamp,
          });
        }
      } catch (err) {
        console.error('[WhatsAppService] Error procesando messages.upsert:', err);
      }
    });

    return this.sock;
  }

  /**
   * Envía un mensaje a través del socket de Baileys.
   * @param {string} jid 
   * @param {object} content 
   * @param {object} options 
   */
  async sendMessage(jid, content, options = {}) {
    if (!this.sock || !this.isReady) {
      throw new Error('[WhatsAppService] El socket no está conectado a WhatsApp.');
    }
    return await this.sock.sendMessage(jid, content, options);
  }

  /**
   * Descarga el medio multimedia de un mensaje de WhatsApp.
   * @param {object} message 
   * @returns {Promise<Buffer>}
   */
  async downloadMedia(message) {
    return await downloadMediaMessage(message, 'buffer', {});
  }

  /**
   * Intenta obtener la URL del avatar de un usuario o grupo.
   * @param {string} jid 
   * @returns {Promise<string|null>}
   */
  async getProfilePictureUrl(jid) {
    if (!this.sock || !this.isReady) return null;
    try {
      return await this.sock.profilePictureUrl(jid, 'image');
    } catch {
      return null;
    }
  }
}

export const whatsAppService = new WhatsAppService();
export default whatsAppService;
