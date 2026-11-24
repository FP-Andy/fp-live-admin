"""신청 태깅 '클립 추가' 모드 — 이미 만든 클립은 그대로 두고 새 클립만 만든다(2026-11-24).

왜 따로 두나
------------
기존 생성(run_fineplay_produce)은 신청 하나의 클립을 **통째로 다시** 만든다. 키가 순번
(fpc-{rid}-001…)이라 사이에 하나만 끼워도 번호가 밀리고, 이번 렌더에 없는 옛 클립을 지우고,
클립마다 액션을 갈아 끼운다. FPA 액션(씬모션)까지 찍은 뒤에 장면 몇 개를 더 넣으려면
그 액션이 전부 날아갔다.

추가 모드의 약속
----------------
1. 기존 클립 키는 영원히 그대로다. 새 클립은 그 신청에서 **한 번이라도 쓴 번호의 최댓값 + 1**
   부터 받는다 — 지운 번호(#459 의 001·008)도 다시 쓰지 않는다(S3 에 옛 영상이 남아 있다).
2. 새 클립만 렌더·업로드한다. 기존 행·액션·S3 객체는 건드리지 않는다.
3. 순서(order_index)는 기존 규칙 그대로 (매니페스트 영상 순서, 시작 시각) 으로 전체를 다시 매긴다.
   키는 바꾸지 않는다 — FinePlay 는 payload 순서대로 행을 만들고 앱은 그 순서로 보여 준다.

이 모듈은 DB·S3 를 직접 만지지 않는 순수 함수만 둔다(테스트 고정용).
"""

from __future__ import annotations

import re
from typing import Any, Callable, Iterable

# 클립 결과 화면이 '추가된 클립' 을 표시할 때 읽는 잡 메타 키. 스키마 변경 없이 메타에 둔다.
APPENDED_KEYS_META = "appended_clip_keys"
# 추가 렌더가 만들 키 목록 — 생성 요청(엔드포인트)이 적고 워커가 읽는다.
APPEND_PENDING_META = "append_pending_keys"
# 한 번이라도 배정한 가장 큰 번호. 메타·DB 에서 흔적이 사라져도 번호를 되쓰지 않게 남긴다.
KEY_HIGH_WATER_META = "clip_key_high_water"


def clip_key(rid: Any, number: int) -> str:
    return f"fpc-{rid}-{number:03d}"


def clip_key_number(key: Any, rid: Any) -> int | None:
    """'fpc-{rid}-NNN' 이면 NNN, 아니면 None(다른 신청·다른 규칙의 키는 세지 않는다)."""
    m = re.fullmatch(rf"fpc-{re.escape(str(rid))}-(\d+)", str(key or "").strip())
    return int(m.group(1)) if m else None


def _payload_keys(payload: Any) -> Iterable[str]:
    if not isinstance(payload, dict):
        return []
    out = []
    for clip in payload.get("clips") or []:
        if isinstance(clip, dict):
            out.append(str(clip.get("clipKey") or clip.get("fpcClipId") or ""))
    return out


def used_clip_numbers(rid: Any, metadata: dict, db_keys: Iterable[str]) -> set[int]:
    """이 신청에서 이미 쓴(또는 썼을 수 있는) 번호들.

    - DB 클립 행(지금 남아 있는 것)
    - 잡 메타 clips[].clipId, result_payload, 사전 작업 링크·자체전 묶음 payload
    - clips 항목 중 clipId 가 빈 것: 옛 생성은 정렬 후 자리 번호(i+1)를 키로 썼으므로
      항목 수만큼의 번호가 이미 쓰였다고 본다(#459: 18 항목 → 001~018).
    - 앞선 추가 모드가 남긴 최댓값(KEY_HIGH_WATER_META)
    """
    keys: list[str] = list(db_keys)
    entries = [e for e in (metadata.get("clips") or []) if isinstance(e, dict)]
    keys += [str(e.get("clipId") or "") for e in entries]
    keys += list(_payload_keys(metadata.get("result_payload")))
    for link in (metadata.get("links") or {}).values():
        if isinstance(link, dict):
            keys += list(_payload_keys(link.get("result_payload")))
    for bundle in (metadata.get("scrimmage") or {}).values():  # 자체전 묶음(fineplay_scrimmage.META_KEY)
        if isinstance(bundle, dict):
            keys += list(_payload_keys(bundle.get("result_payload")))
    keys += [str(k) for k in (metadata.get(APPENDED_KEYS_META) or [])]
    keys += [str(k) for k in (metadata.get(APPEND_PENDING_META) or [])]

    numbers = {n for n in (clip_key_number(k, rid) for k in keys) if n is not None}
    positional = sum(1 for e in entries if not e.get("clipId"))
    numbers.update(range(1, positional + 1))
    try:
        high = int(metadata.get(KEY_HIGH_WATER_META) or 0)
    except (TypeError, ValueError):
        high = 0
    numbers.update(range(1, high + 1))
    return numbers


def assign_new_keys(
    rid: Any,
    count: int,
    used: set[int],
    exists: Callable[[str], bool] | None = None,
    *,
    max_probe: int = 200,
) -> list[str]:
    """쓴 번호의 최댓값 다음부터 count 개. exists(key) 가 True 인 번호(S3 에 이미 있음)는 건너뛴다.

    최댓값 '다음' 부터라 사이의 빈 번호(지운 클립)는 절대 다시 쓰지 않는다.
    """
    keys: list[str] = []
    n = max(used, default=0)
    skipped = 0
    while len(keys) < count:
        n += 1
        key = clip_key(rid, n)
        if exists is not None and exists(key):
            skipped += 1
            if skipped > max_probe:
                raise RuntimeError("비어 있는 클립 번호를 찾지 못했습니다(S3 에 같은 키가 계속 있음).")
            continue
        keys.append(key)
    return keys


def order_rows(
    rows: list[dict],
    video_order: dict[str, int],
) -> list[str]:
    """(영상 순서, 시작 시각) 으로 정렬한 키 목록 — run_fineplay_produce 의 _clip_sort_key 와 같은 규칙.

    rows: [{key, source_video_id, start, prev_order(기존 행만), new(bool)}]
    같은 영상·같은 시작이면 기존 클립이 먼저, 그다음 키 순 — 결과가 항상 같게.
    모르는 영상 id 는 기존 규칙처럼 0번 영상으로 본다.
    """
    def sort_key(r: dict) -> tuple:
        try:
            start = float(r.get("start") or 0)
        except (TypeError, ValueError):
            start = 0.0
        return (
            video_order.get(str(r.get("source_video_id") or ""), 0),
            start,
            1 if r.get("new") else 0,
            int(r.get("prev_order") or 0),
            str(r.get("key")),
        )

    return [str(r["key"]) for r in sorted(rows, key=sort_key)]


def span_key(source_video_id: Any, start: Any, end: Any) -> tuple[str, float, float] | None:
    """메타 clips 항목 ↔ DB 행을 구간으로 맞출 때 쓰는 비교 키(소수 셋째 자리)."""
    try:
        return (str(source_video_id or ""), round(float(start), 3), round(float(end), 3))
    except (TypeError, ValueError):
        return None
