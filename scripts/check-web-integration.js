// Comprueba el módulo preparado contra los tipos reales de la web sin modificarla.
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const target = path.resolve(process.argv[2] || '').replaceAll('\\', '/');
const requireWeb = createRequire(path.join(target, 'package.json'));
const ts = requireWeb('typescript');
const stage = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../integrations/impecraft-web/files').replaceAll('\\', '/');
const options = JSON.parse(readFileSync(path.join(target, 'tsconfig.json'), 'utf8'));
const config = ts.parseJsonConfigFileContent(options, ts.sys, target);
Object.assign(config.options, {
  incremental: false, noEmit: true,
  typeRoots: [path.join(target, 'node_modules/@types')],
  paths: { '@/*': [path.join(stage, 'src/*'), path.join(target, 'src/*')] },
});
const files = [];
function collect(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(file);
    else if (/\.tsx?$/.test(file)) files.push(file.replaceAll('\\', '/'));
  }
}
collect(path.join(stage, 'src'));
const host = ts.createCompilerHost(config.options);
host.resolveModuleNames = (names, containingFile) => names.map((name) => {
  const mapped = containingFile.startsWith(stage) ? target + containingFile.slice(stage.length) : containingFile;
  return ts.resolveModuleName(name, mapped, config.options, host).resolvedModule;
});
const program = ts.createProgram(files, config.options, host);
const errors = ts.getPreEmitDiagnostics(program);
if (errors.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(errors, { getCurrentDirectory: () => target, getCanonicalFileName: (f) => f, getNewLine: () => '\n' }));
  process.exitCode = 1;
} else console.log(`Integración impecraft-web: ${files.length} archivos comprobados sin errores de TypeScript.`);
