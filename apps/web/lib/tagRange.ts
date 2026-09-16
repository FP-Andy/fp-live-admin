/** 하이라이트 태그의 클립 구간을 직접 옮기는 계산.
 *
 *  태깅 화면에는 조절 수단이 둘이다.
 *    · 앞/뒤 칸 — **태깅 시점을 고정**하고 앞뒤 길이를 늘린다. '언제 일어났나' 가 기준.
 *    · 구간 칸 — **구간을 고정**하고 태깅 시점이 따라온다. '어디를 보여줄까' 가 기준.
 *
 *  이 파일은 뒤쪽이다. 구간을 2:36~2:48 에서 2:32~2:43 으로 옮기면 태깅 시점도 같이
 *  움직여야 하는데, 어디에 놓을지를 **앞/뒤가 정하던 비율**로 정한다 — 앞 9 · 뒤 3 이면
 *  12 초의 75% 지점이므로, 11 초로 줄어든 구간에서도 75% 지점(2:40)에 놓는다.
 *
 *  화면(page.tsx)이 아니라 여기 있는 이유는 계산만 떼어 검증하기 위해서다.
 */

/** 구간이 가질 수 있는 최소 길이. 0 이 되면 클립이 사라진다. */
export const MIN_CLIP_SEC = 1;

/** 앞·뒤가 둘 다 0 이라 비율을 못 구할 때만 쓴다. 보통은 앞/뒤가 비율을 정한다. */
export const TAG_POINT_RATIO_FALLBACK = 0.75;

/** "2:32" · "2:32.5" · "152"(초) → 초. 못 읽으면 null — 그때는 고치기 전으로 되돌린다. */
export function parseClock(text: string): number | null {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  const m = /^(?:(\d+):)?([0-5]?\d(?:\.\d+)?)$/.exec(raw);
  if (m) return Number(m[1] || 0) * 60 + Number(m[2]);
  const plain = Number(raw);
  return Number.isFinite(plain) && plain >= 0 ? plain : null;
}

export type TagRangeFit = { t: number; before: number; after: number };

/** 옮긴 구간을 원본 경계 안으로 눌러 담고, 태깅 시점을 같은 비율 자리에 놓는다.
 *
 *  @param bounds  그 태그가 들어 있는 **원본 하나**의 경계(이어붙인 좌표). 구간이 이걸
 *                 넘으면 다른 파일의 장면이 섞이므로 잘라낸다.
 *  @param pads    지금 이 태그에 적용 중인 앞/뒤 초. 비율만 쓴다.
 *  @returns       원본이 최소 길이도 안 되면 null(=아무것도 바꾸지 않는다).
 */
export function fitTagRange(
  rawStart: number,
  rawEnd: number,
  bounds: { srcStart: number; srcEnd: number },
  pads: { before: number; after: number },
): TagRangeFit | null {
  const { srcStart, srcEnd } = bounds;
  if (!(srcEnd - srcStart >= MIN_CLIP_SEC)) return null;

  let start = Math.max(srcStart, Math.min(rawStart, srcEnd - MIN_CLIP_SEC));
  const end = Math.min(srcEnd, Math.max(rawEnd, start + MIN_CLIP_SEC));
  start = Math.max(srcStart, Math.min(start, end - MIN_CLIP_SEC));

  const span = pads.before + pads.after;
  const ratio = span > 0 ? pads.before / span : TAG_POINT_RATIO_FALLBACK;
  const len = end - start;
  // before 를 먼저 반올림하고 after 를 그 나머지로 둔다 — 그래야 before+after 가 구간
  // 길이와 정확히 맞아, 화면에 적어 넣은 구간이 그대로 클립이 된다.
  const before = Math.round(len * ratio * 100) / 100;
  const after = Math.round((len - before) * 100) / 100;
  return { t: start + before, before, after };
}
