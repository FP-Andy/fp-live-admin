'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { apiFetch, apiJson, displayRole, type SessionUser } from '../lib/api';
import { clearFpaDraft, FPA_DRAFT_WARNING_MESSAGE, hasFpaDraft } from './FpaDraftGuard';
import { SportProvider, SPORTS, useSportContext, type Sport } from './SportContext';

type NavItem = {
  href: string;
  label: string;
  icon: string;
  match: (pathname: string) => boolean;
};

type NavSection = {
  id: 'FLA' | 'FPA' | 'FCM' | 'FHL';
  label: string;
  items: NavItem[];
};

const DATA_HUB_ITEM: NavItem = {
  href: '/admin/data-hub',
  label: 'Data Hub',
  icon: '⇩',
  match: (pathname) => pathname.startsWith('/admin/data-hub'),
};

const FLA_ITEMS: NavItem[] = [
  {
    href: '/admin/dashboard',
    label: 'Dashboard',
    icon: '▦',
    match: (pathname) => pathname === '/admin/dashboard',
  },
  {
    href: '/admin/media',
    label: 'Media',
    icon: '◉',
    match: (pathname) => pathname.startsWith('/admin/media'),
  },
  {
    href: '/admin/live-coder',
    label: 'Live Coder',
    icon: '▥',
    match: (pathname) => pathname.startsWith('/admin/live-coder'),
  },
  {
    href: '/admin/system',
    label: 'System',
    icon: '⚙',
    match: (pathname) => pathname.startsWith('/admin/system'),
  },
];

const BASKETBALL_FLA_ITEMS: NavItem[] = [
  FLA_ITEMS[0],
  {
    href: '/admin/basketball/visualization',
    label: 'Visualization',
    icon: '◌',
    match: (pathname) => pathname.startsWith('/admin/basketball/visualization'),
  },
];

const FHL_ITEMS: NavItem[] = [
  {
    href: '/admin/highlight',
    label: 'Highlight',
    icon: '▶',
    match: (pathname) => pathname === '/admin/highlight',
  },
  {
    href: '/admin/highlight/player',
    label: 'Player Clips',
    icon: '◍',
    match: (pathname) => pathname.startsWith('/admin/highlight/player'),
  },
];

const FPA_ITEMS: NavItem[] = [
  {
    href: '/admin/fpa/live',
    label: 'Live Logger',
    icon: '⌁',
    match: (pathname) => pathname.startsWith('/admin/fpa/live'),
  },
  {
    href: '/admin/fpa/reports',
    label: 'Visual Reports',
    icon: '◌',
    match: (pathname) => pathname.startsWith('/admin/fpa/reports'),
  },
  {
    href: '/admin/fpa/settings',
    label: 'Code Guide',
    icon: '⋯',
    match: (pathname) => pathname.startsWith('/admin/fpa/settings'),
  },
];

const FCM_ITEMS: NavItem[] = [
  {
    href: '/admin/fcm/workspace',
    label: 'Workspace',
    icon: '▣',
    match: (pathname) => pathname.startsWith('/admin/fcm/workspace'),
  },
  {
    href: '/admin/fcm/match-status',
    label: 'Match Status',
    icon: '◎',
    match: (pathname) => pathname.startsWith('/admin/fcm/match-status'),
  },
  {
    href: '/admin/fcm/templates',
    label: 'Templates',
    icon: '◫',
    match: (pathname) => pathname.startsWith('/admin/fcm/templates'),
  },
  {
    href: '/admin/fcm/guide',
    label: 'Guide',
    icon: '⋯',
    match: (pathname) => pathname.startsWith('/admin/fcm/guide'),
  },
];

const NAV_SECTIONS: NavSection[] = [
  { id: 'FLA', label: 'FLA', items: FLA_ITEMS },
  { id: 'FHL', label: 'FHL', items: FHL_ITEMS },
  { id: 'FPA', label: 'FPA', items: FPA_ITEMS },
  { id: 'FCM', label: 'FCM', items: FCM_ITEMS },
];

function getPageMeta(pathname: string) {
  if (pathname.startsWith('/admin/match/') && pathname.endsWith('/edit')) {
    return { product: 'FLA', eyebrow: 'Live Match Admin', title: 'Event Editor' };
  }
  if (pathname.startsWith('/admin/match/')) {
    return { product: 'FLA', eyebrow: 'Live Match Admin', title: 'Match Control' };
  }
  if (pathname.startsWith('/admin/basketball/visualization')) {
    return { product: 'FLA', eyebrow: 'Basketball FLA', title: 'Visualization' };
  }
  if (pathname.startsWith('/admin/basketball/')) {
    return { product: 'FLA', eyebrow: 'Basketball FLA', title: 'Match Control' };
  }
  if (pathname.startsWith('/admin/media')) {
    return { product: 'FLA', eyebrow: 'Live Match Admin', title: 'Media' };
  }
  if (pathname.startsWith('/admin/live-coder')) {
    return { product: 'FLA', eyebrow: 'FLA Broadcast Overlay', title: 'Live Coder' };
  }
  if (pathname.startsWith('/admin/highlight')) {
    if (pathname.startsWith('/admin/highlight/player')) {
      return { product: 'FHL', eyebrow: 'FinePlay Highlight', title: 'Player Clips' };
    }
    return { product: 'FHL', eyebrow: 'FinePlay Highlight', title: 'Highlight' };
  }
  if (pathname.startsWith('/admin/system')) {
    return { product: 'FLA', eyebrow: 'Live Match Admin', title: 'System' };
  }
  if (pathname.startsWith('/admin/fpa/live')) {
    return { product: 'FPA', eyebrow: 'Football Performance Analysis', title: 'Live Logger' };
  }
  if (pathname.startsWith('/admin/fpa/reports')) {
    return { product: 'FPA', eyebrow: 'Football Performance Analysis', title: 'Visual Reports' };
  }
  if (pathname.startsWith('/admin/fpa/settings')) {
    return { product: 'FPA', eyebrow: 'Football Performance Analysis', title: 'Code Guide' };
  }
  if (pathname.startsWith('/admin/fpa')) {
    return { product: 'FPA', eyebrow: 'Football Performance Analysis', title: 'FPA' };
  }
  if (pathname.startsWith('/admin/fcm/match-status')) {
    return { product: 'FCM', eyebrow: 'FinePlay Card Marker', title: 'Match Status' };
  }
  if (pathname.startsWith('/admin/fcm/workspace')) {
    return { product: 'FCM', eyebrow: 'FinePlay Card Marker', title: 'Workspace' };
  }
  if (pathname.startsWith('/admin/fcm/templates')) {
    return { product: 'FCM', eyebrow: 'FinePlay Card Marker', title: 'Templates' };
  }
  if (pathname.startsWith('/admin/data-hub')) {
    return { product: 'DATA', eyebrow: 'Shared Match Data', title: 'Data Hub' };
  }
  if (pathname.startsWith('/admin/fcm/guide')) {
    return { product: 'FCM', eyebrow: 'FinePlay Card Marker', title: 'Guide' };
  }
  if (pathname.startsWith('/admin/fcm')) {
    return { product: 'FCM', eyebrow: 'FinePlay Card Marker', title: 'FCM' };
  }
  return { product: 'FLA', eyebrow: 'Live Match Admin', title: 'Dashboard' };
}

function AdminShellContent({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { sport, setSport } = useSportContext();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const pendingSportChangeRef = useRef<Sport | null>(null);
  const currentPath = pathname || '/admin/dashboard';
  const pageMeta = getPageMeta(currentPath);
  const visibleSections = NAV_SECTIONS.map((section) => {
    let items = section.items;
    if (sport === 'BASKETBALL') {
      items = section.id === 'FLA' ? BASKETBALL_FLA_ITEMS : [];
    } else if (section.id === 'FLA' && user?.role !== 'SUPERADMIN') {
      items = section.items.filter((item) => item.href === '/admin/dashboard');
    } else if (section.id === 'FHL' && user?.role !== 'SUPERADMIN') {
      items = [];
    }
    return { ...section, items };
  }).filter((section) => section.items.length > 0);

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

  useEffect(() => {
    if (pendingSportChangeRef.current) return;
    if (currentPath.startsWith('/admin/basketball') && sport !== 'BASKETBALL') {
      setSport('BASKETBALL');
    }
  }, [currentPath, setSport, sport]);

  useEffect(() => {
    if (currentPath === '/admin/dashboard') {
      pendingSportChangeRef.current = null;
    }
  }, [currentPath]);

  const logout = async () => {
    if (currentPath.startsWith('/admin/fpa') && hasFpaDraft()) {
      const ok = window.confirm(FPA_DRAFT_WARNING_MESSAGE);
      if (!ok) return;
      clearFpaDraft();
    }
    await apiFetch('/session/logout', { method: 'POST' });
    router.replace('/login');
    router.refresh();
  };

  const changeSport = (nextSport: Sport) => {
    pendingSportChangeRef.current = nextSport;
    setSport(nextSport);
    if (currentPath !== '/admin/dashboard') {
      router.push('/admin/dashboard');
    } else {
      pendingSportChangeRef.current = null;
    }
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
              <div className="sidebar-eyebrow">Fine Play Console</div>
              <strong>Multi-Product Ops</strong>
            </div>
          ) : null}
        </div>

        {sidebarOpen ? (
          <>
            <div className="sidebar-main">
              <div className="sidebar-user">
                <div className="sidebar-eyebrow">Signed In</div>
                <strong>{user?.name || 'Loading...'}</strong>
                <span className="muted">@{user?.id || 'session'}{user?.role ? ` · ${displayRole(user.role)}` : ''}</span>
              </div>

              <div className="sidebar-sport-switcher">
                <div className="sidebar-eyebrow">Sport Context</div>
                <select
                  className="sport-switcher-select"
                  value={sport}
                  onChange={(event) => changeSport(event.target.value as Sport)}
                  aria-label="Sport context"
                >
                  {SPORTS.map((item) => (
                    <option key={item.value} value={item.value}>{item.label}</option>
                  ))}
                </select>
              </div>

              <nav className="sidebar-nav">
                {visibleSections.map((section) => (
                  <div className="sidebar-section" key={section.id}>
                    <Link
                      className={`product-badge product-toggle ${pageMeta.product === section.id ? 'active' : ''}`}
                      href={section.items[0]?.href || '/admin/dashboard'}
                    >
                      <span>{section.label}</span>
                      <span className={`product-toggle-icon ${pageMeta.product === section.id ? 'open' : ''}`}>⌄</span>
                    </Link>
                    {pageMeta.product === section.id ? (
                      <div className="product-nav">
                        {section.items.map((item) => (
                          <Link
                            className={item.match(currentPath) ? 'active' : ''}
                            href={item.href}
                            key={item.href}
                          >
                            <span className="nav-icon">{item.icon}</span>
                            {item.label}
                          </Link>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ))}
                <Link
                  className={`product-badge data-hub-nav-item ${DATA_HUB_ITEM.match(currentPath) ? 'active' : ''}`}
                  href={DATA_HUB_ITEM.href}
                >
                  <span>
                    <span className="nav-icon">{DATA_HUB_ITEM.icon}</span>
                    {DATA_HUB_ITEM.label}
                  </span>
                </Link>
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
            <div className="sidebar-eyebrow">{pageMeta.eyebrow}</div>
            <h1>{pageMeta.title}</h1>
          </div>
          <div className="topbar-actions">
            {(currentPath.startsWith('/admin/basketball/match/') || (currentPath.startsWith('/admin/match/') && !currentPath.endsWith('/edit'))) ? (
              <Link className="button-link button-compact btn-secondary" href="/admin/dashboard">Dashboard</Link>
            ) : null}
            <div className="topbar-badge sport-context-badge">
              <span className="status-dot" />
              {SPORTS.find((item) => item.value === sport)?.label || 'Football'}
            </div>
            <div className="topbar-badge">
              <span className="status-dot" />
              {user?.name || 'Session'}{user?.role ? ` · ${displayRole(user.role)}` : ''}
            </div>
          </div>
        </header>

        <div className="app-content">{children}</div>
      </div>
    </div>
  );
}

export default function AdminShell({ children }: { children: React.ReactNode }) {
  return (
    <SportProvider>
      <AdminShellContent>{children}</AdminShellContent>
    </SportProvider>
  );
}
