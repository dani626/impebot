import { AttachmentBuilder, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { resolveCommandName } from '../utils/commands.js';
import { CATEGORIES, PRIORITIES, isPrivateJid, parseOpening, ticketError, validateBody, waEventId } from './model.js';
import { decide, PERMISSIONS } from '../luckperms/permissions.js';

export function ticketCommands() {
  const commands = [
    new SlashCommandBuilder().setName('responder').setDescription('Enviar una respuesta al jugador')
      .addStringOption((o) => o.setName('mensaje').setDescription('Texto visible para el jugador').setRequired(true).setMaxLength(4000))
      .addAttachmentOption((o) => o.setName('archivo').setDescription('Archivo visible para el jugador')),
    new SlashCommandBuilder().setName('nota').setDescription('Guardar una nota interna en el ticket')
      .addStringOption((o) => o.setName('mensaje').setDescription('Solo visible para el staff').setRequired(true).setMaxLength(5000)),
    ...[['tomar', 'Asignarme este ticket'], ['soltar', 'Dejar este ticket sin asignar'],
      ['cerrar', 'Cerrar este ticket'], ['reabrir', 'Reabrir este ticket']]
      .map(([name, description]) => new SlashCommandBuilder().setName(name).setDescription(description)),
    new SlashCommandBuilder().setName('prioridad').setDescription('Cambiar la prioridad del ticket')
      .addStringOption((o) => o.setName('valor').setDescription('Prioridad').setRequired(true)
        .addChoices(...PRIORITIES.map((value) => ({ name: value, value })))),
  ];
  return commands.map((command) => command.toJSON());
}

const TICKET_COMMANDS = new Set(['ticket', 'tickets', 'responder', 'cerrar', 'vincular', 'cancelar']);
const COMMAND_NAMES = new Set(['responder', 'nota', 'tomar', 'soltar', 'cerrar', 'reabrir', 'prioridad']);
const STATUS_LABEL = { OPEN: 'Abierto', PENDING: 'Esperando tu respuesta', CLOSED: 'Cerrado' };
const splitText = (text, max = 1900) => text.match(new RegExp(`[\\s\\S]{1,${max}}`, 'g')) || [];

export class TicketService {
  constructor({ backend, repository, whatsapp, discord, config, transformMedia, permissions = async () => undefined }) {
    // permissions(discordUserId, node) → true/false/undefined (LuckPerms)
    Object.assign(this, { backend, repository, whatsapp, discord, config, transformMedia, permissions });
    this.queues = new Map();
    this.wizards = new Map();
    this.running = false;
    this.timer = null;
    this.polling = null;
    this.onInteraction = (interaction) => void this.handleInteraction(interaction).catch((err) => console.error('[Tickets] Interacción:', err.message));
    this.onReady = () => {
      void this.discord.registerTicketCommands(ticketCommands()).catch((err) => console.error('[Tickets] Registro de comandos:', err.message));
      void this.poll().catch((err) => console.error('[Tickets] Sincronización:', err.message));
    };
  }

  key(ticket) { return `${this.backend.name}:${ticket.id}`; }

  async serial(key, work) {
    const previous = this.queues.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(work);
    this.queues.set(key, next);
    try { return await next; }
    finally { if (this.queues.get(key) === next) this.queues.delete(key); }
  }

  start() {
    if (!this.config.enabled || this.running) return;
    this.running = true;
    this.discord.on('interaction', this.onInteraction);
    this.discord.on('ready', this.onReady);
    this.timer = setInterval(() => {
      for (const [jid, wizard] of this.wizards) if (wizard.expires < Date.now()) this.wizards.delete(jid);
      void this.poll().catch((err) => console.error('[Tickets] Sincronización pendiente:', err.message));
    }, this.config.pollIntervalMs);
    this.timer.unref?.();
    if (this.discord.isReady) this.onReady();
  }

  async stop() {
    this.running = false;
    clearInterval(this.timer);
    this.discord.off('interaction', this.onInteraction);
    this.discord.off('ready', this.onReady);
    await Promise.allSettled([...this.queues.values(), ...(this.polling ? [this.polling] : [])]);
    this.wizards.clear();
  }

  async poll() {
    if (!this.running || !this.discord.isReady || this.polling) return this.polling;
    this.polling = (async () => {
      let after = 0;
      while (this.running) {
        const tickets = await this.backend.list({ after });
        for (const ticket of tickets) {
          try { await this.serial(`ticket:${ticket.number}`, () => this.sync(ticket)); }
          catch (err) { console.error(`[Tickets] Ticket #${ticket.number} pendiente:`, err.message); }
        }
        if (tickets.length < 50) break;
        after = tickets.at(-1).number;
      }
    })();
    try { await this.polling; }
    finally { this.polling = null; }
  }

  async sendDiscord(channelId, text) {
    for (const content of splitText(text)) {
      await this.discord.sendMessage(channelId, { content, allowedMentions: { parse: [] } });
    }
  }

  async sync(ticket) {
    // Un sondeo pudo esperar detrás de un comando: no aplicar su instantánea antigua.
    ticket = await this.backend.get(ticket.number);
    const key = this.key(ticket);
    let route = await this.repository.route(key);
    const fresh = !route;
    // Los tickets históricos cerrados se conservan en su backend; no llenan Discord al instalar.
    if (fresh && ticket.status === 'CLOSED') return;
    if (!route) {
      const channel = await this.discord.createTicketChannel(ticket);
      try {
        await this.repository.saveRoute(key, ticket, channel.id);
      } catch (err) {
        await channel.delete('No se pudo persistir el ticket').catch(() => {});
        throw err;
      }
      route = await this.repository.route(key);
    } else {
      await this.repository.saveRoute(key, ticket, route.discord_channel_id);
    }
    if (!(await this.repository.delivered(key, 'header', 'discord'))) {
      const url = this.backend.name === 'web' ? `\n${new URL(`/staff/tickets/${ticket.number}`, this.config.web.url).href}` : '';
      await this.sendDiscord(route.discord_channel_id,
        `🎫 Ticket #${ticket.number}: ${ticket.subject}\nJugador: ${ticket.user.username}\nCategoría: ${ticket.category}${url}\n/responder envía al jugador. /nota guarda una nota interna. El chat normal se queda en Discord.`);
      await this.repository.markDelivered(key, 'header', 'discord');
    }
    for (const message of ticket.messages) {
      if (!(await this.repository.delivered(key, message.id, 'discord'))) {
        await this.sendDiscord(route.discord_channel_id,
          `${message.internal ? '🔒 Nota interna' : '💬 Mensaje'} · ${message.author?.username || 'Sistema'}:\n${message.body}`);
        await this.repository.markDelivered(key, message.id, 'discord');
      }
      if (await this.repository.delivered(key, message.id, 'whatsapp')) continue;
      const isOwnerMessage = message.author?.id === ticket.user.id;
      // La decisión usa internal, no el rol del autor: un jugador puede pertenecer al staff.
      const predatesLink = Date.parse(message.createdAt) < Date.parse(ticket.whatsappLinkedAt || ticket.createdAt);
      if (message.internal || isOwnerMessage || !message.author || !ticket.whatsappJid || predatesLink) {
        await this.repository.markDelivered(key, message.id, 'whatsapp');
        continue;
      }
      if (!this.whatsapp.isReady) continue;
      await this.whatsapp.sendMessage(ticket.whatsappJid, { text: `🎫 Ticket #${ticket.number} · ${message.author.username}\n${message.body}` });
      await this.repository.markDelivered(key, message.id, 'whatsapp');
    }
    const meta = `${ticket.status}|${ticket.priority}|${ticket.assignee?.id || ''}`;
    if (route.last_status !== ticket.status || route.last_meta !== meta) {
      const stateId = `state:${ticket.updatedAt || ticket.createdAt}:${meta}`;
      if (!(await this.repository.delivered(key, stateId, 'discord'))) {
        await this.sendDiscord(route.discord_channel_id,
          `Estado: ${STATUS_LABEL[ticket.status]} · Prioridad: ${ticket.priority} · Responsable: ${ticket.assignee?.username || 'Sin asignar'}`);
        await this.repository.markDelivered(key, stateId, 'discord');
      }
      if (!fresh && route.last_status !== ticket.status && ticket.whatsappJid && this.whatsapp.isReady) {
        await this.whatsapp.sendMessage(ticket.whatsappJid, { text: `🎫 Ticket #${ticket.number}: ${STATUS_LABEL[ticket.status]}.` });
      }
      // Se reintenta la notificación si WhatsApp está desconectado.
      if (fresh || !ticket.whatsappJid || this.whatsapp.isReady) await this.repository.setRouteStatus(key, ticket.status, meta);
    }
  }

  async ownedTickets(jid) {
    const result = [];
    let after = 0;
    for (;;) {
      const page = await this.backend.list({ jid, after });
      result.push(...page);
      if (page.length < 50) return result;
      after = page.at(-1).number;
    }
  }

  async selectOwned(jid, number) {
    if (number) {
      const ticket = await this.backend.get(number);
      if (ticket.whatsappJid !== jid) throw ticketError('Ticket no encontrado.', 404);
      return ticket;
    }
    const active = (await this.ownedTickets(jid)).filter((t) => t.status !== 'CLOSED');
    if (active.length !== 1) throw ticketError(active.length ? 'Tienes varios tickets. Usa !responder NUMERO | mensaje o !cerrar NUMERO.' : 'No tienes tickets abiertos. Usa !ticket.');
    return active[0];
  }

  async handleWhatsApp(data) {
    if (!this.config.enabled || !isPrivateJid(data.jid)) return false;
    if (data.isFromMe) return true;
    // El bloqueo evita que dos mensajes simultáneos creen dos canales o avancen dos pasos.
    await this.serial(`wa:${data.jid}`, async () => {
      try { await this.processWhatsApp(data); }
      catch (err) {
        const text = err.status && err.status < 500 ? err.message : 'El soporte no está disponible ahora. Tu mensaje no se ha confirmado; vuelve a intentarlo.';
        await this.whatsapp.sendMessage(data.jid, { text }).catch(() => {});
        if (!err.status || err.status >= 500) console.error('[Tickets] Mensaje pendiente:', err.message);
      }
    });
    return true;
  }

  async processWhatsApp(data) {
    const { jid, text = '', pushName = 'Jugador', messageId, timestamp } = data;
    if (!messageId) return;
    // Acepta los alias en español e inglés (reply, close, link, cancel, mytickets...).
    const match = text.trim().match(/^[!/.]([^\s]+)\s*([\s\S]*)$/);
    const resolved = match ? resolveCommandName(match[1]) : null;
    const command = TICKET_COMMANDS.has(resolved) ? resolved : undefined;
    const rest = command ? match[2].trim() : '';
    // No se ejecutan comandos recuperados del historial.
    if (command && timestamp && Date.now() / 1000 - timestamp > 180) return;
    const reply = (value) => this.whatsapp.sendMessage(jid, { text: value });
    const actor = { id: jid, username: pushName, role: 'USER', platform: 'whatsapp' };
    if (command === 'vincular') {
      if (!this.backend.link) throw ticketError('La integración con la web no está configurada.');
      const linked = await this.backend.link(jid, rest);
      await reply(`Cuenta vinculada: ${linked.username}. Usa !ticket para abrir un caso.`);
      return;
    }
    if (command === 'cancelar') { this.wizards.delete(jid); await reply('Apertura cancelada.'); return; }
    if (command === 'tickets') {
      const tickets = await this.ownedTickets(jid);
      await reply(tickets.length ? tickets.slice(-20).map((t) => `#${t.number} · ${STATUS_LABEL[t.status]} · ${t.subject}`).join('\n') : 'No tienes tickets. Usa !ticket.');
      return;
    }
    if (command === 'ticket') {
      if (!rest) {
        if (this.wizards.size >= 1000 && !this.wizards.has(jid)) throw ticketError('Hay muchas solicitudes. Inténtalo más tarde.', 429);
        this.wizards.set(jid, { step: 'category', expires: Date.now() + 600000 });
        await reply(`🎫 ¿Qué necesitas? Envía una categoría:\n${CATEGORIES.join(', ')}\n\n!cancelar cancela la apertura.`);
        return;
      }
      await this.open(data, parseOpening(rest));
      this.wizards.delete(jid);
      return;
    }
    if (command === 'cerrar') {
      if (rest && !/^\d+$/.test(rest)) throw ticketError('Usa !cerrar NUMERO.');
      const ticket = await this.selectOwned(jid, Number(rest) || undefined);
      await this.serial(`ticket:${ticket.number}`, async () => {
        const updated = await this.backend.update(ticket.number, { status: 'CLOSED' }, actor);
        await this.sync(updated);
      });
      await reply(`Ticket #${ticket.number} cerrado.`);
      return;
    }
    let body = text;
    let number;
    if (command === 'responder') {
      const response = rest.match(/^(\d+)\s*\|\s*([\s\S]+)$/);
      if (!response) throw ticketError('Usa !responder NUMERO | mensaje.');
      number = Number(response[1]); body = response[2].trim();
    } else if (/^[!/.]\S+/.test(text)) return; // El manejador existente procesa stickers y ayuda.
    const wizard = this.wizards.get(jid);
    if (wizard && timestamp && Date.now() / 1000 - timestamp > 180) return;
    if (!command && wizard && wizard.expires > Date.now()) {
      if (wizard.step === 'category') {
        const category = text.toLowerCase().trim();
        if (!CATEGORIES.includes(category)) throw ticketError(`Elige: ${CATEGORIES.join(', ')}.`);
        Object.assign(wizard, { category, step: 'subject' });
        await reply('Escribe un asunto de entre 5 y 150 caracteres.');
      } else if (wizard.step === 'subject') {
        if (text.trim().length < 5 || text.trim().length > 150) throw ticketError('El asunto debe tener entre 5 y 150 caracteres.');
        Object.assign(wizard, { subject: text.trim(), step: 'message' });
        await reply('Describe el problema (máximo 5000 caracteres).');
      } else {
        await this.open(data, { category: wizard.category, subject: wizard.subject, message: text });
        this.wizards.delete(jid);
      }
      return;
    }
    this.wizards.delete(jid);
    const ticket = await this.selectOwned(jid, number);
    await this.serial(`ticket:${ticket.number}`, async () => {
      const eventId = waEventId(jid, messageId);
      if (await this.repository.delivered(this.key(ticket), eventId, 'incoming')) return;
      // Se comprueba la propiedad antes de descargar o publicar un archivo.
      if (!body && !data.rawMessage?.message) return;
      let media = null;
      if (this.transformMedia && data.rawMessage) {
        media = await this.transformMedia(data);
        if (media.pendingCatboxVideo) media.files.push(new AttachmentBuilder(media.pendingCatboxVideo.buffer, { name: media.pendingCatboxVideo.fileName }));
      }
      if (media?.files.length) {
        await this.sync(ticket);
        const route = await this.repository.route(this.key(ticket));
        const sent = await this.discord.sendMessage(route.discord_channel_id, { content: `📎 Archivo de ${ticket.user.username}`, files: media.files, allowedMentions: { parse: [] } });
        const urls = [...sent.attachments.values()].map((a) => a.url);
        body = [body, ...urls].filter(Boolean).join('\n');
      }
      validateBody(body);
      const updated = await this.backend.message(ticket.number, { body, actor, eventId });
      await this.repository.markDelivered(this.key(ticket), eventId, 'incoming');
      await this.sync(updated).catch((err) => console.error('[Tickets] Entrega pendiente:', err.message));
    });
  }

  async open(data, opening) {
    const ticket = await this.backend.create({ ...opening, jid: data.jid, username: data.pushName || 'Jugador', eventId: waEventId(data.jid, data.messageId) });
    // La confirmación de creación es independiente de la disponibilidad de Discord.
    await this.whatsapp.sendMessage(data.jid, { text: `🎫 Ticket #${ticket.number} abierto: ${ticket.subject}.\nEscribe aquí para continuar. !cerrar ${ticket.number} para cerrarlo.` });
    await this.serial(`ticket:${ticket.number}`, () => this.sync(ticket)).catch((err) => console.error('[Tickets] Canal pendiente de sincronizar:', err.message));
    return ticket;
  }

  async handleDiscord(message) {
    if (!this.config.enabled) return false;
    // Incluso un ticket cerrado nunca cae al relay bidireccional.
    return Boolean(await this.repository.routeByChannel(message.channelId));
  }

  async handleInteraction(interaction) {
    if (!interaction.isChatInputCommand() || !COMMAND_NAMES.has(interaction.commandName)) return;
    await interaction.deferReply({ flags: 64 });
    try {
      if (interaction.guildId !== this.config.guildId) throw ticketError('Servidor no autorizado.', 403);
      // Se consultan roles actuales, no los de una caché de interacciones anterior.
      const member = await interaction.guild.members.fetch(interaction.user.id);
      const byRole = member.permissions.has(PermissionFlagsBits.ManageGuild) || this.config.staffRoleIds.some((id) => member.roles.cache.has(id));
      const byLuckPerms = await this.permissions(interaction.user.id, PERMISSIONS.ticketsStaff.node).catch(() => undefined);
      if (!decide(PERMISSIONS.ticketsStaff, byLuckPerms, { fallback: byRole })) throw ticketError('Necesitas un rol de soporte.', 403);
      const route = await this.repository.routeByChannel(interaction.channelId);
      if (!route || !route.ticket_key.startsWith(`${this.backend.name}:`)) throw ticketError('Este canal no pertenece al modo de tickets activo.');
      const actor = { id: interaction.user.id, username: member.displayName, role: member.permissions.has(PermissionFlagsBits.ManageGuild) ? 'MODERATOR' : 'HELPER', platform: 'discord' };
      await this.serial(`ticket:${route.ticket_number}`, async () => {
        let ticket;
        if (interaction.commandName === 'responder' || interaction.commandName === 'nota') {
          let body = interaction.options.getString('mensaje', true);
          const attachment = interaction.commandName === 'responder' ? interaction.options.getAttachment('archivo') : null;
          if (attachment) body += `\n${attachment.url}`;
          ticket = await this.backend.message(route.ticket_number, { body, internal: interaction.commandName === 'nota', actor, eventId: `dc:${interaction.id}` });
        } else {
          const changes = {
            tomar: { assigneeId: 'me' }, soltar: { assigneeId: null },
            cerrar: { status: 'CLOSED' }, reabrir: { status: 'OPEN' },
            prioridad: { priority: interaction.options.getString('valor') },
          }[interaction.commandName];
          ticket = await this.backend.update(route.ticket_number, changes, actor);
        }
        await interaction.editReply('Guardado. La sincronización entregará las notificaciones pendientes.');
        await this.sync(ticket).catch((err) => console.error('[Tickets] Entrega pendiente:', err.message));
      });
    } catch (err) {
      await interaction.editReply(err.status && err.status < 500 ? err.message : 'No se pudo confirmar la operación. Consulta el ticket antes de repetirla.');
      if (!err.status || err.status >= 500) console.error('[Tickets] Comando:', err.message);
    }
  }
}
