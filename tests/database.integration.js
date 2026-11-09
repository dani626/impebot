import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import mariadb from 'mariadb';
import { TicketRepository } from '../src/tickets/TicketRepository.js';
import { TICKET_DDL } from '../src/tickets/schema.js';

if (!process.env.TICKET_TEST_PORT) throw new Error('Ejecuta scripts/run-db-tests.js para usar una MariaDB temporal.');
let pool;
let repository;
before(async () => {
  pool = mariadb.createPool({ host: '127.0.0.1', port: Number(process.env.TICKET_TEST_PORT), user: 'root', database: 'impebot_test', connectionLimit: 5 });
  for (const ddl of TICKET_DDL) await pool.query(ddl);
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
