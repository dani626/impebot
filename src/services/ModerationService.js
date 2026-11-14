import { CONFIG } from '../config.js';
import { moderationRepository } from '../database/repositories/ModerationRepository.js';
import { commandLogService } from './CommandLogService.js';
import { getContextInfo, formatPhoneNumber } from '../utils/whatsappMessage.js';
import { luckPermsService } from '../luckperms/LuckPermsService.js';
import { decide, PERMISSIONS, UNAVAILABLE, WHATSAPP_COMMAND_PERMISSIONS } from '../luckperms/permissions.js';

export const MODERATION_COMMANDS = new Set(['borrar', 'ban', 'desban', 'bans', 'kick', 'warn', 'warns', 'unwarn']);

/** Quita el sufijo de dispositivo (":12") de un JID. */
const norm = (jid) => (typeof jid === 'string' && jid ? jid.replace(/:\d+@/, '@') : null);
export const userPart = (jid) => String(jid || '').split('@')[0].split(':')[0];

/** Todos los identificadores conocidos de un participante (LID y número). */
export function participantIds(p) {
  return [...new Set([p?.id, p?.lid, p?.jid, p?.phoneNumber, p?.phone_number].map(norm).filter(Boolean))];
}

function findParticipant(meta, jids) {
  const wanted = new Set(jids.filter(Boolean).map(userPart));
  return (meta?.participants || []).find((p) => participantIds(p).some((id) => wanted.has(userPart(id)))) || null;
}

const isAdmin = (p) => Boolean(p && (p.admin === 'admin' || p.admin === 'superadmin' || p.isAdmin || p.isSuperAdmin));
const idsOfWarning = (w) => String(w.user_ids || w.primary_jid).split(',').filter(Boolean);
const displayName = (jid) => (jid.endsWith('@s.whatsapp.net') ? formatPhoneNumber(jid) : userPart(jid));

export class ModerationService {
  /**
   * @param {object} deps
   * @param {(ids: string[], node: string) => Promise<{ result, available, player }>} [deps.permissions] consulta a LuckPerms
   */
  constructor({
    repo = moderationRepository, config = CONFIG.moderation, logger = commandLogService,
    permissions = (ids, node) => luckPermsService.check('whatsapp', ids, node),
  } = {}) {
    this.repo = repo;
    this.permissions = permissions;
    this.config = config;
    this.logger = logger;
    this.whatsapp = null;
    this.onParticipants = (event) => void this.enforceBans(event)
      .catch((err) => console.error('[Moderation] Error aplicando baneos:', err.message));
  }

  start(whatsapp) {
    this.whatsapp = whatsapp;
    if (this.config.enforceBans) whatsapp.on('groupParticipantsUpdate', this.onParticipants);
  }

  stop() {
    this.whatsapp?.off('groupParticipantsUpdate', this.onParticipants);
  }

  /**
   * ¿Puede esta persona moderar? Staff global (WA_STAFF_IDS) siempre; con LuckPerms disponible,
   * solo quien tenga el permiso del comando; sin LuckPerms, los administradores del grupo.
   * @param {{ result?: boolean, available?: boolean }} [luckperms] resultado de LuckPerms para el comando
   */
  authorize(meta, senderIds, luckperms) {
    const entry = findParticipant(meta, senderIds);
    const ids = [...new Set([...senderIds, ...(entry ? participantIds(entry) : [])])];
    const staff = ids.some((id) => this.config.staff.includes(userPart(id)));
    const admin = isAdmin(entry);
    const allowed = decide({}, luckperms, { staff, fallback: this.config.allowGroupAdmins && admin });
    return { allowed, staff, admin, ids, luckperms };
  }

  /** Igual que authorize() pero consultando LuckPerms con todos los identificadores del autor. */
  async authorizeCommand(meta, senderIds, command) {
    const { ids } = this.authorize(meta, senderIds);
    const node = WHATSAPP_COMMAND_PERMISSIONS[command]?.node;
    const luckperms = node ? await this.permissions(ids, node).catch(() => UNAVAILABLE) : UNAVAILABLE;
    return this.authorize(meta, senderIds, luckperms);
  }

  /**
   * Ejecuta un comando de moderación.
   * @returns {Promise<{ status: 'ok'|'denegado'|'error'|'uso'|'ignorado', detail?: string }>}
   */
  async handle({ sock, msg, command, args = [], prefix = '!' }) {
    const groupJid = msg.key.remoteJid;
    const reply = (text, mentions) => sock.sendMessage(groupJid, { text, mentions }, { quoted: msg });

    if (!groupJid?.endsWith('@g.us')) {
      await reply('⚠️ Este comando solo funciona dentro de grupos. / This command only works in groups.');
      return { status: 'ignorado', detail: 'no es un grupo' };
    }

    const meta = await sock.groupMetadata(groupJid);
    const senderIds = [msg.key.participant, msg.key.participantAlt].map(norm).filter(Boolean);
    const auth = await this.authorizeCommand(meta, senderIds, command);
    if (!auth.allowed) {
      // Sin permiso el bot no contesta en el chat: el resultado queda en la consola.
      return { status: 'denegado', detail: 'sin permisos' };
    }

    const botIds = [sock.user?.id, sock.user?.lid].map(norm).filter(Boolean);
    const botEntry = findParticipant(meta, botIds);
    const ctx = {
      sock, msg, args, prefix, groupJid, meta, auth, botIds, botAdmin: isAdmin(botEntry), reply, senderId: senderIds[0],
    };

    switch (command) {
      case 'borrar': return this.deleteMessage(ctx);
      case 'ban': return this.ban(ctx);
      case 'kick': return this.kick(ctx);
      case 'desban': return this.unban(ctx);
      case 'bans': return this.listBans(ctx);
      case 'warn': return this.warn(ctx);
      case 'warns': return this.listWarns(ctx);
      case 'unwarn': return this.unwarn(ctx);
      default: return { status: 'ignorado', detail: 'comando desconocido' };
    }
  }

  async deleteMessage({ sock, msg, prefix, groupJid, botIds, botAdmin, reply }) {
    const info = getContextInfo(msg);
    if (!info?.stanzaId) {
      await reply(`⚠️ Responde al mensaje que quieres borrar con \`${prefix}borrar\`. / Reply to the message you want to delete with \`${prefix}delete\`.`);
      return { status: 'uso', detail: 'sin mensaje citado' };
    }
    const quotedFrom = norm(info.participant);
    const ownMessage = botIds.some((id) => userPart(id) === userPart(quotedFrom));
    if (!ownMessage && !botAdmin) {
      await reply('⚠️ Necesito ser administrador del grupo para borrar mensajes de otras personas. / I need to be a group admin to delete other people\'s messages.');
      return { status: 'error', detail: 'el bot no es admin' };
    }

    await sock.sendMessage(groupJid, {
      delete: { remoteJid: groupJid, fromMe: ownMessage, id: info.stanzaId, participant: info.participant },
    });
    // Limpiar también el comando, para no dejar rastro en el chat.
    if (botAdmin) await sock.sendMessage(groupJid, { delete: msg.key }).catch(() => {});
    return { status: 'ok', detail: `mensaje ${info.stanzaId} de ${userPart(quotedFrom)}` };
  }

  /** Objetivo del comando: mención, mensaje citado o número escrito. */
  resolveTarget(msg, args) {
    const info = getContextInfo(msg);
    const num = args.find((a) => /^\+?\d{6,}$/.test(a));
    const jid = norm(info?.mentionedJid?.[0]) || norm(info?.participant)
      || (num ? `${num.replace(/\D/g, '')}@s.whatsapp.net` : null);
    return { jid, num };
  }

  /**
   * Resuelve y valida a quién se aplica la acción.
   * @returns {{ error: object } | { jid: string, entry: object|null, ids: string[], reason: string|null }}
   */
  async prepareTarget(ctx, usage, { requireMember = false } = {}) {
    const { msg, args, groupJid, meta, auth, botIds, reply } = ctx;
    const { jid, num } = this.resolveTarget(msg, args);
    if (!jid) {
      await reply(usage);
      return { error: { status: 'uso', detail: 'sin objetivo' } };
    }
    const entry = findParticipant(meta, [jid]);
    const ids = entry ? participantIds(entry) : [jid];
    const reason = args.filter((a) => !a.startsWith('@') && a !== num).join(' ').trim() || null;

    if (ids.some((id) => botIds.some((b) => userPart(b) === userPart(id)))) {
      await reply('⚠️ No puedo aplicarme esto a mí mismo. / I cannot do this to myself.');
      return { error: { status: 'denegado', detail: 'objetivo es el bot' } };
    }
    if (ids.some((id) => auth.ids.some((s) => userPart(s) === userPart(id)))) {
      await reply('⚠️ No puedes aplicártelo a ti mismo. / You cannot do this to yourself.');
      return { error: { status: 'denegado', detail: 'objetivo es el autor' } };
    }
    const exempt = async () => (await this.permissions(ids, PERMISSIONS.moderationExempt.node).catch(() => UNAVAILABLE))?.result === true;
    if (ids.some((id) => this.config.staff.includes(userPart(id))) || isAdmin(entry) || await exempt()) {
      await reply('⚠️ No se puede aplicar a un administrador ni al staff. Quítale el rango primero. / Not allowed on admins or staff. Remove their rank first.');
      return { error: { status: 'denegado', detail: 'objetivo protegido' } };
    }
    if (requireMember && !entry) {
      await reply('⚠️ Esa persona no está en el grupo. / That person is not in the group.');
      return { error: { status: 'error', detail: 'no está en el grupo' } };
    }
    return { jid, entry, ids, reason, groupJid };
  }

  /** Expulsa a un participante. @returns {Promise<{ error: object }|null>} */
  async removeFromGroup({ sock, groupJid, botAdmin, reply }, entry) {
    if (!botAdmin) {
      await reply('⚠️ Necesito ser administrador del grupo para expulsar. / I need to be a group admin to remove people.');
      return { error: { status: 'error', detail: 'el bot no es admin' } };
    }
    const result = await sock.groupParticipantsUpdate(groupJid, [entry.id], 'remove');
    const failed = Array.isArray(result) && result.find((r) => String(r.status) !== '200');
    if (failed) {
      await reply(`❌ WhatsApp rechazó la expulsión (código ${failed.status}). / WhatsApp rejected the removal (code ${failed.status}).`);
      return { error: { status: 'error', detail: `expulsión rechazada ${failed.status}` } };
    }
    return null;
  }

  async kick(ctx) {
    const { prefix, reply } = ctx;
    const target = await this.prepareTarget(ctx,
      `⚠️ Uso: \`${prefix}kick @usuario motivo\` o responde a su mensaje. / Usage: \`${prefix}kick @user reason\` or reply to their message.`,
      { requireMember: true });
    if (target.error) return target.error;

    const failure = await this.removeFromGroup(ctx, target.entry);
    if (failure) return failure.error;
    await reply(
      `👢 @${userPart(target.jid)} fue expulsado del grupo. / was removed from the group.` + (target.reason ? `\n📝 ${target.reason}` : ''),
      [target.jid]
    );
    return { status: 'ok', detail: `expulsado ${userPart(target.jid)}${target.reason ? ` (${target.reason})` : ''}` };
  }

  async ban(ctx) {
    const { prefix, reply, groupJid, senderId } = ctx;
    const target = await this.prepareTarget(ctx,
      `⚠️ Uso: \`${prefix}ban @usuario motivo\` o responde a su mensaje. / Usage: \`${prefix}ban @user reason\` or reply to their message.`);
    if (target.error) return target.error;

    if (target.entry) {
      const failure = await this.removeFromGroup(ctx, target.entry);
      if (failure) return failure.error;
    }
    await this.repo.addBan(groupJid, target.ids, { reason: target.reason, bannedBy: senderId });
    await reply(
      `🔨 @${userPart(target.jid)} fue baneado${target.entry ? '' : ' (no estaba en el grupo; queda bloqueado si vuelve)'}. / was banned.`
      + (target.reason ? `\n📝 ${target.reason}` : ''),
      [target.jid]
    );
    return { status: 'ok', detail: `baneado ${userPart(target.jid)}${target.reason ? ` (${target.reason})` : ''}` };
  }

  async unban({ msg, args, prefix, groupJid, reply }) {
    const { jid } = this.resolveTarget(msg, args);
    if (!jid) {
      await reply(`⚠️ Uso: \`${prefix}desban @usuario\` o \`${prefix}desban 56912345678\`. / Usage: \`${prefix}unban @user\`.`);
      return { status: 'uso', detail: 'sin objetivo' };
    }
    const rows = await this.repo.getBans(groupJid);
    const primaries = [...new Set(rows.filter((r) => userPart(r.user_jid) === userPart(jid)).map((r) => r.primary_jid))];
    const removed = await this.repo.removeBansByPrimary(groupJid, primaries);
    if (!removed) {
      await reply('ℹ️ Esa persona no estaba baneada en este grupo. / That person was not banned in this group.');
      return { status: 'ok', detail: `${userPart(jid)} no estaba baneado` };
    }
    await reply(`✅ @${userPart(jid)} ya no está baneado. Podrá volver a entrar. / is no longer banned.`, [jid]);
    return { status: 'ok', detail: `desbaneado ${userPart(jid)}` };
  }

  async listBans({ groupJid, reply }) {
    const rows = await this.repo.getBans(groupJid);
    const byPerson = new Map();
    for (const r of rows) if (!byPerson.has(r.primary_jid)) byPerson.set(r.primary_jid, r);
    if (!byPerson.size) {
      await reply('✅ No hay personas baneadas en este grupo. / Nobody is banned in this group.');
      return { status: 'ok', detail: '0 baneados' };
    }
    const lines = [...byPerson.values()].slice(0, 50).map((r) => `• ${displayName(r.primary_jid)}${r.reason ? ` — ${r.reason}` : ''}`);
    await reply(`🔨 *Baneados / Banned (${byPerson.size}):*\n${lines.join('\n')}`);
    return { status: 'ok', detail: `${byPerson.size} baneados` };
  }

  /** Advertencias de una persona (por cualquiera de sus identificadores). */
  warningsOf(all, ids) {
    const wanted = new Set(ids.map(userPart));
    return all.filter((w) => idsOfWarning(w).some((id) => wanted.has(userPart(id))));
  }

  async warn(ctx) {
    const { prefix, reply, groupJid, senderId } = ctx;
    const target = await this.prepareTarget(ctx,
      `⚠️ Uso: \`${prefix}warn @usuario motivo\` o responde a su mensaje. / Usage: \`${prefix}warn @user reason\` or reply to their message.`,
      { requireMember: true });
    if (target.error) return target.error;

    await this.repo.addWarning(groupJid, target.ids, { reason: target.reason, warnedBy: senderId });
    const mine = this.warningsOf(await this.repo.getWarnings(groupJid), target.ids);
    const limit = this.config.warnLimit;
    const counter = limit > 0 ? `${mine.length}/${limit}` : `${mine.length}`;
    const mention = `@${userPart(target.jid)}`;

    if (limit > 0 && mine.length >= limit) {
      const action = this.config.warnAction === 'ban' ? 'ban' : 'kick';
      const failure = await this.removeFromGroup(ctx, target.entry);
      if (failure) {
        await reply(`⚠️ ${mention} llegó al límite de advertencias (${counter}) pero no pude expulsarlo. / reached the warning limit but I could not remove them.`, [target.jid]);
        return { status: 'error', detail: `${failure.error.detail} (límite ${counter})` };
      }
      if (action === 'ban') await this.repo.addBan(groupJid, target.ids, { reason: `Límite de advertencias (${limit})`, bannedBy: senderId });
      await this.repo.removeWarnings(mine.map((w) => w.id));
      await reply(
        `🚫 ${mention} llegó a ${counter} advertencias y fue ${action === 'ban' ? 'baneado' : 'expulsado'}. / reached ${counter} warnings and was ${action === 'ban' ? 'banned' : 'removed'}.`,
        [target.jid]
      );
      return { status: 'ok', detail: `${userPart(target.jid)} sancionado por límite (${action}) tras ${counter}` };
    }

    await reply(
      `⚠️ ${mention} recibió una advertencia (${counter}). / received a warning.` + (target.reason ? `\n📝 ${target.reason}` : ''),
      [target.jid]
    );
    return { status: 'ok', detail: `advertido ${userPart(target.jid)} (${counter})${target.reason ? `: ${target.reason}` : ''}` };
  }

  async listWarns({ msg, args, groupJid, meta, reply }) {
    const all = await this.repo.getWarnings(groupJid);
    const { jid } = this.resolveTarget(msg, args);
    const limit = this.config.warnLimit;

    if (jid) {
      const entry = findParticipant(meta, [jid]);
      const mine = this.warningsOf(all, entry ? participantIds(entry) : [jid]);
      if (!mine.length) {
        await reply(`✅ @${userPart(jid)} no tiene advertencias. / has no warnings.`, [jid]);
        return { status: 'ok', detail: `${userPart(jid)}: 0 advertencias` };
      }
      const lines = mine.map((w, i) => `${i + 1}. ${w.reason || 'sin motivo / no reason'}`);
      await reply(`⚠️ *@${userPart(jid)}: ${mine.length}${limit > 0 ? `/${limit}` : ''}*\n${lines.join('\n')}`, [jid]);
      return { status: 'ok', detail: `${userPart(jid)}: ${mine.length} advertencias` };
    }

    const people = new Map();
    for (const w of all) people.set(w.primary_jid, (people.get(w.primary_jid) || []).concat(w));
    if (!people.size) {
      await reply('✅ Nadie tiene advertencias en este grupo. / Nobody has warnings in this group.');
      return { status: 'ok', detail: '0 advertidos' };
    }
    const lines = [...people.entries()].slice(0, 50).map(([who, list]) => `• ${displayName(who)}: ${list.length}${limit > 0 ? `/${limit}` : ''}`);
    await reply(`⚠️ *Advertencias / Warnings:*\n${lines.join('\n')}`);
    return { status: 'ok', detail: `${people.size} advertidos` };
  }

  async unwarn({ msg, args, prefix, groupJid, meta, reply }) {
    const { jid } = this.resolveTarget(msg, args);
    if (!jid) {
      await reply(`⚠️ Uso: \`${prefix}unwarn @usuario [all]\`. / Usage: \`${prefix}unwarn @user [all]\`.`);
      return { status: 'uso', detail: 'sin objetivo' };
    }
    const entry = findParticipant(meta, [jid]);
    const mine = this.warningsOf(await this.repo.getWarnings(groupJid), entry ? participantIds(entry) : [jid]);
    if (!mine.length) {
      await reply('ℹ️ Esa persona no tiene advertencias. / That person has no warnings.');
      return { status: 'ok', detail: `${userPart(jid)} sin advertencias` };
    }
    const all = args.some((a) => /^(all|todas|todo|todos)$/i.test(a));
    const toRemove = all ? mine : [mine[mine.length - 1]];
    await this.repo.removeWarnings(toRemove.map((w) => w.id));
    const left = mine.length - toRemove.length;
    await reply(`✅ Advertencia${toRemove.length > 1 ? 's' : ''} retirada${toRemove.length > 1 ? 's' : ''} a @${userPart(jid)}. Quedan ${left}. / Removed. ${left} left.`, [jid]);
    return { status: 'ok', detail: `retiradas ${toRemove.length} a ${userPart(jid)}` };
  }

  /** Si alguien baneado vuelve a entrar al grupo, se le expulsa otra vez. */
  async enforceBans(event) {
    const { groupJid, participant, action } = event;
    if (action !== 'add' || !groupJid || !participant) return;
    const sock = this.whatsapp?.sock;
    if (!sock) return;

    const rows = await this.repo.getBans(groupJid);
    if (!rows.some((r) => userPart(r.user_jid) === userPart(participant))) return;

    try {
      await sock.groupParticipantsUpdate(groupJid, [participant], 'remove');
      this.logger.log({
        source: 'sistema', chatId: groupJid, actorId: participant, command: 'auto-expulsión',
        status: 'ok', detail: 'persona baneada volvió a entrar',
      });
    } catch (err) {
      this.logger.log({
        source: 'sistema', chatId: groupJid, actorId: participant, command: 'auto-expulsión',
        status: 'error', detail: err.message,
      });
    }
  }
}

export const moderationService = new ModerationService();
