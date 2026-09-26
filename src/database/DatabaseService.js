import mariadb from 'mariadb';
import { CONFIG } from '../config.js';

class DatabaseService {
  constructor() {
    this.pool = null;
    this.isConnected = false;
  }

  /**
   * Asegura que la base de datos y las tablas existan antes de inicializar el pool principal.
   */
  async ensureDatabaseAndTables() {
    let serverConn;
    try {
      // 1. Conexión temporal al servidor MariaDB sin especificar base de datos
      serverConn = await mariadb.createConnection({
        host: CONFIG.db.host,
        port: CONFIG.db.port,
        user: CONFIG.db.user,
        password: CONFIG.db.password,
        connectTimeout: 10000,
      });

      // 2. Crear la base de datos si no existe con utf8mb4
      const dbNameEscaped = `\`${CONFIG.db.database.replace(/`/g, '``')}\``;
      await serverConn.query(
        `CREATE DATABASE IF NOT EXISTS ${dbNameEscaped} DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
      );
      console.log(`📦 [DatabaseService] Base de datos '${CONFIG.db.database}' verificada / lista.`);
    } catch (err) {
      console.error(`❌ [DatabaseService] Error al verificar/crear la base de datos: ${err.message}`);
      throw err;
    } finally {
      if (serverConn) await serverConn.end().catch(() => {});
    }

    let dbConn;
    try {
      // 3. Conexión a la base de datos para crear tablas si no existen
      dbConn = await mariadb.createConnection({
        host: CONFIG.db.host,
        port: CONFIG.db.port,
        user: CONFIG.db.user,
        password: CONFIG.db.password,
        database: CONFIG.db.database,
        connectTimeout: 10000,
      });

      // 4. Crear tablas requeridas si no existen
      await dbConn.query(`
        CREATE TABLE IF NOT EXISTS \`channel_mappings\` (
          \`id\` INT AUTO_INCREMENT PRIMARY KEY,
          \`whatsapp_jid\` VARCHAR(128) NOT NULL,
          \`discord_channel_id\` VARCHAR(64) NOT NULL,
          \`webhook_url\` TEXT DEFAULT NULL,
          \`webhook_id\` VARCHAR(64) DEFAULT NULL,
          \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY \`uk_whatsapp_jid\` (\`whatsapp_jid\`),
          INDEX \`idx_discord_channel_id\` (\`discord_channel_id\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      await dbConn.query(`
        CREATE TABLE IF NOT EXISTS \`user_mappings\` (
          \`id\` INT AUTO_INCREMENT PRIMARY KEY,
          \`whatsapp_jid\` VARCHAR(128) NOT NULL,
          \`discord_user_id\` VARCHAR(64) DEFAULT NULL,
          \`display_name\` VARCHAR(128) NOT NULL,
          \`avatar_url\` TEXT DEFAULT NULL,
          \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
          UNIQUE KEY \`uk_user_wa_jid\` (\`whatsapp_jid\`),
          INDEX \`idx_user_discord_id\` (\`discord_user_id\`)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      // Migración / Creación de message_mappings
      // 1. Si existe la tabla anterior 'message_logs', renombrarla a 'message_mappings'
      try {
        const tableCheck = await dbConn.query(`
          SELECT TABLE_NAME 
          FROM information_schema.TABLES 
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'message_logs'
        `, [CONFIG.db.database]);

        if (tableCheck.length > 0) {
          const newTableCheck = await dbConn.query(`
            SELECT TABLE_NAME 
            FROM information_schema.TABLES 
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'message_mappings'
          `, [CONFIG.db.database]);

          if (newTableCheck.length === 0) {
            console.log('🔄 [DatabaseService] Migrando tabla message_logs -> message_mappings...');
            await dbConn.query(`RENAME TABLE \`message_logs\` TO \`message_mappings\`;`);
          }
        }
      } catch (e) {
        console.warn('⚠️ [DatabaseService] Advertencia al verificar migración de tabla message_logs:', e.message);
      }

      await dbConn.query(`
        CREATE TABLE IF NOT EXISTS \`message_mappings\` (
          \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
          \`wa_message_id\` VARCHAR(128) DEFAULT NULL,
          \`discord_message_id\` VARCHAR(64) DEFAULT NULL,
          \`channel_mapping_id\` INT DEFAULT NULL,
          \`origin_platform\` VARCHAR(32) NOT NULL DEFAULT 'whatsapp',
          \`sender_name\` VARCHAR(128) DEFAULT NULL,
          \`content\` TEXT DEFAULT NULL,
          \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX \`idx_wa_message_id\` (\`wa_message_id\`),
          INDEX \`idx_discord_message_id\` (\`discord_message_id\`),
          INDEX \`idx_origin_platform\` (\`origin_platform\`),
          INDEX \`idx_created_at\` (\`created_at\`),
          CONSTRAINT \`fk_channel_mapping_message\` FOREIGN KEY (\`channel_mapping_id\`) REFERENCES \`channel_mappings\` (\`id\`) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      // Asegurar que las nuevas columnas existan si la tabla venía del rename
      try {
        const cols = await dbConn.query(`
          SELECT COLUMN_NAME 
          FROM information_schema.COLUMNS 
          WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'message_mappings'
        `, [CONFIG.db.database]);
        const colNames = cols.map((c) => c.COLUMN_NAME.toLowerCase());

        if (colNames.includes('direction') && !colNames.includes('origin_platform')) {
          await dbConn.query(`
            ALTER TABLE \`message_mappings\` 
            ADD COLUMN \`origin_platform\` VARCHAR(32) NOT NULL DEFAULT 'whatsapp' AFTER \`channel_mapping_id\`;
          `);
          await dbConn.query(`
            UPDATE \`message_mappings\` 
            SET \`origin_platform\` = CASE 
              WHEN \`direction\` = 'discord_to_wa' THEN 'discord' 
              ELSE 'whatsapp' 
            END;
          `);
        }

        if (!colNames.includes('sender_name')) {
          await dbConn.query(`ALTER TABLE \`message_mappings\` ADD COLUMN \`sender_name\` VARCHAR(128) DEFAULT NULL AFTER \`origin_platform\`;`);
        }
        if (!colNames.includes('content')) {
          await dbConn.query(`ALTER TABLE \`message_mappings\` ADD COLUMN \`content\` TEXT DEFAULT NULL AFTER \`sender_name\`;`);
        }
      } catch (alterErr) {
        console.warn('⚠️ [DatabaseService] Advertencia al ajustar columnas de message_mappings:', alterErr.message);
      }

      await dbConn.query(`
        CREATE TABLE IF NOT EXISTS \`bot_settings\` (
          \`setting_key\` VARCHAR(64) NOT NULL PRIMARY KEY,
          \`setting_value\` TEXT NOT NULL,
          \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          \`updated_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

      console.log(`📋 [DatabaseService] Tablas requeridas verificadas / listas.`);
    } catch (err) {
      console.error(`❌ [DatabaseService] Error al verificar/crear tablas: ${err.message}`);
      throw err;
    } finally {
      if (dbConn) await dbConn.end().catch(() => {});
    }
  }

  /**
   * Inicializa el pool de conexiones a MariaDB y verifica conectividad con reintentos.
   * Si la base de datos o las tablas no existen, las crea automáticamente.
   * @param {number} maxRetries 
   * @param {number} retryDelayMs 
   */
  async initialize(maxRetries = 3, retryDelayMs = 2000) {
    if (this.pool) return;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        // Asegurar que la base de datos y tablas existan antes de inicializar el pool
        await this.ensureDatabaseAndTables();

        this.pool = mariadb.createPool({
          host: CONFIG.db.host,
          port: CONFIG.db.port,
          user: CONFIG.db.user,
          password: CONFIG.db.password,
          database: CONFIG.db.database,
          connectionLimit: CONFIG.db.connectionLimit,
          acquireTimeout: 10000,
          connectTimeout: 10000,
        });

        let conn = await this.pool.getConnection();
        await conn.ping();
        conn.release();

        this.isConnected = true;
        console.log(`✅ [DatabaseService] Conectado exitosamente a MariaDB (${CONFIG.db.database}@${CONFIG.db.host}:${CONFIG.db.port})`);
        return;
      } catch (err) {
        if (this.pool) {
          await this.pool.end().catch(() => {});
          this.pool = null;
        }
        console.warn(`⚠️ [DatabaseService] Intento ${attempt}/${maxRetries} de conexión fallido: ${err.message}`);
        if (attempt === maxRetries) {
          console.error(`❌ [DatabaseService] No se pudo conectar a MariaDB tras ${maxRetries} intentos.`);
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
      }
    }
  }

  /**
   * Ejecuta una consulta SQL asegurando la liberación automática de la conexión.
   * @param {string} sql 
   * @param {any[]} params 
   * @returns {Promise<any>}
   */
  async query(sql, params = []) {
    if (!this.pool) {
      throw new Error('[DatabaseService] El pool de conexiones no está inicializado.');
    }

    let conn;
    try {
      conn = await this.pool.getConnection();
      const result = await conn.query(sql, params);
      return result;
    } catch (error) {
      console.error(`[DatabaseService] Error al ejecutar consulta SQL: ${error.message}\nQuery: ${sql}`);
      throw error;
    } finally {
      if (conn) conn.release();
    }
  }

  /**
   * Cierra el pool de conexiones de manera limpia.
   */
  async shutdown() {
    if (this.pool) {
      console.log('🔄 [DatabaseService] Cerrando pool de conexiones MariaDB...');
      await this.pool.end();
      this.pool = null;
      this.isConnected = false;
      console.log('🛑 [DatabaseService] Conexiones a MariaDB cerradas.');
    }
  }
}

// Exportamos una instancia única (Singleton)
export const dbService = new DatabaseService();
