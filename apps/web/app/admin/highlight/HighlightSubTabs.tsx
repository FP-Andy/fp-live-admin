'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { apiJson, type SessionUser } from '../../../lib/api';

type SubTab = { href: string; label: string; roles?: SessionUser['role'][] };

const SUB_TABS: SubTab[] = [
  { href: '/admin/highlight', label: 'AI Highlight', roles: ['SUPERADMIN'] },
  { href: '/admin/highlight/player', label: 'Player Clips', roles: ['SUPERADMIN'] },
  // 수동 태깅·수동 결과물은 FinePlay 클립 파이프라인으로 대체 — 탭에서 제거 (페이지는 살아있음).
  { href: '/admin/highlight/fineplay', label: 'FinePlay 작업', roles: ['SUPERADMIN'] },
  { href: '/admin/highlight/overlay', label: '중계 오버레이', roles: ['SUPERADMIN'] },
  { href: '/admin/highlight/clips', label: '클립 결과' },
  { href: '/admin/highlight/archive', label: '아카이브', roles: ['SUPERADMIN'] },
  { href: '/admin/highlight/editroom', label: '편집룸', roles: ['SUPERADMIN'] },
];

export default function HighlightSubTabs() {
  const pathname = usePathname() || '';
  // 세션 로드 전에는 역할 제한 없는 탭만 보여서 OPERATOR 에게 관리자 탭이 깜빡이지 않게 한다.
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
  const tabs = SUB_TABS.filter((tab) => !tab.roles || (role && tab.roles.includes(role)));
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        marginBottom: 16,
        borderBottom: '1px solid var(--border-ghost)',
        paddingBottom: 8,
      }}
    >
      {tabs.map((tab) => {
        const active = tab.href === '/admin/highlight'
          ? pathname === '/admin/highlight'
          : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
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
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
