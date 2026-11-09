-- Tablas privadas del puente. Los tickets y sus mensajes siguen en las tablas existentes.
CREATE TABLE `impebot_links` (
  `user_id` CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL PRIMARY KEY,
  `whatsapp_jid` VARCHAR(128) NULL,
  `code_hash` CHAR(64) NULL,
  `code_expires` DATETIME(3) NULL,
  `linked_at` DATETIME(3) NULL,
  UNIQUE KEY `uk_impebot_jid` (`whatsapp_jid`),
  UNIQUE KEY `uk_impebot_code` (`code_hash`),
  CONSTRAINT `fk_impebot_user` FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;

CREATE TABLE `impebot_events` (
  `event_id` VARCHAR(191) NOT NULL PRIMARY KEY,
  `ticket_id` CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `actor_id` CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
  `action` VARCHAR(16) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `idx_impebot_event_ticket` (`ticket_id`),
  CONSTRAINT `fk_impebot_event_ticket` FOREIGN KEY (`ticket_id`) REFERENCES `tickets` (`id`) ON DELETE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
