import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TicketService, ticketCommands } from '../src/tickets/TicketService.js';
import { ImpecraftClient } from '../src/tickets/ImpecraftClient.js';
import { isPrivateJid, parseOpening } from '../src/tickets/model.js';
import { DiscordService } from '../src/services/DiscordService.js';
import { CONFIG } from '../src/config.js';
import { PermissionFlagsBits } from 'discord.js';

const jid = '59170000000@s.whatsapp.net';
const ticket = () => ({ id: 'ticket-one', number: 1, subject: 'Necesito ayuda', category: 'soporte', status: 'OPEN', priority: 'NORMAL',
  user: { id: 'owner', username: 'Jugador' }, assignee: null, whatsappJid: jid,
  createdAt: '2026-10-27T00:00:00.000Z', messages: [
    { id: 'm1', body: 'Ayuda con mi cuenta', internal: false, author: { id: 'owner', username: 'Jugador', role: 'USER' }, createdAt: '2026-10-27T00:00:00.000Z' },
  ] });

function fixture(initial = ticket()) {
  const state = { ticket: initial, routes: new Map(), deliveries: new Set(), wa: [], dc: [], created: 0, mutations: [] };
  const discord = Object.assign(new EventEmitter(), {
    isReady: true,
    async createTicketChannel() { state.created++; return { id: 'channel', async delete() {} }; },
    async sendMessage(channelId, payload) { state.dc.push({ channelId, ...payload }); return { attachments: new Map() }; },
    async registerTicketCommands() {},
  });
  const whatsapp = { isReady: true, async sendMessage(to, payload) { state.wa.push({ to, ...payload }); } };
  const backend = {
    name: 'web', async get() { return structuredClone(state.ticket); }, async list({ jid: ownerJid } = {}) { return ownerJid && ownerJid !== jid ? [] : [structuredClone(state.ticket)]; },
    async create(data) { state.mutations.push({ action: 'create', data }); return structuredClone(state.ticket); },
    async message(number, data) { state.mutations.push({ action: 'message', data }); return structuredClone(state.ticket); },
    async update(number, changes, actor) { state.mutations.push({ action: 'update', changes, actor }); Object.assign(state.ticket, changes); return structuredClone(state.ticket); },
  };
  const repository = {
    async route(key) { return structuredClone(state.routes.get(key)); },
    async saveRoute(key, t, channelId) { if (!state.routes.has(key)) state.routes.set(key, { ticket_key: key, ticket_number: t.number, discord_channel_id: channelId }); },
    async routeByChannel(channelId) { return [...state.routes.values()].find((r) => r.discord_channel_id === channelId); },
    async delivered(key, id, destination) { return state.deliveries.has(`${key}/${id}/${destination}`); },
    async markDelivered(key, id, destination) { state.deliveries.add(`${key}/${id}/${destination}`); },
    async setRouteStatus(key, status, meta) { Object.assign(state.routes.get(key), { last_status: status, last_meta: meta }); },
  };
  const service = new TicketService({ backend, repository, whatsapp, discord, config: { enabled: true, web: { url: 'https://example.test' }, pollIntervalMs: 5000, guildId: 'guild', staffRoleIds: ['staff'] } });
  return { service, state, backend, discord, whatsapp, repository };
}

test('normaliza categorías y rechaza asuntos vacíos y chats públicos', () => {
  assert.deepEqual(parseOpening('compra | No llegó mi rango | Compré hace una hora'), { category: 'compra', subject: 'No llegó mi rango', message: 'Compré hace una hora' });
  assert.throws(() => parseOpening('inventada | asunto válido | mensaje'));
  assert.throws(() => parseOpening('soporte | no | mensaje'));
  assert.equal(isPrivateJid('123@g.us'), false);
  assert.equal(isPrivateJid('status@broadcast'), false);
  assert.equal(isPrivateJid(jid), true);
});

test('notas internas, sistema y mensajes del dueño nunca salen a WhatsApp', async () => {
  const f = fixture();
  f.state.ticket.messages.push(
    { id: 'note', internal: true, body: 'SECRETO', author: { id: 'staff', username: 'Helper' } },
    { id: 'system', internal: false, body: 'Sistema', author: null },
    { id: 'reply', internal: false, body: 'Respuesta pública', author: { id: 'staff', username: 'Helper' }, createdAt: '2026-10-27T01:00:00Z' },
  );
  await f.service.sync(f.state.ticket);
  assert.equal(f.state.wa.length, 1);
  assert.match(f.state.wa[0].text, /Respuesta pública/);
  assert.ok(f.state.dc.some((m) => m.content.includes('SECRETO')));
  assert.ok(f.state.dc.every((m) => m.allowedMentions.parse.length === 0));
  await f.service.sync(f.state.ticket);
  assert.equal(f.state.wa.length, 1, 'persistencia evita repetir respuestas');
});

test('un dueño con rol staff sigue siendo el jugador del ticket', async () => {
  const f = fixture();
  f.state.ticket.messages[0].author.role = 'ADMIN';
  await f.service.sync(f.state.ticket);
  assert.equal(f.state.wa.length, 0);
});

test('reintenta entregas pendientes tras desconexión, sin repetir Discord', async () => {
  const f = fixture();
  await f.service.sync(f.state.ticket);
  f.state.ticket.messages.push({ id: 'reply', internal: false, body: 'Respuesta', author: { id: 'staff', username: 'Helper' }, createdAt: '2026-10-27T01:00:00Z' });
  f.whatsapp.isReady = false;
  await f.service.sync(f.state.ticket);
  const dcCount = f.state.dc.length;
  assert.equal(f.state.wa.length, 0);
  f.whatsapp.isReady = true;
  await f.service.sync(f.state.ticket);
  assert.equal(f.state.wa.length, 1);
  assert.equal(f.state.dc.length, dcCount);
});

test('un error de transporte no marca el mensaje como entregado', async () => {
  const f = fixture();
  await f.service.sync(f.state.ticket);
  f.state.ticket.messages.push({ id: 'reply', internal: false, body: 'Respuesta', author: { id: 'staff', username: 'Helper' }, createdAt: '2026-10-27T01:00:00Z' });
  const send = f.whatsapp.sendMessage;
  f.whatsapp.sendMessage = async () => { throw new Error('socket desconectado'); };
  await assert.rejects(() => f.service.sync(f.state.ticket));
  f.whatsapp.sendMessage = send;
  await f.service.sync(f.state.ticket);
  assert.equal(f.state.wa.length, 1);
});

test('no reproduce respuestas anteriores a la vinculación de WhatsApp', async () => {
  const f = fixture();
  f.state.ticket.whatsappLinkedAt = '2026-10-27T02:00:00Z';
  f.state.ticket.messages.push({ id: 'old', internal: false, body: 'Pasado', author: { id: 'staff', username: 'Helper' }, createdAt: '2026-10-27T01:00:00Z' });
  await f.service.sync(f.state.ticket);
  assert.equal(f.state.wa.length, 0);
});

test('los canales de ticket cerrado siguen bloqueando el relay', async () => {
  const f = fixture();
  await f.service.sync(f.state.ticket);
  f.state.ticket.status = 'CLOSED';
  assert.equal(await f.service.handleDiscord({ channelId: 'channel' }), true);
  assert.equal(await f.service.handleDiscord({ channelId: 'unrelated' }), false);
});

test('los tickets cerrados anteriores a la instalación no crean canales', async () => {
  const f = fixture();
  f.state.ticket.status = 'CLOSED';
  await f.service.sync(f.state.ticket);
  assert.equal(f.state.created, 0);
});

test('actualiza responsable y prioridad aunque el estado no cambie', async () => {
  const f = fixture();
  await f.service.sync(f.state.ticket);
  f.state.ticket.assignee = { id: 's', username: 'Ana' };
  f.state.ticket.priority = 'URGENT';
  await f.service.sync(f.state.ticket);
  assert.match(f.state.dc.at(-1).content, /URGENT.*Ana/);
  assert.equal(f.state.wa.length, 0);
});

test('serializa sincronizaciones y refresca una instantánea antigua', async () => {
  const f = fixture();
  const stale = structuredClone(f.state.ticket);
  f.state.ticket.status = 'PENDING';
  await Promise.all(Array.from({ length: 5 }, () => f.service.serial('ticket:1', () => f.service.sync(stale))));
  assert.equal(f.state.created, 1);
  assert.equal(f.state.routes.get('web:ticket-one').last_status, 'PENDING');
});

test('la apertura guiada y los comandos históricos no crean tickets accidentales', async () => {
  const f = fixture();
  const send = (text, timestamp = Date.now() / 1000) => f.service.handleWhatsApp({ jid, pushName: 'Jugador', text, timestamp, messageId: `id-${text}` });
  await send('!ticket', Date.now() / 1000 - 600);
  assert.equal(f.service.wizards.size, 0);
  await send('!ticket'); await send('soporte'); await send('Necesito ayuda'); await send('No puedo entrar al servidor');
  assert.equal(f.state.mutations.length, 1);
  assert.equal(f.state.mutations[0].data.category, 'soporte');
  assert.equal(f.service.wizards.size, 0);
  assert.equal(await f.service.handleWhatsApp({ jid: '123@g.us', text: '!ticket' }), false);
  assert.equal(await f.service.handleWhatsApp({ jid, isFromMe: true, text: '!ticket' }), true);
});

test('rechaza respuestas y cierres de tickets ajenos antes de mutar', async () => {
  const f = fixture();
  await f.service.handleWhatsApp({ jid: '123@s.whatsapp.net', text: '!responder 1 | Ataque', messageId: 'x' });
  await f.service.handleWhatsApp({ jid: '123@s.whatsapp.net', text: '!cerrar 1', messageId: 'y' });
  assert.equal(f.state.mutations.length, 0);
  assert.equal(f.state.wa.length, 2);
  assert.ok(f.state.wa.every((m) => /no encontrado/.test(m.text)));
});

test('los comandos no registrados no se ejecutan y los permisos se consultan de nuevo', async () => {
  const f = fixture();
  const edits = [];
  const interaction = { isChatInputCommand: () => true, commandName: 'cerrar', guildId: 'guild', channelId: 'channel', user: { id: 'attacker' },
    async deferReply() {}, async editReply(text) { edits.push(text); },
    guild: { members: { async fetch() { return { permissions: { has: () => false }, roles: { cache: new Set() } }; } } },
  };
  await f.service.handleInteraction(interaction);
  assert.match(edits[0], /rol de soporte/);
  assert.equal(f.state.mutations.length, 0);
  assert.equal(ticketCommands().length, 7);
});

test('el cliente web requiere HTTPS, secreto y no sigue redirecciones', async () => {
  assert.throws(() => new ImpecraftClient({ url: 'http://example.test', token: 'a'.repeat(32) }));
  assert.throws(() => new ImpecraftClient({ url: 'https://example.test', token: '' }));
  const calls = [];
  const client = new ImpecraftClient({ url: 'https://example.test', token: 'a'.repeat(32) }, async (url, options) => {
    calls.push({ url, options }); return { ok: true, json: async () => ticket() };
  });
  await client.get(12);
  assert.equal(calls[0].url.pathname, '/api/bridge/impebot');
  assert.equal(calls[0].url.searchParams.get('number'), '12');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${'a'.repeat(32)}`);
});

test('un fallo web se propaga y no crea un ticket local alternativo', async () => {
  const client = new ImpecraftClient({ url: 'http://127.0.0.1:3000', token: 'a'.repeat(32) }, async () => ({ ok: false, status: 503, json: async () => ({ error: 'sensitive' }) }));
  await assert.rejects(() => client.create({}), (err) => err.status === 503 && !err.message.includes('sensitive'));
});

test('los canales se crean privados incluso si su categoría es pública', async (t) => {
  const service = new DiscordService();
  const previous = { guildId: CONFIG.discord.guildId, roleIds: CONFIG.tickets.staffRoleIds };
  t.after(() => { CONFIG.discord.guildId = previous.guildId; CONFIG.tickets.staffRoleIds = previous.roleIds; });
  CONFIG.discord.guildId = 'guild'; CONFIG.tickets.staffRoleIds = ['staff'];
  let options;
  service.isReady = true;
  service.client = { user: { id: 'bot' }, guilds: { async fetch() { return { id: 'guild', roles: { async fetch() { return new Map([['staff', {}]]); } },
    channels: { async create(value) { options = value; return { id: 'private-channel' }; } } }; } } };
  await service.createTicketChannel(ticket());
  assert.ok(options.permissionOverwrites.find((o) => o.id === 'guild').deny.includes(PermissionFlagsBits.ViewChannel));
  assert.ok(options.permissionOverwrites.find((o) => o.id === 'staff').allow.includes(PermissionFlagsBits.ViewChannel));
  CONFIG.tickets.staffRoleIds = ['guild'];
  await assert.rejects(() => service.createTicketChannel(ticket()), /rol inválido/);
});

test('/responder publica y /nota persiste sin salir al jugador', async () => {
  const f = fixture();
  await f.service.sync(f.state.ticket);
  const edits = [];
  f.backend.message = async (number, data) => {
    f.state.mutations.push(data);
    f.state.ticket.messages.push({ id: data.eventId, body: data.body, internal: Boolean(data.internal), author: { id: 'staff', username: 'Ana', role: 'HELPER' }, createdAt: '2026-10-27T01:00:00Z' });
    return structuredClone(f.state.ticket);
  };
  const interaction = (name) => ({ isChatInputCommand: () => true, commandName: name, id: `event-${name}`, guildId: 'guild', channelId: 'channel', user: { id: 'staff' },
    async deferReply() {}, async editReply(text) { edits.push(text); },
    options: { getString: () => name === 'nota' ? 'Secreto' : 'Respuesta', getAttachment: () => null },
    guild: { members: { async fetch() { return { displayName: 'Ana', permissions: { has: () => false }, roles: { cache: new Set(['staff']) } }; } } },
  });
  await f.service.handleInteraction(interaction('nota'));
  assert.equal(f.state.wa.length, 0);
  await f.service.handleInteraction(interaction('responder'));
  assert.equal(f.state.wa.length, 1);
  assert.match(f.state.wa[0].text, /Respuesta/);
  assert.equal(f.state.mutations[0].internal, true);
  assert.equal(f.state.mutations[1].internal, false);
  assert.equal(edits.length, 2);
});

test('un mensaje repetido de WhatsApp no vuelve a procesar sus adjuntos', async () => {
  const f = fixture();
  let transformed = 0;
  f.service.transformMedia = async () => { transformed++; return { files: [] }; };
  const data = { jid, pushName: 'Jugador', text: 'Seguimiento', messageId: 'repeated', rawMessage: { message: { conversation: 'Seguimiento' } } };
  await f.service.handleWhatsApp(data);
  await f.service.handleWhatsApp(data);
  assert.equal(f.state.mutations.length, 1);
  assert.equal(transformed, 1);
});

test('una notificación de cierre pendiente no repite avisos en Discord', async () => {
  const f = fixture();
  await f.service.sync(f.state.ticket);
  f.whatsapp.isReady = false;
  f.state.ticket.status = 'CLOSED';
  await f.service.sync(f.state.ticket);
  const count = f.state.dc.length;
  await f.service.sync(f.state.ticket);
  assert.equal(f.state.dc.length, count);
  f.whatsapp.isReady = true;
  await f.service.sync(f.state.ticket);
  assert.equal(f.state.dc.length, count);
  assert.equal(f.state.wa.length, 1);
});

test('con LuckPerms, !vincular no exige permiso y activa el rango; !ticket sí lo exige', async () => {
  const f = fixture();
  const linkedAccounts = [];
  let linkedPlayer = null;
  f.backend.link = async (who, code) => { f.state.mutations.push({ action: 'link', who, code }); return { username: 'Steve' }; };
  f.service.permissions = async (platform, ids, node) => ({ available: true, player: linkedPlayer, result: linkedPlayer ? node === 'impebot.tickets.use' : undefined });
  f.service.onLinked = async (account) => {
    linkedAccounts.push(account);
    linkedPlayer = { uuid: 'u', username: 'steve', primaryGroup: 'vip' };
    return { enabled: true, linked: true, player: linkedPlayer };
  };
  const now = Math.floor(Date.now() / 1000);
  const send = (text, id) => f.service.processWhatsApp({ jid, text, messageId: id, timestamp: now, rawMessage: { key: { remoteJid: jid, id } } });

  await send('!ticket', 'm1');
  assert.match(f.state.wa.at(-1).text, /vincular CODIGO/, 'sin vincular no puede abrir tickets');
  assert.equal(f.service.wizards.size, 0);

  await send('!verificar 0123456789abcdef0123456789abcdef', 'm2');
  assert.deepEqual(linkedAccounts[0], { ids: [jid], username: 'Steve', minecraftUuid: undefined });
  assert.match(f.state.wa.at(-1).text, /Minecraft: steve \(vip\)/);

  await send('!ticket', 'm3');
  assert.equal(f.service.wizards.has(jid), true, 'ya vinculado y con permiso abre el asistente');

  // El código del juego (8 cifras) lo atiende gameLink.js, no la web.
  f.service.config.gameCodes = true;
  const replies = f.state.wa.length;
  await send('!vincular 12345678', 'm4');
  assert.equal(f.state.mutations.filter((m) => m.action === 'link').length, 1, 'no llega a la web');
  assert.equal(f.state.wa.length, replies, 'ni responde: lo hace el manejador de comandos');
});
