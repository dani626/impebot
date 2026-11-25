const MAX_MESSAGES = 2000;

/** Escapa todo texto y URL que entra al HTML: el contenido lo escriben jugadores. */
export const escapeHtml = (text) => String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Solo enlaces http(s): un "javascript:" escapado seguiría ejecutándose al pulsarlo.
const safeUrl = (url) => (/^https?:\/\//i.test(String(url || '')) ? escapeHtml(url) : '#');

/** Lee los mensajes del canal en orden cronológico (hasta MAX_MESSAGES). */
async function fetchAll(channel) {
  const all = [];
  let before;
  while (all.length < MAX_MESSAGES) {
    const page = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    const list = [...page.values()];
    all.push(...list);
    if (list.length < 100) break;
    before = list.reduce((oldest, m) => (m.createdTimestamp < oldest.createdTimestamp ? m : oldest)).id;
  }
  return all.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

const embedText = (e) => [e.title, e.description, ...(e.fields || []).map((f) => `${f.name}: ${f.value}`)].filter(Boolean).join('\n');

/**
 * Genera la transcripción del canal de un ticket.
 * @returns {Promise<{ buffer: Buffer, fileName: string, messageCount: number }>}
 */
export async function generateTranscript({ channel, ticket, format = 'html', categoryLabel }) {
  const messages = (await fetchAll(channel)).map((m) => ({
    author: m.member?.displayName || m.author?.username || 'Desconocido',
    bot: Boolean(m.author?.bot),
    at: new Date(m.createdTimestamp).toISOString(),
    content: m.content || '',
    attachments: [...(m.attachments?.values?.() ?? [])].map((a) => ({ name: a.name, url: a.url })),
    embeds: (m.embeds || []).map(embedText).filter(Boolean),
  }));
  const meta = [
    ['Ticket', `#${ticket.number}`], ['Asunto', ticket.subject], ['Categoría', categoryLabel || ticket.category],
    ['Prioridad', ticket.priority], ['Estado', ticket.status], ['Creador', ticket.user?.username || '—'],
    ['Responsable', ticket.assignee?.username || 'Sin asignar'], ['Creado', ticket.createdAt], ['Generado', new Date().toISOString()],
  ];
  const fileName = `ticket-${ticket.number}.${format === 'txt' ? 'txt' : 'html'}`;
  if (format === 'txt') {
    const lines = [...meta.map(([k, v]) => `${k}: ${v ?? ''}`), '', ...messages.map((m) => [
      `[${m.at}] ${m.author}${m.bot ? ' (bot)' : ''}: ${m.content}`,
      ...m.embeds.map((e) => `  [embed] ${e.replace(/\n/g, '\n          ')}`),
      ...m.attachments.map((a) => `  [adjunto] ${a.name}: ${a.url}`),
    ].join('\n'))];
    return { buffer: Buffer.from(lines.join('\n'), 'utf8'), fileName, messageCount: messages.length };
  }
  const body = messages.map((m) => `<div class="msg"><div class="head"><b>${escapeHtml(m.author)}</b>${m.bot ? ' <span class="bot">BOT</span>' : ''} <time>${escapeHtml(m.at)}</time></div>`
    + (m.content ? `<div class="text">${escapeHtml(m.content)}</div>` : '')
    + m.embeds.map((e) => `<div class="embed">${escapeHtml(e)}</div>`).join('')
    + m.attachments.map((a) => `<div class="att">📎 <a href="${safeUrl(a.url)}" rel="noopener noreferrer">${escapeHtml(a.name)}</a></div>`).join('')
    + '</div>').join('\n');
  const html = `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https:">
<title>Ticket #${escapeHtml(ticket.number)}</title>
<style>body{background:#1e1f22;color:#dbdee1;font:15px/1.45 system-ui,sans-serif;margin:0;padding:24px}
header{background:#2b2d31;border-radius:8px;padding:16px;margin-bottom:16px}dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:0}
dt{color:#949ba4}.msg{padding:8px 12px;border-bottom:1px solid #2b2d31}.head time{color:#949ba4;font-size:12px;margin-left:6px}
.bot{background:#5865f2;color:#fff;border-radius:3px;padding:0 4px;font-size:11px}.text,.embed{white-space:pre-wrap;word-wrap:break-word}
.embed{border-left:4px solid #5865f2;background:#2b2d31;padding:6px 10px;margin-top:4px;border-radius:4px}a{color:#00a8fc}</style></head>
<body><header><h1>Ticket #${escapeHtml(ticket.number)}</h1><dl>${meta.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v ?? '')}</dd>`).join('')}</dl></header>
<main>${body}</main></body></html>`;
  return { buffer: Buffer.from(html, 'utf8'), fileName, messageCount: messages.length };
}
