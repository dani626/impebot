import { CONFIG } from '../config.js';

export class CatboxService {
  constructor() {
    this.apiUrl = 'https://catbox.moe/user/api.php';
  }

  /**
   * Sube un buffer de archivo a Catbox.moe de forma anónima o con userhash.
   * @param {Buffer} buffer 
   * @param {string} [fileName='video.mp4'] 
   * @param {string} [mimetype='video/mp4'] 
   * @returns {Promise<string>} URL directa del video subido (ej. https://files.catbox.moe/xxxxxx.mp4)
   */
  async upload(buffer, fileName = 'video.mp4', mimetype = 'video/mp4') {
    const formData = new FormData();
    formData.append('reqtype', 'fileupload');
    if (CONFIG.catbox?.userhash) {
      formData.append('userhash', CONFIG.catbox.userhash);
    }

    const blob = new Blob([buffer], { type: mimetype });
    formData.append('fileToUpload', blob, fileName);

    const controller = new AbortController();
    // Timeout máximo total de 120s para subidas de archivos grandes
    const timeout = setTimeout(() => controller.abort(), 120000);

    try {
      const response = await fetch(this.apiUrl, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });

      const text = await response.text();

      if (!response.ok || !text.startsWith('http')) {
        throw new Error(`Respuesta inesperada de Catbox (${response.status}): ${text}`);
      }

      return text.trim();
    } finally {
      clearTimeout(timeout);
    }
  }
}

export const catboxService = new CatboxService();
