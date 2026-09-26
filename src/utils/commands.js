import { CONFIG } from '../config.js';

/**
 * Lista blanca de comandos soportados por el bot.
 */
export const BOT_COMMANDS = new Set([
  's',
  'sticker',
  'scrop',
  'scircle',
  'sround',
  'help',
  'menu',
  'bot',
  'presence',
  'presencia',
  'online',
  'offline',
]);

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
 * @param {string} text 
 * @returns {{ isCommand: boolean, prefix?: string, command?: string, args?: string[], restText?: string }}
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
  const command = tokens.shift()?.toLowerCase();

  if (!command || !BOT_COMMANDS.has(command)) {
    return { isCommand: false };
  }

  const restText = tokens.join(' ');
  return {
    isCommand: true,
    prefix,
    command,
    args: tokens,
    restText,
  };
}
