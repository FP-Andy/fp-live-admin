'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const SUB_TABS = [
  { href: '/admin/highlight', label: 'AI Highlight' },
  { href: '/admin/highlight/player', label: 'Player Clips' },
  { href: '/admin/highlight/manual', label: '수동 태깅' },
  { href: '/admin/highlight/results', label: '수동 결과물' },
  { href: '/admin/highlight/fineplay', label: 'FinePlay 작업' },
  { href: '/admin/highlight/clips', label: '클립 결과' },
  { href: '/admin/highlight/editroom', label: '편집룸' },
];

export default function HighlightSubTabs() {
  const pathname = usePathname() || '';
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
      {SUB_TABS.map((tab) => {
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
