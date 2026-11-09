'use client';

import { useEffect, useRef, useState } from 'react';
import { apiFetch } from './api';
import { isPendingShot } from './match-control';

/**
 * FLA 매치 컨트롤 입력 보관함(outbox) — "누른 순간 입력 완료" (2026-11-02 승준 확정 원칙).
 *
 * 종전에는 점유 버튼이 서버 응답을 기다린 뒤 화면을 바꿨고, 공격 기록은 앞 요청이 끝날 때까지
 * 다음 클릭을 버렸고, 슈팅은 최대 12초 잠겼다. 경기 4개가 한 서버를 같이 쓰는 날엔 그 지연이
 * 그대로 "버튼이 안 먹는다"로 보였다. 이제 입력은 화면과 이 보관함에서 끝나고, 서버 저장은 뒤에서 따라간다.
 *
 * - 누르는 즉시 localStorage 에 한 건씩 남긴다. 새로고침·탭 닫힘 뒤에도 남아 다시 열면 이어서 보낸다.
 * - 보내는 줄은 하나, 누른 순서 그대로다. 서버는 시계·점유 명령을 직전 상태와 비교해 점유 구간을
 *   끊으므로 순서가 바뀌면 점유율이 틀어진다.
 * - id(state_id·event_id)는 누를 때 정하고 다시 보낼 때도 바꾸지 않는다. 서버가 같은 id 를 한 번만
 *   저장하므로 응답을 못 받아 다시 보내도 중복 행이 생기지 않는다.
 * - 시각(clock_ms)도 누를 때 값이다. 늦게 도착해도 서버에는 누른 시각으로 남는다.
 */

export type FlaOutboxKind = 'state' | 'lane' | 'shot' | 'marker';
export type FlaOutboxItem = {
  v: 1;
  id: string;
  /** 누른 순서. 같은 밀리초에 두 번 눌러도 순서가 섞이지 않게 마지막 값보다 항상 크게 잡는다. */
  seq: number;
  kind: FlaOutboxKind;
  pressed_at: number;
  clock_ms: number;
  body: Record<string, any>;
  /** 다시 보내도 서버가 받지 않는 입력(검증 실패·보관 경기 등). 지우지 않고 남겨 운영자에게 보인다. */
  failed?: string;
};

const PREFIX = 'fpc.fla-outbox.v1:';
const LEGACY_SHOT_PREFIX = 'fpc.pending-shot.v1:';
const REQUEST_TIMEOUT_MS = 12000;
const SAMPLE_TIMEOUT_MS = 8000;
const MAX_BACKOFF_MS = 10000;
const BLOCKED_WARNING_MS = 60000;
const UUID = /^[0-9a-f-]{36}$/i;

export function makeClientId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // 사내망 HTTP(비보안 컨텍스트)에서는 randomUUID 가 없다.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function isOutboxItem(value: unknown): value is FlaOutboxItem {
  const item = value as FlaOutboxItem | null;
  return !!item && item.v === 1 && typeof item.id === 'string' && UUID.test(item.id)
    && Number.isFinite(item.seq) && ['state', 'lane', 'shot', 'marker'].includes(item.kind)
    && Number.isSafeInteger(item.clock_ms) && item.clock_ms >= 0 && !!item.body && typeof item.body === 'object';
}

/** 대시보드에서 경기를 보관하기 전에 이 브라우저에 안 보낸 입력이 남았는지 본다(사용자 무관). */
export function countStoredFlaInputs(matchId: string) {
  let count = 0;
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && (key.startsWith(PREFIX) || key.startsWith(LEGACY_SHOT_PREFIX)) && key.includes(`:${matchId}:`)) count++;
    }
  } catch {}
  return count;
}

type Reply = { status: number; data: any; text: string };
type Outcome = { kind: 'done' | 'stale' | 'retry' | 'fatal'; reason?: string; revision?: number };

/** 응답 본문까지 제한시간 안에 읽는다. 시간 초과는 "실패"가 아니라 "모름"이다 — 같은 id 로 다시 보낸다. */
async function postJson(path: string, body: unknown, timeoutMs: number): Promise<Reply> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await apiFetch(path, { method: 'POST', body: JSON.stringify(body), signal: controller.signal });
    const text = await response.text();
    let data: any = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    return { status: response.status, data, text };
  } finally {
    clearTimeout(timer);
  }
}

function classify(item: FlaOutboxItem, reply: Reply): Outcome {
  const { status, data } = reply;
  const detail = data?.detail;
  const message = typeof detail === 'string' ? detail : reply.text;
  if (status >= 200 && status < 300) {
    if (typeof data?.command_revision === 'number') return { kind: 'done', revision: data.command_revision };
    // 슈팅·공격 기록은 서버가 돌려준 id 가 보낸 id 와 같아야 저장 확인이다.
    if ((item.kind === 'shot' || item.kind === 'lane') && data?.event_id && data.event_id !== item.id) return { kind: 'retry' };
    return { kind: 'done' };
  }
  if (status === 409) {
    // 다른 탭·기기가 먼저 시계·점유를 바꿨다. 이 명령은 저장되지 않았으니 최신 번호로 다시 보낸다.
    if (item.kind === 'state' && detail && typeof detail === 'object' && detail.reason === 'stale_command_revision') {
      return { kind: 'stale', revision: Number(detail.command_revision) };
    }
    // 같은 id 가 이미 서버에 있다 = 응답을 못 받은 앞선 시도가 저장됐다. id 는 누를 때 만든 무작위 값이라 남의 것일 수 없다.
    if (/different content|different match or payload/i.test(message)) return { kind: 'done' };
    return { kind: 'fatal', reason: message || '409' };
  }
  // 로그인 만료(401)는 apiFetch 가 로그인 화면으로 보낸다. 다시 들어오면 보관함에서 이어서 보낸다.
  if (status === 401 || status === 408 || status === 429 || status >= 500) return { kind: 'retry' };
  // 운영권이 다른 사람에게 있다 — 되찾으면 이어서 보낸다. 1분 넘게 막히면 화면에 경고가 뜬다.
  if (status === 403 && /lock/i.test(message)) return { kind: 'retry' };
  return { kind: 'fatal', reason: `${status} ${message}`.trim() };
}

type OutboxEvents = {
  /** 서버가 저장을 확인한 입력. 다음 폴링이 그 기록을 가져올 때까지 화면 목록에 이어 붙이는 데 쓴다. */
  onDelivered?: (item: FlaOutboxItem) => void;
  /** 보낼 것이 다 빠졌다. */
  onIdle?: () => void;
  /** 3초 시계 저장(sample) 응답에서 다른 탭·기기가 올린 명령 번호를 봤다. */
  onServerState?: (state: any, revision: number) => void;
};

export function useFlaOutbox(matchId: string, userId: string, canWrite: boolean, events: OutboxEvents) {
  const scope = userId ? `${PREFIX}${userId}:${matchId}:` : '';
  const live = useRef({ scope, canWrite, events });
  live.current = { scope, canWrite, events };
  const queue = useRef<FlaOutboxItem[]>([]);
  // 불러온 보관함의 범위. 사용자·경기가 바뀌면 이전 범위의 입력을 엉뚱한 곳에 보내지 않는다.
  const loaded = useRef('');
  const lastSeq = useRef(0);
  const revision = useRef<number | null>(null);
  const sending = useRef(false);
  const inFlight = useRef<string | null>(null);
  const wake = useRef<(() => void) | null>(null);
  const lastProgress = useRef(Date.now());
  const [items, setItems] = useState<FlaOutboxItem[]>([]);
  const [isLoaded, setIsLoaded] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [storageError, setStorageError] = useState(false);

  const waiting = () => queue.current.filter((item) => !item.failed);
  const refreshBlocked = () => setBlocked(waiting().length > 0 && Date.now() - lastProgress.current > BLOCKED_WARNING_MS);
  const publish = () => { setItems([...queue.current]); refreshBlocked(); };
  const persist = (item: FlaOutboxItem) => {
    try { localStorage.setItem(loaded.current + item.id, JSON.stringify(item)); }
    catch { setStorageError(true); }
  };
  const forget = (id: string) => {
    queue.current = queue.current.filter((item) => item.id !== id);
    try { localStorage.removeItem(loaded.current + id); } catch {}
  };

  const pathFor = (item: FlaOutboxItem) => ({
    state: `/matches/${matchId}/state`,
    lane: `/matches/${matchId}/events/attack_lane`,
    shot: `/matches/${matchId}/events/xg`,
    marker: `/matches/${matchId}/markers`,
  })[item.kind];
  // 명령 번호는 보낼 때 붙인다. 보관한 내용(누른 순간의 시계·점유)은 그대로 두고 번호만 최신으로 맞춘다.
  const bodyFor = (item: FlaOutboxItem) => item.kind === 'state'
    ? { ...item.body, state_id: item.id, update_kind: 'command', command_revision: revision.current ?? 0 }
    : item.kind === 'marker' ? item.body : { ...item.body, event_id: item.id };

  const sleep = (ms: number) => new Promise<void>((resolve) => {
    const done = () => { clearTimeout(timer); if (wake.current === done) wake.current = null; resolve(); };
    const timer = setTimeout(done, ms);
    wake.current = done;
  });

  const pump = async () => {
    if (sending.current) return;
    sending.current = true;
    let delay = 0;
    let staleRun = 0;
    try {
      for (;;) {
        const { scope: active, canWrite: writable } = live.current;
        if (!active || loaded.current !== active || !writable) break;
        const item = waiting()[0];
        if (!item) break;
        inFlight.current = item.id;
        let outcome: Outcome;
        try { outcome = classify(item, await postJson(pathFor(item), bodyFor(item), REQUEST_TIMEOUT_MS)); }
        catch { outcome = { kind: 'retry' }; }
        finally { inFlight.current = null; }
        if (loaded.current !== active) break;
        if (typeof outcome.revision === 'number' && Number.isFinite(outcome.revision)) revision.current = outcome.revision;
        if (!queue.current.some((row) => row.id === item.id)) continue; // 기록 전체 삭제로 빠진 건
        if (outcome.kind === 'done') {
          forget(item.id);
          delay = 0; staleRun = 0; lastProgress.current = Date.now();
          publish();
          live.current.events.onDelivered?.(item);
          continue;
        }
        if (outcome.kind === 'stale' && ++staleRun <= 5) continue;
        if (outcome.kind === 'fatal') {
          const failed = { ...item, failed: outcome.reason || '저장 거절' };
          queue.current = queue.current.map((row) => row.id === item.id ? failed : row);
          persist(failed);
          staleRun = 0; lastProgress.current = Date.now();
          publish();
          continue;
        }
        refreshBlocked();
        delay = Math.min(delay ? delay * 2 : 1000, MAX_BACKOFF_MS);
        await sleep(delay);
      }
    } finally {
      sending.current = false;
    }
    if (loaded.current && !waiting().length) live.current.events.onIdle?.();
  };

  useEffect(() => {
    // 명령 번호(revision)는 지우지 않는다 — 로그인 정보가 서버 첫 응답보다 늦게 오면 이미 받아 둔 번호를 잃는다.
    loaded.current = ''; queue.current = [];
    setItems([]); setIsLoaded(false); setStorageError(false); setBlocked(false);
    if (!scope) return;
    const rows = new Map<string, FlaOutboxItem>();
    try {
      const legacyScope = `${LEGACY_SHOT_PREFIX}${userId}:${matchId}:`;
      const legacy: { key: string; item: Record<string, any> & { event_id: string; clock_ms: number } }[] = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key) continue;
        if (key.startsWith(scope)) {
          const item = JSON.parse(localStorage.getItem(key) || 'null');
          if (isOutboxItem(item)) rows.set(item.id, item);
        } else if (key.startsWith(legacyScope)) {
          const item = JSON.parse(localStorage.getItem(key) || 'null');
          if (isPendingShot(item)) legacy.push({ key, item });
        }
      }
      // 종전 슈팅 보관(fpc.pending-shot.v1)은 수동 재시도만 있었다. 같은 event_id 로 옮겨 자동 전송에 태운다.
      legacy.sort((a, b) => a.item.clock_ms - b.item.clock_ms).forEach(({ key, item }, index) => {
        if (!rows.has(item.event_id)) {
          const moved: FlaOutboxItem = { v: 1, id: item.event_id, seq: index + 1, kind: 'shot', pressed_at: Date.now(), clock_ms: item.clock_ms, body: item };
          localStorage.setItem(scope + moved.id, JSON.stringify(moved));
          rows.set(moved.id, moved);
        }
        localStorage.removeItem(key);
      });
    } catch { setStorageError(true); }
    queue.current = [...rows.values()].sort((a, b) => a.seq - b.seq);
    lastSeq.current = queue.current.reduce((max, item) => Math.max(max, item.seq), 0);
    loaded.current = scope;
    lastProgress.current = Date.now();
    publish(); setIsLoaded(true);
    void pump();
    return () => { loaded.current = ''; wake.current?.(); };
  }, [scope]);

  // 운영권을 되찾거나 로그인 정보가 늦게 오면 그때부터 보낸다.
  useEffect(() => { if (canWrite && isLoaded) void pump(); }, [canWrite, isLoaded]);

  useEffect(() => {
    // 연결이 돌아오면 기다리던 재시도를 바로 깨운다. 탭이 다시 보일 때도 같다(숨은 탭은 타이머가 늦다).
    const resume = () => { if (document.visibilityState !== 'hidden') { wake.current?.(); void pump(); } };
    const timer = setInterval(refreshBlocked, 5000);
    window.addEventListener('online', resume);
    document.addEventListener('visibilitychange', resume);
    return () => { clearInterval(timer); window.removeEventListener('online', resume); document.removeEventListener('visibilitychange', resume); };
  }, []);

  const enqueue = (kind: FlaOutboxKind, body: Record<string, any>, clockMs: number, id = makeClientId()): FlaOutboxItem | null => {
    const active = live.current.scope;
    if (!active || loaded.current !== active) return null;
    const seq = Math.max(Date.now() * 1000, lastSeq.current + 1);
    lastSeq.current = seq;
    const item: FlaOutboxItem = { v: 1, id, seq, kind, pressed_at: Date.now(), clock_ms: Math.max(0, Math.round(clockMs)), body };
    // 비어 있던 줄이면 "막힘" 측정은 지금부터 — 오래전 마지막 성공 시각으로 바로 경고하지 않게.
    if (!waiting().length) lastProgress.current = Date.now();
    persist(item);
    queue.current = [...queue.current, item];
    publish();
    void pump();
    return item;
  };

  /** 시계가 도는 동안 3초마다 현재 시계를 서버에 알린다(중계 그래픽용). 운영자 입력이 아니므로 보관하지 않고,
   *  보낼 입력이 남아 있으면 건너뛴다 — 먼저 가면 서버가 더 늦은 시계를 기준으로 삼아 누른 시각이 밀린다. */
  const sample = async (body: Record<string, any>) => {
    const active = live.current.scope;
    if (!active || loaded.current !== active || !live.current.canWrite || sending.current || waiting().length) return;
    sending.current = true;
    try {
      const reply = await postJson(`/matches/${matchId}/state`, { ...body, state_id: makeClientId(), update_kind: 'sample', command_revision: revision.current ?? 0 }, SAMPLE_TIMEOUT_MS);
      const next = reply.data?.command_revision;
      if (reply.status === 200 && typeof next === 'number') {
        const previous = revision.current;
        revision.current = next;
        if (previous !== null && next > previous) live.current.events.onServerState?.(reply.data.state, next);
      }
    } catch {} finally {
      sending.current = false;
    }
    if (waiting().length) void pump();
  };

  const retryFailed = () => {
    queue.current = queue.current.map((item) => {
      if (!item.failed) return item;
      const { failed: _failed, ...rest } = item;
      persist(rest as FlaOutboxItem);
      return rest as FlaOutboxItem;
    });
    lastProgress.current = Date.now();
    publish();
    void pump();
  };

  /** 운영자가 직접 지우기로 한 입력만 뺀다(실패 건 지우기·기록 전체 삭제). 보내는 중인 건은 건드리지 않는다. */
  const discard = (match: (item: FlaOutboxItem) => boolean) => {
    const ids = queue.current.filter((item) => item.id !== inFlight.current && match(item)).map((item) => item.id);
    ids.forEach(forget);
    publish();
    return ids.length;
  };

  const pending = items.filter((item) => !item.failed);
  return {
    items,
    loaded: isLoaded,
    pendingCount: pending.length,
    failedCount: items.length - pending.length,
    blocked,
    storageError,
    enqueue,
    sample,
    discard,
    retryFailed,
    hasPendingState: () => waiting().some((item) => item.kind === 'state'),
    getRevision: () => revision.current,
    /** 서버 값이 더 새로울 때만 올린다. 3초 캐시된 요약이 방금 받은 명령 응답보다 낡았을 수 있다. */
    noteRevision: (next: number) => { if (revision.current === null || next > revision.current) revision.current = next; },
  };
}

/** 아직 서버 목록에 없는 슈팅·공격 기록을 서버 이벤트와 같은 모양으로 바꿔 최근 기록·점수에 넣는다. */
export function outboxRecordRow(item: FlaOutboxItem, sync: '' | '저장 중' | '저장 실패'): Record<string, any> & { id: string; seq: number } {
  const body = item.body || {};
  return {
    ...body,
    id: item.id,
    type: item.kind === 'shot' ? 'XG' : 'ATTACK_LANE',
    clock_ms: item.clock_ms,
    team: body.team,
    created_at: new Date(item.pressed_at).toISOString(),
    seq: item.seq,
    sync,
  };
}
