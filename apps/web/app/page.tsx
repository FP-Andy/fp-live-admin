import Link from 'next/link';

export default function Home() {
  return (
    <main className="login-page">
      <section className="login-panel" style={{ alignItems: 'center' }}>
        <div className="login-copy">
          <div className="sidebar-eyebrow">Fineplay Broadcast Ops</div>
          <h1>Live Match Admin</h1>
          <p>현장 운영용 대시보드와 매치 컨트롤 화면으로 이동할 수 있습니다.</p>
          <div className="row">
            <Link className="home-link" href="/login">Login</Link>
            <Link className="home-link secondary" href="/admin/dashboard">Dashboard</Link>
          </div>
        </div>
      </section>
    </main>
  );
}
