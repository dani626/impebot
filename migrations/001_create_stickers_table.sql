-- Migración: Tabla para almacenamiento y detección de stickers por hash (Baileys)
CREATE TABLE IF NOT EXISTS stickers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    file_sha256 CHAR(64) NOT NULL UNIQUE COMMENT 'SHA-256 del archivo webp desencriptado en hex',
    file_enc_sha256 CHAR(64) DEFAULT NULL COMMENT 'SHA-256 del archivo cifrado en servidores de WhatsApp',
    media_key VARCHAR(64) DEFAULT NULL COMMENT 'Clave de desencriptación en Base64',
    direct_path TEXT DEFAULT NULL,
    mimetype VARCHAR(64) DEFAULT 'image/webp',
    file_length BIGINT UNSIGNED DEFAULT NULL,
    is_animated BOOLEAN DEFAULT FALSE,
    pack_name VARCHAR(255) DEFAULT NULL,
    pack_publisher VARCHAR(255) DEFAULT NULL,
    emojis VARCHAR(120) DEFAULT NULL,
    first_seen_jid VARCHAR(128) DEFAULT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    INDEX idx_stickers_sha (file_sha256)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
