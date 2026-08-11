"""xFP MVP Action 채점 — 정본 v0.1(xFP_MVP_가중치_및_산식_v01.xlsx) 이식.

클립 액션 단위 Action xFP 까지 구현한다:
  원시 기대효과 → Action ID 기준 백분위 → 50~100 변환 → Event(장면) 규칙.
선수 누적 집계(Action Ability → 6축 → Role Raw Score → Final xFP)는 여러 경기의
증거가 쌓여야 하는 선수 단위 계산이라 백엔드/배치 몫으로 남긴다.

정본 규칙(05_산식_정본):
- 원시 기대효과: Goal=xG(연결이면 연결 슈팅 xG×크레딧), Progression=MAX(0,ΔEPV),
  Possession=MAX(0,ΔPC). dual 채점의 epv/pc 는 이미 델타값이다(_epv_delta·_pitch_control_delta).
  ΔPC 는 fpa.py 에서 행위자 기준으로 부호를 맞춰 들어온다(_actor_pc_sign) — 홈 기준 원본을
  그대로 쓰면 어웨이 팀 액션의 부호가 반대라 MAX(0,ΔPC) 에서 통째로 탈락한다.
- 수비(S5/S7)는 예외: Outcome 은 Possession 이지만 원시 기대효과가 ΔPC 가 아니다.
  태클·차단·컷아웃·클리어 = 끊은 지점의 소유권 전환가치(fpa._defense_turnover_value,
  전용 defense 곡선), 블록 = 막은 슛 xG(goal 곡선).
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

# 수비 액션(태클·차단·컷아웃·클리어·블록)의 24코드. 자기 진영 S5 / 상대 진영 S7.
# Outcome 군은 Possession 이지만 **ΔPC 로 채점하지 않는다** — `fpa.py` 가 이미 이들을
# '막아낸 위협'으로 재고 있다(DEFENSE_ARROW_CODES=상대 공격방향 ΔEPV, SHOT_BLOCK_CODES=
# 막은 슛 xG). ΔPC 를 쓰면 수비는 정의상 '상대 통제 공간 → 우리 통제'로 통제 경계를
# 넘는 행위라 ΔPC 가 늘 최대치에 붙어, 막은 위협이 0 이거나 음수인 액션까지 만점이 됐다.
DEFENSE_CODES = frozenset({"S5", "S7"})


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


def raw_to_percentile(code: str, raw: float, basis: str | None = None) -> float | None:
    """원시 기대효과 → 백분위(0~1). 앵커 테이블 선형 보간, 액션 ID 오버라이드 우선.

    basis 는 어느 군의 앵커 곡선으로 잴지 — 생략하면 코드의 Outcome 군을 쓴다.
    수비처럼 Outcome 군(Possession)과 실제 측정 단위(막아낸 EPV·xG)가 다른 코드는
    `effect_basis` 가 돌려주는 군을 넘겨야 스케일이 맞는다.
    """
    if raw is None or raw <= 0:
        return None
    table = _anchors()
    vals = (table.get("actions") or {}).get(code) or (table.get("families") or {}).get(
        basis or outcome_family(code) or ""
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


def effect_basis(code: str, action: dict[str, Any]) -> str | None:
    """이 액션을 실제로 무엇으로 재는지 = 앵커 곡선을 고르는 군.

    보통은 Outcome 군과 같다. 수비(DEFENSE_CODES)만 다르다 — Outcome 은 Possession
    이지만 측정값이 ΔPC 가 아니다(`fpa.py`). 슛블락은 막은 슛의 xG 라 goal 곡선을
    그대로 쓰고, 나머지(태클·차단·컷아웃·클리어)는 끊은 지점의 **소유권 전환가치**
    (`_defense_turnover_value`)라 EPV 와 단위는 같아도 델타가 아니라 레벨이라 스케일이
    다르다 — 전용 defense 곡선으로 잰다.
    """
    if code in DEFENSE_CODES:
        return "goal" if float(action.get("xg") or 0) > 0 else "defense"
    return outcome_family(code)


def _raw_effect(code: str, action: dict[str, Any], linked_shot_xg: float | None) -> float | None:
    """액션의 원시 기대효과. 유효성 미달(<=0·근거 없음)이면 None."""
    if code == "G1":
        v = float(action.get("xg") or 0)
        return v if v > 0 else None
    if code in ("G2", "G3"):
        if linked_shot_xg is None or linked_shot_xg <= 0:
            return None
        return linked_shot_xg * LINK_CREDIT
    # 수비는 Outcome 이 Possession 이어도 ΔPC 를 쓰지 않는다 — 아래 주석 참조.
    fam = effect_basis(code, action)
    if fam == "goal":  # 슛블락 — 막은 슛의 xG(×BLOCK_CREDIT)가 xG 컬럼에 들어온다.
        v = float(action.get("xg") or 0)
        return v if v > 0 else None
    if fam in ("progression", "defense"):  # 수비 전환가치도 EPV 컬럼으로 들어온다.
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
            # 중복 제거(fam)는 Outcome 군 기준 그대로, 백분위는 실제 측정 단위 기준으로.
            p = raw_to_percentile(code, raw, effect_basis(code, pa))
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
