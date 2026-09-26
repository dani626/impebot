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

-- 3. Tabla de Logs de Mensajes para Prevención de Bucles
CREATE TABLE IF NOT EXISTS `message_logs` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `wa_message_id` VARCHAR(128) DEFAULT NULL,
  `discord_message_id` VARCHAR(64) DEFAULT NULL,
  `channel_mapping_id` INT DEFAULT NULL,
  `direction` ENUM('wa_to_discord', 'discord_to_wa') NOT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_wa_message_id` (`wa_message_id`),
  INDEX `idx_discord_message_id` (`discord_message_id`),
  INDEX `idx_created_at` (`created_at`),
  CONSTRAINT `fk_mapping_log` FOREIGN KEY (`channel_mapping_id`) REFERENCES `channel_mappings` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. Ajustes persistentes del bot (presencia de WhatsApp, etc.)
-- Espejo del DDL que aplica DatabaseService.ensureDatabaseAndTables() al arrancar.
CREATE TABLE IF NOT EXISTS `bot_settings` (
  `setting_key` VARCHAR(64) NOT NULL PRIMARY KEY,
  `setting_value` TEXT NOT NULL,
  `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
