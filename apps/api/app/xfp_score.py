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
  태클·인터셉트·컷아웃·클리어 = 끊은 지점의 소유권 전환가치 × 회수 성공도
  (fpa._defense_turnover_value · DEFENSE_RETENTION, 전용 defense 곡선),
  블록 = 막은 슛 xG(goal 곡선). 네 액션의 순서는 산식의 회수 성공도가 만든다 —
  액션별 앵커로는 못 만든다(백분위가 그 곡선 자신의 분포로 매겨져 상쇄된다).
  defense 곡선은 '가치 눈금' 이다 — 산식이 낼 수 있는 값 범위(위치 x 4액션)를 덮게
  굽는다. 실측 빈도 분포에 맞추면 미드필드 수비가 정의상 하위권이 된다
  (xfp_anchors_v0.json 의 defense_scale_note).
- 슛(G1)도 예외: 24코드는 하나여도 **결과가 점수를 가른다**. 슛·블록 [50,78] ·
  유효슛 [74,90] · 골 [84,100] 밴드를 쓰고, 밴드 안 위치는 골문 안 코스 품질이
  주축이며 xG 는 그 위의 난이도 보정이다(shot_outcome_score). 코드는 전부 G1
  그대로라 집계·앱 계약은 안 바뀐다.
- 경합(S11/S12)도 예외: 볼 도착점을 안 찍는 점 액션이라 ΔEPV가 정의상 0이고, 남는
  재료가 ΔPC 하나뿐이었다. 경합 승리는 소유권 획득 사건이므로 수비와 같은 전환가치·
  같은 defense 곡선으로 재고(회수계수 Duel=0.85), 진 경합은 점수에서 뺀다
  (_FAILABLE_ACTIONS). 측정 지점은 after 프레임의 행위자 좌표다.
- 소유(ΔPC로 재는 S1~S4)도 예외: 측정이 분석관 태깅에 가장 크게 흔들리는
  축이라 상한을 내려 [50,80]으로 압축한다(POSSESSION_SCORE_BAND). 편차가 몇 '점'으로
  보이는지는 곡선 기울기에 비례하므로, 범위 압축이 그 편차를 직접 줄인다. 하한 50은
  '유효 액션 없음'의 자리라 건드리지 않는다.
- 압박(S9)도 예외: 같은 possession 군이지만 전용 밴드 [65,90](PRESS_SCORE_BAND). 태그
  자체가 '압박이 걸렸다'는 판정이라 하한이 서고, 팀 점수는 프레임 이동량 비율로 압박자
  개인에게 나뉜다(press_share_score · fpa.press_movement_shares).
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
# 다른 값으로 재고 있다:
#   DEFENSE_ARROW_CODES(태클·인터셉트·컷아웃·클리어) = 끊은 지점의 **소유권 전환가치**
#     (`fpa._defense_turnover_value` = 0.65×상대기준 EPV + 0.35×회수성공도×우리기준 EPV).
#     EPV 와 단위는 같아도 두 지점의 차가 아니라 한 지점의 레벨이라 스케일이 다르고,
#     각도 항도 수비 전용 바닥(DEFENSE_CENTRALITY_FLOOR)을 쓴다 → 전용 defense 곡선.
#   SHOT_BLOCK_CODES(블록) = 막은 슛 xG × BLOCK_CREDIT → goal 곡선.
# ΔPC 를 쓰면 수비는 정의상 '상대 통제 공간 → 우리 통제'로 통제 경계를 넘는 행위라
# ΔPC 가 늘 최대치에 붙어, 막은 위협이 0 이거나 음수인 액션까지 만점이 됐다.
#
# 전환가치는 '상대 공격방향 ΔEPV'(= 상대가 그 패스로 늘린 양)를 대체한 것이다. 옛 방식은
# 상대 진영이 상대에게도 빌드업 구간이라 0 에 가까워, 가장 가치 있는 하이프레스 차단이
# 최하점을 받았다(0.0015 → 53점). 기존 행은 옛 값이 남아 있어 백필이 필요하다
# (`scripts/backfill_defense_epv.py`) — 어시스트와 달리 원시값 자체가 바뀌었기 때문이다.
DEFENSE_CODES = frozenset({"S5", "S7"})

# 경합(듀얼)의 24코드. 자기 진영 S11 / 상대 진영 S12.
#
# 수비(S5/S7)와 **같은 이유로** ΔPC 를 안 쓴다. 경합은 볼 도착점을 안 찍는 점 액션이라
# ΔEPV 가 정의상 0 이고, 그래서 남는 재료가 ΔPC 하나뿐이었다 — 위 POSSESSION_SCORE_BAND
# 주석이 "태깅 편차에 가장 크게 흔들린다" 고 적어둔 바로 그 축이다. 게다가 정작 가진
# 정보인 '어디서 이겼나' 는 점수에 전혀 안 들어갔다.
#
# 경합 승리는 태클·인터셉트와 같은 소유권 획득 사건이므로 같은 전환가치로 재고
# (fpa._defense_turnover_value, 회수계수 Duel=0.85), 같은 defense 곡선을 쓴다.
# 진 경합은 애초에 점수에서 빠진다(fineplay_fpa._FAILABLE_ACTIONS) — 경합은 이겼냐
# 졌냐가 액션의 전부라, 진 것에 점수가 붙으면 태그 자체가 무의미해진다.
DUEL_CODES = frozenset({"S11", "S12"})

# 압박 — possession 군이지만 점이 아니라 영역 평균으로 재는 유일한 코드
# (fpa._press_region_pitch_control). 전용 밴드(PRESS_SCORE_BAND)와 점수 분배가 여기 걸린다.
PRESS_CODE = "S9"

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

# 찬스 창출 패스의 점수 밴드. 이들은 정의상 슛·득점으로 이어진 패스라 **하방이
# 있어야 한다** — 밴드가 없으면 35m 중거리 골을 만든 어시스트가 51점, 즉 '할 수
# 있는 가장 나쁜 액션(50점)' 과 사실상 같은 자리에 떨어진다. 골이 났는데도.
#
# 어시스트 하한 74 = 유효슛 밴드 하한과 같은 자리. '슛까지 갔다' 와 같은 바닥에서
# 시작한다. 상한 95 는 골 밴드(84~100) 안쪽이라, 뛰어난 어시스트가 평범한 골을
# 이길 수는 있어도 최고의 골(100)은 못 넘는다.
#
# 밴드는 **액션 이름**으로 붙는다 — 즉 분석관이 태그를 단 것만 받는다.
# `later_shot`(클립 뒤쪽에 슛이 있음)으로 자동 승격된 패스는 이름이 "Pass" 라
# 밴드가 없다. 의도한 것이다: later_shot 은 '사이에 드리블·패스가 몇 개 껴 있어도
# 뒤에 슛만 있으면 참' 이라 인과가 약하고, 태그는 분석관이 '이게 그 패스다' 라고
# 판단한 정보다. 약한 신호에까지 하방을 깔면 먼 패스가 과대평가된다.
PASS_SCORE_BANDS: dict[str, tuple[int, int]] = {
    "Assist": (74, 95),
    # 키패스는 어시스트와 **패서가 한 일이 같다** — 차이는 받은 사람이 넣었느냐뿐이고
    # 그건 슈터의 몫이다(연결 슛 xG 계승을 폐기한 것과 같은 논리). 그래서 격차를
    # 슛 밴드의 결과 격차(유효슛↔골 10점)보다 훨씬 작게 둔다. 골이 났다는 사실에
    # 소폭 가중만 주는 셈이다.
    "Key Pass": (70, 92),
}

# 패킹 가산의 최대 비중(밴드 폭 대비). 74~95 밴드에서 최대 약 5점.
# 받은 지점이 똑같이 좋아도 '수비를 몇 명 넘겨 넣어줬나' 로 갈리게 하는 항이다.
#
# 왜 xG 델타가 아니라 패킹인가 — 실측(로컬 14건) 상관계수:
#     corr(받은지점 xG, ΔxG)  = +0.97   ← 기본 점수와 사실상 같은 정보
#     corr(받은지점 xG, 패킹)  = -0.24   ← 독립적인 정보원(수비 배치)
# 어시스트는 대개 시작 지점이 골에서 멀어 시작 xG≈0 이라 ΔxG ≈ 받은 xG 가 된다.
# 그걸 가산으로 얹으면 같은 값을 두 번 세는 셈이라 순위가 거의 안 바뀐다.
PASS_PACKING_BONUS = 0.25

# ── 소유(ΔPC) 축의 점수 범위 압축 ────────────────────────────────────────────
# 소유는 **측정 자체가 분석관 태깅에 크게 흔들리는 축**이다. ΔPC 는 프레임에 찍힌
# 전원에 대한 비율식(fpa._pitch_control_at)이라, 경기적으로 무관한 아군을 한둘 더
# 찍었는지로 값이 움직인다. 같은 장면을 40명이 각자 태깅하는 시뮬레이션(좌표 오차
# σ=1.5m, 상대 1~5명 — `fpa.py` 가 기록한 실측 범위)에서:
#
#     점수 표준편차 7.8점 · 최대−최소 폭 30.7점
#
# 편차가 몇 '점' 으로 나타나는지는 **곡선 기울기에 비례**하므로, 범위를 좁히면 그만큼
# 직접 줄어든다 — 같은 태깅 편차에서 50~100 은 7.7점, 50~80 은 5.4점(−33%).
#
# 그리고 소유가 100 까지 갈 이유가 없다. 슛 밴드를 결과별로 나눈 것과 같은 논리다 —
# 볼을 지킨 행위가 골과 같은 상한을 가질 근거가 없다.
#
# **하한은 50 그대로 둔다 — 좁히는 건 상한으로만 한다.** 50 은 `fineplay_fpa`의
# XFP_PLACEHOLDER_SCORE(='유효 액션 없음')와 같은 자리다. 하한을 55 로 올리면 가치가
# 0 에 가까운 소유 태그 하나가 '아무것도 안 찍음'(50)을 이기고, clipScore 는 그 선수
# 액션 점수의 **max** 이며 경기 점수는 그 평균이라(fineplay_fpa.py:671) 그 +5 가 그대로
# 선수 점수로 흘러간다 — 태그를 찍을수록 유리한 구조가 된다. 어시스트(74)·골(84)의
# 하한이 50 보다 높은 건 '슛·골이 실제로 났다' 는 사실이 근거인데, 소유엔 그게 없다.
# 폭 30 은 상한만 내려도 얻는다 — 50~80 의 편차 감소는 55~85 와 사실상 같다(5.4 vs 5.3점).
#
# 적용 경계는 **effect_basis 가 possession 인 코드만** — 즉 실제로 ΔPC 로 재는
# S1/S2(소유 패스)·S3/S4(소유 드리블)다. 수비(S5/S7)와 경합(S11/S12)은 Outcome 이
# Possession 이어도 ΔPC 로 재지 않으므로(DEFENSE_CODES·DUEL_CODES 주석 참조) 건드리지
# 않고, 압박(S9)은 같은 군이어도 성격이 달라 전용 밴드를 쓴다(PRESS_SCORE_BAND).
POSSESSION_SCORE_BAND: tuple[int, int] = (50, 80)

# 압박(S9)은 같은 possession 군이어도 **전용 밴드**를 쓴다.
#
# 하한 65 — 압박은 태그 자체가 판정이다. 분석관이 `pr` 을 찍었다는 건 '압박이 걸렸다' 는
# 뜻이라(실패한 압박은 애초에 안 찍는다), 어시스트(74)·골(84) 하한과 같은 근거가 선다.
# 소유 패스와 결정적으로 다른 지점이다 — 소유는 ΔPC>0 이기만 하면 붙어서 '가치 0 에 가까운
# 태그' 가 존재하지만, 압박은 그런 게 없다.
#
# 상한 90 — 골(100)·어시스트(95)보다 낮게 둔다. 압박은 볼을 되찾을 조건을 만든 행위지
# 되찾은 것 자체가 아니다(그건 태클·인터셉트가 따로 받는다).
#
# 부수 효과로 **앵커 오차가 완화된다.** 압박만 점이 아니라 영역 평균으로 재서 델타
# 스케일이 다른데(`scripts/pc_anchor_rebake.py` 머리말) S9 전용 앵커가 아직 없어 점
# 곡선으로 채점되는 중이다. 폭 25 로 좁히면 그 곡선 오차가 점수에 미치는 폭도 그만큼 준다.
# 전용 앵커가 들어오면 밴드는 그대로 두고 곡선만 갈아끼우면 된다.
PRESS_SCORE_BAND: tuple[int, int] = (65, 90)


def possession_outcome_score(code: str, action: dict[str, Any], percentile: float) -> int | None:
    """ΔPC 로 재는 액션의 밴드 안 점수. 그 축이 아니면 None(=공통 변환 그대로)."""
    if effect_basis(code, action) != "possession":
        return None
    lo, hi = PRESS_SCORE_BAND if code == PRESS_CODE else POSSESSION_SCORE_BAND
    return int(round(lo + (hi - lo) * max(0.0, min(1.0, percentile))))


# ── 압박(S9) 점수 분배 ──────────────────────────────────────────────────────
# 압박은 팀 단위 행위라 번호 없이 찍히고, 그래서 채점된 점수가 **어느 선수에게도 붙지
# 않았다** — `fineplay_fpa.analysis_from_actions` 의 by_player 는 playerId 가 있는 행만
# 담는데 압박 행은 등번호가 비어 있다. 설계 의도는 처음부터 '압박자=프레임에 찍힌 아군'
# 이었고(fpa.py 의 ACTION_CODES 주석·설정 도움말) 분배 공식만 미구현이었다.
#
# 분배는 프레임 이동량으로 한다(fpa.press_movement_shares). 이동량이 곧 '누가 조였나' 다.
XFP_BASE_SCORE = 50  # percentile_to_score 의 바닥 = fineplay_fpa.XFP_PLACEHOLDER_SCORE


def press_share_score(team_score: int, share: float) -> int:
    """압박 팀 점수를 개인 기여 비율로 깎은 점수. share=1 이면 팀 점수 그대로.

        점수 = 50 + (팀 점수 − 50) × 비율

    50 을 축으로 깎는다 — 팀 점수를 그대로 곱하면(예: 90×0.5=45) 기본점수 50 아래로
    내려가 '아무것도 안 한 것보다 나쁜 압박' 이 되어버린다. 50 은 '유효 액션 없음' 의
    자리이므로 기여가 0 에 가까운 선수가 수렴할 곳이 정확히 거기다.

    PRESS_SCORE_BAND 하한 65 와의 관계 — **하한은 팀 행위에 붙지 개인에 붙지 않는다.**
    '압박이 걸렸다' 는 판정은 장면 하나에 대한 것이고, 그 안에서 누가 얼마나 조였는지는
    이동량이 가른다. 그래서 가장 많이 조인 선수(비율 1.0)가 팀 점수를 온전히 받아 하한
    65 를 보장받고, 곁다리로 따라간 선수는 그 아래로 내려간다. 개인마다 65 를 깔면
    프레임에 많이 찍을수록 65 짜리 선수가 늘어나는 구조가 된다(패킹에서 절대 인원수를
    버린 것과 같은 이유). 애초에 조이지 않은 선수는 PRESS_MIN_MOVE_M 문턱에서 빠진다.

    팀 점수 자체(백분위 곡선·앵커)는 건드리지 않는다 — S9 전용 앵커가 없어 점 곡선으로
    채점되는 문제는 별건이고, 분배는 그 위에 얹는 층이다.
    """
    s = max(0.0, min(1.0, float(share)))
    return int(round(XFP_BASE_SCORE + (team_score - XFP_BASE_SCORE) * s))


def pass_outcome_score(action: dict[str, Any], percentile: float) -> int | None:
    """어시스트·키패스 밴드 안 점수. 밴드가 없는 액션이면 None(=공통 변환 그대로).

    밴드 안 위치 = 받은 지점 기대득점의 백분위 + 패킹 가산.
    패킹(fpa._packing_ratio)은 그 패스가 넘어선 상대의 비율이라, '하프라인에서 박스로
    한 방에 넣어준 패스' 와 '박스 옆에서 툭 내준 패스' 를 가른다 — 받은 지점이 같아도.
    값이 없으면(프레임 없음·상대 점 부족) 가산 0 이라 기존 동작 그대로다.
    """
    band = PASS_SCORE_BANDS.get(str(action.get("action") or ""))
    if band is None:
        return None
    lo, hi = band
    shape = max(0.0, min(1.0, percentile))
    packing = action.get("packing")
    if packing is not None:
        shape = min(1.0, shape + PASS_PACKING_BONUS * max(0.0, min(1.0, float(packing))))
    return int(round(lo + (hi - lo) * shape))


# ── 경로 판정: 전진/소유 중 어느 축으로 채점할지 ─────────────────────────────
# 패스·드리블은 ΔEPV(전진)와 ΔPC(소유)를 **둘 다** 갖는다. 그런데 24코드는 액션당
# 하나(P* 아니면 S*)이고 코드가 곧 채점 재료를 정하므로, 하나를 고르고 나머지를 버려야
# 한다. 그 선택을 `axis_scores` → `prefer_progression` 이 한다.
#
# 왜 원값 비교(`epv >= pc`)를 버렸나
# --------------------------------
# 두 값은 단위가 다르다. 같은 백분위를 만드는 원값이 일관되게 5배 차이난다:
#
#     백분위 0.25 → ΔEPV 0.0072 · ΔPC 0.0375   (5.2배)
#     백분위 0.75 → ΔEPV 0.0275 · ΔPC 0.1500   (5.5배)
#
# 그런데 ΔEPV 는 전진 앵커 최상단이 0.075 언저리라 그 위로 올라갈 수 없다. ΔPC 0.075
# 는 소유 곡선에서 백분위 0.47 — 겨우 중간이다. 즉 **ΔPC 가 중앙값만 넘어서면 전진이
# 아무리 커도 `epv >= pc` 가 거짓이 되어 전진 경로가 후보에서 사라졌다.** 큰 전진 패스가
# 소유로 빠져 94점 대신 60점을 받았다(최대 −34점).
#
# 왜 백분위 비교가 아니라 점수 비교인가
# ----------------------------------
# 백분위끼리 비교하면 단위는 맞지만 **경계에서 점수가 불연속으로 뛴다** — 두 축의 밴드가
# 다르므로(전진 50~100 · 소유 50~80) 같은 백분위에서 최대 18점 차이가 난다. 그리고 ΔPC
# 는 태깅에 크게 흔들리는 값이라(찍은 인원·좌표) 경계를 자주 넘나든다. 합성 실험에서
# 백분위 비교는 경로 플립률이 3.7% → 20.8% 로 뛰었다.
#
# 최종 점수의 max 를 쓰면 두 연속함수의 max 라 **경계에서 연속**이다. 플립이 나도 점수가
# 안 튄다. 그리고 max 는 대개 더 안정적인 전진 축을 따라가게 되므로(ΔEPV 는 볼 좌표
# 4개만 쓰고 다른 선수 위치와 무관하다 — fpa._epv_delta), ΔPC 의 변동이 최종 점수에
# 거의 닿지 못한다. 같은 실험에서 분석관 간 점수 표준편차가 5.7점 → 3.0점(−47%)이었다.
#
# 소유 상한(POSSESSION_SCORE_BAND)은 그대로 유효하다 — 전진이 없는 액션(ΔEPV ≤ 0,
# 후진·횡패스)은 전진 점수가 아예 없어 소유 점수가 그대로 최종값이 된다.
def axis_scores(
    action: dict[str, Any], *, progression_code: str, possession_code: str
) -> tuple[int | None, int | None]:
    """(전진 점수, 소유 점수). 그 축의 원시값이 없거나 0 이하면 그쪽은 None."""
    prog: int | None = None
    epv = float(action.get("epv") or 0)
    if epv > 0:
        p = raw_to_percentile(progression_code, epv, "progression")
        if p is not None:
            prog = percentile_to_score(p)

    poss: int | None = None
    pc = float(action.get("pc") or 0)
    if pc > 0:
        p = raw_to_percentile(possession_code, pc, "possession")
        if p is not None:
            banded = possession_outcome_score(possession_code, action, p)
            poss = banded if banded is not None else percentile_to_score(p)

    return prog, poss


def prefer_progression(action: dict[str, Any], *, progression_code: str, possession_code: str) -> bool:
    """전진 축으로 채점해야 하나 — 두 축의 최종 점수를 비교해 높은 쪽.

    둘 다 없으면 False(소유 코드로 떨어지고, 원시값이 없어 점수는 붙지 않는다) —
    원값 비교 시절과 같은 동작이다.
    """
    prog, poss = axis_scores(action, progression_code=progression_code, possession_code=possession_code)
    if prog is None:
        return False
    return poss is None or prog >= poss


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
    그대로 쓰고, 나머지(태클·인터셉트·컷아웃·클리어)는 끊은 지점의 **소유권 전환가치**
    (`_defense_turnover_value`)라 EPV 와 단위는 같아도 델타가 아니라 레벨이라 스케일이
    다르다 — 전용 defense 곡선으로 잰다.

    네 액션이 **한 곡선을 공유하는 것이 설계**다. 액션마다 곡선을 따로 주면 회수
    성공도(DEFENSE_RETENTION)의 곱셈이 백분위에서 상쇄돼 순서가 사라진다.
    """
    if code in DEFENSE_CODES:
        return "goal" if float(action.get("xg") or 0) > 0 else "defense"
    # 경합도 같다 — 이긴 자리의 소유권 전환가치로 재므로 defense 곡선(DUEL_CODES 주석).
    if code in DUEL_CODES:
        return "defense"
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
    """정본 규칙대로 유효 Effect Action 에 xfpScore·xfpPercentile 을 주석한다(제자리).

    입력은 actionCode·groupIndex 가 이미 붙은 페이로드 액션 목록. 선정되지 못한
    액션은 점수 없이 남는다 (정본: 유효 Effect Action 만 점수화).

    중복 제거는 (장면, 행위자) 단위다 — 아래 groups 주석 참조.
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

    # 중복 제거 단위는 **행위자** 다 (장면이 아니다).
    #
    # 정본(xFP 24개 액션 정의 3.5.1)은 "한 event_id 는 조건을 충족하면 G·P·S Action 을
    # 각각 하나씩 생성할 수 있다" 고 쓴다 — 중복 방지의 단위가 event, 곧 한 선수의 한 행위다.
    # 3.5.2 는 못을 박는다: "대표 Action 선택은 화면의 요약 규칙일 뿐, 나머지 Action 을
    # 점수·6축에서 제외하는 규칙이 아니다."
    #
    # 그런데 groupIndex 는 event 가 아니라 **장면** 이다(fineplay_fpa._assign_action_groups —
    # 같은 SceneState 를 공유하는 여러 선수의 여러 행). 장면 단위로 "Outcome 군당 1개" 를
    # 걸면 서로 무관한 선수들이 서로를 밀어낸다:
    #   - 골 장면에서 어시스트(G2)가 슈팅(G1)에 밀려 무득점 — 둘 다 goal 군
    #   - 소유 패스(S2)·수비(S5/S7)·압박(S9)·듀얼(S11/S12)이 전부 possession 군이라
    #     한 장면에 같이 찍히면 넷 중 하나만 살아남는다
    #   - 전진 패스와 짝지어진 침투(P6)가 거의 항상 탈락한다 — 둘 다 progression 군
    # 행위자로 쪼개면 각자 자기 행위의 점수를 받는다. 한 선수가 한 장면에서 여러 번
    # 찍혀도 그 안에서는 정본 규칙(군당 1개·최대 3개)이 그대로 걸리고, 선수 점수는
    # clipScore = max(액션 점수) 라 인플레도 생기지 않는다.
    #
    # 등번호가 없는 행(압박 'pr' 은 팀 단위라 번호를 안 찍는다)은 팀별로 한 덩어리가 된다.
    groups: dict[Any, list[dict[str, Any]]] = {}
    for i, pa in enumerate(payload_actions):
        scene = pa.get("groupIndex") if pa.get("groupIndex") is not None else f"solo-{i}"
        key = (scene, pa.get("teamSide"), pa.get("jersey"))
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
            if code == "G1":
                banded = shot_outcome_score(pa)
            else:
                # 어시스트·키패스 밴드가 먼저다 — 이들은 G2(goal 군)라 소유 압축과 겹치지 않는다.
                banded = pass_outcome_score(pa, p)
                if banded is None:
                    banded = possession_outcome_score(code, pa, p)
            pa["xfpScore"] = banded if banded is not None else percentile_to_score(p)
            pa["xfpPercentile"] = round(p, 4)
