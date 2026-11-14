import 'dotenv/config';

/** Número de segundos de una variable; admite 0. Vacía o no válida = `fallback`. */
function seconds(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isNaN(n) || n < 0 ? fallback : n;
}

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
    // Otros servidores (p. ej. el público) donde también funcionan la música y /minecraft.
    // Tickets y /espejo siguen solo en DISCORD_GUILD_ID, donde están sus canales.
    extraGuildIds: (process.env.DISCORD_EXTRA_GUILD_IDS || '').split(',').map((id) => id.trim()).filter(Boolean),
    webhookCacheTTL: parseInt(process.env.DISCORD_WEBHOOK_CACHE_TTL, 10) || 300000,
  },

  waCommandGroups: new Set((process.env.WA_COMMAND_GROUPS || '').split(',').map((id) => id.trim()).filter(Boolean)),

  // Aviso "vincula tu cuenta" de WhatsApp: el bot solo lo muestra en estos grupos y para estos comandos.
  // Por privado y en cualquier otro grupo no responde nada (queda en la consola).
  linkHint: {
    groups: (process.env.WA_LINK_HINT_GROUPS || '').split(',').map((id) => id.trim()).filter(Boolean),
    commands: (process.env.WA_LINK_HINT_COMMANDS || 's,scrop,scircle,sround').split(',')
      .map((c) => c.trim().toLowerCase().replace(/^[!/.]/, '')).filter(Boolean),
  },

  // Moderación de grupos de WhatsApp (!borrar, !ban, !desban, !bans)
  moderation: {
    // IDs/números con permiso en todos los grupos (separados por coma). Acepta número o LID, con o sin +.
    staff: (process.env.WA_STAFF_IDS || '').split(',')
      .map((id) => id.trim().replace(/^\+/, '').split('@')[0].split(':')[0]).filter(Boolean),
    // Los administradores del grupo también pueden moderar
    allowGroupAdmins: process.env.WA_MOD_GROUP_ADMINS !== 'false',
    // Expulsar de nuevo a un baneado si vuelve a entrar al grupo
    enforceBans: process.env.WA_ENFORCE_BANS !== 'false',
    // Advertencias acumuladas que activan la sanción automática (0 = desactivada)
    warnLimit: Math.max(0, Number.isNaN(parseInt(process.env.WA_WARN_LIMIT, 10)) ? 3 : parseInt(process.env.WA_WARN_LIMIT, 10)),
    // Sanción al llegar al límite: 'kick' (expulsar) o 'ban' (expulsar y bloquear)
    warnAction: process.env.WA_WARN_ACTION === 'ban' ? 'ban' : 'kick',
  },

  // Registro de comandos (consola, WhatsApp y Discord)
  commandLog: {
    toDatabase: process.env.COMMAND_LOG_DB !== 'false',
    retentionDays: parseInt(process.env.COMMAND_LOG_RETENTION_DAYS, 10) || 30,
  },

  music: {
    enabled: process.env.MUSIC_ENABLED !== 'false',
    defaultVolume: Math.min(100, Math.max(0, parseInt(process.env.MUSIC_DEFAULT_VOLUME, 10) || 50)),
    maxDurationSeconds: (parseInt(process.env.MUSIC_MAX_MINUTES, 10) || 60) * 60,
    maxQueueSize: parseInt(process.env.MUSIC_MAX_QUEUE, 10) || 50,
    // Segundos que espera en el canal al acabar la cola (0 = sale en cuanto termina)
    idleLeaveMs: seconds(process.env.MUSIC_IDLE_LEAVE_SECONDS, 0) * 1000,
    // Segundos que espera si el canal de voz se queda sin personas (0 = sale al momento)
    emptyLeaveMs: seconds(process.env.MUSIC_EMPTY_LEAVE_SECONDS, 0) * 1000,
  },

  tickets: {
    enabled: process.env.TICKETS_ENABLED !== 'false',
    categoryId: process.env.TICKETS_CATEGORY_ID || '',
    staffRoleIds: (process.env.TICKETS_STAFF_ROLE_IDS || '').split(',').map((id) => id.trim()).filter(Boolean),
    pollIntervalMs: Math.max(5000, parseInt(process.env.TICKETS_POLL_INTERVAL_MS, 10) || 15000),
    web: {
      url: process.env.IMPECRAFT_WEB_URL || '',
      token: process.env.IMPECRAFT_BOT_TOKEN || '',
      timeoutMs: 10000,
    },
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
    // Notificaciones de entrada y salida de miembros en grupos de WhatsApp hacia Discord (embed)
    groupEvents: process.env.RELAY_GROUP_EVENTS !== 'false',
    // Tamaño máximo de un video que se descarga para subirlo a Catbox (el resto de adjuntos usa el límite de Discord)
    maxMediaBytes: (parseInt(process.env.RELAY_MAX_MEDIA_MB, 10) || 100) * 1024 * 1024,
  },

  // Permisos de comandos desde LuckPerms (base MySQL compartida por la red de Minecraft)
  luckperms: {
    enabled: process.env.LUCKPERMS_ENABLED === 'true',
    db: {
      host: process.env.LUCKPERMS_DB_HOST || 'localhost',
      port: parseInt(process.env.LUCKPERMS_DB_PORT, 10) || 3306,
      user: process.env.LUCKPERMS_DB_USER || '',
      password: process.env.LUCKPERMS_DB_PASSWORD || '',
      database: process.env.LUCKPERMS_DB_NAME || 'luckperms',
    },
    tablePrefix: process.env.LUCKPERMS_TABLE_PREFIX || 'luckperms_',
    // Contextos "server" que cuentan para el bot, además de los permisos globales
    servers: (process.env.LUCKPERMS_SERVERS || 'impebot').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean),
    // Respaldo por si se pierde un aviso del messaging service
    cacheTtlMs: (parseInt(process.env.LUCKPERMS_CACHE_SECONDS, 10) || 60) * 1000,
    // Cada cuánto se leen los avisos de luckperms_messenger (0 = no escuchar)
    pollIntervalMs: Number.isNaN(parseInt(process.env.LUCKPERMS_POLL_MS, 10)) ? 1000 : parseInt(process.env.LUCKPERMS_POLL_MS, 10),
    // Meta de LuckPerms donde se guarda la cuenta de cada plataforma (/lp user X meta set whatsapp 519...)
    // code: códigos temporales de /whatsapp link (plugin ImpeGeo en el proxy)
    metaKeys: { whatsapp: 'whatsapp', discord: 'discord', code: 'impebotcode' },
    // Vincular con el código del juego (!vincular 12345678)
    gameLink: {
      // Grupos donde se acepta (JIDs ...@g.us separados por coma). Vacío = solo por privado.
      groups: (process.env.WA_LINK_GROUPS || '').split(',').map((g) => g.trim()).filter(Boolean),
      // Códigos incorrectos permitidos por persona y hora
      maxFailures: Math.max(1, parseInt(process.env.WA_LINK_MAX_FAILURES, 10) || 5),
      failureWindowMs: 60 * 60 * 1000,
    },
    // Vínculos Discord ↔ Minecraft hechos con DiscordSRV (/discord link), en su backend MySQL
    discordsrv: {
      enabled: process.env.DISCORDSRV_LINKS_ENABLED === 'true',
      db: {
        host: process.env.DISCORDSRV_DB_HOST || process.env.LUCKPERMS_DB_HOST || 'localhost',
        port: parseInt(process.env.DISCORDSRV_DB_PORT || process.env.LUCKPERMS_DB_PORT, 10) || 3306,
        user: process.env.DISCORDSRV_DB_USER || '',
        password: process.env.DISCORDSRV_DB_PASSWORD || '',
        database: process.env.DISCORDSRV_DB_NAME || 'discordsrv',
      },
      tablePrefix: process.env.DISCORDSRV_TABLE_PREFIX || 'discordsrv',
    },
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
