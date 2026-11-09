import test from 'node:test';
import assert from 'node:assert/strict';
import { MirrorService, parseChannelId } from '../src/relay/MirrorService.js';
import { discordService } from '../src/services/DiscordService.js';
import { mirrorRepository } from '../src/database/repositories/MirrorRepository.js';

test('parseChannelId acepta ID, mención y enlace', () => {
  assert.equal(parseChannelId('123456789012345678'), '123456789012345678');
  assert.equal(parseChannelId('<#123456789012345678>'), '123456789012345678');
  assert.equal(parseChannelId('https://discord.com/channels/111111111111111111/222222222222222222'), '222222222222222222');
  assert.equal(parseChannelId('hola'), null);
});

test('forwardMessage entrega a cada espejo y un fallo no afecta a los demás', async () => {
  const sentWebhook = [];
  const sentBot = [];
  const origGet = mirrorRepository.getForJid;
  const origHook = discordService.sendViaWebhook;
  const origSend = discordService.sendMessage;
  mirrorRepository.getForJid = async () => [
    { id: 1, discord_channel_id: 'A', webhook_url: 'https://hook/a' },
    { id: 2, discord_channel_id: 'B', webhook_url: null },
    { id: 3, discord_channel_id: 'C', webhook_url: null },
  ];
  discordService.sendViaWebhook = async (url, p) => { sentWebhook.push({ url, p }); };
  discordService.sendMessage = async (id, p) => {
    if (id === 'B') throw new Error('sin permisos');
    sentBot.push({ id, p });
  };
  try {
    await new MirrorService().forwardMessage('123@g.us', 'Mi grupo', { content: 'hola', username: 'Ana' });
  } finally {
    mirrorRepository.getForJid = origGet;
    discordService.sendViaWebhook = origHook;
    discordService.sendMessage = origSend;
  }
  assert.equal(sentWebhook[0].p.username, 'Ana · Mi grupo');
  assert.equal(sentBot.length, 1);
  assert.equal(sentBot[0].id, 'C');
  assert.match(sentBot[0].p.content, /Ana · Mi grupo/);
});

test('los alias se expanden a ID/JID y lo desconocido pasa igual', async () => {
  const { aliasRepository } = await import('../src/database/repositories/MirrorRepository.js');
  const orig = aliasRepository.resolve;
  aliasRepository.resolve = async (a) => (a === 'logs' ? '222222222222222222' : null);
  try {
    const svc = new MirrorService();
    assert.equal(await svc.expand('logs'), '222222222222222222');
    assert.equal(await svc.expand('333333333333333333'), '333333333333333333');
  } finally {
    aliasRepository.resolve = orig;
  }
});
