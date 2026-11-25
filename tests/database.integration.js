import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import mariadb from 'mariadb';
import { TicketRepository } from '../src/tickets/TicketRepository.js';
import { TICKET_DDL, migrateTicketSchema } from '../src/tickets/schema.js';
import { TicketConfigRepository } from '../src/tickets/TicketConfigRepository.js';

if (!process.env.TICKET_TEST_PORT) throw new Error('Ejecuta scripts/run-db-tests.js para usar una MariaDB temporal.');
let pool;
let repository;
before(async () => {
  pool = mariadb.createPool({ host: '127.0.0.1', port: Number(process.env.TICKET_TEST_PORT), user: 'root', database: 'impebot_test', connectionLimit: 5 });
  for (const ddl of TICKET_DDL) await pool.query(ddl);
  await migrateTicketSchema(pool, { database: 'impebot_test' });
  await migrateTicketSchema(pool, { database: 'impebot_test' });
  repository = new TicketRepository({
    query: (sql, params) => pool.query(sql, params),
    async transaction(work) {
      const conn = await pool.getConnection();
      try { await conn.beginTransaction(); const result = await work(conn); await conn.commit(); return result; }
      catch (err) { await conn.rollback(); throw err; }
      finally { conn.release(); }
    },
  });
});
after(async () => { await pool?.end(); });

const jid = '59170000001@s.whatsapp.net';
const owner = { id: jid, username: 'Jugador', role: 'USER' };
const helper = { id: 'helper', username: 'Ana', role: 'HELPER' };
let number;
test('crea un ticket y su mensaje inicial en la misma transacción', async () => {
  const created = await repository.create({ subject: 'No llegó mi compra', category: 'compra', message: 'Compré un rango', jid, username: 'Jugador', eventId: 'wa:create' });
  number = created.number;
  assert.equal(created.priority, 'HIGH'); assert.equal(created.status, 'OPEN'); assert.equal(created.messages.length, 1);
  const duplicate = await repository.create({ subject: 'No llegó mi compra', category: 'compra', message: 'Compré un rango', jid, username: 'Jugador', eventId: 'wa:create' });
  assert.equal(duplicate.id, created.id);
});
test('una apertura concurrente conserva como máximo un ticket activo', async () => {
  const data = { subject: 'Asunto válido', category: 'soporte', message: 'Ayuda', jid: '123@lid', username: 'Otro' };
  const results = await Promise.allSettled([repository.create({ ...data, eventId: 'race:1' }), repository.create({ ...data, eventId: 'race:2' })]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal((await repository.list({ jid: data.jid })).length, 1);
});
test('notas y respuestas actualizan estado, responsable y orden; los duplicados no se insertan', async () => {
  await repository.message(number, { body: 'Nota interna', internal: true, actor: helper, eventId: 'dc:note' });
  let current = await repository.get(number);
  assert.equal(current.status, 'OPEN'); assert.equal(current.assignee, null);
  await repository.message(number, { body: 'Respuesta pública', actor: helper, eventId: 'dc:reply' });
  await repository.message(number, { body: 'Respuesta pública', actor: helper, eventId: 'dc:reply' });
  current = await repository.get(number);
  assert.equal(current.status, 'PENDING'); assert.equal(current.assignee.id, helper.id); assert.equal(current.messages.length, 3);
  assert.deepEqual(current.messages.map((m) => m.body), ['Compré un rango', 'Nota interna', 'Respuesta pública']);
  await repository.message(number, { body: 'Gracias', actor: owner, eventId: 'wa:followup' });
  assert.equal((await repository.get(number)).status, 'OPEN');
});
test('no permite notas internas del dueño ni acceso de otro jugador', async () => {
  await assert.rejects(() => repository.message(number, { body: 'No', actor: owner, internal: true, eventId: 'bad:note' }), (err) => err.status === 403);
  await assert.rejects(() => repository.message(number, { body: 'No', actor: { ...owner, id: 'other' }, eventId: 'bad:owner' }), (err) => err.status === 403);
  await assert.rejects(() => repository.update(number, { priority: 'URGENT' }, owner), (err) => err.status === 403);
});
test('cierra y conserva el historial; permite un nuevo ticket y bloquea reabrir dos activos', async () => {
  await repository.update(number, { status: 'CLOSED' }, owner);
  await assert.rejects(() => repository.message(number, { body: 'Muy tarde', actor: owner, eventId: 'late' }), (err) => err.status === 409);
  const next = await repository.create({ subject: 'Un nuevo problema', category: 'bug', message: 'Otro caso', jid, username: 'Jugador', eventId: 'new:case' });
  assert.notEqual(next.number, number);
  await assert.rejects(() => repository.update(number, { status: 'OPEN' }, helper));
  assert.equal((await repository.get(number)).messages.length, 4);
});
test('los punteros y las entregas sobreviven a otra instancia de repositorio', async () => {
  const t = await repository.get(number);
  await repository.saveRoute('local:test', t, 'channel123');
  await repository.markDelivered('local:test', 'message123', 'whatsapp');
  const next = new TicketRepository(repository.db);
  assert.equal((await next.routeByChannel('channel123')).ticket_number, number);
  assert.equal(await next.delivered('local:test', 'message123', 'whatsapp'), true);
  assert.equal(await next.delivered('local:test', 'other', 'whatsapp'), false);
});

test('tickets de Discord: dueño por ID de Discord, límite max_open y propiedad', async () => {
  const discordUserId = '111111111111111111';
  const base = { subject: 'Desde Discord', category: 'bug', message: 'Hola', discordUserId, username: 'Gamer', guildId: 'g1', customCategorySlug: 'bugs', maxOpen: 2 };
  const results = await Promise.allSettled([1, 2, 3].map((i) => repository.create({ ...base, eventId: `dcopen:${i}` })));
  // Bajo concurrencia puede perder más de una (bloqueo mutuo); nunca se supera el límite.
  assert.ok(results.filter((r) => r.status === 'fulfilled').length <= 2);
  for (let i = 4; i < 7; i++) await repository.create({ ...base, eventId: `dcopen:${i}` }).catch(() => {});
  const [{ n }] = await pool.query("SELECT COUNT(*) AS n FROM support_tickets WHERE owner_discord_id = ? AND status <> 'CLOSED'", [discordUserId]);
  assert.equal(Number(n), 2);
  // El cupo es por servidor: en otro servidor aún puede abrir.
  assert.equal((await repository.create({ ...base, guildId: 'g2', eventId: 'dcopen:g2' })).guildId, 'g2');
  const t = results.find((r) => r.status === 'fulfilled').value;
  assert.equal(t.origin, 'discord'); assert.equal(t.ownerDiscordId, discordUserId); assert.equal(t.whatsappJid, null); assert.equal(t.customCategorySlug, 'bugs');
  const player = { id: discordUserId, username: 'Gamer', role: 'USER', platform: 'discord' };
  await repository.message(t.number, { body: 'Más datos', actor: player, eventId: 'dcmsg:1' });
  await assert.rejects(() => repository.message(t.number, { body: 'No', actor: { ...player, id: '222222222222222222' }, eventId: 'dcmsg:2' }), (err) => err.status === 403);
  await repository.update(t.number, { status: 'CLOSED' }, player);
  await repository.update(t.number, { status: 'OPEN' }, helper);
});
test('configuración por servidor, categorías, paneles y participantes', async () => {
  const config = new TicketConfigRepository(repository.db);
  assert.equal((await config.guild('g1')).maxOpenPerUser, 3);
  const cfg = await config.updateGuild('g1', { maxOpenPerUser: 5, staffRoleIds: ['r1'], logChannelId: 'logs' });
  assert.deepEqual([cfg.maxOpenPerUser, cfg.staffRoleIds, cfg.logChannelId, cfg.requireLinkedWeb], [5, ['r1'], 'logs', true]);
  const cat = await config.createCategory('g1', { slug: 'compras', label: 'Compras', baseCategory: 'compra', staffRoleIds: ['r2'] });
  await assert.rejects(() => config.createCategory('g1', { slug: 'compras', label: 'Otra' }), (err) => err.code === 'ER_DUP_ENTRY');
  assert.deepEqual((await config.updateCategory(cat.id, { enabled: false })).enabled, false);
  assert.equal((await config.categories('g1', { enabledOnly: true })).length, 0);
  await config.savePanel('g1', { channelId: 'c', messageId: 'm1', title: 'T', description: 'D', mode: 'select', categoryIds: [cat.id] });
  assert.deepEqual((await config.panel('m1')).categoryIds, [cat.id]);
  await config.addParticipant('local:x', 'u1', 'user', 'staff');
  assert.deepEqual(await config.participants('local:x'), [{ id: 'u1', type: 'user' }]);
  await config.removeParticipant('local:x', 'u1');
  assert.equal((await config.participants('local:x')).length, 0);
});
