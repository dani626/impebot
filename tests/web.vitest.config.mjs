import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const web = process.env.IMPECRAFT_TEST_ROOT;
if (!web) throw new Error('Falta IMPECRAFT_TEST_ROOT; usa scripts/run-db-tests.js.');
const requireWeb = createRequire(path.join(web, 'package.json'));
export default {
  root,
  resolve: { alias: [
    { find: 'server-only', replacement: path.join(root, 'tests/web-empty.mjs') },
    { find: '@/lib/server/impebot', replacement: path.join(root, 'integrations/impecraft-web/files/src/lib/server/impebot.ts') },
    { find: '@', replacement: path.join(web, 'src') },
    { find: 'zod', replacement: requireWeb.resolve('zod') },
  ] },
  test: { include: ['tests/web.integration.test.ts'], environment: 'node', fileParallelism: false },
};
