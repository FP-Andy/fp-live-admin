import Link from 'next/link';
import type { ReactNode } from 'react';

export function ConsoleToolbar({ children }: { children: ReactNode }) {
  return <div className="console-toolbar">{children}</div>;
}

export function ConsoleEmpty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="console-empty" role="status"><strong>{title}</strong>{children ? <div>{children}</div> : null}</div>;
}

export function ConsoleSectionNav({ items }: { items: { id: string; label: string }[] }) {
  return <nav className="console-section-nav" aria-label="페이지 목차">{items.map(item => <a key={item.id} href={`#${item.id}`}>{item.label}</a>)}</nav>;
}

export function FcmWorkflow({ current }: { current: 'match-status' | 'templates' | 'workspace' | 'guide' }) {
  // 순서가 있는 단계는 데이터 제출 → 카드 생성 둘뿐이다. 템플릿은 미리 등록해 두는 설정이라
  // 사용 가이드처럼 번호 없이 오른쪽에 둔다(2026-11-04 승준).
  const steps = [{ id: 'match-status', label: '경기 · 데이터 제출' }, { id: 'workspace', label: '카드 생성' }];
  const extras = [{ id: 'templates', label: '템플릿 확인' }, { id: 'guide', label: '사용 가이드' }];
  return <nav className="console-workflow" aria-label="카드 제작 단계">
    {steps.map((step, index) => <Link key={step.id} href={`/admin/fcm/${step.id}`} aria-current={current === step.id ? 'page' : undefined}><span>{index + 1}</span>{step.label}</Link>)}
    {extras.map((item) => <Link key={item.id} href={`/admin/fcm/${item.id}`} aria-current={current === item.id ? 'page' : undefined}>{item.label}</Link>)}
  </nav>;
}
