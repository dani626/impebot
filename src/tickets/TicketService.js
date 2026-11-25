import { AttachmentBuilder, ChannelType, PermissionFlagsBits, SlashCommandBuilder } from 'discord.js';
import { resolveCommandName } from '../utils/commands.js';
import {
  CATEGORIES, PRIORITIES, PRIORITY_META, isPrivateJid, normalizeSlug, parseOpening, priorityChannelName,
  sanitizeChannelName, ticketError, validateBody, validateTicket, waEventId,
} from './model.js';
import { commandLogService } from '../services/CommandLogService.js';
import { decide, PERMISSIONS, TICKET_PLAYER_PERMISSIONS, UNAVAILABLE, whatsappSenderIds } from '../luckperms/permissions.js';
import { GUILD_DEFAULTS } from './TicketConfigRepository.js';
import { buildControlMessage, buildDeleteConfirmRow, buildOpenModal, buildPanelMessage } from './ui.js';
import { generateTranscript } from './transcript.js';

const BUTTON_STYLES = ['Primary', 'Secondary', 'Success', 'Danger'];
const priorityChoices = PRIORITIES.map((value) => ({ name: value, value }));

/** Opciones comunes de /ticket categoria crear|editar. */
function categoryOptions(s, { create }) {
  s.addStringOption((o) => o.setName('slug').setDescription('Identificador (a-z, 0-9, -)').setRequired(true).setMaxLength(40));
  if (create) s.addStringOption((o) => o.setName('nombre').setDescription('Texto del botón o de la opción').setRequired(true).setMaxLength(80));
  else s.addStringOption((o) => o.setName('nombre').setDescription('Texto del botón o de la opción').setMaxLength(80));
  s.addStringOption((o) => o.setName('base').setDescription('Categoría equivalente en la web').addChoices(...CATEGORIES.map((c) => ({ name: c, value: c }))))
    .addStringOption((o) => o.setName('descripcion').setDescription('Subtítulo en el menú desplegable').setMaxLength(100))
    .addStringOption((o) => o.setName('emoji').setDescription('Emoji Unicode o <:nombre:id>').setMaxLength(64))
    .addStringOption((o) => o.setName('estilo').setDescription('Color del botón').addChoices(...BUTTON_STYLES.map((v) => ({ name: v, value: v }))))
    .addChannelOption((o) => o.setName('categoria_canales').setDescription('Categoría de Discord donde se crean los canales').addChannelTypes(ChannelType.GuildCategory));
  if (create) s.addRoleOption((o) => o.setName('rol_staff').setDescription('Rol de staff de esta categoría'));
  else {
    s.addRoleOption((o) => o.setName('rol_staff_agregar').setDescription('Añadir un rol de staff'))
      .addRoleOption((o) => o.setName('rol_staff_quitar').setDescription('Quitar un rol de staff'));
  }
  s.addStringOption((o) => o.setName('prioridad').setDescription('Prioridad inicial').addChoices(...priorityChoices))
    .addBooleanOption((o) => o.setName('ping_roles').setDescription('Mencionar a los roles al abrir o escalar'));
  if (!create) {
    s.addBooleanOption((o) => o.setName('activa').setDescription('Mostrar en los paneles'))
      .addIntegerOption((o) => o.setName('orden').setDescription('Orden en los paneles').setMinValue(-1000).setMaxValue(1000));
  }
  return s.addStringOption((o) => o.setName('mensaje_bienvenida').setDescription('Texto extra en el mensaje del ticket').setMaxLength(1000));
}

function panelOptions(s) {
  return s.addStringOption((o) => o.setName('modo').setDescription('Botones o menú desplegable').addChoices({ name: 'botones', value: 'buttons' }, { name: 'menú', value: 'select' }))
    .addStringOption((o) => o.setName('color').setDescription('Color del embed, p. ej. #5865F2').setMaxLength(7))
    .addStringOption((o) => o.setName('categorias').setDescription('Slugs separados por comas (vacío = todas)').setMaxLength(500));
}

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
      .addStringOption((o) => o.setName('valor').setDescription('Prioridad').setRequired(true).addChoices(...priorityChoices)),
    new SlashCommandBuilder().setName('ticket').setDescription('Tickets de Discord: configuración, paneles y gestión')
      .addSubcommandGroup((g) => g.setName('config').setDescription('Configuración de tickets del servidor')
        .addSubcommand((s) => s.setName('ver').setDescription('Ver la configuración y las categorías'))
        .addSubcommand((s) => s.setName('editar').setDescription('Cambiar la configuración del servidor')
          .addChannelOption((o) => o.setName('categoria_canales').setDescription('Categoría de Discord por defecto').addChannelTypes(ChannelType.GuildCategory))
          .addChannelOption((o) => o.setName('canal_logs').setDescription('Canal de logs y transcripciones').addChannelTypes(ChannelType.GuildText))
          .addStringOption((o) => o.setName('formato_transcripcion').setDescription('Formato de las transcripciones').addChoices({ name: 'html', value: 'html' }, { name: 'txt', value: 'txt' }))
          .addIntegerOption((o) => o.setName('max_abiertos').setDescription('Tickets abiertos por usuario').setMinValue(1).setMaxValue(20))
          .addRoleOption((o) => o.setName('rol_staff_agregar').setDescription('Añadir un rol de staff global'))
          .addRoleOption((o) => o.setName('rol_staff_quitar').setDescription('Quitar un rol de staff global'))
          .addBooleanOption((o) => o.setName('renombrar_prioridad').setDescription('Prefijo de prioridad en el nombre del canal'))
          .addIntegerOption((o) => o.setName('delay_borrado').setDescription('Segundos antes de borrar un canal').setMinValue(0).setMaxValue(60))
          .addBooleanOption((o) => o.setName('requerir_web').setDescription('Modo web: exigir cuenta vinculada (si no, ticket local)'))))
      .addSubcommandGroup((g) => g.setName('categoria').setDescription('Categorías de tickets')
        .addSubcommand((s) => categoryOptions(s.setName('crear').setDescription('Crear una categoría'), { create: true }))
        .addSubcommand((s) => categoryOptions(s.setName('editar').setDescription('Editar una categoría'), { create: false }))
        .addSubcommand((s) => s.setName('eliminar').setDescription('Eliminar una categoría')
          .addStringOption((o) => o.setName('slug').setDescription('Identificador').setRequired(true).setMaxLength(40)))
        .addSubcommand((s) => s.setName('listar').setDescription('Listar las categorías')))
      .addSubcommandGroup((g) => g.setName('panel').setDescription('Paneles de apertura')
        .addSubcommand((s) => panelOptions(s.setName('enviar').setDescription('Publicar un panel de apertura')
          .addChannelOption((o) => o.setName('canal').setDescription('Canal del panel').setRequired(true).addChannelTypes(ChannelType.GuildText))
          .addStringOption((o) => o.setName('titulo').setDescription('Título').setRequired(true).setMaxLength(256))
          .addStringOption((o) => o.setName('descripcion').setDescription('Descripción').setRequired(true).setMaxLength(4000))))
        .addSubcommand((s) => panelOptions(s.setName('actualizar').setDescription('Editar un panel publicado')
          .addStringOption((o) => o.setName('message_id').setDescription('ID del mensaje del panel').setRequired(true).setMaxLength(24))
          .addStringOption((o) => o.setName('titulo').setDescription('Título').setMaxLength(256))
          .addStringOption((o) => o.setName('descripcion').setDescription('Descripción').setMaxLength(4000)))))
      .addSubcommand((s) => s.setName('add').setDescription('Dar acceso a este ticket')
        .addUserOption((o) => o.setName('usuario').setDescription('Usuario')).addRoleOption((o) => o.setName('rol').setDescription('Rol')))
      .addSubcommand((s) => s.setName('remove').setDescription('Quitar acceso a este ticket')
        .addUserOption((o) => o.setName('usuario').setDescription('Usuario')).addRoleOption((o) => o.setName('rol').setDescription('Rol')))
      .addSubcommand((s) => s.setName('transcripcion').setDescription('Enviar la transcripción al canal de logs'))
      .addSubcommand((s) => s.setName('renombrar').setDescription('Renombrar el canal del ticket')
        .addStringOption((o) => o.setName('nombre').setDescription('Nuevo nombre').setRequired(true).setMaxLength(90))),
  ];
  return commands.map((command) => command.toJSON());
}

const TICKET_COMMANDS = new Set(['ticket', 'tickets', 'responder', 'cerrar', 'vincular', 'cancelar']);
const COMMAND_NAMES = new Set(['responder', 'nota', 'tomar', 'soltar', 'cerrar', 'reabrir', 'prioridad']);
const STATUS_LABEL = { OPEN: 'Abierto', PENDING: 'Esperando tu respuesta', CLOSED: 'Cerrado' };
const ACTION_CHANGES = { claim: { assigneeId: 'me' }, release: { assigneeId: null }, close: { status: 'CLOSED' }, reopen: { status: 'OPEN' } };
const EMOJI_RE = /^(<a?:\w{2,32}:\d{16,24}>|\p{Extended_Pictographic}[\p{Extended_Pictographic}\u200d\ufe0f\p{Emoji_Modifier}]*)$/u;
const RENAME_COOLDOWN_MS = 5 * 60 * 1000;
const splitText = (text, max = 1900) => text.match(new RegExp(`[\\s\\S]{1,${max}}`, 'g')) || [];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const errorText = (err) => (err.status && err.status < 500 ? err.message : 'No se pudo confirmar la operación. Consulta el ticket antes de repetirla.');

export class TicketService {
  /**
   * @param {object} deps
   * @param {(platform: 'whatsapp'|'discord', ids: string[], node: string) => Promise<object>} [deps.permissions] LuckPerms
   * @param {(account: { ids: string[], username: string, minecraftUuid?: string }) => Promise<{ player, linked }>} [deps.onLinked]
   *   guarda en LuckPerms el vínculo verificado por la web
   * @param {import('./TicketConfigRepository.js').TicketConfigRepository} [deps.configRepository] configuración por servidor
   * @param {import('./TicketRepository.js').TicketRepository} [deps.localRepository] tickets locales de reserva en modo web
   */
  constructor({
    backend, repository, whatsapp, discord, config, transformMedia, configRepository = null, localRepository = null,
    permissions = async () => UNAVAILABLE, onLinked = async () => ({ player: null, linked: false }),
  }) {
    Object.assign(this, { backend, repository, whatsapp, discord, config, transformMedia, permissions, onLinked, configRepository, localRepository });
    this.queues = new Map();
    this.wizards = new Map();
    /** Tickets de Discord entre backend.create() y saveRoute(): sync() no les crea otro canal. */
    this.opening = new Set();
    this.running = false;
    this.timer = null;
    this.polling = null;
    this.onInteraction = (interaction) => void this.handleInteraction(interaction).catch((err) => console.error('[Tickets] Interacción:', err.message));
    this.onReady = () => {
      void this.discord.registerTicketCommands(ticketCommands()).catch((err) => console.error('[Tickets] Registro de comandos:', err.message));
      void this.poll().catch((err) => console.error('[Tickets] Sincronización:', err.message));
    };
  }

  key(ticket, backend = this.backend) { return `${backend.name}:${ticket.id}`; }

  /** Cola por ticket: incluye el backend para que web #1 y local #1 no compartan cola. */
  lockKey(backend, number) { return `ticket:${backend.name}:${number}`; }
  routeLock(route) { return `ticket:${route.ticket_key.split(':')[0]}:${route.ticket_number}`; }

  /** Backend dueño de una ruta: el activo o, en modo web, el local de reserva. */
  backendFor(key) {
    if (key?.startsWith(`${this.backend.name}:`)) return this.backend;
    if (this.localRepository && key?.startsWith(`${this.localRepository.name}:`)) return this.localRepository;
    return null;
  }

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
          try { await this.serial(this.lockKey(this.backend, ticket.number), () => this.sync(ticket)); }
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

  // ── Configuración por servidor ──

  async guildConfig(guildId) {
    return this.configRepository ? this.configRepository.guild(guildId) : { guildId, ...GUILD_DEFAULTS, staffRoleIds: [] };
  }

  guildAllowed(guildId) {
    const ids = [this.config.guildId, ...(this.config.extraGuildIds || [])].filter(Boolean);
    return Boolean(guildId) && (!ids.length || ids.includes(guildId));
  }

  /** Roles de staff de un ticket: los del .env (solo servidor principal) + los del servidor + los de su categoría. */
  staffRoleIds(guildId, cfg, category) {
    return [...new Set([...(guildId === this.config.guildId ? this.config.staffRoleIds || [] : []), ...(cfg?.staffRoleIds || []), ...(category?.staffRoleIds || [])])];
  }

  /** Permisos actuales (no los de una caché anterior) de un miembro sobre los tickets de una categoría. */
  async access(guild, userId, { categoryId } = {}) {
    const member = await guild.members.fetch(userId);
    const cfg = await this.guildConfig(guild.id);
    const category = categoryId && this.configRepository ? await this.configRepository.category(categoryId) : null;
    const staffRoleIds = this.staffRoleIds(guild.id, cfg, category);
    const manage = member.permissions.has(PermissionFlagsBits.ManageGuild);
    const byRole = manage || staffRoleIds.some((id) => member.roles.cache.has(id));
    const lp = await this.permissions('discord', [userId], PERMISSIONS.ticketsStaff.node).catch(() => UNAVAILABLE);
    return {
      member, cfg, category, staffRoleIds, manage,
      staff: decide(PERMISSIONS.ticketsStaff, lp, { fallback: byRole }),
      actor: { id: userId, username: member.displayName, role: manage ? 'MODERATOR' : 'HELPER', platform: 'discord' },
    };
  }

  async isAdmin(guild, userId) {
    const member = await guild.members.fetch(userId);
    const lp = await this.permissions('discord', [userId], PERMISSIONS.ticketsAdmin.node).catch(() => UNAVAILABLE);
    return decide(PERMISSIONS.ticketsAdmin, lp, { fallback: member.permissions.has(PermissionFlagsBits.ManageGuild) });
  }

  // ── Sincronización backend → Discord / WhatsApp ──

  async controlPayload(ticket, route, backend) {
    const category = route.category_id && this.configRepository ? await this.configRepository.category(route.category_id) : null;
    const webUrl = backend.name === 'web' && route.origin !== 'discord' ? new URL(`/staff/tickets/${ticket.number}`, this.config.web.url).href : null;
    return buildControlMessage(ticket, { route, category, webUrl });
  }

  async postControl(key, route, ticket, backend) {
    const sent = await this.discord.sendMessage(route.discord_channel_id, await this.controlPayload(ticket, route, backend));
    await sent.pin?.().catch(() => {});
    if (sent.id) await this.repository.setControlMessage(key, sent.id);
    route.control_message_id = sent.id;
  }

  async sync(ticket, backend = this.backend) {
    // Un sondeo pudo esperar detrás de un comando: no aplicar su instantánea antigua.
    ticket = await backend.get(ticket.number);
    const key = this.key(ticket, backend);
    let route = await this.repository.route(key);
    // Un canal borrado no se recrea ni recibe mensajes.
    if (route?.channel_deleted) return;
    // Su apertura desde un panel aún está creando el canal.
    if (!route && this.opening.has(key)) return;
    const fresh = !route;
    // Los tickets históricos cerrados se conservan en su backend; no llenan Discord al instalar.
    if (fresh && ticket.status === 'CLOSED') return;
    if (!route) {
      const mainCfg = await this.guildConfig(this.config.guildId);
      const channel = await this.discord.createTicketChannel(ticket, { staffRoleIds: this.staffRoleIds(this.config.guildId, mainCfg, null) });
      try {
        await this.repository.saveRoute(key, ticket, channel.id, { guildId: this.config.guildId || null, origin: backend.name === 'web' ? 'web' : 'whatsapp' });
      } catch (err) {
        await channel.delete('No se pudo persistir el ticket').catch(() => {});
        throw err;
      }
      route = await this.repository.route(key);
    } else {
      await this.repository.saveRoute(key, ticket, route.discord_channel_id);
    }
    const discordOrigin = route.origin === 'discord';
    // Mensaje fijado con botones; también en canales anteriores, salvo los que ya estaban cerrados.
    let controlPosted = false;
    if (!route.control_message_id && !(ticket.status === 'CLOSED' && route.last_status === 'CLOSED')) {
      await this.postControl(key, route, ticket, backend);
      controlPosted = true;
    }
    for (const message of ticket.messages) {
      if (!(await this.repository.delivered(key, message.id, 'discord'))) {
        // El jugador lee los canales de Discord: las notas internas nunca se publican allí.
        if (!(discordOrigin && message.internal)) {
          await this.sendDiscord(route.discord_channel_id,
            `${message.internal ? '🔒 Nota interna' : '💬 Mensaje'} · ${message.author?.username || 'Sistema'}:\n${message.body}`);
        }
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
        if (route.control_message_id && !controlPosted) {
          await this.discord.editChannelMessage(route.discord_channel_id, route.control_message_id, await this.controlPayload(ticket, route, backend))
            .catch(() => this.postControl(key, route, ticket, backend));
        }
        if (!fresh && route.last_status !== ticket.status) {
          await this.applyStatusEffects(route, ticket).catch((err) => console.error(`[Tickets] Ticket #${ticket.number}: permisos o transcripción:`, err.message));
        }
        await this.repository.markDelivered(key, stateId, 'discord');
      }
      if (!fresh && route.last_status !== ticket.status && ticket.whatsappJid && this.whatsapp.isReady) {
        await this.whatsapp.sendMessage(ticket.whatsappJid, { text: `🎫 Ticket #${ticket.number}: ${STATUS_LABEL[ticket.status]}.` });
      }
      // Se reintenta la notificación si WhatsApp está desconectado.
      if (fresh || !ticket.whatsappJid || this.whatsapp.isReady) await this.repository.setRouteStatus(key, ticket.status, meta);
    }
  }

  /** Al cerrar: bloquea la escritura del jugador y sus invitados y envía la transcripción. Al reabrir: la restaura. */
  async applyStatusEffects(route, ticket) {
    const closing = ticket.status === 'CLOSED';
    if (route.origin === 'discord' && (closing || route.last_status === 'CLOSED')) {
      const participants = this.configRepository ? await this.configRepository.participants(route.ticket_key) : [];
      const targets = [...(route.owner_discord_id ? [{ id: route.owner_discord_id, type: 'user' }] : []), ...participants.map((p) => ({ id: p.id, type: p.type }))];
      await (closing ? this.discord.lockTicketChannel(route.discord_channel_id, targets) : this.discord.unlockTicketChannel(route.discord_channel_id, targets));
    }
    if (closing) await this.sendTranscript(route, ticket, 'cerrado');
  }

  /** Sube la transcripción al canal de logs del servidor. Devuelve el enlace o null si no hay canal de logs. */
  async sendTranscript(route, ticket, reason) {
    const cfg = await this.guildConfig(route.guild_id || this.config.guildId);
    if (!cfg.logChannelId) return null;
    const channel = await this.discord.getChannel(route.discord_channel_id);
    const category = route.category_id && this.configRepository ? await this.configRepository.category(route.category_id) : null;
    const t = await generateTranscript({ channel, ticket, format: cfg.transcriptFormat, categoryLabel: category?.label });
    const sent = await this.discord.sendMessage(cfg.logChannelId, {
      content: `📄 Ticket #${ticket.number} (${reason}) · ${t.messageCount} mensajes · <#${route.discord_channel_id}>`,
      files: [new AttachmentBuilder(t.buffer, { name: t.fileName })],
      allowedMentions: { parse: [] },
    });
    return sent?.url || null;
  }

  // ── WhatsApp ──

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

  async selectOwned(jid, number, { implicit = false } = {}) {
    if (number) {
      const ticket = await this.backend.get(number);
      if (ticket.whatsappJid !== jid) throw ticketError('Ticket no encontrado.', 404);
      return ticket;
    }
    const active = (await this.ownedTickets(jid)).filter((t) => t.status !== 'CLOSED');
    if (implicit && active.length !== 1) return null;
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
    const senderIds = whatsappSenderIds(data.rawMessage || { key: { remoteJid: jid } });
    if (command === 'vincular') {
      // Los códigos del juego (8 cifras, /whatsapp link) los atiende el manejador de comandos (gameLink.js).
      // Sin LuckPerms nadie más los atiende y van a la web, que responde que el código no vale.
      if (/^\d{8}$/.test(rest) && this.config.gameCodes) return;
      // Único comando sin permiso: el código de la web demuestra de quién es la cuenta.
      if (!this.backend.link) throw ticketError('La integración con la web no está configurada.');
      const linked = await this.backend.link(jid, rest);
      let extra = '';
      try {
        const lp = await this.onLinked({ ids: senderIds, username: linked.username, minecraftUuid: linked.minecraftUuid });
        if (lp.linked) extra = `\n🎮 Minecraft: ${lp.player.username} (${lp.player.primaryGroup}). Ya puedes usar los comandos de tu rango.`;
        else if (lp.enabled) extra = `\n⚠️ ${linked.username} aún no ha entrado al servidor de Minecraft. Entra una vez y genera un código nuevo en la web para activar tu rango.`;
      } catch (err) {
        console.error('[Tickets] No se pudo guardar el vínculo en LuckPerms:', err.message);
        extra = '\n⚠️ No se pudo activar tu rango ahora. Genera un código nuevo en la web más tarde o pide a un admin que use !mcvincular.';
      }
      await reply(`Cuenta vinculada: ${linked.username}. Usa !ticket para abrir un caso.${extra}`);
      return;
    }
    const perm = TICKET_PLAYER_PERMISSIONS[command];
    if (perm) {
      const lp = await this.permissions('whatsapp', senderIds, perm.node).catch(() => UNAVAILABLE);
      const staff = senderIds.some((id) => (this.config.staffIds || []).includes(String(id).split('@')[0].split(':')[0]));
      if (!decide(perm, lp, { staff })) {
        // Sin permiso no se contesta en el chat: solo queda en la consola.
        commandLogService.log({ source: 'whatsapp', actorId: jid, actorName: pushName, chatId: jid, command: `!${command}`, args: rest, status: 'denegado', detail: `sin ${perm.node}` });
        return;
      }
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
      await this.serial(this.lockKey(this.backend, ticket.number), async () => {
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
    const ticket = await this.selectOwned(jid, number, { implicit: !command });
    if (!ticket) return;
    await this.serial(this.lockKey(this.backend, ticket.number), async () => {
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
    await this.serial(this.lockKey(this.backend, ticket.number), () => this.sync(ticket)).catch((err) => console.error('[Tickets] Canal pendiente de sincronizar:', err.message));
    return ticket;
  }

  // ── Mensajes en canales de ticket ──

  async handleDiscord(message) {
    if (!this.config.enabled) return false;
    const route = await this.repository.routeByChannel(message.channelId);
    // Incluso un ticket cerrado nunca cae al relay bidireccional.
    if (!route) return false;
    if (route.origin === 'discord' && !route.channel_deleted && !message.author?.bot && !message.webhookId) {
      await this.serial(this.routeLock(route), () => this.persistChannelMessage(route, message))
        .catch((err) => console.error(`[Tickets] Mensaje del canal del ticket #${route.ticket_number}:`, err.message));
    }
    return true;
  }

  /** En tickets abiertos desde Discord el chat del canal es la conversación: se guarda en el backend sin volver a publicarse. */
  async persistChannelMessage(route, message) {
    const backend = this.backendFor(route.ticket_key);
    if (!backend) return;
    const body = [message.content, ...[...(message.attachments?.values?.() ?? [])].map((a) => a.url)].filter(Boolean).join('\n').trim().slice(0, 5000);
    if (!body) return;
    const before = await backend.get(route.ticket_number);
    if (before.status === 'CLOSED') return;
    let actor;
    if (message.author.id === route.owner_discord_id) {
      actor = { id: message.author.id, username: message.member?.displayName || message.author.username, role: 'USER', platform: 'discord', asPlayer: true };
    } else {
      const access = await this.access(message.guild, message.author.id, { categoryId: route.category_id });
      // Los invitados con /ticket add hablan en el canal, pero no escriben en el historial del backend.
      if (!access.staff) return;
      actor = access.actor;
    }
    const updated = await backend.message(route.ticket_number, { body, internal: false, actor, eventId: `dcmsg:${message.id}` });
    const known = new Set(before.messages.map((m) => m.id));
    const saved = updated.messages.findLast((m) => !known.has(m.id) && m.body.trim() === body);
    if (saved) await this.repository.markDelivered(route.ticket_key, saved.id, 'discord');
    await this.sync(updated, backend);
  }

  // ── Interacciones ──

  async respond(interaction, content, extra = {}) {
    const payload = { content, ...extra };
    if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
    return interaction.reply({ ...payload, flags: 64 });
  }

  async handleInteraction(interaction) {
    if (interaction.isChatInputCommand?.()) {
      if (interaction.commandName === 'ticket') return this.handleTicketCommand(interaction);
      if (COMMAND_NAMES.has(interaction.commandName)) return this.handleLegacyCommand(interaction);
      return;
    }
    if (!interaction.customId?.startsWith('tk:')) return;
    try {
      if (!this.guildAllowed(interaction.guildId)) throw ticketError('Servidor no autorizado.', 403);
      const [, action, arg] = interaction.customId.split(':');
      if (action === 'open') return await this.showOpenModal(interaction, Number(arg));
      if (action === 'open_select') return await this.showOpenModal(interaction, Number(interaction.values?.[0]));
      if (action === 'modal') return await this.openFromModal(interaction, Number(arg));
      if (action === 'delete_cancel') return await interaction.update({ content: 'Borrado cancelado.', components: [] });
      return await this.ticketAction(interaction, action, Number(arg));
    } catch (err) {
      await this.respond(interaction, errorText(err)).catch(() => {});
      if (!err.status || err.status >= 500) console.error('[Tickets] Componente:', err.message);
    }
  }

  async handleLegacyCommand(interaction) {
    await interaction.deferReply({ flags: 64 });
    try {
      if (!this.guildAllowed(interaction.guildId)) throw ticketError('Servidor no autorizado.', 403);
      const route = await this.repository.routeByChannel(interaction.channelId);
      const access = await this.access(interaction.guild, interaction.user.id, { categoryId: route?.category_id });
      const { staff, actor } = access;
      if (!staff) throw ticketError('Necesitas un rol de soporte.', 403);
      const backend = route && this.backendFor(route.ticket_key);
      if (!backend) throw ticketError('Este canal no pertenece al modo de tickets activo.');
      await this.serial(this.routeLock(route), async () => {
        let ticket;
        const previous = interaction.commandName === 'prioridad' ? await backend.get(route.ticket_number) : null;
        if (interaction.commandName === 'responder' || interaction.commandName === 'nota') {
          let body = interaction.options.getString('mensaje', true);
          const attachment = interaction.commandName === 'responder' ? interaction.options.getAttachment('archivo') : null;
          if (attachment) body += `\n${attachment.url}`;
          // En tickets de Discord la nota se guarda pero sync() nunca la publica en el canal del jugador.
          ticket = await backend.message(route.ticket_number, { body, internal: interaction.commandName === 'nota', actor, eventId: `dc:${interaction.id}` });
        } else {
          const changes = {
            tomar: { assigneeId: 'me' }, soltar: { assigneeId: null },
            cerrar: { status: 'CLOSED' }, reabrir: { status: 'OPEN' },
            prioridad: { priority: interaction.options.getString('valor') },
          }[interaction.commandName];
          ticket = await backend.update(route.ticket_number, changes, actor);
        }
        await interaction.editReply('Guardado. La sincronización entregará las notificaciones pendientes.');
        await this.sync(ticket, backend).catch((err) => console.error('[Tickets] Entrega pendiente:', err.message));
        if (previous && previous.priority !== ticket.priority) await this.afterPriorityChange(route, ticket, access);
      });
    } catch (err) {
      await interaction.editReply(errorText(err));
      if (!err.status || err.status >= 500) console.error('[Tickets] Comando:', err.message);
    }
  }

  // ── Apertura desde un panel ──

  async openableCategory(interaction, categoryId) {
    if (!this.configRepository) throw ticketError('Los tickets de Discord no están configurados.', 503);
    const category = await this.configRepository.category(categoryId);
    if (!category || category.guildId !== interaction.guildId || !category.enabled) throw ticketError('Esta categoría ya no está disponible.', 404);
    const lp = await this.permissions('discord', [interaction.user.id], PERMISSIONS.ticketsDiscordUse.node).catch(() => UNAVAILABLE);
    if (!decide(PERMISSIONS.ticketsDiscordUse, lp)) throw ticketError('No tienes permiso para abrir tickets.', 403);
    const cfg = await this.guildConfig(interaction.guildId);
    const open = await this.repository.countOpenDiscord(interaction.user.id, interaction.guildId);
    if (open >= cfg.maxOpenPerUser) throw ticketError(`Ya tienes ${open} ticket(s) abierto(s) (máximo ${cfg.maxOpenPerUser}).`, 409);
    return { category, cfg };
  }

  async showOpenModal(interaction, categoryId) {
    const { category } = await this.openableCategory(interaction, categoryId);
    await interaction.showModal(buildOpenModal(category));
  }

  async openFromModal(interaction, categoryId) {
    await interaction.deferReply({ flags: 64 });
    const subject = interaction.fields.getTextInputValue('subject');
    const message = interaction.fields.getTextInputValue('message');
    // El bloqueo por usuario impide superar el límite con dos formularios enviados a la vez.
    const channelId = await this.serial(`dc:${interaction.user.id}`, async () => {
      const { category, cfg } = await this.openableCategory(interaction, categoryId);
      return this.openDiscordTicket({ interaction, category, cfg, subject, message });
    });
    await interaction.editReply(`🎫 Ticket creado: <#${channelId}>`);
  }

  async openDiscordTicket({ interaction, category, cfg, subject, message }) {
    const { guild, user } = interaction;
    const member = await guild.members.fetch(user.id);
    const username = member.displayName || user.username;
    const data = { subject: subject.trim(), message, category: category.baseCategory, priority: category.defaultPriority, username, eventId: `dcopen:${interaction.id}` };
    validateTicket(data);
    let backend = this.backend;
    let ticket;
    if (backend.name === 'web') {
      try { ticket = await backend.create({ ...data, discordId: user.id }); }
      catch (err) {
        // Sin cuenta web vinculada: error, o ticket local si el servidor lo permite (/ticket config editar requerir_web:false).
        if (err.status !== 403 || cfg.requireLinkedWeb || !this.localRepository) throw err;
        backend = this.localRepository;
      }
    }
    ticket ||= await backend.create({ ...data, discordUserId: user.id, guildId: guild.id, customCategorySlug: category.slug, maxOpen: cfg.maxOpenPerUser });
    const key = this.key(ticket, backend);
    this.opening.add(key);
    try { return await this.createDiscordChannel({ ticket, backend, key, guild, user, username, category, cfg }); }
    finally { this.opening.delete(key); }
  }

  async createDiscordChannel({ ticket, backend, key, guild, user, username, category, cfg }) {
    const staffRoleIds = this.staffRoleIds(guild.id, cfg, category);
    const baseName = `ticket-${ticket.number}-${sanitizeChannelName(username, 30) || 'usuario'}`;
    const channel = await this.discord.createTicketChannel(ticket, {
      guildId: guild.id,
      // Sin categoría configurada, el servidor principal usa TICKETS_CATEGORY_ID.
      categoryChannelId: category.discordCategoryId || cfg.defaultCategoryChannelId || (guild.id === this.config.guildId ? undefined : null),
      staffRoleIds, ownerDiscordId: user.id,
      channelName: cfg.renameOnPriority ? priorityChannelName(baseName, ticket.priority) : baseName,
      topic: `Ticket #${ticket.number} | ${category.label} | Abierto por ${username}`.slice(0, 1024),
    });
    try {
      await this.repository.saveRoute(key, ticket, channel.id, { guildId: guild.id, origin: 'discord', ownerDiscordId: user.id, categoryId: category.id });
    } catch (err) {
      await channel.delete?.('No se pudo persistir el ticket').catch(() => {});
      throw err;
    }
    this.opening.delete(key);
    await this.serial(this.lockKey(backend, ticket.number), () => this.sync(ticket, backend)).catch((err) => console.error('[Tickets] Canal pendiente de sincronizar:', err.message));
    const ping = category.pingRoles ? staffRoleIds : [];
    await this.discord.sendMessage(channel.id, {
      content: `👋 <@${user.id}>, el staff te atenderá aquí. Escribe en este canal para continuar.${ping.length ? `\n${ping.map((id) => `<@&${id}>`).join(' ')}` : ''}`,
      allowedMentions: { users: [user.id], roles: ping },
    }).catch(() => {});
    return channel.id;
  }

  // ── Botones y selector del mensaje fijado ──

  async ticketAction(interaction, action, number) {
    const route = await this.repository.routeByChannel(interaction.channelId);
    if (!route || route.ticket_number !== number || route.channel_deleted) throw ticketError('Este ticket ya no existe.', 404);
    const backend = this.backendFor(route.ticket_key);
    if (!backend) throw ticketError('Este canal no pertenece al modo de tickets activo.');
    if (action === 'delete_confirm') await interaction.update({ content: '🗑️ Borrando…', components: [] });
    else await interaction.deferReply({ flags: 64 });
    const access = await this.access(interaction.guild, interaction.user.id, { categoryId: route.category_id });
    const isOwner = route.owner_discord_id === interaction.user.id;
    if (!access.staff && !(action === 'close' && isOwner)) throw ticketError('Solo el staff puede usar este control.', 403);
    const actor = access.staff ? access.actor
      : { id: interaction.user.id, username: access.member.displayName, role: 'USER', platform: 'discord', asPlayer: true };

    if (action === 'transcript') {
      const ticket = await backend.get(number);
      const url = await this.sendTranscript(route, ticket, `pedida por ${access.member.displayName}`);
      return interaction.editReply(url ? `📄 Transcripción enviada: ${url}` : 'Configura un canal de logs con /ticket config editar canal_logs.');
    }
    if (action === 'delete') {
      if ((await backend.get(number)).status !== 'CLOSED') throw ticketError('Cierra el ticket antes de borrar el canal.', 409);
      return interaction.editReply({ content: '¿Borrar este canal? La transcripción se enviará al canal de logs.', components: [buildDeleteConfirmRow(number)] });
    }
    if (action === 'delete_confirm') return this.deleteTicketChannel(interaction, route, backend, access);
    let changes = ACTION_CHANGES[action];
    if (action === 'prio') {
      const priority = interaction.values?.[0];
      if (!PRIORITIES.includes(priority)) throw ticketError('Prioridad inválida.');
      changes = { priority };
    }
    if (!changes) throw ticketError('Acción desconocida.');
    await this.serial(this.routeLock(route), async () => {
      const previous = action === 'prio' ? await backend.get(number) : null;
      const ticket = await backend.update(number, changes, actor);
      await interaction.editReply('Guardado.');
      await this.sync(ticket, backend).catch((err) => console.error('[Tickets] Entrega pendiente:', err.message));
      if (previous && previous.priority !== ticket.priority) await this.afterPriorityChange(route, ticket, access);
    });
  }

  /** Renombra el canal sin esperar (Discord permite 2 cambios cada 10 min) y avisa al staff si sube a HIGH/URGENT. */
  async afterPriorityChange(route, ticket, { cfg, category, staffRoleIds }) {
    const lastRename = route.last_renamed_at ? new Date(route.last_renamed_at).getTime() : 0;
    if (cfg.renameOnPriority && Date.now() - lastRename > RENAME_COOLDOWN_MS) {
      const channel = await this.discord.getChannel(route.discord_channel_id).catch(() => null);
      const name = channel && priorityChannelName(channel.name, ticket.priority);
      if (name && name !== channel.name) {
        await this.repository.setLastRenamedAt(route.ticket_key);
        // Un 429 deja la petición en cola dentro de discord.js: nunca se espera aquí.
        void this.discord.renameTicketChannel(route.discord_channel_id, name).catch((err) => console.warn(`[Tickets] Renombrar #${ticket.number}:`, err.message));
      }
    }
    if (['HIGH', 'URGENT'].includes(ticket.priority) && (category?.pingRoles ?? true) && staffRoleIds.length) {
      const meta = PRIORITY_META[ticket.priority];
      await this.discord.sendMessage(route.discord_channel_id, {
        content: `${meta.emoji} Prioridad ${meta.label}: ${staffRoleIds.map((id) => `<@&${id}>`).join(' ')}`,
        allowedMentions: { roles: staffRoleIds },
      }).catch(() => {});
    }
  }

  async deleteTicketChannel(interaction, route, backend, { cfg }) {
    const ticket = await backend.get(route.ticket_number);
    if (ticket.status !== 'CLOSED') throw ticketError('Cierra el ticket antes de borrar el canal.', 409);
    await this.sendTranscript(route, ticket, `borrado por ${interaction.member?.displayName || interaction.user.username}`)
      .catch((err) => console.error(`[Tickets] Transcripción de #${ticket.number}:`, err.message));
    // Primero se marca: así sync() y poll() nunca recrean el canal ni le envían mensajes.
    await this.repository.markChannelDeleted(route.ticket_key);
    await interaction.editReply({ content: `🗑️ El canal se borrará en ${cfg.deleteDelaySeconds} s.`, components: [] });
    await this.discord.sendMessage(route.discord_channel_id, { content: `🗑️ Este canal se borrará en ${cfg.deleteDelaySeconds} segundos.`, allowedMentions: { parse: [] } }).catch(() => {});
    await sleep(cfg.deleteDelaySeconds * 1000);
    await this.discord.deleteTicketChannel(route.discord_channel_id, `Ticket #${ticket.number} borrado por ${interaction.user.id}`);
  }

  // ── /ticket ──

  async handleTicketCommand(interaction) {
    await interaction.deferReply({ flags: 64 });
    try {
      if (!this.guildAllowed(interaction.guildId)) throw ticketError('Servidor no autorizado.', 403);
      if (!this.configRepository) throw ticketError('Los tickets de Discord no están configurados.', 503);
      const group = interaction.options.getSubcommandGroup(false);
      const sub = interaction.options.getSubcommand();
      let text;
      if (group) {
        if (!(await this.isAdmin(interaction.guild, interaction.user.id))) throw ticketError('Necesitas Gestionar servidor o impebot.tickets.admin.', 403);
        text = await ({ config: () => this.configCommand(interaction, sub), categoria: () => this.categoryCommand(interaction, sub), panel: () => this.panelCommand(interaction, sub) }[group])();
      } else {
        text = await this.channelCommand(interaction, sub);
      }
      await interaction.editReply({ content: text.slice(0, 2000), allowedMentions: { parse: [] } });
    } catch (err) {
      await interaction.editReply(errorText(err));
      if (!err.status || err.status >= 500) console.error('[Tickets] /ticket:', err.message);
    }
  }

  checkRole(interaction, role) {
    if (role && role.id === interaction.guildId) throw ticketError('@everyone no puede ser un rol de staff.');
    return role;
  }

  async configCommand(interaction, sub) {
    const o = interaction.options;
    const guildId = interaction.guildId;
    let cfg = await this.configRepository.guild(guildId);
    if (sub === 'editar') {
      const add = this.checkRole(interaction, o.getRole('rol_staff_agregar'));
      const remove = o.getRole('rol_staff_quitar');
      const staffRoleIds = add || remove ? [...new Set([...cfg.staffRoleIds, ...(add ? [add.id] : [])])].filter((id) => id !== remove?.id) : undefined;
      cfg = await this.configRepository.updateGuild(guildId, {
        defaultCategoryChannelId: o.getChannel('categoria_canales')?.id, logChannelId: o.getChannel('canal_logs')?.id,
        transcriptFormat: o.getString('formato_transcripcion') ?? undefined, maxOpenPerUser: o.getInteger('max_abiertos') ?? undefined,
        staffRoleIds, renameOnPriority: o.getBoolean('renombrar_prioridad') ?? undefined,
        deleteDelaySeconds: o.getInteger('delay_borrado') ?? undefined, requireLinkedWeb: o.getBoolean('requerir_web') ?? undefined,
      });
    }
    const categories = await this.configRepository.categories(guildId);
    const ch = (id) => (id ? `<#${id}>` : '—');
    return [
      `⚙️ Tickets de este servidor (backend: ${this.backend.name})`,
      `Categoría de canales: ${ch(cfg.defaultCategoryChannelId)} · Logs: ${ch(cfg.logChannelId)} · Transcripción: ${cfg.transcriptFormat}`,
      `Máx. abiertos por usuario: ${cfg.maxOpenPerUser} · Borrado tras ${cfg.deleteDelaySeconds} s · Renombrar por prioridad: ${cfg.renameOnPriority ? 'sí' : 'no'}`,
      `Roles de staff: ${cfg.staffRoleIds.map((id) => `<@&${id}>`).join(' ') || '—'}${this.backend.name === 'web' ? ` · Exigir cuenta web: ${cfg.requireLinkedWeb ? 'sí' : 'no (tickets locales de reserva)'}` : ''}`,
      '', this.describeCategories(categories),
    ].join('\n');
  }

  describeCategories(categories) {
    if (!categories.length) return 'Sin categorías. Crea una con /ticket categoria crear.';
    return categories.map((c) => `${c.enabled ? '✅' : '⏸️'} ${c.emoji || ''} **${c.label}** \`${c.slug}\` → ${c.baseCategory} · ${c.defaultPriority}`
      + `${c.discordCategoryId ? ` · <#${c.discordCategoryId}>` : ''}${c.staffRoleIds.length ? ` · ${c.staffRoleIds.map((id) => `<@&${id}>`).join(' ')}` : ''}`).join('\n');
  }

  async categoryCommand(interaction, sub) {
    const o = interaction.options;
    const guildId = interaction.guildId;
    if (sub === 'listar') return this.describeCategories(await this.configRepository.categories(guildId));
    const slug = normalizeSlug(o.getString('slug', true));
    if (!slug) throw ticketError('El slug solo admite letras, números y guiones.');
    const existing = await this.configRepository.categoryBySlug(guildId, slug);
    if (sub === 'eliminar') {
      if (!existing) throw ticketError('Categoría no encontrada.', 404);
      await this.configRepository.deleteCategory(existing.id);
      await this.refreshPanels(guildId);
      return `🗑️ Categoría \`${slug}\` eliminada. Los tickets abiertos conservan su canal.`;
    }
    const emoji = o.getString('emoji') ?? undefined;
    if (emoji && !EMOJI_RE.test(emoji.trim())) throw ticketError('Emoji inválido: usa un emoji Unicode o <:nombre:id>.');
    const fields = {
      label: o.getString('nombre') ?? undefined, baseCategory: o.getString('base') ?? undefined, description: o.getString('descripcion') ?? undefined,
      emoji: emoji?.trim(), buttonStyle: o.getString('estilo') ?? undefined, discordCategoryId: o.getChannel('categoria_canales')?.id,
      defaultPriority: o.getString('prioridad') ?? undefined, pingRoles: o.getBoolean('ping_roles') ?? undefined,
      welcomeMessage: o.getString('mensaje_bienvenida') ?? undefined,
    };
    let category;
    if (sub === 'crear') {
      if (existing) throw ticketError(`Ya existe la categoría \`${slug}\`.`, 409);
      if ((await this.configRepository.categories(guildId)).length >= 25) throw ticketError('Máximo 25 categorías por servidor.');
      const role = this.checkRole(interaction, o.getRole('rol_staff'));
      category = await this.configRepository.createCategory(guildId, { ...fields, slug, staffRoleIds: role ? [role.id] : [] });
    } else {
      if (!existing) throw ticketError('Categoría no encontrada.', 404);
      const add = this.checkRole(interaction, o.getRole('rol_staff_agregar'));
      const remove = o.getRole('rol_staff_quitar');
      category = await this.configRepository.updateCategory(existing.id, {
        ...fields, enabled: o.getBoolean('activa') ?? undefined, sortOrder: o.getInteger('orden') ?? undefined,
        staffRoleIds: add || remove ? [...new Set([...existing.staffRoleIds, ...(add ? [add.id] : [])])].filter((id) => id !== remove?.id) : undefined,
      });
    }
    await this.refreshPanels(guildId);
    return `✅ Categoría guardada:\n${this.describeCategories([category])}`;
  }

  /** Categorías que muestra un panel: las elegidas (en su orden de categorías) o todas las activas. */
  async panelCategories(panel) {
    const all = await this.configRepository.categories(panel.guildId, { enabledOnly: true });
    return panel.categoryIds ? all.filter((c) => panel.categoryIds.includes(c.id)) : all;
  }

  async refreshPanels(guildId) {
    for (const panel of await this.configRepository.panels(guildId)) {
      await this.discord.editChannelMessage(panel.channelId, panel.messageId, buildPanelMessage(panel, await this.panelCategories(panel)))
        .catch((err) => console.warn(`[Tickets] Panel ${panel.messageId} sin actualizar:`, err.message));
    }
  }

  async panelCommand(interaction, sub) {
    const o = interaction.options;
    const guildId = interaction.guildId;
    const color = o.getString('color');
    if (color && !/^#?[0-9a-f]{6}$/i.test(color)) throw ticketError('Color inválido: usa #RRGGBB.');
    let categoryIds;
    const slugs = o.getString('categorias');
    if (slugs) {
      const all = await this.configRepository.categories(guildId);
      categoryIds = slugs.split(',').map((s) => normalizeSlug(s)).filter(Boolean).map((slug) => {
        const found = all.find((c) => c.slug === slug);
        if (!found) throw ticketError(`Categoría no encontrada: ${slug}.`, 404);
        return found.id;
      });
    }
    const changes = {
      title: o.getString('titulo') ?? undefined, description: o.getString('descripcion') ?? undefined, mode: o.getString('modo') ?? undefined,
      color: color ? `#${color.replace('#', '')}` : undefined, categoryIds,
    };
    if (sub === 'enviar') {
      const target = o.getChannel('canal', true);
      const draft = { guildId, mode: 'buttons', color: null, categoryIds: null, ...Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined)) };
      const sent = await this.discord.sendMessage(target.id, buildPanelMessage(draft, await this.panelCategories(draft)));
      await this.configRepository.savePanel(guildId, { ...draft, channelId: target.id, messageId: sent.id });
      return `✅ Panel publicado en <#${target.id}> (mensaje ${sent.id}).`;
    }
    const messageId = o.getString('message_id', true);
    const panel = await this.configRepository.panel(messageId);
    if (!panel || panel.guildId !== guildId) throw ticketError('Panel no encontrado en este servidor.', 404);
    const updated = await this.configRepository.updatePanel(messageId, changes);
    await this.discord.editChannelMessage(updated.channelId, messageId, buildPanelMessage(updated, await this.panelCategories(updated)));
    return '✅ Panel actualizado.';
  }

  async channelCommand(interaction, sub) {
    const route = await this.repository.routeByChannel(interaction.channelId);
    if (!route || route.channel_deleted) throw ticketError('Usa este comando dentro del canal de un ticket.');
    const backend = this.backendFor(route.ticket_key);
    if (!backend) throw ticketError('Este canal no pertenece al modo de tickets activo.');
    const access = await this.access(interaction.guild, interaction.user.id, { categoryId: route.category_id });
    if (!access.staff) throw ticketError('Necesitas un rol de soporte.', 403);
    const ticket = await backend.get(route.ticket_number);
    if (sub === 'transcripcion') {
      const url = await this.sendTranscript(route, ticket, `pedida por ${access.member.displayName}`);
      return url ? `📄 Transcripción enviada: ${url}` : 'Configura un canal de logs con /ticket config editar canal_logs.';
    }
    if (sub === 'renombrar') {
      const name = sanitizeChannelName(interaction.options.getString('nombre', true), 90);
      if (!name) throw ticketError('Nombre inválido.');
      void this.discord.renameTicketChannel(route.discord_channel_id, name).catch((err) => console.warn(`[Tickets] Renombrar #${ticket.number}:`, err.message));
      return `✏️ El canal pasará a llamarse ${name} (Discord limita a 2 cambios cada 10 minutos).`;
    }
    const user = interaction.options.getUser('usuario');
    const role = interaction.options.getRole('rol');
    if (!user && !role) throw ticketError('Indica un usuario o un rol.');
    if (role?.id === interaction.guildId) throw ticketError('No se puede usar @everyone.');
    const targets = [...(user ? [{ id: user.id, type: 'user' }] : []), ...(role ? [{ id: role.id, type: 'role' }] : [])];
    if (sub === 'add') {
      for (const t of targets) {
        await this.discord.setTicketParticipantPermission(route.discord_channel_id, t.id, t.type, {
          ViewChannel: true, ReadMessageHistory: true, SendMessages: ticket.status !== 'CLOSED', AttachFiles: true, EmbedLinks: true,
        });
        await this.configRepository.addParticipant(route.ticket_key, t.id, t.type, interaction.user.id);
      }
      return `✅ Acceso concedido: ${targets.map((t) => (t.type === 'role' ? `<@&${t.id}>` : `<@${t.id}>`)).join(' ')}`;
    }
    if (targets.some((t) => t.id === route.owner_discord_id || t.id === this.discord.client?.user?.id)) throw ticketError('No se puede quitar al creador del ticket ni al bot.');
    for (const t of targets) {
      await this.discord.setTicketParticipantPermission(route.discord_channel_id, t.id, t.type, null);
      await this.configRepository.removeParticipant(route.ticket_key, t.id);
    }
    return `✅ Acceso retirado: ${targets.map((t) => (t.type === 'role' ? `<@&${t.id}>` : `<@${t.id}>`)).join(' ')}`;
  }
}
