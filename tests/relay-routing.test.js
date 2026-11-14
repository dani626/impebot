import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { RelayEngine } from '../src/relay/RelayEngine.js';
import { MessageTransformer } from '../src/relay/MessageTransformer.js';
import { discordService } from '../src/services/DiscordService.js';
import { whatsAppService } from '../src/services/WhatsAppService.js';
import { ticketService } from '../src/tickets/index.js';
import { channelMappingRepository } from '../src/database/repositories/ChannelMappingRepository.js';
import { messageMappingRepository } from '../src/database/repositories/MessageMappingRepository.js';
import { userMappingRepository } from '../src/database/repositories/UserMappingRepository.js';
import { settingsRepository } from '../src/database/repositories/SettingsRepository.js';
import {
  displayNameFor, parseSettings, pendingDestinations, resolveSetting, retargetQuoteLink,
} from '../src/relay/relayRouting.js';

const JID = 'grupo@g.us';
const link = (id, direction = 'both', extra = {}) => ({
  id, whatsapp_jid: JID, discord_channel_id: `chan${id}`, discord_guild_id: direction === 'wa_to_dc' ? 'PUBLICO' : 'HUB',
  alias: null, direction, enabled: 1, settings: null, webhook_url: `https://hook/${id}`, webhook_id: null, ...extra,
});

/** Sustituye métodos de los singletons y devuelve cómo restaurarlos. */
function stub(t, target, methods) {
  const original = {};
  for (const [name, fn] of Object.entries(methods)) { original[name] = target[name]; target[name] = fn; }
  t.after(() => Object.assign(target, original));
}

/**
 * Motor con una "base de datos" en memoria que aplica las mismas reglas que las consultas reales:
 * salida = activos both/wa_to_dc; entrada = activo both/dc_to_wa.
 */
function setup(t, { links, rows = [], hubGuildId = '', transform, globalSettings = null }) {
  const sent = []; const saved = [...rows]; const waSent = []; const edits = []; const deletes = []; const notices = []; const attempts = [];
  const relay = { ...CONFIG.relay }; const guildId = CONFIG.discord.guildId;
  CONFIG.relay.enabled = true; CONFIG.relay.relayOwnMessages = false; CONFIG.discord.guildId = hubGuildId;
  t.after(() => { Object.assign(CONFIG.relay, relay); CONFIG.discord.guildId = guildId; });

  stub(t, ticketService, { handleWhatsApp: async () => false, handleDiscord: async () => false });
  stub(t, userMappingRepository, { getByWhatsAppJid: async () => null });
  stub(t, settingsRepository, { get: async () => globalSettings });
  stub(t, whatsAppService, {
    getProfilePictureUrl: async () => null,
    getChatName: async () => 'Grupo Uno',
    sendMessage: async (jid, content) => { waSent.push({ jid, content }); return { key: { id: `wa-out-${waSent.length}` } }; },
  });
  stub(t, channelMappingRepository, {
    getOutboundForJid: async (jid) => links.filter((l) => l.whatsapp_jid === jid && l.enabled && l.direction !== 'dc_to_wa'),
    getInboundForChannel: async (ch) => links.find((l) => l.discord_channel_id === ch && l.enabled && l.direction !== 'wa_to_dc') || null,
    existsInGuild: async (jid, guild) => links.some((l) => l.whatsapp_jid === jid && [guild, ''].includes(l.discord_guild_id)),
    getById: async (id) => links.find((l) => l.id === id) || null,
    getByWhatsAppJid: async (jid) => links.find((l) => l.whatsapp_jid === jid) || null,
  });
  stub(t, messageMappingRepository, {
    getAllByWaMessageId: async (id) => saved.filter((r) => r.wa_message_id === id),
    exists: async (wa, dc) => saved.some((r) => (wa && r.wa_message_id === wa) || (dc && r.discord_message_id === dc)),
    save: async (r) => { saved.push({ wa_message_id: r.waMessageId, discord_message_id: r.discordMessageId, channel_mapping_id: r.channelMappingId, origin_platform: r.originPlatform }); },
  });
  stub(t, discordService, {
    sendViaWebhook: async (url, payload) => {
      attempts.push(payload);
      if (url.endsWith('/caido')) throw new Error('webhook caído');
      sent.push({ url, ...payload }); return { id: `dc-${url.split('/').pop()}` };
    },
    sendMessage: async (channelId, payload) => {
      if (channelId === 'chancaido') throw new Error('canal caído');
      notices.push({ channelId, ...payload }); return { id: `bot-${channelId}` };
    },
    editWebhookMessage: async (url, id, payload) => { edits.push({ url, id, ...payload }); },
    deleteWebhookMessage: async (url, id) => { deletes.push({ url, id }); },
  });
  stub(t, MessageTransformer, {
    toDiscord: transform || (async (wa) => ({ content: wa.text, files: [], embeds: [], pendingCatboxVideo: null, quote: null })),
    toWhatsApp: async (msg) => [{ content: { text: msg.cleanContent } }],
  });
  return { engine: new RelayEngine(), sent, saved, waSent, edits, deletes, notices, attempts };
}

const waMessage = (extra = {}) => ({ jid: JID, messageId: 'WA1', sender: '591@s.whatsapp.net', pushName: 'Ana', text: 'hola', isFromMe: false, ...extra });
const dcMessage = (channelId, id = 'DC1') => ({ id, channelId, cleanContent: 'desde discord', attachments: { size: 0 }, author: { username: 'Luis' }, member: null });

test('WhatsApp → Discord llega a todos los canales both/wa_to_dc y guarda una fila por vínculo', async (t) => {
  const { engine, sent, saved } = setup(t, { links: [link(1), link(2, 'wa_to_dc'), link(3, 'wa_to_dc')] });
  await engine.handleWhatsAppMessage(waMessage());
  assert.deepEqual(sent.map((s) => s.url).sort(), ['https://hook/1', 'https://hook/2', 'https://hook/3']);
  assert.deepEqual(saved.map((r) => [r.channel_mapping_id, r.discord_message_id, r.origin_platform]).sort(),
    [[1, 'dc-1', 'whatsapp'], [2, 'dc-2', 'whatsapp'], [3, 'dc-3', 'whatsapp']]);
  // El canal principal muestra solo el nombre; los espejos añaden el chat.
  assert.equal(sent.find((s) => s.url.endsWith('/1')).username, 'Ana');
  assert.equal(sent.find((s) => s.url.endsWith('/2')).username, 'Ana · Grupo Uno');
});

test('WhatsApp → Discord nunca usa vínculos dc_to_wa ni pausados', async (t) => {
  const { engine, sent, saved } = setup(t, { links: [link(1, 'dc_to_wa'), link(2, 'both', { enabled: 0 }), link(3, 'wa_to_dc', { enabled: 0 })] });
  await engine.handleWhatsAppMessage(waMessage());
  assert.equal(sent.length, 0);
  assert.equal(saved.length, 0);
});

test('Discord → WhatsApp solo sale por vínculos both o dc_to_wa activos', async (t) => {
  const links = [link(1), link(2, 'wa_to_dc'), link(3, 'dc_to_wa'), link(4, 'both', { enabled: 0 })];
  const { engine, waSent, saved } = setup(t, { links });
  await engine.handleDiscordMessage(dcMessage('chan2', 'DC-espejo'));
  await engine.handleDiscordMessage(dcMessage('chan4', 'DC-pausado'));
  await engine.handleDiscordMessage(dcMessage('sin-vinculo', 'DC-otro'));
  assert.equal(waSent.length, 0, 'un espejo, un canal pausado o uno sin vínculo no escriben a WhatsApp');

  await engine.handleDiscordMessage(dcMessage('chan1', 'DC-both'));
  await engine.handleDiscordMessage(dcMessage('chan3', 'DC-solo-ida'));
  assert.deepEqual(waSent.map((m) => m.jid), [JID, JID]);
  assert.deepEqual(saved.map((r) => [r.channel_mapping_id, r.origin_platform]), [[1, 'discord'], [3, 'discord']]);
});

test('un mensaje repetido de WhatsApp no se reenvía dos veces a ningún canal', async (t) => {
  const { engine, sent } = setup(t, { links: [link(1), link(2, 'wa_to_dc')] });
  await engine.handleWhatsAppMessage(waMessage());
  await engine.handleWhatsAppMessage(waMessage());
  assert.equal(sent.length, 2);
});

test('el eco de un mensaje escrito en Discord no vuelve a su canal, pero sí llega a los demás', async (t) => {
  const { engine, sent, waSent } = setup(t, { links: [link(1), link(2, 'wa_to_dc')] });
  await engine.handleDiscordMessage(dcMessage('chan1'));
  CONFIG.relay.relayOwnMessages = true;
  await engine.handleWhatsAppMessage(waMessage({ messageId: 'wa-out-1', isFromMe: true }));
  assert.equal(waSent.length, 1);
  assert.deepEqual(sent.map((s) => s.url), ['https://hook/2']);
  // Y un mensaje de bot publicado en Discord por el relay nunca sale a WhatsApp.
  await engine.handleDiscordMessage(dcMessage('chan1'));
  assert.equal(waSent.length, 1);
});

test('con un solo vínculo both, el eco de Discord se descarta como antes', async (t) => {
  const { engine, sent } = setup(t, { links: [link(1)] });
  await engine.handleDiscordMessage(dcMessage('chan1'));
  CONFIG.relay.relayOwnMessages = true;
  await engine.handleWhatsAppMessage(waMessage({ messageId: 'wa-out-1', isFromMe: true }));
  assert.equal(sent.length, 0);
});

test('un canal caído no impide la entrega a los demás', async (t) => {
  const links = [link(1, 'both', { webhook_url: 'https://hook/caido', discord_channel_id: 'chancaido' }), link(2, 'wa_to_dc')];
  const { engine, sent, saved } = setup(t, { links });
  const error = t.mock.method(console, 'error', () => {}); t.mock.method(console, 'warn', () => {});
  await engine.handleWhatsAppMessage(waMessage());
  assert.deepEqual(sent.map((s) => s.url), ['https://hook/2']);
  assert.deepEqual(saved.map((r) => r.channel_mapping_id), [2]);
  assert.equal(error.mock.callCount(), 1);
});

test('ningún canal notifica @everyone/@here ni roles, por webhook ni por bot', async (t) => {
  const links = [link(1), link(2, 'wa_to_dc', { webhook_url: 'https://hook/caido' })];
  const { engine, attempts, notices } = setup(t, { links });
  t.mock.method(console, 'warn', () => {});
  await engine.handleWhatsAppMessage(waMessage({ text: '@everyone @here <@&123> hola' }));
  assert.equal(attempts.length, 2);
  assert.equal(notices.length, 1, 'el espejo con webhook caído sale por el bot');
  assert.match(notices[0].content, /Ana · Grupo Uno/);
  for (const payload of [...attempts, ...notices]) assert.deepEqual(payload.allowedMentions, { parse: [] });
});

test('el enlace de una cita apunta a la copia de cada canal, o se quita si no existe', async (t) => {
  const quotedRows = [
    { wa_message_id: 'CITADO', discord_message_id: 'q1', channel_mapping_id: 1, origin_platform: 'whatsapp' },
    { wa_message_id: 'CITADO', discord_message_id: 'q2', channel_mapping_id: 2, origin_platform: 'whatsapp' },
  ];
  const url1 = 'https://discord.com/channels/HUB/chan1/q1';
  const transform = async (wa, ctx) => {
    assert.deepEqual(ctx, { channelId: 'chan1', guildId: 'HUB', mappingId: 1 });
    return { content: `> 💬 **x:** cita • [Ver mensaje](${url1})\n> 🔗 ${url1}\nrespuesta`, files: [], embeds: [], pendingCatboxVideo: null, quote: { copies: quotedRows, jumpUrl: url1 } };
  };
  const { engine, sent } = setup(t, { links: [link(1), link(2, 'wa_to_dc'), link(3, 'wa_to_dc')], rows: quotedRows, transform });
  await engine.handleWhatsAppMessage(waMessage());
  const content = (n) => sent.find((s) => s.url.endsWith(`/${n}`)).content;
  assert.match(content(1), /channels\/HUB\/chan1\/q1/);
  assert.match(content(2), /channels\/PUBLICO\/chan2\/q2/);
  assert.doesNotMatch(content(2), /chan1/);
  assert.equal(content(3), '> 💬 **x:** cita\nrespuesta');
});

test('sin canal en el hub se crea uno aunque exista un espejo; con canal pausado en el hub, no', async (t) => {
  const links = [link(2, 'wa_to_dc')];
  const { engine, sent } = setup(t, { links, hubGuildId: 'HUB' });
  let created = 0;
  engine.createMappingChannel = async () => { created++; await new Promise((r) => setImmediate(r)); const l = link(9); links.push(l); return l; };
  // Dos mensajes simultáneos de un chat nuevo crean un único canal.
  await Promise.all([engine.handleWhatsAppMessage(waMessage()), engine.handleWhatsAppMessage(waMessage({ messageId: 'WA2' }))]);
  assert.equal(created, 1);
  assert.deepEqual(sent.map((s) => s.url).sort(), ['https://hook/2', 'https://hook/2', 'https://hook/9', 'https://hook/9']);

  links.length = 0; links.push(link(1, 'both', { enabled: 0 }));
  await engine.handleWhatsAppMessage(waMessage({ messageId: 'WA3' }));
  assert.equal(created, 1, 'pausar el canal del hub no debe crear otro');
});

test('un borrado en WhatsApp se aplica a cada copia según on_delete del vínculo', async (t) => {
  const links = [link(1), link(2, 'wa_to_dc', { settings: '{"on_delete":"delete"}' }), link(3, 'wa_to_dc', { settings: { on_delete: 'ignore' } }), link(4, 'wa_to_dc', { enabled: 0 })];
  const rows = [1, 2, 3, 4].map((n) => ({ wa_message_id: 'WA1', discord_message_id: `dc-${n}`, channel_mapping_id: n, origin_platform: 'whatsapp' }));
  const { engine, edits, deletes } = setup(t, { links, rows });
  t.mock.method(console, 'log', () => {});
  await engine.handleWhatsAppDelete({ waMessageId: 'WA1', remoteJid: JID });
  assert.deepEqual(edits.map((e) => e.id), ['dc-1'], 'por defecto se marca como eliminado');
  assert.deepEqual(deletes, [{ url: 'https://hook/2', id: 'dc-2' }]);
});

test('on_delete hereda vínculo → global → código y descarta valores inválidos', () => {
  assert.equal(resolveSetting('on_delete', { settings: null }), 'mark');
  assert.equal(resolveSetting('on_delete', { settings: null }, '{"on_delete":"delete"}'), 'delete');
  assert.equal(resolveSetting('on_delete', { settings: '{"on_delete":"ignore"}' }, '{"on_delete":"delete"}'), 'ignore');
  assert.equal(resolveSetting('on_delete', { settings: '{"on_delete":"explotar"}' }, { on_delete: 'delete' }), 'delete');
  assert.equal(resolveSetting('on_delete', { settings: 'no es json' }, 'tampoco'), 'mark');
  assert.throws(() => resolveSetting('inventado', {}));
  assert.deepEqual(parseSettings('[1]'), [1]);
});

test('pendingDestinations, displayNameFor y retargetQuoteLink', () => {
  const links = [{ id: 1 }, { id: 2 }];
  assert.deepEqual(pendingDestinations(links, []), links);
  assert.deepEqual(pendingDestinations(links, [{ channel_mapping_id: 1 }]), [{ id: 2 }]);
  assert.deepEqual(pendingDestinations(links, [{ channel_mapping_id: null }]), [], 'copia sin vínculo: no reenviar');
  assert.equal(displayNameFor({ direction: 'both' }, 'Ana', 'Grupo'), 'Ana');
  assert.equal(displayNameFor({ direction: 'wa_to_dc' }, 'Ana', null), 'Ana');
  assert.equal(retargetQuoteLink('sin cita', null, 'x'), 'sin cita');
  assert.equal(retargetQuoteLink('a U b U', 'U', 'V'), 'a V b V');
});
