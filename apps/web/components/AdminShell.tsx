'use client';

import Link from 'next/link';
import ConsoleIcon from './ConsoleIcon';
import { ThemeToggle } from './ConsoleTheme';
import { usePathname, useRouter } from 'next/navigation';
import { Fragment, useEffect, useRef, useState } from 'react';
import { apiFetch, clearCachedSessionUser, displayRole, fetchSessionUser, type SessionUser } from '../lib/api';
import { clearFpaDraft, FPA_DRAFT_WARNING_MESSAGE, hasFpaDraft } from './FpaDraftGuard';
import { SportProvider, SPORTS, useSportContext, type Sport } from './SportContext';
import {allowWorkspaceLeave} from '../lib/workspace-leave';

type NavItem = {
  href: string;
  label: string;
  icon: string;
  match: (pathname: string) => boolean;
  roles?: SessionUser['role'][];
  /** 사이드바 항목에 마우스를 올리면 뜨는 한 줄 설명(title). */
  description?: string;
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
    label: '운영 현황',
    icon: '▦',
    match: (pathname) => pathname === '/admin/dashboard',
  },
  {
    href: '/admin/media',
    label: '영상 송출',
    icon: '◉',
    match: (pathname) => pathname.startsWith('/admin/media'),
  },
  {
    href: '/admin/live-coder',
    label: '중계 그래픽',
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
  href: '/admin/futsal/fla/video', label: '영상 기록', icon: '▷',
  match: pathname => pathname.startsWith('/admin/futsal/fla/video'),
}, {
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
  // FHL 메뉴는 "무엇을 하러 왔나" 기준 두 묶음 + 중계 오버레이. 묶음 안의 화면은 상단 탭(HighlightSubTabs)이 나눈다.
  {
    href: '/admin/highlight/fineplay',
    label: 'FinePlay 클립',
    icon: '◇',
    description: 'FinePlay 신청을 받아 클립을 만들고 보내는 곳',
    match: (pathname) =>
      pathname.startsWith('/admin/highlight/fineplay') ||
      pathname.startsWith('/admin/highlight/clips') ||
      pathname.startsWith('/admin/highlight/archive'),
    roles: ['SUPERADMIN'],
  },
  {
    href: '/admin/highlight',
    label: '직접 만들기',
    icon: '▶',
    description: 'AI·선수별·수동으로 하이라이트를 직접 만드는 곳',
    match: (pathname) =>
      pathname === '/admin/highlight' ||
      pathname.startsWith('/admin/highlight/player') ||
      pathname.startsWith('/admin/highlight/manual') ||
      pathname.startsWith('/admin/highlight/results') ||
      pathname.startsWith('/admin/highlight/template-editor'),
    roles: ['SUPERADMIN'],
  },
  {
    href: '/admin/highlight/overlay',
    label: '중계 오버레이',
    icon: '▧',
    description: '중계 영상에 기록 그래픽을 얹는 곳',
    match: (pathname) => pathname.startsWith('/admin/highlight/overlay'),
    roles: ['SUPERADMIN'],
  },
  // OPERATOR 는 FinePlay 클립 검수(+클립 귀속 FPA)만 접근한다. fineplay API 는 superuser 전용이다.
  {
    href: '/admin/highlight/clips',
    label: '클립 검수',
    icon: '◇',
    description: 'FinePlay 클립의 구간·대표 액션·FPA를 확인하고 고치는 곳',
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
    label: 'FinePlay 분석',
    icon: '⌁',
    match: (pathname) => pathname.startsWith('/admin/fpa/live'),
  },
  {
    href: '/admin/fpa/reports',
    label: '모델 관리',
    icon: '◌',
    match: (pathname) => pathname.startsWith('/admin/fpa/reports'),
  },
  {
    href: '/admin/fpa/replay',
    label: '씬 모션',
    icon: '◒',
    match: (pathname) => pathname.startsWith('/admin/fpa/replay'),
  },
  {
    href: '/admin/fpa/settings',
    label: '코드 안내',
    icon: '⋯',
    match: (pathname) => pathname.startsWith('/admin/fpa/settings'),
  },
];

const FUTSAL_FPA_ITEMS: NavItem[] = [
  FPA_ITEMS[0],
  {
    href: '/admin/futsal/fpa/tracking',
    label: '영상 분석',
    icon: '⌖',
    match: (pathname) => pathname.startsWith('/admin/futsal/fpa/tracking'),
  },
  ...FPA_ITEMS.slice(1),
];

const FCM_ITEMS: NavItem[] = [
  {
    href: '/admin/fcm/match-status',
    label: '데이터 제출',
    icon: '◎',
    match: (pathname) => pathname.startsWith('/admin/fcm/match-status'),
  },
  {
    href: '/admin/fcm/workspace',
    label: '카드 생성',
    icon: '▣',
    match: (pathname) => pathname.startsWith('/admin/fcm/workspace'),
  },
  {
    href: '/admin/fcm/templates',
    label: '템플릿',
    icon: '◫',
    match: (pathname) => pathname.startsWith('/admin/fcm/templates'),
  },
  {
    href: '/admin/fcm/guide',
    label: '사용 가이드',
    icon: '⋯',
    match: (pathname) => pathname.startsWith('/admin/fcm/guide'),
  },
];

const FUTSAL_FCM_ITEMS: NavItem[] = [
  {
    href: '/admin/fcm/futsal',
    label: 'Queen Cup Cards',
    icon: '▣',
    match: (pathname) => pathname === '/admin/fcm/futsal',
  },
  {
    href: '/admin/fcm/futsal/reports',
    label: '매치 리포트',
    icon: '▤',
    match: (pathname) => pathname.startsWith('/admin/fcm/futsal/reports'),
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
  if (pathname.startsWith('/admin/futsal/fla/video')) return { product: 'FLA', eyebrow: 'Futsal FLA', title: '영상 기록' };
  if (pathname.startsWith('/admin/futsal/fpa/tracking')) {
    return { product: 'FPA', eyebrow: 'Futsal Video Analysis', title: '영상 분석' };
  }
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
    return { product: 'FLA', eyebrow: 'Live Match Admin', title: '영상 송출' };
  }
  if (pathname.startsWith('/admin/live-coder')) {
    return { product: 'FLA', eyebrow: 'FLA Broadcast Overlay', title: '중계 그래픽' };
  }
  if (pathname.startsWith('/admin/highlight')) {
    if (pathname.startsWith('/admin/highlight/overlay')) {
      return { product: 'FHL', eyebrow: 'FinePlay Highlight', title: '중계 오버레이' };
    }
    if (pathname.startsWith('/admin/highlight/player')) {
      return { product: 'FHL', eyebrow: 'FinePlay Highlight', title: '선수 개인 클립' };
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
      return { product: 'FHL', eyebrow: 'FinePlay Highlight', title: '클립 검수·전송' };
    }
    if (pathname.startsWith('/admin/highlight/archive')) {
      return { product: 'FHL', eyebrow: 'FinePlay Highlight', title: '보관함' };
    }
    if (pathname.startsWith('/admin/highlight/fineplay')) {
      return { product: 'FHL', eyebrow: 'FinePlay Highlight', title: '신청·태깅' };
    }
    if (pathname.startsWith('/admin/highlight/template-editor')) {
      return { product: 'FHL', eyebrow: 'FinePlay Highlight', title: '템플릿 에디터' };
    }
    return { product: 'FHL', eyebrow: 'FinePlay Highlight', title: 'AI 하이라이트' };
  }
  if (pathname.startsWith('/admin/system')) {
    return { product: 'SYSTEM', eyebrow: 'Console Settings', title: '시스템' };
  }
  if (pathname.startsWith('/admin/fpa/live')) {
    return { product: 'FPA', eyebrow: 'Football Performance Analysis', title: 'FinePlay 분석' };
  }
  if (pathname.startsWith('/admin/fpa/reports')) {
    return { product: 'FPA', eyebrow: 'Football Performance Analysis', title: '모델 관리' };
  }
  if (pathname.startsWith('/admin/fpa/tracking')) {
    return { product: 'FPA', eyebrow: 'Computer Vision Review', title: 'Player Matching' };
  }
  if (pathname.startsWith('/admin/fpa/replay')) {
    return { product: 'FPA', eyebrow: 'Football Performance Analysis', title: '씬 모션' };
  }
  if (pathname.startsWith('/admin/fpa/settings')) {
    return { product: 'FPA', eyebrow: 'Football Performance Analysis', title: '코드 안내' };
  }
  if (pathname.startsWith('/admin/fpa')) {
    return { product: 'FPA', eyebrow: 'Football Performance Analysis', title: 'FPA' };
  }
  if (pathname.startsWith('/admin/fcm/futsal/reports')) {
    return { product: 'FCM', eyebrow: 'FinePlay Card Marker', title: 'Match Report' };
  }
  if (pathname.startsWith('/admin/fcm/match-status')) {
    return { product: 'FCM', eyebrow: 'FinePlay Card Marker', title: '데이터 제출' };
  }
  if (pathname.startsWith('/admin/fcm/workspace')) {
    return { product: 'FCM', eyebrow: 'FinePlay Card Marker', title: '카드 생성' };
  }
  if (pathname.startsWith('/admin/fcm/templates')) {
    return { product: 'FCM', eyebrow: 'FinePlay Card Marker', title: '템플릿' };
  }
  if (pathname.startsWith('/admin/data-hub')) {
    return { product: 'DATA', eyebrow: 'Shared Match Data', title: 'Data Hub' };
  }
  if (pathname.startsWith('/admin/fcm/guide')) {
    return { product: 'FCM', eyebrow: 'FinePlay Card Marker', title: '사용 가이드' };
  }
  if (pathname.startsWith('/admin/fcm')) {
    return { product: 'FCM', eyebrow: 'FinePlay Card Marker', title: 'FCM' };
  }
  return { product: 'FLA', eyebrow: 'Live Match Admin', title: '운영 현황' };
}

function AdminShellContent({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { sport, setSport } = useSportContext();
  const [user, setUser] = useState<SessionUser | null>(null);
  const [checkingSession,setCheckingSession]=useState(true);
  const ownerRef=useRef<string|null>(null);
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
      items = section.id === 'FLA' ? FUTSAL_FLA_ITEMS : section.id === 'FPA' ? FUTSAL_FPA_ITEMS : section.id === 'FCM' ? FUTSAL_FCM_ITEMS : [];
    } else if (section.id === 'FLA' && user?.role !== 'SUPERADMIN') {
      items = section.items.filter((item) => item.href === '/admin/dashboard');
    } else if (section.id === 'FHL') {
      items = section.items.filter((item) => !item.roles || (user?.role && item.roles.includes(user.role)));
    }
    return { ...section, items };
  }).filter((section) => section.items.length > 0);

  useEffect(() => {
    let active = true;
    let ticket=0;
    const verify=async()=>{
      const current=++ticket;
      // Keep a verified workspace visible during focus/minute revalidation.
      // Initial load and account-change handlers already gate unverified content.
      try{const data=await fetchSessionUser();if(active&&current===ticket){ownerRef.current=data.id;setUser(data);setCheckingSession(false);}}
      catch{if(active&&current===ticket){ownerRef.current=null;setUser(null);router.replace(`/login?next=${encodeURIComponent(currentPath)}`);}}
    };
    const changed=(event:Event)=>{const id=(event as CustomEvent).detail?.id;if(id!==ownerRef.current){setCheckingSession(true);setUser(null);void verify();}};
    const channel=typeof BroadcastChannel!=='undefined'?new BroadcastChannel('fpc-session'):null;
    if(channel)channel.onmessage=event=>{if(event.data?.id!==ownerRef.current){setCheckingSession(true);setUser(null);void verify();}};
    const focus=()=>{if(!document.hidden)void verify();};
    window.addEventListener('focus',focus);window.addEventListener('fpc-session-changed',changed);
    const timer=setInterval(focus,60000);void verify();
    return () => {active=false;ticket++;clearInterval(timer);channel?.close();window.removeEventListener('focus',focus);window.removeEventListener('fpc-session-changed',changed);};
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
    if(!await allowWorkspaceLeave())return;
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

  const changeSport = async (nextSport: Sport) => {
    if(nextSport===sport||!await allowWorkspaceLeave())return;
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
                  <div className="sidebar-section" data-product={section.id} key={section.id}>
                    <button
                      className={`product-badge product-toggle ${pageMeta.product === section.id ? 'active' : ''}`}
                      onClick={() => setExpandedProduct((current) => current === section.id ? null : section.id)}
                      aria-expanded={expandedProduct === section.id}
                      aria-controls={`nav-${section.id}`}
                    >
                      <span className="product-label"><span className="product-monogram">{section.label}</span><span>{({ FLA: '라이브 기록', FHL: '하이라이트 제작', FPA: 'FinePlay 분석', FCM: '카드 제작' })[section.id]}</span></span>
                      <span className={`product-toggle-icon ${expandedProduct === section.id ? 'open' : ''}`}>⌄</span>
                    </button>
                    {expandedProduct === section.id ? (
                      <div className="product-nav" id={`nav-${section.id}`}>
                        {section.items.map((item) => (
                          <Link
                            className={item.match(currentPath) ? 'active' : ''}
                            href={item.href}
                            aria-current={item.match(currentPath) ? 'page' : undefined}
                            title={item.description}
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
                  data-product="DATA"
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
                    <ConsoleIcon name="System" /> 시스템
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

        <div className="app-content" style={checkingSession?{visibility:'hidden',pointerEvents:'none'}:undefined} aria-hidden={checkingSession}>{user?<Fragment key={user.id}>{children}</Fragment>:null}</div>

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
