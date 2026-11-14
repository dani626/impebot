// Decisiones puras del relay: a qué vínculos va un mensaje, ajustes por vínculo y enlaces de cita.
// Sin acceso a red ni a base de datos, para poder probar cada caso.

/** Ajustes permitidos por vínculo, con sus valores válidos y su valor por defecto. */
export const MAPPING_SETTINGS = {
  // Qué hacer en Discord cuando el mensaje se elimina en WhatsApp.
  on_delete: { values: ['mark', 'delete', 'ignore'], default: 'mark' },
};

/** Clave de bot_settings con los valores globales, en JSON: {"on_delete":"mark"}. */
export const GLOBAL_SETTINGS_KEY = 'relay.defaults';

/** Acepta el JSON como texto (MariaDB antiguas) o ya convertido a objeto. Nunca lanza. */
export function parseSettings(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Herencia: ajuste del vínculo → valor global → valor por defecto del código.
 * Un valor desconocido se ignora y se sigue con el siguiente nivel.
 */
export function resolveSetting(key, mapping, globalSettings = null) {
  const definition = MAPPING_SETTINGS[key];
  if (!definition) throw new Error(`Ajuste de vínculo desconocido: ${key}`);
  for (const source of [parseSettings(mapping?.settings), parseSettings(globalSettings)]) {
    if (definition.values.includes(source[key])) return source[key];
  }
  return definition.default;
}

/**
 * Vínculos a los que todavía hay que reenviar un mensaje de WhatsApp.
 * @param {Array<{id: number}>} mappings vínculos de salida del chat
 * @param {Array<{channel_mapping_id: number|null}>} existingRows copias ya registradas de ese mensaje
 */
export function pendingDestinations(mappings, existingRows) {
  if (existingRows.length === 0) return mappings;
  // Una copia cuyo vínculo ya no existe no dice a dónde fue: mejor no reenviar que duplicar.
  if (existingRows.some((row) => row.channel_mapping_id == null)) return [];
  const done = new Set(existingRows.map((row) => Number(row.channel_mapping_id)));
  return mappings.filter((mapping) => !done.has(Number(mapping.id)));
}

/** Los espejos (wa_to_dc) pueden recibir varios chats en un canal: se añade el nombre del chat. */
export function displayNameFor(mapping, username, chatName) {
  return mapping.direction === 'wa_to_dc' && chatName ? `${username} · ${chatName}` : username;
}

/**
 * Cambia el enlace "Ver mensaje" de una cita por el del canal de destino,
 * o lo quita si en ese canal no existe el mensaje citado.
 */
export function retargetQuoteLink(content, fromUrl, toUrl) {
  if (!content || !fromUrl || fromUrl === toUrl) return content;
  if (toUrl) return content.split(fromUrl).join(toUrl);
  return content.replace(` • [Ver mensaje](${fromUrl})\n> 🔗 ${fromUrl}`, '');
}

export function jumpUrl(guildId, channelId, messageId) {
  return `https://discord.com/channels/${guildId || '@me'}/${channelId}/${messageId}`;
}
