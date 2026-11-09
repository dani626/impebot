import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { MirrorService } from '../src/relay/MirrorService.js';
import { discordService } from '../src/services/DiscordService.js';
import { MessageTransformer, mediaSizeLimit, toByteCount } from '../src/relay/MessageTransformer.js';
import { WhatsAppService } from '../src/services/WhatsAppService.js';

const MB = 1024 * 1024;

test('los espejos nunca notifican @everyone/@here ni roles, por webhook ni por bot', async () => {
  const payloads = [];
  const origHook = discordService.sendViaWebhook;
  const origSend = discordService.sendMessage;
  discordService.sendViaWebhook = async (_url, p) => { payloads.push(p); throw new Error('webhook caído'); };
  discordService.sendMessage = async (_id, p) => { payloads.push(p); };
  try {
    await new MirrorService().deliver({ id: 1, discord_channel_id: 'A', webhook_url: 'https://hook/a' }, 'Grupo', {
      content: '@everyone @here <@&123> hola',
    });
  } finally {
    discordService.sendViaWebhook = origHook;
    discordService.sendMessage = origSend;
  }
  assert.equal(payloads.length, 2);
  for (const p of payloads) assert.deepEqual(p.allowedMentions, { parse: [] });
});

test('toByteCount acepta número, string y Long', () => {
  assert.equal(toByteCount(1234), 1234);
  assert.equal(toByteCount('2048'), 2048);
  assert.equal(toByteCount({ toNumber: () => 4096 }), 4096);
  assert.equal(toByteCount(undefined), 0);
  assert.equal(toByteCount('basura'), 0);
});

test('mediaSizeLimit: Discord para adjuntos, Catbox amplía solo videos', () => {
  const config = { catbox: { enabled: true, maxDirectUploadBytes: 10 * MB }, relay: { maxMediaBytes: 100 * MB } };
  assert.equal(mediaSizeLimit({ isVideo: true }, config), 100 * MB);
  assert.equal(mediaSizeLimit({}, config), 10 * MB);
  assert.equal(mediaSizeLimit({ isVideo: true }, { ...config, catbox: { ...config.catbox, enabled: false } }), 10 * MB);
});

test('un documento enorme no se descarga y se avisa en Discord', async () => {
  const result = await MessageTransformer.toDiscord({
    rawMessage: { key: { id: 'X', remoteJid: 'g@g.us' }, message: { documentMessage: { fileName: 'iso.zip', fileLength: 1500 * MB } } },
    text: 'mira esto',
  });
  assert.equal(result.files.length, 0);
  assert.equal(result.pendingCatboxVideo, null);
  assert.match(result.content, /omitido/);
});

test('un fallo al reconectar se reprograma con espera creciente, sin promesas sin manejar', async (t) => {
  mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => mock.timers.reset());
  const wa = new WhatsAppService();
  let calls = 0;
  wa.start = async () => { calls++; throw new Error('sin red'); };

  wa.scheduleReconnect();
  assert.equal(wa.reconnectAttempts, 1);
  mock.timers.tick(3000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  assert.equal(wa.reconnectAttempts, 2);
  assert.ok(wa.reconnectTimer, 'debe quedar otro reintento programado');

  wa.stop();
  assert.equal(wa.reconnectTimer, null);
  wa.scheduleReconnect();
  assert.equal(wa.reconnectTimer, null, 'tras stop() no se reconecta');
});
