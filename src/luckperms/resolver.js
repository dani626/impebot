/**
 * Cálculo de permisos a partir de las filas de LuckPerms (almacenamiento SQL), sin depender de la base.
 * Reproduce las reglas habituales de LuckPerms:
 *  - Los permisos propios del jugador van antes que los heredados; los grupos se recorren
 *    en profundidad, de mayor a menor peso (weight.N), sin repetir.
 *  - Dentro de un mismo dueño, un permiso de servidor concreto pesa más que uno global.
 *  - Gana el primer valor encontrado, de modo que un "false" explícito niega.
 *  - Coincidencia exacta antes que comodines (a.b.* → a.* → *).
 *  - Se ignoran permisos caducados, de mundos concretos o con contextos extra.
 */

/** Convierte un número de WhatsApp o un ID a solo dígitos (sin "+", sin "@s.whatsapp.net", sin ":dispositivo"). */
export function digitsOf(id) {
  const user = String(id ?? '').split('@')[0].split(':')[0];
  return /^\+?\d{5,20}$/.test(user) ? user.replace(/^\+/, '') : null;
}

/** Nodo de meta de LuckPerms (meta.<clave>.<valor>). Los delimitadores se escapan como hace LuckPerms. */
export function metaNode(key, value) {
  const esc = (s) => String(s).toLowerCase().replace(/[\\./\-$]/g, (c) => `\\${c}`);
  return `meta.${esc(key)}.${esc(value)}`;
}

/** ¿Esta fila aplica para el bot? `servers` son los contextos "server" aceptados además de global. */
export function isNodeActive(row, { servers = [], now = Math.floor(Date.now() / 1000) } = {}) {
  const expiry = Number(row.expiry) || 0;
  if (expiry > 0 && expiry <= now) return false;
  if (row.world && String(row.world).toLowerCase() !== 'global') return false;
  if (row.contexts && row.contexts !== '{}') return false;
  const server = String(row.server || 'global').toLowerCase();
  return server === 'global' || servers.includes(server);
}

const isTrue = (v) => v === true || v === 1 || v === '1' || (typeof v === 'bigint' && v === 1n);

/** Agrupa filas de luckperms_group_permissions por nombre de grupo. */
export function indexGroups(groupRows) {
  const groups = new Map();
  for (const row of groupRows) {
    const name = String(row.name).toLowerCase();
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(row);
  }
  return groups;
}

function groupWeight(rows, opts) {
  let weight = 0;
  for (const row of rows || []) {
    const m = /^weight\.(\d+)$/i.exec(row.permission);
    if (m && isTrue(row.value) && isNodeActive(row, opts)) weight = Math.max(weight, Number(m[1]));
  }
  return weight;
}

/**
 * Mapa plano permiso → true/false, en el orden de prioridad de LuckPerms.
 * @param {object[]} userRows filas de luckperms_user_permissions del jugador
 * @param {Map<string, object[]>} groups resultado de indexGroups()
 * @param {{ servers?: string[], now?: number }} opts
 * @returns {{ permissions: Map<string, boolean>, groups: string[] }}
 */
export function buildPermissionMap(userRows, groups, opts = {}) {
  const permissions = new Map();
  const visited = [];
  const seen = new Set();

  const visit = (rows, isUser) => {
    const active = rows.filter((r) => isNodeActive(r, opts));
    // Un permiso de servidor concreto pesa más que el global del mismo dueño.
    active.sort((a, b) => Number(String(b.server).toLowerCase() !== 'global') - Number(String(a.server).toLowerCase() !== 'global'));
    for (const row of active) {
      const key = String(row.permission).toLowerCase();
      if (!permissions.has(key)) permissions.set(key, isTrue(row.value));
    }
    let parents = active
      .filter((r) => isTrue(r.value) && /^group\./i.test(r.permission))
      .map((r) => r.permission.slice(6).toLowerCase());
    // Todo jugador pertenece al menos a "default".
    if (isUser && !parents.length) parents = ['default'];
    parents = [...new Set(parents)].sort((a, b) => groupWeight(groups.get(b), opts) - groupWeight(groups.get(a), opts));
    for (const name of parents) {
      if (seen.has(name) || !groups.has(name)) continue;
      seen.add(name);
      visited.push(name);
      visit(groups.get(name), false);
    }
  };

  visit(userRows, true);
  return { permissions, groups: visited };
}

/** @returns {true|false|undefined} undefined = LuckPerms no dice nada (se aplican las reglas por defecto). */
export function checkPermission(permissions, node) {
  const key = String(node).toLowerCase();
  if (permissions.has(key)) return permissions.get(key);
  const parts = key.split('.');
  for (let i = parts.length - 1; i >= 1; i--) {
    const wildcard = `${parts.slice(0, i).join('.')}.*`;
    if (permissions.has(wildcard)) return permissions.get(wildcard);
  }
  if (permissions.has('*')) return permissions.get('*');
  return undefined;
}

/** Mensaje del messaging service SQL de LuckPerms (mismo formato que envían los servidores). */
export function encodeMessengerMessage(id, type, content) {
  return JSON.stringify(content === undefined ? { id, type } : { id, type, content });
}
