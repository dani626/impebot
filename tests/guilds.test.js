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
