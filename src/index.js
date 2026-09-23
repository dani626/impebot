import { CONFIG } from './config.js';
import { dbService } from './database/DatabaseService.js';
import { whatsAppService } from './services/WhatsAppService.js';
import { discordService } from './services/DiscordService.js';
import { relayEngine } from './relay/RelayEngine.js';
import { handleMessage } from './handlers/messageHandler.js';
import { consoleService } from './services/ConsoleService.js';

async function bootstrap() {
  console.log('==================================================');
  console.log('🤖 INICIANDO SISTEMA IMPEBOT & RELAY (WA <-> DISCORD)');
  console.log('==================================================');

  // 1. Inicializar Conexión a Base de Datos MariaDB
  try {
    await dbService.initialize(3, 2000);
  } catch (dbError) {
    console.warn(
      '⚠️ [Bootstrap] No se pudo conectar a MariaDB. Asegúrate de que el servicio esté corriendo y las credenciales en .env sean correctas.'
    );
    console.warn('⚠️ [Bootstrap] El relay no podrá persistir logs ni mapeos hasta que la base de datos esté disponible.');
  }

  // 2. Iniciar Servicio de WhatsApp (Baileys)
  try {
    await whatsAppService.start();

    // Conectar el manejador de stickers existente a los mensajes crudos de WhatsApp
    whatsAppService.on('rawMessage', async (msg) => {
      try {
        if (whatsAppService.sock) {
          await handleMessage(whatsAppService.sock, msg);
        }
      } catch (stickerErr) {
        console.error('[Bootstrap] Error en manejador de stickers:', stickerErr);
      }
    });
  } catch (waError) {
    console.error('❌ [Bootstrap] Error al iniciar WhatsAppService:', waError);
  }

  // 3. Iniciar Servicio de Discord
  try {
    if (CONFIG.discord.token) {
      await discordService.login();
    } else {
      console.warn('⚠️ [Bootstrap] DISCORD_BOT_TOKEN no definido. Configúralo en .env para habilitar Discord.');
    }
  } catch (discordError) {
    console.error('❌ [Bootstrap] Error al conectar con Discord:', discordError.message);
  }

  // 4. Iniciar Motor de Retransmisión (RelayEngine)
  relayEngine.start();

  // 5. Iniciar Lector de Comandos por Consola (Pterodactyl / Terminal)
  consoleService.start();
}

// Manejo de apagado graceful (SIGINT / SIGTERM)
async function handleShutdown(signal) {
  console.log(`\n🛑 Recibida señal ${signal}. Cerrando servicios ordenadamente...`);
  try {
    consoleService.stop();
    relayEngine.stop();
    discordService.destroy();
    await dbService.shutdown();
  } catch (err) {
    console.error('Error durante el apagado:', err);
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

bootstrap().catch((err) => {
  console.error('❌ [Bootstrap] Error crítico no controlado:', err);
});
