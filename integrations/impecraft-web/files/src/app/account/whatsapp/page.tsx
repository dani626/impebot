import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/server/auth';
import { WhatsappLink } from '@/components/features/auth/WhatsappLink';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Vincular WhatsApp' };

export default async function WhatsappPage() {
    if (!(await getCurrentUser())) redirect('/login?next=/account/whatsapp');
    return <div className="mx-auto max-w-xl px-4 py-10"><WhatsappLink /></div>;
}
