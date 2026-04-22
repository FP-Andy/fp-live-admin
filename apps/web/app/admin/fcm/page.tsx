import { redirect } from 'next/navigation';

export default function FcmIndexPage() {
  redirect('/admin/fcm/match-status');
}
