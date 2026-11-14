import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionFlagsBits } from 'discord.js';
import { CONFIG } from '../src/config.js';
import { MirrorService, parseChannelId } from '../src/relay/MirrorService.js';
import { ConsoleService } from '../src/services/ConsoleService.js';
import { discordService } from '../src/services/DiscordService.js';
import { dbService } from '../src/database/DatabaseService.js';
import { luckPermsService } from '../src/luckperms/LuckPermsService.js';
import { channelMappingRepository } from '../src/database/repositories/ChannelMappingRepository.js';
import { settingsRepository } from '../src/database/repositories/SettingsRepository.js';
import { isValidAlias, withSetting } from '../src/relay/relayRouting.js';

const HUB = '111111111111111111';
const PUBLIC = '222222222222222222';
const JID = '123@g.us';
const duplicate = () => Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY', errno: 1062 });

function stub(t, target, methods) {
  const original = {};
  for (const [name, fn] of Object.entries(methods)) { original[name] = target[name]; target[name] = fn; }
  t.after(() => Object.assign(target, original));
}

/** Vínculos en memoria con las mismas reglas de unicidad que la tabla. */
function fakeLinks(t, links) {
  let nextId = 100;
  const sameAlias = (a, b) => a && b && a.toLowerCase() === b.toLowerCase();
  stub(t, channelMappingRepository, {
    getByAlias: async (alias) => links.find((l) => sameAlias(l.alias, alias)) || null,
    getById: async (id) => links.find((l) => l.id === id) || null,
    getByPair: async (jid, ch) => links.find((l) => l.whatsapp_jid === jid && l.discord_channel_id === ch) || null,
    getByDiscordChannelId: async (ch) => links.find((l) => l.discord_channel_id === ch) || null,
    getByWhatsAppJid: async (jid) => links.find((l) => l.whatsapp_jid === jid) || null,
    getAllForChannel: async (ch) => links.filter((l) => l.discord_channel_id === ch),
    getMirrors: async () => links.filter((l) => l.direction === 'wa_to_dc'),
    searchAliases: async (prefix = '') => links.filter((l) => l.alias?.toLowerCase().startsWith(prefix.toLowerCase())),
    addMirror: async (m) => {
      if (links.some((l) => sameAlias(l.alias, m.alias))) throw duplicate();
      links.push({ id: nextId++, whatsapp_jid: m.whatsappJid, discord_channel_id: m.discordChannelId, discord_guild_id: m.discordGuildId, alias: m.alias, direction: 'wa_to_dc', enabled: 1, settings: null, webhook_url: m.webhookUrl, created_by: m.createdBy });
    },
    removeMirror: async (id) => {
      const i = links.findIndex((l) => l.id === id && l.direction === 'wa_to_dc');
      if (i < 0) return 0;
      links.splice(i, 1); return 1;
    },
    setAlias: async (id, alias) => {
      if (links.some((l) => l.id !== id && sameAlias(l.alias, alias))) throw duplicate();
      links.find((l) => l.id === id).alias = alias;
    },
    setEnabled: async (id, enabled) => { links.find((l) => l.id === id).enabled = enabled ? 1 : 0; },
    setDirection: async (id, direction) => {
      const link = links.find((l) => l.id === id);
      if (direction !== 'wa_to_dc' && links.some((l) => l.id !== id && l.direction !== 'wa_to_dc' && l.discord_channel_id === link.discord_channel_id)) throw duplicate();
      link.direction = direction;
    },
    setSettings: async (id, settings) => { links.find((l) => l.id === id).settings = Object.keys(settings).length ? settings : null; },
  });
  return links;
}

const hubLink = (extra = {}) => ({ id: 1, whatsapp_jid: JID, discord_channel_id: HUB, discord_guild_id: 'G-HUB', alias: null, direction: 'both', enabled: 1, settings: null, webhook_url: 'https://hook/hub', ...extra });

/** Ejecuta /espejo <sub> con esas opciones y devuelve la respuesta. */
async function espejo(t, sub, options, { channelId = HUB, webhooks = [] } = {}) {
  const guildId = CONFIG.discord.guildId; CONFIG.discord.guildId = '';
  t.after(() => { CONFIG.discord.guildId = guildId; });
  stub(t, luckPermsService, { check: async () => ({ available: false }) });
  const channel = {
    isTextBased: () => true, guild: { id: 'G-PUBLICO', name: 'Público', members: { me: {} } },
    permissionsFor: () => ({ has: () => true }),
    createWebhook: async () => { webhooks.push(1); return { url: 'https://hook/nuevo' }; },
  };
  const client = discordService.client; discordService.client = { channels: { fetch: async () => channel } };
  t.after(() => { discordService.client = client; });
  let reply = null;
  await new MirrorService().handleInteraction({
    commandName: 'espejo', channelId, guildId: 'G-HUB', user: { id: 'U1' },
    isAutocomplete: () => false, isChatInputCommand: () => true,
    memberPermissions: { has: (p) => p === PermissionFlagsBits.ManageGuild },
    options: { getSubcommand: () => sub, getString: (name) => options[name] ?? null },
    deferReply: async () => {}, editReply: async (text) => { reply = text; },
  });
  return reply;
}

test('parseChannelId acepta ID, mención y enlace', () => {
  assert.equal(parseChannelId('123456789012345678'), '123456789012345678');
  assert.equal(parseChannelId('<#123456789012345678>'), '123456789012345678');
  assert.equal(parseChannelId('https://discord.com/channels/111111111111111111/222222222222222222'), '222222222222222222');
  assert.equal(parseChannelId('hola'), null);
});

test('/espejo agregar crea un vínculo wa_to_dc con el chat del canal actual, su servidor y alias', async (t) => {
  const links = fakeLinks(t, [hubLink()]);
  const reply = await espejo(t, 'agregar', { canal: `<#${PUBLIC}>`, alias: 'publico' });
  assert.match(reply, /✅/);
  assert.deepEqual(
    (({ whatsapp_jid, discord_channel_id, discord_guild_id, alias, direction, webhook_url, created_by }) => ({ whatsapp_jid, discord_channel_id, discord_guild_id, alias, direction, webhook_url, created_by }))(links[1]),
    { whatsapp_jid: JID, discord_channel_id: PUBLIC, discord_guild_id: 'G-PUBLICO', alias: 'publico', direction: 'wa_to_dc', webhook_url: 'https://hook/nuevo', created_by: 'U1' },
  );
});

test('/espejo agregar reutiliza el webhook del canal y rechaza duplicados, "todos" y el canal principal', async (t) => {
  const links = fakeLinks(t, [hubLink({ alias: 'general' }), { ...hubLink(), id: 2, whatsapp_jid: 'otro@g.us', discord_channel_id: PUBLIC, direction: 'wa_to_dc', webhook_url: 'https://hook/publico' }]);
  const webhooks = [];
  assert.match(await espejo(t, 'agregar', { canal: PUBLIC, chat: 'general' }, { webhooks }), /✅/);
  assert.equal(links[2].webhook_url, 'https://hook/publico');
  assert.equal(webhooks.length, 0, 'no se crea otro webhook en el mismo canal');

  assert.match(await espejo(t, 'agregar', { canal: PUBLIC, chat: JID }), /ya existe/);
  assert.match(await espejo(t, 'agregar', { canal: HUB, chat: JID }), /canal principal/);
  assert.match(await espejo(t, 'agregar', { canal: PUBLIC, chat: 'todos' }), /Ya no se puede/);
  assert.match(await espejo(t, 'agregar', { canal: '333333333333333333', chat: JID, alias: 'GENERAL' }), /ya lo usa otro vínculo/);
  assert.match(await espejo(t, 'agregar', { canal: PUBLIC, chat: JID, alias: '12345' }), /no puede ser solo números/);
  assert.equal(links.length, 3);
});

test('/espejo quitar borra espejos por alias o por canal+chat, y nunca el canal principal', async (t) => {
  const mirror = (id, alias) => ({ ...hubLink(), id, discord_channel_id: `${PUBLIC.slice(0, -1)}${id}`, direction: 'wa_to_dc', alias });
  const links = fakeLinks(t, [hubLink({ alias: 'general' }), mirror(2, 'publico'), mirror(3, null)]);
  assert.match(await espejo(t, 'quitar', { canal: 'general' }), /canal principal/);
  assert.match(await espejo(t, 'quitar', { canal: HUB, chat: JID }), /canal principal/);
  assert.equal(links.length, 3);
  assert.match(await espejo(t, 'quitar', { canal: 'publico' }), /Espejo eliminado/);
  assert.match(await espejo(t, 'quitar', { canal: links[1].discord_channel_id }), /Espejo eliminado/); // chat: el del canal actual
  assert.deepEqual(links.map((l) => l.id), [1]);
  assert.match(await espejo(t, 'quitar', { canal: PUBLIC, chat: JID }), /no existía/);
});

test('/espejo alias nombra un vínculo por canal, chat o número; alias-quitar lo borra', async (t) => {
  const links = fakeLinks(t, [hubLink(), { ...hubLink(), id: 2, discord_channel_id: PUBLIC, direction: 'wa_to_dc' }, { ...hubLink(), id: 3, whatsapp_jid: 'otro@g.us', discord_channel_id: PUBLIC, direction: 'wa_to_dc' }]);
  assert.match(await espejo(t, 'alias', { nombre: 'general', id: HUB }), /#1/);
  assert.match(await espejo(t, 'alias', { nombre: 'pub', id: PUBLIC }), /varios vínculos/);
  assert.match(await espejo(t, 'alias', { nombre: 'pub', id: '#3' }), /#3/);
  assert.match(await espejo(t, 'alias', { nombre: 'General', id: '#2' }), /ya lo usa otro vínculo/);
  assert.match(await espejo(t, 'alias', { nombre: 'x y', id: '#2' }), /solo puede tener/);
  assert.deepEqual(links.map((l) => l.alias), ['general', null, 'pub']);
  assert.match(await espejo(t, 'listar', {}), /`pub` → `#3`/);
  assert.match(await espejo(t, 'alias-quitar', { nombre: 'PUB' }), /eliminado/);
  assert.equal(links[2].alias, null);
});

test('consola "relay": alias, pausa, dirección y ajustes, con sus validaciones', async (t) => {
  const links = fakeLinks(t, [hubLink(), { ...hubLink(), id: 2, whatsapp_jid: 'otro@g.us', direction: 'wa_to_dc' }]);
  let globals = null;
  stub(t, settingsRepository, { get: async () => globals, set: async (_key, value) => { globals = value; } });
  const connected = dbService.isConnected; dbService.isConnected = true;
  t.after(() => { dbService.isConnected = connected; });
  const out = [];
  t.mock.method(console, 'log', (line) => out.push(String(line)));
  const relay = async (line) => { out.length = 0; await new ConsoleService().handleRelayCommand(line.split(' ')); return out.join('\n'); };

  assert.match(await relay('#1 alias general'), /✅/);
  assert.match(await relay('general pausar'), /pausado/);
  assert.equal(links[0].enabled, 0);
  assert.match(await relay('1 activar'), /activo/);
  assert.match(await relay('2 alias GENERAL'), /ya lo usa otro vínculo/);
  assert.match(await relay('2 direccion both'), /solo puede haber uno por canal/);
  assert.match(await relay('2 direccion arriba'), /no válida/);
  assert.match(await relay('1 direccion dc_to_wa'), /✅/);
  assert.match(await relay('1 ajuste on_delete delete'), /✅/);
  assert.deepEqual(links[0].settings, { on_delete: 'delete' });
  assert.match(await relay('1 ajuste on_delete explotar'), /Valor no válido/);
  assert.match(await relay('1 ajuste inventado x'), /Ajuste desconocido/);
  assert.match(await relay('1 ajuste on_delete -'), /✅/);
  assert.equal(links[0].settings, null);
  assert.match(await relay('global on_delete ignore'), /✅/);
  assert.equal(globals, '{"on_delete":"ignore"}');
  assert.match(await relay('99 pausar'), /No hay ningún vínculo/);
  assert.match(await relay('1 bailar'), /Uso:/);
});

test('isValidAlias y withSetting', () => {
  assert.equal(isValidAlias('público-1'), true);
  assert.equal(isValidAlias('a'), false);
  assert.equal(isValidAlias('123'), false);
  assert.equal(isValidAlias('con espacio'), false);
  assert.deepEqual(withSetting('{"on_delete":"mark"}', 'on_delete', null), {});
  assert.deepEqual(withSetting(null, 'on_delete', 'ignore'), { on_delete: 'ignore' });
});
