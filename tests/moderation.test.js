import test from 'node:test';
import assert from 'node:assert/strict';
import { ModerationService } from '../src/services/ModerationService.js';
import { parseCommand, resolveCommandName, BOT_COMMANDS } from '../src/utils/commands.js';
import { withSlashAliases, SLASH_ALIASES } from '../src/utils/slashAliases.js';
import { formatCommandLog } from '../src/services/CommandLogService.js';

const GROUP = '120363000000000001@g.us';
const BOT = '5550000@s.whatsapp.net';

function setup({ staff = [], botAdmin = true, removeStatus = '200' } = {}) {
  const sent = [];
  const removed = [];
  const bans = [];
  const logs = [];
  const warnings = [];
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
    addWarning: async (g, ids, meta) => { warnings.push({ id: warnings.length + 1, primary_jid: ids[0], user_ids: ids.join(','), reason: meta.reason }); },
    getWarnings: async () => [...warnings],
    removeWarnings: async (idsToRemove) => { for (const id of idsToRemove) { const i = warnings.findIndex((w) => w.id === id); if (i >= 0) warnings.splice(i, 1); } return idsToRemove.length; },
  };
  const service = new ModerationService({ repo, config: { staff, allowGroupAdmins: true, enforceBans: true, warnLimit: 3, warnAction: 'kick' }, logger: { log: (e) => logs.push(e) } });
  const msgFrom = (participant, contextInfo, text = '') => ({
    key: { remoteJid: GROUP, participant, id: 'CMD1' },
    message: { extendedTextMessage: { text, contextInfo } },
  });
  return { service, sock, sent, removed, bans, logs, warnings, msgFrom };
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

test('!kick expulsa sin dejar baneo guardado', async () => {
  const { service, sock, removed, bans, msgFrom } = setup();
  const res = await service.handle({
    sock, command: 'kick', args: ['@333', 'molestar'],
    msg: msgFrom('111@lid', { mentionedJid: ['333@lid'] }),
  });
  assert.equal(res.status, 'ok');
  assert.equal(removed.length, 1);
  assert.equal(bans.length, 0);
});

test('!warn acumula advertencias y al llegar al límite expulsa y las reinicia', async () => {
  const { service, sock, removed, warnings, msgFrom } = setup();
  const run = () => service.handle({
    sock, command: 'warn', args: ['@333', 'spam'],
    msg: msgFrom('111@lid', { mentionedJid: ['333@lid'] }),
  });
  assert.equal((await run()).status, 'ok');
  assert.equal((await run()).status, 'ok');
  assert.equal(warnings.length, 2);
  assert.equal(removed.length, 0);
  const third = await run();
  assert.equal(third.status, 'ok');
  assert.match(third.detail, /sancionado/);
  assert.equal(removed.length, 1);
  assert.equal(warnings.length, 0);
});

test('!unwarn retira la última advertencia y !warn exige permisos', async () => {
  const { service, sock, warnings, msgFrom } = setup();
  const mention = { mentionedJid: ['333@lid'] };
  await service.handle({ sock, command: 'warn', args: ['@333'], msg: msgFrom('111@lid', mention) });
  await service.handle({ sock, command: 'warn', args: ['@333'], msg: msgFrom('111@lid', mention) });
  await service.handle({ sock, command: 'unwarn', args: ['@333'], msg: msgFrom('111@lid', mention) });
  assert.equal(warnings.length, 1);
  const denied = await service.handle({ sock, command: 'warn', args: ['@333'], msg: msgFrom('222@lid', mention) });
  assert.equal(denied.status, 'denegado');
});

test('cada comando existe en español e inglés y los alias llevan al mismo comando', () => {
  const pairs = [
    ['ayuda', 'help'], ['borrar', 'delete'], ['desban', 'unban'], ['expulsar', 'kick'],
    ['advertir', 'warn'], ['advertencias', 'warns'], ['presencia', 'presence'],
    ['responder', 'reply'], ['cerrar', 'close'], ['vincular', 'link'], ['cancelar', 'cancel'],
    ['srecorte', 'scrop'], ['enlinea', 'online'], ['desconectado', 'offline'],
  ];
  for (const [es, en] of pairs) {
    assert.equal(resolveCommandName(es), resolveCommandName(en), `${es} vs ${en}`);
    assert.ok(BOT_COMMANDS.has(es) && BOT_COMMANDS.has(en));
  }
  const parsed = parseCommand('!delete algo');
  assert.equal(parsed.command, 'borrar');
  assert.equal(parsed.invoked, 'delete');
  assert.equal(parseCommand('!nada').isCommand, false);
});

test('los slash commands se registran también con su alias', () => {
  const names = withSlashAliases([{ name: 'cola' }, { name: 'play' }, { name: 'espejo' }]).map((c) => c.name);
  for (const n of ['cola', 'queue', 'play', 'reproducir', 'espejo', 'mirror']) assert.ok(names.includes(n), n);
  assert.equal(SLASH_ALIASES.queue, 'cola');
});
