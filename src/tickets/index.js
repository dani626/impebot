import { CONFIG } from '../config.js';
import { ticketRepository } from './TicketRepository.js';
import { ImpecraftClient } from './ImpecraftClient.js';
import { TicketService } from './TicketService.js';
import { whatsAppService } from '../services/WhatsAppService.js';
import { discordService } from '../services/DiscordService.js';
import { MessageTransformer } from '../relay/MessageTransformer.js';

// Una configuración incompleta nunca cambia silenciosamente a tickets locales.
const backend = CONFIG.tickets.enabled && (CONFIG.tickets.web.url || CONFIG.tickets.web.token)
  ? new ImpecraftClient(CONFIG.tickets.web) : ticketRepository;

export const ticketService = new TicketService({
  backend, repository: ticketRepository, whatsapp: whatsAppService, discord: discordService,
  config: { ...CONFIG.tickets, guildId: CONFIG.discord.guildId },
  transformMedia: (data) => MessageTransformer.toDiscord(data),
});
