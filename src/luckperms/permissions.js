/**
 * Permiso de LuckPerms que exige cada comando, como si el bot fuera un plugin más.
 *
 * - public: lo puede usar cualquiera salvo que LuckPerms lo niegue explícitamente
 *   (ej. `/lp user Steve permission set impebot.sticker false`).
 * - restringido: requiere `true` en LuckPerms (o las reglas de respaldo: WA_STAFF_IDS,
 *   administradores del grupo para moderación, Gestionar servidor / rol de soporte en Discord).
 */
export const PERMISSIONS = {
  sticker: { node: 'impebot.sticker', public: true },
  help: { node: 'impebot.help', public: true },
  presence: { node: 'impebot.presence' },
  account: { node: 'impebot.account', public: true },
  link: { node: 'impebot.link' },
  moderationDelete: { node: 'impebot.moderation.delete' },
  moderationBan: { node: 'impebot.moderation.ban' },
  moderationKick: { node: 'impebot.moderation.kick' },
  moderationWarn: { node: 'impebot.moderation.warn' },
  moderationExempt: { node: 'impebot.moderation.exempt' },
  musicPlay: { node: 'impebot.music.play', public: true },
  musicControl: { node: 'impebot.music.control', public: true },
  musicQueue: { node: 'impebot.music.queue', public: true },
  ticketsStaff: { node: 'impebot.tickets.staff' },
};

/** Comando canónico de WhatsApp → permiso. */
export const WHATSAPP_COMMAND_PERMISSIONS = {
  s: PERMISSIONS.sticker,
  scrop: PERMISSIONS.sticker,
  scircle: PERMISSIONS.sticker,
  sround: PERMISSIONS.sticker,
  help: PERMISSIONS.help,
  presence: PERMISSIONS.presence,
  online: PERMISSIONS.presence,
  offline: PERMISSIONS.presence,
  mc: PERMISSIONS.account,
  mcvincular: PERMISSIONS.link,
  mcdesvincular: PERMISSIONS.link,
  borrar: PERMISSIONS.moderationDelete,
  ban: PERMISSIONS.moderationBan,
  desban: PERMISSIONS.moderationBan,
  bans: PERMISSIONS.moderationBan,
  kick: PERMISSIONS.moderationKick,
  warn: PERMISSIONS.moderationWarn,
  warns: PERMISSIONS.moderationWarn,
  unwarn: PERMISSIONS.moderationWarn,
};

/** Slash command (o botón) de música → permiso. */
export const MUSIC_PERMISSIONS = {
  play: PERMISSIONS.musicPlay,
  cola: PERMISSIONS.musicQueue,
  queue: PERMISSIONS.musicQueue,
};

export const musicPermission = (name) => MUSIC_PERMISSIONS[name] || PERMISSIONS.musicControl;

/**
 * Decisión final combinando LuckPerms con las reglas de respaldo.
 * @param {{ public?: boolean }} perm
 * @param {true|false|undefined} lpResult
 * @param {{ staff?: boolean, fallback?: boolean }} rules staff = siempre permitido (WA_STAFF_IDS);
 *   fallback = lo que permitiría el bot sin LuckPerms (admin del grupo, Gestionar servidor...)
 */
export function decide(perm, lpResult, { staff = false, fallback = false } = {}) {
  if (staff) return true; // acceso de emergencia: nunca se pierde el control del bot
  if (lpResult === true) return true;
  if (lpResult === false) return false;
  return Boolean(perm?.public || fallback);
}

/** Todos los identificadores de quien envía un mensaje de WhatsApp (LID y número). */
export function whatsappSenderIds(msg) {
  const key = msg?.key || {};
  const isGroup = String(key.remoteJid || '').endsWith('@g.us');
  return [...new Set([
    key.participant, key.participantAlt, key.participantPn, key.participantLid, key.senderPn, key.senderLid,
    isGroup ? null : key.remoteJid, isGroup ? null : key.remoteJidAlt,
  ].filter(Boolean).map((j) => String(j).replace(/:\d+@/, '@')))];
}
