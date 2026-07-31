"""xFP MVP Action 채점 — 정본 v0.1(xFP_MVP_가중치_및_산식_v01.xlsx) 이식.

클립 액션 단위 Action xFP 까지 구현한다:
  원시 기대효과 → Action ID 기준 백분위 → 50~100 변환 → Event(장면) 규칙.
선수 누적 집계(Action Ability → 6축 → Role Raw Score → Final xFP)는 여러 경기의
증거가 쌓여야 하는 선수 단위 계산이라 백엔드/배치 몫으로 남긴다.

정본 규칙(05_산식_정본):
- 원시 기대효과: Goal=xG(연결이면 연결 슈팅 xG×크레딧), Progression=MAX(0,ΔEPV),
  Possession=MAX(0,ΔPC). dual 채점의 epv/pc 는 이미 델타값이다(_epv_delta·_pitch_control_delta).
- Effect Action: 한 Event(장면)당 Outcome 별 최대 1개·전체 최대 3개, 동일 Action ID 중복 금지.
- Action xFP: Action ID 기준 백분위 → 50~100 조각 변환(01 시트 H열).
- 대표 Action = argmax(Action Percentile) — UI 라벨일 뿐, 다른 유효 Action 집계를 제외하지 않음.

백분위 분포는 실측 자료가 아직 없어 xfp_anchors_v0.json 의 캘리브레이션 앵커로
보간한다 — 실데이터가 쌓이면 JSON 만 교체하면 된다.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

_ANCHORS_PATH = Path(__file__).parent / "xfp_anchors_v0.json"

# G2/G3 연결 기여 크레딧 — 정본에 수치 미확정(v0). 연결 슈팅 xG × credit.
LINK_CREDIT = 0.7


@lru_cache(maxsize=1)
def _anchors() -> dict[str, Any]:
    return json.loads(_ANCHORS_PATH.read_text(encoding="utf-8"))


def outcome_family(code: str) -> str | None:
    """24코드 → Outcome 군. G*=goal, P*=progression, S*=possession."""
    if not code:
        return None
    head = code[0]
    return {"G": "goal", "P": "progression", "S": "possession"}.get(head)


def percentile_to_score(p: float) -> int:
    """정본 01 시트 변환표: 백분위(0~1) → 50~100."""
    p = max(0.0, min(1.0, p))
    if p < 0.10:
        s = 50 + 90 * p
    elif p < 0.25:
        s = 60 + 60 * (p - 0.10)
    elif p < 0.50:
        s = 70 + 40 * (p - 0.25)
    elif p < 0.75:
        s = 80 + 40 * (p - 0.50)
    elif p < 0.90:
        s = 90 + 33.333333 * (p - 0.75)
    elif p < 0.97:
        s = 95 + 28.571429 * (p - 0.90)
    elif p < 0.99:
        s = 98
    elif p < 0.999:
        s = 99
    else:
        s = 100
    return int(round(s))


def raw_to_percentile(code: str, raw: float) -> float | None:
    """원시 기대효과 → 백분위(0~1). 앵커 테이블 선형 보간, 액션 ID 오버라이드 우선."""
    if raw is None or raw <= 0:
        return None
    table = _anchors()
    vals = (table.get("actions") or {}).get(code) or (table.get("families") or {}).get(
        outcome_family(code) or ""
    )
    if not vals:
        return None
    pts = table["percentile_points"]
    if raw <= vals[0]:
        return pts[0] * (raw / vals[0]) if vals[0] > 0 else pts[0]
    if raw >= vals[-1]:
        over = (raw - vals[-1]) / vals[-1]
        return min(0.999, pts[-1] + (0.999 - pts[-1]) * min(over, 1.0))
    for k in range(1, len(vals)):
        if raw <= vals[k]:
            lo_v, hi_v = vals[k - 1], vals[k]
            t = (raw - lo_v) / (hi_v - lo_v) if hi_v > lo_v else 0.0
            return pts[k - 1] + (pts[k] - pts[k - 1]) * t
    return pts[-1]


def _raw_effect(code: str, action: dict[str, Any], linked_shot_xg: float | None) -> float | None:
    """액션의 원시 기대효과. 유효성 미달(<=0·근거 없음)이면 None."""
    fam = outcome_family(code)
    if code == "G1":
        v = float(action.get("xg") or 0)
        return v if v > 0 else None
    if code in ("G2", "G3"):
        if linked_shot_xg is None or linked_shot_xg <= 0:
            return None
        return linked_shot_xg * LINK_CREDIT
    if fam == "progression":
        v = float(action.get("epv") or 0)
        return v if v > 0 else None
    if fam == "possession":
        v = float(action.get("pc") or 0)
        return v if v > 0 else None
    return None


def score_clip_actions(payload_actions: list[dict[str, Any]]) -> None:
    """장면(Event) 규칙대로 유효 Effect Action 에 xfpScore·xfpPercentile 을 주석한다(제자리).

    입력은 actionCode·groupIndex 가 이미 붙은 페이로드 액션 목록. 선정되지 못한
    액션은 점수 없이 남는다 (정본: 유효 Effect Action 만 점수화).
    """
    # 연결 슈팅(G1) 목록 — G2/G3 의 '연결 슈팅 xG' 는 그 액션 뒤 첫 슈팅의 xG.
    shots = sorted(
        (float(pa.get("seq") or 0), float(pa.get("xg") or 0))
        for pa in payload_actions
        if pa.get("actionCode") == "G1" and float(pa.get("xg") or 0) > 0
    )

    def linked_shot_xg(seq: float) -> float | None:
        for s, x in shots:
            if s > seq:
                return x
        return None

    groups: dict[Any, list[dict[str, Any]]] = {}
    for i, pa in enumerate(payload_actions):
        key = pa.get("groupIndex") if pa.get("groupIndex") is not None else f"solo-{i}"
        groups.setdefault(key, []).append(pa)

    for members in groups.values():
        candidates = []
        for pa in members:
            # 실패 패스/크로스 — 기록·표시만, 점수 계산 제외.
            if pa.get("failed"):
                continue
            code = str(pa.get("actionCode") or "")
            fam = outcome_family(code)
            if not fam:
                continue
            raw = _raw_effect(code, pa, linked_shot_xg(float(pa.get("seq") or 0)))
            if raw is None:
                continue
            p = raw_to_percentile(code, raw)
            if p is None:
                continue
            candidates.append((pa, code, fam, raw, p))
        # Outcome 별 최대 1개(백분위 높은 순) · 전체 최대 3개 · 동일 Action ID 중복 금지.
        candidates.sort(key=lambda t: -t[4])
        seen_outcome: set[str] = set()
        seen_code: set[str] = set()
        chosen = []
        for cand in candidates:
            _, code, fam, _, _ = cand
            if fam in seen_outcome or code in seen_code:
                continue
            chosen.append(cand)
            seen_outcome.add(fam)
            seen_code.add(code)
            if len(chosen) >= 3:
                break
        for pa, code, fam, raw, p in chosen:
            pa["xfpScore"] = percentile_to_score(p)
            pa["xfpPercentile"] = round(p, 4)
