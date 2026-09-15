import LoginForm from '../../components/LoginForm';
import { ThemeToggle } from '../../components/ConsoleTheme';

export default function LoginPage({
  searchParams,
}: {
  searchParams?: { next?: string };
}) {
  const requestedPath = searchParams?.next || '';
  const nextPath = requestedPath.startsWith('/') && !requestedPath.startsWith('//') && !requestedPath.includes('\\') ? requestedPath : '/admin/dashboard';

  return (
    <main className="login-page">
      <div className="login-theme"><ThemeToggle /></div>
      <section className="login-panel compact">
        <div className="login-copy centered">
          <img src="/brand/fineplay-mark.svg" alt="Fine Play" width="48" height="51" /><div className="sidebar-eyebrow">FINEPLAY CONSOLE</div>
          <h1>플레이의 시작.</h1><p className="muted">경기의 모든 순간을 연결하는 운영 워크스페이스</p>
        </div>

        <LoginForm nextPath={nextPath} />
      </section>
    </main>
  );
}
