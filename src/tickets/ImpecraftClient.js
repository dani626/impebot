import { ticketError } from './model.js';

export class ImpecraftClient {
  constructor({ url, token, timeoutMs = 10000 }, fetchImpl = fetch) {
    const base = new URL(url);
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) {
      throw new Error('IMPECRAFT_WEB_URL debe usar HTTPS (HTTP solo en localhost).');
    }
    if (!token || token.length < 32) throw new Error('IMPECRAFT_BOT_TOKEN debe tener al menos 32 caracteres.');
    this.url = new URL('/api/bridge/impebot', base).href;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
    this.name = 'web';
  }

  async request(method, body, params = {}) {
    const url = new URL(this.url);
    for (const [key, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(key, String(value));
    const response = await this.fetch(url, {
      method, redirect: 'error',
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw ticketError(response.status >= 500 ? 'La web de soporte no está disponible.' : data?.error || `Error HTTP ${response.status}`, response.status);
    if (!data) throw new Error('Respuesta inválida de impecraft-web.');
    return data;
  }

  list(params) { return this.request('GET', null, params); }
  get(number) { return this.request('GET', null, { number }); }
  create(data) { return this.request('POST', { action: 'create', ...data }); }
  message(number, data) { return this.request('POST', { action: 'message', number, ...data }); }
  update(number, changes, actor) { return this.request('POST', { action: 'update', number, changes, actor }); }
  link(jid, code) { return this.request('POST', { action: 'link', jid, code }); }
}
