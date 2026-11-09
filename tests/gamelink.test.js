import test from 'node:test';
import assert from 'node:assert/strict';
import { LuckPermsService } from '../src/luckperms/LuckPermsService.js';
import { GameLinkService, isGameCode } from '../src/luckperms/gameLink.js';

const STEVE = '11111111-2222-3333-4444-555555555555';
const ALEX = '99999999-2222-3333-4444-555555555555';
const NOW = 1_000_000_000_000;
const node = (uuid, permission, extra = {}) => ({ uuid, permission, value: 1, server: 'global', world: 'global', expiry: 0, contexts: '{}', ...extra });
const code = (uuid, value, expiry = NOW / 1000 + 600) => node(uuid, `meta.impebotcode.${value}`, { expiry });

function fakeDb(users) {
  const db = {
    users,
    players: [{ uuid: STEVE, username: 'steve', primary_group: 'vip' }, { uuid: ALEX, username: 'alex', primary_group: 'default' }],
    messenger: [],
  };
  const withPlayer = (u) => ({ ...u, username: db.players.find((p) => p.uuid === u.uuid)?.username, primary_group: db.players.find((p) => p.uuid === u.uuid)?.primary_group });
  const removeWhere = (fn) => { const before = db.users.length; db.users = db.users.filter((u) => !fn(u)); return { affectedRows: before - db.users.length }; };
  const run = async (sql, params = []) => {
    if (sql.includes('MAX(`id`)')) return [{ latest: 0 }];
    if (sql.startsWith('INSERT INTO `luckperms_messenger`')) { db.messenger.push(JSON.parse(params[0])); return {}; }
    if (sql.includes('LEFT JOIN')) return db.users.filter((u) => params.includes(u.permission)).map(withPlayer);
    if (sql.startsWith('SELECT DISTINCT `uuid`')) {
      const exclude = sql.includes('<> ?') ? params.at(-1) : null;
      const nodes = exclude ? params.slice(0, -1) : params;
      return [...new Set(db.users.filter((u) => nodes.includes(u.permission) && u.uuid !== exclude).map((u) => u.uuid))].map((uuid) => ({ uuid }));
    }
    if (sql.startsWith('DELETE') && sql.includes('IN (')) return removeWhere((u) => params.includes(u.permission));
    if (sql.startsWith('DELETE') && sql.includes('`uuid` = ? AND `permission` = ?')) return removeWhere((u) => u.uuid === params[0] && u.permission === params[1]);
    if (sql.startsWith('INSERT INTO `luckperms_user_permissions`')) { db.users.push(node(params[0], params[1])); return {}; }
    throw new Error(`consulta inesperada: ${sql}`);
  };
  const conn = { query: run, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {} };
  return { db, pool: { query: run, getConnection: async () => conn, end: async () => {} } };
}

async function setup(users, gameLink = {}) {
  const { db, pool } = fakeDb(users);
  let clock = NOW;
  const lp = new LuckPermsService({
    config: {
      enabled: true, db: {}, tablePrefix: 'luckperms_', servers: ['impebot'], cacheTtlMs: 60000, pollIntervalMs: 0,
      metaKeys: { whatsapp: 'whatsapp', discord: 'discord', code: 'impebotcode' },
    },
    createPool: () => pool,
    now: () => clock,
  });
  await lp.start();
  const links = new GameLinkService({
    lp, now: () => clock, config: { groups: [], maxFailures: 5, failureWindowMs: 3600000, ...gameLink },
  });
  return { db, lp, links, advance: (ms) => { clock += ms; } };
}

function fakeSock({ admin = false } = {}) {
  const sent = [];
  return {
    sent,
    user: { id: '51900000000:1@s.whatsapp.net' },
    groupMetadata: async () => ({ participants: [{ id: '51900000000@s.whatsapp.net', admin: admin ? 'admin' : null }] }),
    sendMessage: async (jid, content) => { sent.push({ jid, ...content }); },
  };
}

const PHONE = ['51987654321@s.whatsapp.net', '123456789012345@lid'];
const perms = (db, uuid) => db.users.filter((u) => u.uuid === uuid).map((u) => u.permission).sort();

test('distingue los códigos del juego de los de la web', () => {
  assert.equal(isGameCode('12345678'), true);
  assert.equal(isGameCode('00012345'), true);
  assert.equal(isGameCode('1234567'), false);
  assert.equal(isGameCode('a3f9c2e1b4d5a6f7c8e9d0a1b2c3d4e5'), false);
});

test('un código válido vincula el número y el LID, se gasta y avisa a la red', async () => {
  const { db, links } = await setup([code(STEVE, '12345678')]);
  const res = await links.redeem('12345678', PHONE);
  assert.equal(res.status, 'linked');
  assert.equal(res.player.username, 'steve');
  assert.equal(res.previous, null);
  assert.deepEqual(perms(db, STEVE), ['meta.whatsapp.123456789012345', 'meta.whatsapp.51987654321']);
  assert.equal(db.messenger.at(-1).content.userUuid, STEVE);
  assert.equal((await links.redeem('12345678', PHONE)).status, 'invalid', 'un solo uso');
});

test('mover un número de otra cuenta se indica', async () => {
  const { db, links } = await setup([node(ALEX, 'meta.whatsapp.51987654321'), code(STEVE, '12345678')]);
  const res = await links.redeem('12345678', PHONE);
  assert.equal(res.previous.username, 'alex');
  assert.deepEqual(perms(db, ALEX), []);
  assert.deepEqual(db.messenger.map((m) => m.content.userUuid).sort(), [ALEX, STEVE].sort());
});

test('códigos caducados o repetidos en dos jugadores no valen', async () => {
  const { db, links } = await setup([
    code(STEVE, '11111111', NOW / 1000 - 1),
    code(STEVE, '22222222'), code(ALEX, '22222222'),
  ]);
  assert.equal((await links.redeem('11111111', PHONE)).status, 'invalid');
  assert.equal((await links.redeem('22222222', PHONE)).status, 'invalid');
  assert.equal(db.users.some((u) => u.permission.endsWith('22222222')), false, 'el código ambiguo se anula');
});

test('cinco códigos incorrectos bloquean una hora', async () => {
  const { links, advance } = await setup([code(STEVE, '12345678')]);
  for (let i = 0; i < 5; i++) assert.equal((await links.redeem(`0000000${i}`, PHONE)).status, 'invalid');
  assert.equal((await links.redeem('12345678', PHONE)).status, 'limited', 'ni siquiera el bueno');
  assert.equal((await links.redeem('12345678', ['51911111111@s.whatsapp.net'])).status, 'linked', 'otra persona sí');
  advance(3600001);
  assert.equal((await links.redeem('00000009', PHONE)).status, 'invalid', 'pasada la hora vuelve a intentar');
});

test('en un grupo no permitido el código se anula y se avisa', async () => {
  const { db, links } = await setup([code(STEVE, '12345678')]);
  const sock = fakeSock({ admin: true });
  const msg = { key: { remoteJid: 'g1@g.us', id: 'M1', participant: '51987654321@s.whatsapp.net' } };
  const res = await links.handleCommand({ sock, msg, jid: 'g1@g.us', code: '12345678', senderIds: PHONE });
  assert.equal(res.status, 'denegado');
  assert.equal(db.users.length, 0, 'código anulado');
  assert.deepEqual(sock.sent[0].delete, msg.key, 'borra el mensaje porque es admin');
  assert.match(sock.sent[1].text, /por privado/);
  assert.equal(db.messenger.at(-1).content.userUuid, STEVE, 'ImpeGeo se entera y avisa al jugador');
});

test('en un grupo permitido vincula y borra el mensaje; sin ser admin no lo intenta', async () => {
  const { db, links } = await setup([code(STEVE, '12345678')], { groups: ['g1@g.us'] });
  const sock = fakeSock({ admin: false });
  const msg = { key: { remoteJid: 'g1@g.us', id: 'M1' } };
  const res = await links.handleCommand({ sock, msg, jid: 'g1@g.us', code: '12345678', senderIds: PHONE });
  assert.equal(res.status, 'ok');
  assert.equal(sock.sent.some((m) => m.delete), false);
  assert.match(sock.sent.at(-1).text, /steve/);
  assert.ok(perms(db, STEVE).includes('meta.whatsapp.51987654321'));
});

test('por privado responde citando y explica el código incorrecto', async () => {
  const { links } = await setup([]);
  const sock = fakeSock();
  const msg = { key: { remoteJid: '51987654321@s.whatsapp.net', id: 'M1' } };
  const res = await links.handleCommand({ sock, msg, jid: msg.key.remoteJid, code: '12345678', senderIds: PHONE });
  assert.equal(res.detail, 'código incorrecto');
  assert.match(sock.sent[0].text, /\/whatsapp link/);
});

test('un código publicado en un mensaje normal del grupo se anula', async () => {
  const { db, links } = await setup([code(STEVE, '12345678')]);
  const sock = fakeSock({ admin: true });
  const msg = { key: { remoteJid: 'g1@g.us', id: 'M2' } };
  assert.equal(await links.burnLeaked({ sock, msg, jid: 'g1@g.us', text: 'mi codigo es 12345678 jaja' }), 1);
  assert.equal(db.users.length, 0);
  assert.ok(sock.sent.some((m) => m.delete));
  // Números que no son códigos de nadie: ni se borra ni se dice nada.
  const quiet = fakeSock({ admin: true });
  assert.equal(await links.burnLeaked({ sock: quiet, msg, jid: 'g1@g.us', text: 'llámame al 98765432' }), 0);
  assert.equal(quiet.sent.length, 0);
  assert.equal(await links.burnLeaked({ sock: quiet, msg, jid: 'g1@g.us', text: 'teléfono 519876543210' }), 0, '12 cifras no es un código');
});
