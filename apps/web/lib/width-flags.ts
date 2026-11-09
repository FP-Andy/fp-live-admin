import { useEffect, type RefObject } from 'react';

// 카드 폭에 따라 data-w-<이름> 속성을 켜고 끈다. CSS 컨테이너 쿼리 대신 쓴다.
//
// 왜: 매치 컨트롤에 container-type 카드가 있으면 Safari(WebKit)가 창을 760px 아래로
// 줄였다 다시 넓혀도 좁은 화면 스타일(아래 탭·한 칸 배치)을 바로 풀지 못한다. 시계가
// 멈춰 있으면 계속 남고, 흐르면 1초쯤 남았다 풀린다(이사71 재현, Chromium 은 0건).
// 속성 선택자는 바뀌는 즉시 다시 계산돼 이 문제가 없다.
//
// flags: { 이름: 안쪽 폭(px)이 이 값 이하이면 켬 }. 리렌더 없이 속성만 바꾼다.
export function useWidthFlags(ref: RefObject<HTMLElement | null>, flags: Record<string, number>) {
  const key = JSON.stringify(flags);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const entries = Object.entries(JSON.parse(key) as Record<string, number>);
    const apply = (width: number) => {
      for (const [name, max] of entries) el.toggleAttribute(`data-w-${name}`, width <= max);
    };
    // 컨테이너 쿼리와 같은 기준 — 안쪽(content box) 폭.
    const style = getComputedStyle(el);
    apply(el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight));
    const observer = new ResizeObserver((items) => apply(items[items.length - 1].contentRect.width));
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, key]);
}
