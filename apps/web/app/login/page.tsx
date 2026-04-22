import LoginForm from '../../components/LoginForm';

export default function LoginPage({
  searchParams,
}: {
  searchParams?: { next?: string };
}) {
  const nextPath = searchParams?.next || '/admin/dashboard';

  return (
    <main className="login-page">
      <section className="login-panel compact">
        <div className="login-copy centered">
          <div className="sidebar-eyebrow">Fine Play Console</div>
          <h1>Sign In</h1>
        </div>

        <LoginForm nextPath={nextPath} />
      </section>
    </main>
  );
}
