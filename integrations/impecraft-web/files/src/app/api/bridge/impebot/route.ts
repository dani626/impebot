import { NextResponse } from 'next/server';
import { HttpError, readJson, route } from '@/lib/server/http';
import { botAction, botList, requireImpebot } from '@/lib/server/impebot';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const GET = route(async (req) => {
    requireImpebot(req);
    return NextResponse.json(await botList(new URL(req.url).searchParams), { headers: { 'Cache-Control': 'no-store' } });
});

export const POST = route(async (req) => {
    requireImpebot(req);
    const text = await req.text();
    if (Buffer.byteLength(text, 'utf8') > 32_768) throw new HttpError(413, 'Petición demasiado grande');
    const input = await readJson(new Request(req.url, { method: 'POST', body: text }));
    return NextResponse.json(await botAction(input), { headers: { 'Cache-Control': 'no-store' } });
});
