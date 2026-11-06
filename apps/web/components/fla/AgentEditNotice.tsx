'use client';

import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '../../lib/api';

/**
 * 매치 컨트롤 알림 한 줄 — 직원 에이전트가 이 경기 기록을 고치거나 되돌리면 "OOO님이 기록을 고쳤습니다(무엇·몇 분)".
 *
 * 서버 `GET /matches/{id}/agent-edits` 를 5초마다 본다. 새 알림이 오면 onChange 로 화면이 기록을 다시 받게 한다
 * (고친 내용이 운영자 화면에도 바로 보이도록). 열 때는 최근 10분 것만 보여 준다.
 */
type AgentEdit = { id: string; kind: 'applied' | 'reverted'; message: string; at: string };

const POLL_MS = 5000;
const SHOW_RECENT_MS = 10 * 60 * 1000;

export default function AgentEditNotice({ matchId, onChange }: { matchId: string; onChange?: () => void }) {
  const [latest, setLatest] = useState<AgentEdit | null>(null);
  const [count, setCount] = useState(0);
  const seen = useRef<Set<string>>(new Set());
  const first = useRef(true);
  const changed = useRef(onChange);
  changed.current = onChange;

  useEffect(() => {
    seen.current = new Set();
    first.current = true;
    setLatest(null);
    setCount(0);
    let stopped = false;
    const poll = async () => {
      try {
        const response = await apiFetch(`/matches/${matchId}/agent-edits`);
        if (!response.ok || stopped) return;
        const data = await response.json();
        const items: AgentEdit[] = Array.isArray(data?.items) ? data.items : [];
        const now = Date.parse(data?.server_now || '') || Date.now();
        const fresh = items.filter((item) => !seen.current.has(item.id));
        fresh.forEach((item) => seen.current.add(item.id));
        const visible = first.current ? fresh.filter((item) => now - Date.parse(item.at) <= SHOW_RECENT_MS) : fresh;
        if (visible.length) {
          setLatest(visible[0]);
          setCount((value) => value + visible.length);
          if (!first.current) changed.current?.();
        }
        first.current = false;
      } catch {}
    };
    void poll();
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void poll(); }, POLL_MS);
    return () => { stopped = true; clearInterval(timer); };
  }, [matchId]);

  if (!latest) return null;
  const time = new Date(latest.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
  return <div className="fla-feedback agent-edit-notice" role="status" aria-live="polite">
    <span>{latest.message} · {time}{count > 1 ? ` (외 ${count - 1}건)` : ''}</span>
    <button aria-label="알림 닫기" onClick={() => { setLatest(null); setCount(0); }}>×</button>
  </div>;
}
