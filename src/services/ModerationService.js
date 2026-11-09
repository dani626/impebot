import { CONFIG } from '../config.js';
import { moderationRepository } from '../database/repositories/ModerationRepository.js';
import { commandLogService } from './CommandLogService.js';
import { getContextInfo, formatPhoneNumber } from '../utils/whatsappMessage.js';

export const MODERATION_COMMANDS = new Set(['borrar', 'ban', 'desban', 'bans']);

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

export class ModerationService {
  constructor({ repo = moderationRepository, config = CONFIG.moderation, logger = commandLogService } = {}) {
    this.repo = repo;
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

  /** ¿Puede esta persona moderar? Staff global o administrador del grupo. */
  authorize(meta, senderIds) {
    const entry = findParticipant(meta, senderIds);
    const ids = [...new Set([...senderIds, ...(entry ? participantIds(entry) : [])])];
    const staff = ids.some((id) => this.config.staff.includes(userPart(id)));
    const admin = isAdmin(entry);
    return { allowed: staff || (this.config.allowGroupAdmins && admin), staff, admin, ids };
  }

  /**
   * Ejecuta un comando de moderación.
   * @returns {Promise<{ status: 'ok'|'denegado'|'error'|'uso'|'ignorado', detail?: string }>}
   */
  async handle({ sock, msg, command, args = [], prefix = '!' }) {
    const groupJid = msg.key.remoteJid;
    const reply = (text, mentions) => sock.sendMessage(groupJid, { text, mentions }, { quoted: msg });

    if (!groupJid?.endsWith('@g.us')) {
      await reply('⚠️ Este comando solo funciona dentro de grupos.');
      return { status: 'ignorado', detail: 'no es un grupo' };
    }

    const meta = await sock.groupMetadata(groupJid);
    const senderIds = [msg.key.participant, msg.key.participantAlt].map(norm).filter(Boolean);
    const auth = this.authorize(meta, senderIds);
    if (!auth.allowed) {
      await reply('⛔ No tienes permiso para usar este comando.');
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
      case 'desban': return this.unban(ctx);
      case 'bans': return this.listBans(ctx);
      default: return { status: 'ignorado', detail: 'comando desconocido' };
    }
  }

  async deleteMessage({ sock, msg, prefix, groupJid, botIds, botAdmin, reply }) {
    const info = getContextInfo(msg);
    if (!info?.stanzaId) {
      await reply(`⚠️ Responde al mensaje que quieres borrar con \`${prefix}borrar\`.`);
      return { status: 'uso', detail: 'sin mensaje citado' };
    }
    const quotedFrom = norm(info.participant);
    const ownMessage = botIds.some((id) => userPart(id) === userPart(quotedFrom));
    if (!ownMessage && !botAdmin) {
      await reply('⚠️ Necesito ser administrador del grupo para borrar mensajes de otras personas.');
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

  async ban({ sock, msg, args, prefix, groupJid, meta, auth, botIds, botAdmin, reply, senderId }) {
    const { jid, num } = this.resolveTarget(msg, args);
    if (!jid) {
      await reply(`⚠️ Uso: \`${prefix}ban @usuario motivo\`, o responde a su mensaje con \`${prefix}ban motivo\`.`);
      return { status: 'uso', detail: 'sin objetivo' };
    }

    const entry = findParticipant(meta, [jid]);
    const ids = entry ? participantIds(entry) : [jid];
    const label = `@${userPart(jid)}`;
    const reason = args.filter((a) => !a.startsWith('@') && a !== num).join(' ').trim() || null;

    if (ids.some((id) => botIds.some((b) => userPart(b) === userPart(id)))) {
      await reply('⚠️ No puedo banearme a mí mismo.');
      return { status: 'denegado', detail: 'objetivo es el bot' };
    }
    if (ids.some((id) => auth.ids.some((s) => userPart(s) === userPart(id)))) {
      await reply('⚠️ No puedes banearte a ti mismo.');
      return { status: 'denegado', detail: 'objetivo es el autor' };
    }
    if (ids.some((id) => this.config.staff.includes(userPart(id))) || isAdmin(entry)) {
      await reply('⚠️ No se puede banear a un administrador ni al staff. Quítale el rango primero.');
      return { status: 'denegado', detail: 'objetivo protegido' };
    }

    if (entry) {
      if (!botAdmin) {
        await reply('⚠️ Necesito ser administrador del grupo para expulsar.');
        return { status: 'error', detail: 'el bot no es admin' };
      }
      const result = await sock.groupParticipantsUpdate(groupJid, [entry.id], 'remove');
      const failed = Array.isArray(result) && result.find((r) => String(r.status) !== '200');
      if (failed) {
        await reply(`❌ WhatsApp rechazó la expulsión (código ${failed.status}).`);
        return { status: 'error', detail: `expulsión rechazada ${failed.status}` };
      }
    }

    await this.repo.addBan(groupJid, ids, { reason, bannedBy: senderId });
    await reply(
      `🔨 ${label} fue baneado${entry ? '' : ' (no estaba en el grupo; queda bloqueado si vuelve)'}.`
      + (reason ? `\n📝 Motivo: ${reason}` : ''),
      [jid]
    );
    return { status: 'ok', detail: `baneado ${userPart(jid)}${reason ? ` (${reason})` : ''}` };
  }

  async unban({ msg, args, prefix, groupJid, reply }) {
    const { jid } = this.resolveTarget(msg, args);
    if (!jid) {
      await reply(`⚠️ Uso: \`${prefix}desban @usuario\` o \`${prefix}desban 56912345678\`.`);
      return { status: 'uso', detail: 'sin objetivo' };
    }
    const rows = await this.repo.getBans(groupJid);
    const primaries = [...new Set(rows.filter((r) => userPart(r.user_jid) === userPart(jid)).map((r) => r.primary_jid))];
    const removed = await this.repo.removeBansByPrimary(groupJid, primaries);
    if (!removed) {
      await reply('ℹ️ Esa persona no estaba baneada en este grupo.');
      return { status: 'ok', detail: `${userPart(jid)} no estaba baneado` };
    }
    await reply(`✅ @${userPart(jid)} ya no está baneado. Podrá volver a entrar.`, [jid]);
    return { status: 'ok', detail: `desbaneado ${userPart(jid)}` };
  }

  async listBans({ groupJid, reply }) {
    const rows = await this.repo.getBans(groupJid);
    const byPerson = new Map();
    for (const r of rows) if (!byPerson.has(r.primary_jid)) byPerson.set(r.primary_jid, r);
    if (!byPerson.size) {
      await reply('✅ No hay personas baneadas en este grupo.');
      return { status: 'ok', detail: '0 baneados' };
    }
    const lines = [...byPerson.values()].slice(0, 50).map((r) => {
      const who = r.primary_jid.endsWith('@s.whatsapp.net') ? formatPhoneNumber(r.primary_jid) : userPart(r.primary_jid);
      return `• ${who}${r.reason ? ` — ${r.reason}` : ''}`;
    });
    await reply(`🔨 *Baneados (${byPerson.size}):*\n${lines.join('\n')}`);
    return { status: 'ok', detail: `${byPerson.size} baneados` };
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
