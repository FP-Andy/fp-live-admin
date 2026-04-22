import { redirect } from 'next/navigation';

export default function FvcIndexPage() {
  redirect('/admin/fcm/match-status');
}
