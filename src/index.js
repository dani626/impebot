import { CONFIG } from './config.js';
import { dbService } from './database/DatabaseService.js';
import { whatsAppService } from './services/WhatsAppService.js';
import { discordService } from './services/DiscordService.js';
import { relayEngine } from './relay/RelayEngine.js';
import { handleMessage } from './handlers/messageHandler.js';
import { consoleService } from './services/ConsoleService.js';
import { ticketService } from './tickets/index.js';
import { moderationService } from './services/ModerationService.js';
import { MusicService } from './services/MusicService.js';
import { luckPermsService } from './luckperms/LuckPermsService.js';
import { MinecraftDiscordCommands } from './luckperms/MinecraftDiscordCommands.js';

const musicService = new MusicService({ discord: discordService });
const minecraftCommands = new MinecraftDiscordCommands({ discord: discordService });

async function bootstrap() {
  console.log('==================================================');
  console.log('🤖 INICIANDO SISTEMA IMPEBOT & RELAY (WA <-> DISCORD)');
  console.log('==================================================');

  // 1. Inicializar Conexión a Base de Datos MariaDB
  try {
    await dbService.initialize(3, 2000);
  } catch (dbError) {
    if (CONFIG.tickets.enabled) throw new Error('Tickets requiere MariaDB disponible. No se iniciaron los transportes.', { cause: dbError });
    console.warn(
      '⚠️ [Bootstrap] No se pudo conectar a MariaDB. Asegúrate de que el servicio esté corriendo y las credenciales en .env sean correctas.'
    );
    console.warn('⚠️ [Bootstrap] El relay no podrá persistir logs ni mapeos hasta que la base de datos esté disponible.');
  }

  // Permisos desde LuckPerms (opcional). Si no conecta, se usan las reglas por defecto.
  await luckPermsService.start();
  minecraftCommands.start();

  // Registrar rutas antes de conectar los transportes para no perder mensajes iniciales.
  relayEngine.start();
  ticketService.start();
  musicService.start();
  moderationService.start(whatsAppService);

  // 2. Iniciar Servicio de WhatsApp (Baileys)
  // El manejador de comandos se registra antes de conectar: si el primer intento falla,
  // los reintentos posteriores siguen atendiendo comandos.
  whatsAppService.on('rawMessage', async (msg) => {
    try {
      if (whatsAppService.sock) {
        await handleMessage(whatsAppService.sock, msg);
      }
    } catch (stickerErr) {
      console.error('[Bootstrap] Error en manejador de stickers:', stickerErr);
    }
  });

  try {
    await whatsAppService.start();
  } catch (waError) {
    console.error('❌ [Bootstrap] Error al iniciar WhatsAppService:', waError);
    whatsAppService.scheduleReconnect();
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

  // Iniciar lector de comandos por consola (Pterodactyl / Terminal).
  consoleService.start();
}

// Manejo de apagado graceful (SIGINT / SIGTERM)
async function handleShutdown(signal) {
  console.log(`\n🛑 Recibida señal ${signal}. Cerrando servicios ordenadamente...`);
  try {
    consoleService.stop();
    relayEngine.stop();
    await ticketService.stop();
    musicService.stop();
    moderationService.stop();
    minecraftCommands.stop();
    await luckPermsService.stop();
    whatsAppService.stop();
    discordService.destroy();
    await dbService.shutdown();
  } catch (err) {
    console.error('Error durante el apagado:', err);
  } finally {
    process.exit(0);
  }
}

// Una promesa sin manejar en algún listener no debe tumbar todo el bot (Node la convierte en fallo fatal).
process.on('unhandledRejection', (reason) => {
  console.error('❌ [Proceso] Promesa rechazada sin manejar:', reason);
});

// Una excepción síncrona deja el proceso en estado desconocido: registrar y salir con error
// para que el gestor (Pterodactyl, Docker, PM2) lo reinicie.
process.on('uncaughtException', (err) => {
  console.error('❌ [Proceso] Excepción no capturada, reiniciando:', err);
  process.exit(1);
});

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

bootstrap().catch((err) => {
  console.error('❌ [Bootstrap] Error crítico no controlado:', err);
  process.exitCode = 1;
});
