/**
 * 로컬 앱(FinePlay Highlight) 안에서 돌고 있는지 알아내는 자리.
 *
 * 콘솔과 앱은 화면 코드를 **한 벌만** 쓴다. 두 벌이면 반드시 어긋나기 때문이다.
 * 대신 앱 안에서는 `window.fhlLocal` 다리가 놓여 있어서, 서버로 뻗던 길(로그인·
 * 잡 만들기·클립 올리기·합치기)을 그 다리로 돌린다.
 *
 * 빌드 시점 환경변수가 아니라 **실행 중에** 보는 이유 — 같은 빌드 하나가 콘솔로도
 * 뜨고 앱 안에서도 뜬다. 굽는 시점에는 어느 쪽인지 알 수 없다.
 */

export type LocalInfo = {
  version: string;
  platform: string;
  workDir: string;
  home: string;
};

/** 로컬 앱이 잘라 둔 클립 한 개. 서버로 올리지 않고 그 자리에서 합친다. */
export type LocalClip = {
  name: string;
  path: string;
  size?: number;
  requested_start: number;
  requested_end: number;
  start_time: number;
  has_audio: boolean;
  kind: string | null;
  tag_offset: number | null;
};

export type LocalCutRange = {
  sourceIndex: number;
  start: number;
  end: number;
  kind?: string | null;
  tagOffset?: number | null;
};

export type LocalProgress = {
  phase: 'cutting' | 'merging';
  done?: number;
  total?: number;
  percent?: number;
  message?: string;
};

export type LocalBridge = {
  info: () => Promise<LocalInfo>;
  reveal: (filePath: string) => Promise<boolean>;
  /** <input type="file"> 로 고른 파일의 실제 경로 — 원본은 수 GB 라 메모리로 읽지 않는다. */
  pathForFile: (file: File) => string;
  createJob: () => Promise<{ jobId: string; dir: string }>;
  cut: (jobId: string, sources: string[], ranges: LocalCutRange[]) => Promise<LocalClip[]>;
  /** {"홈:원정": dataURL} 을 파일로 저장하고 {"홈:원정": 경로} 를 돌려준다. */
  saveScoreboards: (jobId: string, images: Record<string, string>) => Promise<Record<string, string>>;
  saveIntro: (jobId: string, dataUrl: string) => Promise<string>;
  merge: (jobId: string, options: {
    clips: LocalClip[];
    intro: { imagePath: string; duration: number } | null;
    scoreboard: Record<string, unknown> | null;
    sbImages: Record<string, string>;
    sbHasLogo: boolean;
  }) => Promise<{ outPath: string }>;
  /** 진행 상황 구독. 돌려주는 함수를 부르면 끊는다. */
  onProgress: (handler: (payload: LocalProgress) => void) => () => void;
};

/** 앱 안이면 다리를, 브라우저면 null. 서버 렌더 중에는 늘 null 이다. */
export function localBridge(): LocalBridge | null {
  if (typeof window === 'undefined') return null;
  const bridge = (window as unknown as { fhlLocal?: LocalBridge }).fhlLocal;
  return bridge ?? null;
}

export function isLocalApp(): boolean {
  return localBridge() !== null;
}

/** 앱 안에는 로그인이 없다. 화면이 사람 이름을 찍는 자리에 쓸 붙박이 값. */
export const LOCAL_USER = {
  id: 'local',
  name: '로컬',
  role: 'ADMIN',
} as const;
