'use client';

import { useEffect, useRef, useState } from 'react';
import { apiJson } from './api';

type Highlight = { id: string; clock_ms: number };
type Pending = { request_id: string; clock_ms: number };
const validPending = (value: unknown): value is Pending => {
  const row = value as Pending | null;
  return !!row && typeof row.request_id === 'string'
    && /^[0-9a-f-]{36}$/i.test(row.request_id) && Number.isSafeInteger(row.clock_ms) && row.clock_ms >= 0;
};

export function useMatchHighlights(matchId: string, userId: string, canWrite: boolean, clock: () => number) {
  const scope = userId ? `fpc.highlight-pending.v1:${userId}:${matchId}` : '';
  const current = useRef(scope);
  current.current = scope;
  const queue = useRef<{ scope: string; items: Pending[] }>({ scope: '', items: [] });
  const active = useRef(new Set<string>());
  const requestVersion = useRef(0);
  const [highlights, setHighlights] = useState<Highlight[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [busy, setBusy] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  const [storageError, setStorageError] = useState(false);

  useEffect(() => {
    setHighlights([]); setNotice(''); setBusy([]); setStorageError(false);
    let items: Pending[] = [];
    if (scope) {
      try {
        const value = JSON.parse(sessionStorage.getItem(scope) || '[]');
        if (!Array.isArray(value) || !value.every(validPending)) throw new Error('Invalid pending highlights');
        items = value;
      } catch { setStorageError(true); }
    }
    queue.current = { scope, items };
    setPending(items);
    const version = ++requestVersion.current;
    if (scope) void apiJson<{ highlights: Highlight[] }>(`/matches/${matchId}/highlights`).then((result) => {
      if (current.current === scope && requestVersion.current === version) setHighlights(result.highlights || []);
    }).catch(() => {
      if (current.current === scope && requestVersion.current === version) setNotice('하이라이트 목록을 불러오지 못했습니다.');
    });
    return () => { requestVersion.current++; };
  }, [scope, matchId]);

  const updatePending = (operation: (items: Pending[]) => Pending[]) => {
    // An old match's response can finish its own saved request, never update a
    // newly selected match/account. sessionStorage also isolates browser tabs.
    const visible = current.current === scope && queue.current.scope === scope;
    let items = visible ? queue.current.items : [];
    if (!visible) {
      try { items = JSON.parse(sessionStorage.getItem(scope) || '[]'); } catch { return; }
      if (!Array.isArray(items) || !items.every(validPending)) return;
    }
    const next = operation(items);
    if (visible) { queue.current = { scope, items: next }; setPending(next); }
    try {
      if (next.length) sessionStorage.setItem(scope, JSON.stringify(next));
      else sessionStorage.removeItem(scope);
      if (visible) setStorageError(false);
    } catch { if (visible) setStorageError(true); }
  };

  const send = async (item: Pending) => {
    if (!canWrite || !scope || active.current.has(item.request_id)) return;
    active.current.add(item.request_id);
    setBusy([...active.current]);
    try {
      const response = await apiJson<{ ok: boolean; highlight: Highlight }>(`/matches/${matchId}/highlights`, {
        method: 'POST', body: JSON.stringify(item),
      });
      if (!response.ok || response.highlight?.id !== item.request_id || response.highlight.clock_ms !== item.clock_ms) {
        throw new Error('Unconfirmed highlight response');
      }
      updatePending((items) => items.filter((row) => row.request_id !== item.request_id));
      if (current.current === scope) {
        requestVersion.current++;
        setHighlights((rows) => [...rows.filter((row) => row.id !== item.request_id), response.highlight].sort((a, b) => a.clock_ms - b.clock_ms));
        setNotice('하이라이트를 서버에 저장했습니다.');
      }
    } catch {
      if (current.current === scope) setNotice('저장을 확인하지 못했습니다. 아래 원래 시각으로 다시 요청할 수 있습니다.');
    } finally {
      active.current.delete(item.request_id);
      if (current.current === scope) setBusy([...active.current]);
    }
  };

  const markHighlight = async () => {
    if (!canWrite || !scope || queue.current.scope !== scope) return;
    const item = { request_id: crypto.randomUUID(), clock_ms: Math.max(0, Math.round(clock())) };
    updatePending((items) => [...items, item]);
    await send(item);
  };

  const removeHighlight = async (highlightId: string) => {
    if (!canWrite) return;
    try {
      const result = await apiJson<{ ok: boolean }>(`/matches/${matchId}/highlights/${highlightId}`, { method: 'DELETE' });
      if (!result.ok) throw new Error('Unconfirmed deletion');
      if (current.current === scope) {
        requestVersion.current++;
        setHighlights((rows) => rows.filter((row) => row.id !== highlightId));
        setNotice('하이라이트를 삭제했습니다.');
      }
    } catch {
      if (current.current === scope) setNotice('삭제를 확인하지 못했습니다. 목록을 다시 확인하세요.');
    }
  };

  useEffect(() => {
    if (!storageError || !pending.length) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [storageError, pending.length]);

  const exportPending = () => {
    const blob = new Blob([JSON.stringify({ format: 'fpc-pending-highlights', matchId, userId, pending }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a'); link.href = url; link.download = `highlights-pending-${matchId}.json`; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return { highlights, pending, busy, hlNotice: notice, storageError, markHighlight, removeHighlight, retryHighlight: send, exportPending };
}
