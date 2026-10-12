'use client';

import { useEffect, useRef, useState } from 'react';
import { isPendingShot, matchControlJson, type PendingShot } from './match-control';

export function usePendingShots(matchId: string, userId: string, canWrite: boolean, onSaved: () => void) {
  const scope = userId ? `fpc.pending-shot.v1:${userId}:${matchId}:` : '';
  const current = useRef({ scope, canWrite, onSaved });
  current.current = { scope, canWrite, onSaved };
  const items = useRef<{ scope: string; rows: PendingShot[] }>({ scope: '', rows: [] });
  const active = useRef(new Set<string>());
  const [pending, setPending] = useState<PendingShot[]>([]);
  const [busy, setBusy] = useState<string[]>([]);
  const [notice, setNotice] = useState('');
  const [storageError, setStorageError] = useState(false);

  useEffect(() => {
    current.current.scope = scope;
    const restore = () => {
      const rows = new Map<string, PendingShot>();
      if (items.current.scope === scope) for (const item of items.current.rows) rows.set(item.event_id, item);
      try {
        if (scope) for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (!key?.startsWith(scope)) continue;
          const item = JSON.parse(localStorage.getItem(key) || 'null');
          if (isPendingShot(item)) rows.set(item.event_id, item);
        }
      } catch { setStorageError(true); }
      items.current = { scope, rows: [...rows.values()] };
      setPending(items.current.rows);
    };
    setNotice(''); setBusy([]); setStorageError(false);
    restore();
    return () => { current.current.scope = ''; };
  }, [scope]);

  const send = async (item: PendingShot, requestScope = scope) => {
    if (!requestScope || current.current.scope !== requestScope || !current.current.canWrite || active.current.has(item.event_id)) return;
    active.current.add(item.event_id);
    setBusy([...active.current]);
    try {
      const response = await matchControlJson(`/matches/${matchId}/events/xg`, { method: 'POST', body: JSON.stringify(item) });
      if (!response.ok || (response.event_id && response.event_id !== item.event_id)) throw new Error('Unconfirmed shot');
      // Clear only this acknowledged snapshot, never the form for the next shot.
      try { localStorage.removeItem(requestScope + item.event_id); } catch {}
      if (current.current.scope !== requestScope) return;
      items.current.rows = items.current.rows.filter(row => row.event_id !== item.event_id);
      setPending([...items.current.rows]);
      setNotice('슈팅을 기록했습니다. 기록 탭에서 확인할 수 있습니다.');
      current.current.onSaved();
    } catch {
      if (current.current.scope === requestScope) setNotice('슈팅 저장 확인이 지연됩니다. 아래 보관된 기록을 재시도하면 최초 시각으로 중복 없이 확인합니다.');
    } finally {
      active.current.delete(item.event_id);
      if (current.current.scope === requestScope) setBusy([...active.current]);
    }
  };

  const enqueue = (item: PendingShot): Promise<void> | null => {
    if (!scope || !canWrite || items.current.scope !== scope) return null;
    // Separate keys prevent two tabs from overwriting each other's pending list.
    try { localStorage.setItem(scope + item.event_id, JSON.stringify(item)); }
    catch { setStorageError(true); }
    items.current.rows = [...items.current.rows, item];
    setPending([...items.current.rows]);
    return send(item);
  };

  return { pending, busy, notice, storageError, enqueue, retry: send };
}
