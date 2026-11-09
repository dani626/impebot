import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = path.resolve(process.argv[2] || '');
const runtime = path.join(root, '.test-runtime');
await mkdir(runtime, { recursive: true });
const target = await mkdtemp(path.join(runtime, 'web-install-'));
const requireWeb = createRequire(path.join(web, 'package.json'));
function run(args, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (part) => { output += part; }); child.stderr.on('data', (part) => { output += part; });
    child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve(output) : reject(new Error(output)));
  });
}
try {
  for (const relative of ['prisma/schema.prisma', 'src/app/account/page.tsx', '.env.example']) {
    await mkdir(path.dirname(path.join(target, relative)), { recursive: true });
    await copyFile(path.join(web, relative), path.join(target, relative));
  }
  await run(['scripts/install-impecraft-web.js', '--target', target]);
  const second = await run(['scripts/install-impecraft-web.js', '--target', target, '--check']);
  if (second.includes('Preparado:')) throw new Error('El instalador no es idempotente.');
  const schema = await readFile(path.join(target, 'prisma/schema.prisma'), 'utf8');
  if (schema.split('model ImpebotLink {').length !== 2 || schema.split('model ImpebotEvent {').length !== 2) throw new Error('Modelos duplicados o ausentes.');
  const validation = await run([requireWeb.resolve('prisma/build/index.js'), 'validate', '--schema', path.join(target, 'prisma/schema.prisma')], target);
  console.log(validation.trim());
  console.log('Instalador verificado en copia temporal: respaldo, instalación idempotente y esquema Prisma válido.');
} finally {
  if (path.dirname(path.resolve(target)) !== path.resolve(runtime)) throw new Error('Destino de limpieza inesperado.');
  await rm(target, { recursive: true, force: true });
}
