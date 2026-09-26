'use client';

import Link from 'next/link';
import ConsoleIcon from './ConsoleIcon';
import { ThemeToggle } from './ConsoleTheme';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { apiFetch, clearCachedSessionUser, displayRole, fetchSessionUser, readCachedSessionUser, type SessionUser } from '../lib/api';
import { clearFpaDraft, FPA_DRAFT_WARNING_MESSAGE, hasFpaDraft } from './FpaDraftGuard';
import { SportProvider, SPORTS, useSportContext, type Sport } from './SportContext';

type NavItem = {
  href: string;
  label: string;
  icon: string;
  match: (pathname: string) => boolean;
  roles?: SessionUser['role'][];
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
];

const BASKETBALL_FLA_ITEMS: NavItem[] = [
  FLA_ITEMS[0],
  {
    href: '/admin/basketball/media', label: 'Media', icon: '◉',
    match: (pathname) => pathname.startsWith('/admin/basketball/media'),
  },
  {
    href: '/admin/basketball/visualization',
    label: 'Visualization',
    icon: '◌',
    match: (pathname) => pathname.startsWith('/admin/basketball/visualization'),
  },
];

// 퀸컵은 수동 FLA/FPA 기록만 사용한다. 미디어·라이브 코더 메뉴를 노출하지 않는다.
const FUTSAL_FLA_ITEMS: NavItem[] = [FLA_ITEMS[0], {
  href: '/admin/futsal/visualization', label: 'Visualization', icon: '◌',
  match: pathname => pathname.startsWith('/admin/futsal/visualization'),
}];

const FHL_ITEMS: NavItem[] = [
  // FinePlay 연동 프로세스에서 쓰지 않는 기존 업로드→완료 흐름은 메뉴에서 숨긴다 (페이지는 살아있음).
  // {
  //   href: '/admin/highlight/upload',
  //   label: 'Upload',
  //   icon: '⬆',
  //   match: (pathname) => pathname.startsWith('/admin/highlight/upload'),
  //   roles: ['OPERATOR', 'SUPERADMIN'],
  // },
  // {
  //   href: '/admin/highlight/my',
  //   label: 'My Clips',
  //   icon: '◍',
  //   match: (pathname) => pathname.startsWith('/admin/highlight/my'),
  //   roles: ['OPERATOR', 'SUPERADMIN'],
  // },
  // {
  //   href: '/admin/highlight/process',
  //   label: 'Process',
  //   icon: '▤',
  //   match: (pathname) => pathname.startsWith('/admin/highlight/process'),
  //   roles: ['SUPERADMIN'],
  // },
  // {
  //   href: '/admin/highlight/completed',
  //   label: 'Completed',
  //   icon: '✓',
  //   match: (pathname) => pathname.startsWith('/admin/highlight/completed'),
  //   roles: ['SUPERADMIN'],
  // },
  {
    href: '/admin/highlight',
    label: 'AI+Log',
    icon: '▶',
    match: (pathname) => pathname === '/admin/highlight' || pathname.startsWith('/admin/highlight/player'),
    roles: ['SUPERADMIN'],
  },
  {
    href: '/admin/highlight/fineplay',
    label: 'FinePlay',
    icon: '◇',
    match: (pathname) =>
      pathname.startsWith('/admin/highlight/fineplay') ||
      pathname.startsWith('/admin/highlight/editroom') ||
      pathname.startsWith('/admin/highlight/clips') ||
      pathname.startsWith('/admin/highlight/archive'),
    roles: ['SUPERADMIN'],
  },
  {
    href: '/admin/highlight/overlay',
    label: '중계 오버레이',
    icon: '▧',
    match: (pathname) => pathname.startsWith('/admin/highlight/overlay'),
    roles: ['SUPERADMIN'],
  },
  // OPERATOR 는 FinePlay 클립 결과(+클립 귀속 FPA)만 접근한다.
  {
    href: '/admin/highlight/clips',
    label: 'FinePlay',
    icon: '◇',
    match: (pathname) => pathname.startsWith('/admin/highlight/clips'),
    roles: ['OPERATOR'],
  },
];

// 농구 하이라이트는 수동 태깅으로만 만든다. AI+Log·FinePlay 연동·중계 오버레이는
// 축구 경기 데이터(이벤트·선수단·클립 작업)를 전제로 하므로 농구에서는 열지 않는다.
const BASKETBALL_FHL_ITEMS: NavItem[] = [
  {
    href: '/admin/highlight/manual',
    label: '수동 태깅',
    icon: '▶',
    match: (pathname) => pathname.startsWith('/admin/highlight/manual'),
    roles: ['SUPERADMIN'],
  },
  {
    href: '/admin/highlight/results',
    label: '수동 결과물',
    icon: '✓',
    match: (pathname) => pathname.startsWith('/admin/highlight/results'),
    roles: ['SUPERADMIN'],
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
    label: 'Model Room',
    icon: '◌',
    match: (pathname) => pathname.startsWith('/admin/fpa/reports'),
  },
  {
    href: '/admin/fpa/replay',
    label: 'Scene Motion',
    icon: '◒',
    match: (pathname) => pathname.startsWith('/admin/fpa/replay'),
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
    href: '/admin/fcm/workspace',
    label: 'Workspace',
    icon: '▣',
    match: (pathname) => pathname.startsWith('/admin/fcm/workspace'),
  },
  {
    href: '/admin/fcm/guide',
    label: 'Guide',
    icon: '⋯',
    match: (pathname) => pathname.startsWith('/admin/fcm/guide'),
  },
];

const FUTSAL_FCM_ITEMS: NavItem[] = [
  {
    href: '/admin/fcm/futsal',
    label: 'Queen Cup Cards',
    icon: '▣',
    match: (pathname) => pathname.startsWith('/admin/fcm/futsal'),
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
  if (pathname.startsWith('/admin/futsal/visualization')) {
    return { product: 'FLA', eyebrow: 'Futsal FLA', title: 'Visualization' };
  }
  if (pathname.startsWith('/admin/basketball/visualization')) {
    return { product: 'FLA', eyebrow: 'Basketball FLA', title: 'Visualization' };
  }
  if (pathname.startsWith('/admin/basketball/media')) {
    return { product: 'FLA', eyebrow: 'Basketball FLA', title: 'Media' };
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
    if (pathname.startsWith('/admin/highlight/overlay')) {
      return { product: 'FHL', eyebrow: 'FinePlay Highlight', title: '중계 오버레이' };
    }
    if (pathname.startsWith('/admin/highlight/player')) {
      return { product: 'FHL', eyebrow: 'FinePlay Highlight', title: 'Player Clips' };
    }
    if (pathname.startsWith('/admin/highlight/upload')) {
      return { product: 'FHL', eyebrow: 'FinePlay Highlight', title: 'Upload' };
    }
    if (pathname.startsWith('/admin/highlight/my')) {
      return { product: 'FHL', eyebrow: 'FinePlay Highlight', title: 'My Clips' };
    }
    if (pathname.startsWith('/admin/highlight/process')) {
      return { product: 'FHL', eyebrow: 'FinePlay Highlight', title: 'Process' };
    }
    if (pathname.startsWith('/admin/highlight/completed')) {
      return { product: 'FHL', eyebrow: 'FinePlay Highlight', title: 'Completed' };
    }
    if (pathname.startsWith('/admin/highlight/manual')) {
      return { product: 'FHL', eyebrow: 'FinePlay Highlight', title: '수동 태깅' };
    }
    if (pathname.startsWith('/admin/highlight/results')) {
      return { product: 'FHL', eyebrow: 'FinePlay Highlight', title: '수동 결과물' };
    }
    if (pathname.startsWith('/admin/highlight/clips')) {
      return { product: 'FHL', eyebrow: 'FinePlay Highlight', title: '클립 결과' };
    }
    if (pathname.startsWith('/admin/highlight/archive')) {
      return { product: 'FHL', eyebrow: 'FinePlay Highlight', title: '아카이브' };
    }
    return { product: 'FHL', eyebrow: 'FinePlay Highlight', title: 'AI+Log' };
  }
  if (pathname.startsWith('/admin/system')) {
    return { product: 'SYSTEM', eyebrow: 'Console Settings', title: 'System' };
  }
  if (pathname.startsWith('/admin/fpa/live')) {
    return { product: 'FPA', eyebrow: 'Football Performance Analysis', title: 'Live Logger' };
  }
  if (pathname.startsWith('/admin/fpa/reports')) {
    return { product: 'FPA', eyebrow: 'Football Performance Analysis', title: 'Model Room' };
  }
  if (pathname.startsWith('/admin/fpa/replay')) {
    return { product: 'FPA', eyebrow: 'Football Performance Analysis', title: 'Scene Motion' };
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
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const pendingSportChangeRef = useRef<Sport | null>(null);
  const currentPath = pathname || '/admin/dashboard';
  const pageMeta = getPageMeta(currentPath);
  const [expandedProduct, setExpandedProduct] = useState<string | null>(pageMeta.product);
  useEffect(() => { setExpandedProduct(pageMeta.product); }, [pageMeta.product]);
  useEffect(() => {
    try {
      const saved = window.sessionStorage.getItem('fpc.sidebar.open');
      setSidebarOpen(saved === null ? !window.matchMedia('(max-width: 760px)').matches : saved === 'true');
    } catch { /* Storage is optional. */ }
  }, []);
  useEffect(() => {
    if (window.matchMedia('(max-width: 760px)').matches) setSidebarOpen(false);
  }, [currentPath]);
  const toggleSidebar = (open: boolean) => {
    setSidebarOpen(open);
    try { window.sessionStorage.setItem('fpc.sidebar.open', String(open)); } catch { /* Optional. */ }
  };
  const visibleSections = NAV_SECTIONS.map((section) => {
    let items = section.items;
    if (sport === 'BASKETBALL') {
      items = section.id === 'FLA'
        ? BASKETBALL_FLA_ITEMS
        : section.id === 'FHL'
          ? BASKETBALL_FHL_ITEMS.filter((item) => !item.roles || (user?.role && item.roles.includes(user.role)))
          : [];
    } else if (sport === 'FUTSAL') {
      items = section.id === 'FLA' ? FUTSAL_FLA_ITEMS : section.id === 'FPA' ? FPA_ITEMS : section.id === 'FCM' ? FUTSAL_FCM_ITEMS : [];
    } else if (section.id === 'FLA' && user?.role !== 'SUPERADMIN') {
      items = section.items.filter((item) => item.href === '/admin/dashboard');
    } else if (section.id === 'FHL') {
      items = section.items.filter((item) => !item.roles || (user?.role && item.roles.includes(user.role)));
    }
    return { ...section, items };
  }).filter((section) => section.items.length > 0);

  useEffect(() => {
    let active = true;
    const cachedUser = readCachedSessionUser();
    if (cachedUser) setUser(cachedUser);

    fetchSessionUser()
      .then((data) => {
        if (active) setUser(data);
      })
      .catch(() => {
        if (active) {
          setUser(null);
          router.replace(`/login?next=${encodeURIComponent(currentPath)}`);
        }
      });

    return () => {
      active = false;
    };
  }, [router, currentPath]);

  useEffect(() => {
    if (pendingSportChangeRef.current) return;
    if (currentPath.startsWith('/admin/futsal') && sport !== 'FUTSAL') setSport('FUTSAL');
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
    clearCachedSessionUser();
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
      <aside id="console-sidebar" className="sidebar" hidden={!sidebarOpen} onKeyDown={(event) => { if (event.key === 'Escape') { toggleSidebar(false); sidebarToggleRef.current?.focus(); } }}>
        <div className="sidebar-brand">
          <button className="sidebar-toggle" onClick={() => { toggleSidebar(false); sidebarToggleRef.current?.focus(); }} aria-label="사이드바 숨기기" aria-controls="console-sidebar" aria-expanded={sidebarOpen}>
            <ConsoleIcon name="panel" />
          </button>
          {sidebarOpen ? (
            <div>
              <div className="console-wordmark"><img src="/brand/fineplay-mark.svg" alt="" width="28" height="30" /><strong>Fine Play<span>console</span></strong></div>
            </div>
          ) : null}
        </div>

        {sidebarOpen ? (
          <>
            <div className="sidebar-main">
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
                    <button
                      className={`product-badge product-toggle ${pageMeta.product === section.id ? 'active' : ''}`}
                      onClick={() => setExpandedProduct((current) => current === section.id ? null : section.id)}
                      aria-expanded={expandedProduct === section.id}
                      aria-controls={`nav-${section.id}`}
                    >
                      <span className="product-label"><span className="product-monogram">{section.label}</span><span>{({ FLA: 'Live Analytics', FHL: 'Highlights', FPA: 'Performance', FCM: 'Card Studio' })[section.id]}</span></span>
                      <span className={`product-toggle-icon ${expandedProduct === section.id ? 'open' : ''}`}>⌄</span>
                    </button>
                    {expandedProduct === section.id ? (
                      <div className="product-nav" id={`nav-${section.id}`}>
                        {section.items.map((item) => (
                          <Link
                            className={item.match(currentPath) ? 'active' : ''}
                            href={item.href}
                            aria-current={item.match(currentPath) ? 'page' : undefined}
                            key={item.href}
                          >
                            <span className="nav-icon"><ConsoleIcon name={item.label} /></span>
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
                    <span className="nav-icon"><ConsoleIcon name="data" /></span>
                    {DATA_HUB_ITEM.label}
                  </span>
                </Link>
              </nav>

              <div className="sidebar-footer">
                {user?.role === 'SUPERADMIN' ? (
                  <Link className={`sidebar-system-link ${currentPath.startsWith('/admin/system') ? 'active' : ''}`} href="/admin/system" aria-current={currentPath.startsWith('/admin/system') ? 'page' : undefined}>
                    <ConsoleIcon name="System" /> System
                  </Link>
                ) : null}
                <button onClick={logout}><ConsoleIcon name="logout" /> 로그아웃</button>
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

      <div className="app-main" onKeyDown={(event) => { if (event.key === 'Escape' && sidebarOpen) { toggleSidebar(false); sidebarToggleRef.current?.focus(); } }}>
        <header className="topbar">
          <div className="topbar-leading">
            <button
              ref={sidebarToggleRef}
              className="topbar-sidebar-toggle"
              onClick={() => toggleSidebar(!sidebarOpen)}
              aria-label={sidebarOpen ? '사이드바 숨기기' : '사이드바 열기'}
              title={sidebarOpen ? '사이드바 숨기기' : '사이드바 열기'}
              aria-expanded={sidebarOpen}
              aria-controls="console-sidebar"
            >
              <ConsoleIcon name="panel" />
            </button>
            <div>
            <div className="sidebar-eyebrow">Workspace <span className="breadcrumb-divider">/</span> {pageMeta.product}</div>
            <h1>{pageMeta.title}</h1>
            </div>
          </div>
          <div className="topbar-actions">
            <ThemeToggle />
            {currentPath.startsWith('/admin/basketball/match/') ? (
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
