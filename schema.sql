-- Espejo del DDL que crea el bot al arrancar (DatabaseService.ensureDatabaseAndTables).
-- Importar este archivo es opcional.
CREATE DATABASE IF NOT EXISTS `relay_bot` DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `relay_bot`;

-- 1. Tabla de Mapeo de Canales / Grupos
CREATE TABLE IF NOT EXISTS `channel_mappings` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `whatsapp_jid` VARCHAR(128) NOT NULL,
  `discord_channel_id` VARCHAR(64) NOT NULL,
  `webhook_url` TEXT DEFAULT NULL,
  `webhook_id` VARCHAR(64) DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_whatsapp_jid` (`whatsapp_jid`),
  INDEX `idx_discord_channel_id` (`discord_channel_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. Tabla de Mapeo de Usuarios
CREATE TABLE IF NOT EXISTS `user_mappings` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `whatsapp_jid` VARCHAR(128) NOT NULL,
  `discord_user_id` VARCHAR(64) DEFAULT NULL,
  `display_name` VARCHAR(128) NOT NULL,
  `avatar_url` TEXT DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_user_wa_jid` (`whatsapp_jid`),
  INDEX `idx_user_discord_id` (`discord_user_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. Tabla de Mapeo de Mensajes entre Plataformas (WhatsApp, Discord, etc.)
CREATE TABLE IF NOT EXISTS `message_mappings` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `wa_message_id` VARCHAR(128) DEFAULT NULL,
  `discord_message_id` VARCHAR(64) DEFAULT NULL,
  `channel_mapping_id` INT DEFAULT NULL,
  `origin_platform` VARCHAR(32) NOT NULL DEFAULT 'whatsapp',
  `sender_name` VARCHAR(128) DEFAULT NULL,
  `content` TEXT DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_wa_message_id` (`wa_message_id`),
  INDEX `idx_discord_message_id` (`discord_message_id`),
  INDEX `idx_origin_platform` (`origin_platform`),
  INDEX `idx_created_at` (`created_at`),
  CONSTRAINT `fk_channel_mapping_message` FOREIGN KEY (`channel_mapping_id`) REFERENCES `channel_mappings` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Ajustes persistentes del bot (presencia de WhatsApp, etc.)
-- Espejo del DDL que aplica DatabaseService.ensureDatabaseAndTables() al arrancar.
CREATE TABLE IF NOT EXISTS `bot_settings` (
  `setting_key` VARCHAR(64) NOT NULL PRIMARY KEY,
  `setting_value` TEXT NOT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4b. Espejos: copia de los mensajes de un chat de WhatsApp ('*' = todos) a otro canal/servidor de Discord
CREATE TABLE IF NOT EXISTS `relay_mirrors` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `whatsapp_jid` VARCHAR(128) NOT NULL,
  `discord_channel_id` VARCHAR(64) NOT NULL,
  `webhook_url` TEXT DEFAULT NULL,
  `created_by` VARCHAR(64) DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_mirror` (`whatsapp_jid`, `discord_channel_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4c. Alias para no escribir IDs de canal ni JIDs en /espejo
CREATE TABLE IF NOT EXISTS `relay_aliases` (
  `alias` VARCHAR(64) NOT NULL PRIMARY KEY,
  `target` VARCHAR(128) NOT NULL,
  `created_by` VARCHAR(64) DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4d. Baneos de grupos de WhatsApp y registro de comandos
CREATE TABLE IF NOT EXISTS `wa_bans` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `group_jid` VARCHAR(128) NOT NULL,
  `user_jid` VARCHAR(128) NOT NULL,
  `primary_jid` VARCHAR(128) NOT NULL,
  `reason` VARCHAR(255) DEFAULT NULL,
  `banned_by` VARCHAR(128) DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_ban` (`group_jid`, `user_jid`),
  INDEX `idx_ban_primary` (`group_jid`, `primary_jid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `wa_warnings` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `group_jid` VARCHAR(128) NOT NULL,
  `primary_jid` VARCHAR(128) NOT NULL,
  `user_ids` TEXT NOT NULL,
  `reason` VARCHAR(255) DEFAULT NULL,
  `warned_by` VARCHAR(128) DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_warn_group` (`group_jid`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `command_logs` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `source` VARCHAR(16) NOT NULL,
  `actor_id` VARCHAR(128) DEFAULT NULL,
  `actor_name` VARCHAR(128) DEFAULT NULL,
  `chat_id` VARCHAR(128) DEFAULT NULL,
  `command` VARCHAR(64) NOT NULL,
  `args` VARCHAR(500) DEFAULT NULL,
  `status` VARCHAR(16) NOT NULL,
  `detail` VARCHAR(255) DEFAULT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_cmdlog_created` (`created_at`),
  INDEX `idx_cmdlog_source` (`source`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. Tickets y entregas persistentes (ver src/tickets/schema.js)
CREATE TABLE IF NOT EXISTS support_tickets (
    number INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    id CHAR(36) NOT NULL UNIQUE,
    subject VARCHAR(150) NOT NULL,
    category ENUM('soporte','compra','reporte','apelacion','bug','otro') NOT NULL,
    status ENUM('OPEN','PENDING','CLOSED') NOT NULL DEFAULT 'OPEN',
    priority ENUM('LOW','NORMAL','HIGH','URGENT') NOT NULL DEFAULT 'NORMAL',
    owner_jid VARCHAR(128) NOT NULL,
    user_name VARCHAR(128) NOT NULL,
    assignee_id VARCHAR(64) NULL,
    assignee_name VARCHAR(128) NULL,
    active_owner VARCHAR(128) GENERATED ALWAYS AS (CASE WHEN status <> 'CLOSED' THEN owner_jid ELSE NULL END) STORED,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    closed_at DATETIME(3) NULL,
    UNIQUE KEY uk_support_active_owner (active_owner)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS support_messages (
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
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS support_routes (
    ticket_key VARCHAR(96) PRIMARY KEY,
    ticket_number INT NOT NULL,
    discord_channel_id VARCHAR(64) NULL UNIQUE,
    whatsapp_jid VARCHAR(128) NULL,
    last_status VARCHAR(16) NULL,
    last_meta VARCHAR(255) NULL,
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS support_deliveries (
    ticket_key VARCHAR(96) NOT NULL,
    message_id VARCHAR(128) NOT NULL,
    destination VARCHAR(16) NOT NULL,
    delivered_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (ticket_key, message_id, destination)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
