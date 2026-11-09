import { CONFIG } from '../config.js';

/**
 * Comandos del bot y sus alias en español e inglés.
 * La clave es el nombre canónico (el que usan los manejadores); cada alias lleva a esa clave.
 */
export const COMMAND_ALIASES = {
  // Stickers
  s: ['sticker', 'stk', 'pegatina'],
  scrop: ['srecorte'],
  scircle: ['scirculo'],
  sround: ['sredondo'],
  // Ayuda y estado
  help: ['ayuda', 'menu', 'bot', 'comandos', 'commands'],
  presence: ['presencia'],
  online: ['enlinea', 'conectado'],
  offline: ['desconectado', 'invisible'],
  // Tickets (chats privados)
  ticket: [],
  tickets: ['mytickets', 'mistickets'],
  responder: ['reply'],
  cerrar: ['close'],
  vincular: ['link'],
  cancelar: ['cancel'],
  // Moderación de grupos
  borrar: ['delete', 'del', 'eliminar'],
  ban: ['banear'],
  desban: ['unban', 'desbanear'],
  bans: ['banlist', 'baneados'],
  kick: ['expulsar', 'echar'],
  warn: ['advertir', 'advertencia'],
  warns: ['advertencias', 'warnings'],
  unwarn: ['quitaradvertencia', 'desadvertir'],
  // Cuenta de Minecraft (LuckPerms)
  mc: ['minecraft', 'micuenta'],
  mcvincular: ['mclink', 'vincularmc'],
  mcdesvincular: ['mcunlink', 'desvincularmc'],
};

/** alias o nombre canónico → nombre canónico */
const NAME_TO_CANONICAL = new Map();
for (const [canonical, aliases] of Object.entries(COMMAND_ALIASES)) {
  NAME_TO_CANONICAL.set(canonical, canonical);
  for (const alias of aliases) NAME_TO_CANONICAL.set(alias, canonical);
}

/**
 * Lista blanca de comandos soportados por el bot (incluye todos los alias).
 */
export const BOT_COMMANDS = new Set(NAME_TO_CANONICAL.keys());

/** Devuelve el nombre canónico de un comando (o null si no existe). */
export function resolveCommandName(word) {
  return NAME_TO_CANONICAL.get(String(word || '').toLowerCase()) || null;
}

/**
 * Determina si un texto dado inicia con un prefijo configurado y corresponde a un comando válido del bot.
 * @param {string} text Texto a evaluar
 * @returns {boolean}
 */
export function isBotCommand(text) {
  if (!text || typeof text !== 'string') return false;
  const trimmed = text.trim();
  const prefix = CONFIG.prefixes.find((p) => trimmed.startsWith(p));
  if (!prefix) return false;

  const command = trimmed.slice(prefix.length).trim().split(/ +/)[0]?.toLowerCase();
  return Boolean(command && BOT_COMMANDS.has(command));
}

/**
 * Extrae y descompone un comando de texto si corresponde a uno válido.
 * `command` es el nombre canónico; `invoked` es la palabra que escribió la persona.
 * @param {string} text
 * @returns {{ isCommand: boolean, prefix?: string, command?: string, invoked?: string, args?: string[], restText?: string }}
 */
export function parseCommand(text) {
  if (!text || typeof text !== 'string') {
    return { isCommand: false };
  }

  const trimmed = text.trim();
  const prefix = CONFIG.prefixes.find((p) => trimmed.startsWith(p));
  if (!prefix) {
    return { isCommand: false };
  }

  const tokens = trimmed.slice(prefix.length).trim().split(/ +/);
  const invoked = tokens.shift()?.toLowerCase();
  const command = resolveCommandName(invoked);

  if (!command) {
    return { isCommand: false };
  }

  const restText = tokens.join(' ');
  return {
    isCommand: true,
    prefix,
    command,
    invoked,
    args: tokens,
    restText,
  };
}
