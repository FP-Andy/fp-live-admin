import Link from 'next/link';

export default function Home() {
  return (
    <main className="container">
      <h1>Live Match Admin</h1>
      <p><Link href="/admin/dashboard">Go to Dashboard</Link></p>
    </main>
  );
}
