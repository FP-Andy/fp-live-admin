'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { apiJson, type SessionUser } from '../../../lib/api';
import { useSportContext } from '../../../components/SportContext';

type SubTab = {
  href: string;
  label: string;
  /** 한 줄 설명 — 탭 아래 작은 흐린 글씨로 지금 화면이 무엇을 하는지 알려 준다. */
  desc: string;
  /** FinePlay 클립 묶음의 단계 번호(1→2→3). 없으면 번호 없이 이름만. */
  step?: number;
  roles?: SessionUser['role'][];
};

// 사이드바(AdminShell 의 FHL_ITEMS)와 같은 묶음이어야 한다 — 지금 경로가 속한 묶음의 화면만 탭으로 보인다.
// FinePlay 클립: 신청을 받아 태깅 → 검수·전송 → 보관하는 한 흐름이라 단계 번호를 붙인다.
const FINEPLAY_TABS: SubTab[] = [
  {
    href: '/admin/highlight/fineplay', label: '신청·태깅', step: 1, roles: ['SUPERADMIN'],
    desc: 'FinePlay 신청을 가져와 태깅하고 클립을 만듭니다. 다 만들면 2단계에서 검수·전송합니다.',
  },
  {
    href: '/admin/highlight/clips', label: '클립 검수·전송', step: 2, roles: ['SUPERADMIN'],
    desc: '클립 구간·대표 액션·FPA를 고치고 FinePlay로 보냅니다. 끝나면 보관함으로 옮깁니다.',
  },
  {
    href: '/admin/highlight/archive', label: '보관함', step: 3, roles: ['SUPERADMIN'],
    desc: "끝난 경기입니다. '열어서 수정'으로 다시 고칠 수 있습니다.",
  },
  // OPERATOR 는 클립 검수 한 화면만 연다(fineplay API 는 superuser 전용).
  {
    href: '/admin/highlight/clips', label: '클립 검수', roles: ['OPERATOR'],
    desc: '클립 구간·대표 액션·FPA를 확인하고 고칩니다.',
  },
];

// 직접 만들기: AI·선수별·수동으로 하이라이트를 만드는 화면들. 템플릿 에디터는 수동 태깅에서만 쓰므로 여기 둔다.
// 수동 태깅·수동 결과물은 클립을 하나로 합쳐 로컬에 내려받는 유일한 창구다("수동 결과물"의 합본 다운로드).
const MAKE_TABS: SubTab[] = [
  {
    href: '/admin/highlight', label: 'AI 하이라이트', roles: ['SUPERADMIN'],
    desc: '영상과 로그를 올리면 AI가 장면을 골라 줍니다.',
  },
  {
    href: '/admin/highlight/player', label: '선수 개인 클립', roles: ['SUPERADMIN'],
    desc: '한 선수의 공 터치만 골라 개인 클립을 만듭니다.',
  },
  {
    href: '/admin/highlight/manual', label: '수동 태깅', roles: ['SUPERADMIN'],
    desc: '영상을 보며 장면을 직접 찍어 하이라이트를 만듭니다.',
  },
  {
    href: '/admin/highlight/results', label: '수동 결과물', roles: ['SUPERADMIN'],
    desc: '수동 태깅 결과를 확인하고 합본을 내려받습니다.',
  },
  {
    href: '/admin/highlight/template-editor', label: '템플릿 에디터', roles: ['SUPERADMIN'],
    desc: '수동 태깅에서 쓰는 카드·점수판 템플릿을 만듭니다.',
  },
];

// 농구에서 여는 두 화면. 사이드바(AdminShell 의 BASKETBALL_FHL_ITEMS)와 같은 목록이어야
// 한다 — 메뉴에는 없는 탭이 상단에 뜨면 축구 전용 화면으로 새어 들어간다.
const BASKETBALL_SUB_TABS = new Set(['/admin/highlight/manual', '/admin/highlight/results']);

function isActive(href: string, pathname: string) {
  return href === '/admin/highlight' ? pathname === '/admin/highlight' : pathname.startsWith(href);
}

function groupTabs(pathname: string): SubTab[] {
  if (FINEPLAY_TABS.some((tab) => isActive(tab.href, pathname))) return FINEPLAY_TABS;
  if (MAKE_TABS.some((tab) => isActive(tab.href, pathname))) return MAKE_TABS;
  // 중계 오버레이 등 묶음 밖 화면은 탭이 없다.
  return [];
}

export default function HighlightSubTabs({ backToResults = false }: {
  /** clips 화면이 수동 결과물에서 넘어왔을 때(?jobId= 또는 수동 출처 매치) 되돌아가는 길을 보인다. */
  backToResults?: boolean;
} = {}) {
  const { sport } = useSportContext();
  const pathname = usePathname() || '';
  // 세션 로드 전에는 탭을 그리지 않아 OPERATOR 에게 관리자 탭이 깜빡이지 않게 한다.
  const [role, setRole] = useState<SessionUser['role'] | null>(null);
  useEffect(() => {
    let active = true;
    apiJson<SessionUser>('/session/me')
      .then((data) => {
        if (active) setRole(data.role);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  const tabs = (sport === 'BASKETBALL'
    ? MAKE_TABS.filter((tab) => BASKETBALL_SUB_TABS.has(tab.href))
    : groupTabs(pathname))
    .filter((tab) => !tab.roles || (role && tab.roles.includes(role)));
  const current = tabs.find((tab) => isActive(tab.href, pathname));
  if (!tabs.length && !backToResults) return null;
  // 하나뿐이면(OPERATOR 의 클립 검수) 탭 줄은 숨기고 설명만 남긴다.
  const showTabs = tabs.length > 1;
  return (
    <div className="fhl-subnav">
      {showTabs || backToResults ? (
        <div className="fhl-subnav-row">
          {showTabs ? (
            <div
              className="fhl-subtabs"
              style={{
                display: 'flex',
                gap: 8,
                marginBottom: 16,
                borderBottom: '1px solid var(--border-ghost)',
                paddingBottom: 8,
              }}
            >
              {tabs.map((tab) => {
                const active = isActive(tab.href, pathname);
                return (
                  <Link
                    key={`${tab.href}:${tab.label}`}
                    href={tab.href}
                    aria-current={active ? 'page' : undefined}
                    style={{
                      padding: '6px 14px',
                      borderRadius: 'var(--radius-card)',
                      fontSize: 13,
                      fontWeight: 600,
                      textDecoration: 'none',
                      color: active ? 'var(--text, #eee)' : 'var(--muted, #999)',
                      background: active ? 'var(--surface-card)' : 'transparent',
                      border: active ? '1px solid var(--border-ghost)' : '1px solid transparent',
                    }}
                  >
                    {tab.step ? <span className="fhl-subtab-step">{tab.step}</span> : null}
                    {tab.label}
                  </Link>
                );
              })}
            </div>
          ) : null}
          {backToResults ? (
            <Link className="fhl-subnav-back" href="/admin/highlight/results">← 수동 결과물</Link>
          ) : null}
        </div>
      ) : null}
      {current ? <p className="fhl-subnav-desc">{current.desc}</p> : null}
    </div>
  );
}
