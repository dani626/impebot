import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder,
  StringSelectMenuBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { PRIORITIES, PRIORITY_META } from './model.js';

const STATUS_LABEL = { OPEN: '🟩 Abierto', PENDING: '🟨 Esperando al jugador', CLOSED: '⬛ Cerrado' };
const ORIGIN_LABEL = { discord: 'Discord', whatsapp: 'WhatsApp', web: 'Web' };
const CLOSED_COLOR = 0x4f545c;

const button = (id, label, style, emoji) => {
  const b = new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(style);
  return emoji ? b.setEmoji(emoji) : b;
};
const chunk = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, i * size + size));

/** Panel de apertura: botones (5 por fila, 5 filas) o un menú desplegable; como máximo 25 categorías. */
export function buildPanelMessage(panel, categories) {
  const embed = new EmbedBuilder().setTitle(panel.title.slice(0, 256)).setDescription(panel.description.slice(0, 4096));
  if (panel.color) embed.setColor(panel.color);
  const shown = categories.filter((c) => c.enabled).slice(0, 25);
  if (!shown.length) return { embeds: [embed.setFooter({ text: 'No hay categorías activas.' })], components: [] };
  if (panel.mode === 'select') {
    const menu = new StringSelectMenuBuilder().setCustomId('tk:open_select').setPlaceholder('Elige el motivo de tu ticket').addOptions(
      shown.map((c) => ({ label: c.label.slice(0, 100), value: String(c.id), ...(c.description ? { description: c.description.slice(0, 100) } : {}), ...(c.emoji ? { emoji: c.emoji } : {}) })),
    );
    return { embeds: [embed], components: [new ActionRowBuilder().addComponents(menu)] };
  }
  const buttons = shown.map((c) => button(`tk:open:${c.id}`, c.label.slice(0, 80), ButtonStyle[c.buttonStyle] || ButtonStyle.Primary, c.emoji));
  return { embeds: [embed], components: chunk(buttons, 5).map((row) => new ActionRowBuilder().addComponents(row)) };
}

export function buildOpenModal(category) {
  return new ModalBuilder().setCustomId(`tk:modal:${category.id}`).setTitle(`Ticket: ${category.label}`.slice(0, 45)).addComponents(
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('subject').setLabel('Asunto')
      .setStyle(TextInputStyle.Short).setMinLength(5).setMaxLength(150).setRequired(true)),
    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('message').setLabel('Describe tu caso')
      .setStyle(TextInputStyle.Paragraph).setMinLength(1).setMaxLength(4000).setRequired(true)),
  );
}

/** Mensaje fijado del ticket: estado, prioridad y botones según el estado. Se edita en el mismo mensaje. */
export function buildControlMessage(ticket, { route = {}, category = null, webUrl = null } = {}) {
  const closed = ticket.status === 'CLOSED';
  const prio = PRIORITY_META[ticket.priority] || PRIORITY_META.NORMAL;
  const owner = route.owner_discord_id ? `<@${route.owner_discord_id}>` : ticket.user?.username || '—';
  const embed = new EmbedBuilder()
    .setTitle(`🎫 Ticket #${ticket.number}: ${ticket.subject}`.slice(0, 256))
    .setColor(closed ? CLOSED_COLOR : prio.color)
    .addFields(
      { name: 'Estado', value: STATUS_LABEL[ticket.status] || ticket.status, inline: true },
      { name: 'Prioridad', value: `${prio.emoji} ${prio.label}`, inline: true },
      { name: 'Categoría', value: category?.label || ticket.category, inline: true },
      { name: 'Creador', value: owner, inline: true },
      { name: 'Responsable', value: ticket.assignee?.username || 'Sin asignar', inline: true },
      { name: 'Origen', value: ORIGIN_LABEL[route.origin || ticket.origin] || 'WhatsApp', inline: true },
    );
  if (webUrl) embed.addFields({ name: 'Web', value: webUrl });
  if (category?.welcomeMessage && !closed) embed.setDescription(category.welcomeMessage.slice(0, 4000));
  else if (route.origin !== 'discord') embed.setDescription('/responder envía al jugador. /nota guarda una nota interna. El chat normal se queda en Discord.');

  const n = ticket.number;
  const actions = closed
    ? [button(`tk:reopen:${n}`, 'Reabrir', ButtonStyle.Success, '🔓'), button(`tk:transcript:${n}`, 'Transcripción', ButtonStyle.Secondary, '📄'),
      button(`tk:delete:${n}`, 'Borrar', ButtonStyle.Danger, '🗑️')]
    : [ticket.assignee ? button(`tk:release:${n}`, 'Soltar', ButtonStyle.Secondary, '↩️') : button(`tk:claim:${n}`, 'Tomar', ButtonStyle.Primary, '🙋'),
      button(`tk:close:${n}`, 'Cerrar', ButtonStyle.Danger, '🔒'), button(`tk:transcript:${n}`, 'Transcripción', ButtonStyle.Secondary, '📄')];
  const priority = new StringSelectMenuBuilder().setCustomId(`tk:prio:${n}`).setPlaceholder('Prioridad').setDisabled(closed)
    .addOptions(PRIORITIES.map((p) => ({ label: PRIORITY_META[p].label, value: p, emoji: PRIORITY_META[p].emoji, default: p === ticket.priority })));
  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(actions), new ActionRowBuilder().addComponents(priority)],
    allowedMentions: { parse: [] },
  };
}

export function buildDeleteConfirmRow(number) {
  return new ActionRowBuilder().addComponents(
    button(`tk:delete_confirm:${number}`, 'Confirmar borrado', ButtonStyle.Danger),
    button(`tk:delete_cancel:${number}`, 'Cancelar', ButtonStyle.Secondary),
  );
}
