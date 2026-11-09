'use client';
import { useState } from 'react';
import Link from 'next/link';

export function WhatsappLink() {
    const [command, setCommand] = useState('');
    const [status, setStatus] = useState('');
    const [busy, setBusy] = useState(false);
    async function update(method: 'POST' | 'DELETE') {
        setBusy(true); setStatus(''); setCommand('');
        try {
            const response = await fetch('/api/account/impebot', { method });
            const data = await response.json();
            if (!response.ok) throw new Error(data.error || 'No se pudo completar la solicitud');
            if (method === 'POST') {
                setCommand(`!vincular ${data.code}`);
                setStatus('Envía este comando por privado al bot desde tu WhatsApp. Caduca en 10 minutos y solo se puede usar una vez.');
            } else setStatus('WhatsApp desvinculado. Ya no se enviarán nuevas respuestas a ese número.');
        } catch (error) { setStatus(error instanceof Error ? error.message : 'No se pudo conectar'); }
        finally { setBusy(false); }
    }
    return (
        <section className="glass space-y-4 rounded-xl p-6">
            <h1 className="text-2xl font-bold">Soporte por WhatsApp</h1>
            <p>Vincula tu cuenta para abrir y continuar tus tickets desde WhatsApp. El historial también estará en Soporte.</p>
            <p className="text-sm text-slate-400">No compartas el código: permite vincular tu cuenta al número que lo envíe. Para atender tickets desde Discord, vincula Discord en Mi cuenta y usa tu rol de staff.</p>
            <div className="flex flex-wrap gap-3">
                <button className="btn-minecraft" disabled={busy} onClick={() => update('POST')}>Generar código</button>
                <button className="btn-secondary" disabled={busy} onClick={() => update('DELETE')}>Desvincular WhatsApp</button>
            </div>
            {command && <pre className="overflow-x-auto rounded-lg bg-black/30 p-3"><code>{command}</code></pre>}
            <p role="status">{status}</p>
            <Link href="/account" className="text-teal-300">Volver a Mi cuenta</Link>
        </section>
    );
}
