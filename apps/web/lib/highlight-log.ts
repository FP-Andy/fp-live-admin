import { parseManualWork, type SavedWork } from './manual-draft';

export const MAX_LOG_BYTES = 100 * 1024 * 1024;
export type LogSource = { name: string; size: number; duration: number; fingerprint: string };
export type SourceFile = { file: File; duration: number };
export type LogAttachment = { name: string; type: string; size: number; data: string };
export type HighlightLog = {
  format: 'fpc-highlight-log'; version: 1; sport: string; createdAt: string;
  sources: LogSource[]; work: SavedWork;
  attachments: { intro?: LogAttachment; music?: LogAttachment };
};

const fingerprints = new WeakMap<File, Promise<string>>();
/** Bounded reads for large match videos; detects accidental source substitution. */
export function sourceFingerprint(file: File): Promise<string> {
  const cached = fingerprints.get(file);
  if (cached) return cached;
  const promise = (async () => {
    const chunk = 1024 * 1024;
    const starts = [...new Set([0, Math.max(0, Math.floor(file.size / 2) - chunk / 2), Math.max(0, file.size - chunk)])];
    const bytes = await new Blob([String(file.size), ...starts.map((start) => file.slice(start, start + chunk))]).arrayBuffer();
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    return 'sha256-sampled-v1:' + Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
  })();
  fingerprints.set(file, promise);
  return promise;
}

export async function encodeAttachment(file: File, kind: 'intro' | 'music'): Promise<LogAttachment> {
  const limit = kind === 'intro' ? 20 : 40;
  if (file.size > limit * 1024 * 1024) throw new Error(`${kind === 'intro' ? '인트로' : '음악'} 파일은 ${limit}MB까지 JSON에 포함할 수 있습니다.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const chunks: string[] = [];
  for (let i = 0; i < bytes.length; i += 32768) chunks.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
  return { name: file.name, type: file.type, size: file.size, data: btoa(chunks.join('')) };
}

export function decodeAttachment(value: unknown, kind: 'intro' | 'music'): File | null {
  if (value === undefined) return null;
  const item = value as LogAttachment;
  const limit = (kind === 'intro' ? 20 : 40) * 1024 * 1024;
  const allowed = kind === 'intro' ? /\.(png|jpe?g|webp)$/i : /\.(mp3|m4a|aac|wav|ogg|flac)$/i;
  if (!item || typeof item.name !== 'string' || !allowed.test(item.name) || typeof item.type !== 'string'
    || !Number.isInteger(item.size) || item.size < 0 || item.size > limit || typeof item.data !== 'string'
    || item.data.length > Math.ceil(limit / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.data)) {
    throw new Error('JSON에 포함된 인트로 또는 음악 파일이 올바르지 않습니다.');
  }
  const raw = atob(item.data);
  if (raw.length !== item.size) throw new Error('첨부 파일 크기가 맞지 않습니다.');
  return new File([Uint8Array.from(raw, (c) => c.charCodeAt(0))], item.name, { type: item.type });
}

export async function createHighlightLog(sport: string, sources: SourceFile[], work: SavedWork,
  files: { intro?: File | null; music?: File | null } = {}): Promise<HighlightLog> {
  if (!sources.length) throw new Error('원본 영상을 먼저 선택하세요.');
  return {
    format: 'fpc-highlight-log', version: 1, sport, createdAt: new Date().toISOString(),
    sources: await Promise.all(sources.map(async ({ file, duration }) => ({
      name: file.name, size: file.size, duration, fingerprint: await sourceFingerprint(file),
    }))),
    work: structuredClone(work),
    attachments: {
      ...(files.intro ? { intro: await encodeAttachment(files.intro, 'intro') } : {}),
      ...(files.music ? { music: await encodeAttachment(files.music, 'music') } : {}),
    },
  };
}

export function logBlob(log: HighlightLog): Blob {
  const blob = new Blob([JSON.stringify(log, null, 2)], { type: 'application/json' });
  if (blob.size > MAX_LOG_BYTES) throw new Error('JSON 로그가 100MB를 넘습니다. 첨부 파일 크기를 줄여 주세요.');
  return blob;
}

export async function readHighlightLog(raw: string, sport: string, sources: SourceFile[], allowedKinds: string[]) {
  if (new Blob([raw]).size > MAX_LOG_BYTES) throw new Error('JSON 로그는 100MB까지 불러올 수 있습니다.');
  const log = JSON.parse(raw);
  const legacy = log?.format === 'fpc-manual-draft' && log.version === 1;
  if ((!legacy && (log?.format !== 'fpc-highlight-log' || log.version !== 1)) || log.sport !== sport
    || !Array.isArray(log.sources) || !sources.length || log.sources.length !== sources.length) {
    throw new Error('종목과 원본 영상 개수가 일치하는 하이라이트 JSON을 선택하세요.');
  }
  for (let i = 0; i < sources.length; i++) {
    const source = log.sources[i], actual = sources[i];
    if (!source || source.size !== actual.file.size || (legacy ? source.name !== actual.file.name
      : typeof source.duration !== 'number' || !Number.isFinite(source.duration)
        || Math.abs(source.duration - actual.duration) > .1 || source.fingerprint !== await sourceFingerprint(actual.file))) {
      throw new Error(`원본 ${i + 1}이 로그와 다릅니다. 같은 영상 파일을 같은 순서로 선택하세요.`);
    }
  }
  const work = parseManualWork(JSON.stringify(log.work), allowedKinds);
  const total = sources.reduce((sum, source) => sum + source.duration, 0);
  if (work.tags.length > 50000 || work.tags.some((tag) => tag.t > total + .1)) throw new Error('영상 길이를 벗어난 태그가 있습니다.');
  work.tags = [...work.tags].sort((a, b) => a.t - b.t);
  const intro = legacy ? null : decodeAttachment(log.attachments?.intro, 'intro');
  const music = legacy ? null : decodeAttachment(log.attachments?.music, 'music');
  return { work, intro, music, legacy };
}
