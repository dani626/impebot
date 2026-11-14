// Esquema del relay (vínculos grupo de WhatsApp ↔ canal de Discord) y su migración.
// La migración es idempotente: cada paso comprueba antes si ya está aplicado.

export const CHANNEL_MAPPINGS_DDL = `
  CREATE TABLE IF NOT EXISTS \`channel_mappings\` (
    \`id\` INT AUTO_INCREMENT PRIMARY KEY,
    \`whatsapp_jid\` VARCHAR(128) NOT NULL,
    \`discord_channel_id\` VARCHAR(64) NOT NULL,
    \`discord_guild_id\` VARCHAR(64) NOT NULL DEFAULT '',
    \`alias\` VARCHAR(64) DEFAULT NULL,
    \`direction\` ENUM('both','wa_to_dc','dc_to_wa') NOT NULL DEFAULT 'both',
    \`enabled\` BOOLEAN NOT NULL DEFAULT TRUE,
    \`settings\` JSON DEFAULT NULL,
    \`webhook_url\` TEXT DEFAULT NULL,
    \`webhook_id\` VARCHAR(64) DEFAULT NULL,
    \`created_by\` VARCHAR(64) DEFAULT NULL,
    \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    \`inbound_channel\` VARCHAR(64) GENERATED ALWAYS AS (CASE WHEN \`direction\` <> 'wa_to_dc' THEN \`discord_channel_id\` ELSE NULL END) STORED,
    UNIQUE KEY \`uk_pair\` (\`whatsapp_jid\`, \`discord_channel_id\`),
    UNIQUE KEY \`uk_alias\` (\`alias\`),
    UNIQUE KEY \`uk_inbound\` (\`inbound_channel\`),
    INDEX \`idx_discord_channel_id\` (\`discord_channel_id\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

export const MESSAGE_MAPPINGS_DDL = `
  CREATE TABLE IF NOT EXISTS \`message_mappings\` (
    \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
    \`wa_message_id\` VARCHAR(128) DEFAULT NULL,
    \`discord_message_id\` VARCHAR(64) DEFAULT NULL,
    \`channel_mapping_id\` INT DEFAULT NULL,
    \`origin_platform\` VARCHAR(32) NOT NULL DEFAULT 'whatsapp',
    \`sender_name\` VARCHAR(128) DEFAULT NULL,
    \`content\` TEXT DEFAULT NULL,
    \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY \`uk_mapping_wa\` (\`channel_mapping_id\`, \`wa_message_id\`),
    INDEX \`idx_wa_message_id\` (\`wa_message_id\`, \`channel_mapping_id\`),
    INDEX \`idx_discord_message_id\` (\`discord_message_id\`),
    INDEX \`idx_origin_platform\` (\`origin_platform\`),
    INDEX \`idx_created_at\` (\`created_at\`),
    CONSTRAINT \`fk_channel_mapping_message\` FOREIGN KEY (\`channel_mapping_id\`) REFERENCES \`channel_mappings\` (\`id\`) ON DELETE SET NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
`;

const NEW_COLUMNS = [
  ['discord_guild_id', "VARCHAR(64) NOT NULL DEFAULT '' AFTER `discord_channel_id`"],
  ['alias', 'VARCHAR(64) DEFAULT NULL AFTER `discord_guild_id`'],
  ['direction', "ENUM('both','wa_to_dc','dc_to_wa') NOT NULL DEFAULT 'both' AFTER `alias`"],
  ['enabled', 'BOOLEAN NOT NULL DEFAULT TRUE AFTER `direction`'],
  ['settings', 'JSON DEFAULT NULL AFTER `enabled`'],
  ['created_by', 'VARCHAR(64) DEFAULT NULL AFTER `webhook_id`'],
  ['inbound_channel', "VARCHAR(64) GENERATED ALWAYS AS (CASE WHEN `direction` <> 'wa_to_dc' THEN `discord_channel_id` ELSE NULL END) STORED"],
];

async function columnsOf(conn, database, table) {
  const rows = await conn.query(
    'SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
    [database, table]
  );
  return new Set(rows.map((r) => r.name.toLowerCase()));
}

/** Devuelve Map<nombre de índice, número de columnas>. */
async function indexesOf(conn, database, table) {
  const rows = await conn.query(
    'SELECT INDEX_NAME AS name, COUNT(*) AS cols FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? GROUP BY INDEX_NAME',
    [database, table]
  );
  return new Map(rows.map((r) => [r.name, Number(r.cols)]));
}

const MIRRORS_MIGRATED_KEY = 'relay.legacy_mirrors_migrated';

/**
 * Convierte, una sola vez, los espejos de la tabla antigua relay_mirrors en vínculos wa_to_dc.
 * La marca en bot_settings evita que un espejo quitado después con /espejo reaparezca al reiniciar.
 * Las tablas antiguas no se borran.
 */
async function migrateLegacyMirrors(conn, database, log) {
  const tables = new Set((await conn.query(
    "SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME IN ('relay_mirrors', 'relay_aliases', 'bot_settings')",
    [database]
  )).map((r) => r.name.toLowerCase()));
  if (!tables.has('relay_mirrors') || !tables.has('bot_settings')) return;
  const done = await conn.query('SELECT 1 FROM `bot_settings` WHERE `setting_key` = ? LIMIT 1', [MIRRORS_MIGRATED_KEY]);
  if (done.length > 0) return;

  const result = await conn.query(
    `INSERT INTO \`channel_mappings\` (\`whatsapp_jid\`, \`discord_channel_id\`, \`direction\`, \`webhook_url\`, \`created_by\`)
     SELECT \`whatsapp_jid\`, \`discord_channel_id\`, 'wa_to_dc', \`webhook_url\`, \`created_by\` FROM \`relay_mirrors\` WHERE \`whatsapp_jid\` <> '*'
     ON DUPLICATE KEY UPDATE \`channel_mappings\`.\`id\` = \`channel_mappings\`.\`id\``
  );
  const copied = Number(result?.affectedRows ?? 0);
  if (copied > 0) log.log(`🔄 [DatabaseService] ${copied} espejo(s) de relay_mirrors convertidos en vínculos wa_to_dc.`);

  const wildcard = await conn.query("SELECT COUNT(*) AS n FROM `relay_mirrors` WHERE `whatsapp_jid` = '*'");
  if (Number(wildcard[0].n) > 0) {
    log.warn(`⚠️ [DatabaseService] ${wildcard[0].n} espejo(s) de "todos los chats" no se convirtieron: ya no existen; añade uno por chat con /espejo agregar.`);
  }
  if (tables.has('relay_aliases')) {
    const aliases = await conn.query('SELECT COUNT(*) AS n FROM `relay_aliases`');
    if (Number(aliases[0].n) > 0) {
      log.warn(`⚠️ [DatabaseService] ${aliases[0].n} alias de relay_aliases no se convirtieron: ahora el alias es de un vínculo; vuelve a crearlos con /espejo alias.`);
    }
  }
  await conn.query('INSERT INTO `bot_settings` (`setting_key`, `setting_value`) VALUES (?, ?)', [MIRRORS_MIGRATED_KEY, '1']);
}

/**
 * Lleva channel_mappings y message_mappings al esquema de varios canales por grupo.
 * Los vínculos existentes quedan como direction = 'both', enabled = 1 y sin alias.
 * @param {{ query: Function }} conn conexión ya abierta sobre la base de datos del bot
 * @param {{ database: string, hubGuildId?: string, log?: Console }} options
 */
export async function migrateRelaySchema(conn, { database, hubGuildId = '', log = console }) {
  // ── channel_mappings ──
  let indexes = await indexesOf(conn, database, 'channel_mappings');
  if (indexes.has('uk_whatsapp_jid')) {
    await conn.query('CREATE TABLE IF NOT EXISTS `channel_mappings_backup_v1` AS SELECT * FROM `channel_mappings`');
    log.log('🔄 [DatabaseService] Migrando channel_mappings (copia previa en channel_mappings_backup_v1)...');
  }

  const columns = await columnsOf(conn, database, 'channel_mappings');
  for (const [name, definition] of NEW_COLUMNS) {
    if (!columns.has(name)) await conn.query(`ALTER TABLE \`channel_mappings\` ADD COLUMN \`${name}\` ${definition}`);
  }

  // Los vínculos anteriores a esta migración están todos en el servidor hub. Solo se rellena
  // al crear la columna: después puede haber espejos de otros servidores sin servidor anotado.
  if (hubGuildId && !columns.has('discord_guild_id')) {
    await conn.query("UPDATE `channel_mappings` SET `discord_guild_id` = ? WHERE `discord_guild_id` = ''", [hubGuildId]);
  }

  if (!indexes.has('uk_pair')) {
    await conn.query('ALTER TABLE `channel_mappings` ADD UNIQUE KEY `uk_pair` (`whatsapp_jid`, `discord_channel_id`)');
  }
  if (indexes.has('uk_whatsapp_jid')) {
    await conn.query('ALTER TABLE `channel_mappings` DROP INDEX `uk_whatsapp_jid`');
  }
  if (!indexes.has('uk_alias')) {
    await conn.query('ALTER TABLE `channel_mappings` ADD UNIQUE KEY `uk_alias` (`alias`)');
  }
  if (!indexes.has('uk_inbound')) {
    const shared = await conn.query(
      'SELECT `inbound_channel` AS channel FROM `channel_mappings` WHERE `inbound_channel` IS NOT NULL GROUP BY `inbound_channel` HAVING COUNT(*) > 1'
    );
    if (shared.length === 0) {
      await conn.query('ALTER TABLE `channel_mappings` ADD UNIQUE KEY `uk_inbound` (`inbound_channel`)');
    } else {
      log.warn(`⚠️ [DatabaseService] No se aplicó uk_inbound: hay canales de Discord con varios grupos hacia WhatsApp (${shared.map((r) => r.channel).join(', ')}). Deja uno solo por canal y reinicia.`);
    }
  }

  await migrateLegacyMirrors(conn, database, log);

  // ── message_mappings: una fila por mensaje y por vínculo ──
  indexes = await indexesOf(conn, database, 'message_mappings');
  if (!indexes.has('uk_mapping_wa') && !indexes.has('idx_mapping_wa')) {
    const repeated = await conn.query(
      'SELECT 1 FROM `message_mappings` WHERE `channel_mapping_id` IS NOT NULL AND `wa_message_id` IS NOT NULL GROUP BY `channel_mapping_id`, `wa_message_id` HAVING COUNT(*) > 1 LIMIT 1'
    );
    if (repeated.length === 0) {
      await conn.query('ALTER TABLE `message_mappings` ADD UNIQUE KEY `uk_mapping_wa` (`channel_mapping_id`, `wa_message_id`)');
    } else {
      await conn.query('ALTER TABLE `message_mappings` ADD INDEX `idx_mapping_wa` (`channel_mapping_id`, `wa_message_id`)');
      log.warn('⚠️ [DatabaseService] message_mappings ya tiene reenvíos repetidos: se creó idx_mapping_wa sin unicidad.');
    }
  }
  if (indexes.get('idx_wa_message_id') === 1) {
    await conn.query(
      'ALTER TABLE `message_mappings` DROP INDEX `idx_wa_message_id`, ADD INDEX `idx_wa_message_id` (`wa_message_id`, `channel_mapping_id`)'
    );
  } else if (!indexes.has('idx_wa_message_id')) {
    await conn.query('ALTER TABLE `message_mappings` ADD INDEX `idx_wa_message_id` (`wa_message_id`, `channel_mapping_id`)');
  }
}
