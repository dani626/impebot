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

      await dbConn.query(`
        CREATE TABLE IF NOT EXISTS \`message_logs\` (
          \`id\` BIGINT AUTO_INCREMENT PRIMARY KEY,
          \`wa_message_id\` VARCHAR(128) DEFAULT NULL,
          \`discord_message_id\` VARCHAR(64) DEFAULT NULL,
          \`channel_mapping_id\` INT DEFAULT NULL,
          \`direction\` ENUM('wa_to_discord', 'discord_to_wa') NOT NULL,
          \`created_at\` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          INDEX \`idx_wa_message_id\` (\`wa_message_id\`),
          INDEX \`idx_discord_message_id\` (\`discord_message_id\`),
          INDEX \`idx_created_at\` (\`created_at\`),
          CONSTRAINT \`fk_mapping_log\` FOREIGN KEY (\`channel_mapping_id\`) REFERENCES \`channel_mappings\` (\`id\`) ON DELETE SET NULL
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
      `);

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
export default dbService;
