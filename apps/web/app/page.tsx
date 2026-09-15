import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

export default function Home() {
  // The dashboard validates the session; an expired cookie still reaches login.
  const hasSession = Boolean(cookies().get('live_admin_session')?.value);
  redirect(hasSession ? '/admin/dashboard' : '/login');
}
