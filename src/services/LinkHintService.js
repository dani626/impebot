import { CONFIG } from '../config.js';
import { settingsRepository } from '../database/repositories/SettingsRepository.js';

const SETTING_KEY = 'link_hint_groups';
export const isGroupJid = (value) => /^\d[\d-]*@g\.us$/.test(String(value || '').trim());
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

/**
 * Grupos de WhatsApp donde se avisa de que falta vincular la cuenta.
 * Suma los de WA_LINK_HINT_GROUPS (fijos) y los que se añaden desde la consola (guardados en bot_settings).
 */
export class LinkHintService {
  constructor() {
    /** @type {Map<string, string>} jid → alias (los añadidos en caliente) */
    this.dynamic = new Map();
    this.loaded = false;
  }

  async ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await settingsRepository.get(SETTING_KEY, '[]');
      for (const item of JSON.parse(raw || '[]')) if (isGroupJid(item?.jid)) this.dynamic.set(item.jid, item.alias || '');
    } catch (err) {
      console.warn(`⚠️ [LinkHint] No se pudo leer la lista de grupos: ${err.message}`);
    }
  }

  async save() {
    await settingsRepository.set(SETTING_KEY, JSON.stringify([...this.dynamic].map(([jid, alias]) => ({ jid, alias }))));
  }

  /** IDs de grupo con aviso activo (los del .env y los añadidos por consola). */
  groupIds() {
    return [...new Set([...CONFIG.linkHint.groups, ...this.dynamic.keys()])];
  }

  /** Añade un grupo por su ID (@g.us). El alias es opcional y solo sirve para reconocerlo. */
  async add(jid, alias = '') {
    await this.ensureLoaded();
    if (!isGroupJid(jid)) throw new Error('El ID de grupo debe terminar en @g.us');
    const existed = this.dynamic.has(jid);
    this.dynamic.set(jid, alias || this.dynamic.get(jid) || '');
    await this.save();
    return { jid, alias: this.dynamic.get(jid), existed };
  }

  /** Quita un grupo por ID o alias. Los del .env no se pueden quitar desde aquí. */
  async remove(ref) {
    await this.ensureLoaded();
    const wanted = norm(ref);
    const jid = [...this.dynamic].find(([id, alias]) => id === ref.trim() || (alias && norm(alias) === wanted))?.[0];
    if (!jid) {
      if (CONFIG.linkHint.groups.includes(ref.trim())) throw new Error('Ese grupo viene de WA_LINK_HINT_GROUPS en el .env: quítalo de ahí.');
      throw new Error(`No hay ningún grupo con ese ID o alias: ${ref}`);
    }
    const alias = this.dynamic.get(jid);
    this.dynamic.delete(jid);
    await this.save();
    return { jid, alias };
  }

  async list() {
    await this.ensureLoaded();
    return [
      ...CONFIG.linkHint.groups.map((jid) => ({ jid, alias: '', source: '.env' })),
      ...[...this.dynamic].map(([jid, alias]) => ({ jid, alias, source: 'consola' })),
    ];
  }
}

export const linkHintService = new LinkHintService();
