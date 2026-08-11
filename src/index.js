import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';
import { handleMessage } from './handlers/messageHandler.js';
import { CONFIG } from './config.js';

async function startBot() {
  console.log('==================================================');
  console.log('🚀 Iniciando ' + CONFIG.botName + ' (Pterodactyl Ready)...');
  console.log('==================================================');

  // Cargar estado de autenticación (guardado en auth_info_baileys)
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    generateHighQualityLinkPreview: true,
    browser: ['Ubuntu', 'Chrome', '20.0.04']
  });

  // Guardar credenciales cada vez que cambien
  sock.ev.on('creds.update', saveCreds);

  // Soporte opcional para Código de Vinculación por Número (Pairing Code) en Pterodactyl
  const pairingNumber = process.env.PAIRING_NUMBER || process.env.PHONE_NUMBER;
  if (pairingNumber && !sock.authState.creds.registered) {
    setTimeout(async () => {
      try {
        const cleanedNumber = pairingNumber.replace(/[^0-9]/g, '');
        const code = await sock.requestPairingCode(cleanedNumber);
        console.log('\n==================================================');
        console.log(`🔑 CÓDIGO DE VINCULACIÓN PARA ${cleanedNumber}:`);
        console.log(`👉 ${code}`);
        console.log('==================================================\n');
      } catch (err) {
        console.error('Error al generar código de vinculación:', err);
      }
    }, 3000);
  }

  // Manejador de eventos de conexión
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && (!pairingNumber || sock.authState.creds.registered)) {
      console.log('\n📲 ESCANEA EL CÓDIGO QR EN EL CONSOLA DE PTERODACTYL:\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(
        `⚠️ Conexión cerrada. Causa: ${lastDisconnect?.error?.message || statusCode}. Reintentando reconexión: ${shouldReconnect}`
      );

      if (shouldReconnect) {
        setTimeout(startBot, 3000);
      } else {
        console.log('❌ Sesión cerrada permanentemente. Si deseas vincular de nuevo, elimina la carpeta auth_info_baileys y reinicia el servidor en Pterodactyl.');
      }
    } else if (connection === 'open') {
      console.log('\n==================================================');
      console.log('✅ ¡Bot conectado exitosamente a WhatsApp!');
      console.log('💬 Envia una imagen a tu chat con el texto "!s" para probar.');
      console.log('==================================================\n');
    }
  });

  // Escuchar mensajes entrantes
  sock.ev.on('messages.upsert', async (m) => {
    try {
      if (m.type === 'notify') {
        for (const msg of m.messages) {
          await handleMessage(sock, msg);
        }
      }
    } catch (err) {
      console.error('Error procesando mensaje entrante:', err);
    }
  });
}

startBot().catch((err) => {
  console.error('Error crítico al iniciar el bot:', err);
});
