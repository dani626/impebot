import { PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { CONFIG } from '../config.js';
import { luckPermsService } from './LuckPermsService.js';
import { decide, PERMISSIONS } from './permissions.js';

/**
 * /minecraft info [usuario]              → cuenta vinculada (cualquiera)
 * /minecraft vincular jugador usuario    → admin: fuerza meta.discord.<id> (impebot.link.admin)
 * /minecraft desvincular jugador|usuario → admin: quita el vínculo de Discord (impebot.link.admin)
 * Sin LuckPerms disponible, Gestionar servidor sirve de respaldo.
 */
export function minecraftCommands() {
  const jugador = (o) => o.setName('jugador').setDescription('Nombre del jugador en Minecraft').setRequired(true).setMinLength(3).setMaxLength(36);
  return [
    new SlashCommandBuilder().setName('minecraft').setDescription('Cuenta de Minecraft vinculada (LuckPerms)')
      .addSubcommand((s) => s.setName('info').setDescription('Ver a qué jugador está vinculada una cuenta')
        .addUserOption((o) => o.setName('usuario').setDescription('Por defecto, tú')))
      .addSubcommand((s) => s.setName('vincular').setDescription('Vincular una cuenta de Discord a un jugador (staff)')
        .addStringOption(jugador)
        .addUserOption((o) => o.setName('usuario').setDescription('Cuenta de Discord').setRequired(true)))
      .addSubcommand((s) => s.setName('desvincular').setDescription('Quitar el vínculo de Discord (staff)')
        .addStringOption((o) => o.setName('jugador').setDescription('Nombre del jugador en Minecraft').setMinLength(3).setMaxLength(36))
        .addUserOption((o) => o.setName('usuario').setDescription('O la cuenta de Discord vinculada'))),
  ].map((c) => c.toJSON());
}

export class MinecraftDiscordCommands {
  constructor({ discord, lp = luckPermsService }) {
    this.discord = discord;
    this.lp = lp;
    this.onInteraction = (interaction) => void this.handleInteraction(interaction)
      .catch((err) => console.error('[Minecraft] Interacción:', err.message));
    this.onReady = () => void this.discord.registerGuildCommands(minecraftCommands())
      .catch((err) => console.error('[Minecraft] Registro de comandos:', err.message));
  }

  start() {
    if (!this.lp.enabled) return;
    this.discord.on('interaction', this.onInteraction);
    this.discord.on('ready', this.onReady);
  }

  stop() {
    this.discord.off('interaction', this.onInteraction);
    this.discord.off('ready', this.onReady);
  }

  async handleInteraction(interaction) {
    if (!interaction.isChatInputCommand?.() || interaction.commandName !== 'minecraft') return;
    if (CONFIG.discord.guildId && interaction.guildId !== CONFIG.discord.guildId) return;
    await interaction.deferReply({ flags: 64 });
    try {
      const sub = interaction.options.getSubcommand();
      if (sub === 'info') {
        const own = await this.lp.check('discord', [interaction.user.id], PERMISSIONS.account.node);
        if (!decide(PERMISSIONS.account, own)) {
          await interaction.editReply(own.available && !own.player
            ? 'Tu cuenta de Discord no está vinculada a Minecraft. Escribe `/discord link` en el servidor de Minecraft y envía el código a DiscordSRV.'
            : `⛔ Necesitas el permiso ${PERMISSIONS.account.node}.`);
          return;
        }
        const user = interaction.options.getUser('usuario') || interaction.user;
        const player = await this.lp.findPlayer('discord', [user.id]);
        if (!player) {
          await interaction.editReply(`🎮 <@${user.id}> no está vinculado a ninguna cuenta de Minecraft.`);
          return;
        }
        const { groups } = await this.lp.loadUser(player.uuid);
        await interaction.editReply(`🎮 <@${user.id}> → **${player.username}**\n🏷️ Rango: ${player.primaryGroup}${groups.length > 1 ? `\n📚 Grupos: ${groups.join(', ')}` : ''}`);
        return;
      }

      const manageGuild = Boolean(interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild));
      const lp = await this.lp.check('discord', [interaction.user.id], PERMISSIONS.linkAdmin.node);
      if (!decide(PERMISSIONS.linkAdmin, lp, { fallback: manageGuild })) {
        await interaction.editReply(`⛔ Necesitas el permiso ${PERMISSIONS.linkAdmin.node}.`);
        return;
      }

      if (sub === 'desvincular') {
        const name = interaction.options.getString('jugador');
        const target = interaction.options.getUser('usuario');
        const player = name ? await this.lp.findPlayerByName(name) : target ? await this.lp.findPlayer('discord', [target.id]) : null;
        if (!name && !target) {
          await interaction.editReply('Indica el jugador o el usuario de Discord.');
          return;
        }
        if (!player) {
          await interaction.editReply(name ? `❌ No existe el jugador **${name}** en LuckPerms.` : `ℹ️ <@${target.id}> no está vinculado.`);
          return;
        }
        const removed = await this.lp.unlink(player.uuid, 'discord');
        await interaction.editReply(removed ? `✅ **${player.username}** ya no está vinculado a Discord.` : `ℹ️ **${player.username}** no tenía Discord vinculado.`);
        return;
      }

      const name = interaction.options.getString('jugador', true);
      const player = await this.lp.findPlayerByName(name);
      if (!player) {
        await interaction.editReply(`❌ No existe el jugador **${name}** en LuckPerms (debe haber entrado al servidor al menos una vez).`);
        return;
      }

      const user = interaction.options.getUser('usuario', true);
      // Solo quien gestiona el servidor puede vincularse a sí mismo.
      if (user.id === interaction.user.id && !manageGuild) {
        await interaction.editReply('⚠️ No puedes vincular tu propia cuenta. Pídeselo a otro miembro del staff.');
        return;
      }
      await this.lp.link(player.uuid, 'discord', [user.id]);
      await interaction.editReply(`✅ <@${user.id}> vinculado a **${player.username}** (${player.primaryGroup}).`);
    } catch (err) {
      console.error('[Minecraft] Error:', err.message);
      await interaction.editReply('❌ No se pudo consultar LuckPerms. Inténtalo más tarde.').catch(() => {});
    }
  }
}
