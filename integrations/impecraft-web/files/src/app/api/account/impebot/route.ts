import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/server/auth';
import { HttpError, route } from '@/lib/server/http';
import { issueWhatsappCode, unlinkWhatsapp } from '@/lib/server/impebot';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function sameOrigin(req: Request) {
    if (req.headers.get('origin') !== new URL(req.url).origin) throw new HttpError(403, 'Origen no autorizado');
    if ((process.env.IMPECRAFT_BOT_TOKEN || '').length < 32) throw new HttpError(503, 'La integración ImpeBot no está configurada');
}

export const POST = route(async (req) => {
    sameOrigin(req);
    return NextResponse.json(await issueWhatsappCode(await requireUser()), { headers: { 'Cache-Control': 'no-store' } });
});

export const DELETE = route(async (req) => {
    sameOrigin(req);
    await unlinkWhatsapp(await requireUser());
    return NextResponse.json({ ok: true });
});
