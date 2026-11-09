import 'server-only';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { db } from '@/lib/server/db';
import { HttpError } from '@/lib/server/http';
import { needsTwoFactor } from '@/lib/server/auth';
import { hasRole, isStaff } from '@/lib/roles';
import { createTicketSchema, ticketMessageSchema, ticketUpdateSchema } from '@/lib/server/validators';
import { ticketSummaryInclude, toTicketSummary } from '@/lib/server/tickets';
import { audit } from '@/lib/server/audit';
import { rateLimit } from '@/lib/server/rate-limit';
import type { Prisma, User } from '@/generated/prisma/client';

export const hashCode = (code: string) => createHash('sha256').update(code).digest('hex');

export function requireImpebot(req: Request) {
    const secret = process.env.IMPECRAFT_BOT_TOKEN || '';
    if (secret.length < 32) throw new HttpError(503, 'Integración ImpeBot deshabilitada');
    const supplied = req.headers.get('authorization') || '';
    const actual = createHash('sha256').update(supplied).digest();
    const expected = createHash('sha256').update(`Bearer ${secret}`).digest();
    if (!timingSafeEqual(actual, expected)) throw new HttpError(401, 'Bot no autorizado');
}

const jidSchema = z.string().max(128).regex(/^\d+(?::\d+)?@(s\.whatsapp\.net|lid)$/);
const actorSchema = z.object({
    id: z.string().min(1).max(128),
    platform: z.enum(['whatsapp', 'discord']),
    // Los roles y nombres enviados por el cliente no se usan como autorización.
    username: z.string().max(128).optional(),
    role: z.string().max(16).optional(),
});
const numberSchema = z.number().int().positive();
const eventSchema = z.string().min(1).max(191);
export const impebotRequest = z.discriminatedUnion('action', [
    z.object({ action: z.literal('link'), jid: jidSchema, code: z.string().regex(/^[a-f0-9]{32}$/) }),
    createTicketSchema.extend({ action: z.literal('create'), jid: jidSchema, eventId: eventSchema, username: z.string().max(128).optional() }),
    ticketMessageSchema.extend({ action: z.literal('message'), number: numberSchema, eventId: eventSchema, actor: actorSchema }),
    z.object({ action: z.literal('update'), number: numberSchema, changes: ticketUpdateSchema, actor: actorSchema }),
]);

type LinkRow = { user_id: string; whatsapp_jid: string | null; linked_at: Date | null };
type EventRow = { ticket_id: string; actor_id: string; action: string };
type Connection = Prisma.TransactionClient;

async function linkForJid(jid: string) {
    const [link] = await db.$queryRaw<LinkRow[]>`SELECT user_id, whatsapp_jid, linked_at FROM impebot_links WHERE whatsapp_jid = ${jid}`;
    if (!link) throw new HttpError(403, 'Primero vincula tu cuenta: Mi cuenta → WhatsApp en la web, luego !vincular CODIGO');
    const user = await db.user.findUnique({ where: { id: link.user_id } });
    if (!user) throw new HttpError(403, 'La cuenta vinculada ya no existe');
    return user;
}

async function resolveActor(actor: z.infer<typeof actorSchema>) {
    if (actor.platform === 'whatsapp') return { user: await linkForJid(jidSchema.parse(actor.id)), player: true };
    if (!/^\d{16,24}$/.test(actor.id)) throw new HttpError(403, 'Identidad Discord inválida');
    const user = await db.user.findUnique({ where: { discordId: actor.id } });
    if (!user || !isStaff(user.role)) throw new HttpError(403, 'Vincula tu Discord en Mi cuenta; necesitas un rol de staff en la web');
    if (await needsTwoFactor(user)) throw new HttpError(403, 'Activa la verificación en dos pasos en Mi cuenta');
    return { user, player: false };
}

async function previousEvent(tx: Connection, eventId: string, user: User, action: string, ticketId?: string) {
    const [event] = await tx.$queryRaw<EventRow[]>`SELECT ticket_id, actor_id, action FROM impebot_events WHERE event_id = ${eventId}`;
    if (event && (event.actor_id !== user.id || event.action !== action || (ticketId && event.ticket_id !== ticketId))) {
        throw new HttpError(409, 'El identificador del mensaje ya fue utilizado');
    }
    return event;
}

async function recordEvent(tx: Connection, eventId: string, user: User, action: string, ticketId: string) {
    await tx.$executeRaw`INSERT INTO impebot_events (event_id, ticket_id, actor_id, action) VALUES (${eventId}, ${ticketId}, ${user.id}, ${action})`;
}

export async function botTicketDetail(number: number) {
    const ticket = await db.ticket.findUnique({
        where: { number },
        include: {
            ...ticketSummaryInclude,
            messages: { include: { author: { select: { id: true, username: true, role: true } } }, orderBy: { createdAt: 'asc' } },
        },
    });
    if (!ticket) throw new HttpError(404, 'Ticket no encontrado');
    const [link] = await db.$queryRaw<LinkRow[]>`SELECT user_id, whatsapp_jid, linked_at FROM impebot_links WHERE user_id = ${ticket.userId}`;
    return {
        ...toTicketSummary(ticket),
        whatsappJid: link?.whatsapp_jid || null,
        whatsappLinkedAt: link?.linked_at?.toISOString() || null,
        messages: ticket.messages.map((m) => ({
            id: m.id, body: m.body, internal: m.internal, author: m.author, createdAt: m.createdAt.toISOString(),
        })),
    };
}

export async function botList(params: URLSearchParams) {
    if (params.has('number')) return botTicketDetail(numberSchema.parse(Number(params.get('number'))));
    const after = z.coerce.number().int().nonnegative().parse(params.get('after') || 0);
    const jid = params.get('jid');
    const owner = jid ? await linkForJid(jidSchema.parse(jid)) : null;
    const tickets = await db.ticket.findMany({
        where: { number: { gt: after }, ...(owner ? { userId: owner.id } : {}) },
        select: { number: true }, orderBy: { number: 'asc' }, take: 50,
    });
    return Promise.all(tickets.map((t) => botTicketDetail(t.number)));
}

export async function issueWhatsappCode(user: User) {
    rateLimit(`impebot-code:${user.id}`, 5, 10 * 60_000);
    const code = randomBytes(16).toString('hex');
    const hash = hashCode(code);
    const expires = new Date(Date.now() + 10 * 60_000);
    await db.$executeRaw`
        INSERT INTO impebot_links (user_id, code_hash, code_expires) VALUES (${user.id}, ${hash}, ${expires})
        ON DUPLICATE KEY UPDATE code_hash = VALUES(code_hash), code_expires = VALUES(code_expires)`;
    return { code, expiresAt: expires.toISOString() };
}

export async function unlinkWhatsapp(user: User) {
    await db.$executeRaw`DELETE FROM impebot_links WHERE user_id = ${user.id}`;
}

export async function botAction(input: unknown) {
    const data = impebotRequest.parse(input);
    if (data.action === 'link') {
        rateLimit(`impebot-link:${data.jid}`, 10, 10 * 60_000);
        const hash = hashCode(data.code);
        const userId = await db.$transaction(async (tx) => {
            const [link] = await tx.$queryRaw<LinkRow[]>`
                SELECT user_id, whatsapp_jid, linked_at FROM impebot_links
                WHERE code_hash = ${hash} AND code_expires > NOW(3) FOR UPDATE`;
            if (!link) throw new HttpError(400, 'Código inválido, utilizado o caducado');
            await tx.$executeRaw`UPDATE impebot_links SET whatsapp_jid = ${data.jid}, linked_at = NOW(3), code_hash = NULL, code_expires = NULL WHERE user_id = ${link.user_id}`;
            return link.user_id;
        });
        const user = await db.user.findUniqueOrThrow({ where: { id: userId } });
        return { username: user.username };
    }
    if (data.action === 'create') {
        const user = await linkForJid(data.jid);
        rateLimit(`impebot-create:${user.id}`, 10, 60 * 60_000);
        // Compras/apelaciones con pedido o sanción se crean en la web con sus verificaciones propias.
        if (data.orderId || data.sanctionId) throw new HttpError(400, 'Vincula pedidos o sanciones desde la web');
        const number = await db.$transaction(async (tx) => {
            // Serializa el límite y las creaciones simultáneas de este jugador por el puente.
            await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id} FOR UPDATE`;
            const event = await previousEvent(tx, data.eventId, user, 'create');
            if (event) return (await tx.ticket.findUniqueOrThrow({ where: { id: event.ticket_id } })).number;
            const count = await tx.ticket.count({ where: { userId: user.id, status: { not: 'CLOSED' } } });
            if (count >= 3) throw new HttpError(429, 'Ya tienes tres tickets abiertos');
            const ticket = await tx.ticket.create({
                data: {
                    userId: user.id, subject: data.subject, category: data.category,
                    priority: data.category === 'compra' ? 'HIGH' : 'NORMAL',
                    messages: { create: { body: data.message, authorId: user.id } },
                },
            });
            await recordEvent(tx, data.eventId, user, 'create', ticket.id);
            return ticket.number;
        });
        return botTicketDetail(number);
    }
    const { user, player } = await resolveActor(data.actor);
    rateLimit(`impebot-message:${user.id}`, 120, 60_000);
    await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM tickets WHERE number = ${data.number} FOR UPDATE`;
        const ticket = await tx.ticket.findUnique({ where: { number: data.number } });
        if (!ticket || (player && ticket.userId !== user.id)) throw new HttpError(404, 'Ticket no encontrado');
        if (data.action === 'message') {
            if (player && data.internal) throw new HttpError(403, 'Solo el staff puede dejar notas internas');
            if (await previousEvent(tx, data.eventId, user, 'message', ticket.id)) return;
            if (ticket.status === 'CLOSED') throw new HttpError(409, 'El ticket está cerrado; reábrelo antes de responder');
            await tx.ticketMessage.create({ data: { ticketId: ticket.id, authorId: user.id, body: data.body, internal: data.internal } });
            await tx.ticket.update({
                where: { id: ticket.id },
                data: {
                    ...(data.internal ? {} : { status: player ? 'OPEN' : 'PENDING', closedAt: null }),
                    ...(!player && !data.internal && !ticket.assigneeId ? { assigneeId: user.id } : {}),
                },
            });
            await recordEvent(tx, data.eventId, user, 'message', ticket.id);
        } else {
            const changes = data.changes;
            if (player && (changes.status !== 'CLOSED' || Object.keys(changes).some((key) => key !== 'status'))) {
                throw new HttpError(403, 'Solo puedes cerrar tus propios tickets');
            }
            const update: Prisma.TicketUncheckedUpdateInput = {};
            if (changes.status) { update.status = changes.status; update.closedAt = changes.status === 'CLOSED' ? new Date() : null; }
            if (changes.priority) update.priority = changes.priority;
            if (changes.category) update.category = changes.category;
            if (changes.assigneeId !== undefined) {
                const target = changes.assigneeId === 'me' ? user.id : changes.assigneeId;
                if (!hasRole(user.role, 'MODERATOR') && target !== user.id && !(target === null && ticket.assigneeId === user.id)) {
                    throw new HttpError(403, 'Solo un moderador puede reasignar tickets de otros');
                }
                if (target) {
                    const assignee = await tx.user.findUnique({ where: { id: target } });
                    if (!assignee || !isStaff(assignee.role)) throw new HttpError(400, 'Responsable inválido');
                }
                update.assigneeId = target;
            }
            await tx.ticket.update({ where: { id: ticket.id }, data: update });
        }
    });
    if (!player) await audit(user, 'update', 'ticket', null, `ImpeBot: ${data.action} en ticket #${data.number}`);
    return botTicketDetail(data.number);
}
