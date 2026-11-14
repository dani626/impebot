import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { CONFIG } from '../config.js';
import { discordService } from '../services/DiscordService.js';
import { channelMappingRepository } from '../database/repositories/ChannelMappingRepository.js';
import { luckPermsService } from '../luckperms/LuckPermsService.js';
import { decide, PERMISSIONS } from '../luckperms/permissions.js';
import { isValidAlias } from './relayRouting.js';

// Un espejo es un vínculo de channel_mappings con direction = 'wa_to_dc': el relay le copia
// los mensajes del chat y nunca lee lo que se escribe en ese canal.

export function mirrorCommands() {
  const chat = (o) => o.setName('chat').setDescription('Alias o JID del chat de WhatsApp. Por defecto: el chat de este canal').setMaxLength(128).setAutocomplete(true);
  const canal = (o) => o.setName('canal').setDescription('ID, mención o alias del canal destino (puede ser de otro servidor)').setRequired(true).setMaxLength(100).setAutocomplete(true);
  return [
    new SlashCommandBuilder().setName('espejo').setDescription('Copiar los mensajes de WhatsApp a otro canal o servidor')
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((s) => s.setName('agregar').setDescription('Añadir un canal espejo').addStringOption(canal).addStringOption(chat)
        .addStringOption((o) => o.setName('alias').setDescription('Alias para este espejo (letras, números, - y _)').setMinLength(2).setMaxLength(32)))
      .addSubcommand((s) => s.setName('quitar').setDescription('Quitar un canal espejo').addStringOption(canal).addStringOption(chat))
      .addSubcommand((s) => s.setName('alias').setDescription('Poner un alias a un vínculo')
        .addStringOption((o) => o.setName('nombre').setDescription('Alias (letras, números, - y _)').setRequired(true).setMinLength(2).setMaxLength(32))
        .addStringOption((o) => o.setName('id').setDescription('ID/mención del canal, JID del chat o número del vínculo (#12)').setRequired(true).setMaxLength(128)))
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

const isDuplicate = (err) => err?.code === 'ER_DUP_ENTRY' || err?.errno === 1062;
const describe = (m) => `\`${m.whatsapp_jid}\` → <#${m.discord_channel_id}>`;

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

  async handleAutocomplete(interaction) {
    if (CONFIG.discord.guildId && interaction.guildId !== CONFIG.discord.guildId) return;
    if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) return interaction.respond([]);
    const rows = await channelMappingRepository.searchAliases(interaction.options.getFocused().trim());
    await interaction.respond(rows.map((r) => ({
      name: `${r.alias} → ${r.whatsapp_jid} · canal ${r.discord_channel_id}`.slice(0, 100), value: r.alias,
    })));
  }

  /** Canal de destino: el de un vínculo con ese alias o, si no, el ID/mención/enlace escrito. */
  async resolveChannelId(input) {
    const aliased = await channelMappingRepository.getByAlias(input);
    return aliased ? aliased.discord_channel_id : parseChannelId(input);
  }

  /**
   * Chat de WhatsApp: el del vínculo con ese alias, el JID escrito o, sin opción, el del canal actual.
   * @returns {Promise<string|null>}
   */
  async resolveChat(interaction) {
    const raw = interaction.options.getString('chat')?.trim();
    if (!raw) {
      const mapping = await channelMappingRepository.getByDiscordChannelId(interaction.channelId);
      return mapping?.whatsapp_jid || null;
    }
    const aliased = await channelMappingRepository.getByAlias(raw);
    if (aliased) return aliased.whatsapp_jid;
    return raw.includes('@') ? raw : null;
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
    const reply = await ({
      alias: () => this.setAlias(interaction),
      'alias-quitar': () => this.removeAlias(interaction),
      listar: () => this.list(),
      quitar: () => this.remove(interaction),
      agregar: () => this.add(interaction),
    })[sub]?.();
    if (reply) await interaction.editReply(reply.slice(0, 1900));
  }

  async setAlias(interaction) {
    const name = interaction.options.getString('nombre', true).trim();
    const raw = interaction.options.getString('id', true).trim();
    if (!isValidAlias(name)) return 'El alias solo puede tener letras, números, - y _ (2 a 32 caracteres) y no puede ser solo números.';

    let mapping = null;
    if (/^#\d{1,9}$/.test(raw)) {
      mapping = await channelMappingRepository.findByRef(raw);
    } else if (/^\d{15,25}$|^<#\d+>$|channels\//.test(raw)) {
      const links = await channelMappingRepository.getAllForChannel(parseChannelId(raw));
      if (links.length > 1) {
        return `Ese canal tiene varios vínculos. Indica el número del que quieres:\n${links.map((m) => `• \`#${m.id}\` ${describe(m)}`).join('\n')}`;
      }
      mapping = links[0] || null;
    } else {
      mapping = await channelMappingRepository.getByWhatsAppJid(raw);
    }
    if (!mapping) return 'No hay ningún vínculo con ese canal, chat o número.';

    try {
      await channelMappingRepository.setAlias(mapping.id, name);
    } catch (err) {
      if (isDuplicate(err)) return `El alias \`${name}\` ya lo usa otro vínculo.`;
      throw err;
    }
    return `✅ Alias \`${name}\` → vínculo \`#${mapping.id}\` (${describe(mapping)})`;
  }

  async removeAlias(interaction) {
    const mapping = await channelMappingRepository.getByAlias(interaction.options.getString('nombre', true).trim());
    if (!mapping) return 'Ese alias no existe.';
    await channelMappingRepository.setAlias(mapping.id, null);
    return 'Alias eliminado.';
  }

  async list() {
    const mirrors = await channelMappingRepository.getMirrors();
    const aliased = await channelMappingRepository.searchAliases('', 100);
    const line = (m) => `• \`#${m.id}\` ${describe(m)} (\`${m.discord_channel_id}\`)${m.alias ? ` · alias \`${m.alias}\`` : ''}${m.enabled ? '' : ' · ⏸️ pausado'}`;
    const aliasLines = aliased.map((m) => `• \`${m.alias}\` → \`#${m.id}\` ${describe(m)}`);
    return (mirrors.length ? mirrors.map(line).join('\n') : 'No hay espejos configurados.')
      + (aliasLines.length ? `\n\n**Alias**\n${aliasLines.join('\n')}` : '');
  }

  async remove(interaction) {
    const canal = interaction.options.getString('canal', true).trim();
    // El alias de un espejo lo identifica por completo: no hace falta indicar el chat.
    const aliased = await channelMappingRepository.getByAlias(canal);
    let mapping = aliased?.direction === 'wa_to_dc' && !interaction.options.getString('chat') ? aliased : null;
    if (!mapping) {
      const channelId = aliased ? aliased.discord_channel_id : parseChannelId(canal);
      if (!channelId) return 'No reconocí ese canal. Usa su ID numérico o el alias del espejo.';
      const jid = await this.resolveChat(interaction);
      if (!jid) return 'Indica `chat` (alias o JID), o ejecuta el comando dentro del canal de un chat retransmitido.';
      mapping = await channelMappingRepository.getByPair(jid, channelId);
    }
    if (!mapping) return 'Ese espejo no existía.';
    if (mapping.direction !== 'wa_to_dc') return 'Ese es el canal principal del chat, no un espejo: no se quita desde aquí.';
    const removed = await channelMappingRepository.removeMirror(mapping.id);
    return removed ? `Espejo eliminado: ${describe(mapping)}.` : 'Ese espejo no existía.';
  }

  async add(interaction) {
    const alias = interaction.options.getString('alias')?.trim() || null;
    if (alias && !isValidAlias(alias)) return 'El alias solo puede tener letras, números, - y _ (2 a 32 caracteres) y no puede ser solo números.';
    if (/^(todos|\*)$/i.test(interaction.options.getString('chat')?.trim() || '')) {
      return 'Ya no se puede copiar "todos" los chats a un canal: añade un espejo por cada chat.';
    }
    const channelId = await this.resolveChannelId(interaction.options.getString('canal', true).trim());
    if (!channelId) return 'No reconocí ese canal. Usa su ID numérico.';
    const jid = await this.resolveChat(interaction);
    if (!jid) return 'Indica `chat` (alias o JID), o ejecuta el comando dentro del canal de un chat retransmitido.';

    const existing = await channelMappingRepository.getByPair(jid, channelId);
    if (existing) {
      return existing.direction === 'wa_to_dc'
        ? `Ese espejo ya existe: \`#${existing.id}\` ${describe(existing)}.`
        : 'Ese canal ya es el canal principal de ese chat.';
    }

    const channel = await discordService.client.channels.fetch(channelId).catch(() => null);
    if (!channel || !channel.isTextBased() || !channel.guild) return 'No encuentro ese canal de texto. ¿El bot está en ese servidor?';
    const perms = channel.permissionsFor(channel.guild.members.me);
    if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) return 'El bot no puede ver o escribir en ese canal.';

    // Un canal que ya recibe otros chats reutiliza su webhook en vez de crear uno por espejo.
    let webhookUrl = (await channelMappingRepository.getAllForChannel(channelId)).find((m) => m.webhook_url)?.webhook_url || null;
    if (!webhookUrl && perms.has(PermissionFlagsBits.ManageWebhooks) && typeof channel.createWebhook === 'function') {
      try {
        webhookUrl = (await channel.createWebhook({ name: 'ImpeBot Espejo', reason: 'Espejo WhatsApp' })).url;
      } catch (err) {
        console.warn('[MirrorService] No se pudo crear webhook:', err.message);
      }
    }

    try {
      await channelMappingRepository.addMirror({
        whatsappJid: jid, discordChannelId: channelId, discordGuildId: channel.guild.id, webhookUrl, alias, createdBy: interaction.user.id,
      });
    } catch (err) {
      if (isDuplicate(err)) return alias ? `El alias \`${alias}\` ya lo usa otro vínculo.` : 'Ese espejo ya existe.';
      throw err;
    }
    return `✅ \`${jid}\` → <#${channelId}> en **${channel.guild.name}**.${alias ? ` Alias: \`${alias}\`.` : ''}`
      + (webhookUrl ? '' : '\nSin permiso de webhooks: los mensajes saldrán con el nombre del bot.');
  }
}

export const mirrorService = new MirrorService();
