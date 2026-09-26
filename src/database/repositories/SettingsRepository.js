import fs from 'fs';
import path from 'path';
import { dbService } from '../DatabaseService.js';

export class SettingsRepository {
  constructor() {
    this.localFilePath = path.resolve(process.cwd(), 'bot_settings.json');
  }

  /**
   * Lee la configuración local desde archivo JSON de respaldo.
   * @private
   */
  _readLocal() {
    try {
      if (fs.existsSync(this.localFilePath)) {
        const raw = fs.readFileSync(this.localFilePath, 'utf8');
        return JSON.parse(raw);
      }
    } catch {
      // Ignorar error al leer JSON local
    }
    return {};
  }

  /**
   * Guarda la configuración local en archivo JSON de respaldo.
   * @private
   */
  _writeLocal(data) {
    try {
      fs.writeFileSync(this.localFilePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (err) {
      console.warn('[SettingsRepository] Error al guardar en bot_settings.json:', err.message);
    }
  }

  /**
   * Obtiene un valor de configuración por su clave.
   * @param {string} key 
   * @param {string|null} [defaultValue=null] 
   * @returns {Promise<string|null>}
   */
  async get(key, defaultValue = null) {
    // 1. Intentar leer desde MariaDB
    try {
      const rows = await dbService.query(
        'SELECT setting_value FROM bot_settings WHERE setting_key = ? LIMIT 1',
        [key]
      );
      if (rows && rows.length > 0 && rows[0].setting_value !== undefined) {
        return rows[0].setting_value;
      }
    } catch {
      // Si MariaDB no está lista o falla la consulta, continuar con respaldo local
    }

    // 2. Fallback a archivo local
    const localData = this._readLocal();
    if (Object.prototype.hasOwnProperty.call(localData, key)) {
      return localData[key];
    }

    return defaultValue;
  }

  /**
   * Guarda o actualiza un valor de configuración.
   * @param {string} key 
   * @param {string} value 
   * @returns {Promise<string>}
   */
  async set(key, value) {
    const stringValue = String(value);

    // 1. Guardar de inmediato en archivo local
    const localData = this._readLocal();
    localData[key] = stringValue;
    this._writeLocal(localData);

    // 2. Persistir en MariaDB
    try {
      const sql = `
        INSERT INTO bot_settings (setting_key, setting_value)
        VALUES (?, ?)
        ON DUPLICATE KEY UPDATE
          setting_value = VALUES(setting_value),
          updated_at = CURRENT_TIMESTAMP
      `;
      await dbService.query(sql, [key, stringValue]);
    } catch (dbErr) {
      console.warn(`[SettingsRepository] No se pudo guardar clave '${key}' en MariaDB:`, dbErr.message);
    }

    return stringValue;
  }
}

export const settingsRepository = new SettingsRepository();
