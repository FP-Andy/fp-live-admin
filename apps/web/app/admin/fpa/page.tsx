import { redirect } from 'next/navigation';

export default function FpaIndexPage() {
  redirect('/admin/fpa/live');
}
