import { CONFIG } from '../config.js';

/**
 * ¿Se atienden comandos de este servidor de Discord?
 * Sin DISCORD_GUILD_ID, todos. Con él, solo ese; y con `extra`, también los de DISCORD_EXTRA_GUILD_IDS
 * (música y /minecraft, que no dependen de los canales del servidor principal).
 */
export function isCommandGuild(guildId, { extra = false } = {}) {
  const main = CONFIG.discord.guildId;
  if (!main) return true;
  return guildId === main || (extra && CONFIG.discord.extraGuildIds.includes(guildId));
}

/** Servidores donde se registran los comandos. */
export function commandGuildIds({ extra = false } = {}) {
  const ids = [CONFIG.discord.guildId, ...(extra ? CONFIG.discord.extraGuildIds : [])].filter(Boolean);
  return [...new Set(ids)];
}
