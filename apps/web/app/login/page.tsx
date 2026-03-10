import LoginForm from '../../components/LoginForm';

export default function LoginPage({
  searchParams,
}: {
  searchParams?: { next?: string };
}) {
  const nextPath = searchParams?.next || '/admin/dashboard';

  return (
    <main className="login-page">
      <section className="login-panel">
        <div className="login-copy">
          <div className="sidebar-eyebrow">Fineplay Broadcast Ops</div>
          <h1>간단 로그인</h1>
          <p>
            운영자 이름만 입력하면 세션이 발급됩니다.
            이후 매치 생성과 락 점유는 현재 로그인 계정 기준으로 동작합니다.
          </p>
        </div>

        <LoginForm nextPath={nextPath} />
      </section>
    </main>
  );
}
