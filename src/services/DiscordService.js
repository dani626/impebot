import { EventEmitter } from 'events';
import {
  Client,
  GatewayIntentBits,
  WebhookClient,
  Events,
} from 'discord.js';
import { CONFIG } from '../config.js';

export class DiscordService extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.isReady = false;
    /** @type {Map<string, { client: WebhookClient, expiresAt: number }>} */
    this.webhookCache = new Map();
    this.cacheTTL = CONFIG.discord.webhookCacheTTL || 300000; // 5 minutos
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
        GatewayIntentBits.MessageContent,
      ],
    });

    this.client.once(Events.ClientReady, (readyClient) => {
      this.isReady = true;
      console.log('==================================================');
      console.log(`✅ ¡Bot conectado a Discord como: ${readyClient.user.tag}!`);
      console.log('==================================================\n');
      this.emit('ready', readyClient);
    });

    this.client.on(Events.MessageCreate, (message) => {
      // Filtrar mensajes generados por bots o webhooks para evitar bucles inmediatos
      if (message.author.bot || message.webhookId) return;

      this.emit('message', message);
    });

    this.client.on(Events.Error, (err) => {
      console.error('[DiscordService] Error en cliente de Discord:', err);
      this.emit('error', err);
    });

    await this.client.login(CONFIG.discord.token);
    return this.client;
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
export default discordService;
