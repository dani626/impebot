import test from 'node:test';
import assert from 'node:assert/strict';
import { allChannelsId, commandAccess } from '../src/services/DiagnosticCommands.js';

const GUILD = '1000';
const ROLE = 1, USER = 2, CHANNEL = 3;
const who = { guildId: GUILD, userId: 'U1', roleIds: [GUILD, 'R1', 'R2'], channelId: 'C1' };

test('sin restricciones en Integraciones se puede usar', () => {
  assert.deepEqual(commandAccess({ ...who }), { allowed: true, reasons: [] });
  assert.equal(allChannelsId('1000'), '999');
});

test('@everyone desactivado bloquea, salvo que un rol suyo lo permita', () => {
  const everyoneOff = [{ type: ROLE, id: GUILD, permission: false }];
  const res = commandAccess({ appList: everyoneOff, ...who });
  assert.equal(res.allowed, false);
  assert.match(res.reasons[0], /@everyone \(en todo el bot\)/);
  assert.equal(commandAccess({ appList: [...everyoneOff, { type: ROLE, id: 'R2', permission: true }], ...who }).allowed, true);
});

test('un rol bloqueado no gana si otro rol suyo lo permite; el usuario manda sobre los roles', () => {
  const roles = [{ type: ROLE, id: 'R1', permission: false }, { type: ROLE, id: 'R2', permission: true }];
  assert.equal(commandAccess({ appList: roles, ...who }).allowed, true);
  const onlyBlocked = commandAccess({ appList: [roles[0]], ...who });
  assert.equal(onlyBlocked.allowed, false);
  assert.match(onlyBlocked.reasons[0], /<@&R1>/);
  assert.equal(commandAccess({ appList: [roles[0], { type: USER, id: 'U1', permission: true }], ...who }).allowed, true);
});

test('canales: el concreto manda sobre "todos los canales"', () => {
  const allOff = [{ type: CHANNEL, id: '999', permission: false }];
  const res = commandAccess({ appList: allOff, ...who });
  assert.equal(res.allowed, false);
  assert.match(res.reasons[0], /todos los canales/);
  assert.equal(commandAccess({ appList: [...allOff, { type: CHANNEL, id: 'C1', permission: true }], ...who }).allowed, true);
  const thisOff = commandAccess({ appList: [{ type: CHANNEL, id: 'C1', permission: false }], ...who });
  assert.match(thisOff.reasons[0], /<#C1>/);
});

test('lo puesto en un comando manda sobre lo general del bot', () => {
  const appList = [{ type: ROLE, id: GUILD, permission: false }];
  const commandList = [{ type: ROLE, id: GUILD, permission: true }];
  assert.equal(commandAccess({ appList, commandList, ...who }).allowed, true);
  const blocked = commandAccess({ commandList: [{ type: CHANNEL, id: 'C1', permission: false }], ...who });
  assert.equal(blocked.allowed, false);
  assert.match(blocked.reasons[0], /en este comando/);
});
