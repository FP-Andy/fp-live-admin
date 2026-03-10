'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { apiFetch, apiJson, type SessionUser } from '../lib/api';

export default function AdminShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  useEffect(() => {
    let active = true;

    apiJson<SessionUser>('/session/me')
      .then((data) => {
        if (active) setUser(data);
      })
      .catch(() => {
        router.replace(`/login?next=${encodeURIComponent(pathname || '/admin/dashboard')}`);
      });

    return () => {
      active = false;
    };
  }, [pathname, router]);

  const logout = async () => {
    await apiFetch('/session/logout', { method: 'POST' });
    router.replace('/login');
    router.refresh();
  };

  return (
    <div className={`app-shell ${sidebarOpen ? 'expanded' : 'collapsed'}`}>
      <aside className={`sidebar ${sidebarOpen ? 'open' : 'collapsed'}`}>
        <div className="sidebar-brand">
          <button className="sidebar-toggle" onClick={() => setSidebarOpen((prev) => !prev)} aria-label="Toggle sidebar">
            {sidebarOpen ? '←' : '→'}
          </button>
          {sidebarOpen ? (
            <div>
              <div className="sidebar-eyebrow">Fineplay Console</div>
              <strong>Live Admin</strong>
            </div>
          ) : null}
        </div>

        {sidebarOpen ? (
          <>
            <div className="sidebar-main">
              <div className="sidebar-user">
                <div className="sidebar-eyebrow">Signed In</div>
                <strong>{user?.name || 'Loading...'}</strong>
                <span className="muted">@{user?.id || 'session'}</span>
              </div>

              <nav className="sidebar-nav">
                <Link className={pathname === '/admin/dashboard' ? 'active' : ''} href="/admin/dashboard">Dashboard</Link>
              </nav>

              <div className="sidebar-footer">
                <button onClick={logout}>Log Out</button>
              </div>
            </div>

            <div className="sidebar-legal">
              <div>(주)파인루덴스</div>
              <div>대표이사 : 이용근</div>
              <div>사업자등록번호 : 804-59-00695</div>
              <div>연락처 : 010-6343-1823</div>
              <div>이메일 : official@fineplay.kr</div>
              <div>© 2026 Fine Ludens Co., Ltd All rights reserved</div>
            </div>
          </>
        ) : null}
      </aside>

      <div className="app-main">
        <header className="topbar">
          <div>
            <div className="sidebar-eyebrow">Match Operations</div>
            <h1>{pathname?.startsWith('/admin/match/') ? 'Match Control' : 'Dashboard'}</h1>
          </div>
          <div className="topbar-badge">
            <span className="status-dot" />
            {user?.name || 'Session'}
          </div>
        </header>

        <div className="app-content">{children}</div>
      </div>
    </div>
  );
}
