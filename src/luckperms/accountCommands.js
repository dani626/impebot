import { luckPermsService } from './LuckPermsService.js';
import { digitsOf } from './resolver.js';
import { getContextInfo } from '../utils/whatsappMessage.js';
import { participantIds, userPart } from '../services/ModerationService.js';

/**
 * Cuenta de Minecraft en WhatsApp. El vínculo se guarda como meta de LuckPerms
 * (`meta.whatsapp.<número>`) y se avisa a toda la red.
 *
 *  !vincular / !verificar / !link / !verify CODIGO  → el propio jugador, con el código de la web
 *                                                     (TicketService → linkVerifiedAccount)
 *  !mc                                              → a qué jugador estás vinculado
 *  !mcvincular Jugador @usuario|número|respuesta    → admin: fuerza el vínculo (impebot.link.admin)
 *  !mcdesvincular Jugador | @usuario | número       → admin: quita el vínculo (impebot.link.admin)
 *
 * Un admin no puede forzar su propio vínculo (salvo WA_STAFF_IDS): para eso está !vincular,
 * que demuestra con la web que la cuenta es suya.
 */

const norm = (jid) => String(jid).replace(/:\d+@/, '@');

/**
 * Vincula al jugador verificado por la web (su nick de Minecraft) con quien envió el código.
 * @returns {Promise<{ enabled: boolean, player: object|null, linked: boolean }>}
 */
export async function linkVerifiedAccount({ ids, username, minecraftUuid }, lp = luckPermsService) {
  if (!lp.enabled) return { enabled: false, player: null, linked: false };
  const player = (minecraftUuid && await lp.findPlayerByName(minecraftUuid)) || await lp.findPlayerByName(username);
  if (!player) return { enabled: true, player: null, linked: false };
  await lp.link(player.uuid, 'whatsapp', ids);
  return { enabled: true, player, linked: true };
}

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
const playerArg = (args) => args.find((a) => /^[A-Za-z0-9_]{3,16}$/.test(a) && !digitsOf(a)) || args.find((a) => /^[0-9a-f-]{36}$/i.test(a));

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
      await reply(`🎮 Tu WhatsApp no está vinculado a ninguna cuenta de Minecraft. Escribe /whatsapp link en el juego y envíame \`${prefix}vincular CODIGO\` por privado. / Not linked: send \`${prefix}link CODE\` in private.`);
      return { status: 'ok', detail: 'sin vincular' };
    }
    const { groups } = await luckPermsService.loadUser(player.uuid);
    await reply(`🎮 *${player.username}*\n🏷️ Rango / Rank: ${player.primaryGroup}${groups.length > 1 ? `\n📚 Grupos / Groups: ${groups.join(', ')}` : ''}`);
    return { status: 'ok', detail: player.username };
  }

  const name = playerArg(args);

  if (command === 'mcdesvincular') {
    let player = name ? await luckPermsService.findPlayerByName(name) : null;
    if (!name) {
      const ids = await targetIds(sock, msg, args);
      player = ids.length ? await luckPermsService.findPlayer('whatsapp', ids) : null;
      if (!ids.length) {
        await reply(`⚠️ Uso: \`${prefix}mcdesvincular Jugador\` o \`${prefix}mcdesvincular @usuario\`. / Usage: \`${prefix}mcunlink Player|@user\`.`);
        return { status: 'uso', detail: 'sin objetivo' };
      }
      if (!player) {
        await reply('ℹ️ Esa persona no está vinculada a ninguna cuenta. / That person is not linked.');
        return { status: 'ok', detail: 'no vinculado' };
      }
    } else if (!player) {
      await reply(`❌ No existe el jugador *${name}* en LuckPerms. / Player not found.`);
      return { status: 'error', detail: `jugador ${name} no existe` };
    }
    const removed = await luckPermsService.unlink(player.uuid, 'whatsapp');
    await reply(removed
      ? `✅ *${player.username}* ya no está vinculado a WhatsApp. / unlinked.`
      : `ℹ️ *${player.username}* no tenía WhatsApp vinculado. / was not linked.`);
    return { status: 'ok', detail: `desvinculado ${player.username} (${removed})` };
  }

  // mcvincular: forzar
  const usage = `⚠️ Uso: \`${prefix}mcvincular Jugador @usuario\` (o responde a su mensaje, o escribe su número). / Usage: \`${prefix}forcelink Player @user\`.`;
  if (!name) {
    await reply(usage);
    return { status: 'uso', detail: 'sin jugador' };
  }
  const player = await luckPermsService.findPlayerByName(name);
  if (!player) {
    await reply(`❌ No existe el jugador *${name}* en LuckPerms (debe haber entrado al servidor al menos una vez). / Player not found.`);
    return { status: 'error', detail: `jugador ${name} no existe` };
  }
  const ids = await targetIds(sock, msg, args.filter((a) => a !== name));
  if (!ids.length) {
    await reply(usage);
    return { status: 'uso', detail: 'sin persona' };
  }
  if (!isStaff && ids.some((id) => senderIds.some((s) => userPart(s) === userPart(id)))) {
    await reply(`⚠️ No puedes forzar tu propio vínculo. Usa \`${prefix}vincular CODIGO\` con el código de la web. / Use \`${prefix}link CODE\` instead.`);
    return { status: 'denegado', detail: 'autovinculación' };
  }
  const previous = await luckPermsService.findPlayer('whatsapp', ids);
  await luckPermsService.link(player.uuid, 'whatsapp', ids);
  const moved = previous && previous.uuid !== player.uuid ? ` (antes: ${previous.username})` : '';
  await reply(`✅ WhatsApp ${shown(ids)} vinculado a *${player.username}* (${player.primaryGroup})${moved}. / linked.`);
  return { status: 'ok', detail: `vinculado ${player.username}${moved}` };
}
