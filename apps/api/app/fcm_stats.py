"""FCM 주요선수 카드 스탯 선택 규칙 (분석관 스탯 입력 가이드).

FPA 로그에서 뽑은 선수 한 명의 수치(``metrics``)와 포지션을 받아 카드에 올릴
스탯 문구 최대 5줄을 고른다. FPA 로그 반영 · 파일 업로드 분석이 같은 함수를 쓴다.

규칙 요약
- 골이 있으면: Goal → 기대득점(xG) → 슈팅(유효슈팅)(필수) → 드리블/돌파 → 경합 성공률
- 골 없이 어시스트가 있으면: Assist → Key Pass → 패스 성공률 → 전진 패스 → 경합 성공률
- 득점 관여가 없으면: 포지션별 순서(``POSITION_ORDER``)
- 위 순서의 스탯이 0이거나 FPA 로그로 셀 수 없으면 건너뛰고 포지션 순서의 다음 스탯으로 채운다.
- 5줄을 넘길 때만 수비 스탯(인터셉트·태클·클리어·차단)을 한 줄에 ' / '로 묶는다.

순서는 어드민 카드뉴스(AdminWeb ``CardNewsPage.jsx`` 의 ``POSITION_BASE_ORDER``,
``sortCandidatesByPriority``)와 맞췄다. 가이드의 골/어시스트 순서가 어드민 FW/MF 순서와 같다.

표기
- 스탯명과 값 사이는 ``' : '``(앞뒤 공백).
- 괄호 앞에는 공백을 두지 않는다: ``85.0%(17회)``, ``0.310(1골)``, ``2회(1회)``.
  가이드 표와 어드민 카드뉴스(``fpaAnalysis.js``)가 이 형식이다. 가이드 ⑤의 예시
  ``99.9% (30회)`` 만 괄호 앞에 공백이 있어 표와 어긋난다 — 표/어드민을 따른다.
- 비율은 소수 1자리(가이드 예시 99.9%, 어드민 ``toFixed(1)``), xG는 소수 3자리.
- 볼 터치는 쓰지 않는다. FPA 로그는 주요 액션만 남기므로 행 수가 실제 터치 수가 아니다.
"""
from __future__ import annotations

from typing import Any, Mapping

MAX_STAT_LINES = 5
# 수비 스탯을 한 줄에 묶을 때 최대 개수. 가이드 예시(인터셉트 / 차단 / 클리어)가 3개다.
MAX_DEFENSIVE_PER_LINE = 3

STAT_LABELS: dict[str, str] = {
    "goal": "Goal",
    "assist": "Assist",
    "shot": "슈팅(유효슈팅)",
    "xg": "기대득점(xG)",
    "cross": "크로스 성공률(%)",
    "header": "헤더",
    "dribble": "드리블",
    "breakthrough": "돌파",
    "pass_rate": "패스 성공률(%)",
    "forward_pass": "전진 패스",
    "key_pass": "Key Pass",
    "intercept": "인터셉트",
    "tackle": "태클",
    "clear": "클리어",
    "block": "차단",
    "duel": "경합 성공률(%)",
}

DEFENSIVE_STATS = ("intercept", "tackle", "clear", "block")

# 'N회' 한 가지 값으로 쓰는 스탯 → metrics 키
COUNT_METRICS = {
    "header": "headers",
    "dribble": "dribbles",
    "breakthrough": "breakthroughs",
    "forward_pass": "forward_passes",
    "key_pass": "key_passes",
    "intercept": "intercepts",
    "tackle": "tackles",
    "clear": "clears",
    "block": "blocks",
}

# 가이드에 있지만 FPA 로그로 셀 수 없는 스탯 — 자동 선택에서 빠진다.
UNSUPPORTED_STATS = {"볼 터치": "FPA 로그는 주요 액션만 기록해 실제 볼 터치 수를 알 수 없다"}

GOAL_ORDER = ("goal", "xg", "shot", "dribble_or_breakthrough", "duel")
ASSIST_ORDER = ("assist", "key_pass", "pass_rate", "forward_pass", "duel")

# 득점 관여가 없을 때의 포지션별 순서. 어드민 카드뉴스 POSITION_BASE_ORDER 를 따르되
# 볼 터치는 뺐다. FW 는 어드민처럼 xG·슈팅을 앞에 두고, MF/DF 는 슈팅을 맨 뒤로 보낸다
# (가이드: "포지션에 맞는 스탯"). GK 가 주요선수 카드를 받으면 수비 순서를 쓴다.
POSITION_ORDER: dict[str, tuple[str, ...]] = {
    "FW": (
        "xg", "shot", "dribble", "breakthrough", "duel", "header", "cross",
        "pass_rate", "forward_pass", "key_pass", "intercept", "tackle", "clear", "block",
    ),
    "MF": (
        "pass_rate", "forward_pass", "key_pass", "duel", "dribble", "cross",
        "intercept", "tackle", "clear", "block", "header", "breakthrough", "xg", "shot",
    ),
    "DF": (
        "intercept", "tackle", "clear", "block", "duel", "pass_rate", "forward_pass",
        "key_pass", "dribble", "breakthrough", "cross", "header", "xg", "shot",
    ),
}
POSITION_ORDER["GK"] = POSITION_ORDER["DF"]
DEFAULT_POSITION = "MF"

STAT_CASE_GOAL = "GOAL"
STAT_CASE_ASSIST = "ASSIST"
STAT_CASE_POSITION = "POSITION"


def _int(metrics: Mapping[str, Any], key: str) -> int:
    try:
        return int(round(float(metrics.get(key) or 0)))
    except (TypeError, ValueError):
        return 0


def _float(metrics: Mapping[str, Any], key: str) -> float:
    try:
        return float(metrics.get(key) or 0)
    except (TypeError, ValueError):
        return 0.0


def _rate(success: int, total: int) -> float:
    return (success / total * 100) if total > 0 else 0.0


def normalize_position(value: Any) -> str:
    """GK/DF/MF/FW 로 맞춘다. 모르는 값은 빈 문자열."""
    text = str(value or "").strip().upper()
    return text if text in {"GK", "DF", "MF", "FW"} else ""


def stat_case(metrics: Mapping[str, Any]) -> str:
    if _int(metrics, "goals") > 0:
        return STAT_CASE_GOAL
    if _int(metrics, "assists") > 0:
        return STAT_CASE_ASSIST
    return STAT_CASE_POSITION


def is_available(key: str, metrics: Mapping[str, Any]) -> bool:
    """카드에 올릴 값이 있는가. 0회·0골 같은 빈 스탯은 다음 스탯에 자리를 넘긴다."""
    if key == "goal":
        return _int(metrics, "goals") > 0
    if key == "assist":
        return _int(metrics, "assists") > 0
    if key in {"shot", "xg"}:
        # xG 는 슈팅이 있어야 의미가 있다. 슈팅이 있는데 xG 가 0 이면 0.000 그대로 쓴다.
        return _int(metrics, "shots") > 0
    if key == "cross":
        return _int(metrics, "crosses") > 0
    if key == "pass_rate":
        return _int(metrics, "passes") > 0
    if key == "duel":
        return _int(metrics, "duels") > 0
    return key in COUNT_METRICS and _int(metrics, COUNT_METRICS[key]) > 0


def format_stat(key: str, metrics: Mapping[str, Any]) -> str:
    label = STAT_LABELS[key]
    goals = _int(metrics, "goals")
    if key == "goal":
        value = f"{goals}골"
    elif key == "assist":
        value = f"{_int(metrics, 'assists')}도움"
    elif key == "shot":
        value = f"{_int(metrics, 'shots')}회({_int(metrics, 'shots_on_target')}회)"
    elif key == "xg":
        value = f"{_float(metrics, 'xg'):.3f}({goals}골)"
    elif key == "cross":
        success = _int(metrics, "crosses_success")
        value = f"{_rate(success, _int(metrics, 'crosses')):.1f}%({success}회)"
    elif key == "pass_rate":
        success = _int(metrics, "passes_success")
        value = f"{_rate(success, _int(metrics, 'passes')):.1f}%({success}회)"
    elif key == "duel":
        won = _int(metrics, "duels_won")
        value = f"{_rate(won, _int(metrics, 'duels')):.1f}%({won}회)"
    else:
        value = f"{_int(metrics, COUNT_METRICS[key])}회"
    return f"{label} : {value}"


def _priority_keys(metrics: Mapping[str, Any], position: str) -> list[str]:
    """카드 5줄을 채울 스탯 키를 우선순위대로 늘어놓는다(값이 있는 것만)."""
    case = stat_case(metrics)
    fallback = POSITION_ORDER.get(normalize_position(position) or DEFAULT_POSITION, POSITION_ORDER[DEFAULT_POSITION])
    primary: tuple[str, ...] = ()
    if case == STAT_CASE_GOAL:
        primary = GOAL_ORDER
    elif case == STAT_CASE_ASSIST:
        primary = ASSIST_ORDER

    keys: list[str] = []
    for key in primary:
        if key == "dribble_or_breakthrough":
            # 가이드의 '드리블/돌파'는 한 자리다. 드리블을 먼저 보고 없으면 돌파.
            key = "dribble" if is_available("dribble", metrics) else "breakthrough"
        if key == "shot" and case == STAT_CASE_GOAL:
            # 골이 있으면 슈팅(유효슈팅)은 필수다. 골이면 슈팅이 최소 1회라 정상 데이터에선 늘 값이 있다.
            keys.append(key)
            continue
        if key not in keys and is_available(key, metrics):
            keys.append(key)
    # 빈 자리는 선수 포지션 순서의 다음 스탯으로 채운다(골/어시스트 경우도 같다).
    for key in fallback:
        if key not in keys and is_available(key, metrics):
            keys.append(key)
    return keys


def _group_lines(keys: list[str], *, combine_defensive: bool) -> list[list[str]]:
    if not combine_defensive:
        return [[key] for key in keys]
    lines: list[list[str]] = []
    run: list[str] = []

    def flush() -> None:
        if not run:
            return
        # 4개면 3+1 대신 2+2 로 나눠 한 줄이 너무 길어지지 않게 한다.
        size = 2 if len(run) == 4 else MAX_DEFENSIVE_PER_LINE
        for start in range(0, len(run), size):
            lines.append(run[start:start + size])
        run.clear()

    for key in keys:
        if key in DEFENSIVE_STATS:
            run.append(key)
            continue
        flush()
        lines.append([key])
    flush()
    return lines


def select_player_stats(metrics: Mapping[str, Any], position: str = "") -> dict[str, Any]:
    """규칙대로 고른 카드 스탯(``selected``)과 후보 전체(``candidates``)를 돌려준다.

    ``candidates`` 는 ``selected`` 를 앞에 두고, 5줄에 못 든 나머지 스탯을 한 줄씩 붙인다.
    화면이 ``candidates[:5]`` 를 기본 선택으로 쓰던 옛 동작과도 결과가 같다.
    """
    keys = _priority_keys(metrics, position)
    # 5줄이 넘칠 때만 수비 스탯을 묶는다. 넘치지 않으면 한 줄에 하나씩이 더 읽기 쉽다.
    lines = _group_lines(keys, combine_defensive=len(keys) > MAX_STAT_LINES)
    selected_lines = lines[:MAX_STAT_LINES]
    selected = [" / ".join(format_stat(key, metrics) for key in line) for line in selected_lines]
    used = {key for line in selected_lines for key in line}
    # 골+어시스트 선수의 Assist 처럼 우선순위 밖이지만 값이 있는 스탯도 후보로는 남긴다.
    rest_keys = [key for key in keys if key not in used]
    rest_keys += [key for key in STAT_LABELS if key not in used and key not in rest_keys and is_available(key, metrics)]
    return {
        "selected": selected,
        "candidates": selected + [format_stat(key, metrics) for key in rest_keys],
        "stat_case": stat_case(metrics),
        "position": normalize_position(position) or DEFAULT_POSITION,
    }


def infer_position_from_events(mean_x_ratio: float | None, *, is_goalkeeper: bool = False) -> str:
    """명단 포지션이 없을 때 FPA 액션 위치로 포지션을 추정한다.

    ``mean_x_ratio`` 는 공격 방향을 오른쪽으로 맞춘 시작 X 좌표 평균 / 경기장 길이(0~1).
    FPA 는 공격 액션을 더 많이 남기므로 경계값을 반 코트보다 조금 앞으로 잡았다.
    """
    if is_goalkeeper:
        return "GK"
    if mean_x_ratio is None:
        return ""
    if mean_x_ratio < 0.42:
        return "DF"
    if mean_x_ratio < 0.65:
        return "MF"
    return "FW"


# FinePlay 신청 라인업(positionSlot) → 포지션. 기록지 라벨은 그대로 자리가 정해진다.
_SLOT_LABEL_POSITION = {
    "GK": "GK",
    "SW": "DF", "LB": "DF", "LCB": "DF", "CB": "DF", "RCB": "DF", "RB": "DF", "LWB": "DF", "RWB": "DF",
    "LDM": "MF", "DM": "MF", "CDM": "MF", "RDM": "MF", "LM": "MF", "LCM": "MF", "CM": "MF",
    "RCM": "MF", "RM": "MF", "LAM": "MF", "CAM": "MF", "RAM": "MF",
    "LW": "FW", "LS": "FW", "ST": "FW", "RS": "FW", "RW": "FW",
}


def position_from_slot(slot: Any, *, formation: str = "", max_line: int | None = None, max_custom_row: int | None = None) -> str:
    """앱 FormationSlot.id → GK/DF/MF/FW.

    - ``gk`` → GK, 기록지 라벨(LCB·CM·ST …) → 표대로
    - ``player_{라인}_{순번}`` → 라인 0 = DF, 마지막 라인 = FW, 그 사이 = MF
      (마지막 라인은 포메이션 '4-3-3' 의 줄 수로, 없으면 명단 전체의 최대 라인으로 정한다)
    - ``c{행}_{열}``(커스텀) → 0행 GK, 1행 DF, 가장 앞 행 FW, 그 사이 MF
    - ``SUB``·빈 값 → 모름
    """
    text = str(slot or "").strip()
    if not text or text.upper() == "SUB":
        return ""
    if text.lower() == "gk":
        return "GK"
    if text.upper() in _SLOT_LABEL_POSITION:
        return _SLOT_LABEL_POSITION[text.upper()]
    parts = text.split("_")
    if text.startswith("player_") and len(parts) >= 3 and parts[1].isdigit():
        line = int(parts[1])
        last = max_line
        formation_lines = [part for part in str(formation or "").split(" ")[0].split("-") if part.isdigit()]
        if formation_lines:
            last = len(formation_lines) - 1
        if line == 0:
            return "DF"
        if last is not None and line >= last:
            return "FW"
        return "MF"
    if len(text) >= 4 and text[0] == "c" and "_" in text and text[1:text.index("_")].isdigit():
        row = int(text[1:text.index("_")])
        if row == 0:
            return "GK"
        if row == 1:
            return "DF"
        if max_custom_row is not None and row >= max_custom_row and row >= 3:
            return "FW"
        return "MF"
    return ""
