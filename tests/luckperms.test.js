import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPermissionMap, checkPermission, digitsOf, encodeMessengerMessage, indexGroups, isNodeActive, metaNode,
} from '../src/luckperms/resolver.js';
import { LuckPermsService } from '../src/luckperms/LuckPermsService.js';
import { decide, whatsappSenderIds, PERMISSIONS } from '../src/luckperms/permissions.js';
import { ModerationService } from '../src/services/ModerationService.js';

const node = (permission, extra = {}) => ({ permission, value: 1, server: 'global', world: 'global', expiry: 0, contexts: '{}', ...extra });
const gnode = (name, permission, extra) => ({ name, ...node(permission, extra) });
const OPTS = { servers: ['impebot'], now: 1_000_000 };

// Grupos parecidos a los de la red: default ← helper ← mod ← admin
const GROUPS = indexGroups([
  gnode('default', 'impebot.sticker'),
  gnode('helper', 'group.default'), gnode('helper', 'weight.10'), gnode('helper', 'impebot.moderation.warn'),
  gnode('mod', 'group.helper'), gnode('mod', 'weight.50'), gnode('mod', 'impebot.moderation.*'),
  gnode('mod', 'impebot.moderation.ban', { value: 0 }),
  gnode('admin', 'group.mod'), gnode('admin', 'weight.100'), gnode('admin', 'impebot.moderation.ban'),
  gnode('survi', 'impebot.presence', { server: 'survivalop' }),
  gnode('owner', '*'),
]);

const perms = (userRows) => buildPermissionMap(userRows, GROUPS, OPTS);

test('herencia de grupos, comodines y negación como en LuckPerms', () => {
  const mod = perms([node('group.mod')]);
  assert.deepEqual(mod.groups, ['mod', 'helper', 'default']);
  assert.equal(checkPermission(mod.permissions, 'impebot.moderation.kick'), true, 'comodín impebot.moderation.*');
  assert.equal(checkPermission(mod.permissions, 'impebot.moderation.ban'), false, 'false exacto gana al comodín');
  assert.equal(checkPermission(mod.permissions, 'impebot.sticker'), true, 'heredado de default');
  assert.equal(checkPermission(mod.permissions, 'impebot.presence'), undefined);

  const admin = perms([node('group.admin')]);
  assert.equal(checkPermission(admin.permissions, 'impebot.moderation.ban'), true, 'el grupo más cercano manda');

  const owner = perms([node('group.owner')]);
  assert.equal(checkPermission(owner.permissions, 'cualquier.cosa'), true, '* lo permite todo');
});

test('los permisos propios ganan a los heredados y el grupo de mayor peso va primero', () => {
  const own = perms([node('group.admin'), node('impebot.moderation.ban', { value: 0 })]);
  assert.equal(checkPermission(own.permissions, 'impebot.moderation.ban'), false);

  // helper (peso 10) da warn=true; un grupo de más peso que lo niega debe ganar.
  const groups = indexGroups([
    gnode('helper', 'weight.10'), gnode('helper', 'impebot.moderation.warn'),
    gnode('castigado', 'weight.90'), gnode('castigado', 'impebot.moderation.warn', { value: 0 }),
  ]);
  const both = buildPermissionMap([node('group.helper'), node('group.castigado')], groups, OPTS);
  assert.equal(checkPermission(both.permissions, 'impebot.moderation.warn'), false);
});

test('se ignoran permisos caducados, de otros servidores, mundos o contextos extra', () => {
  const now = OPTS.now;
  assert.equal(isNodeActive(node('x', { expiry: now - 1 }), OPTS), false);
  assert.equal(isNodeActive(node('x', { expiry: now + 60 }), OPTS), true);
  assert.equal(isNodeActive(node('x', { server: 'survivalop' }), OPTS), false);
  assert.equal(isNodeActive(node('x', { server: 'impebot' }), OPTS), true);
  assert.equal(isNodeActive(node('x', { world: 'world_nether' }), OPTS), false);
  assert.equal(isNodeActive(node('x', { contexts: '{"gamemode":["creative"]}' }), OPTS), false);

  const survi = perms([node('group.survi')]);
  assert.equal(checkPermission(survi.permissions, 'impebot.presence'), undefined, 'solo vale en survivalop');
  const withSurvi = buildPermissionMap([node('group.survi')], GROUPS, { ...OPTS, servers: ['impebot', 'survivalop'] });
  assert.equal(checkPermission(withSurvi.permissions, 'impebot.presence'), true);
});

test('un jugador sin grupos hereda default', () => {
  const nobody = perms([]);
  assert.deepEqual(nobody.groups, ['default']);
  assert.equal(checkPermission(nobody.permissions, 'impebot.sticker'), true);
});

test('formato de meta y de avisos del messaging service', () => {
  assert.equal(metaNode('whatsapp', '51987654321'), 'meta.whatsapp.51987654321');
  assert.equal(metaNode('a.b', 'c-d'), 'meta.a\\.b.c\\-d');
  assert.equal(digitsOf('51987654321:4@s.whatsapp.net'), '51987654321');
  assert.equal(digitsOf('+51 hola'), null);
  assert.equal(digitsOf('123456789012345@lid'), '123456789012345');
  assert.deepEqual(JSON.parse(encodeMessengerMessage('abc', 'userupdate', { userUuid: 'u1' })),
    { id: 'abc', type: 'userupdate', content: { userUuid: 'u1' } });
  assert.deepEqual(JSON.parse(encodeMessengerMessage('abc', 'update')), { id: 'abc', type: 'update' });
});

test('decide(): staff de emergencia, LuckPerms y reglas de respaldo', () => {
  assert.equal(decide(PERMISSIONS.presence, undefined), false);
  assert.equal(decide(PERMISSIONS.presence, true), true);
  assert.equal(decide(PERMISSIONS.presence, false, { staff: true }), true);
  assert.equal(decide(PERMISSIONS.sticker, undefined), true);
  assert.equal(decide(PERMISSIONS.sticker, false), false);
  assert.equal(decide(PERMISSIONS.moderationBan, undefined, { fallback: true }), true);
  assert.equal(decide(PERMISSIONS.moderationBan, false, { fallback: true }), false);
});

test('identificadores del remitente en grupo y en privado', () => {
  assert.deepEqual(whatsappSenderIds({ key: { remoteJid: 'g@g.us', participant: '111:3@lid', participantAlt: '519@s.whatsapp.net' } }), ['111@lid', '519@s.whatsapp.net']);
  assert.deepEqual(whatsappSenderIds({ key: { remoteJid: '519@s.whatsapp.net' } }), ['519@s.whatsapp.net']);
});

// ---------------------------------------------------------------- servicio con base falsa

const UUID = '11111111-2222-3333-4444-555555555555';
const OTHER = '99999999-2222-3333-4444-555555555555';

function fakeDb() {
  const db = {
    users: [
      { uuid: UUID, ...node('group.mod') },
      { uuid: UUID, ...node('meta.whatsapp.51987654321') },
    ],
    groups: [gnode('mod', 'impebot.moderation.*'), gnode('default', 'impebot.sticker')],
    players: [{ uuid: UUID, username: 'steve', primary_group: 'mod' }, { uuid: OTHER, username: 'alex', primary_group: 'default' }],
    messenger: [],
    queries: 0,
  };
  const run = async (sql, params = []) => {
    db.queries++;
    if (sql.includes('MAX(`id`)')) return [{ latest: db.messenger.at(-1)?.id || 0 }];
    if (sql.startsWith('SELECT `id`, `msg`')) return db.messenger.filter((m) => m.id > params[0]);
    if (sql.startsWith('INSERT INTO `luckperms_messenger`')) { db.messenger.push({ id: db.messenger.length + 1, msg: params[0] }); return {}; }
    if (sql.includes('LEFT JOIN')) {
      return db.users.filter((u) => params.includes(u.permission))
        .map((u) => ({ ...u, username: db.players.find((p) => p.uuid === u.uuid)?.username, primary_group: 'mod' }));
    }
    if (sql.includes('FROM `luckperms_group_permissions`')) return db.groups;
    if (sql.includes('FROM `luckperms_players`')) return db.players.filter((p) => p.username === params[0] || p.uuid === params[0]);
    if (sql.startsWith('SELECT DISTINCT `uuid`')) return db.users.filter((u) => params.slice(0, -1).includes(u.permission) && u.uuid !== params.at(-1));
    if (sql.startsWith('DELETE') && sql.includes('IN (')) { const before = db.users.length; db.users = db.users.filter((u) => !params.includes(u.permission)); return { affectedRows: before - db.users.length }; }
    if (sql.startsWith('DELETE') && sql.includes('LIKE')) {
      const prefix = params[1].replace(/\\(.)/g, '$1');
      const before = db.users.length;
      db.users = db.users.filter((u) => !(u.uuid === params[0] && u.permission.startsWith(prefix)));
      return { affectedRows: before - db.users.length };
    }
    if (sql.startsWith('INSERT INTO `luckperms_user_permissions`')) { db.users.push({ uuid: params[0], ...node(params[1]) }); return {}; }
    if (sql.includes('FROM `luckperms_user_permissions` WHERE `uuid` = ?')) return db.users.filter((u) => u.uuid === params[0]);
    throw new Error(`consulta inesperada: ${sql}`);
  };
  const conn = { query: run, beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {} };
  const pool = { query: run, getConnection: async () => conn, end: async () => {} };
  return { db, pool };
}

function service(db, pool, extra = {}) {
  let clock = 1_000_000_000;
  const lp = new LuckPermsService({
    config: {
      enabled: true, db: {}, tablePrefix: 'luckperms_', servers: ['impebot'], cacheTtlMs: 60000, pollIntervalMs: 0,
      metaKeys: { whatsapp: 'whatsapp', discord: 'discord' }, ...extra,
    },
    createPool: () => pool,
    now: () => clock,
  });
  return { lp, advance: (ms) => { clock += ms; } };
}

test('reconoce al jugador por su número (o LID) y calcula su permiso', async () => {
  const { db, pool } = fakeDb();
  const { lp } = service(db, pool);
  await lp.start();
  const res = await lp.check('whatsapp', ['51987654321@s.whatsapp.net', '777@lid'], 'impebot.moderation.ban');
  assert.equal(res.result, true);
  assert.equal(res.player.username, 'steve');
  const stranger = await lp.check('whatsapp', ['5100000000@s.whatsapp.net'], 'impebot.moderation.ban');
  assert.deepEqual(stranger, { result: undefined, player: null });
});

test('usa caché y la borra al recibir un aviso de la red', async () => {
  const { db, pool } = fakeDb();
  const { lp } = service(db, pool);
  await lp.start();
  await lp.check('whatsapp', ['51987654321'], 'impebot.moderation.ban');
  const before = db.queries;
  await lp.check('whatsapp', ['51987654321'], 'impebot.moderation.ban');
  assert.equal(db.queries, before, 'segunda consulta sale de la caché');

  // Otro servidor quita el rango y avisa.
  db.users = db.users.filter((u) => u.permission !== 'group.mod');
  db.messenger.push({ id: 1, msg: encodeMessengerMessage('x1', 'userupdate', { userUuid: UUID }) });
  await lp.pollMessenger();
  const res = await lp.check('whatsapp', ['51987654321'], 'impebot.moderation.ban');
  assert.equal(res.result, undefined, 'ya no tiene el permiso');
});

test('la caché caduca aunque se pierda un aviso', async () => {
  const { db, pool } = fakeDb();
  const { lp, advance } = service(db, pool);
  await lp.start();
  await lp.check('whatsapp', ['51987654321'], 'impebot.moderation.ban');
  db.users = db.users.filter((u) => u.permission !== 'group.mod');
  advance(61000);
  assert.equal((await lp.check('whatsapp', ['51987654321'], 'impebot.moderation.ban')).result, undefined);
});

test('vincular guarda la meta, se la quita a otro jugador y avisa a la red', async () => {
  const { db, pool } = fakeDb();
  const { lp } = service(db, pool);
  await lp.start();
  await lp.link(OTHER, 'whatsapp', ['51987654321@s.whatsapp.net']);
  assert.ok(db.users.some((u) => u.uuid === OTHER && u.permission === 'meta.whatsapp.51987654321' && u.server === 'global'));
  assert.ok(!db.users.some((u) => u.uuid === UUID && u.permission.startsWith('meta.whatsapp')));
  const notified = db.messenger.map((m) => JSON.parse(m.msg)).filter((m) => m.type === 'userupdate').map((m) => m.content.userUuid).sort();
  assert.deepEqual(notified, [UUID, OTHER].sort());

  // Sus propios avisos no le borran la caché dos veces, y se reconoce al nuevo dueño.
  await lp.pollMessenger();
  assert.equal((await lp.findPlayer('whatsapp', ['51987654321'])).username, 'alex');

  assert.equal(await lp.unlink(OTHER, 'whatsapp'), 1);
  assert.equal(await lp.findPlayer('whatsapp', ['51987654321']), null);
});

test('si LuckPerms está desactivado o caído, check() no lanza', async () => {
  const off = new LuckPermsService({ config: { enabled: false, tablePrefix: 'luckperms_' } });
  assert.deepEqual(await off.check('whatsapp', ['519'], 'x'), { result: undefined, player: null });

  const broken = { query: async () => { throw new Error('ECONNREFUSED'); }, end: async () => {} };
  const { lp } = service(null, broken);
  const original = console.error;
  console.error = () => {};
  try {
    await lp.start();
    assert.deepEqual(await lp.check('whatsapp', ['51987654321'], 'x'), { result: undefined, player: null });
  } finally {
    console.error = original;
  }
});

test('el prefijo de tablas no admite inyección SQL', () => {
  assert.throws(() => new LuckPermsService({ config: { tablePrefix: 'lp`; DROP TABLE x; --' } }));
});

// ---------------------------------------------------------------- moderación con LuckPerms

const GROUP = '120363000000000001@g.us';
function moderation(permissions) {
  const sent = [];
  const sock = {
    user: { id: '5550000:7@s.whatsapp.net' },
    groupMetadata: async () => ({
      participants: [
        { id: '111@lid', phoneNumber: '56911111111@s.whatsapp.net', admin: 'admin' },
        { id: '222@lid', phoneNumber: '56922222222@s.whatsapp.net', admin: null },
        { id: '333@lid', phoneNumber: '56933333333@s.whatsapp.net', admin: null },
        { id: '5550000@s.whatsapp.net', admin: 'admin' },
      ],
    }),
    sendMessage: async (jid, content) => { sent.push(content); return {}; },
    groupParticipantsUpdate: async (g, ids) => [{ status: '200', jid: ids[0] }],
  };
  const repo = { addBan: async () => {}, getBans: async () => [] };
  const service = new ModerationService({
    repo, permissions, logger: { log() {} },
    config: { staff: [], allowGroupAdmins: true, enforceBans: true, warnLimit: 3, warnAction: 'kick' },
  });
  const ban = (from, target) => service.handle({
    sock, command: 'ban', args: [`@${target}`],
    msg: { key: { remoteJid: GROUP, participant: `${from}@lid`, id: 'C' }, message: { extendedTextMessage: { text: '', contextInfo: { mentionedJid: [`${target}@lid`] } } } },
  });
  return { ban, sent };
}

test('un miembro con impebot.moderation.ban en LuckPerms puede banear', async () => {
  const asked = [];
  const { ban } = moderation(async (ids, n) => {
    asked.push([ids, n]);
    return n === 'impebot.moderation.ban' && ids.includes('56922222222@s.whatsapp.net') ? true : undefined;
  });
  assert.equal((await ban('222', '333')).status, 'ok');
  assert.ok(asked[0][0].includes('56922222222@s.whatsapp.net'), 'se consulta también el número, no solo el LID');
});

test('un admin del grupo con el permiso negado en LuckPerms no puede banear', async () => {
  const { ban } = moderation(async (ids, n) => (n === 'impebot.moderation.ban' ? false : undefined));
  assert.equal((await ban('111', '333')).status, 'denegado');
});

test('impebot.moderation.exempt protege al objetivo', async () => {
  const { ban, sent } = moderation(async (ids, n) => {
    if (n === 'impebot.moderation.exempt') return ids.includes('333@lid');
    return undefined;
  });
  assert.equal((await ban('111', '333')).status, 'denegado');
  assert.match(sent.at(-1).text, /administrador ni al staff/);
});
