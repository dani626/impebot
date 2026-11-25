import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { TicketService } from '../src/tickets/TicketService.js';
import { migrateTicketSchema } from '../src/tickets/schema.js';
import { buildControlMessage, buildPanelMessage } from '../src/tickets/ui.js';
import { generateTranscript, escapeHtml } from '../src/tickets/transcript.js';
import { priorityChannelName } from '../src/tickets/model.js';
import { GUILD_DEFAULTS } from '../src/tickets/TicketConfigRepository.js';
import { DiscordService } from '../src/services/DiscordService.js';

const OWNER = '111111111111111111';
const STAFF = '222222222222222222';
const GUEST = '333333333333333333';
const clone = (v) => structuredClone(v);
const err = (message, status) => Object.assign(new Error(message), { status });

/** Backend en memoria con las reglas de propiedad de TicketRepository. */
function memoryBackend(name = 'local') {
  const tickets = new Map();
  const events = new Set();
  let clock = 0;
  const stamp = () => new Date(Date.UTC(2026, 10, 1) + ++clock * 1000).toISOString();
  const get = async (n) => { if (!tickets.has(n)) throw err('Ticket no encontrado.', 404); return clone(tickets.get(n)); };
  return {
    name, tickets, get,
    async list() { return [...tickets.values()].map(clone); },
    async create(d) {
      const number = tickets.size + 1;
      const owner = d.discordUserId || d.discordId || d.jid;
      tickets.set(number, {
        id: `t${number}`, number, subject: d.subject, category: d.category, status: 'OPEN', priority: d.priority || 'NORMAL',
        user: { id: owner, username: d.username }, whatsappJid: d.jid || null, assignee: null, input: d,
        createdAt: stamp(), updatedAt: stamp(),
        messages: [{ id: `m${number}-0`, body: d.message, internal: false, author: { id: owner, username: d.username }, createdAt: stamp() }],
      });
      return get(number);
    },
    async message(n, d) {
      const t = tickets.get(n);
      if (events.has(d.eventId)) return get(n);
      if (d.actor.role === 'USER' && (d.actor.id !== t.user.id || d.internal)) throw err('No tienes acceso.', 403);
      if (t.status === 'CLOSED') throw err('Cerrado.', 409);
      events.add(d.eventId);
      t.messages.push({ id: `m${n}-${t.messages.length}`, body: d.body.trim(), internal: Boolean(d.internal), author: { id: d.actor.id, username: d.actor.username }, createdAt: stamp() });
      t.updatedAt = stamp();
      return get(n);
    },
    async update(n, changes, actor) {
      const t = tickets.get(n);
      if (actor.role === 'USER' && (actor.id !== t.user.id || changes.status !== 'CLOSED' || Object.keys(changes).length > 1)) throw err('Sin permiso.', 403);
      if (changes.status) t.status = changes.status;
      if (changes.priority) t.priority = changes.priority;
      if (changes.assigneeId === 'me') t.assignee = { id: actor.id, username: actor.username };
      if (changes.assigneeId === null) t.assignee = null;
      t.updatedAt = stamp();
      return get(n);
    },
  };
}

function fixture({ backend = memoryBackend(), localRepository = null, guildConfig = {} } = {}) {
  const state = { routes: new Map(), deliveries: new Set(), dc: [], edits: [], channels: [], locks: [], unlocks: [], renames: [], deleted: [], perms: [], participants: [] };
  const cfg = { guildId: 'guild', ...GUILD_DEFAULTS, staffRoleIds: [], logChannelId: 'logs', ...guildConfig };
  const categories = [{
    id: 7, guildId: 'guild', slug: 'compras', label: 'Compras', baseCategory: 'compra', enabled: true, defaultPriority: 'HIGH',
    discordCategoryId: 'cat-channels', staffRoleIds: ['shop-staff'], pingRoles: true, welcomeMessage: null,
  }, {
    id: 8, guildId: 'staff-guild', slug: 'staff', label: 'Staff', baseCategory: 'soporte', enabled: true, defaultPriority: 'NORMAL',
    discordCategoryId: null, staffRoleIds: [], pingRoles: false, welcomeMessage: null,
  }];
  const configRepository = {
    async guild(guildId) { return { ...cfg, guildId }; },
    async category(id) { return clone(categories.find((c) => c.id === id) || null); },
    async categories() { return clone(categories); },
    async participants(key) { return state.participants.filter((p) => p.key === key); },
    async addParticipant(key, id, type) { state.participants.push({ key, id, type }); },
    async removeParticipant(key, id) { state.participants = state.participants.filter((p) => !(p.key === key && p.id === id)); },
  };
  const repository = {
    async route(key) { return clone(state.routes.get(key) || null); },
    async routeByChannel(id) { return clone([...state.routes.values()].find((r) => r.discord_channel_id === id) || null); },
    async saveRoute(key, t, channelId, extra = {}) {
      if (!state.routes.has(key)) state.routes.set(key, { ticket_key: key, ticket_number: t.number, discord_channel_id: channelId, origin: 'whatsapp', channel_deleted: false, guild_id: extra.guildId, owner_discord_id: extra.ownerDiscordId, category_id: extra.categoryId, ...(extra.origin ? { origin: extra.origin } : {}) });
    },
    async delivered(key, id, dest) { return state.deliveries.has(`${key}/${id}/${dest}`); },
    async markDelivered(key, id, dest) { state.deliveries.add(`${key}/${id}/${dest}`); },
    async setRouteStatus(key, status, meta) { Object.assign(state.routes.get(key), { last_status: status, last_meta: meta }); },
    async setControlMessage(key, id) { state.routes.get(key).control_message_id = id; },
    async markChannelDeleted(key) { state.routes.get(key).channel_deleted = true; },
    async setLastRenamedAt(key) { state.routes.get(key).last_renamed_at = new Date(); },
    async countOpenDiscord(owner, guildId) { return [...state.routes.values()].filter((r) => r.owner_discord_id === owner && r.guild_id === guildId && r.origin === 'discord' && !r.channel_deleted && r.last_status !== 'CLOSED').length; },
  };
  const channelMessages = new Map();
  const discord = Object.assign(new EventEmitter(), {
    isReady: true, client: { user: { id: 'bot' } },
    async createTicketChannel(ticket, options = {}) {
      const channel = { id: `ch-${state.channels.length + 1}`, options, async delete() {} };
      state.channels.push(channel);
      return channel;
    },
    async sendMessage(channelId, payload) {
      const msg = { id: `msg-${state.dc.length + 1}`, url: `https://discord.test/${channelId}`, channelId, ...payload, async pin() {} };
      state.dc.push(msg);
      if (!channelMessages.has(channelId)) channelMessages.set(channelId, []);
      channelMessages.get(channelId).push({ id: msg.id, createdTimestamp: state.dc.length, content: payload.content || '', author: { username: 'Bot', bot: true }, attachments: new Map(), embeds: [] });
      return msg;
    },
    async editChannelMessage(channelId, messageId, payload) { state.edits.push({ channelId, messageId, ...payload }); },
    async getChannel(id) {
      return { id, name: 'ticket-1-jugador', messages: { async fetch() { return new Map((channelMessages.get(id) || []).map((m) => [m.id, m])); } } };
    },
    async lockTicketChannel(id, ids) { state.locks.push({ id, ids }); },
    async unlockTicketChannel(id, ids) { state.unlocks.push({ id, ids }); },
    async renameTicketChannel(id, name) { state.renames.push({ id, name }); },
    async deleteTicketChannel(id) { state.deleted.push(id); },
    async setTicketParticipantPermission(id, target, type, perms) { state.perms.push({ id, target, type, perms }); },
    async registerTicketCommands() {},
  });
  const service = new TicketService({
    backend, repository, discord, configRepository, localRepository,
    whatsapp: { isReady: true, async sendMessage() {} },
    config: { enabled: true, guildId: 'guild', extraGuildIds: ['staff-guild'], staffRoleIds: ['staff'], pollIntervalMs: 5000, web: { url: 'https://example.test' } },
  });
  return { service, state, backend, discord, configRepository, repository, categories };
}

const members = {
  [OWNER]: { displayName: 'Jugador', roles: [] },
  [STAFF]: { displayName: 'Ana', roles: ['shop-staff'] },
  [GUEST]: { displayName: 'Invitado', roles: [] },
};
function interaction({ customId, user = OWNER, guildId = 'guild', channelId, values, fields, id = `i-${Math.random()}` }) {
  const replies = [];
  const self = {
    id, customId, values, guildId, channelId, user: { id: user, username: members[user].displayName }, replies, deferred: false, replied: false, modal: null,
    member: { displayName: members[user].displayName },
    guild: { id: guildId, members: { async fetch(uid) { return { displayName: members[uid].displayName, permissions: { has: () => false }, roles: { cache: new Set(members[uid].roles) } }; } } },
    fields: { getTextInputValue: (k) => fields[k] },
    isChatInputCommand: () => false,
    async showModal(m) { self.modal = m; self.replied = true; },
    async deferReply() { self.deferred = true; },
    async reply(p) { self.replied = true; replies.push(p); },
    async editReply(p) { replies.push(p); },
    async update(p) { self.replied = true; replies.push(p); },
  };
  return self;
}
const text = (r) => (typeof r === 'string' ? r : r?.content);

async function openTicket(f, { user = OWNER, guildId = 'guild', categoryId = 7 } = {}) {
  const button = interaction({ customId: `tk:open:${categoryId}`, user, guildId });
  await f.service.handleInteraction(button);
  assert.ok(button.modal, text(button.replies[0]));
  const modal = interaction({ customId: `tk:modal:${categoryId}`, user, guildId, fields: { subject: 'Mi compra no llegó', message: 'Pagué el rango VIP' } });
  await f.service.handleInteraction(modal);
  return { modal, route: [...f.state.routes.values()].at(-1) };
}

test('migrateTicketSchema quita active_owner, permite owner_jid nulo y es idempotente', async () => {
  const columns = new Map([['number', 'NO'], ['owner_jid', 'NO'], ['active_owner', 'YES']]);
  const routeColumns = new Set(['ticket_key']);
  const indexes = new Set(['PRIMARY', 'uk_support_active_owner']);
  const altered = [];
  const conn = {
    async query(sql, params) {
      if (sql.includes('information_schema.COLUMNS')) {
        return params[1] === 'support_tickets' ? [...columns].map(([name, nullable]) => ({ name, nullable })) : [...routeColumns].map((name) => ({ name, nullable: 'YES' }));
      }
      if (sql.includes('information_schema.STATISTICS')) return [...indexes].map((name) => ({ name }));
      altered.push(sql);
      const add = sql.match(/ALTER TABLE (\w+) ADD COLUMN `(\w+)`/);
      if (add) (add[1] === 'support_tickets' ? columns.set(add[2], 'YES') : routeColumns.add(add[2]));
      if (/DROP COLUMN active_owner/.test(sql)) columns.delete('active_owner');
      if (/MODIFY owner_jid/.test(sql)) columns.set('owner_jid', 'YES');
      const index = sql.match(/(?:ADD INDEX|DROP INDEX) (\w+)/);
      if (index) (sql.includes('DROP') ? indexes.delete(index[1]) : indexes.add(index[1]));
      return [];
    },
  };
  await migrateTicketSchema(conn, { database: 'db' });
  assert.ok(altered.some((s) => /DROP INDEX uk_support_active_owner/.test(s)));
  assert.ok(altered.some((s) => /DROP COLUMN active_owner/.test(s)));
  assert.ok(routeColumns.has('channel_deleted') && routeColumns.has('control_message_id') && columns.has('owner_discord_id'));
  const count = altered.length;
  await migrateTicketSchema(conn, { database: 'db' });
  assert.equal(altered.length, count, 'segunda ejecución sin cambios');
});

test('panel con botón + modal crea el ticket en la categoría base, canal privado y ruta de Discord', async () => {
  const f = fixture();
  const { modal, route } = await openTicket(f);
  const ticket = f.backend.tickets.get(1);
  assert.equal(ticket.category, 'compra');
  assert.equal(ticket.priority, 'HIGH');
  assert.equal(ticket.input.discordUserId, OWNER);
  const { options } = f.state.channels[0];
  assert.equal(options.guildId, 'guild');
  assert.equal(options.ownerDiscordId, OWNER);
  assert.equal(options.categoryChannelId, 'cat-channels');
  assert.deepEqual(options.staffRoleIds.sort(), ['shop-staff', 'staff']);
  assert.match(options.channelName, /^🟠-ticket-1-jugador$/);
  assert.equal(route.origin, 'discord');
  assert.match(text(modal.replies.at(-1)), /<#ch-1>/);
  assert.ok(f.state.dc.some((m) => m.embeds?.length && m.components?.length), 'mensaje de control');
  const ping = f.state.dc.find((m) => m.content?.includes('<@&'));
  assert.deepEqual(ping.allowedMentions.roles.sort(), ['shop-staff', 'staff']);
});

test('respeta max_open_per_user y serializa dos formularios simultáneos', async () => {
  const f = fixture({ guildConfig: { maxOpenPerUser: 1 } });
  const send = () => f.service.handleInteraction(interaction({ customId: 'tk:modal:7', fields: { subject: 'Asunto válido', message: 'Hola' } }));
  await Promise.all([send(), send()]);
  assert.equal(f.backend.tickets.size, 1);
  const button = interaction({ customId: 'tk:open:7' });
  await f.service.handleInteraction(button);
  assert.equal(button.modal, null);
  assert.match(text(button.replies[0]), /máximo 1/);
});

test('rechaza categorías de otro servidor y servidores no autorizados; acepta servidores extra', async () => {
  const f = fixture();
  const foreign = interaction({ customId: 'tk:open:7', guildId: 'staff-guild' });
  await f.service.handleInteraction(foreign);
  assert.match(text(foreign.replies[0]), /ya no está disponible/, 'servidor extra permitido pero la categoría es de otro');
  const blocked = interaction({ customId: 'tk:open:7', guildId: 'unknown' });
  await f.service.handleInteraction(blocked);
  assert.match(text(blocked.replies[0]), /no autorizado/);
});

test('modo web: sin cuenta vinculada falla o cae a local según requerir_web', async () => {
  const web = memoryBackend('web');
  web.create = async () => { throw err('Primero vincula tu cuenta de Discord en Mi cuenta en la web para abrir tickets.', 403); };
  const strict = fixture({ backend: web, localRepository: memoryBackend('local') });
  const { modal } = await openTicket(strict);
  assert.match(text(modal.replies.at(-1)), /vincula tu cuenta de Discord/);
  assert.equal(strict.state.channels.length, 0);

  const local = memoryBackend('local');
  const relaxed = fixture({ backend: web, localRepository: local, guildConfig: { requireLinkedWeb: false } });
  const { route } = await openTicket(relaxed);
  assert.equal(local.tickets.size, 1);
  assert.match(route.ticket_key, /^local:/);
  assert.equal(relaxed.service.backendFor(route.ticket_key), local);
});

test('el chat del canal se guarda sin duplicarse; los invitados no escriben en el historial', async () => {
  const f = fixture();
  const { route } = await openTicket(f);
  const before = f.state.dc.length;
  const msg = (user, content, id) => ({ id, channelId: route.discord_channel_id, content, author: { id: user, username: members[user].displayName },
    member: { displayName: members[user].displayName }, attachments: new Map([['a', { url: 'https://cdn.test/a.png' }]]), guild: interaction({ customId: 'x' }).guild });
  assert.equal(await f.service.handleDiscord(msg(OWNER, 'Adjunto captura', 'd1')), true);
  assert.equal(await f.service.handleDiscord(msg(STAFF, 'Lo revisamos', 'd2')), true);
  assert.equal(await f.service.handleDiscord(msg(GUEST, 'Hola', 'd3')), true);
  const t = f.backend.tickets.get(1);
  assert.deepEqual(t.messages.slice(1).map((m) => m.body), ['Adjunto captura\nhttps://cdn.test/a.png', 'Lo revisamos\nhttps://cdn.test/a.png']);
  assert.equal(f.state.dc.slice(before).filter((m) => m.content?.startsWith('💬')).length, 0, 'no se republica en el canal');
});

test('/nota en un ticket de Discord nunca aparece en el canal del jugador', async () => {
  const f = fixture();
  const { route } = await openTicket(f);
  const note = { ...interaction({ customId: undefined, user: STAFF, channelId: route.discord_channel_id }), commandName: 'nota', isChatInputCommand: () => true,
    options: { getString: () => 'SECRETO interno', getAttachment: () => null } };
  await f.service.handleInteraction(note);
  assert.equal(f.backend.tickets.get(1).messages.at(-1).internal, true);
  assert.ok(f.state.dc.every((m) => !m.content?.includes('SECRETO')));
  await f.service.sync(f.backend.tickets.get(1));
  assert.ok(f.state.dc.every((m) => !m.content?.includes('SECRETO')));
});

test('botones: solo staff toma; el dueño cierra; cerrar bloquea y transcribe; reabrir restaura', async () => {
  const f = fixture();
  const { route } = await openTicket(f);
  f.state.participants.push({ key: route.ticket_key, id: GUEST, type: 'user' });
  const click = (customId, user) => f.service.handleInteraction(interaction({ customId, user, channelId: route.discord_channel_id }));
  const deny = interaction({ customId: 'tk:claim:1', user: OWNER, channelId: route.discord_channel_id });
  await f.service.handleInteraction(deny);
  assert.match(text(deny.replies.at(-1)), /Solo el staff/);
  await click('tk:claim:1', STAFF);
  assert.equal(f.backend.tickets.get(1).assignee.id, STAFF);
  assert.ok(f.state.edits.length, 'mensaje de control editado');
  await click('tk:close:1', OWNER);
  assert.equal(f.backend.tickets.get(1).status, 'CLOSED');
  assert.deepEqual(f.state.locks[0].ids, [{ id: OWNER, type: 'user' }, { id: GUEST, type: 'user' }]);
  assert.ok(f.state.dc.some((m) => m.channelId === 'logs' && m.files?.length), 'transcripción al cerrar');
  await click('tk:reopen:1', STAFF);
  assert.deepEqual(f.state.unlocks[0].ids, [{ id: OWNER, type: 'user' }, { id: GUEST, type: 'user' }]);
});

test('borrar exige ticket cerrado y confirmación; después sync no recrea el canal', async () => {
  const f = fixture({ guildConfig: { deleteDelaySeconds: 0 } });
  const { route } = await openTicket(f);
  const early = interaction({ customId: 'tk:delete:1', user: STAFF, channelId: route.discord_channel_id });
  await f.service.handleInteraction(early);
  assert.match(text(early.replies.at(-1)), /Cierra el ticket/);
  await f.service.handleInteraction(interaction({ customId: 'tk:close:1', user: STAFF, channelId: route.discord_channel_id }));
  const ask = interaction({ customId: 'tk:delete:1', user: STAFF, channelId: route.discord_channel_id });
  await f.service.handleInteraction(ask);
  assert.equal(ask.replies.at(-1).components[0].components[0].data.custom_id, 'tk:delete_confirm:1');
  await f.service.handleInteraction(interaction({ customId: 'tk:delete_confirm:1', user: STAFF, channelId: route.discord_channel_id }));
  assert.deepEqual(f.state.deleted, [route.discord_channel_id]);
  assert.equal(f.state.routes.get(route.ticket_key).channel_deleted, true);
  const sent = f.state.dc.length;
  f.backend.tickets.get(1).status = 'OPEN';
  await f.service.sync(f.backend.tickets.get(1));
  assert.equal(f.state.channels.length, 1);
  assert.equal(f.state.dc.length, sent);
});

test('prioridad: actualiza el embed, renombra con enfriamiento y menciona solo a los roles de staff', async () => {
  const f = fixture();
  const { route } = await openTicket(f);
  const prio = (value) => f.service.handleInteraction(interaction({ customId: 'tk:prio:1', user: STAFF, values: [value], channelId: route.discord_channel_id }));
  await prio('URGENT');
  assert.equal(f.backend.tickets.get(1).priority, 'URGENT');
  const last = f.state.edits.at(-1);
  assert.equal(last.embeds[0].data.fields.find((x) => x.name === 'Prioridad').value, '🔴 Urgente');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(f.state.renames.map((r) => r.name), ['🔴-ticket-1-jugador']);
  const ping = f.state.dc.at(-1);
  assert.match(ping.content, /Urgente/);
  assert.deepEqual(ping.allowedMentions, { roles: ['staff', 'shop-staff'] });
  await prio('LOW');
  await new Promise((r) => setImmediate(r));
  assert.equal(f.state.renames.length, 1, 'segundo cambio dentro de 5 minutos no renombra');
  const invalid = interaction({ customId: 'tk:prio:1', user: STAFF, values: ['MAX'], channelId: route.discord_channel_id });
  await f.service.handleInteraction(invalid);
  assert.match(text(invalid.replies.at(-1)), /inválida/);
});

test('un fallo al renombrar (429) no rompe la interacción', async () => {
  const f = fixture();
  const { route } = await openTicket(f);
  f.discord.renameTicketChannel = () => Promise.reject(Object.assign(new Error('rate limited'), { status: 429 }));
  const i = interaction({ customId: 'tk:prio:1', user: STAFF, values: ['LOW'], channelId: route.discord_channel_id });
  await f.service.handleInteraction(i);
  assert.equal(text(i.replies.at(-1)), 'Guardado.');
});

test('transcripción HTML escapa el contenido y TXT lista adjuntos', async () => {
  const messages = new Map([
    ['1', { createdTimestamp: 2, content: '<img src=x onerror=alert(1)>', author: { username: '"><script>' }, attachments: new Map([['a', { name: 'a.png', url: 'javascript:alert(1)' }]]), embeds: [] }],
    ['2', { createdTimestamp: 1, content: 'Primero', author: { username: 'Ana' }, attachments: new Map([['b', { name: 'b.txt', url: 'https://cdn.test/b.txt' }]]), embeds: [{ title: 'T', description: 'D' }] }],
  ]);
  const channel = { messages: { async fetch() { return messages; } } };
  const ticket = { number: 5, subject: '<b>asunto</b>', category: 'bug', priority: 'LOW', status: 'CLOSED', user: { username: 'Jugador' } };
  const html = (await generateTranscript({ channel, ticket })).buffer.toString();
  assert.ok(!html.includes('<img src=x') && !html.includes('<script>') && !html.includes('<b>asunto'));
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(!html.includes('javascript:'));
  assert.ok(html.indexOf('Primero') < html.indexOf('onerror'), 'orden cronológico');
  const txt = await generateTranscript({ channel, ticket, format: 'txt' });
  assert.equal(txt.fileName, 'ticket-5.txt');
  assert.match(txt.buffer.toString(), /\[adjunto\] b\.txt: https:\/\/cdn\.test\/b\.txt/);
  assert.equal(txt.messageCount, 2);
  assert.equal(escapeHtml(`&<>"'`), '&amp;&lt;&gt;&quot;&#39;');
});

test('/ticket add y remove gestionan permisos y nunca quitan al creador', async () => {
  const f = fixture();
  const { route } = await openTicket(f);
  const cmd = (sub, opts) => {
    const i = { ...interaction({ customId: undefined, user: STAFF, channelId: route.discord_channel_id }), commandName: 'ticket', isChatInputCommand: () => true,
      options: { getSubcommandGroup: () => null, getSubcommand: () => sub, getUser: (k) => opts[k] || null, getRole: (k) => opts[`r_${k}`] || null } };
    return f.service.handleInteraction(i).then(() => text(i.replies.at(-1)));
  };
  assert.match(await cmd('add', { usuario: { id: GUEST } }), /Acceso concedido/);
  assert.equal(f.state.perms[0].perms.SendMessages, true);
  assert.equal(f.state.participants.length, 1);
  assert.match(await cmd('remove', { usuario: { id: OWNER } }), /creador/);
  assert.match(await cmd('remove', { usuario: { id: GUEST } }), /Acceso retirado/);
  assert.equal(f.state.perms.at(-1).perms, null);
  assert.equal(f.state.participants.length, 0);
});

test('UI: panel en filas de 5 botones o menú; control según estado', () => {
  const cats = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, label: `Cat ${i}`, enabled: true, buttonStyle: 'Success' }));
  const buttons = buildPanelMessage({ title: 'T', description: 'D', mode: 'buttons' }, cats);
  assert.deepEqual(buttons.components.map((r) => r.components.length), [5, 5, 2]);
  const select = buildPanelMessage({ title: 'T', description: 'D', mode: 'select' }, cats);
  assert.equal(select.components[0].components[0].options.length, 12);
  const open = buildControlMessage({ number: 3, subject: 'x', status: 'OPEN', priority: 'HIGH', category: 'bug', assignee: null, user: {} });
  assert.deepEqual(open.components[0].components.map((b) => b.data.custom_id), ['tk:claim:3', 'tk:close:3', 'tk:transcript:3']);
  const closed = buildControlMessage({ number: 3, subject: 'x', status: 'CLOSED', priority: 'HIGH', category: 'bug', assignee: null, user: {} });
  assert.deepEqual(closed.components[0].components.map((b) => b.data.custom_id), ['tk:reopen:3', 'tk:transcript:3', 'tk:delete:3']);
  assert.equal(closed.components[1].components[0].data.disabled, true);
  assert.equal(priorityChannelName('🔵-ticket-1', 'URGENT'), '🔴-ticket-1');
});

test('createTicketChannel admite servidor, dueño y roles propios; los comandos se registran en servidores extra', async () => {
  const service = new DiscordService();
  let options;
  service.isReady = true;
  service.client = { user: { id: 'bot' }, guilds: { async fetch(id) { return { id, roles: { async fetch() { return new Map([['r1', {}]]); } }, channels: { async create(v) { options = v; return { id: 'c' }; } } }; } } };
  await service.createTicketChannel({ number: 1, subject: 'x' }, { guildId: 'other', ownerDiscordId: OWNER, staffRoleIds: ['r1'], categoryChannelId: null, channelName: 'n' });
  assert.equal(options.parent, undefined);
  assert.equal(options.name, 'n');
  assert.ok(options.permissionOverwrites.some((o) => o.id === OWNER));
  assert.ok(options.permissionOverwrites.find((o) => o.id === 'other').deny.length);
  let extra;
  service.registerGuildCommands = (commands, opts) => { extra = opts?.extra; };
  await service.registerTicketCommands([]);
  assert.equal(extra, true);
});

test('/ticket categoria y panel: solo admins, validan entradas y actualizan los paneles', async () => {
  const f = fixture();
  const created = [];
  const panels = [];
  Object.assign(f.configRepository, {
    async categoryBySlug(g, slug) { return f.categories.find((c) => c.slug === slug) || null; },
    async createCategory(g, data) { const c = { id: 99, guildId: g, enabled: true, staffRoleIds: [], baseCategory: 'soporte', defaultPriority: 'NORMAL', ...data }; created.push(c); f.categories.push(c); return c; },
    async panels() { return panels; },
    async savePanel(g, data) { panels.push({ ...data, guildId: g }); },
  });
  const admin = (manage, group, sub, opts) => {
    const i = { ...interaction({ customId: undefined, user: STAFF }), commandName: 'ticket', isChatInputCommand: () => true,
      options: { getSubcommandGroup: () => group, getSubcommand: () => sub, getString: (k) => opts[k] ?? null, getBoolean: () => null,
        getInteger: () => null, getChannel: (k) => opts[k] ?? null, getRole: () => null } };
    i.guild.members.fetch = async () => ({ permissions: { has: () => manage }, roles: { cache: new Set() } });
    return f.service.handleInteraction(i).then(() => text(i.replies.at(-1)));
  };
  assert.match(await admin(false, 'categoria', 'listar', {}), /Gestionar servidor/);
  assert.match(await admin(true, 'categoria', 'crear', { slug: 'Soporte General', nombre: 'Soporte', emoji: 'abc' }), /Emoji inválido/);
  assert.match(await admin(true, 'categoria', 'crear', { slug: 'compras', nombre: 'Otra' }), /Ya existe/);
  assert.match(await admin(true, 'categoria', 'crear', { slug: 'Soporte General', nombre: 'Soporte', emoji: '🛠️' }), /Categoría guardada/);
  assert.equal(created[0].slug, 'soporte-general');
  assert.match(await admin(true, 'panel', 'enviar', { canal: { id: 'panel-ch' }, titulo: 'Soporte', descripcion: 'Abre un ticket', color: 'rojo' }), /Color inválido/);
  assert.match(await admin(true, 'panel', 'enviar', { canal: { id: 'panel-ch' }, titulo: 'Soporte', descripcion: 'Abre un ticket', categorias: 'compras' }), /Panel publicado/);
  const panelMsg = f.state.dc.find((m) => m.channelId === 'panel-ch');
  assert.deepEqual(panelMsg.components[0].components.map((b) => b.data.custom_id), ['tk:open:7']);
  assert.deepEqual(panels[0].categoryIds, [7]);
});

test('un rol de staff borrado en Discord se omite (con aviso) y no bloquea la apertura; @everyone sí se rechaza', async (t) => {
  const service = new DiscordService();
  let options;
  service.isReady = true;
  service.client = { user: { id: 'bot' }, guilds: { async fetch(id) { return { id, roles: { async fetch() { return new Map([['r1', {}]]); } }, channels: { async create(v) { options = v; return { id: 'c' }; } } }; } } };
  const warn = t.mock.method(console, 'warn', () => {});
  await service.createTicketChannel({ number: 1, subject: 'x' }, { guildId: 'g', staffRoleIds: ['r1', 'gone'], categoryChannelId: null });
  const ids = options.permissionOverwrites.map((o) => o.id);
  assert.ok(ids.includes('r1') && !ids.includes('gone'));
  assert.match(warn.mock.calls[0].arguments[0], /gone/);
  await assert.rejects(() => service.createTicketChannel({ number: 1, subject: 'x' }, { guildId: 'g', staffRoleIds: ['g'] }), /@everyone/);
});

test('lock/unlock usan el tipo de cada participante y un fallo no detiene a los demás', async (t) => {
  const service = new DiscordService();
  const calls = [];
  t.mock.method(console, 'warn', () => {});
  service.getChannel = async () => ({ permissionOverwrites: { async edit(id, perms, opts) {
    calls.push({ id, perms, type: opts.type });
    if (id === GUEST) throw new Error('Unknown Member');
  } } });
  await service.lockTicketChannel('ch', [{ id: GUEST, type: 'user' }, { id: OWNER, type: 'user' }, { id: 'role1', type: 'role' }]);
  assert.deepEqual(calls.map((c) => [c.id, c.type, c.perms.SendMessages]), [[GUEST, 1, false], [OWNER, 1, false], ['role1', 0, false]]);
  await service.unlockTicketChannel('ch', [{ id: 'role1', type: 'role' }]);
  assert.deepEqual(calls.at(-1).perms, { SendMessages: true });
});

test('/prioridad dispara el renombrado y la mención como el selector', async () => {
  const f = fixture();
  const { route } = await openTicket(f);
  const cmd = { ...interaction({ customId: undefined, user: STAFF, channelId: route.discord_channel_id }), commandName: 'prioridad', isChatInputCommand: () => true,
    options: { getString: () => 'URGENT', getAttachment: () => null } };
  await f.service.handleInteraction(cmd);
  await new Promise((r) => setImmediate(r));
  assert.equal(f.backend.tickets.get(1).priority, 'URGENT');
  assert.deepEqual(f.state.renames.map((r) => r.name), ['🔴-ticket-1-jugador']);
  assert.match(f.state.dc.at(-1).content, /Urgente/);
});

test('max_open_per_user se cuenta por servidor', async () => {
  const f = fixture({ guildConfig: { maxOpenPerUser: 1 } });
  await openTicket(f);
  const { route } = await openTicket(f, { guildId: 'staff-guild', categoryId: 8 });
  assert.equal(route.guild_id, 'staff-guild');
  assert.equal(f.backend.tickets.size, 2);
  const again = interaction({ customId: 'tk:open:7' });
  await f.service.handleInteraction(again);
  assert.match(text(again.replies[0]), /máximo 1/);
});

test('poll() no crea un segundo canal para un ticket que se está abriendo desde un panel', async () => {
  const f = fixture();
  const create = f.discord.createTicketChannel;
  f.discord.createTicketChannel = async (ticket, options) => {
    // El sondeo llega justo entre backend.create() y saveRoute().
    if (options?.ownerDiscordId) await f.service.sync(ticket, f.backend);
    return create(ticket, options);
  };
  const { route } = await openTicket(f);
  assert.equal(f.state.channels.length, 1);
  assert.equal(route.origin, 'discord');
  assert.equal(f.service.opening.size, 0);
});

test('web #1 y local #1 usan colas distintas', () => {
  const f = fixture();
  assert.notEqual(f.service.lockKey({ name: 'web' }, 1), f.service.lockKey({ name: 'local' }, 1));
  assert.equal(f.service.routeLock({ ticket_key: 'local:abc', ticket_number: 1 }), f.service.lockKey({ name: 'local' }, 1));
});
