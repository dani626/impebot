import { createRequire } from 'module';
import { execFile, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);

/** Ejecuta un binario y devuelve su salida, o null si no se puede ejecutar. */
async function probe(binary, args) {
  try {
    const { stdout, stderr } = await execFileAsync(binary, args, { timeout: 20000 });
    return (stdout || stderr || '').trim().split('\n')[0] || 'ok';
  } catch {
    return null;
  }
}

/** Binario autónomo de yt-dlp para esta plataforma (no necesita Python). */
function ytDlpAsset(platform = process.platform, arch = process.arch) {
  if (platform === 'win32') return 'yt-dlp.exe';
  if (platform === 'darwin') return 'yt-dlp_macos';
  if (platform === 'linux') return arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
  return null;
}

/**
 * Garantiza que yt-dlp existe y se puede ejecutar. npm puede omitir los scripts de instalación
 * (política allow-scripts) o instalar la versión que exige Python, que no siempre está disponible;
 * en ese caso se descarga el binario autónomo oficial.
 * @returns {Promise<string>} versión de yt-dlp
 */
export async function ensureYtDlp(log = console) {
  const { constants } = require('youtube-dl-exec');
  const target = constants.YOUTUBE_DL_PATH;

  if (fs.existsSync(target)) {
    const version = await probe(target, ['--version']);
    if (version) return version;
  }

  const asset = ytDlpAsset();
  if (!asset) throw new Error(`Plataforma no soportada para yt-dlp (${process.platform}/${process.arch})`);

  log.log(`⬇️ [Music] Descargando yt-dlp (${asset})...`);
  const response = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${asset}`);
  if (!response.ok) throw new Error(`No se pudo descargar yt-dlp (HTTP ${response.status})`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const tmp = `${target}.download`;
  fs.writeFileSync(tmp, Buffer.from(await response.arrayBuffer()), { mode: 0o755 });
  fs.renameSync(tmp, target);

  const version = await probe(target, ['--version']);
  if (!version) throw new Error('yt-dlp se descargó pero no se puede ejecutar en este sistema');
  return version;
}

/**
 * Garantiza que hay un ffmpeg utilizable: el de ffmpeg-static, el del sistema, o lo descarga
 * ejecutando el instalador de ffmpeg-static (que npm pudo haber omitido).
 * @returns {Promise<string>} ruta o nombre del ejecutable
 */
export async function ensureFfmpeg(log = console) {
  const bundled = require('ffmpeg-static');
  if (bundled && fs.existsSync(bundled) && await probe(bundled, ['-version'])) return bundled;
  if (await probe('ffmpeg', ['-version'])) return 'ffmpeg';
  if (!bundled) throw new Error(`ffmpeg-static no soporta esta plataforma (${process.platform}/${process.arch})`);

  log.log('⬇️ [Music] Descargando ffmpeg...');
  const installer = path.join(path.dirname(require.resolve('ffmpeg-static/package.json')), 'install.js');
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [installer], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`El instalador de ffmpeg terminó con código ${code}`))));
  });
  if (!fs.existsSync(bundled) || !(await probe(bundled, ['-version']))) {
    throw new Error('ffmpeg se descargó pero no se puede ejecutar en este sistema');
  }
  return bundled;
}
