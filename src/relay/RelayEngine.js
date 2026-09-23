import { CONFIG } from '../config.js';
import { whatsAppService } from '../services/WhatsAppService.js';
import { discordService } from '../services/DiscordService.js';
import { channelMappingRepository } from '../database/repositories/ChannelMappingRepository.js';
import { userMappingRepository } from '../database/repositories/UserMappingRepository.js';
import { messageLogRepository } from '../database/repositories/MessageLogRepository.js';
import { MessageTransformer } from './MessageTransformer.js';

export class RelayEngine {
  constructor() {
    this.cleanupTimer = null;
    this.isRunning = false;
  }

  /**
   * Inicia el motor de retransmisión suscribiéndose a los eventos de ambas plataformas.
   */
  start() {
    if (!CONFIG.relay.enabled) {
      console.log('ℹ️ [RelayEngine] El reenvío está deshabilitado en la configuración.');
      return;
    }

    if (this.isRunning) return;
    this.isRunning = true;

    console.log('🔄 [RelayEngine] Iniciando motor de retransmisión WhatsApp ↔ Discord...');

    // Escuchar mensajes de WhatsApp
    whatsAppService.on('message', async (waData) => {
      try {
        await this.handleWhatsAppMessage(waData);
      } catch (err) {
        console.error('[RelayEngine] Error procesando mensaje de WhatsApp -> Discord:', err);
      }
    });

    // Escuchar mensajes de Discord
    discordService.on('message', async (discordMsg) => {
      try {
        await this.handleDiscordMessage(discordMsg);
      } catch (err) {
        console.error('[RelayEngine] Error procesando mensaje de Discord -> WhatsApp:', err);
      }
    });

    // Programar limpieza periódica de logs antiguos para optimizar la base de datos
    this.scheduleCleanup();

    console.log('🚀 [RelayEngine] Motor de retransmisión activo y listo.');
  }

  /**
   * Procesa un mensaje entrante de WhatsApp y lo reenvía a Discord.
   * @param {object} waData 
   */
  async handleWhatsAppMessage(waData) {
    const { jid, messageId, sender, pushName, text, isFromMe } = waData;

    // 1. Ignorar mensajes propios del bot si se desea evitar autoretransmisión
    if (isFromMe) return;

    // 2. Si el mensaje es un comando del bot de stickers (!s, !help, etc.), no retransmitirlo a Discord
    if (text && CONFIG.prefixes.some((p) => text.startsWith(p))) {
      return;
    }

    // 3. Verificar si el grupo o chat tiene un mapeo a un canal de Discord
    let mapping = await channelMappingRepository.getByWhatsAppJid(jid);

    // Si no existe mapeo y se especificó DISCORD_GUILD_ID, crearlo automáticamente
    if (!mapping && CONFIG.discord.guildId) {
      mapping = await this.autoCreateMapping(waData);
    }

    if (!mapping) return;

    // 4. Prevención de bucles: verificar si el mensaje ya fue registrado
    const alreadyProcessed = await messageLogRepository.exists(messageId, null);
    if (alreadyProcessed) {
      return;
    }

    // 5. Determinar identidad del remitente (Mapeo personalizado o fallback con pushName y avatar)
    const userMap = await userMappingRepository.getByWhatsAppJid(sender);
    const username = userMap?.display_name || pushName || sender.split('@')[0];
    let avatarURL = userMap?.avatar_url;

    if (!avatarURL) {
      avatarURL = await whatsAppService.getProfilePictureUrl(sender);
      // Si el sender es @lid y no tiene avatar directo, probar con el jid si es chat directo
      if (!avatarURL && !jid.endsWith('@g.us') && jid !== sender) {
        avatarURL = await whatsAppService.getProfilePictureUrl(jid);
      }
    }

    // 6. Transformar mensaje a formato Discord
    const { content, files } = await MessageTransformer.toDiscord(waData);
    if (!content && files.length === 0) return;

    // 7. Enviar a Discord (preferentemente vía Webhook para impersonar usuario)
    let discordMessageId = null;

    if (mapping.webhook_url) {
      try {
        const result = await discordService.sendViaWebhook(mapping.webhook_url, {
          content: content || undefined,
          username: username.slice(0, 80),
          avatarURL: avatarURL || undefined,
          files,
        });
        discordMessageId = result?.id || null;
      } catch (webhookErr) {
        console.warn(`[RelayEngine] Fallo al enviar vía Webhook, intentando canal directo: ${webhookErr.message}`);
      }
    }

    // Fallback a envío como bot si no hay webhook o falló
    if (!discordMessageId && mapping.discord_channel_id) {
      const sentMsg = await discordService.sendMessage(mapping.discord_channel_id, {
        content: `**[${username}]:** ${content}`,
        files,
      });
      discordMessageId = sentMsg.id;
    }

    // 8. Registrar IDs para prevenir bucles de retorno
    await messageLogRepository.logMessage(
      messageId,
      discordMessageId,
      mapping.id,
      'wa_to_discord'
    );
  }

  /**
   * Procesa un mensaje entrante de Discord y lo reenvía a WhatsApp.
   * @param {import('discord.js').Message} discordMsg 
   */
  async handleDiscordMessage(discordMsg) {
    const channelId = discordMsg.channelId;

    // 1. Verificar si el canal de Discord está mapeado a un JID de WhatsApp
    const mapping = await channelMappingRepository.getByDiscordChannelId(channelId);
    if (!mapping) return;

    // 2. Prevención de bucles: verificar si el mensaje de Discord ya está en logs
    const alreadyProcessed = await messageLogRepository.exists(null, discordMsg.id);
    if (alreadyProcessed) {
      return;
    }

    // 3. Transformar mensaje al formato de Baileys
    const payloads = await MessageTransformer.toWhatsApp(discordMsg);
    if (!payloads || payloads.length === 0) return;

    // 4. Reenviar cada payload a WhatsApp
    for (const payload of payloads) {
      try {
        const sent = await whatsAppService.sendMessage(mapping.whatsapp_jid, payload.content, payload.options);
        const waMessageId = sent?.key?.id || null;

        // 5. Registrar en logs para evitar bucles de retorno
        await messageLogRepository.logMessage(
          waMessageId,
          discordMsg.id,
          mapping.id,
          'discord_to_wa'
        );
      } catch (waErr) {
        console.error(`[RelayEngine] Error al enviar mensaje a WhatsApp (${mapping.whatsapp_jid}):`, waErr.message);
      }
    }
  }

  /**
   * Crea automáticamente la categoría, el canal de Discord, el Webhook y el mapeo en BD para un chat de WhatsApp.
   * @param {object} waData 
   * @returns {Promise<object|null>}
   */
  async autoCreateMapping(waData) {
    const { jid, pushName, sender } = waData;

    try {
      let categoryName = '💬 Mensajes Directos';
      let channelName = '';
      let topic = `WhatsApp Chat JID: ${jid}`;

      if (jid === 'status@broadcast') {
        categoryName = '📢 Estados';
        channelName = 'estados-whatsapp';
        topic = `WhatsApp Estados / Stories (${jid})`;
      } else if (jid.endsWith('@newsletter')) {
        // Canales / Canales de difusión de WhatsApp
        categoryName = '📢 Canales';
        const name = await whatsAppService.getChatName(jid);
        channelName = name ? `canal-${name}` : `canal-${jid.split('@')[0]}`;
        topic = `WhatsApp Canal/Newsletter JID: ${jid}`;
      } else if (jid.endsWith('@g.us')) {
        // Grupos de WhatsApp
        categoryName = '👥 Mensajes en Grupos';
        const groupName = await whatsAppService.getChatName(jid);
        channelName = groupName ? `grp-${groupName}` : `grupo-${jid.split('@')[0]}`;
        topic = `WhatsApp Grupo JID: ${jid} | Nombre: ${groupName || 'Desconocido'}`;
      } else {
        // Chats privados / directos (@s.whatsapp.net o @lid)
        categoryName = '💬 Mensajes Directos';
        const userName = pushName || sender.split('@')[0];
        channelName = `dm-${userName}`;
        topic = `WhatsApp Direct Message JID: ${jid} | Usuario: ${userName}`;
      }

      console.log(`✨ [RelayEngine] Creando canal automático en Discord para ${jid} en categoría "${categoryName}"...`);

      // 1. Obtener o crear la categoría correspondiente
      const category = await discordService.findOrCreateCategory(categoryName);
      const categoryId = category ? category.id : null;

      // Obtener avatar del chat/grupo/usuario para el webhook inicial si existe
      const avatarUrl = await whatsAppService.getProfilePictureUrl(jid).catch(() => null);

      // 2. Crear el canal y su webhook (con avatar inicial si está disponible)
      const created = await discordService.createRelayChannel(channelName, categoryId, topic, avatarUrl);
      if (!created || !created.channel) {
        console.error(`❌ [RelayEngine] No se pudo crear el canal de Discord para ${jid}`);
        return null;
      }

      // 3. Guardar en la base de datos (channel_mappings)
      await channelMappingRepository.save(
        jid,
        created.channel.id,
        created.webhook ? created.webhook.url : null,
        created.webhook ? created.webhook.id : null
      );

      // 4. Leer el mapeo recién creado para devolver el objeto completo
      const mapping = await channelMappingRepository.getByWhatsAppJid(jid);

      console.log(`✅ [RelayEngine] Mapeo guardado exitosamente en BD: [${jid} <-> #${created.channel.name}] (ID: ${mapping?.id})`);
      return mapping;
    } catch (err) {
      console.error(`❌ [RelayEngine] Error durante la auto-creación del mapeo para ${jid}:`, err);
      return null;
    }
  }

  /**
   * Tarea periódica de limpieza de logs antiguos.
   */
  scheduleCleanup() {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);

    const interval = CONFIG.relay.cleanupIntervalMs || 3600000;
    this.cleanupTimer = setInterval(async () => {
      try {
        const retention = CONFIG.relay.messageRetentionHours || 24;
        const deleted = await messageLogRepository.cleanup(retention);
        if (deleted > 0) {
          console.log(`🧹 [RelayEngine] Limpieza de logs completada: ${deleted} registros eliminados.`);
        }
      } catch (err) {
        console.error('[RelayEngine] Error durante la limpieza de logs:', err.message);
      }
    }, interval);
  }

  /**
   * Detiene el motor de retransmisión.
   */
  stop() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.isRunning = false;
    console.log('🛑 [RelayEngine] Motor de retransmisión detenido.');
  }
}

export const relayEngine = new RelayEngine();
export default relayEngine;
