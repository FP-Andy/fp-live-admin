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
from dataclasses import dataclass
from typing import Any

# FPA Action 명(fpa.ACTION_CODES 값) → FinePlay contributionRole.
# 서버가 아는 롤: SHOOTER PASSER CROSSER DRIBBLER PENETRATOR INTERCEPTOR PRESSER DUELER
# (미지의 롤은 경고 후 원문 보존이므로 매핑 없는 액션은 롤을 생략한다.)
# 임시 xFP 자리값 — 정식 산식(클립별 xFP, ~/xFP calc_action_score 이식) 전까지
# 모든 액션 xfpScore / 선수 clipScore 를 50으로 고정해 점수 UI 프로세스를 끝까지 검증한다.
XFP_PLACEHOLDER_SCORE = 50

ACTION_ROLE_MAP: dict[str, str] = {
    "Shot": "SHOOTER",
    "Goal": "SHOOTER",
    "Shot On Target": "SHOOTER",
    "Blocked Shot": "SHOOTER",
    "Pass": "PASSER",
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
}

# 주요선수 롤 결정용 액션 중요도(앞일수록 높음) — 한 선수가 여러 액션이면 가장 중요한 것.
ACTION_SIGNIFICANCE = [
    "Goal", "Shot On Target", "Shot", "Blocked Shot",
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
        action_name = str(row.get("Action") or "")
        side = str(row.get("Team") or "").strip().lower()
        jersey = str(row.get("Player") or "").strip()
        entry = _find_lineup_player(lineup, jersey) if side == our_side else None
        action: dict[str, Any] = {
            "seq": i + 1,
            "sceneActionIndex": int(str(row.get("SceneActionIndex") or i + 1) or i + 1),
            "action": action_name,
            "actionLabel": ACTION_LABELS_KO.get(action_name) or action_name,
            "teamSide": side or None,
            "jersey": jersey or None,
            "playerId": str(entry["playerId"]) if entry and entry.get("playerId") else None,
            "playerName": entry.get("name") if entry else None,
            **_row_metrics(row),
        }
        extra = {
            key: value
            for key, value in (("tags", row.get("Tags")), ("receiver", row.get("Receiver")))
            if str(value or "").strip()
        }
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


def equal_split_offsets(actions: list[dict[str, Any]], clip_duration: float) -> None:
    """오프셋이 없는 액션에 클립 길이 균등 분할 기본값을 채운다(제자리 수정)."""
    n = len(actions)
    if n <= 0 or clip_duration <= 0:
        return
    for i, a in enumerate(actions):
        if a.get("startOffset") is None or a.get("endOffset") is None:
            a["startOffset"] = round(clip_duration * i / n, 2)
            a["endOffset"] = round(clip_duration * (i + 1) / n, 2)


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

    대표 액션 선정(2단계):
      1) 클립 결과 탭에서 지정한 명시값(extra.isPrimary) — 최우선.
      2) 자동: ACTION_SIGNIFICANCE 중요도순, 동급이면 나중(seq 큰) 액션.
         하이라이트는 결정적 장면으로 끝나는 경우가 많아 마지막 쪽이 대표일 확률이 높다.
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
    if primary is None:
        primary = min(
            actions,
            key=lambda a: (
                _significance(str(a.get("action") or "")),
                -float(a.get("seq") or 0),
            ),
        )

    primary_action = str(primary.get("action") or "")
    primary_side = str(primary.get("teamSide") or "").strip().lower()
    clip_side = clip_team if clip_team in ("home", "away") else (primary_side or None)
    is_ours = clip_side == our_side

    # 페이로드용 액션(간결형): DB 전용 필드 제외.
    payload_actions = [
        {k: v for k, v in a.items() if k not in ("sceneActionIndex", "extra") and v is not None}
        for a in actions
    ]
    for a, pa in zip(actions, payload_actions):
        # 정식 xFP 산식 전 임시 자리값 — 앱 점수 UI 프로세스를 끝까지 태우기 위함.
        pa.setdefault("xfpScore", XFP_PLACEHOLDER_SCORE)
        # 그룹(FPA 태깅 장면) 정보 — DB 재전송 경로는 extra 에만 있으므로 승격.
        ex = a.get("extra") or {}
        if pa.get("groupIndex") is None and ex.get("groupIndex") is not None:
            pa["groupIndex"] = ex["groupIndex"]
        if ex.get("isGroupMain") and not pa.get("isGroupMain"):
            pa["isGroupMain"] = True

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
                     if k in ("seq", "action", "actionLabel", "xg", "xgot", "epv", "pc", "startOffset", "endOffset")
                     and v is not None}
                    for a in player_actions
                ],
                **{k: best[k] for k in ("xg", "xgot", "epv", "pc") if best.get(k) is not None},
            },
        }
        role = ACTION_ROLE_MAP.get(str(best.get("action") or ""))
        if role:
            player["contributionRole"] = role
        # 클립 점수 임시 자리값 — 백엔드가 검증(0~100)·저장하고 경기 단위 평균(matchPlayerScores)도 파생.
        player["clipScore"] = XFP_PLACEHOLDER_SCORE
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
) -> tuple[list[str], list[dict[str, Any]]]:
    """결과 콜백 payload 의 clips[] 에 FPA 분석 필드를 채운다(제자리 수정).

    클립은 startTime 오름차순, 씬은 SceneIndex 오름차순으로 1:1 매칭.
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
    ordered = sorted(clips, key=lambda c: float(c.get("startTime") or 0))

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
