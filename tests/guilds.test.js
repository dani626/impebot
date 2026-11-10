import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { commandGuildIds, isCommandGuild } from '../src/utils/guilds.js';

test('los servidores extra solo valen para los comandos que lo piden', (t) => {
  const previous = { ...CONFIG.discord };
  t.after(() => Object.assign(CONFIG.discord, previous));
  Object.assign(CONFIG.discord, { guildId: 'HUB', extraGuildIds: ['PUBLIC', 'HUB'] });

  assert.equal(isCommandGuild('HUB'), true);
  assert.equal(isCommandGuild('PUBLIC'), false, 'tickets y espejo: solo el principal');
  assert.equal(isCommandGuild('PUBLIC', { extra: true }), true, 'música y /minecraft');
  assert.equal(isCommandGuild('OTHER', { extra: true }), false);
  assert.deepEqual(commandGuildIds(), ['HUB']);
  assert.deepEqual(commandGuildIds({ extra: true }), ['HUB', 'PUBLIC']);

  Object.assign(CONFIG.discord, { guildId: '', extraGuildIds: [] });
  assert.equal(isCommandGuild('ANY'), true, 'sin DISCORD_GUILD_ID se atiende cualquier servidor');
});

test('los comandos de cada servidor se envían juntos en una sola petición', async (t) => {
  const { DiscordService } = await import('../src/services/DiscordService.js');
  const previous = { ...CONFIG.discord };
  t.after(() => Object.assign(CONFIG.discord, previous));
  Object.assign(CONFIG.discord, { guildId: 'HUB', extraGuildIds: ['PUBLIC', 'GONE'] });

  const calls = [];
  const discord = new DiscordService();
  discord.commandDelayMs = 5;
  discord.client = {
    guilds: {
      fetch: async (id) => {
        if (id === 'GONE') throw new Error('Unknown Guild');
        return { name: id, commands: { set: async (list) => { calls.push([id, list.map((c) => c.name).sort()]); } } };
      },
    },
  };
  const errors = [];
  t.mock.method(console, 'error', (...args) => errors.push(args.join(' ')));
  t.mock.method(console, 'log', () => {});

  await Promise.all([
    discord.registerGuildCommands([{ name: 'play' }], { extra: true }),
    discord.registerGuildCommands([{ name: 'espejo' }]),
  ]);
  assert.deepEqual(calls, [
    ['HUB', ['espejo', 'mirror', 'play', 'reproducir']],
    ['PUBLIC', ['play', 'reproducir']],
  ]);
  assert.match(errors.join('\n'), /GONE: Unknown Guild/, 'un servidor extra que falla no impide los demás');
});
