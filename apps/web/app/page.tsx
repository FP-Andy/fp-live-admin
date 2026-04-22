import Link from 'next/link';

export default function Home() {
  return (
    <main className="login-page">
      <section className="login-panel" style={{ alignItems: 'center' }}>
        <div className="login-copy">
          <div className="sidebar-eyebrow">Fine Play Console</div>
          <h1>FLA and FPA in one workspace</h1>
          <p>FLA 운영 도구와 FPA 분석 도구를 하나의 콘솔에서 분리된 제품 구조로 다룹니다.</p>
          <div className="row">
            <Link className="home-link" href="/login">Login</Link>
            <Link className="home-link secondary" href="/admin/dashboard">Dashboard</Link>
          </div>
        </div>
      </section>
    </main>
  );
}
