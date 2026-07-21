'use client';

// 수동 하이라이트 파이프라인용 진행 바 + "다른 일 해도 되나" 배지.
// 수동 태깅 페이지와 수동 결과물 페이지가 공유한다.

export function ProgressBar({
  percent,
  indeterminate,
  color = 'var(--accent, #3b82f6)',
}: {
  percent?: number;
  indeterminate?: boolean;
  color?: string;
}) {
  const track: React.CSSProperties = {
    height: 6,
    width: '100%',
    borderRadius: 999,
    background: 'var(--surface-input, #16161a)',
    overflow: 'hidden',
  };
  const fill: React.CSSProperties = indeterminate
    ? {
        height: '100%',
        width: '35%',
        borderRadius: 999,
        background: color,
        animation: 'hlIndeterminate 1.1s ease-in-out infinite',
      }
    : {
        height: '100%',
        width: `${Math.max(0, Math.min(100, percent ?? 0))}%`,
        borderRadius: 999,
        background: color,
        transition: 'width 0.3s ease',
      };
  return (
    <div style={track}>
      <div style={fill} />
    </div>
  );
}

// canLeave=true  → 서버가 처리 중이라 탭 닫고 다른 일 해도 됨(강조: 초록)
// canLeave=false → 브라우저에서 도는 단계라 탭 유지 필수(강조: 빨강)
export function LeaveBadge({ canLeave }: { canLeave: boolean }) {
  return (
    <span
      style={{
        fontSize: 12,
        fontWeight: 700,
        whiteSpace: 'nowrap',
        padding: '2px 9px',
        borderRadius: 999,
        background: canLeave ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
        color: canLeave ? '#22c55e' : '#ef4444',
        border: `1px solid ${canLeave ? 'rgba(34,197,94,0.45)' : 'rgba(239,68,68,0.45)'}`,
      }}
    >
      {canLeave ? '✅ 다른 일 해도 됨 · 탭 닫아도 OK' : '⛔ 이 탭 유지 · 닫지 마세요'}
    </span>
  );
}
