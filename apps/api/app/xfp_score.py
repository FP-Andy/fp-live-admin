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
- 돌파(Breakthrough)도 예외: 드리블과 24코드가 같아 '제쳤다'가 점수에 안 들어가므로,
  완성된 점수를 [70,100]으로 옮긴다(BREAKTHROUGH_SCORE_BAND). 백분위를 다시 펴는
  다른 밴드와 달리 **아핀 변환이라 분포 모양이 보존**되고, 축과 무관하게 마지막에 건다.
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

# 세이브(골키퍼) — 2026-09-07 신설.
#
# 그전까지 Save 는 `classify_action_code` 가 24코드를 안 붙여 **점수가 아예 계산되지
# 않았다**. 키퍼는 무슨 선방을 하든 XFP_PLACEHOLDER_SCORE(50, '유효 액션 없음')에
# 머물렀다 — 월드클래스 선방과 아무것도 안 한 선수의 클립 점수가 같았다.
#
# 재는 값은 **xGOT** 이다. xG 가 아니다.
#   xG   = 그 자리에서 쏘면 들어갈 확률 → 슈터의 몫이다.
#   xGOT = 그 코스로 온 유효슛이 들어갈 확률 → **키퍼가 실제로 마주한 난이도**다.
# 같은 12m 에서 와도 톱코너와 정면은 전혀 다른 선방인데 xG 는 둘을 구분하지 못한다.
# 블록(qw)이 xG 를 쓰는 건 코스가 정해지기 **전에** 몸을 던지는 행위라서고, 세이브는
# 코스가 정해진 **뒤의** 행위다.
#
# 채점은 **두 축을 각각 줄세워 섞는다** (2026-09-07 운영 결정):
#     score = 75 + 25 × (0.65×xGOT백분위 + 0.35×xG백분위)
#
# 왜 goal 곡선을 그대로 쓰면 안 되나 — 그 곡선은 '모든 슛의 xG' 분포(대부분 0.05 이하)로
# 구운 것이다. 반면 세이브의 xGOT 은 **유효슛이었던 공만** 모인 훨씬 높은 분포라
# (막은 슛 6000개 시뮬레이션 중앙값 0.176) 전부 꼭대기에 붙었다 — 중앙값 92점,
# 90점 이상이 67.4%. 그래서 세이브 전용 앵커(save_xgot·save_xg)를 따로 둔다.
#
# ⚠️ 두 축은 독립이 아니다. xGOT 공식이 xG 를 58% 품고 있어(XG_SHARE_IN_XGOT)
# 실측 corr(xG, xGOT) = +0.64 다. 즉 xG 를 따로 넣는 건 같은 정보를 일부 두 번 세는
# 것이고, 같은 xGOT 안에서 xG 가 높다는 건 '가까운 데서 나쁜 코스로 온 슛'을 뜻한다
# (실측: xG 높은 20% 의 코스품질 0.35 vs 낮은 20% 의 0.64). 그걸 알고도 넣기로 한
# 결정이다 — 가까운 거리는 반응시간이 짧다는 판단. 되돌리려면 SAVE_XG_WEIGHT 를 0 으로.
SAVE_SCORE_BAND: tuple[int, int] = (75, 100)
SAVE_XGOT_WEIGHT = 0.65
SAVE_XG_WEIGHT = 0.35

# 밴드 안 위치를 **볼록하게** 휜다 — `mix ** SAVE_SCORE_GAMMA`.
#
# 백분위를 그대로 곱하면 점수가 밴드에 **균등하게** 깔린다(백분위는 정의상 균등하다).
# 그러면 90점 이상이 38% 나온다 — 고득점이 흔해서 '잘 막았다' 가 안 된다.
# γ>1 이면 낮은 쪽은 완만하고 높은 쪽만 가파르게 올라가, 100 에 가까울수록 희귀해진다.
#
# γ=2.5 인 이유 (막은 슛 6000개 시뮬레이션):
#     γ    중앙값   90점+    98점+
#     1.0    87    38.0%    7.1%   ← 균등, 고득점이 흔하다
#     2.5    79    13.9%    3.1%   ← 채택
#     4.0    76     8.6%    1.9%   ← 과하다(아래 참조)
# 열 번에 한 번쯤 90점대가 나오고 98점 이상은 경기당 한 번 볼까 말까가 된다.
# **최상급은 안 깎인다** — 일대일·톱코너 세이브는 여전히 97~99점이다.
# γ=4 는 '살짝 까다로운' 세이브(79점)와 정면 약슛(75점)의 차이를 4점까지 눌러
# 변별이 아까운 구간까지 뭉갠다.
SAVE_SCORE_GAMMA = 2.5
#
# ⚠️ 코드 S13 은 **잠정 배정**이다. 노션 『xFP 24개 액션 정의』의 정본 배정을 확인하지
# 못했다(비어 있는 슬롯은 S6·S8·S10·S13·S14). 정본이 다르면 이 상수만 바꾸면 된다.
SAVE_CODE = "S13"

# 캐칭·펀칭(골키퍼) — 2026-09-07 신설. Save 와 같은 이유로 그전까지 점수가 없었다.
#
# 재는 값은 **상대가 찬 위치의 위협 × 회수계수**다(fpa._gk_claim_value). 대부분
# 크로스라 킥 위치가 곧 그 공이 만들던 위협의 크기고, 캐칭/펀칭은 회수계수로 갈린다.
#
# **전용 곡선(gk_claim)을 쓴다.** defense 곡선을 그대로 쓰면 크로스 원점이 전부 그
# 곡선의 꼭대기 꼬리에 몰려 거의 모든 캐칭이 96~99점이 된다(실측: 크로스류 점수 폭
# 7점, 표본의 93%가 90점 이상). 전용 곡선에서는 캐칭 68~94 · 펀칭 51~74 로 펴지고
# 같은 자리에서 캐칭−펀칭이 평균 20점 갈린다(기존 계수·곡선으로는 2점이었다).
#
# 두 액션이 **한 코드·한 곡선을 공유하는 것이 설계**다. 액션마다 곡선을 따로 주면
# 회수계수의 곱셈이 백분위에서 상쇄돼 캐칭과 펀칭의 순서가 사라진다(DEFENSE_CODES 와
# 같은 이유).
#
# ⚠️ S14 도 SAVE_CODE 와 같이 **잠정 배정**이다 — 정본 확인 후 상수만 바꾸면 된다.
GK_CLAIM_CODE = "S14"

# 캐칭·펀칭 밴드와 곡선 (2026-09-07 운영 결정).
#
#     score = 밴드하한 + 밴드폭 × 백분위 ** GK_CLAIM_SCORE_GAMMA
#
# **액션별로 밴드가 다르다.** 캐칭은 잡아서 소유권까지 가져오고 펀칭은 위협만 지우므로,
# 같은 자리에서 처리했어도 캐칭이 위다. 두 밴드가 겹치는 구간을 두는 건 의도다 —
# 좋은 자리의 펀칭이 나쁜 자리의 캐칭보다 높을 수 있어야 한다.
#
# 상한 93/89 — 세이브(100)보다 낮다. 크로스를 처리한 건 위협을 지운 것이지 골을 막은
# 게 아니다. 하한 65/58 — 압박과 같은 근거다(태그 자체가 '처리했다' 는 판정이다).
#
# ⚠️ 밴드가 캐칭/펀칭을 가르므로 **회수계수는 곱하지 않는다**(fpa._gk_claim_value).
# 둘 다 걸면 펀칭이 이중으로 깎여, 자기 밴드 바닥에 몰린다.
#
# 세이브와 같이 **볼록하게**(γ=2.5) 휜다 — 백분위를 그대로 쓰면 점수가 밴드에 균등하게
# 깔려 고득점이 흔해진다. 캐칭 기준 90점 이상이 12.4% → 5.0% 가 된다.
GK_CLAIM_SCORE_BANDS: dict[str, tuple[int, int]] = {
    "Catching": (65, 93),
    "Punching": (58, 89),
}
GK_CLAIM_SCORE_BAND_DEFAULT: tuple[int, int] = (58, 89)
GK_CLAIM_SCORE_GAMMA = 2.5


def gk_claim_outcome_score(action: dict[str, Any], percentile: float) -> int:
    """캐칭·펀칭의 밴드 안 점수 — GK_CLAIM_SCORE_BANDS 주석 참조.

    액션 이름을 못 읽으면(구버전 행) 낮은 쪽 밴드를 쓴다 — 모르는 처리에 캐칭의
    상한을 주는 것보다 안전하다.
    """
    lo, hi = GK_CLAIM_SCORE_BANDS.get(
        str(action.get("action") or ""), GK_CLAIM_SCORE_BAND_DEFAULT
    )
    shaped = max(0.0, min(1.0, percentile)) ** GK_CLAIM_SCORE_GAMMA
    return int(round(lo + (hi - lo) * shaped))

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
# ⚠️ 이 하한은 **'실패한 압박은 안 찍는다' 는 운영 전제 위에 서 있다**(2026-09-07 재확인).
# 압박이 상대 볼 경로를 화살표로 찍게 되면서(fpa.PRESS_ARROW_CODES) 뚫린 압박도 '기록
# 가능한 모양' 이 됐지만, 찍지 않기로 정했다. 전제가 깨지면 — 뚫린 압박이 최소 65 점을
# 받아 '아무것도 안 찍음'(50)을 이긴다. 그때는 이 밴드를 손대지 말고
# `fineplay_fpa._FAILABLE_ACTIONS` 에 Press 를 넣어라. 돌파(BREAKTHROUGH_SCORE_BAND)가
# 같은 전제·같은 처방을 쓴다.
#
# 상한 90 — 골(100)·어시스트(95)보다 낮게 둔다. 압박은 볼을 되찾을 조건을 만든 행위지
# 되찾은 것 자체가 아니다(그건 태클·인터셉트가 따로 받는다).
#
# 부수 효과로 **앵커 오차가 완화된다.** 압박만 점이 아니라 영역 평균으로 재서 델타
# 스케일이 다른데(`scripts/pc_anchor_rebake.py` 머리말) S9 전용 앵커가 아직 없어 점
# 곡선으로 채점되는 중이다. 폭 25 로 좁히면 그 곡선 오차가 점수에 미치는 폭도 그만큼 준다.
# 전용 앵커가 들어오면 밴드는 그대로 두고 곡선만 갈아끼우면 된다.
#
# 2026-09-07 로 채점 영역이 '프레임 전원 hull' → '상대 볼 경로 8m 캡슐' 로 바뀌면서
# **델타 스케일이 또 달라졌다**(같은 성공 장면에서 −0.020 → +0.093). 전용 앵커의 필요가
# 그만큼 커졌다 — 새 태깅이 쌓이면 실측 분포로 구워야 한다.
PRESS_SCORE_BAND: tuple[int, int] = (65, 90)

# ── 돌파(Breakthrough) 하한 ─────────────────────────────────────────────────
# 돌파와 드리블은 24코드가 같다(P4/P5·S3/S4 — classify_action_code 가 한 분기로 묶는다).
# 그래서 채점 재료가 ΔEPV·ΔPC 뿐이고, 이건 **어디서 어디로 갔는지**의 함수다. 즉
# '상대를 제쳤다' 는 사실이 점수에 한 톨도 안 들어간다:
#
#     빈 공간에서 (70,34)→(80,34) 드리블      67점
#     수비 셋 제치고 (70,34)→(80,34) 돌파     67점   ← 같다
#
# 돌파는 태깅 단계에서 이미 '제쳤다' 는 판정이 끝난 태그다(제치지 못했으면 드리블로
# 찍는다). 압박(pr) 하한 65 와 같은 근거다 — 태그 자체가 판정인 액션.
#
# **분포 모양은 그대로 두고 구간만 올린다.** 백분위를 선형으로 펴는 기존 밴드 방식
# (PASS_SCORE_BANDS·SHOT_SCORE_BANDS)과 다르다: 그 방식은 변환표의 구간별 기울기를
# 지워 분포가 눌린다. 여기서는 완성된 점수(50~100)를 그대로 [70,100] 으로 옮기는
# 아핀 변환이라, 드리블 분포의 순서·간격 비율이 보존된다.
#
#     자기 진영 10m  55 → 73      상대 진영 18m  77 → 86
#     상대 진영 10m  67 → 80      박스까지 20m   90 → 94
#
# **축과 무관하게** 최종 점수에 건다. 옆으로 간 돌파는 ΔEPV≤0 이라 소유 축(50~80)으로
# 떨어지는데, 거기만 빼면 "돌파는 최소 70" 이 깨진다. 소유 축의 낮은 상한은 아핀
# 변환 뒤에도 그대로 남는다(80 → 88).
#
# ⚠️ 실패한 돌파는 지금 점수에서 안 빠진다. fineplay_fpa._FAILABLE_ACTIONS 가
# {Pass, Cross} 뿐이라 코드 `e`(실패 돌파)에 Fail 태그가 붙어도 그대로 채점된다.
# **실패 코드를 안 찍는다는 운영 전제로 이 하한을 넣었다**(2026-08-14 결정). 전제가
# 깨지면 — 실패 돌파가 성공한 드리블보다 높아진다(6m 뺏긴 돌파 60 → 76). 그때는
# 밴드를 손대지 말고 _FAILABLE_ACTIONS 에 Breakthrough 를 넣어라.
BREAKTHROUGH_SCORE_BAND: tuple[int, int] = (70, 100)

# percentile_to_score 의 출력 범위 — 위 아핀 변환의 원본 구간이다.
SCORE_RANGE: tuple[int, int] = (50, 100)

# ── 경합(S11/S12) 전용 밴드 ────────────────────────────────────────────────
#
# 경합은 EPV(끊은 자리의 소유권 전환가치)로 줄세운다. 그런데 공통 변환을 그대로 타면
# 수비 위치 특성상 원값이 쉽게 defense 앵커 상단(0.0305/0.0381/0.0419)에 닿아, 평범한
# 우리 진영 경합이 90 점대를 받았다. 경합은 경기당 수십 번 일어나는 행위라 그 눈금으로는
# 다른 액션과 견줄 수가 없다.
#
# 그래서 [60, 89] 로 옮긴다. 하한 60 은 '이긴 경합은 어쨌든 값이 있다'는 바닥이고,
# 상한 89 는 태클·인터셉트 같은 명시적 탈취 위로 올라가지 않게 둔 천장이다.
# 경합 액션 코드 — 우리 진영(S11)/상대 진영(S12). fineplay_fpa.classify_action_code 참조.
DUEL_ACTION_CODES: frozenset[str] = frozenset({"S11", "S12"})
DUEL_SCORE_BAND: tuple[int, int] = (60, 89)

# 밴드 안에서는 **가운데가 두꺼운** 분포를 만든다.
#
# 백분위는 정의상 균등분포다. 그걸 밴드에 선형으로 얹으면 60 점도 89 점도 평범한 경합만큼
# 흔해진다 — 대부분의 경합은 고만고만한데 점수만 넓게 퍼지는 모양이다. 그래서 백분위를
# 정규분포의 분위수로 되돌려(Φ⁻¹) 밴드에 얹는다. 결과적으로 점수는 구간 한가운데
# (74.5)를 평균으로 모이고 양 끝은 드물어진다 — 정말 값진 경합과 그저 그런 경합이
# 점수로 갈린다.
#
# z 를 ±3σ 로 잘라 밴드 폭에 맞춘다(σ ≈ 14.5/3 ≈ 4.83). 3σ 밖은 양 끝 0.27% 라
# 잘라도 분포 모양이 상하지 않는다.
DUEL_SCORE_SIGMA_SPAN = 3.0


def _inverse_normal_cdf(p: float) -> float:
    """표준정규 분위수 Φ⁻¹(p). Acklam 근사 — 소수점 아래 아홉 자리까지 맞는다.

    statistics.NormalDist().inv_cdf 로도 되지만, 이 모듈은 표준 라이브러리 밖 의존을
    늘리지 않고 순수 계산만 담아 두는 쪽이라 직접 쓴다(다른 산식들과 같은 방식).
    """
    if p <= 0.0:
        return -DUEL_SCORE_SIGMA_SPAN
    if p >= 1.0:
        return DUEL_SCORE_SIGMA_SPAN
    a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02,
         1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00]
    b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02,
         6.680131188771972e+01, -1.328068155288572e+01]
    c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00,
         -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00]
    d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00,
         3.754408661907416e+00]
    plow, phigh = 0.02425, 1 - 0.02425
    if p < plow:
        q = (-2 * __import__("math").log(p)) ** 0.5
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
               ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    if p > phigh:
        q = (-2 * __import__("math").log(1 - p)) ** 0.5
        return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / \
               ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
    q = p - 0.5
    r = q * q
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / \
           (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)


def duel_outcome_score(percentile: float) -> int:
    """경합 백분위 → [60, 89] 안의 점수. 가운데가 두꺼운 분포가 되게 얹는다."""
    p = max(0.0, min(1.0, float(percentile)))
    lo, hi = DUEL_SCORE_BAND
    center = (lo + hi) / 2.0
    sigma = (hi - lo) / 2.0 / DUEL_SCORE_SIGMA_SPAN
    z = max(-DUEL_SCORE_SIGMA_SPAN, min(DUEL_SCORE_SIGMA_SPAN, _inverse_normal_cdf(p)))
    return int(round(max(lo, min(hi, center + sigma * z))))


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


def breakthrough_band_score(action: dict[str, Any], score: int) -> int:
    """돌파면 완성된 점수를 [70,100] 으로 옮긴다. 그 외 액션은 그대로.

    아핀 변환이라 **분포 모양이 보존**된다 — 드리블에서 55/67/77/90 이던 것이
    73/80/86/94 가 되고 순서·간격 비율은 그대로다. 백분위를 다시 펴지 않는 이유는
    BREAKTHROUGH_SCORE_BAND 주석 참조.

    축(전진/소유)을 가리지 않고 최종 점수에 건다 — 옆으로 간 돌파만 소유 축으로
    떨어져 하한을 못 받는 일이 없게.
    """
    if str(action.get("action") or "") != "Breakthrough":
        return score
    lo, hi = BREAKTHROUGH_SCORE_BAND
    base_lo, base_hi = SCORE_RANGE
    shape = (score - base_lo) / (base_hi - base_lo)
    return int(round(lo + (hi - lo) * max(0.0, min(1.0, shape))))


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
    # 세이브는 전용 곡선(save_xgot)으로 잰다 — goal 곡선은 스케일이 안 맞는다(SAVE_CODE 주석).
    if code == SAVE_CODE:
        return "save_xgot"
    # 캐칭·펀칭은 킥 위치 위협 × 회수계수 → 전용 gk_claim 곡선(GK_CLAIM_CODE 주석).
    if code == GK_CLAIM_CODE:
        return "gk_claim"
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


def save_outcome_score(action: dict[str, Any]) -> int | None:
    """세이브(S13)의 점수 — 두 축을 각각 줄세워 섞어 밴드에 얹는다.

        score = 75 + 25 × (0.65×xGOT백분위 + 0.35×xG백분위) ** 2.5

    지수 2.5 가 고득점을 희귀하게 만든다(SAVE_SCORE_GAMMA).
    근거와 주의는 SAVE_SCORE_BAND 위 주석 참조. xGOT 이 없으면(골문 코스 미입력)
    잴 근거가 없어 None — 호출부가 점수를 안 준다.

    xG 가 없으면 xGOT 축만으로 밴드를 채운다. 0 으로 깎지 않는다 — 근거가 없는 것과
    값이 낮은 것은 다르고, 전자로 점수를 내리면 '기록이 덜 된 세이브' 가 벌을 받는다.
    """
    try:
        xgot = float(action.get("xgot") or 0)
    except (TypeError, ValueError):
        return None
    if xgot <= 0:
        return None
    p_xgot = raw_to_percentile(SAVE_CODE, xgot, "save_xgot")
    if p_xgot is None:
        return None
    try:
        xg = float(action.get("xg") or 0)
    except (TypeError, ValueError):
        xg = 0.0
    p_xg = raw_to_percentile(SAVE_CODE, xg, "save_xg") if xg > 0 else None
    if p_xg is None:
        mix = p_xgot
    else:
        mix = SAVE_XGOT_WEIGHT * p_xgot + SAVE_XG_WEIGHT * p_xg
    lo, hi = SAVE_SCORE_BAND
    # 볼록 곡선 — 100 에 가까울수록 희귀해진다(SAVE_SCORE_GAMMA 주석).
    shaped = max(0.0, min(1.0, mix)) ** SAVE_SCORE_GAMMA
    return int(round(lo + (hi - lo) * shaped))


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
    if code == SAVE_CODE:
        # 세이브는 **xGOT** 으로 잰다 — 키퍼가 마주한 실제 난이도(SAVE_CODE 주석).
        # xG 로 폴백하지 않는다. 골문 코스를 안 찍었으면 '어려운 선방이었다' 는 근거가
        # 없는 것이고, 그때 슛 위치 xG 로 대신 채우면 정면으로 온 쉬운 공도 자리만
        # 좋으면 고득점이 된다. 근거가 없으면 점수를 주지 않는 쪽이 맞다.
        v = float(action.get("xgot") or 0)
        return v if v > 0 else None
    # 수비는 Outcome 이 Possession 이어도 ΔPC 를 쓰지 않는다 — 아래 주석 참조.
    fam = effect_basis(code, action)
    if fam == "goal":  # 슛블락 — 막은 슛의 xG(×BLOCK_CREDIT)가 xG 컬럼에 들어온다.
        v = float(action.get("xg") or 0)
        return v if v > 0 else None
    # 캐칭·펀칭도 EPV 컬럼을 쓴다 — 수비 전환가치와 같이 델타가 아니라 레벨이다.
    if fam in ("progression", "defense", "gk_claim"):  # 수비 전환가치도 EPV 컬럼으로 들어온다.
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

    중복 제거는 **행위(event)** 단위다 — 아래 groups 주석 참조.
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

    # 중복 제거 단위는 **행위(event)** 다 — 장면도, 행위자도 아니다.
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
    # 처음엔 장면 단위였고, 위 문제 때문에 행위자 단위로 내렸다. 그런데 거기서 멈추니
    # **같은 선수의 서로 다른 두 행위**가 여전히 서로를 밀어냈다 — 한 장면에서 경합과
    # 클리어를 같이 찍으면 둘 다 possession 군이라, 계수가 4배인 경합이 이기고 클리어가
    # 무점수로 남았다(2026-09-11 실제로 그렇게 났다). 무관한 두 행위다.
    #
    # 그래서 seq(행별 순번)까지 키에 넣어 행위 단위로 내린다. 정본이 말하는 단위가
    # 그것이고(3.5.1 의 event_id), 그렇게 해야 3.5.2 의 "나머지 Action 을 점수에서
    # 제외하는 규칙이 아니다" 와도 맞는다.
    #
    # 아래 '군당 1개·최대 3개' 규칙은 그대로 둔다 — 한 행위가 여러 코드를 만들게 되면
    # (정본 3.5.1 이 허용한다) 그때 이 규칙이 제 일을 한다. 지금은 한 행이 코드 하나라
    # 묶음마다 후보가 하나뿐이고, 따라서 아무것도 탈락하지 않는다.
    #
    # 선수 점수는 clipScore = max(액션 점수) 라 행을 더 살려도 인플레는 생기지 않는다.
    groups: dict[Any, list[dict[str, Any]]] = {}
    for i, pa in enumerate(payload_actions):
        scene = pa.get("groupIndex") if pa.get("groupIndex") is not None else f"solo-{i}"
        # seq 가 없으면(옛 페이로드) 행 순번으로 갈음한다 — 어느 쪽이든 행마다 다르다.
        event = pa.get("seq") if pa.get("seq") is not None else f"row-{i}"
        key = (scene, pa.get("teamSide"), pa.get("jersey"), event)
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
            elif code == SAVE_CODE:
                # 세이브는 두 축(xGOT·xG)을 섞어 [75,100] 밴드에 얹는다(save_outcome_score).
                banded = save_outcome_score(pa)
            elif code == GK_CLAIM_CODE:
                # 캐칭·펀칭은 액션별 밴드에 볼록 곡선으로 얹는다(GK_CLAIM_SCORE_BANDS).
                banded = gk_claim_outcome_score(pa, p)
            elif code in DUEL_ACTION_CODES:
                # 경합은 EPV 로 줄세워 [60,89] 에, 가운데가 두꺼운 분포로 얹는다.
                # possession_outcome_score 보다 **먼저** 봐야 한다 — 경합은 possession
                # 군이라 그냥 두면 공통 소유 밴드로 빨려 들어간다.
                banded = duel_outcome_score(p)
            else:
                # 어시스트·키패스 밴드가 먼저다 — 이들은 G2(goal 군)라 소유 압축과 겹치지 않는다.
                banded = pass_outcome_score(pa, p)
                if banded is None:
                    banded = possession_outcome_score(code, pa, p)
            # 돌파 하한은 **맨 마지막**에 건다 — 어느 축·어느 밴드를 거쳤든 최종 점수를
            # [70,100] 으로 옮긴다(BREAKTHROUGH_SCORE_BAND).
            pa["xfpScore"] = breakthrough_band_score(
                pa, banded if banded is not None else percentile_to_score(p)
            )
            pa["xfpPercentile"] = round(p, 4)
