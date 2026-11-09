import { luckPermsService } from './LuckPermsService.js';
import { digitsOf } from './resolver.js';
import { getContextInfo } from '../utils/whatsappMessage.js';
import { participantIds, userPart } from '../services/ModerationService.js';

/**
 * Comandos de WhatsApp para la cuenta de Minecraft:
 *  !mc                           → muestra a qué jugador está vinculado quien escribe
 *  !mcvincular <jugador> @usuario|número|respuesta   (permiso impebot.link)
 *  !mcdesvincular <jugador>      (permiso impebot.link)
 *
 * El vínculo se guarda como meta de LuckPerms (`meta.whatsapp.<número>`) y se avisa a toda la red.
 * Vincularse a uno mismo no está permitido (salvo WA_STAFF_IDS): cualquiera con impebot.link
 * podría apropiarse de la cuenta del dueño del servidor.
 */

const norm = (jid) => String(jid).replace(/:\d+@/, '@');

/** Identificadores (número y LID) de la persona señalada por mención, respuesta o número escrito. */
async function targetIds(sock, msg, args) {
  const info = getContextInfo(msg);
  const typed = args.map(digitsOf).find(Boolean);
  const jid = info?.mentionedJid?.[0] || info?.participant || (typed ? `${typed}@s.whatsapp.net` : null);
  if (!jid) return [];
  const ids = new Set([norm(jid)]);
  const groupJid = msg.key.remoteJid;
  if (groupJid?.endsWith('@g.us')) {
    const meta = await sock.groupMetadata(groupJid).catch(() => null);
    const entry = meta?.participants?.find((p) => participantIds(p).some((id) => userPart(id) === userPart(jid)));
    if (entry) for (const id of participantIds(entry)) ids.add(id);
  }
  return [...ids];
}

const shown = (ids) => ids.filter((id) => !String(id).endsWith('@lid')).map((id) => `+${digitsOf(id)}`).join(', ') || 'LID';

export async function handleAccountCommand({ sock, msg, command, args, prefix, senderIds, isStaff = false }) {
  const jid = msg.key.remoteJid;
  const reply = (text) => sock.sendMessage(jid, { text }, { quoted: msg });

  if (!luckPermsService.enabled) {
    await reply('ℹ️ La vinculación con Minecraft no está activada. / Minecraft linking is not enabled.');
    return { status: 'ignorado', detail: 'LuckPerms desactivado' };
  }

  if (command === 'mc') {
    const player = await luckPermsService.findPlayer('whatsapp', senderIds);
    if (!player) {
      await reply('🎮 Tu WhatsApp no está vinculado a ninguna cuenta de Minecraft. Pide a un miembro del staff que lo vincule. / Your WhatsApp is not linked to a Minecraft account. Ask a staff member to link it.');
      return { status: 'ok', detail: 'sin vincular' };
    }
    const { groups } = await luckPermsService.loadUser(player.uuid);
    await reply(`🎮 *${player.username}*\n🏷️ Rango / Rank: ${player.primaryGroup}${groups.length > 1 ? `\n📚 Grupos / Groups: ${groups.join(', ')}` : ''}`);
    return { status: 'ok', detail: player.username };
  }

  const name = args.find((a) => /^[A-Za-z0-9_]{3,16}$/.test(a) && !digitsOf(a)) || args.find((a) => /^[0-9a-f-]{36}$/i.test(a));
  const usage = command === 'mcvincular'
    ? `⚠️ Uso: \`${prefix}mcvincular Jugador @usuario\` (o responde a su mensaje, o escribe su número). / Usage: \`${prefix}mclink Player @user\`.`
    : `⚠️ Uso: \`${prefix}mcdesvincular Jugador\`. / Usage: \`${prefix}mcunlink Player\`.`;
  if (!name) {
    await reply(usage);
    return { status: 'uso', detail: 'sin jugador' };
  }
  const player = await luckPermsService.findPlayerByName(name);
  if (!player) {
    await reply(`❌ No existe el jugador *${name}* en LuckPerms (debe haber entrado al servidor al menos una vez). / Player not found.`);
    return { status: 'error', detail: `jugador ${name} no existe` };
  }

  if (command === 'mcdesvincular') {
    const removed = await luckPermsService.unlink(player.uuid, 'whatsapp');
    await reply(removed
      ? `✅ *${player.username}* ya no está vinculado a WhatsApp. / unlinked.`
      : `ℹ️ *${player.username}* no tenía WhatsApp vinculado. / was not linked.`);
    return { status: 'ok', detail: `desvinculado ${player.username} (${removed})` };
  }

  const ids = await targetIds(sock, msg, args.filter((a) => a !== name));
  if (!ids.length) {
    await reply(usage);
    return { status: 'uso', detail: 'sin persona' };
  }
  // Solo WA_STAFF_IDS puede vincularse a sí mismo (el resto, a través de otra persona del staff).
  if (!isStaff && ids.some((id) => senderIds.some((s) => userPart(s) === userPart(id)))) {
    await reply('⚠️ No puedes vincular tu propio WhatsApp. Pídeselo a otro miembro del staff. / You cannot link yourself.');
    return { status: 'denegado', detail: 'autovinculación' };
  }
  await luckPermsService.link(player.uuid, 'whatsapp', ids);
  await reply(`✅ WhatsApp ${shown(ids)} vinculado a *${player.username}* (${player.primaryGroup}). / linked.`);
  return { status: 'ok', detail: `vinculado ${player.username}` };
}
