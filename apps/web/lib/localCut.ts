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

// 마지막 ffmpeg 로그를 굴려 담는다. 실패했을 때 사용자에게 **진짜 원인**을 보여주기
// 위해서다 — 그전에는 exec 의 종료 코드도 로그도 버리고 "N번 클립을 만들지 못했습니다"
// 만 띄워서, 원인을 알아내려면 개발자가 재현하는 수밖에 없었다.
const LOG_KEEP = 40;
let logTail: string[] = [];

/** ffmpeg 코어는 31MB라 한 번 받으면 재사용한다. */
async function getFFmpeg(onLog?: (line: string) => void): Promise<FFmpeg> {
  if (cached) return cached;
  const ffmpeg = new FFmpeg();
  ffmpeg.on('log', ({ message }) => {
    logTail.push(message);
    if (logTail.length > LOG_KEEP) logTail.shift();
    onLog?.(message);
  });
  await ffmpeg.load({ coreURL: CORE_URL, wasmURL: WASM_URL });
  cached = ffmpeg;
  return ffmpeg;
}

/** 로그에서 원인 한 줄을 골라낸다. 없으면 마지막 줄들. */
function failureReason(): string {
  const meaningful = logTail.filter((l) =>
    /not (currently )?supported|Could not|Invalid|Error|error|No such|failed/i.test(l),
  );
  const picked = (meaningful.length ? meaningful : logTail).slice(-3);
  return picked.join(' / ').slice(0, 300);
}

// 자르기 시도 순서. 위에서부터 되는 걸 쓴다.
//
// SUFA 원본처럼 **오디오가 무압축 PCM(pcm_s16be)** 인 촬영본이 있다. PCM 은 mp4 에
// 담을 수 없어서 무손실 복사가 헤더 작성 단계에서 실패한다:
//     Could not find tag for codec pcm_s16be in stream #1,
//     codec not currently supported in container
// 그러면 출력이 0바이트가 되어 "N번 클립을 만들지 못했습니다" 만 뜬다.
//
// 브라우저 코어는 ffmpeg 5.1.4 다(@ffmpeg/core 0.12.10). 최신 ffmpeg(8.x)는 PCM 을
// mp4 의 ipcm 박스로 담을 수 있어 터미널에서는 같은 파일이 잘린다 — 그래서 '맥에서는
// 되는데' 로 보였다. 실제로는 브라우저에서 OS 와 무관하게 실패한다.
//
// **비디오는 어떤 경우에도 재인코딩하지 않는다.** 오디오만 굽는 건 가볍고 화질과
// 무관하다. 마지막 수단으로 오디오를 버리는 건, 합치기 단계가 어차피 오디오를 다시
// 굽기 때문에 최소한 영상은 건지려는 것이다.
const CUT_VARIANTS: { label: string; codecArgs: string[] }[] = [
  { label: '무손실 복사', codecArgs: ['-c', 'copy'] },
  { label: '오디오 재인코딩', codecArgs: ['-c:v', 'copy', '-c:a', 'aac'] },
  { label: '오디오 제외', codecArgs: ['-c:v', 'copy', '-an'] },
];

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
  // 이 원본에 통하는 자르기 방식(CUT_VARIANTS 인덱스). 첫 클립에서 정해진다.
  let variantIndex = 0;

  try {
    for (let i = 0; i < requests.length; i += 1) {
      const { start, end } = requests[i];
      const out = `clip_${String(i + 1).padStart(3, '0')}.mp4`;
      onProgress?.({ done: i, total: requests.length, phase: 'cutting' });

      // 한 번 통한 방식을 기억해 다음 클립부터는 그것부터 시도한다 — 원본 하나에서
      // 무손실 복사가 안 되면 나머지 클립도 전부 안 되므로, 매번 실패를 반복할 이유가 없다.
      let bytes: Uint8Array | null = null;
      for (let v = variantIndex; v < CUT_VARIANTS.length; v += 1) {
        logTail = [];
        await ffmpeg.exec([
          '-ss', start.toFixed(3),
          '-i', input,
          '-to', end.toFixed(3),
          ...CUT_VARIANTS[v].codecArgs,
          '-copyts',
          out,
        ]);
        let data: unknown = null;
        try {
          data = await ffmpeg.readFile(out);
        } catch {
          /* 출력이 아예 안 만들어진 경우 — 아래에서 다음 방식으로 넘어간다 */
        }
        const candidate = data as Uint8Array | null;
        if (candidate && candidate.length >= 1024) {
          bytes = candidate;
          variantIndex = v;
          break;
        }
        // 실패한 흔적(0바이트 파일)을 지우고 다음 방식으로.
        try {
          await ffmpeg.deleteFile(out);
        } catch {
          /* 없으면 그대로 */
        }
      }

      if (!bytes) {
        throw new Error(
          `${i + 1}번 클립을 만들지 못했습니다 (${start.toFixed(1)}~${end.toFixed(1)}초). `
          + `원본을 이 브라우저에서 자를 수 없는 형식입니다 — ${failureReason()}`,
        );
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
