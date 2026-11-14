import { EventEmitter } from 'events';
import {
  Client,
  GatewayIntentBits,
  WebhookClient,
  Events,
  PermissionFlagsBits,
  ChannelType,
} from 'discord.js';
import { CONFIG } from '../config.js';
import { commandLogService } from './CommandLogService.js';
import { SLASH_ALIASES, withSlashAliases } from '../utils/slashAliases.js';
import { commandGuildIds } from '../utils/guilds.js';

/**
 * Contenido reenviado desde WhatsApp nunca debe notificar a nadie en Discord:
 * sin esto, un "@everyone" escrito en un grupo avisaría a todo el servidor (también en los espejos públicos).
 */
export const NO_MENTIONS = Object.freeze({ parse: [] });

export class DiscordService extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.isReady = false;
    /** @type {Map<string, { client: WebhookClient, expiresAt: number }>} */
    this.webhookCache = new Map();
    this.cacheTTL = CONFIG.discord.webhookCacheTTL || 300000; // 5 minutos
    /** Comandos de cada servidor: se envían todos juntos (una petición por servidor). */
    this.commandRegistry = new Map();
    this.commandWaiters = [];
    this.commandTimer = null;
    this.commandDelayMs = 1500;
    /** Últimos nombres de comandos vistos por servidor, para registrar qué cambió y cuándo. */
    this.commandSnapshot = new Map();
  }

  /**
   * Inicializa y conecta el cliente de Discord.
   */
  async login() {
    if (!CONFIG.discord.token) {
      console.warn('⚠️ [DiscordService] No se proporcionó DISCORD_BOT_TOKEN en las variables de entorno.');
      return;
    }

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.MessageContent,
      ],
    });

    this.client.once(Events.ClientReady, (readyClient) => {
      this.isReady = true;
      console.log('==================================================');
      console.log(`✅ ¡Bot conectado a Discord como: ${readyClient.user.tag}!`);
      console.log('==================================================\n');
      this.startCommandWatchdog();
      this.emit('ready', readyClient);
    });

    this.client.on(Events.MessageCreate, (message) => {
      // Filtrar mensajes generados por bots o webhooks para evitar bucles inmediatos
      if (message.author.bot || message.webhookId) return;

      this.emit('message', message);
    });

    // La música sale del canal de voz cuando se queda sin personas.
    this.client.on(Events.VoiceStateUpdate, (oldState, newState) => this.emit('voiceStateUpdate', oldState, newState));

    this.client.on(Events.InteractionCreate, (interaction) => {
      // Los alias (/queue, /volume, /reply...) se tratan como su comando original.
      const canonical = SLASH_ALIASES[interaction.commandName];
      if (canonical) {
        interaction.invokedAs = interaction.commandName;
        interaction.commandName = canonical;
      }
      if (interaction.isChatInputCommand?.()) this.logSlashCommand(interaction);
      else if (interaction.isButton?.()) this.logButtonClick(interaction);
      this.emit('interaction', interaction);
    });

    this.client.on(Events.Error, (err) => {
      console.error('[DiscordService] Error en cliente de Discord:', err);
      this.emit('error', err);
    });

    await this.client.login(CONFIG.discord.token);
    return this.client;
  }

  /**
   * Deja constancia de cada slash command. No se guardan textos libres
   * (como las respuestas de tickets), solo opciones cortas.
   */
  logSlashCommand(interaction) {
    try {
      const sub = interaction.options.getSubcommand(false);
      const args = (interaction.options.data[0]?.options && sub ? interaction.options.data[0].options : interaction.options.data)
        .filter((o) => o.name !== 'mensaje' && o.value !== undefined && o.type !== 11)
        .map((o) => `${o.name}=${String(o.value).slice(0, 80)}`)
        .join(' ');
      commandLogService.log({
        source: 'discord',
        actorId: interaction.user.id,
        actorName: interaction.member?.displayName || interaction.user.username,
        chatId: interaction.channelId,
        command: `/${interaction.invokedAs || interaction.commandName}${sub ? ` ${sub}` : ''}`,
        args,
        status: 'recibido',
      });
    } catch (err) {
      console.warn('[DiscordService] No se pudo registrar el comando:', err.message);
    }
  }

  /** Deja constancia de cada pulsación de botón (controles de música, etc.). */
  logButtonClick(interaction) {
    try {
      commandLogService.log({
        source: 'discord',
        actorId: interaction.user.id,
        actorName: interaction.member?.displayName || interaction.user.username,
        chatId: interaction.channelId,
        command: `botón ${interaction.customId}`,
        status: 'recibido',
      });
    } catch (err) {
      console.warn('[DiscordService] No se pudo registrar el botón:', err.message);
    }
  }

  /**
   * Obtiene o crea un WebhookClient en caché para una URL dada.
   * @param {string} webhookUrl 
   * @returns {WebhookClient}
   */
  getWebhookClient(webhookUrl) {
    const now = Date.now();
    const cached = this.webhookCache.get(webhookUrl);

    if (cached && cached.expiresAt > now) {
      return cached.client;
    }

    if (cached) {
      try {
        cached.client.destroy();
      } catch (e) {
        // Ignorar error al limpiar
      }
    }

    const client = new WebhookClient({ url: webhookUrl });
    this.webhookCache.set(webhookUrl, {
      client,
      expiresAt: now + this.cacheTTL,
    });

    return client;
  }

  /**
   * Envía un mensaje a Discord a través de un Webhook simulando el usuario remitente.
   * @param {string} webhookUrl 
   * @param {{ content?: string, username?: string, avatarURL?: string, files?: any[] }} payload 
   * @returns {Promise<any>}
   */
  async sendViaWebhook(webhookUrl, payload) {
    if (!webhookUrl) {
      throw new Error('[DiscordService] No se proporcionó URL de webhook.');
    }

    const webhookClient = this.getWebhookClient(webhookUrl);
    return await webhookClient.send(payload);
  }

  /**
   * Envía un mensaje directo a un canal de texto (como el bot de Discord).
   * @param {string} channelId 
   * @param {any} content 
   */
  async sendMessage(channelId, content) {
    if (!this.client || !this.isReady) {
      throw new Error('[DiscordService] Cliente de Discord no inicializado o no conectado.');
    }

    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`[DiscordService] Canal ${channelId} no es válido o no es de texto.`);
    }

    return await channel.send(content);
  }

  async createTicketChannel(ticket) {
    if (!this.isReady || !CONFIG.discord.guildId) throw new Error('Discord no está disponible para tickets.');
    const guild = await this.client.guilds.fetch(CONFIG.discord.guildId);
    const roles = await guild.roles.fetch();
    const staffIds = CONFIG.tickets.staffRoleIds;
    if (staffIds.some((id) => id === guild.id || !roles.has(id))) throw new Error('TICKETS_STAFF_ROLE_IDS contiene un rol inválido.');
    const permissions = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles];
    return guild.channels.create({
      name: `ticket-${ticket.number}-${ticket.subject}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 100),
      type: ChannelType.GuildText,
      parent: CONFIG.tickets.categoryId || undefined,
      topic: `Ticket #${ticket.number} | ${ticket.category} | ${ticket.status} | Respuestas al jugador: /responder. Notas: /nota.`,
      permissionOverwrites: [
        { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: this.client.user.id, allow: [...permissions, PermissionFlagsBits.ManageChannels] },
        ...staffIds.map((id) => ({ id, allow: permissions })),
      ],
    });
  }

  /**
   * Registra comandos en DISCORD_GUILD_ID y, con `extra`, también en DISCORD_EXTRA_GUILD_IDS.
   * Cada módulo llama al conectarse; se juntan durante un instante y se envían de una vez por servidor
   * (crear uno a uno choca con el límite de Discord y con alias y varios servidores tardaba minutos).
   * El envío reemplaza la lista del bot en ese servidor: los comandos que ya no existen desaparecen.
   * Si un servidor extra falla (el bot no está en él), los demás se registran igual.
   */
  registerGuildCommands(commands, { extra = false } = {}) {
    const all = withSlashAliases(commands);
    for (const guildId of commandGuildIds({ extra })) {
      if (!this.commandRegistry.has(guildId)) this.commandRegistry.set(guildId, new Map());
      const byName = this.commandRegistry.get(guildId);
      for (const command of all) byName.set(command.name, command);
    }
    return new Promise((resolve, reject) => {
      this.commandWaiters.push({ resolve, reject });
      clearTimeout(this.commandTimer);
      this.commandTimer = setTimeout(() => void this.flushCommands(), this.commandDelayMs);
    });
  }

  async flushCommands() {
    const waiters = this.commandWaiters.splice(0);
    const errors = [];
    let mainError = null;
    for (const [guildId, byName] of this.commandRegistry) {
      try {
        const guild = await this.client.guilds.fetch(guildId);
        // DiscordSRV comparte la aplicación y reemplaza la lista al arrancar: conservar sus comandos.
        const foreign = [];
        try {
          const existing = await guild.commands.fetch();
          this.logCommandChanges(guild, [...(existing?.values?.() ?? [])].map((c) => c.name));
          for (const c of existing?.values?.() ?? []) {
            if (!byName.has(c.name)) foreign.push({ name: c.name, description: c.description, options: c.options, defaultMemberPermissions: c.defaultMemberPermissions, dmPermission: c.dmPermission });
          }
        } catch { /* sin lectura previa se registran solo los propios */ }
        await guild.commands.set([...byName.values(), ...foreign]);
        const extra = foreign.length ? ` (conserva ${foreign.length} ajenos: ${foreign.map((c) => `/${c.name}`).join(', ')})` : '';
        console.log(`✅ [Discord] ${byName.size} comandos registrados en ${guild.name}${extra}.`);
        this.commandSnapshot.set(guild.id, new Set([...byName.keys(), ...foreign.map((c) => c.name)]));
      } catch (err) {
        if (guildId === CONFIG.discord.guildId) mainError = err;
        else errors.push(`${guildId}: ${err.message}`);
      }
    }
    if (errors.length) console.error(`⚠️ [Discord] No se pudieron registrar comandos en ${errors.join('; ')}`);
    for (const waiter of waiters) {
      if (mainError) waiter.reject(mainError);
      else waiter.resolve();
    }
  }

  /** Compara los comandos del servidor con la última lista vista y registra qué se añadió o quitó. */
  logCommandChanges(guild, names) {
    const now = new Set(names);
    const before = this.commandSnapshot.get(guild.id);
    this.commandSnapshot.set(guild.id, now);
    if (!before) return;
    const added = [...now].filter((n) => !before.has(n));
    const removed = [...before].filter((n) => !now.has(n));
    if (!added.length && !removed.length) return;
    const list = (a) => a.map((n) => `/${n}`).join(', ') || '—';
    console.warn(`⚠️ [Discord] Los comandos de ${guild.name} cambiaron desde fuera del bot (otra aplicación o plugin que usa el mismo bot, p. ej. DiscordSRV): añadidos: ${list(added)}; quitados: ${list(removed)}. Ahora hay ${now.size}: ${list([...now].sort())}`);
  }

  /** Si otra herramienta (DiscordSRV) borra nuestros comandos, los vuelve a registrar. */
  startCommandWatchdog(intervalMs = 10 * 60 * 1000) {
    clearInterval(this.commandWatchdog);
    this.commandWatchdog = setInterval(async () => {
      try {
        let missingIn = null;
        for (const [guildId, byName] of this.commandRegistry) {
          const guild = await this.client.guilds.fetch(guildId);
          const present = await guild.commands.fetch();
          this.logCommandChanges(guild, [...present.values()].map((c) => c.name));
          const missing = [...byName.keys()].filter((n) => !present.some((c) => c.name === n));
          if (missing.length && !missingIn) {
            missingIn = true;
            console.warn(`⚠️ [Discord] Faltan ${missing.length} comandos del bot en ${guild.name} (${missing.slice(0, 8).map((n) => `/${n}`).join(', ')}${missing.length > 8 ? '…' : ''}); se registran de nuevo.`);
          }
        }
        if (missingIn) await this.flushCommands();
      } catch (err) {
        console.error(`⚠️ [Discord] Revisión de comandos falló: ${err.message}`);
      }
    }, intervalMs);
    this.commandWatchdog.unref?.();
  }

  async registerTicketCommands(commands) {
    return this.registerGuildCommands(commands);
  }

  /**
   * Edita un mensaje previamente enviado a través de un Webhook.
   * @param {string} webhookUrl 
   * @param {string} messageId 
   * @param {object} payload 
   * @returns {Promise<any>}
   */
  async editWebhookMessage(webhookUrl, messageId, payload) {
    if (!webhookUrl || !messageId) {
      throw new Error('[DiscordService] webhookUrl y messageId son requeridos para editar.');
    }
    const webhookClient = this.getWebhookClient(webhookUrl);
    return await webhookClient.editMessage(messageId, payload);
  }

  /**
   * Edita un mensaje previamente enviado en un canal de texto (como el bot de Discord).
   * @param {string} channelId 
   * @param {string} messageId 
   * @param {object} payload 
   * @returns {Promise<any>}
   */
  async editChannelMessage(channelId, messageId, payload) {
    if (!this.client || !this.isReady) {
      throw new Error('[DiscordService] Cliente de Discord no inicializado o no conectado.');
    }
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`[DiscordService] Canal ${channelId} no es válido o no es de texto.`);
    }
    const message = await channel.messages.fetch(messageId);
    if (!message) {
      throw new Error(`[DiscordService] Mensaje ${messageId} no encontrado.`);
    }
    return await message.edit(payload);
  }

  /**
   * Elimina un mensaje previamente enviado a través de un Webhook.
   * @param {string} webhookUrl 
   * @param {string} messageId 
   * @returns {Promise<void>}
   */
  async deleteWebhookMessage(webhookUrl, messageId) {
    if (!webhookUrl || !messageId) {
      throw new Error('[DiscordService] webhookUrl y messageId son requeridos para eliminar.');
    }
    const webhookClient = this.getWebhookClient(webhookUrl);
    return await webhookClient.deleteMessage(messageId);
  }

  /**
   * Elimina un mensaje previamente enviado en un canal de Discord.
   * @param {string} channelId 
   * @param {string} messageId 
   * @returns {Promise<void>}
   */
  async deleteChannelMessage(channelId, messageId) {
    if (!this.client || !this.isReady) {
      throw new Error('[DiscordService] Cliente de Discord no inicializado o no conectado.');
    }
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`[DiscordService] Canal ${channelId} no es válido o no es de texto.`);
    }
    const message = await channel.messages.fetch(messageId);
    if (message) {
      await message.delete();
    }
  }

  /**
   * Busca o crea una categoría en el servidor principal.
   * @param {string} categoryName 
   * @returns {Promise<import('discord.js').CategoryChannel|null>}
   */
  async findOrCreateCategory(categoryName) {
    if (!this.client || !this.isReady || !CONFIG.discord.guildId) return null;
    try {
      const guild = await this.client.guilds.fetch(CONFIG.discord.guildId);
      if (!guild) return null;

      const channels = await guild.channels.fetch();
      let category = channels.find(
        (c) => c && c.type === 4 && c.name.toLowerCase() === categoryName.toLowerCase() // 4 = ChannelType.GuildCategory
      );

      if (!category) {
        category = await guild.channels.create({
          name: categoryName,
          type: 4, // GuildCategory
        });
        console.log(`📁 [DiscordService] Categoría creada: "${categoryName}"`);
      }

      return category;
    } catch (err) {
      console.error(`[DiscordService] Error creando/buscando categoría "${categoryName}":`, err.message);
      return null;
    }
  }

  /**
   * Crea un canal de texto en Discord bajo una categoría específica y le asocia un Webhook.
   * @param {string} channelName 
   * @param {string} categoryId 
   * @param {string} topic 
   * @param {string|null} avatarUrl
   * @returns {Promise<{ channel: import('discord.js').TextChannel, webhook: import('discord.js').Webhook }|null>}
   */
  async createRelayChannel(channelName, categoryId = null, topic = '', avatarUrl = null) {
    if (!this.client || !this.isReady || !CONFIG.discord.guildId) return null;
    try {
      const guild = await this.client.guilds.fetch(CONFIG.discord.guildId);
      if (!guild) return null;

      // Sanitizar nombre de canal para Discord (solo minúsculas, números, guiones y sin espacios)
      const sanitizedName = channelName
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9_-]/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 100) || 'chat-wa';

      const channel = await guild.channels.create({
        name: sanitizedName,
        type: 0, // ChannelType.GuildText
        parent: categoryId || undefined,
        topic: topic ? topic.slice(0, 1024) : undefined,
      });

      console.log(`📢 [DiscordService] Canal creado: #${channel.name} (${channel.id})`);

      // Crear Webhook para este canal con avatar si está disponible
      const webhook = await channel.createWebhook({
        name: 'ImpeBot Relay',
        avatar: avatarUrl || undefined,
        reason: 'Auto-relay WhatsApp <-> Discord',
      });

      console.log(`🔗 [DiscordService] Webhook creado para #${channel.name}`);

      return { channel, webhook };
    } catch (err) {
      console.error(`[DiscordService] Error creando canal "${channelName}":`, err.message);
      return null;
    }
  }

  /**
   * Cierra las conexiones de Discord y limpia los Webhooks en caché.
   */
  destroy() {
    for (const [, entry] of this.webhookCache) {
      try {
        entry.client.destroy();
      } catch (e) {
        // Ignorar
      }
    }
    this.webhookCache.clear();

    if (this.client) {
      this.client.destroy();
      this.client = null;
      this.isReady = false;
      console.log('🛑 [DiscordService] Cliente de Discord detenido.');
    }
  }
}

export const discordService = new DiscordService();
