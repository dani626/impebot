/**
 * Permiso de LuckPerms que exige cada comando, como si el bot fuera un plugin más.
 *
 * Con LuckPerms activo y disponible, TODOS los comandos exigen su permiso en `true`
 * (se puede dar a todos con `/lp group default permission set impebot.sticker true`).
 * La única excepción es !vincular / !verificar (y !link / !verify), que nunca pasa por aquí:
 * es la forma de que un jugador se identifique.
 *
 * Si LuckPerms está desactivado o no responde, se aplican las reglas de antes:
 * - open: lo puede usar cualquiera (stickers, ayuda, música, tickets de jugador).
 * - el resto: solo con las reglas de respaldo (WA_STAFF_IDS, admins del grupo,
 *   Gestionar servidor / rol de soporte en Discord).
 * WA_STAFF_IDS siempre puede usarlo todo (acceso de emergencia).
 */
export const PERMISSIONS = {
  sticker: { node: 'impebot.sticker', open: true },
  help: { node: 'impebot.help', open: true },
  account: { node: 'impebot.account', open: true },
  presence: { node: 'impebot.presence' },
  linkAdmin: { node: 'impebot.link.admin' },
  moderationDelete: { node: 'impebot.moderation.delete' },
  moderationBan: { node: 'impebot.moderation.ban' },
  moderationKick: { node: 'impebot.moderation.kick' },
  moderationWarn: { node: 'impebot.moderation.warn' },
  moderationExempt: { node: 'impebot.moderation.exempt' },
  ticketsUse: { node: 'impebot.tickets.use', open: true },
  ticketsStaff: { node: 'impebot.tickets.staff' },
  musicPlay: { node: 'impebot.music.play', open: true },
  musicControl: { node: 'impebot.music.control', open: true },
  musicQueue: { node: 'impebot.music.queue', open: true },
  mirror: { node: 'impebot.relay.mirror' },
};

/** Comandos que nunca exigen permiso: sirven para identificarse. */
export const LINK_COMMANDS = new Set(['vincular']);

/** Comando canónico de WhatsApp → permiso (los de tickets se comprueban en TicketService). */
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
  mcvincular: PERMISSIONS.linkAdmin,
  mcdesvincular: PERMISSIONS.linkAdmin,
  borrar: PERMISSIONS.moderationDelete,
  ban: PERMISSIONS.moderationBan,
  desban: PERMISSIONS.moderationBan,
  bans: PERMISSIONS.moderationBan,
  kick: PERMISSIONS.moderationKick,
  warn: PERMISSIONS.moderationWarn,
  warns: PERMISSIONS.moderationWarn,
  unwarn: PERMISSIONS.moderationWarn,
};

/** Comandos de tickets del jugador (chat privado de WhatsApp). */
export const TICKET_PLAYER_PERMISSIONS = {
  ticket: PERMISSIONS.ticketsUse,
  tickets: PERMISSIONS.ticketsUse,
  responder: PERMISSIONS.ticketsUse,
  cerrar: PERMISSIONS.ticketsUse,
  cancelar: PERMISSIONS.ticketsUse,
};

/** Slash command (o botón) de música → permiso. */
const MUSIC_PERMISSIONS = {
  play: PERMISSIONS.musicPlay,
  cola: PERMISSIONS.musicQueue,
  queue: PERMISSIONS.musicQueue,
};

export const musicPermission = (name) => MUSIC_PERMISSIONS[name] || PERMISSIONS.musicControl;

/** Resultado de LuckPerms cuando no se pudo (o no se debe) consultar. */
export const UNAVAILABLE = Object.freeze({ result: undefined, player: null, available: false });

/**
 * Decisión final combinando LuckPerms con las reglas de respaldo.
 * @param {{ open?: boolean }} perm
 * @param {{ result?: true|false|undefined, available?: boolean }|undefined} lp resultado de luckPermsService.check()
 * @param {{ staff?: boolean, fallback?: boolean }} rules staff = WA_STAFF_IDS (siempre permitido);
 *   fallback = lo que permitiría el bot sin LuckPerms (admin del grupo, Gestionar servidor...)
 */
export function decide(perm, lp, { staff = false, fallback = false } = {}) {
  if (staff) return true; // acceso de emergencia: nunca se pierde el control del bot
  if (lp?.available) return lp.result === true;
  return Boolean(perm?.open || fallback);
}

/** Mensaje al denegar: si la persona no está vinculada, se le explica cómo hacerlo. */
export function deniedText(lp, prefix = '!') {
  if (lp?.available && !lp.player) {
    return `⛔ Primero vincula tu cuenta de Minecraft: escribe /whatsapp link en el juego y envíame \`${prefix}vincular CODIGO\`. / Link your Minecraft account first with \`${prefix}link CODE\`.`;
  }
  return '⛔ No tienes permiso para usar este comando. / You do not have permission to use this command.';
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
