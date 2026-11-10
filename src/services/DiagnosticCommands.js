import { ApplicationCommandPermissionType, ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { luckPermsService } from '../luckperms/LuckPermsService.js';
import { decide, PERMISSIONS } from '../luckperms/permissions.js';
import { SLASH_ALIASES } from '../utils/slashAliases.js';
import { isCommandGuild } from '../utils/guilds.js';

/**
 * /diagnostico [usuario] [canal]: explica por qué alguien no ve o no puede usar los comandos del bot.
 * Revisa, para esa persona y ese canal:
 *  1. Los permisos de Discord del canal (ver canal, usar comandos de aplicación, conectar y hablar...).
 *  2. Las restricciones de Ajustes del servidor → Integraciones → IMPEBOT (generales y de cada comando).
 *  3. Su cuenta vinculada y sus permisos de LuckPerms.
 * Lo usa el staff: impebot.diagnose, o Gestionar servidor si LuckPerms no está disponible.
 */
export function diagnosticCommands() {
  return [
    new SlashCommandBuilder().setName('diagnostico').setDescription('Por qué alguien no ve o no puede usar los comandos del bot (staff)')
      .addUserOption((o) => o.setName('usuario').setDescription('Por defecto, tú'))
      .addChannelOption((o) => o.setName('canal').setDescription('Por defecto, este canal')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildStageVoice, ChannelType.GuildAnnouncement)),
  ].map((c) => c.toJSON());
}

const ALIAS_NAMES = new Set(Object.keys(SLASH_ALIASES));
const { Role, User, Channel } = ApplicationCommandPermissionType;

/** ID que Discord usa para "todos los canales" en los permisos de comandos: el del servidor menos 1. */
export const allChannelsId = (guildId) => (BigInt(guildId) - 1n).toString();

/**
 * Decisión por persona en una lista de permisos de comando (de la app o de un comando).
 * Usuario concreto > sus roles (basta uno permitido) > @everyone. null = la lista no dice nada.
 */
export function memberRule(list, { guildId, userId, roleIds }) {
  const user = list.find((p) => p.type === User && p.id === userId);
  if (user) return { allowed: user.permission, why: 'el usuario' };
  const roles = list.filter((p) => p.type === Role && p.id !== guildId && roleIds.includes(p.id));
  if (roles.length) {
    const allowed = roles.some((p) => p.permission);
    const ids = roles.filter((p) => p.permission === allowed).map((p) => `<@&${p.id}>`);
    return { allowed, why: `el rol ${ids.join(', ')}` };
  }
  const everyone = list.find((p) => p.type === Role && p.id === guildId);
  if (everyone) return { allowed: everyone.permission, why: '@everyone' };
  return null;
}

/** Decisión por canal: el canal concreto > "todos los canales". null = la lista no dice nada. */
export function channelRule(list, { guildId, channelId }) {
  const channel = list.find((p) => p.type === Channel && p.id === channelId);
  if (channel) return { allowed: channel.permission, why: `el canal <#${channelId}>` };
  const all = list.find((p) => p.type === Channel && p.id === allChannelsId(guildId));
  if (all) return { allowed: all.permission, why: 'todos los canales' };
  return null;
}

/**
 * ¿Puede usar este comando según Integraciones? Lo de cada comando manda sobre lo general del bot,
 * y por separado para persona y canal (las dos cosas deben permitirlo).
 * @returns {{ allowed: boolean, reasons: string[] }}
 */
export function commandAccess({ appList = [], commandList = [], ...who }) {
  const reasons = [];
  let allowed = true;
  const check = (rule, level, kind) => {
    if (rule && !rule.allowed) {
      allowed = false;
      reasons.push(`${kind} desactivado por ${rule.why} (${level})`);
    }
  };
  const byCommand = memberRule(commandList, who);
  check(byCommand ?? memberRule(appList, who), byCommand ? 'en este comando' : 'en todo el bot', 'usuario/rol');
  const channelByCommand = channelRule(commandList, who);
  check(channelByCommand ?? channelRule(appList, who), channelByCommand ? 'en este comando' : 'en todo el bot', 'canal');
  return { allowed, reasons };
}

const yes = (ok) => (ok ? '✅' : '❌');

export class DiagnosticCommands {
  constructor({ discord, lp = luckPermsService }) {
    this.discord = discord;
    this.lp = lp;
    this.onInteraction = (interaction) => void this.handleInteraction(interaction)
      .catch((err) => console.error('[Diagnóstico] Interacción:', err.message));
    this.onReady = () => void this.discord.registerGuildCommands(diagnosticCommands(), { extra: true })
      .catch((err) => console.error('[Diagnóstico] Registro de comandos:', err.message));
  }

  start() {
    this.discord.on('interaction', this.onInteraction);
    this.discord.on('ready', this.onReady);
  }

  stop() {
    this.discord.off('interaction', this.onInteraction);
    this.discord.off('ready', this.onReady);
  }

  async handleInteraction(interaction) {
    if (!interaction.isChatInputCommand?.() || interaction.commandName !== 'diagnostico') return;
    if (!interaction.guild || !isCommandGuild(interaction.guildId, { extra: true })) return;
    await interaction.deferReply({ flags: 64 });

    const manageGuild = Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
    const own = await this.lp.check('discord', [interaction.user.id], PERMISSIONS.diagnose.node);
    if (!decide(PERMISSIONS.diagnose, own, { fallback: manageGuild })) {
      await interaction.editReply(`⛔ Necesitas el permiso ${PERMISSIONS.diagnose.node}.`);
      return;
    }

    try {
      const user = interaction.options.getUser('usuario') || interaction.user;
      const channel = interaction.options.getChannel('canal') || interaction.channel;
      await interaction.editReply((await this.report(interaction.guild, user, channel)).slice(0, 2000));
    } catch (err) {
      console.error('[Diagnóstico] Error:', err.message);
      await interaction.editReply(`❌ No se pudo completar el diagnóstico: ${err.message}`).catch(() => {});
    }
  }

  async report(guild, user, channel) {
    const lines = [`🩺 **Diagnóstico de ${user} en ${channel}**`];
    const member = await guild.members.fetch(user.id).catch(() => null);
    if (!member) return `${lines[0]}\n❌ No es miembro de este servidor.`;

    // 1. Permisos de Discord en el canal
    const perms = channel.permissionsFor(member);
    const isVoice = channel.isVoiceBased?.();
    const needs = [
      ['Ver el canal', PermissionFlagsBits.ViewChannel],
      ['Enviar mensajes', PermissionFlagsBits.SendMessages],
      ['Usar comandos de aplicación', PermissionFlagsBits.UseApplicationCommands],
      ...(isVoice ? [['Conectar', PermissionFlagsBits.Connect], ['Hablar', PermissionFlagsBits.Speak]] : []),
    ];
    const missing = needs.filter(([, flag]) => !perms?.has(flag));
    lines.push('', '**1. Permisos de Discord en el canal**');
    lines.push(needs.map(([label, flag]) => `${yes(perms?.has(flag))} ${label}`).join(' · '));
    if (perms?.has(PermissionFlagsBits.Administrator)) lines.push('ℹ️ Es administrador: Discord le da todos los permisos.');

    const me = guild.members.me;
    if (isVoice && me) {
      const botPerms = channel.permissionsFor(me);
      const botNeeds = [['Ver', PermissionFlagsBits.ViewChannel], ['Conectar', PermissionFlagsBits.Connect], ['Hablar', PermissionFlagsBits.Speak]];
      lines.push(`Bot en el canal: ${botNeeds.map(([label, flag]) => `${yes(botPerms?.has(flag))} ${label}`).join(' · ')}`);
    }

    // 2. Integraciones → IMPEBOT
    lines.push('', '**2. Integraciones → IMPEBOT**');
    const commands = (await guild.commands.fetch()).filter((c) => !ALIAS_NAMES.has(c.name));
    let overrides = new Map();
    try {
      overrides = await guild.commands.permissions.fetch({});
    } catch (err) {
      lines.push(`⚠️ No se pudieron leer las restricciones (${err.message}).`);
    }
    const appId = guild.client.application?.id || guild.client.user.id;
    const who = { guildId: guild.id, userId: member.id, roleIds: [...member.roles.cache.keys()], channelId: channel.id };
    const appList = overrides.get?.(appId) || [];
    const blocked = [];
    for (const command of commands.values()) {
      const access = commandAccess({ appList, commandList: overrides.get?.(command.id) || [], ...who });
      const required = command.defaultMemberPermissions;
      if (required && !member.permissions.has(required)) {
        access.allowed = false;
        access.reasons.push(`pide permisos de Discord que no tiene (${required.toArray().join(', ')})`);
      }
      if (!access.allowed) blocked.push(`❌ /${command.name}: ${access.reasons.join('; ')}`);
    }
    const general = commandAccess({ appList, ...who });
    if (!general.allowed) lines.push(`❌ Todo el bot: ${general.reasons.join('; ')}`);
    if (blocked.length) lines.push(...blocked.slice(0, 15), ...(blocked.length > 15 ? [`… y ${blocked.length - 15} más`] : []));
    else lines.push(`✅ Puede ver los ${commands.size} comandos del bot aquí.`);

    // 3. LuckPerms
    lines.push('', '**3. Cuenta vinculada y LuckPerms**');
    const nodes = [
      ['/play', PERMISSIONS.musicPlay], ['/skip, /stop, /pause, /volumen', PERMISSIONS.musicControl],
      ['/cola', PERMISSIONS.musicQueue], ['/minecraft info', PERMISSIONS.account],
    ];
    const results = await Promise.all(nodes.map(([, perm]) => this.lp.check('discord', [member.id], perm.node)));
    const first = results[0];
    if (!first.available) lines.push('⚠️ LuckPerms no disponible: se usan las reglas por defecto.');
    else if (!first.player) lines.push('❌ No tiene la cuenta de Discord vinculada a Minecraft (`/discord link` en el juego).');
    else lines.push(`🎮 Vinculado a **${first.player.username}** (${first.player.primaryGroup}).`);
    lines.push(nodes.map(([label, perm], i) => `${yes(decide(perm, results[i]))} ${label}`).join(' · '));

    // Conclusión
    const problems = [];
    if (missing.length) problems.push(`le faltan permisos de Discord en el canal (${missing.map(([label]) => label).join(', ')})`);
    if (!general.allowed || blocked.length) problems.push('hay restricciones en Integraciones → IMPEBOT');
    lines.push('', problems.length
      ? `**Causa probable:** ${problems.join(' y ')}.`
      : '**Discord y LuckPerms lo permiten.** Si aun así no le aparecen los comandos, que cierre y abra Discord o borre su caché (en el celular, Ajustes → Aplicaciones → Discord → Almacenamiento → Borrar caché).');
    return lines.join('\n');
  }
}
