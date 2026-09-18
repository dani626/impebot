import mariadb from 'mariadb';
import { CONFIG } from '../config.js';

class DatabaseService {
  constructor() {
    this.pool = null;
    this.isConnected = false;
  }

  /**
   * Inicializa el pool de conexiones a MariaDB y verifica conectividad con reintentos.
   * @param {number} maxRetries 
   * @param {number} retryDelayMs 
   */
  async initialize(maxRetries = 3, retryDelayMs = 2000) {
    if (this.pool) return;

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

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      let conn;
      try {
        conn = await this.pool.getConnection();
        await conn.ping();
        this.isConnected = true;
        console.log(`✅ [DatabaseService] Conectado exitosamente a MariaDB (${CONFIG.db.database}@${CONFIG.db.host}:${CONFIG.db.port})`);
        return;
      } catch (err) {
        console.warn(`⚠️ [DatabaseService] Intento ${attempt}/${maxRetries} de conexión fallido: ${err.message}`);
        if (attempt === maxRetries) {
          console.error(`❌ [DatabaseService] No se pudo conectar a MariaDB tras ${maxRetries} intentos.`);
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
      } finally {
        if (conn) conn.release();
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
