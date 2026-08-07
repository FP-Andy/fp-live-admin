"""FinePlay 잡 ↔ FPA dual 씬 연결 — match–clip–action 구조의 데이터 빌더.

연결 규칙(2026-07-27 합의):
- 클립 귀속 팀은 태깅 시점(A=홈/D=어웨이)에 확정된 clip_teams 가 1순위,
  없으면 씬 primary 행의 팀으로 폴백.
- 클립 N개 ↔ 저장된 씬 N개를 시간/씬번호 순서로 1:1 자동 매칭한다
  (클립에서 직접 FPA 를 찍는 귀속 UI 가 생기기 전까지의 임시 브릿지).
- 씬의 모든 행 = 클립의 action 목록. 주요선수는 여러 명일 수 있다
  (패스→패스→슛 = 3명) — 우리 팀·라인업(등번호) 매칭되는 행위자 전원이
  involvedPlayers 로 들어간다.
- 씬↔클립 개수가 다르면 앞에서부터 매칭하고 경고만 남긴다(전송은 막지 않음).
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

from .xfp_score import score_clip_actions

# FPA Action 명(fpa.ACTION_CODES 값) → FinePlay contributionRole.
# 서버가 아는 롤: SHOOTER PASSER CROSSER DRIBBLER PENETRATOR INTERCEPTOR PRESSER DUELER
# (미지의 롤은 경고 후 원문 보존이므로 매핑 없는 액션은 롤을 생략한다.)
# 임시 xFP 자리값 — 정식 산식(클립별 xFP, ~/xFP calc_action_score 이식) 전까지
# xFP 정본 v0.1 채점 적용 — 유효 Effect Action 만 xfpScore 를 받는다 (xfp_score.py).
# 자리값 50 은 유효 액션이 하나도 없는 선수의 clipScore 폴백에만 남는다.
XFP_PLACEHOLDER_SCORE = 50

ACTION_ROLE_MAP: dict[str, str] = {
    "Shot": "SHOOTER",
    "Goal": "SHOOTER",
    "Shot On Target": "SHOOTER",
    "Blocked Shot": "SHOOTER",
    "Pass": "PASSER",
    "Assist": "PASSER",
    "Key Pass": "PASSER",
    "Cross": "CROSSER",
    "Dribble": "DRIBBLER",
    "Breakthrough": "DRIBBLER",
    "Penetration": "PENETRATOR",
    "Press": "PRESSER",
    "Intercept": "INTERCEPTOR",
    "Tackle": "DUELER",
    "Duel": "DUELER",
}

# 앱 카드 제목(sequenceSummary)·mainAction 용 한글 라벨.
ACTION_LABELS_KO: dict[str, str] = {
    "Shot": "슈팅",
    "Goal": "골",
    "Shot On Target": "유효 슈팅",
    "Blocked Shot": "블록된 슈팅",
    "Pass": "패스",
    "Cross": "크로스",
    "Dribble": "드리블",
    "Breakthrough": "돌파",
    "Penetration": "침투",
    "Press": "압박",
    "Intercept": "인터셉트",
    "Tackle": "태클",
    "Duel": "경합",
    "Acquisition": "볼 획득",
    "Clear": "클리어",
    "Cutout": "컷아웃",
    "Block": "블록",
    "Catching": "캐칭",
    "Punching": "펀칭",
    "Save": "세이브",
    "Foul": "파울",
    "Be Fouled": "파울 유도",
    "Offside": "오프사이드",
    "Touch": "터치",
    "Throw-in": "스로인",
    "Sprint": "스프린트",
    "Miss": "미스",
    # dual 은 어시스트·키패스를 독립 액션이 아니라 Pass 의 태그로 찍는다.
    # 아래 canonical_action_name 이 태그를 보고 이 이름으로 승격한다.
    "Assist": "어시스트",
    "Key Pass": "키패스",
}

# 주요선수 롤 결정용 액션 중요도(앞일수록 높음) — 한 선수가 여러 액션이면 가장 중요한 것.
ACTION_SIGNIFICANCE = [
    "Goal", "Shot On Target", "Shot", "Blocked Shot",
    "Assist", "Key Pass",
    "Cross", "Breakthrough", "Penetration", "Dribble", "Pass",
    "Intercept", "Tackle", "Press", "Duel",
]


@dataclass
class FpaScene:
    index: int
    rows: list[dict[str, Any]]
    primary_row: dict[str, Any]


def _parse_float(value: Any) -> float | None:
    try:
        text = str(value).strip()
        if not text:
            return None
        return float(text)
    except (TypeError, ValueError):
        return None


def _parse_coord(value: Any) -> tuple[float, float] | None:
    """row Coord "Pos(66.13, 38.09)" → (x, y) 미터. 공격방향 정규화 좌표(오른쪽 공격)."""
    text = str(value or "")
    m = re.search(r"Pos\(([-\d.]+),\s*([-\d.]+)\)", text)
    if not m:
        return None
    try:
        return (float(m.group(1)), float(m.group(2)))
    except ValueError:
        return None


def _parse_scene_state(value: Any) -> dict[str, Any] | None:
    """행의 SceneState(json 문자열)에서 모션 렌더에 필요한 점 스냅샷만 추린다."""
    if isinstance(value, dict):
        parsed: Any = value
    else:
        text = str(value or "").strip()
        if not text:
            return None
        try:
            parsed = json.loads(text)
        except (ValueError, TypeError):
            return None
    if not isinstance(parsed, dict):
        return None
    state = {
        key: parsed[key]
        for key in ("beforeDots", "afterDots", "passArrows", "primary")
        if parsed.get(key) is not None
    }
    return state or None


def _pick_primary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """SceneState.primary(행 인덱스)가 있으면 그 행, 없으면 슈팅류 → 첫 행 순."""
    state_text = next((r.get("SceneState") for r in rows if r.get("SceneState")), None)
    if state_text:
        try:
            primary = json.loads(state_text).get("primary")
            if isinstance(primary, int) and 0 <= primary < len(rows):
                return rows[primary]
        except (ValueError, TypeError):
            pass
    for row in rows:
        if ACTION_ROLE_MAP.get(str(row.get("Action") or "")) == "SHOOTER":
            return row
    return rows[0]


def pick_primary(rows: list[dict[str, Any]]) -> dict[str, Any]:
    """공개 래퍼 — 클립 액션 귀속 API 등 외부 호출용."""
    return _pick_primary(rows)


def action_label(action_name: str) -> str:
    """액션 영문명 → 한글 라벨(미정의 시 원문)."""
    return ACTION_LABELS_KO.get(action_name) or action_name


def load_scenes(saved_rows: list[dict[str, Any]]) -> list[FpaScene]:
    """저장된 FPA 로그 행에서 씬 목록을 SceneIndex 순으로 복원한다."""
    groups: dict[int, list[dict[str, Any]]] = {}
    for row in saved_rows or []:
        try:
            index = int(str(row.get("SceneIndex") or "").strip())
        except ValueError:
            continue
        groups.setdefault(index, []).append(row)
    scenes: list[FpaScene] = []
    for index in sorted(groups):
        rows = sorted(
            groups[index],
            key=lambda r: int(str(r.get("SceneActionIndex") or "0") or 0),
        )
        scenes.append(FpaScene(index=index, rows=rows, primary_row=_pick_primary(rows)))
    return scenes


def _find_lineup_player(lineup: list[dict[str, Any]], jersey: str) -> dict[str, Any] | None:
    jersey = str(jersey or "").strip()
    if not jersey:
        return None
    for entry in lineup or []:
        if str(entry.get("jerseyNumber") or "").strip() == jersey:
            return entry
    return None


def _significance(action: str) -> int:
    try:
        return ACTION_SIGNIFICANCE.index(action)
    except ValueError:
        return len(ACTION_SIGNIFICANCE)


# 결과를 액션 이름으로 승격하는 규칙. dual 은 결과를 Action 이 아니라 Tags 에 찍는다
# (슈팅은 d/dd/ddd/db 가 전부 Shot + result tag, 키패스·어시스트도 Pass 의 태그).
# 그래서 승격하지 않으면 골도 유효슛도 전부 "슈팅" 한 덩어리로 앱에 나간다.
_ACTION_PROMOTIONS: dict[str, tuple[tuple[str, str], ...]] = {
    # 앞에 오는 태그가 우선 — 골은 유효슈팅이기도 하므로 순서가 곧 우선순위다.
    "Shot": (("Goal", "Goal"), ("On Target", "Shot On Target"), ("Blocked", "Blocked Shot")),
    "Pass": (("Assist", "Assist"), ("Key Pass", "Key Pass")),
}

# 승격된 이름 → 원래 액션. 승격이 이름을 갈아치우기 때문에 이게 없으면 골이
# 슈팅 집계에서 빠진다 — 골은 골이면서 슈팅이고, 어시스트는 어시스트면서 패스다.
# 두 층을 다 실어 보내야 소비하는 쪽이 원하는 층으로 셀 수 있다.
_ACTION_BASE: dict[str, str] = {
    promoted: base
    for base, rules in _ACTION_PROMOTIONS.items()
    for _tag, promoted in rules
}


def _tags_of(value: Any) -> set[str]:
    return {part.strip() for part in str(value or "").split(",") if part.strip()}


def canonical_action_name(action: Any, tags: Any) -> str:
    """dual 행의 (Action, Tags) → 결과까지 반영한 액션 이름.

    "Shot" + "Goal" → "Goal", "Pass" + "Assist" → "Assist". 승격된 이름은
    ACTION_LABELS_KO·ACTION_SIGNIFICANCE·ACTION_ROLE_MAP·_SHOT_ACTIONS 가 이미
    알고 있어서, 라벨(골/유효 슈팅/어시스트)과 대표 액션 랭크가 함께 살아난다.
    24코드(actionCode)는 승격 전후가 같으므로 채점은 흔들리지 않는다.

    실패한 액션은 승격하지 않는다 — "Fail" 이 붙은 패스는 어시스트일 수 없고,
    승격해 버리면 _is_failed_action 이 놓쳐 점수 제외가 풀린다.
    """
    name = str(action or "").strip()
    tag_set = _tags_of(tags)
    if "Fail" in tag_set:
        return name
    for tag, promoted in _ACTION_PROMOTIONS.get(name, ()):
        if tag in tag_set:
            return promoted
    return name


def base_action_name(action: Any) -> str:
    """승격된 이름 → 원래 액션. "Goal"→"Shot", "Assist"→"Pass".

    집계하는 쪽이 두 층을 다 셀 수 있게 payload 에 baseAction 으로 함께 싣는다.
    골은 골이면서 슈팅이고 어시스트는 어시스트면서 패스인데, 승격은 이름을
    갈아치우므로 이게 없으면 골이 슈팅 집계에서 통째로 빠진다.

    승격 대상이 아닌 액션(크로스·드리블 등)은 자기 자신이 base 다 — 모든 액션이
    baseAction 을 갖게 해서 소비하는 쪽이 예외 없이 한 필드만 보면 되게 한다.
    """
    name = str(action or "").strip()
    return _ACTION_BASE.get(name, name)


def _row_metrics(row: dict[str, Any]) -> dict[str, float]:
    return {
        key: value
        for key, value in (
            ("xg", _parse_float(row.get("xG"))),
            ("xgot", _parse_float(row.get("xGOT"))),
            ("epv", _parse_float(row.get("EPV"))),
            ("pc", _parse_float(row.get("PC"))),
        )
        if value is not None
    }


def rematch_action_players(
    actions: list[dict[str, Any]],
    *,
    our_side: str,
    lineup: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """저장된 액션들을 전송 관점(our_side)에 맞춰 선수 매칭을 다시 한다.

    사전작업은 한 태깅본을 홈/어웨이 두 신청으로 내보내는데, DB 액션은 저장 시점
    관점으로 playerId 가 붙어 있다. 전송 시점에 우리 팀 행은 그 신청의 라인업으로
    재매칭하고, 반대편 행은 개인 식별 필드를 뗀다(상대 라인업이 없고, 상대 신청
    건에 개인 식별 정보를 싣지 않는다). 등번호·팀 사이드·지표는 그대로 남는다.
    """
    out: list[dict[str, Any]] = []
    for action in actions:
        a = dict(action)
        side = str(a.get("teamSide") or "").strip().lower()
        entry = _find_lineup_player(lineup, str(a.get("jersey") or "")) if side == our_side else None
        if entry:
            a["playerId"] = str(entry["playerId"]) if entry.get("playerId") else None
            a["playerName"] = entry.get("name")
            a["userId"] = (
                int(str(entry["playerId"]))
                if str(entry.get("playerId") or "").isdigit()
                else None
            )
        else:
            a["playerId"] = None
            a["playerName"] = None
            a["userId"] = None
        out.append(a)
    return out


def scene_action_rows(
    scene: FpaScene,
    *,
    our_side: str,
    lineup: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """씬의 모든 행 → action 목록(DB·페이로드 공용 상세형).

    등번호→playerId 매칭은 우리 팀(our_side) 행에만 시도한다
    (라인업은 신청 팀 것뿐이므로).
    """
    actions: list[dict[str, Any]] = []
    for i, row in enumerate(scene.rows):
        # 결과 태그(Goal/On Target/Assist…)를 액션 이름에 반영한다 — 안 하면
        # 골·유효슛·빗나간 슛이 전부 "슈팅" 하나로 뭉개져 앱까지 나간다.
        action_name = canonical_action_name(row.get("Action"), row.get("Tags"))
        side = str(row.get("Team") or "").strip().lower()
        jersey = str(row.get("Player") or "").strip()
        entry = _find_lineup_player(lineup, jersey) if side == our_side else None
        action: dict[str, Any] = {
            "seq": i + 1,
            "sceneActionIndex": int(str(row.get("SceneActionIndex") or i + 1) or i + 1),
            # dual 시간 기록 — 클립 내 초로 환산해 구간 시작 기본값으로 쓴다 (equal_split_offsets).
            "recordedTime": _parse_timeline_seconds(row.get("Time")),
            "action": action_name,
            # 집계용 상위 층 — 골도 슈팅으로, 어시스트도 패스로 세지게 한다.
            "baseAction": base_action_name(action_name),
            "actionLabel": ACTION_LABELS_KO.get(action_name) or action_name,
            "teamSide": side or None,
            "jersey": jersey or None,
            "playerId": str(entry["playerId"]) if entry and entry.get("playerId") else None,
            "playerName": entry.get("name") if entry else None,
            # 개인 페이지 "내 액션" 필터용 — 라인업 playerId 가 숫자면 실계정 userId.
            "userId": (
                int(str(entry["playerId"]))
                if entry and str(entry.get("playerId") or "").isdigit()
                else None
            ),
            **_row_metrics(row),
        }
        extra = {
            key: value
            for key, value in (("tags", row.get("Tags")), ("receiver", row.get("Receiver")))
            if str(value or "").strip()
        }
        coord = _parse_coord(row.get("Coord"))
        if coord is not None:
            action["x"], action["y"] = coord
            # DB(extra 컬럼)에도 보존 — 재전송 때 24코드 OWN/OPP 판정에 필요.
            extra["x"], extra["y"] = coord
        # 장면 모션 렌더 소스 — before/after 점 스냅샷을 액션 단위로 보존한다.
        scene_state = _parse_scene_state(row.get("SceneState"))
        if scene_state:
            extra["sceneState"] = scene_state
        # 슛 골대 클릭 지점("gx,gy,공격방향") — 씬 모션 슛 경로 렌더용.
        goal_mouth = str(row.get("GoalMouth") or "").strip()
        if goal_mouth:
            extra["goalMouth"] = goal_mouth
        if extra:
            action["extra"] = extra
        actions.append(action)
    _assign_action_groups(actions, scene.rows)
    return actions


def _assign_action_groups(actions: list[dict[str, Any]], rows: list[dict[str, Any]]) -> None:
    """FPA 태깅 단위(장면)로 액션을 묶는다 — groupIndex + 그룹 주 액션(isGroupMain).

    같은 장면의 행들은 동일한 SceneState 문자열을 공유한다(장면당 1회 직렬화).
    그룹 주 액션 = 장면 ★(SceneState.primary, 장면 내 행 인덱스) → 슈팅류 → 첫 행.
    앱 타임라인이 이 정보로 '패스(주) ↳ 침투(부)' 상하관계를 그린다.
    """
    if not actions:
        return
    groups: list[list[int]] = []
    prev_state: str | None = None
    for i in range(len(actions)):
        state = str(rows[i].get("SceneState") or "") if i < len(rows) else ""
        if prev_state is None or state != prev_state:
            groups.append([])
        groups[-1].append(i)
        prev_state = state
    for g_idx, members in enumerate(groups, start=1):
        main_local: int | None = None
        state = _parse_scene_state(rows[members[0]].get("SceneState")) if members[0] < len(rows) else None
        primary = (state or {}).get("primary")
        if isinstance(primary, int) and 0 <= primary < len(members):
            main_local = primary
        if main_local is None:
            for local, i in enumerate(members):
                if ACTION_ROLE_MAP.get(str(actions[i].get("action") or "")) == "SHOOTER":
                    main_local = local
                    break
        if main_local is None:
            main_local = 0
        for local, i in enumerate(members):
            actions[i]["groupIndex"] = g_idx
            # DB(extra 컬럼)에도 실어 재전송 때 그룹이 보존되게 한다.
            extra = actions[i].setdefault("extra", {})
            extra["groupIndex"] = g_idx
            if local == main_local:
                actions[i]["isGroupMain"] = True
                extra["isGroupMain"] = True


def _parse_timeline_seconds(value: Any) -> float | None:
    """dual 시간 기록("MM:SS"·"H:MM:SS"·초) → 초. 파싱 불가면 None."""
    text = str(value or "").strip()
    if not text:
        return None
    parts = text.split(":")
    try:
        if len(parts) == 1:
            return float(parts[0])
        if len(parts) == 2:
            return int(parts[0]) * 60 + float(parts[1])
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
    except ValueError:
        return None
    return None


def equal_split_offsets(actions: list[dict[str, Any]], clip_duration: float) -> None:
    """액션 구간(클립 내 초) 채우기 — dual 기록 시간 우선, 나머지 균등 분할(제자리 수정).

    분석관이 dual 에서 클립 내 시간(예: 00:03)으로 기록했으면 그 값이 구간 시작이
    되어 앱 타임라인·시크와 동기화된다. 클립 길이를 벗어난 값(경기 시계로 찍은
    경우)은 무시하고 균등 분할로 폴백한다. 콘솔 클립 결과에서 수정하면 그 값이 최우선.
    """
    n = len(actions)
    if n <= 0 or clip_duration <= 0:
        return
    # 1) dual 기록 시간 — 클립 범위(+1s 슬랙) 안일 때만 시작으로 채택.
    #    **0 은 '미기록'으로 본다**: dual 시간 입력의 기본값이 "00:00" 이라 시간을 안 적은
    #    액션까지 0초 기록으로 둔갑하고, 그러면 전 액션이 0 에 몰려(끝=다음 시작=0) 앱
    #    타임라인 시크가 죽는다. 진짜 클립 첫머리 액션은 아래 분할에서 어차피 0 을 받는다.
    for a in actions:
        if a.get("startOffset") is None:
            t = a.get("recordedTime")
            if isinstance(t, (int, float)) and 0 < t <= clip_duration + 1:
                a["startOffset"] = round(min(float(t), clip_duration), 2)
    # 2) 시작이 빈 액션은 **앞뒤 확정값 사이**를 균등 분할한다. 전역 i/n 으로 채우면
    #    일부만 시간을 적었을 때 뒤 액션이 앞 액션보다 이른 시각으로 밀려 순서가 꼬인다.
    i = 0
    while i < n:
        if actions[i].get("startOffset") is not None:
            i += 1
            continue
        j = i
        while j < n and actions[j].get("startOffset") is None:
            j += 1
        count = j - i
        has_prev = i > 0
        lo = float(actions[i - 1]["startOffset"]) if has_prev else 0.0
        hi = float(actions[j]["startOffset"]) if j < n else clip_duration
        if hi < lo:
            hi = lo
        for k in range(count):
            # 앞 앵커가 있으면 그 뒤로 밀어 넣고(k+1/count+1), 없으면 클립 시작부터 채운다.
            frac = (k + 1) / (count + 1) if has_prev else k / max(count, 1)
            actions[i + k]["startOffset"] = round(lo + (hi - lo) * frac, 2)
        i = j
    # 3) 끝 = 다음 액션 시작(없으면 클립 끝). 시작보다 앞서지 않게 클램프.
    for i, a in enumerate(actions):
        if a.get("endOffset") is None:
            nxt = next(
                (float(b["startOffset"]) for b in actions[i + 1:] if b.get("startOffset") is not None),
                clip_duration,
            )
            a["endOffset"] = round(max(nxt, float(a["startOffset"])), 2)


def analysis_from_actions(
    actions: list[dict[str, Any]],
    *,
    clip_team: str | None,
    our_side: str,
    team_labels: dict[str, str],
    fpa_match_id: str | None = None,
    scene_index: int | None = None,
    primary_seq: int | None = None,
) -> tuple[str | None, dict[str, Any], list[dict[str, Any]]]:
    """액션 목록 → (mainAction, teamView, involvedPlayers).

    씬 기반 enrichment 와 DB 기반 재전송이 공유하는 조립 규칙.

    대표 액션 선정(3단계):
      1) 클립 결과 탭에서 지정한 명시값(extra.isPrimary) — 최우선.
      2) 자동: 정본 v0.1 규칙 — 유효 Effect Action 의 백분위 argmax.
      3) 폴백(채점 불가 시): ACTION_SIGNIFICANCE 중요도순, 동급이면 나중(seq 큰) 액션.
    (태깅 시 ★(SceneState.primary)는 씬 채점·롤용으로만 쓰고 클립 대표에는 안 쓴다.)
    """
    if not actions:
        fallback = clip_team_fallback_view(clip_team, our_side, team_labels)
        return None, fallback or {}, []

    primary = next(
        (a for a in actions if (a.get("extra") or {}).get("isPrimary")),
        None,
    )
    if primary is None and primary_seq is not None:
        primary = next((a for a in actions if a.get("seq") == primary_seq), None)
    explicit_primary = primary is not None
    if primary is None:
        primary = min(
            actions,
            key=lambda a: (
                _significance(str(a.get("action") or "")),
                -float(a.get("seq") or 0),
            ),
        )

    # 페이로드용 액션(간결형): DB 전용 필드 제외.
    payload_actions = [
        {k: v for k, v in a.items() if k not in ("sceneActionIndex", "extra", "recordedTime") and v is not None}
        for a in actions
    ]
    shot_seqs = [
        float(a.get("seq") or 0)
        for a in actions
        if str(a.get("action") or "") in _SHOT_ACTIONS
    ]
    for a, pa in zip(actions, payload_actions):
        # 그룹(FPA 태깅 장면) 정보 — DB 재전송 경로는 extra 에만 있으므로 승격.
        ex = a.get("extra") or {}
        if pa.get("groupIndex") is None and ex.get("groupIndex") is not None:
            pa["groupIndex"] = ex["groupIndex"]
        if ex.get("isGroupMain") and not pa.get("isGroupMain"):
            pa["isGroupMain"] = True
        # 재전송 경로(DB) 액션은 좌표가 extra 에만 있다 — 분류 전에 승격.
        if a.get("x") is None and ex.get("x") is not None:
            a["x"] = ex.get("x")
            a["y"] = ex.get("y")
            pa.setdefault("x", ex.get("x"))
            pa.setdefault("y", ex.get("y"))
        # 실패 패스/크로스 — 기록·표시는 하되 점수 계산에서 제외한다.
        if _is_failed_action(str(a.get("action") or ""), ex):
            pa["failed"] = True
        # 24코드 표준 액션 ID — 표기(라벨)는 앱이 코드 매핑으로 책임진다.
        code = classify_action_code(
            a,
            later_shot=any(sq > float(a.get("seq") or 0) for sq in shot_seqs),
        )
        if code:
            pa["actionCode"] = code

    # 정본 v0.1 Action xFP — 24코드·연결 슈팅이 준비된 뒤 장면(Event) 규칙으로 채점.
    # 유효 Effect Action 만 점수를 받는다 (임시 50점 자리값 대체).
    score_clip_actions(payload_actions)

    # 대표 액션 — 명시 지정이 없으면 정본 규칙(Action Percentile argmax)으로 확정.
    if not explicit_primary:
        best = max(
            (pa for pa in payload_actions if pa.get("xfpPercentile") is not None),
            key=lambda pa: pa["xfpPercentile"],
            default=None,
        )
        if best is not None:
            primary = next(a for a, pa in zip(actions, payload_actions) if pa is best)
    for a, pa in zip(actions, payload_actions):
        if a is primary:
            pa["isClipPrimary"] = True

    primary_action = str(primary.get("action") or "")
    primary_side = str(primary.get("teamSide") or "").strip().lower()
    clip_side = clip_team if clip_team in ("home", "away") else (primary_side or None)
    is_ours = clip_side == our_side

    labels: list[str] = []
    for a in actions:
        label = str(a.get("actionLabel") or "")
        if label and (not labels or labels[-1] != label):
            labels.append(label)

    team_view: dict[str, Any] = {
        "source": "fpa-dual",
        "highlightTeam": "OURS" if is_ours else "OPPONENT",
        "teamSide": clip_side,
        "teamLabel": team_labels.get(clip_side or "") or None,
        "sequenceSummary": "→".join(labels[:4]),
        "actions": payload_actions,
        **{k: primary[k] for k in ("xg", "xgot", "epv", "pc") if primary.get(k) is not None},
    }
    if fpa_match_id:
        team_view["fpaMatchId"] = fpa_match_id
    if scene_index is not None:
        team_view["sceneIndex"] = scene_index
    primary_code = next(
        (pa.get("actionCode") for a, pa in zip(actions, payload_actions) if a is primary),
        None,
    )
    if primary_code:
        team_view["mainActionCode"] = primary_code
    jersey = str(primary.get("jersey") or "").strip()
    if jersey:
        team_view["mainPlayerJersey"] = jersey
        if primary.get("playerName"):
            team_view["mainPlayerName"] = primary["playerName"]

    # 서사형 제목 — "[직전 액션] 후 [N]번의 [대표 액션]". 앱 클립 제목 1순위 소스.
    ordered = sorted(actions, key=lambda a: float(a.get("seq") or 0))
    primary_label = ACTION_LABELS_KO.get(primary_action) or (primary_action or "액션")
    p_idx = next((i for i, a in enumerate(ordered) if a is primary), 0)
    prev_label = str(ordered[p_idx - 1].get("actionLabel") or "").strip() if p_idx > 0 else ""
    headline = f"{jersey}번의 {primary_label}" if jersey else primary_label
    if prev_label:
        headline = f"{prev_label} 후 {headline}"
    team_view["displayActionLabel"] = headline

    # 관여 등번호 — 행위자(액션 찍힌 선수) 기준, 등장 순서 유지·중복 제거.
    involved_jerseys: list[str] = []
    for a in ordered:
        j = str(a.get("jersey") or "").strip()
        if j and j not in involved_jerseys:
            involved_jerseys.append(j)
    if involved_jerseys:
        team_view["involvedJerseys"] = involved_jerseys

    # 주요선수(복수): 우리 팀 + 라인업 매칭된 행위자 전원. 롤은 가장 중요한 액션 기준.
    involved: list[dict[str, Any]] = []
    by_player: dict[str, list[dict[str, Any]]] = {}
    for a in actions:
        if a.get("playerId"):
            by_player.setdefault(str(a["playerId"]), []).append(a)
    for player_id, player_actions in by_player.items():
        best = min(player_actions, key=lambda a: _significance(str(a.get("action") or "")))
        player: dict[str, Any] = {
            "playerId": player_id,
            "playerName": best.get("playerName"),
            "playerView": {
                "jerseyNumber": best.get("jersey"),
                "actions": [
                    {k: v for k, v in a.items()
                     # baseAction 필수 — 백엔드 득점·도움 집계가 이 배열을 센다
                     # (docs/handoff_2026-08-07_goal_assist_ranking.md).
                     if k in ("seq", "action", "baseAction", "actionLabel",
                              "xg", "xgot", "epv", "pc", "startOffset", "endOffset")
                     and v is not None}
                    for a in player_actions
                ],
                **{k: best[k] for k in ("xg", "xgot", "epv", "pc") if best.get(k) is not None},
            },
        }
        role = ACTION_ROLE_MAP.get(str(best.get("action") or ""))
        if role:
            player["contributionRole"] = role
        # 클립 점수 — 그 선수 유효 Effect Action xFP 의 최대값. 유효 액션이 없으면
        # 자리값 유지 (백엔드가 0~100 검증·저장, 경기 단위 평균 matchPlayerScores 파생).
        player_seqs = {float(a.get("seq") or 0) for a in player_actions}
        player_scores = [
            pa["xfpScore"]
            for pa in payload_actions
            if pa.get("xfpScore") is not None and float(pa.get("seq") or 0) in player_seqs
        ]
        player["clipScore"] = max(player_scores) if player_scores else XFP_PLACEHOLDER_SCORE
        involved.append(player)

    main_action = ACTION_LABELS_KO.get(primary_action) or (primary_action or None)
    return main_action, team_view, involved


def build_clip_analysis(
    scene: FpaScene,
    *,
    clip_team: str | None,
    our_side: str,
    team_labels: dict[str, str],
    lineup: list[dict[str, Any]],
    fpa_match_id: str,
) -> tuple[str | None, dict[str, Any], list[dict[str, Any]], list[dict[str, Any]]]:
    """씬 하나 → (mainAction, teamView, involvedPlayers, actionRows).

    clip_team: 태깅 시점(A/D)에 확정된 클립 귀속 팀 — 있으면 팀 판정 1순위.
    our_side: FPA 로그에서 FinePlay 신청 팀이 어느 쪽인지 ('home'|'away').
    """
    action_rows = scene_action_rows(scene, our_side=our_side, lineup=lineup)
    # 태깅 ★(SceneState.primary)는 클립 대표 선정에서 제외 — 자동 규칙 + 클립 결과 탭 지정만 쓴다.
    main_action, team_view, involved = analysis_from_actions(
        action_rows,
        clip_team=clip_team,
        our_side=our_side,
        team_labels=team_labels,
        fpa_match_id=fpa_match_id,
        scene_index=scene.index,
    )
    return main_action, team_view, involved, action_rows


_SHOT_ACTIONS = {"Shot", "Goal", "Shot On Target", "Blocked Shot"}
# 승격된 패스류 — 24코드 판정에서 빠지면 actionCode 가 없어 점수까지 사라진다.
_PASS_ACTIONS = {"Pass", "Assist", "Key Pass"}
_DEFENSE_ACTIONS = {"Intercept", "Tackle", "Acquisition", "Cutout", "Block", "Clear"}
# 실패 표시 대상 — 하이라이트 마지막이 실패 패스/크로스로 끝나도 기록은 하되
# 점수 계산에서 제외한다(태그 "Fail" 기준). 표시·모션(빨간 화살표)만 나간다.
_FAILABLE_ACTIONS = {"Pass", "Cross"}


def _is_failed_action(action_name: str, extra: dict[str, Any] | None) -> bool:
    if action_name not in _FAILABLE_ACTIONS:
        return False
    return "Fail" in str((extra or {}).get("tags") or "")


def classify_action_code(action: dict[str, Any], *, later_shot: bool) -> str | None:
    """24개 표준 액션 코드(G1~S14) v0 판정 — 노션 'xFP 24개 액션 정의' 기준.

    1차 로직(2026-07-28 합의): 가장 높은 지표를 받은 기대효과로 군을 정한다 —
    슈팅류는 G1, 그 외에는 EPV vs PC 큰 쪽(Progression/Possession).
    진영(OWN/OPP)은 공격방향 정규화 좌표 x>52.5 기준, 좌표 없으면 OPP 가정.
    패스/크로스 뒤에 같은 클립에서 슈팅이 이어지면 득점 연결(G2/G3).
    정밀 판정(Direct/Indirect 인과·credit)은 정식 산식 이식 때 개정한다.
    """
    name = str(action.get("action") or "")
    x = action.get("x")
    opp = (float(x) > 52.5) if isinstance(x, (int, float)) else True
    epv = float(action.get("epv") or 0)
    pc = float(action.get("pc") or 0)
    progression = epv >= pc and epv > 0

    if name in _SHOT_ACTIONS:
        return "G1"
    if name in _PASS_ACTIONS:
        # 어시스트·키패스는 정의상 슈팅으로 이어진 패스라 later_shot 을 따지지 않는다
        # (승격 근거가 태그이므로, 씬이 잘려 뒤 슈팅이 같은 클립에 없어도 득점 연결이다).
        if later_shot or name in ("Assist", "Key Pass"):
            return "G2"
        if progression:
            return "P1" if not opp else "P2"
        return "S1" if not opp else "S2"
    if name == "Cross":
        return "G3" if later_shot else "P3"
    if name in ("Dribble", "Breakthrough"):
        if progression:
            return "P4" if not opp else "P5"
        return "S3" if not opp else "S4"
    if name == "Penetration":
        return "P6"
    if name in _DEFENSE_ACTIONS:
        return "S5" if not opp else "S7"
    if name == "Press":
        return "S9"
    if name == "Duel":
        return "S11" if not opp else "S12"
    return None


def annotate_action_codes(actions: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """직렬화된 DB 액션 목록에 actionCode·xfpScore 를 제자리 주석 — 콘솔 결과 탭 검수용.

    재전송 페이로드와 같은 규칙(좌표는 extra 승격, 뒤 슈팅 연결 시 G2/G3)으로 계산하고,
    정본 v0.1 Action xFP 채점(장면 규칙·유효 Effect Action 만 점수)까지 동일하게 돌린다 —
    콘솔에서 보는 점수 = 앱으로 나가는 점수.
    """
    shot_seqs = [
        float(a.get("seq") or 0)
        for a in actions
        if str(a.get("action") or "") in _SHOT_ACTIONS
    ]
    for a in actions:
        ex = a.get("extra") or {}
        if a.get("x") is None and ex.get("x") is not None:
            a["x"] = ex.get("x")
            a["y"] = ex.get("y")
        if a.get("groupIndex") is None and ex.get("groupIndex") is not None:
            a["groupIndex"] = ex["groupIndex"]
        if _is_failed_action(str(a.get("action") or ""), ex):
            a["failed"] = True
        code = classify_action_code(
            a,
            later_shot=any(sq > float(a.get("seq") or 0) for sq in shot_seqs),
        )
        if code:
            a["actionCode"] = code
    score_clip_actions(actions)
    return actions


def clip_team_fallback_view(clip_team: str | None, our_side: str, team_labels: dict[str, str]) -> dict[str, Any] | None:
    """씬이 매칭되지 않은 클립도 태깅 팀 귀속만은 전달한다."""
    if clip_team not in ("home", "away"):
        return None
    return {
        "source": "clip-tag",
        "highlightTeam": "OURS" if clip_team == our_side else "OPPONENT",
        "teamSide": clip_team,
        "teamLabel": team_labels.get(clip_team) or None,
    }


def enrich_result_payload(
    payload: dict[str, Any],
    saved_log: Any,
    *,
    our_side: str,
    lineup: list[dict[str, Any]],
    clip_teams: dict[str, str | None] | None = None,
    video_order: dict[str, int] | None = None,
) -> tuple[list[str], list[dict[str, Any]]]:
    """결과 콜백 payload 의 clips[] 에 FPA 분석 필드를 채운다(제자리 수정).

    클립은 (영상 순서, startTime) 오름차순, 씬은 SceneIndex 오름차순으로 1:1 매칭.
    영상별 타임라인이 각자 0부터라 다중 영상 신청은 video_order(매니페스트 videos[]
    순서) 없이는 전역 순서가 어긋난다. 미지정이면 startTime 만으로 정렬(영상 1개와 동일).
    반환: (경고 목록, DB 기록용 클립별 액션 레코드
           [{clip_key, fpa_match_id, scene_index, actions}]).
    """
    warnings: list[str] = []
    records: list[dict[str, Any]] = []
    clip_teams = clip_teams or {}
    our_side = (our_side or "home").strip().lower()
    team_labels = {"home": saved_log.teamid_h or "", "away": saved_log.teamid_a or ""}

    scenes = load_scenes(list(saved_log.rows or []))
    clips = payload.get("clips") or []
    vorder = video_order or {}
    ordered = sorted(
        clips,
        key=lambda c: (
            vorder.get(str(c.get("sourceVideoId") or ""), 0),
            float(c.get("startTime") or 0),
        ),
    )

    if not scenes:
        warnings.append(f"FPA 매치 {saved_log.match_id} 에 저장된 씬이 없습니다.")
    elif len(ordered) != len(scenes):
        warnings.append(
            f"클립 {len(ordered)}개 ↔ FPA 씬 {len(scenes)}개 — 앞에서부터 순서대로 매칭했습니다."
        )

    matched = {id(c) for c, _ in zip(ordered, scenes)}
    for clip, scene in zip(ordered, scenes):
        clip_key = str(clip.get("clipKey") or clip.get("fpcClipId") or "")
        main_action, team_view, involved, action_rows = build_clip_analysis(
            scene,
            clip_team=clip_teams.get(clip_key),
            our_side=our_side,
            team_labels=team_labels,
            lineup=lineup,
            fpa_match_id=str(saved_log.match_id),
        )
        if main_action and not clip.get("mainAction"):
            clip["mainAction"] = main_action
        clip["teamView"] = team_view
        if involved:
            clip["involvedPlayers"] = involved
        records.append({
            "clip_key": clip_key,
            "fpa_match_id": str(saved_log.match_id),
            "scene_index": scene.index,
            "actions": action_rows,
        })

    # 씬이 안 붙은 클립: 태깅 팀 귀속만이라도 페이로드에 남긴다.
    for clip in ordered:
        if id(clip) in matched:
            continue
        clip_key = str(clip.get("clipKey") or clip.get("fpcClipId") or "")
        fallback = clip_team_fallback_view(clip_teams.get(clip_key), our_side, team_labels)
        if fallback and not clip.get("teamView"):
            clip["teamView"] = fallback

    return warnings, records
