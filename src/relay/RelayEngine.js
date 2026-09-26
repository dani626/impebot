import { EmbedBuilder } from 'discord.js';
import { CONFIG } from '../config.js';
import { whatsAppService } from '../services/WhatsAppService.js';
import { discordService } from '../services/DiscordService.js';
import { catboxService } from '../services/CatboxService.js';
import { channelMappingRepository } from '../database/repositories/ChannelMappingRepository.js';
import { userMappingRepository } from '../database/repositories/UserMappingRepository.js';
import { messageLogRepository } from '../database/repositories/MessageLogRepository.js';
import { MessageTransformer } from './MessageTransformer.js';
import { isBotCommand } from '../utils/commands.js';

/**
 * Genera embeds formateados para estados de subida a Catbox.
 * @param {'ready'|'pending'|'error'} status 
 * @param {{ url?: string, error?: string }} [data={}] 
 * @returns {EmbedBuilder}
 */
function buildCatboxEmbed(status, data = {}) {
  const embed = new EmbedBuilder().setTitle('🎬 Video adjunto');
  if (status === 'ready') {
    return embed
      .setColor(0x25d366)
      .setDescription(`[▶ Reproducir / Descargar video en Catbox](${data.url})`)
      .setFooter({ text: 'Catbox.moe • WhatsApp Relay' });
  }
  if (status === 'pending') {
    return embed
      .setColor(0xf39c12)
      .setDescription('⏳ *Subiendo video a Catbox en segundo plano...*')
      .setFooter({ text: 'Catbox.moe • Procesando' });
  }
  if (status === 'error') {
    return embed
      .setColor(0xe74c3c)
      .setDescription(`⚠️ *(No se pudo procesar el video en Catbox: ${data.error || 'error desconocido'})*`)
      .setFooter({ text: 'Catbox.moe • Error de subida' });
  }
  return embed;
}

/**
 * Formatea el contenido para envío como bot cuando no se usa webhook.
 * @param {string} username 
 * @param {string} content 
 * @returns {string}
 */
function formatDiscordBotContent(username, content) {
  const prefixUser = `**[${username}]:**`;
  return content ? `${prefixUser} ${content}` : prefixUser;
}

/**
 * Entrega un mensaje a Discord prefiriendo Webhook con fallback al canal directo.
 * @param {object} mapping 
 * @param {object} payload 
 * @returns {Promise<string|null>} ID del mensaje en Discord
 */
async function deliverToDiscord(mapping, { content, username, avatarURL, files, embeds }) {
  if (mapping.webhook_url) {
    try {
      const result = await discordService.sendViaWebhook(mapping.webhook_url, {
        content: content || undefined,
        username: username.slice(0, 80),
        avatarURL: avatarURL || undefined,
        files,
        embeds: embeds?.length > 0 ? embeds : undefined,
      });
      if (result?.id) return result.id;
    } catch (webhookErr) {
      console.warn(`[RelayEngine] Fallo al enviar vía Webhook, intentando canal directo: ${webhookErr.message}`);
    }
  }

  if (mapping.discord_channel_id) {
    const botContent = formatDiscordBotContent(username, content);
    const sentMsg = await discordService.sendMessage(mapping.discord_channel_id, {
      content: botContent,
      files,
      embeds: embeds?.length > 0 ? embeds : undefined,
    });
    return sentMsg?.id || null;
  }

  return null;
}

/**
 * Edita un mensaje en Discord ya sea por Webhook o por canal directo.
 * @param {object} mapping 
 * @param {string} messageId 
 * @param {object} payload 
 */
async function updateDiscordMessage(mapping, messageId, { content, username, embeds }) {
  if (mapping.webhook_url) {
    return await discordService.editWebhookMessage(mapping.webhook_url, messageId, {
      content: content || undefined,
      embeds,
    });
  }
  if (mapping.discord_channel_id) {
    const botContent = formatDiscordBotContent(username, content);
    return await discordService.editChannelMessage(mapping.discord_channel_id, messageId, {
      content: botContent,
      embeds,
    });
  }
}

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

    // Escuchar mensajes eliminados en WhatsApp ("eliminar para todos")
    whatsAppService.on('message.delete', async (deleteData) => {
      try {
        await this.handleWhatsAppDelete(deleteData);
      } catch (err) {
        console.error('[RelayEngine] Error procesando eliminación de WhatsApp -> Discord:', err);
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

    // 1. Ignorar mensajes propios salvo RELAY_OWN_MESSAGES=true
    if (isFromMe && !CONFIG.relay.relayOwnMessages) return;

    // 2. Si el mensaje es un comando del bot (!s, !help, !presence, etc.), no retransmitirlo a Discord
    if (isBotCommand(text)) {
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
    let guildId = CONFIG.discord.guildId;
    if (!guildId && discordService.isReady && discordService.client) {
      const ch = discordService.client.channels.cache.get(mapping.discord_channel_id);
      if (ch?.guildId) {
        guildId = ch.guildId;
      }
    }

    const { content, files, embeds, pendingCatboxVideo } = await MessageTransformer.toDiscord(waData, {
      channelId: mapping.discord_channel_id,
      guildId,
    });
    if (!content && files.length === 0 && (!embeds || embeds.length === 0) && !pendingCatboxVideo) return;

    // Si es un mensaje recuperado de sincronización offline, pausar brevemente para evitar Rate Limits en Discord
    if (waData.isDelayed) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    // 7. Procesar subida de video a Catbox si aplica
    let catboxUploadPromise = null;
    let immediateCatboxUrl = null;
    let timedOut = false;

    if (pendingCatboxVideo) {
      catboxUploadPromise = catboxService.upload(
        pendingCatboxVideo.buffer,
        pendingCatboxVideo.fileName,
        pendingCatboxVideo.mimetype
      );

      const timeoutMs = CONFIG.catbox?.uploadTimeoutMs || 3500;
      let timer = null;
      const timeoutPromise = new Promise((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve('TIMEOUT');
        }, timeoutMs);
      });

      try {
        const raceRes = await Promise.race([catboxUploadPromise, timeoutPromise]);
        if (raceRes !== 'TIMEOUT') {
          immediateCatboxUrl = raceRes;
        }
      } catch (uploadErr) {
        console.error('[RelayEngine] Error inmediato al subir video a Catbox:', uploadErr.message);
      } finally {
        if (timer) clearTimeout(timer);
      }
    }

    let outgoingContent = content || '';
    const outgoingEmbeds = [...(embeds || [])];

    if (immediateCatboxUrl) {
      outgoingContent = outgoingContent ? `${outgoingContent}\n${immediateCatboxUrl}` : immediateCatboxUrl;
      outgoingEmbeds.push(buildCatboxEmbed('ready', { url: immediateCatboxUrl }));
    } else if (timedOut && catboxUploadPromise) {
      outgoingEmbeds.push(buildCatboxEmbed('pending'));
    }

    // 8. Enviar a Discord (preferentemente vía Webhook para impersonar usuario)
    const discordMessageId = await deliverToDiscord(mapping, {
      content: outgoingContent,
      username,
      avatarURL,
      files,
      embeds: outgoingEmbeds,
    });

    if (!discordMessageId) return;

    // 9. Registrar IDs para prevenir bucles de retorno
    await messageLogRepository.logMessage(
      messageId,
      discordMessageId,
      mapping.id,
      'wa_to_discord'
    );

    // 10. Si el video continúa subiéndose en background, actualizar el mensaje de Discord al terminar
    if (timedOut && catboxUploadPromise) {
      const initialEmbeds = [...(embeds || [])];
      const baseContent = content || '';

      catboxUploadPromise
        .then(async (catboxUrl) => {
          console.log(`🎬 [RelayEngine] Video subido a Catbox exitosamente: ${catboxUrl}. Editando mensaje en Discord (${discordMessageId})...`);
          const newContent = baseContent ? `${baseContent}\n${catboxUrl}` : catboxUrl;
          const newEmbeds = [...initialEmbeds, buildCatboxEmbed('ready', { url: catboxUrl })];
          await updateDiscordMessage(mapping, discordMessageId, {
            content: newContent,
            username,
            embeds: newEmbeds,
          });
        })
        .catch(async (uploadErr) => {
          console.error('❌ [RelayEngine] Error al subir video a Catbox en segundo plano:', uploadErr.message);
          const newEmbeds = [...initialEmbeds, buildCatboxEmbed('error', { error: uploadErr.message })];
          try {
            await updateDiscordMessage(mapping, discordMessageId, {
              content: baseContent,
              username,
              embeds: newEmbeds,
            });
          } catch (editErr) {
            console.error('[RelayEngine] Error editando mensaje tras fallo de subida a Catbox:', editErr.message);
          }
        });
    }
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
   * Procesa la eliminación de un mensaje de WhatsApp ("eliminar para todos")
   * e informa / actualiza el mensaje correspondiente en Discord.
   * @param {object} deleteData 
   */
  async handleWhatsAppDelete(deleteData) {
    const { waMessageId, remoteJid } = deleteData;
    if (!waMessageId) return;

    // 1. Buscar si tenemos registrado el mensaje en la base de datos
    const logEntry = await messageLogRepository.getByWaMessageId(waMessageId);
    if (!logEntry || !logEntry.discord_message_id) {
      return;
    }

    const discordMessageId = logEntry.discord_message_id;

    // 2. Obtener el mapeo correspondiente
    let mapping = null;
    if (logEntry.channel_mapping_id) {
      mapping = await channelMappingRepository.getById(logEntry.channel_mapping_id);
    }
    if (!mapping && remoteJid) {
      mapping = await channelMappingRepository.getByWhatsAppJid(remoteJid);
    }

    if (!mapping) return;

    console.log(`🗑️ [RelayEngine] Notificando eliminación en Discord para mensaje WA ${waMessageId} (DC ${discordMessageId})...`);

    const deletedEmbed = new EmbedBuilder()
      .setColor(0x95a5a6)
      .setDescription('🗑️ *Este mensaje fue eliminado en WhatsApp.*')
      .setFooter({ text: 'WhatsApp Relay • Mensaje eliminado' })
      .setTimestamp(new Date());

    try {
      if (mapping.webhook_url) {
        await discordService.editWebhookMessage(mapping.webhook_url, discordMessageId, {
          content: '🗑️ *[Mensaje eliminado en WhatsApp]*',
          embeds: [deletedEmbed],
          files: [],
        });
      } else if (mapping.discord_channel_id) {
        await discordService.editChannelMessage(mapping.discord_channel_id, discordMessageId, {
          content: '🗑️ *[Mensaje eliminado en WhatsApp]*',
          embeds: [deletedEmbed],
          files: [],
        });
      }
      console.log(`✅ [RelayEngine] Mensaje ${discordMessageId} actualizado a eliminado en Discord.`);
    } catch (err) {
      console.warn(`⚠️ [RelayEngine] No se pudo editar el mensaje ${discordMessageId} en Discord: ${err.message}. Intentando enviar aviso al canal...`);
      // Fallback: si no se pudo editar (ej: mensaje muy antiguo o borrado), enviar aviso en el canal
      try {
        if (mapping.discord_channel_id) {
          await discordService.sendMessage(mapping.discord_channel_id, {
            embeds: [deletedEmbed],
          });
        }
      } catch (sendErr) {
        console.error('[RelayEngine] Error enviando aviso de eliminación a Discord:', sendErr.message);
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
