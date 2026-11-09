#!/usr/bin/env node
/**
 * Añade un contexto server=<nombre> a todos los permisos de una exportación de LuckPerms
 * (`/lp export archivo` → archivo.json.gz), para importarla en la base compartida sin que esos
 * permisos se apliquen en otros servidores.
 *
 *   node scripts/luckperms-add-context.mjs entrada.json.gz salida.json.gz lobby
 *
 * - Los permisos que ya tienen un contexto "server" se dejan tal cual.
 * - Se conservan el resto de contextos (world, etc.), los valores y las caducidades.
 * - Se omite `group.default` de los jugadores: todos lo tienen ya y solo inflaría la base.
 * - Los tracks no tienen contexto y se copian sin cambios.
 * Luego, en el servidor ya conectado a MySQL: `/lp import salida` (combina, no borra nada).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';

export function addServerContext(data, server) {
  const stats = { groups: 0, users: 0, nodes: 0, alreadyScoped: 0, skippedDefault: 0 };
  const scope = (nodes = []) => nodes.map((n) => {
    const context = n.context && typeof n.context === 'object' ? { ...n.context } : {};
    if (context.server !== undefined) {
      stats.alreadyScoped++;
      return n;
    }
    stats.nodes++;
    return { ...n, context: { ...context, server } };
  });

  const out = { ...data, groups: {}, users: {} };
  for (const [name, group] of Object.entries(data.groups || {})) {
    stats.groups++;
    out.groups[name] = { ...group, nodes: scope(group.nodes) };
  }
  for (const [uuid, user] of Object.entries(data.users || {})) {
    const nodes = (user.nodes || []).filter((n) => {
      const isDefault = String(n.key).toLowerCase() === 'group.default' && n.value !== false && !n.expiry
        && !(n.context && Object.keys(n.context).length);
      if (isDefault) stats.skippedDefault++;
      return !isDefault;
    });
    if (!nodes.length) continue; // jugador sin nada propio de este servidor
    stats.users++;
    out.users[uuid] = { ...user, nodes: scope(nodes) };
  }
  return { data: out, stats };
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop());
if (isMain) {
  const [input, output, server] = process.argv.slice(2);
  if (!input || !output || !/^[a-z0-9_-]+$/i.test(server || '')) {
    console.error('Uso: node scripts/luckperms-add-context.mjs entrada.json.gz salida.json.gz <servidor>');
    process.exit(1);
  }
  const raw = readFileSync(input);
  const json = JSON.parse((input.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8'));
  const { data, stats } = addServerContext(json, server.toLowerCase());
  const text = JSON.stringify(data, null, 2);
  writeFileSync(output, output.endsWith('.gz') ? gzipSync(text) : text);
  console.log(`Grupos: ${stats.groups} · jugadores con permisos propios: ${stats.users}`);
  console.log(`Permisos con server=${server}: ${stats.nodes} · ya tenían servidor: ${stats.alreadyScoped} · group.default omitidos: ${stats.skippedDefault}`);
}
