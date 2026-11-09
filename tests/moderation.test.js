import test from 'node:test';
import assert from 'node:assert/strict';
import { ModerationService } from '../src/services/ModerationService.js';
import { formatCommandLog } from '../src/services/CommandLogService.js';

const GROUP = '120363000000000001@g.us';
const BOT = '5550000@s.whatsapp.net';

function setup({ staff = [], botAdmin = true, removeStatus = '200' } = {}) {
  const sent = [];
  const removed = [];
  const bans = [];
  const logs = [];
  const sock = {
    user: { id: '5550000:7@s.whatsapp.net' },
    groupMetadata: async () => ({
      participants: [
        { id: '111@lid', phoneNumber: '56911111111@s.whatsapp.net', admin: 'admin' }, // admin
        { id: '222@lid', phoneNumber: '56922222222@s.whatsapp.net', admin: null }, // miembro
        { id: '333@lid', phoneNumber: '56933333333@s.whatsapp.net', admin: null }, // miembro
        { id: BOT, admin: botAdmin ? 'admin' : null },
      ],
    }),
    sendMessage: async (jid, content) => { sent.push(content); return {}; },
    groupParticipantsUpdate: async (g, ids, action) => { removed.push({ ids, action }); return [{ status: removeStatus, jid: ids[0] }]; },
  };
  const repo = {
    addBan: async (g, ids, meta) => { bans.push({ g, ids, ...meta }); },
    getBans: async () => bans.map((b) => ({ user_jid: b.ids[0], primary_jid: b.ids[0], reason: b.reason })),
    removeBansByPrimary: async () => 1,
  };
  const service = new ModerationService({ repo, config: { staff, allowGroupAdmins: true, enforceBans: true }, logger: { log: (e) => logs.push(e) } });
  const msgFrom = (participant, contextInfo, text = '') => ({
    key: { remoteJid: GROUP, participant, id: 'CMD1' },
    message: { extendedTextMessage: { text, contextInfo } },
  });
  return { service, sock, sent, removed, bans, logs, msgFrom };
}

test('un miembro sin permisos no puede banear', async () => {
  const { service, sock, removed, msgFrom } = setup();
  const res = await service.handle({
    sock, command: 'ban', args: ['@333'],
    msg: msgFrom('222@lid', { mentionedJid: ['333@lid'] }),
  });
  assert.equal(res.status, 'denegado');
  assert.equal(removed.length, 0);
});

test('un admin banea: expulsa al objetivo y guarda todos sus identificadores', async () => {
  const { service, sock, removed, bans, msgFrom } = setup();
  const res = await service.handle({
    sock, command: 'ban', args: ['@333', 'spam'],
    msg: msgFrom('111@lid', { mentionedJid: ['333@lid'] }),
  });
  assert.equal(res.status, 'ok');
  assert.deepEqual(removed[0], { ids: ['333@lid'], action: 'remove' });
  assert.deepEqual(bans[0].ids.sort(), ['333@lid', '56933333333@s.whatsapp.net'].sort());
  assert.equal(bans[0].reason, 'spam');
});

test('el staff configurado puede banear aunque no sea admin del grupo', async () => {
  const { service, sock, removed, msgFrom } = setup({ staff: ['222'] });
  const res = await service.handle({
    sock, command: 'ban', args: [],
    msg: msgFrom('222@lid', { participant: '333@lid', mentionedJid: [] }),
  });
  assert.equal(res.status, 'ok');
  assert.equal(removed.length, 1);
});

test('no se puede banear a un admin ni sin ser admin el bot', async () => {
  let ctx = setup();
  let res = await ctx.service.handle({
    sock: ctx.sock, command: 'ban', args: [],
    msg: ctx.msgFrom('111@lid', { mentionedJid: ['111@lid'] }),
  });
  assert.equal(res.status, 'denegado');

  ctx = setup({ botAdmin: false });
  res = await ctx.service.handle({
    sock: ctx.sock, command: 'ban', args: [],
    msg: ctx.msgFrom('111@lid', { mentionedJid: ['333@lid'] }),
  });
  assert.equal(res.status, 'error');
  assert.equal(ctx.removed.length, 0);
});

test('!borrar elimina el mensaje citado y requiere cita y permisos', async () => {
  const { service, sock, sent, msgFrom } = setup();
  const noQuote = await service.handle({ sock, command: 'borrar', msg: msgFrom('111@lid', {}) });
  assert.equal(noQuote.status, 'uso');

  const res = await service.handle({
    sock, command: 'borrar',
    msg: msgFrom('111@lid', { stanzaId: 'MSG9', participant: '333@lid' }),
  });
  assert.equal(res.status, 'ok');
  const del = sent.find((c) => c.delete && c.delete.id === 'MSG9');
  assert.ok(del);
  assert.equal(del.delete.fromMe, false);
});

test('un baneado que vuelve a entrar es expulsado y queda registrado', async () => {
  const { service, sock, removed, logs, bans } = setup();
  bans.push({ ids: ['333@lid'], reason: null });
  service.whatsapp = { sock };
  await service.enforceBans({ groupJid: GROUP, participant: '333@lid', action: 'add' });
  assert.equal(removed.length, 1);
  assert.equal(logs[0].command, 'auto-expulsión');
});

test('formatCommandLog incluye origen, autor, comando y estado', () => {
  const line = formatCommandLog({ source: 'whatsapp', actorId: '111@lid', actorName: 'Ana', chatId: GROUP, command: '!ban', args: '@333', status: 'ok', detail: 'baneado 333' });
  assert.match(line, /WHATSAPP/);
  assert.match(line, /Ana/);
  assert.match(line, /!ban @333/);
  assert.match(line, /OK/);
});
