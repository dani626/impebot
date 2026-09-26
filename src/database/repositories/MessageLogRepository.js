import { messageMappingRepository } from './MessageMappingRepository.js';

/**
 * @deprecated Use messageMappingRepository instead.
 * Mantenido temporalmente por retrocompatibilidad.
 */
export class MessageLogRepository {
  async exists(waMessageId = null, discordMessageId = null) {
    return await messageMappingRepository.exists(waMessageId, discordMessageId);
  }

  async getByWaMessageId(waMessageId) {
    return await messageMappingRepository.getByWaMessageId(waMessageId);
  }

  async getByDiscordMessageId(discordMessageId) {
    return await messageMappingRepository.getByDiscordMessageId(discordMessageId);
  }

  async logMessage(waMessageId, discordMessageId, channelMappingId, direction) {
    const originPlatform = direction === 'wa_to_discord' ? 'whatsapp' : 'discord';
    return await messageMappingRepository.save({
      waMessageId,
      discordMessageId,
      channelMappingId,
      originPlatform,
    });
  }

  async cleanup() {
    // Ya no se eliminan registros para preservar punteros históricos
    return 0;
  }
}

export const messageLogRepository = new MessageLogRepository();
