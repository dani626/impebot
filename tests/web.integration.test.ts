import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '@/lib/server/db';
import { botAction, botList, botTicketDetail, hashCode, issueWhatsappCode, requireImpebot, unlinkWhatsapp } from '@/lib/server/impebot';
import { needsTwoFactor } from '@/lib/server/auth';

vi.mock('@/lib/server/auth', () => ({ needsTwoFactor: vi.fn(async () => false) }));

const jid = '59170000002@s.whatsapp.net';
let player: Awaited<ReturnType<typeof db.user.create>>;
let helper: typeof player;
let other: typeof player;
let number: number;
const actor = () => ({ id: helper.discordId!, platform: 'discord' as const, role: 'ADMIN', username: 'Ignored' });
const playerActor = () => ({ id: jid, platform: 'whatsapp' as const, role: 'ADMIN' });

beforeAll(async () => {
    if (!process.env.DATABASE_URL?.includes('/web_test')) throw new Error('Solo se puede ejecutar en la DB temporal web_test');
    player = await db.user.create({ data: { email: 'player@test.invalid', username: 'Jugador', password: 'fixture' } });
    other = await db.user.create({ data: { email: 'other@test.invalid', username: 'Otro', password: 'fixture' } });
    helper = await db.user.create({ data: { email: 'helper@test.invalid', username: 'Ayudante', password: 'fixture', role: 'HELPER', discordId: '12345678901234567' } });
});
afterAll(async () => { await db.$disconnect(); });

describe('puente real de impecraft-web sobre MariaDB temporal', () => {
    it('autenticación dedicada; rechaza vacío, otro token y sesiones como secreto', () => {
        process.env.IMPECRAFT_BOT_TOKEN = 's'.repeat(32);
        expect(() => requireImpebot(new Request('http://localhost'))).toThrow();
        expect(() => requireImpebot(new Request('http://localhost', { headers: { authorization: 'Bearer incorrecto' } }))).toThrow();
        expect(() => requireImpebot(new Request('http://localhost', { headers: { authorization: `Bearer ${'s'.repeat(32)}` } }))).not.toThrow();
    });

    it('un jugador debe demostrar posesión del código; se guarda solo su hash', async () => {
        await expect(botAction({ action: 'create', jid, eventId: 'create:unlinked', subject: 'Necesito ayuda', category: 'soporte', message: 'Ayuda' })).rejects.toMatchObject({ status: 403 });
        const { code } = await issueWhatsappCode(player);
        const [row] = await db.$queryRaw<{ code_hash: string }[]>`SELECT code_hash FROM impebot_links WHERE user_id = ${player.id}`;
        expect(row.code_hash).toBe(hashCode(code)); expect(row.code_hash).not.toBe(code);
        await expect(botAction({ action: 'link', jid, code: '0'.repeat(32) })).rejects.toMatchObject({ status: 400 });
        expect(await botAction({ action: 'link', jid, code })).toMatchObject({ username: player.username });
        await expect(botAction({ action: 'link', jid, code })).rejects.toMatchObject({ status: 400 });
    });

    it('usa los tickets nativos y hace idempotente la creación', async () => {
        const data = { action: 'create', jid, eventId: 'create:one', subject: 'Necesito ayuda', category: 'compra', message: 'No llegó mi rango' };
        const t = await botAction(data) as Awaited<ReturnType<typeof botTicketDetail>>;
        number = t.number;
        expect(t.user.id).toBe(player.id); expect(t.priority).toBe('HIGH'); expect(t.whatsappJid).toBe(jid);
        const duplicate = await botAction(data) as typeof t;
        expect(duplicate.id).toBe(t.id);
        expect(await db.ticket.count({ where: { userId: player.id } })).toBe(1);
        expect(await db.ticketMessage.count({ where: { ticketId: t.id } })).toBe(1);
    });

    it('separa notas internas, respuestas públicas y roles reales', async () => {
        await botAction({ action: 'message', number, body: 'Nota privada', internal: true, actor: actor(), eventId: 'dc:note' });
        let t = await botTicketDetail(number);
        expect(t.status).toBe('OPEN'); expect(t.assignee).toBe(null);
        const data = { action: 'message', number, body: 'Ya estamos revisando', internal: false, actor: actor(), eventId: 'dc:reply' };
        await botAction(data); await botAction(data);
        t = await botTicketDetail(number);
        expect(t.status).toBe('PENDING'); expect(t.assignee?.id).toBe(helper.id);
        expect(t.messages.filter((m) => m.internal).length).toBe(1); expect(t.messages.length).toBe(3);
        await expect(botAction({ action: 'message', number, body: 'Nota falsa', internal: true, actor: playerActor(), eventId: 'wa:note' })).rejects.toMatchObject({ status: 403 });
        await botAction({ action: 'message', number, body: 'Gracias', actor: playerActor(), eventId: 'wa:reply' });
        expect((await botTicketDetail(number)).status).toBe('OPEN');
    });

    it('no permite cerrar tickets ajenos ni elevar permisos con el JSON', async () => {
        const { code } = await issueWhatsappCode(other);
        const otherJid = '123@lid';
        await botAction({ action: 'link', jid: otherJid, code });
        await expect(botAction({ action: 'update', number, actor: { id: otherJid, platform: 'whatsapp', role: 'ADMIN' }, changes: { status: 'CLOSED' } })).rejects.toMatchObject({ status: 404 });
        await expect(botAction({ action: 'update', number, actor: playerActor(), changes: { priority: 'URGENT' } })).rejects.toMatchObject({ status: 403 });
        await expect(botAction({ action: 'update', number, actor: actor(), changes: { assigneeId: player.id } })).rejects.toMatchObject({ status: 403 });
    });

    it('una degradación de staff o 2FA pendiente bloquea la siguiente operación', async () => {
        await db.user.update({ where: { id: helper.id }, data: { role: 'USER' } });
        await expect(botAction({ action: 'update', number, actor: actor(), changes: { status: 'CLOSED' } })).rejects.toMatchObject({ status: 403 });
        await db.user.update({ where: { id: helper.id }, data: { role: 'HELPER' } });
        vi.mocked(needsTwoFactor).mockResolvedValueOnce(true);
        await expect(botAction({ action: 'update', number, actor: actor(), changes: { status: 'CLOSED' } })).rejects.toMatchObject({ status: 403 });
    });

    it('el panel nativo y el bot comparten mensajes, responsable y cierre', async () => {
        const t = await db.ticket.findUniqueOrThrow({ where: { number } });
        await db.ticketMessage.create({ data: { ticketId: t.id, body: 'Respuesta desde la web', authorId: helper.id } });
        expect((await botTicketDetail(number)).messages.at(-1)?.body).toBe('Respuesta desde la web');
        await botAction({ action: 'update', number, actor: actor(), changes: { status: 'CLOSED' } });
        expect((await db.ticket.findUniqueOrThrow({ where: { number } })).closedAt).not.toBeNull();
        await expect(botAction({ action: 'message', number, actor: actor(), body: 'Tarde', eventId: 'late' })).rejects.toMatchObject({ status: 409 });
        await botAction({ action: 'update', number, actor: actor(), changes: { status: 'OPEN' } });
        expect((await botTicketDetail(number)).status).toBe('OPEN');
        expect((await botList(new URLSearchParams({ jid }))) as unknown[]).toHaveLength(1);
    });

    it('el límite de tickets y la desvinculación se aplican en el servidor', async () => {
        for (let i = 2; i <= 3; i++) await botAction({ action: 'create', jid, eventId: `create:${i}`, subject: `Nuevo caso ${i}`, category: 'soporte', message: 'Ayuda' });
        await expect(botAction({ action: 'create', jid, eventId: 'create:4', subject: 'Cuarto caso', category: 'soporte', message: 'Ayuda' })).rejects.toMatchObject({ status: 429 });
        await unlinkWhatsapp(player);
        expect((await botTicketDetail(number)).whatsappJid).toBeNull();
        await expect(botList(new URLSearchParams({ jid }))).rejects.toMatchObject({ status: 403 });
    });
});
