import test from 'node:test';
import assert from 'node:assert/strict';
import { addServerContext } from '../scripts/luckperms-add-context.mjs';

test('añade server=lobby sin tocar contextos existentes ni caducidades', () => {
  const { data, stats } = addServerContext({
    metadata: { generatedBy: 'x' },
    groups: {
      vip: { nodes: [
        { type: 'permission', key: 'essentials.fly', value: true },
        { type: 'inheritance', key: 'group.default', value: true },
        { type: 'permission', key: 'worldedit.*', value: true, context: { world: 'world' } },
        { type: 'permission', key: 'x.y', value: false, context: { server: 'survivalop' } },
        { type: 'weight', key: 'weight.20', value: true },
      ] },
    },
    users: {
      a: { username: 'steve', primaryGroup: 'vip', nodes: [
        { type: 'inheritance', key: 'group.default', value: true },
        { type: 'inheritance', key: 'group.vip', value: true, expiry: 1999999999 },
      ] },
      b: { username: 'alex', primaryGroup: 'default', nodes: [{ type: 'inheritance', key: 'group.default', value: true }] },
    },
    tracks: { staff: { groups: ['helper', 'mod'] } },
  }, 'lobby');

  const vip = data.groups.vip.nodes;
  assert.deepEqual(vip[0].context, { server: 'lobby' });
  assert.deepEqual(vip[1].context, { server: 'lobby' }, 'la herencia del grupo también queda en lobby');
  assert.deepEqual(vip[2].context, { world: 'world', server: 'lobby' });
  assert.deepEqual(vip[3].context, { server: 'survivalop' });
  assert.deepEqual(data.users.a.nodes, [{ type: 'inheritance', key: 'group.vip', value: true, expiry: 1999999999, context: { server: 'lobby' } }]);
  assert.equal(data.users.b, undefined, 'jugador solo con default no se importa');
  assert.deepEqual(data.tracks, { staff: { groups: ['helper', 'mod'] } });
  assert.deepEqual(stats, { groups: 1, users: 1, nodes: 5, alreadyScoped: 1, skippedDefault: 2 });
});
