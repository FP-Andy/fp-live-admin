import { redirect } from 'next/navigation';

export default function FpaTrackingPage({ searchParams }: { searchParams?: { job?: string } }) {
  const job = searchParams?.job;
  redirect('/admin/futsal/fpa/tracking' + (job ? `?job=${encodeURIComponent(job)}` : ''));
}
