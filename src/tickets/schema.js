// Prefijo propio: nunca modifica las tablas del relay ni las de impecraft-web.
export const TICKET_DDL = [
  `CREATE TABLE IF NOT EXISTS support_tickets (
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
];
