// Solo usa datos temporales y loopback; no lee credenciales de los proyectos.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mariadb from 'mariadb';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
const bin = arg('--mariadb-bin'); const web = arg('--web-root');
if (!process.argv.includes('--mariadb-bin') || !process.argv.includes('--web-root')) throw new Error('Usa --mariadb-bin RUTA_BIN --web-root RUTA_FRONTEND');
const runtime = path.join(root, '.test-runtime');
await mkdir(runtime, { recursive: true });
const directory = await mkdtemp(path.join(runtime, 'mariadb-'));
const probe = createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
let server;
let logs = '';
const run = (file, args, options = {}) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { windowsHide: true, cwd: root, stdio: 'inherit', ...options });
  child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${path.basename(file)} terminó con código ${code}`)));
});
let admin;
try {
  await run(path.join(bin, 'mariadb-install-db.exe'), [`--datadir=${directory}`, `--port=${port}`, '--silent']);
  server = spawn(path.join(bin, 'mariadbd.exe'), ['--no-defaults', `--basedir=${path.dirname(bin)}`, `--datadir=${directory}`, `--port=${port}`, '--bind-address=127.0.0.1', '--console', '--innodb-buffer-pool-size=32M'], { windowsHide: true, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', (data) => { logs = (logs + data).slice(-6000); });
  server.stderr.on('data', (data) => { logs = (logs + data).slice(-6000); });
  for (let i = 0; i < 80; i++) {
    try { admin = await mariadb.createConnection({ host: '127.0.0.1', port, user: 'root', multipleStatements: true, connectTimeout: 500 }); break; }
    catch { if (server.exitCode !== null) throw new Error(logs); await new Promise((resolve) => setTimeout(resolve, 250)); }
  }
  if (!admin) throw new Error(`MariaDB temporal no inició. ${logs}`);
  await admin.query('CREATE DATABASE impebot_test DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
  await admin.query('CREATE DATABASE web_test DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
  await admin.query('USE web_test');
  const migrations = path.join(web, 'prisma/migrations');
  for (const folder of (await readdir(migrations, { withFileTypes: true })).filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    if (folder.name === '0010_impebot_tickets') continue;
    await admin.query(await readFile(path.join(migrations, folder.name, 'migration.sql'), 'utf8'));
  }
  await admin.query(await readFile(path.join(root, 'integrations/impecraft-web/files/prisma/migrations/0010_impebot_tickets/migration.sql'), 'utf8'));
  const env = { ...process.env, TICKET_TEST_PORT: String(port), IMPECRAFT_TEST_ROOT: web, DATABASE_URL: `mariadb://root@127.0.0.1:${port}/web_test` };
  console.log('MariaDB aislada lista; ejecutando pruebas de persistencia.');
  await run(process.execPath, ['--test', 'tests/database.integration.js'], { env });
  console.log('Comprobando el puente contra la base de datos y el cliente Prisma reales de la web.');
  await run(process.execPath, [path.join(web, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'tests/web.vitest.config.mjs'], { env });
} catch (err) {
  console.error(err.message); process.exitCode = 1;
} finally {
  if (admin) {
    await admin.query('SHUTDOWN').catch(() => {});
    await admin.end().catch(() => {});
  }
  if (server && server.exitCode === null) {
    await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 5000))]);
    if (server.exitCode === null) { server.kill(); await once(server, 'exit'); }
  }
  // Verifica el destino absoluto antes de borrar únicamente el datadir creado por esta ejecución.
  if (path.dirname(path.resolve(directory)) !== path.resolve(runtime)) throw new Error('Destino de limpieza inesperado.');
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
