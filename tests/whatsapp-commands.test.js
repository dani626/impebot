import test from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { handleMessage } from '../src/handlers/messageHandler.js';

test('solo atiende la ayuda en grupos expresamente autorizados', async () => {
  const allowed = '120363000000000001@g.us';
  const replies = [];
  const sock = { async sendMessage(jid, payload) { replies.push({ jid, payload }); } };
  const ask = (jid) => handleMessage(sock, {
    key: { remoteJid: jid },
    message: { conversation: '!ayuda' },
    messageTimestamp: Math.floor(Date.now() / 1000),
  });
  const alreadyAllowed = CONFIG.waCommandGroups.has(allowed);
  CONFIG.waCommandGroups.add(allowed);
  try {
    await ask('120363000000000002@g.us');
    await ask('123@lid');
    assert.deepEqual(replies, []);
    await ask(allowed);
    assert.deepEqual(replies.map(({ jid }) => jid), [allowed]);
  } finally {
    if (!alreadyAllowed) CONFIG.waCommandGroups.delete(allowed);
  }
});
