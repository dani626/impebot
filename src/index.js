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
  console.log('🚀 Iniciando ' + CONFIG.botName + '...');

  // Cargar estado de autenticación (guardado en la carpeta auth_info_baileys)
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    generateHighQualityLinkPreview: true,
  });

  // Guardar credenciales cada vez que se actualizan
  sock.ev.on('creds.update', saveCreds);

  // Manejador de eventos de conexión
  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n📲 ESCANEA EL SIGUIENTE CÓDIGO QR CON TU WHATSAPP:\n');
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
        console.log('❌ Sesión cerrada permanentemente. Por favor elimina la carpeta auth_info_baileys y vuelve a iniciar.');
      }
    } else if (connection === 'open') {
      console.log('✅ ¡Bot conectado exitosamente a WhatsApp!');
      console.log('💬 Envia una imagen a tu chat con el texto "!s" para probar.');
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
