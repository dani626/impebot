import 'dotenv/config';

export const CONFIG = {
  // Prefijos aceptados para los comandos de WhatsApp
  prefixes: ['!', '/', '.'],

  // Metadatos por defecto para los stickers generados
  sticker: {
    packname: 'ImpeBot',
    author: 'Sticker Bot 🤖',
  },

  // Ajustes de conexión
  botName: 'ImpeBot WhatsApp',

  // Configuración de WhatsApp
  whatsapp: {
    // Estado de presencia por defecto: 'online' (available) u 'offline' (unavailable)
    presence: (process.env.WA_PRESENCE || process.env.WHATSAPP_PRESENCE || 'online').toLowerCase(),
  },

  // Configuración de Base de Datos (MariaDB)
  db: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT, 10) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'relay_bot',
    connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT, 10) || 5,
  },

  // Configuración de Discord
  discord: {
    token: process.env.DISCORD_BOT_TOKEN || '',
    guildId: process.env.DISCORD_GUILD_ID || '',
    webhookCacheTTL: parseInt(process.env.DISCORD_WEBHOOK_CACHE_TTL, 10) || 300000,
  },

  // Configuración del motor Relay
  relay: {
    enabled: process.env.RELAY_ENABLED !== 'false',
    messageRetentionHours: parseInt(process.env.RELAY_MESSAGE_RETENTION_HOURS, 10) || 24,
    cleanupIntervalMs: parseInt(process.env.RELAY_CLEANUP_INTERVAL_MS, 10) || 3600000,
  },
};
