type RecordValue = { id: string; title: string; updatedAt: string };
type Journal = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
type Entry<T> = { record: T; base?: T; changed: Set<keyof T>; revision: number; saved: number; error: boolean; journalFailed: boolean; timer?: ReturnType<typeof setTimeout>; running?: Promise<void> };

/** One writer per report survives page unmounts. Acknowledgements belong to a
 * revision, while the synchronous tab journal covers reloads before IDB commits. */
export function createReportPersistence<T extends RecordValue>(write: (record: T) => Promise<unknown>, journal: () => Journal, prefix: string, delay = 800) {
  const entries = new Map<string, Entry<T>>();
  let lastSaved: T | undefined;
  const listeners = new Set<(id: string) => void>();
  const emit = (id: string) => listeners.forEach(listener => listener(id));
  const key = (id: string) => prefix + id;
  function stage(value: T): T {
    const previous = entries.get(value.id);
    const record = { ...value, updatedAt: new Date(Math.max(Date.now(), Date.parse(previous?.record.updatedAt || value.updatedAt) + 1 || 0)).toISOString() };
    const entry = previous || { record, base: lastSaved?.id === value.id ? lastSaved : undefined, changed: new Set<keyof T>(), revision: 0, saved: 0, error: false, journalFailed: false };
    const before = previous?.record || entry.base;
    for (const field of new Set([...Object.keys(before || {}), ...Object.keys(record)] as Array<keyof T>)) {
      if (!Object.is(before?.[field], record[field])) entry.changed.add(field);
    }
    entry.record = record; entry.revision++; entry.error = false;
    // Once a full source is in IDB, journal only changed top-level fields. Typing
    // prose must not stringify or copy an entire match's coordinate data again.
    const recovery = entry.base ? { schema: 'fpc-report-journal/v1', id: record.id, baseUpdatedAt: entry.base.updatedAt, updatedAt: record.updatedAt,
      changes: Object.fromEntries([...entry.changed].map(field => [field, record[field]])),
      removed: [...entry.changed].filter(field => record[field] === undefined) } : record;
    try { journal().setItem(key(record.id), JSON.stringify(recovery)); entry.journalFailed = false; }
    catch { entry.journalFailed = true; }
    clearTimeout(entry.timer);
    entries.set(record.id, entry);
    entry.timer = setTimeout(() => { void flush(record.id).catch(() => {}); }, delay);
    emit(record.id);
    return record;
  }
  async function flush(id: string): Promise<void> {
    const entry = entries.get(id); if (!entry) return;
    clearTimeout(entry.timer);
    if (entry.running) { await entry.running; if (entry.saved < entry.revision) return flush(id); return; }
    entry.running = (async () => {
      while (entry.saved < entry.revision) {
        const revision = entry.revision, record = entry.record;
        try { await write(record); }
        catch (error) { entry.error = true; emit(id); throw error; }
        entry.saved = revision; entry.error = false;
        lastSaved = record;
        if (entry.saved === entry.revision) {
          try { journal().removeItem(key(id)); } catch { /* stale journals lose to the newer IDB timestamp */ }
        }
        emit(id);
      }
    })();
    try { await entry.running; } finally {
      entry.running = undefined;
      if (entry.saved === entry.revision) { clearTimeout(entry.timer); entries.delete(id); }
    }
  }
  function recover(id: string, stored: T | undefined): T | undefined {
    if (stored) lastSaved = stored;
    const entry = entries.get(id);
    if (entry && entry.saved < entry.revision) return entry.record;
    try {
      const candidate = JSON.parse(journal().getItem(key(id)) || 'null');
      if (candidate?.id === id && typeof candidate.updatedAt === 'string' && (!stored || candidate.updatedAt > stored.updatedAt)) {
        if (candidate.schema !== 'fpc-report-journal/v1') return candidate as T;
        if (stored && stored.updatedAt >= candidate.baseUpdatedAt && candidate.changes && Array.isArray(candidate.removed)) {
          const recovered = { ...stored, ...candidate.changes } as T;
          for (const field of candidate.removed) delete recovered[field as keyof T];
          return recovered;
        }
      }
    } catch { /* leave the journal intact; the caller can still open the IDB record */ }
    return stored;
  }
  function state(id: string) {
    const entry = entries.get(id), dirty = !!entry && entry.saved < entry.revision;
    return { dirty, record: entry?.record, message: !dirty ? '이 브라우저에 저장됨' : entry?.error ? '저장 실패 · JSON 저장 후 다시 시도하세요' : entry?.journalFailed ? '저장 대기 · 임시 복구 공간 부족, 화면을 닫지 마세요' : '저장 중 · 이 탭에 임시 보관됨' };
  }
  return { stage, flush, recover, state, subscribe(listener: (id: string) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; } };
}
