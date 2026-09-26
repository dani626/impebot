import { EventEmitter } from 'events';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { CONFIG } from '../config.js';
import { settingsRepository } from '../database/repositories/SettingsRepository.js';
import {
  extractWaText,
  parseWaTimestamp,
  normalizePresence,
  extractRevokedMessageKey,
} from '../utils/whatsappMessage.js';

export class WhatsAppService extends EventEmitter {
  constructor() {
    super();
    this.sock = null;
    this.isReady = false;
    this.authFolder = 'auth_info_baileys';
    this.currentPresence = normalizePresence(CONFIG.whatsapp?.presence) || 'available';
  }

  /**
   * Carga el estado de presencia guardado (desde MariaDB o respaldo local).
   */
  async loadStoredPresence() {
    try {
      const saved = await settingsRepository.get('whatsapp_presence', null);
      if (saved) {
        const isOffline = saved === 'offline' || saved === 'unavailable';
        this.currentPresence = isOffline ? 'unavailable' : 'available';
        return;
      }
    } catch (err) {
      console.warn('[WhatsAppService] No se pudo leer la presencia guardada:', err.message);
    }

    const envPresence = CONFIG.whatsapp?.presence;
    const isOffline = envPresence === 'offline' || envPresence === 'unavailable';
    this.currentPresence = isOffline ? 'unavailable' : 'available';
  }

  /**
   * Inicia el socket de Baileys y configura los listeners de eventos.
   */
  async start() {
    console.log('==================================================');
    console.log(`🚀 Iniciando ${CONFIG.botName}...`);
    console.log('==================================================');

    // Cargar estado de presencia guardado previamente
    await this.loadStoredPresence();

    const { state, saveCreds } = await useMultiFileAuthState(this.authFolder);
    const { version } = await fetchLatestBaileysVersion();

    this.sock = makeWASocket({
      version,
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      auth: state,
      generateHighQualityLinkPreview: true,
      browser: ['Ubuntu', 'Chrome', '20.0.04'],
      markOnlineOnConnect: this.currentPresence === 'available',
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
    this.sock.ev.on('connection.update', async (update) => {
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

        // Aplicar estado de presencia configurado / persistido (sin sobreescribir DB)
        await this.setPresence(this.currentPresence, false);

        this.emit('ready', this.sock);
      }

      this.emit('connection.update', update);
    });

    // Eventos de mensajes entrantes (en vivo y de sincronización)
    this.sock.ev.on('messages.upsert', async (m) => {
      try {
        const allowSync = CONFIG.relay?.syncMissedMessages;
        if (m.type !== 'notify' && (!allowSync || m.type !== 'append')) return;

        const isAppend = m.type === 'append';
        for (const msg of m.messages) {
          await this.processIncomingMessage(msg, isAppend);
        }
      } catch (err) {
        console.error('[WhatsAppService] Error procesando messages.upsert:', err);
      }
    });

    // Evento de sincronización masiva de historial (offline catch-up)
    this.sock.ev.on('messaging-history.set', async ({ messages }) => {
      try {
        if (!CONFIG.relay?.syncMissedMessages) return;
        if (!Array.isArray(messages) || messages.length === 0) return;

        console.log(`📥 [WhatsAppService] Recibidos ${messages.length} mensajes en sincronización de historial.`);
        for (const msg of messages) {
          await this.processIncomingMessage(msg, true);
        }
      } catch (err) {
        console.error('[WhatsAppService] Error en messaging-history.set:', err);
      }
    });

    // Evento nativo de eliminación de mensajes en Baileys (messages.delete)
    this.sock.ev.on('messages.delete', async (item) => {
      try {
        if (Array.isArray(item?.keys)) {
          for (const key of item.keys) {
            if (key?.id) {
              this.emit('message.delete', {
                waMessageId: key.id,
                remoteJid: key.remoteJid,
                fromMe: key.fromMe,
                participant: key.participant,
              });
            }
          }
        }
      } catch (err) {
        console.error('[WhatsAppService] Error procesando messages.delete:', err);
      }
    });

    // Evento de actualización de mensajes (messages.update)
    this.sock.ev.on('messages.update', async (updates) => {
      try {
        if (!Array.isArray(updates)) return;
        for (const update of updates) {
          if (update.update?.message) {
            const { isRevoke, revokedKey } = extractRevokedMessageKey(update.update);
            if (isRevoke && revokedKey?.id) {
              this.emit('message.delete', {
                waMessageId: revokedKey.id,
                remoteJid: revokedKey.remoteJid,
                fromMe: revokedKey.fromMe,
                participant: revokedKey.participant,
              });
            }
          }
        }
      } catch (err) {
        console.error('[WhatsAppService] Error procesando messages.update:', err);
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

  /**
   * Obtiene el nombre del chat (asunto del grupo o pushName).
   * @param {string} jid 
   * @returns {Promise<string|null>}
   */
  async getChatName(jid) {
    if (!this.sock || !this.isReady) return null;
    try {
      if (jid.endsWith('@g.us')) {
        const metadata = await this.sock.groupMetadata(jid);
        return metadata?.subject || null;
      }
    } catch {
      // Ignorar error al consultar metadata
    }
    return null;
  }

  /**
   * Actualiza el estado de presencia en WhatsApp ('available' / online o 'unavailable' / offline).
   * @param {'online'|'offline'|'available'|'unavailable'} presence
   * @param {boolean} [persist=true] Indica si se debe guardar en base de datos y respaldo local
   * @returns {Promise<string>} Retorna el nuevo estado ('available' o 'unavailable')
   */
  async setPresence(presence, persist = true) {
    this.currentPresence = normalizePresence(presence) || 'available';

    if (persist) {
      try {
        await settingsRepository.set('whatsapp_presence', this.currentPresence);
      } catch (err) {
        console.error('[WhatsAppService] Error al guardar presencia en almacenamiento:', err.message);
      }
    }

    if (this.sock && this.isReady) {
      try {
        await this.sock.sendPresenceUpdate(this.currentPresence);
        console.log(
          `📱 [WhatsAppService] Presencia establecida en WhatsApp: ${
            this.currentPresence === 'available' ? '🟢 ONLINE (available)' : '⚪ OFFLINE (unavailable)'
          }`
        );
      } catch (err) {
        console.error('[WhatsAppService] Error al actualizar presencia en WhatsApp:', err.message);
      }
    }

    return this.currentPresence;
  }

  /**
   * Normaliza y procesa un mensaje entrante (en tiempo real o recuperado de sincronización).
   * @param {import('@whiskeysockets/baileys').WAMessage} msg 
   * @param {boolean} [isHistoricalSync=false] 
   */
  async processIncomingMessage(msg, isHistoricalSync = false) {
    if (!msg || !msg.message) return;

    // Verificar si es un mensaje de revocación ("eliminar para todos")
    const { isRevoke, revokedKey } = extractRevokedMessageKey(msg);
    if (isRevoke && revokedKey?.id) {
      console.log(`🗑️ [WhatsApp] Mensaje revocado detectado: ID ${revokedKey.id} en ${revokedKey.remoteJid}`);
      this.emit('message.delete', {
        waMessageId: revokedKey.id,
        remoteJid: revokedKey.remoteJid,
        fromMe: revokedKey.fromMe,
        participant: revokedKey.participant,
        rawMessage: msg,
      });
      return;
    }

    // Calcular antigüedad del mensaje
    const timestampSec = parseWaTimestamp(msg);
    const nowSec = Math.floor(Date.now() / 1000);
    const ageSeconds = nowSec - timestampSec;
    const maxAgeSeconds = (CONFIG.relay?.maxMissedMessageAgeHours || 24) * 3600;

    // Si es un mensaje antiguo pero supera el límite de horas configurado, se omite
    if (ageSeconds > maxAgeSeconds) {
      return;
    }

    // Se considera atrasado/offline si viene por sincronización o si tiene más de 60 segundos
    const isDelayed = isHistoricalSync || ageSeconds > 60;

    this.emit('rawMessage', msg);

    // Extraer información normalizada del mensaje
    const jid = msg.key.remoteJid;
    const sender = msg.key.participant || msg.participant || jid;
    const pushName = msg.pushName || sender.split('@')[0];
    const isFromMe = Boolean(msg.key.fromMe);
    const text = extractWaText(msg);

    // Determinar tipo de contenido / multimedia
    const msgType = Object.keys(msg.message)[0] || 'desconocido';
    const chatType = jid?.endsWith('@g.us') ? 'GRUPO' : (jid?.endsWith('@lid') ? 'DIRECTO/LID' : 'DIRECTO');
    const previewText = text ? `"${text.length > 80 ? text.substring(0, 77) + '...' : text}"` : `[${msgType}]`;
    const originTag = isFromMe ? '🤖 [BOT/PROPIO]' : '👤 [USUARIO]';
    const delayTag = isDelayed ? ' ⏳ [SINCRONIZADO/OFFLINE]' : '';

    console.log(
      `📩 [WhatsApp ${chatType}]${delayTag} ${originTag} De: ${pushName} (${sender}) | Chat: ${jid} | Tipo: ${msgType} | Contenido: ${previewText}`
    );

    this.emit('message', {
      rawMessage: msg,
      jid,
      sender,
      pushName,
      text,
      isFromMe,
      messageId: msg.key.id,
      timestamp: timestampSec,
      isDelayed,
    });
  }

  /**
   * Retorna el estado actual de presencia en formato amigable.
   * @returns {{ status: 'available'|'unavailable', label: 'online'|'offline' }}
   */
  getPresence() {
    return {
      status: this.currentPresence,
      label: this.currentPresence === 'available' ? 'online' : 'offline',
    };
  }
}

export const whatsAppService = new WhatsAppService();
