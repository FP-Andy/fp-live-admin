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
- 슛(G1)도 예외: 24코드는 하나여도 **결과가 점수를 가른다**. 슛·블록 [50,78] ·
  유효슛 [74,90] · 골 [84,100] 밴드를 쓰고, 밴드 안 위치는 골문 안 코스 품질이
  주축이며 xG 는 그 위의 난이도 보정이다(shot_outcome_score). 코드는 전부 G1
  그대로라 집계·앱 계약은 안 바뀐다.
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

# ── 슛 결과별 차등 채점 ──────────────────────────────────────────────────────
# 슛·유효슛·골은 24코드가 전부 G1 이고 원시 기대효과도 xG 하나뿐이라, 골이든 빗나간
# 슛이든 xG 가 같으면 점수가 같았다. 결과가 점수를 가르도록 결과별 밴드를 둔다.
#
# 상한은 '닿아야 할 목표' 가 아니라 **점근선**이다 — shape=1(최저 xG + 완벽한 코스)
# 일 때만 꼭대기에 닿아서, 실전 값은 상한 두어 점 아래에 머문다.
SHOT_SCORE_BANDS: dict[str, tuple[int, int]] = {
    "Shot": (50, 78),
    # 블록된 슛은 골문에 닿지 못해 xGOT 이 0 이다 — 코스를 잴 근거가 없어 빗나간 슛과 같은 밴드.
    "Blocked Shot": (50, 78),
    "Shot On Target": (74, 90),
    "Goal": (84, 100),
}

# xGOT(main._estimate_xgot)은 코스 품질만이 아니라
#     xgot = 0.58*xG + 0.24*코너 + 0.14*배치 + 보정
# 이라 xG 를 절반 넘게 품고 있다. 날것으로 쓰면 'xG 0.03 + 최고 코스'(0.386)와
# 'xG 0.60 + 최악 코스'(0.352)가 거의 같은 값이 되어 둘을 구분할 수 없다.
# 그래서 xG 성분을 걷어내고 **순수 코스 품질**만 남긴다.
XG_SHARE_IN_XGOT = 0.58
PLACEMENT_SPAN = 0.38      # 0.24(코너) + 0.14(배치) = 코스 성분이 차지할 수 있는 최대 폭
GOAL_BONUS_IN_XGOT = 0.03  # _estimate_xgot 이 골에 얹는 가산 — 밴드가 이미 골을 올리므로 뺀다

# 난이도 보정 강도(λ). 0.5 이상이면 'xG 높고 코스 높음' 과 'xG 높고 코스 낮음' 의
# 순서가 뒤집힌다 — 반드시 0.5 미만이어야 한다.
SHOT_DIFFICULTY_WEIGHT = 0.30

# '받은 지점 기대득점(receptionXg)' 으로 채점하는 액션. 어시스트·키패스만이다 —
# 일반 패스는 뒤에 슛이 있어도 그 슛과의 인과가 약해 기존 연결 슛 xG 를 그대로 쓴다.
RECEPTION_XG_ACTIONS = frozenset({"Assist", "Key Pass"})

# 어시스트 점수 밴드. 어시스트는 정의상 득점으로 이어진 패스라 **하방이 있어야 한다** —
# 밴드가 없으면 35m 중거리 골을 만든 어시스트가 51점, 즉 '할 수 있는 가장 나쁜
# 액션(50점)' 과 사실상 같은 자리에 떨어진다. 골이 났는데도.
#
# 하한 74 = 유효슛 밴드 하한과 같은 자리. '슛까지 갔다' 와 같은 바닥에서 시작한다.
# 상한 95 = 골 밴드(84~100) 안쪽. 뛰어난 어시스트가 평범한 골을 이길 수 있지만,
#           최고의 골(100)은 못 넘는다.
# 키패스(슛까지만 간 패스)는 아직 밴드가 없다 — 별도 결정 대기.
ASSIST_SCORE_BANDS: dict[str, tuple[int, int]] = {
    "Assist": (74, 95),
}


def assist_outcome_score(action: dict[str, Any], percentile: float) -> int | None:
    """어시스트 밴드 안 점수. 밴드가 없는 액션이면 None(=공통 변환을 그대로 쓴다).

    밴드 안 위치는 원시값(받은 지점 기대득점)의 백분위 그대로다 — 슛처럼 별도
    shape 을 두지 않는 이유는, 어시스트의 가치를 가르는 축이 '만들어 준 자리의 질'
    하나뿐이기 때문이다(코스 품질 같은 두 번째 축이 없다).
    """
    band = ASSIST_SCORE_BANDS.get(str(action.get("action") or ""))
    if band is None:
        return None
    lo, hi = band
    return int(round(lo + (hi - lo) * max(0.0, min(1.0, percentile))))


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


def shot_placement_quality(action: dict[str, Any]) -> float | None:
    """골문 안 어디로 보냈나 = 순수 코스 품질(0~1). 잴 근거가 없으면 None.

    xGOT 에서 xG 성분(XG_SHARE_IN_XGOT)과 골 가산을 걷어내면 `0.24*코너 + 0.14*배치`
    만 남는다 — 이게 선수가 실제로 한 일(코스 선택)이다. xGOT 을 날것으로 쓰면
    xG 가 절반 넘게 섞여 '어려운 자리에서 톱코너' 와 '쉬운 자리에서 키퍼 정면' 이
    같은 값이 된다.

    xGOT 미기록(None)과 빗나감(0.0)은 다르다 — 전자는 근거 없음이라 None 을 돌려
    호출부가 중립 처리하게 하고, 후자는 코스 품질 0 이 맞다.
    """
    xgot = action.get("xgot")
    if xgot is None:
        return None
    try:
        raw = float(xgot)
    except (TypeError, ValueError):
        return None
    if str(action.get("action") or "") == "Goal":
        raw -= GOAL_BONUS_IN_XGOT
    xg = float(action.get("xg") or 0)
    return max(0.0, min(1.0, (raw - XG_SHARE_IN_XGOT * xg) / PLACEMENT_SPAN))


def shot_outcome_shape(action: dict[str, Any]) -> float:
    """유효슛·골의 밴드 안 위치(0~1).

        shape = T + λ·Q·(1 − 2T)      T=코스 품질, Q=xG 백분위

    `(1 − 2T)` 가 Q 의 **부호를 뒤집는 게 핵심**이다:
      - 코스가 좋으면(T→1) xG 가 낮을수록 가점 — 어려운 걸 해냈다
      - 코스가 나쁘면(T→0) xG 가 높을수록 가점 — 자리는 잡았다
    그래서 'xG 낮고 코스 높음 > xG 높고 코스 높음 > xG 높고 코스 낮음 > xG 낮고
    코스 낮음' 순서가 나온다. 단순 가중합으로는 이 순서를 만들 수 없다(두 요구가
    반대 방향이라 선형 결합은 한쪽으로만 단조가 된다).
    """
    t = shot_placement_quality(action)
    if t is None:
        # xGOT 미기록 — 코스를 판단할 근거가 없다. 중립값 T=0.5 를 넣으면 식에서
        # Q 항이 (1−2·0.5)=0 으로 사라져 밴드 중앙이 된다. 없는 근거로 점수를
        # 올리지도 내리지도 않는다는 뜻이다.
        return 0.5
    q = raw_to_percentile("G1", float(action.get("xg") or 0), "goal") or 0.0
    return max(0.0, min(1.0, t + SHOT_DIFFICULTY_WEIGHT * q * (1.0 - 2.0 * t)))


def shot_outcome_score(action: dict[str, Any]) -> int | None:
    """슛 결과(슛·블록·유효슛·골)별 차등 점수. 슛류가 아니거나 근거가 없으면 None."""
    band = SHOT_SCORE_BANDS.get(str(action.get("action") or ""))
    if band is None:
        return None
    lo, hi = band
    if str(action.get("action") or "") in ("Shot", "Blocked Shot"):
        # 골문 안 코스가 없는 슛 — 기존대로 xG 만으로 잰다(현행 로직 유지).
        shape = raw_to_percentile("G1", float(action.get("xg") or 0), "goal")
        if shape is None:
            return None
    else:
        shape = shot_outcome_shape(action)
    return int(round(lo + (hi - lo) * shape))


def _raw_effect(code: str, action: dict[str, Any], linked_shot_xg: float | None) -> float | None:
    """액션의 원시 기대효과. 유효성 미달(<=0·근거 없음)이면 None."""
    if code == "G1":
        v = float(action.get("xg") or 0)
        return v if v > 0 else None
    if code in ("G2", "G3"):
        # 어시스트·키패스는 **받은 지점의 기대득점**으로 잰다(fpa._reception_chance_xg).
        # 연결 슛 xG 를 계승하면, 받은 뒤 드리블로 수비를 제치고 각을 만든 몫까지
        # 패서 점수에 섞인다 — 그건 슈터의 온전한 액션이다. 패서가 한 일은 '동료를
        # 그 자리에 세워준 것' 까지이고, 그 자리의 가치가 곧 어시스트의 값이다.
        if str(action.get("action") or "") in RECEPTION_XG_ACTIONS:
            received = action.get("receptionXg")
            if received is not None and float(received) > 0:
                return float(received)
            # 값이 없으면(프레임 없는 옛 행·single 모드) 기존 방식으로 넘어간다.
            # 여기서 None 을 돌려주면 점수가 통째로 사라진다(실제로 그 회귀가 있었다).
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
            # 결과별 밴드를 쓰는 액션 — 슛(G1)과 어시스트(G2). 나머지는 정본 변환 그대로.
            # xfpPercentile 은 어느 쪽이든 '원시값의 백분위' 라는 뜻을 유지한다 —
            # 밴드를 쓰면 점수와 1:1 대응하지 않으므로 대표 액션 선정은 점수 기준이다
            # (fineplay_fpa.analysis_from_actions 참조).
            banded = shot_outcome_score(pa) if code == "G1" else assist_outcome_score(pa, p)
            pa["xfpScore"] = banded if banded is not None else percentile_to_score(p)
            pa["xfpPercentile"] = round(p, 4)
