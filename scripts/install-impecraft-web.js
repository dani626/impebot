import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'integrations/impecraft-web');
const targetArg = process.argv.indexOf('--target');
if (targetArg === -1 || !process.argv[targetArg + 1]) {
  console.error('Uso: node scripts/install-impecraft-web.js --target RUTA_AL_FRONTEND [--check]');
  process.exit(1);
}
const target = path.resolve(process.argv[targetArg + 1]);
const check = process.argv.includes('--check');
const backup = path.join(target, '.impebot-backups', new Date().toISOString().replace(/[:.]/g, '-'));
const contents = new Map();
async function collect(dir, prefix = '') {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = path.join(prefix, entry.name);
    if (entry.isDirectory()) await collect(path.join(dir, entry.name), relative);
    else contents.set(relative, await readFile(path.join(dir, entry.name), 'utf8'));
  }
}
await collect(path.join(source, 'files'));
const schemaPath = 'prisma/schema.prisma';
let schema = await readFile(path.join(target, schemaPath), 'utf8');
if (!schema.includes('model ImpebotLink {')) {
  for (const name of ['User', 'Ticket']) {
    if (!schema.includes(`model ${name} {`)) throw new Error(`No se encontró model ${name}; revisa la versión de impecraft-web.`);
  }
  schema = schema.replace('model User {', 'model User {\n  impebotLink ImpebotLink?')
    .replace('model Ticket {', 'model Ticket {\n  impebotEvents ImpebotEvent[]');
  schema += '\n' + await readFile(path.join(source, 'schema.fragment.prisma'), 'utf8');
} else if (!schema.includes('model ImpebotEvent {') || !schema.includes('impebotLink ImpebotLink?') || !schema.includes('impebotEvents ImpebotEvent[]')) {
  throw new Error('La integración Prisma existente está incompleta; revisa las relaciones antes de instalar.');
}
contents.set(schemaPath, schema);
const accountPath = 'src/app/account/page.tsx';
let account = await readFile(path.join(target, accountPath), 'utf8');
if (!account.includes('href="/account/whatsapp"')) {
  const anchor = '<Link href="/support" className="btn-secondary">';
  if (!account.includes(anchor)) throw new Error('La página Mi cuenta cambió. Añade el enlace /account/whatsapp manualmente.');
  account = account.replace(anchor, '<Link href="/account/whatsapp" className="btn-secondary">WhatsApp</Link>\n                    ' + anchor);
}
contents.set(accountPath, account);
const examplePath = '.env.example';
let example = await readFile(path.join(target, examplePath), 'utf8');
if (!/^IMPECRAFT_BOT_TOKEN=/m.test(example)) example += '\n# Puente ImpeBot: mismo secreto aleatorio de al menos 32 caracteres que en el bot\nIMPECRAFT_BOT_TOKEN=\n';
contents.set(examplePath, example);

const changes = [];
for (const [relative, content] of contents) {
  const file = path.join(target, relative);
  const previous = await readFile(file, 'utf8').catch((err) => { if (err.code === 'ENOENT') return null; throw err; });
  if (relative.endsWith('migration.sql') && previous !== null && previous !== content) {
    throw new Error(`La migración ${relative} ya existe con otro contenido. No se sobrescribirá una migración potencialmente aplicada.`);
  }
  if (previous !== content) changes.push({ relative, content, previous });
}
for (const { relative } of changes) console.log(`${check ? 'Preparado' : 'Instalar'}: ${relative}`);
if (!check && changes.length) {
  // Respaldo de todos los archivos afectados antes de la primera modificación.
  for (const { relative, previous } of changes) {
    if (previous !== null) {
      const saved = path.join(backup, relative);
      await mkdir(path.dirname(saved), { recursive: true });
      await cp(path.join(target, relative), saved);
    }
  }
  await mkdir(backup, { recursive: true });
  await writeFile(path.join(backup, 'manifest.json'), JSON.stringify(changes.map(({ relative, previous }) => ({ relative, existed: previous !== null })), null, 2));
  for (const { relative, content } of changes) {
    const file = path.join(target, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  console.log(`Respaldo: ${backup}`);
}
console.log(check ? 'Verificación de instalación terminada; no se escribieron archivos.' : 'Archivos listos. Configura el secreto y ejecuta prisma migrate deploy y prisma generate en la web.');
