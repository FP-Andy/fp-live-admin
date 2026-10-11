import { apiFetch } from './api';

/** A suspended browser can stop performance.now on some platforms. Wall time
 * restores that interval; the monotonic clock protects against backward edits. */
export function elapsedMatchMs(perfStart: number, wallStart: number, perfNow: number, wallNow: number) {
  return Math.max(0, perfNow - perfStart, wallNow - wallStart);
}

export function restoredMatchMs(state: any): number {
  const base = Math.max(0, Number(state?.clock_ms) || 0);
  if (!state?.running || !state.sampled_at || !state.server_now) return base;
  const elapsed = Date.parse(state.server_now) - Date.parse(state.sampled_at);
  return base + (Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0) * (state.clock_speed === 2 ? 2 : 1);
}

/** Bound both the fetch and body read. A timeout does not mean a write failed:
 * callers must keep the original request ID and payload for reconciliation. */
export async function matchControlJson<T = any>(path: string, init?: RequestInit, timeoutMs = 12000): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await apiFetch(path, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    return await response.json() as T;
  } finally {
    clearTimeout(timeout);
  }
}

export type PendingShot = {
  event_id: string;
  clock_ms: number;
  team: 'HOME' | 'AWAY';
  xg: number;
  [key: string]: unknown;
};

export function isPendingShot(value: unknown): value is PendingShot {
  const item = value as PendingShot | null;
  return !!item && typeof item.event_id === 'string' && /^[0-9a-f-]{36}$/i.test(item.event_id)
    && Number.isSafeInteger(item.clock_ms) && item.clock_ms >= 0
    && (item.team === 'HOME' || item.team === 'AWAY') && Number.isFinite(item.xg);
}
