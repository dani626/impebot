import { CONFIG } from '../config.js';
import { ticketRepository } from './TicketRepository.js';
import { ticketConfigRepository } from './TicketConfigRepository.js';
import { ImpecraftClient } from './ImpecraftClient.js';
import { TicketService } from './TicketService.js';
import { whatsAppService } from '../services/WhatsAppService.js';
import { discordService } from '../services/DiscordService.js';
import { MessageTransformer } from '../relay/MessageTransformer.js';
import { luckPermsService } from '../luckperms/LuckPermsService.js';
import { linkVerifiedAccount } from '../luckperms/accountCommands.js';

// Una configuración incompleta nunca cambia silenciosamente a tickets locales.
const backend = CONFIG.tickets.enabled && (CONFIG.tickets.web.url || CONFIG.tickets.web.token)
  ? new ImpecraftClient(CONFIG.tickets.web) : ticketRepository;

export const ticketService = new TicketService({
  backend, repository: ticketRepository, whatsapp: whatsAppService, discord: discordService,
  // Tickets locales de reserva en modo web: solo si un servidor pone requerir_web en false.
  configRepository: ticketConfigRepository, localRepository: ticketRepository,
  config: {
    ...CONFIG.tickets, guildId: CONFIG.discord.guildId, extraGuildIds: CONFIG.discord.extraGuildIds,
    staffIds: CONFIG.moderation.staff, gameCodes: CONFIG.luckperms.enabled,
  },
  transformMedia: (data) => MessageTransformer.toDiscord(data),
  permissions: (platform, ids, node) => luckPermsService.check(platform, ids, node),
  onLinked: (account) => linkVerifiedAccount(account),
});
