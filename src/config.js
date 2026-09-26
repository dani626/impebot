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
    // Recuperar mensajes no recibidos mientras el bot estuvo offline
    syncMissedMessages: process.env.RELAY_SYNC_MISSED !== 'false',
    // Máxima antigüedad en horas de los mensajes perdidos a procesar (por defecto 24h)
    maxMissedMessageAgeHours: parseInt(process.env.RELAY_MAX_MISSED_HOURS, 10) || 24,
    // Modo del embed con fecha/hora original: 'missed' (solo mensajes recuperados), 'all' o 'none'
    embedTimestampMode: (process.env.RELAY_EMBED_TIMESTAMP || 'missed').toLowerCase(),
    // Reenviar mensajes propios (celular u otra sesión). Opt-in: RELAY_OWN_MESSAGES=true
    relayOwnMessages: process.env.RELAY_OWN_MESSAGES === 'true',
  },

  // Configuración de Catbox para subida y reproducción de videos
  catbox: {
    enabled: process.env.CATBOX_ENABLED !== 'false',
    userhash: process.env.CATBOX_USERHASH || '',
    alwaysUse: process.env.CATBOX_ALWAYS === 'true',
    // Umbral en bytes para enviar directamente por Discord (por defecto 10 MB)
    maxDirectUploadBytes: (parseInt(process.env.DISCORD_MAX_DIRECT_UPLOAD_MB, 10) || 10) * 1024 * 1024,
    // Tiempo máximo de espera sincrónica en ms antes de enviar el mensaje previo y continuar en background
    uploadTimeoutMs: parseInt(process.env.CATBOX_TIMEOUT_MS, 10) || 3500,
  },
};
