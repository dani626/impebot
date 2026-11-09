// DDL de baneos de grupos de WhatsApp y registro de comandos. Espejo en schema.sql.
export const MODERATION_DDL = [
  `CREATE TABLE IF NOT EXISTS \`wa_bans\` (
    \`id\` INT AUTO_INCREMENT PRIMARY KEY,
    \`group_jid\` VARCHAR(128) NOT NULL,
    \`user_jid\` VARCHAR(128) NOT NULL,
    \`primary_jid\` VARCHAR(128) NOT NULL,
    \`reason\` VARCHAR(255) DEFAULT NULL,
    \`banned_by\` VARCHAR(128) DEFAULT NULL,
    \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY \`uk_ban\` (\`group_jid\`, \`user_jid\`),
    INDEX \`idx_ban_primary\` (\`group_jid\`, \`primary_jid\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS \`wa_warnings\` (
    \`id\` INT AUTO_INCREMENT PRIMARY KEY,
    \`group_jid\` VARCHAR(128) NOT NULL,
    \`primary_jid\` VARCHAR(128) NOT NULL,
    \`user_ids\` TEXT NOT NULL,
    \`reason\` VARCHAR(255) DEFAULT NULL,
    \`warned_by\` VARCHAR(128) DEFAULT NULL,
    \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX \`idx_warn_group\` (\`group_jid\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
  `CREATE TABLE IF NOT EXISTS \`command_logs\` (
    \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
    \`source\` VARCHAR(16) NOT NULL,
    \`actor_id\` VARCHAR(128) DEFAULT NULL,
    \`actor_name\` VARCHAR(128) DEFAULT NULL,
    \`chat_id\` VARCHAR(128) DEFAULT NULL,
    \`command\` VARCHAR(64) NOT NULL,
    \`args\` VARCHAR(500) DEFAULT NULL,
    \`status\` VARCHAR(16) NOT NULL,
    \`detail\` VARCHAR(255) DEFAULT NULL,
    \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX \`idx_cmdlog_created\` (\`created_at\`),
    INDEX \`idx_cmdlog_source\` (\`source\`)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
];
