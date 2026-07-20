import { FFmpeg } from '@ffmpeg/ffmpeg';
import type { FFFSType } from '@ffmpeg/ffmpeg';

// enum 을 값으로 import 하면 번들러가 고르는 빌드에 따라 undefined 가 된다.
// 런타임 값은 문자열 그대로이므로 리터럴을 쓴다.
const WORKERFS = 'WORKERFS' as FFFSType;

// 브라우저에서 원본을 자르되 재인코딩은 하지 않는다(-c copy). 그래서 빠르고 가볍지만
// 잘리는 위치가 키프레임으로 밀린다(이 소스는 약 5.7초 간격).
//
// -to + -copyts 를 함께 쓰면 출력 클립이 "원본 타임라인 좌표"를 그대로 유지한다.
// 서버는 ffprobe 로 클립의 start_time 을 읽어 요청 구간과의 차이를 구하고,
// 합치기 재인코딩 한 번에 정확한 지점으로 다듬는다.
//
// WORKERFS 로 마운트하므로 1GB 원본을 메모리에 통째로 올리지 않는다.

const CORE_URL = '/ffmpeg/ffmpeg-core.js';
const WASM_URL = '/ffmpeg/ffmpeg-core.wasm';
const MOUNT_POINT = '/mnt';
// 마운트되는 이름을 고정한다. 원본 파일명에 공백·대괄호·한글이 섞여 있어도 안전하다.
const SAFE_NAME = 'source.mp4';

export type CutRequest = {
  /** 원본 타임라인 기준 클립 시작(초) */
  start: number;
  /** 원본 타임라인 기준 클립 끝(초) */
  end: number;
};

export type CutClip = {
  index: number;
  blob: Blob;
  /** 요청한 구간 — 서버가 정밀 트림에 사용한다 */
  requestedStart: number;
  requestedEnd: number;
};

export type CutProgress = {
  done: number;
  total: number;
  phase: 'loading' | 'cutting' | 'finished';
};

let cached: FFmpeg | null = null;

/** ffmpeg 코어는 31MB라 한 번 받으면 재사용한다. */
async function getFFmpeg(onLog?: (line: string) => void): Promise<FFmpeg> {
  if (cached) return cached;
  const ffmpeg = new FFmpeg();
  if (onLog) ffmpeg.on('log', ({ message }) => onLog(message));
  await ffmpeg.load({ coreURL: CORE_URL, wasmURL: WASM_URL });
  cached = ffmpeg;
  return ffmpeg;
}

export async function cutClipsLocally(
  file: File,
  requests: CutRequest[],
  onProgress?: (p: CutProgress) => void,
): Promise<CutClip[]> {
  onProgress?.({ done: 0, total: requests.length, phase: 'loading' });
  const ffmpeg = await getFFmpeg();

  // Blob 을 감싸 이름만 바꾼다. 데이터는 참조만 하므로 메모리 복사가 없다.
  const mountable = new File([file], SAFE_NAME, { type: file.type || 'video/mp4' });

  try {
    await ffmpeg.createDir(MOUNT_POINT);
  } catch {
    /* 이미 있으면 그대로 쓴다 */
  }
  await ffmpeg.mount(WORKERFS, { files: [mountable] }, MOUNT_POINT);

  const input = `${MOUNT_POINT}/${SAFE_NAME}`;
  const clips: CutClip[] = [];

  try {
    for (let i = 0; i < requests.length; i += 1) {
      const { start, end } = requests[i];
      const out = `clip_${String(i + 1).padStart(3, '0')}.mp4`;
      onProgress?.({ done: i, total: requests.length, phase: 'cutting' });

      await ffmpeg.exec([
        '-ss', start.toFixed(3),
        '-i', input,
        '-to', end.toFixed(3),
        '-c', 'copy',
        '-copyts',
        out,
      ]);

      const data = await ffmpeg.readFile(out);
      const bytes = data as Uint8Array;
      // 빈 출력이면 구간 지정이 잘못된 것이므로 조용히 넘기지 않는다.
      if (!bytes || bytes.length < 1024) {
        throw new Error(`${i + 1}번 클립을 만들지 못했습니다 (${start.toFixed(1)}~${end.toFixed(1)}초).`);
      }
      clips.push({
        index: i + 1,
        blob: new Blob([bytes], { type: 'video/mp4' }),
        requestedStart: start,
        requestedEnd: end,
      });
      await ffmpeg.deleteFile(out);
    }
  } finally {
    try {
      await ffmpeg.unmount(MOUNT_POINT);
    } catch {
      /* 마운트 해제 실패가 결과를 무효로 만들지는 않는다 */
    }
  }

  onProgress?.({ done: requests.length, total: requests.length, phase: 'finished' });
  return clips;
}

/**
 * 업로드용 클립은 원본 시간축을 유지하므로 재생기가 "588초에서 시작하는 16초 영상"으로 읽어
 * 눈으로 확인하기 어렵다. 사람이 열어볼 때만 시간축을 0부터로 다시 매긴다.
 * 재인코딩이 없어 순식간이고, 화질과 내용은 그대로다.
 */
export async function normalizeForPreview(blob: Blob): Promise<Blob> {
  const ffmpeg = await getFFmpeg();
  const stamp = Date.now();
  const inName = `pv_in_${stamp}.mp4`;
  const outName = `pv_out_${stamp}.mp4`;
  await ffmpeg.writeFile(inName, new Uint8Array(await blob.arrayBuffer()));
  try {
    await ffmpeg.exec([
      '-i', inName,
      '-c', 'copy',
      '-avoid_negative_ts', 'make_zero',
      '-reset_timestamps', '1',
      outName,
    ]);
    const data = (await ffmpeg.readFile(outName)) as Uint8Array;
    return new Blob([data], { type: 'video/mp4' });
  } finally {
    for (const name of [inName, outName]) {
      try {
        await ffmpeg.deleteFile(name);
      } catch {
        /* 이미 없으면 무시 */
      }
    }
  }
}
