import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { CONFIG } from '../config.js';
import { discordService, NO_MENTIONS } from '../services/DiscordService.js';
import { channelMappingRepository } from '../database/repositories/ChannelMappingRepository.js';
import { mirrorRepository, aliasRepository, ALL_CHATS } from '../database/repositories/MirrorRepository.js';
import { luckPermsService } from '../luckperms/LuckPermsService.js';
import { decide, PERMISSIONS } from '../luckperms/permissions.js';

export function mirrorCommands() {
  const chat = (o) => o.setName('chat').setDescription('Alias, JID del chat de WhatsApp o "todos". Por defecto: el chat de este canal').setMaxLength(128).setAutocomplete(true);
  const canal = (o) => o.setName('canal').setDescription('Alias, ID o mención del canal destino (puede ser de otro servidor)').setRequired(true).setMaxLength(100).setAutocomplete(true);
  return [
    new SlashCommandBuilder().setName('espejo').setDescription('Copiar los mensajes de WhatsApp a otro canal o servidor')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((s) => s.setName('agregar').setDescription('Añadir un canal espejo').addStringOption(canal).addStringOption(chat))
      .addSubcommand((s) => s.setName('quitar').setDescription('Quitar un canal espejo').addStringOption(canal).addStringOption(chat))
      .addSubcommand((s) => s.setName('alias').setDescription('Crear un alias para un ID de canal o un JID')
        .addStringOption((o) => o.setName('nombre').setDescription('Alias (letras, números, - y _)').setRequired(true).setMinLength(2).setMaxLength(32))
        .addStringOption((o) => o.setName('id').setDescription('ID/mención del canal, o JID del chat').setRequired(true).setMaxLength(128)))
      .addSubcommand((s) => s.setName('alias-quitar').setDescription('Borrar un alias')
        .addStringOption((o) => o.setName('nombre').setDescription('Alias a borrar').setRequired(true).setMaxLength(32).setAutocomplete(true)))
      .addSubcommand((s) => s.setName('listar').setDescription('Ver los espejos configurados')),
  ].map((c) => c.toJSON());
}

/** Acepta "123", "<#123>" o un enlace https://discord.com/channels/guild/123. */
export function parseChannelId(input) {
  const match = String(input).match(/(\d{15,25})(?!.*\d{15,25})/);
  return match ? match[1] : null;
}

const ALIAS_RE = /^[\p{L}\p{N}_-]{2,32}$/u;

export class MirrorService {
  constructor() {
    this.onInteraction = (interaction) => void this.handleInteraction(interaction)
      .catch((err) => console.error('[MirrorService] Interacción:', err.message));
    this.onReady = () => void discordService.registerGuildCommands(mirrorCommands())
      .catch((err) => console.error('[MirrorService] Registro de comandos:', err.message));
  }

  start() {
    discordService.on('interaction', this.onInteraction);
    discordService.on('ready', this.onReady);
  }

  stop() {
    discordService.off('interaction', this.onInteraction);
    discordService.off('ready', this.onReady);
  }

  /**
   * Copia un mensaje (ya transformado a formato Discord) a todos los espejos del chat.
   * Nunca lanza: un espejo caído no debe afectar al relay principal.
   */
  async forwardMessage(jid, chatName, payload) {
    let mirrors = [];
    try {
      mirrors = await mirrorRepository.getForJid(jid);
    } catch (err) {
      console.error('[MirrorService] No se pudieron leer los espejos:', err.message);
      return;
    }
    const label = chatName ? `${payload.username} · ${chatName}` : payload.username;
    await Promise.all(mirrors.map((m) => this.deliver(m, label, payload)));
  }

  /** Igual que forwardMessage pero para embeds de sistema (entradas/salidas de grupo). */
  async forwardEmbed(jid, embed, { name, avatarUrl } = {}) {
    let mirrors = [];
    try {
      mirrors = await mirrorRepository.getForJid(jid);
    } catch (err) {
      console.error('[MirrorService] No se pudieron leer los espejos:', err.message);
      return;
    }
    const username = (name || CONFIG.botName || 'WhatsApp Relay').slice(0, 80);
    await Promise.all(mirrors.map((m) => this.deliver(m, username, { avatarURL: avatarUrl, embeds: [embed] })));
  }

  async deliver(mirror, label, { content, avatarURL, files, embeds }) {
    const username = label.slice(0, 80);
    const hasEmbeds = embeds?.length > 0;
    if (mirror.webhook_url) {
      try {
        await discordService.sendViaWebhook(mirror.webhook_url, {
          content: content || undefined, username, avatarURL: avatarURL || undefined, files,
          embeds: hasEmbeds ? embeds : undefined, allowedMentions: NO_MENTIONS,
        });
        return;
      } catch (err) {
        console.warn(`[MirrorService] Webhook del espejo ${mirror.id} falló, usando el bot: ${err.message}`);
      }
    }
    try {
      await discordService.sendMessage(mirror.discord_channel_id, {
        content: content ? `**[${label}]:** ${content}` : `**[${label}]**`,
        files, embeds: hasEmbeds ? embeds : undefined, allowedMentions: NO_MENTIONS,
      });
    } catch (err) {
      console.error(`[MirrorService] No se pudo enviar al espejo ${mirror.discord_channel_id}:`, err.message);
    }
  }

  async handleAutocomplete(interaction) {
    if (CONFIG.discord.guildId && interaction.guildId !== CONFIG.discord.guildId) return;
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.respond([]);
    const focused = interaction.options.getFocused().trim();
    const rows = await aliasRepository.search(focused);
    await interaction.respond(rows.map((r) => ({ name: `${r.alias} → ${r.target}`.slice(0, 100), value: r.alias })));
  }

  /** Alias (sin distinguir mayúsculas) → destino; si no existe, se devuelve el texto tal cual. */
  async expand(value) {
    return (await aliasRepository.resolve(value)) ?? value;
  }

  async handleInteraction(interaction) {
    if (interaction.isAutocomplete?.() && interaction.commandName === 'espejo') {
      return this.handleAutocomplete(interaction);
    }
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'espejo') return;
    if (CONFIG.discord.guildId && interaction.guildId !== CONFIG.discord.guildId) return;
    await interaction.deferReply({ flags: 64 });

    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
      await interaction.editReply('Necesitas el permiso Gestionar servidor.');
      return;
    }
    // Con LuckPerms disponible, además hace falta impebot.relay.mirror.
    const lp = await luckPermsService.check('discord', [interaction.user.id], PERMISSIONS.mirror.node);
    if (!decide(PERMISSIONS.mirror, lp, { fallback: true })) {
      await interaction.editReply(`⛔ Necesitas el permiso ${PERMISSIONS.mirror.node}.`);
      return;
    }

    const sub = interaction.options.getSubcommand();
    if (sub === 'alias') {
      const name = interaction.options.getString('nombre', true).trim();
      const raw = interaction.options.getString('id', true).trim();
      if (!ALIAS_RE.test(name)) {
        await interaction.editReply('El alias solo puede tener letras, números, - y _ (2 a 32 caracteres).');
        return;
      }
      const target = /^\d{15,25}$|^<#\d+>$|channels\//.test(raw) ? parseChannelId(raw) : raw;
      if (!target) {
        await interaction.editReply('No reconocí ese ID.');
        return;
      }
      await aliasRepository.set(name, target, interaction.user.id);
      await interaction.editReply(`✅ Alias \`${name}\` → \`${target}\``);
      return;
    }
    if (sub === 'alias-quitar') {
      const removed = await aliasRepository.remove(interaction.options.getString('nombre', true).trim());
      await interaction.editReply(removed ? 'Alias eliminado.' : 'Ese alias no existe.');
      return;
    }

    if (sub === 'listar') {
      const all = await mirrorRepository.getAll();
      const aliases = await aliasRepository.getAll();
      const aliasLines = aliases.map((a) => `• \`${a.alias}\` → \`${a.target}\``);
      await interaction.editReply(((all.length
        ? all.map((m) => `• ${m.whatsapp_jid === ALL_CHATS ? '**todos los chats**' : `\`${m.whatsapp_jid}\``} → <#${m.discord_channel_id}> (\`${m.discord_channel_id}\`)`).join('\n')
        : 'No hay espejos configurados.') + (aliasLines.length ? `\n\n**Alias**\n${aliasLines.join('\n')}` : '')).slice(0, 1900));
      return;
    }

    const channelId = parseChannelId(await this.expand(interaction.options.getString('canal', true).trim()));
    if (!channelId) {
      await interaction.editReply('No reconocí ese canal. Usa su ID numérico.');
      return;
    }
    const jid = await this.resolveChat(interaction);
    if (!jid) {
      await interaction.editReply('Indica `chat` (JID o "todos"), o ejecuta el comando dentro del canal de un chat retransmitido.');
      return;
    }

    if (sub === 'quitar') {
      const removed = await mirrorRepository.remove(jid, channelId);
      await interaction.editReply(removed ? 'Espejo eliminado.' : 'Ese espejo no existía.');
      return;
    }

    // agregar
    const channel = await discordService.client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || !channel.guild) {
      await interaction.editReply('No encuentro ese canal de texto. ¿El bot está en ese servidor?');
      return;
    }
    const me = channel.guild.members.me;
    const perms = channel.permissionsFor(me);
    if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
      await interaction.editReply('El bot no puede ver o escribir en ese canal.');
      return;
    }
    let webhookUrl = null;
    if (perms.has(PermissionFlagsBits.ManageWebhooks) && typeof channel.createWebhook === 'function') {
      try {
        webhookUrl = (await channel.createWebhook({ name: 'ImpeBot Espejo', reason: 'Espejo WhatsApp' })).url;
      } catch (err) {
        console.warn('[MirrorService] No se pudo crear webhook:', err.message);
      }
    }
    await mirrorRepository.add(jid, channelId, webhookUrl, interaction.user.id);
    await interaction.editReply(
      `✅ ${jid === ALL_CHATS ? 'Todos los chats' : `\`${jid}\``} → <#${channelId}> en **${channel.guild.name}**.`
      + (webhookUrl ? '' : '\nSin permiso de webhooks: los mensajes saldrán con el nombre del bot.'));
  }

  async resolveChat(interaction) {
    const raw = interaction.options.getString('chat')?.trim();
    if (raw) {
      const target = await this.expand(raw);
      return /^(todos|\*)$/i.test(target) ? ALL_CHATS : target;
    }
    const mapping = await channelMappingRepository.getByDiscordChannelId(interaction.channelId);
    return mapping?.whatsapp_jid || null;
  }
}

export const mirrorService = new MirrorService();
