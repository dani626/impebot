// Prefijo propio: nunca modifica las tablas del relay ni las de impecraft-web.
export const TICKET_DDL = [
  `CREATE TABLE IF NOT EXISTS support_tickets (
    number INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    id CHAR(36) NOT NULL UNIQUE,
    subject VARCHAR(150) NOT NULL,
    category ENUM('soporte','compra','reporte','apelacion','bug','otro') NOT NULL,
    status ENUM('OPEN','PENDING','CLOSED') NOT NULL DEFAULT 'OPEN',
    priority ENUM('LOW','NORMAL','HIGH','URGENT') NOT NULL DEFAULT 'NORMAL',
    origin ENUM('whatsapp','discord','web') NOT NULL DEFAULT 'whatsapp',
    owner_jid VARCHAR(128) NULL,
    owner_discord_id VARCHAR(64) NULL,
    guild_id VARCHAR(64) NULL,
    custom_category_slug VARCHAR(40) NULL,
    user_name VARCHAR(128) NOT NULL,
    assignee_id VARCHAR(64) NULL,
    assignee_name VARCHAR(128) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    closed_at DATETIME(3) NULL,
    INDEX idx_support_owner_jid (owner_jid, status),
    INDEX idx_support_owner_discord (owner_discord_id, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS support_messages (
    sequence BIGINT NOT NULL AUTO_INCREMENT UNIQUE,
    id CHAR(36) PRIMARY KEY,
    ticket_id CHAR(36) NOT NULL,
    event_id VARCHAR(191) NOT NULL UNIQUE,
    body TEXT NOT NULL,
    internal BOOLEAN NOT NULL DEFAULT FALSE,
    author_id VARCHAR(128) NOT NULL,
    author_name VARCHAR(128) NOT NULL,
    author_role VARCHAR(16) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    INDEX idx_support_conversation (ticket_id, sequence),
    FOREIGN KEY (ticket_id) REFERENCES support_tickets(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS support_routes (
    ticket_key VARCHAR(96) PRIMARY KEY,
    ticket_number INT NOT NULL,
    discord_channel_id VARCHAR(64) NULL UNIQUE,
    guild_id VARCHAR(64) NULL,
    origin ENUM('whatsapp','discord','web') NOT NULL DEFAULT 'whatsapp',
    owner_discord_id VARCHAR(64) NULL,
    category_id INT NULL,
    control_message_id VARCHAR(64) NULL,
    channel_deleted BOOLEAN NOT NULL DEFAULT FALSE,
    last_renamed_at DATETIME(3) NULL,
    whatsapp_jid VARCHAR(128) NULL,
    last_status VARCHAR(16) NULL,
    last_meta VARCHAR(255) NULL,
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS support_deliveries (
    ticket_key VARCHAR(96) NOT NULL,
    message_id VARCHAR(128) NOT NULL,
    destination VARCHAR(16) NOT NULL,
    delivered_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (ticket_key, message_id, destination)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS support_guild_configs (
    guild_id VARCHAR(64) PRIMARY KEY,
    default_category_channel_id VARCHAR(64) NULL,
    log_channel_id VARCHAR(64) NULL,
    transcript_format ENUM('html','txt') NOT NULL DEFAULT 'html',
    max_open_per_user TINYINT UNSIGNED NOT NULL DEFAULT 3,
    staff_role_ids TEXT NULL,
    delete_delay_seconds TINYINT UNSIGNED NOT NULL DEFAULT 5,
    rename_on_priority BOOLEAN NOT NULL DEFAULT TRUE,
    require_linked_web BOOLEAN NOT NULL DEFAULT TRUE,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS support_categories (
    id INT AUTO_INCREMENT PRIMARY KEY,
    guild_id VARCHAR(64) NOT NULL,
    slug VARCHAR(40) NOT NULL,
    label VARCHAR(80) NOT NULL,
    description VARCHAR(100) NULL,
    emoji VARCHAR(64) NULL,
    button_style ENUM('Primary','Secondary','Success','Danger') NOT NULL DEFAULT 'Primary',
    base_category ENUM('soporte','compra','reporte','apelacion','bug','otro') NOT NULL DEFAULT 'soporte',
    discord_category_id VARCHAR(64) NULL,
    staff_role_ids TEXT NULL,
    default_priority ENUM('LOW','NORMAL','HIGH','URGENT') NOT NULL DEFAULT 'NORMAL',
    ping_roles BOOLEAN NOT NULL DEFAULT TRUE,
    welcome_message TEXT NULL,
    sort_order INT NOT NULL DEFAULT 0,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE KEY uk_support_cat_guild_slug (guild_id, slug),
    INDEX idx_support_cat_guild (guild_id, enabled, sort_order)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS support_panels (
    id INT AUTO_INCREMENT PRIMARY KEY,
    guild_id VARCHAR(64) NOT NULL,
    channel_id VARCHAR(64) NOT NULL,
    message_id VARCHAR(64) NOT NULL UNIQUE,
    title VARCHAR(256) NOT NULL,
    description TEXT NOT NULL,
    color VARCHAR(16) NULL,
    mode ENUM('buttons','select') NOT NULL DEFAULT 'buttons',
    category_ids TEXT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
  `CREATE TABLE IF NOT EXISTS support_participants (
    ticket_key VARCHAR(96) NOT NULL,
    target_id VARCHAR(64) NOT NULL,
    target_type ENUM('user','role') NOT NULL,
    added_by VARCHAR(64) NOT NULL,
    added_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (ticket_key, target_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin`,
];

const NEW_COLUMNS = {
  support_tickets: [
    ['origin', "ENUM('whatsapp','discord','web') NOT NULL DEFAULT 'whatsapp' AFTER `priority`"],
    ['owner_discord_id', 'VARCHAR(64) NULL AFTER `owner_jid`'],
    ['guild_id', 'VARCHAR(64) NULL AFTER `owner_discord_id`'],
    ['custom_category_slug', 'VARCHAR(40) NULL AFTER `guild_id`'],
  ],
  support_routes: [
    ['guild_id', 'VARCHAR(64) NULL AFTER `discord_channel_id`'],
    ['origin', "ENUM('whatsapp','discord','web') NOT NULL DEFAULT 'whatsapp' AFTER `guild_id`"],
    ['owner_discord_id', 'VARCHAR(64) NULL AFTER `origin`'],
    ['category_id', 'INT NULL AFTER `owner_discord_id`'],
    ['control_message_id', 'VARCHAR(64) NULL AFTER `category_id`'],
    ['channel_deleted', 'BOOLEAN NOT NULL DEFAULT FALSE AFTER `control_message_id`'],
    ['last_renamed_at', 'DATETIME(3) NULL AFTER `channel_deleted`'],
  ],
};

/**
 * Lleva las tablas de tickets de una instalación anterior al esquema con tickets de Discord.
 * Idempotente: cada paso comprueba information_schema antes de alterar.
 * El límite de tickets abiertos pasa de la columna generada active_owner a TicketRepository.create().
 */
export async function migrateTicketSchema(conn, { database }) {
  const columns = async (table) => new Map((await conn.query(
    'SELECT COLUMN_NAME AS name, IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
    [database, table],
  )).map((r) => [r.name.toLowerCase(), r.nullable]));
  const indexes = async (table) => new Set((await conn.query(
    'SELECT DISTINCT INDEX_NAME AS name FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
    [database, table],
  )).map((r) => r.name));

  let ticketIndexes = await indexes('support_tickets');
  if (ticketIndexes.has('uk_support_active_owner')) await conn.query('ALTER TABLE support_tickets DROP INDEX uk_support_active_owner');
  let ticketColumns = await columns('support_tickets');
  if (ticketColumns.has('active_owner')) await conn.query('ALTER TABLE support_tickets DROP COLUMN active_owner');
  if (ticketColumns.get('owner_jid') === 'NO') await conn.query('ALTER TABLE support_tickets MODIFY owner_jid VARCHAR(128) NULL');

  for (const [table, list] of Object.entries(NEW_COLUMNS)) {
    const existing = await columns(table);
    for (const [name, definition] of list) {
      if (!existing.has(name)) await conn.query(`ALTER TABLE ${table} ADD COLUMN \`${name}\` ${definition}`);
    }
  }

  ticketIndexes = await indexes('support_tickets');
  if (!ticketIndexes.has('idx_support_owner_jid')) await conn.query('ALTER TABLE support_tickets ADD INDEX idx_support_owner_jid (owner_jid, status)');
  if (!ticketIndexes.has('idx_support_owner_discord')) await conn.query('ALTER TABLE support_tickets ADD INDEX idx_support_owner_discord (owner_discord_id, status)');
}
