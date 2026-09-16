/** 하이라이트 태그의 클립 구간을 직접 옮기는 계산.
 *
 *  태깅 화면에는 조절 수단이 둘이다.
 *    · 앞/뒤 칸 — **태깅 시점을 고정**하고 앞뒤 길이를 늘린다. '언제 일어났나' 가 기준.
 *    · 구간 칸 — **구간을 고정**하고 태깅 시점이 따라온다. '어디를 보여줄까' 가 기준.
 *
 *  이 파일은 뒤쪽이다. 구간을 2:36~2:49 에서 2:32~2:43 으로 옮기면 태깅 시점도 같이
 *  움직여야 하는데, 어디에 놓을지는 **구간의 80% 지점**으로 정한다(TAG_POINT_RATIO).
 *  11 초 구간이면 시작 + 8.8 초다.
 *
 *  화면(page.tsx)이 아니라 여기 있는 이유는 계산만 떼어 검증하기 위해서다.
 */

/** 구간이 가질 수 있는 최소 길이. 0 이 되면 클립이 사라진다. */
export const MIN_CLIP_SEC = 1;

/** 구간을 옮겼을 때 태깅 시점이 앉는 자리 — 구간 길이의 이 비율만큼 뒤.
 *
 *  앞/뒤 기본값(10·3)에서 유도하지 않고 **고정값**으로 둔다. 기본값을 조금 바꿨다고
 *  이미 잡아 둔 구간들의 시점이 따라 움직이면 안 되기 때문이다. 13 초 기본 클립에서
 *  10/3 은 76.9% 자리지만, 구간을 직접 옮길 때는 80% 를 쓴다(2026-09-16 합의). */
export const TAG_POINT_RATIO = 0.8;

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

/** 옮긴 구간을 원본 경계 안으로 눌러 담고, 태깅 시점을 80% 자리에 놓는다.
 *
 *  @param bounds  그 태그가 들어 있는 **원본 하나**의 경계(이어붙인 좌표). 구간이 이걸
 *                 넘으면 다른 파일의 장면이 섞이므로 잘라낸다.
 *  @returns       원본이 최소 길이도 안 되면 null(=아무것도 바꾸지 않는다).
 */
export function fitTagRange(
  rawStart: number,
  rawEnd: number,
  bounds: { srcStart: number; srcEnd: number },
): TagRangeFit | null {
  const { srcStart, srcEnd } = bounds;
  if (!(srcEnd - srcStart >= MIN_CLIP_SEC)) return null;

  let start = Math.max(srcStart, Math.min(rawStart, srcEnd - MIN_CLIP_SEC));
  const end = Math.min(srcEnd, Math.max(rawEnd, start + MIN_CLIP_SEC));
  start = Math.max(srcStart, Math.min(start, end - MIN_CLIP_SEC));

  const len = end - start;
  // before 를 먼저 반올림하고 after 를 그 나머지로 둔다 — 그래야 before+after 가 구간
  // 길이와 정확히 맞아, 화면에 적어 넣은 구간이 그대로 클립이 된다.
  const before = Math.round(len * TAG_POINT_RATIO * 100) / 100;
  const after = Math.round((len - before) * 100) / 100;
  return { t: start + before, before, after };
}
