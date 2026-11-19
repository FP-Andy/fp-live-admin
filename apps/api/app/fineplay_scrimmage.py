"""라커룸 자체전 — 신청 1건, 결과 2경기 (ADR-X-0010, 2026-11-19).

자체전(매니페스트 ``matchKind="SCRIMMAGE"`` + ``opponentLineup``)은 영상 하나를 양 팀 태깅하지만,
결과는 **묶음 두 개로 나눠 따로** ``POST /api/internal/xfp/analysis-results`` 로 보낸다.

- A 묶음: A팀 클립(team_side 없는 옛 클립 포함) + B팀 **골** 클립(표시용)
- B 묶음: B팀 클립 + A팀 골 클립(표시용)

A팀 = 매니페스트 lineup = ``fpa_link.our_side``(기본 홈) 쪽, B팀 = opponentLineup = 반대편.

FinePlay 계약(Backend 쪽과 맞춘 값 — 바꾸지 말 것):
- 최상위 ``scrimmageSide``: "A" | "B". 자체전 분할 전송에만 싣는다.
- ``analysisRequestId``·``teamId`` 는 두 묶음 모두 원 신청 값. B 경기 행은 서버가 찾거나 만든다.
- 표시용 클립: ``displayOnly: true``, involvedPlayers 없음, 액션 식별 필드 없음, mainPlayerName 없음,
  highlightTeam "OPPONENT". 득점·xFP 는 원래 묶음에서만 센다(결정 2).
- 원래 클립 안 반대편 액션은 식별 필드를 모두 뗀다 — 등번호가 남으면 서버가 '확인 필요' 매칭 행을
  만들고, 운영자가 연결하면 이중 집계된다(결정 3).
- clipKey 는 FPC 클립 id 그대로(B 묶음 접미사 ``:B`` 는 서버가 붙인다).
- 두 묶음은 클립이 0개여도 **항상** 보낸다 — 서버는 둘 다 들어와야 분석 완료·알림 1번을 한다.

잡 메타 ``metadata["scrimmage"] = {"A": {...}, "B": {...}}`` 에 묶음별 상태를 남긴다.
일반 잡의 ``callback_status``/``result_payload`` 는 건드리지 않는다.
"""

from __future__ import annotations

from typing import Any

from .fineplay_fpa import scrimmage_opponent_lineup

LETTERS = ("A", "B")
META_KEY = "scrimmage"
# 선수를 가리키는 필드 — 표시용 클립과 원래 클립의 반대편 액션에서 뗀다.
IDENTITY_KEYS = ("playerId", "userId", "playerName", "jersey")
TEAM_LABELS = {"A": "A팀", "B": "B팀"}


def _side(value: Any) -> str | None:
    text = str(value or "").strip().lower()
    return text if text in ("home", "away") else None


def bundle_sides(metadata: Any) -> dict[str, str] | None:
    """자체전 분할 대상이면 {"A": 사이드, "B": 사이드}, 아니면 None.

    사전 작업(standalone)은 링크별 홈/어웨이 전송이 따로 있어 대상이 아니다.
    """
    meta = metadata if isinstance(metadata, dict) else {}
    if meta.get("standalone"):
        return None
    if scrimmage_opponent_lineup(meta.get("manifest")) is None:
        return None
    a_side = _side((meta.get("fpa_link") or {}).get("our_side")) or "home"
    return {"A": a_side, "B": "away" if a_side == "home" else "home"}


def bundle_lineup(metadata: Any, letter: str) -> list[dict[str, Any]]:
    """그 묶음 편의 라인업 — A = 매니페스트 lineup, B = opponentLineup."""
    manifest = (metadata or {}).get("manifest") if isinstance(metadata, dict) else None
    manifest = manifest if isinstance(manifest, dict) else {}
    if letter == "A":
        return [e for e in (manifest.get("lineup") or []) if isinstance(e, dict)]
    return list(scrimmage_opponent_lineup(manifest) or [])


def parse_letters(value: Any) -> tuple[str, ...] | None:
    """요청 바디 side — 없으면 둘 다, "A"/"B" 면 그 묶음만. 모르는 값이면 None."""
    if value is None or value == "":
        return LETTERS
    text = str(value).strip().upper()
    return (text,) if text in LETTERS else None


def clip_role(team_side: Any, is_goal: Any, *, side: str, letter: str) -> str | None:
    """이 묶음에서 클립의 역할 — "own"(원래 클립) | "display"(반대편 골, 표시용) | None(빠짐).

    team_side 가 없는 옛 클립은 A 묶음에만 원래 클립으로 넣는다(양쪽에 넣으면 이중 집계).
    """
    clip_side = _side(team_side)
    if clip_side is None:
        return "own" if letter == "A" else None
    if clip_side == side:
        return "own"
    return "display" if bool(is_goal) else None


def bundle_roles(metadata: Any, team_side: Any, is_goal: Any) -> dict[str, str | None] | None:
    """클립 하나가 묶음마다 맡는 역할 — {"A": "own"|"display"|None, "B": ...}. 자체전이 아니면 None.

    클립 검수·전송 화면이 묶음별 클립 목록을 이 값으로 만든다. 전송(_build_clip_result_payload)도
    같은 clip_role·bundle_sides 를 쓰므로, 화면에 보이는 묶음 = 실제로 나가는 묶음이다.
    """
    sides = bundle_sides(metadata)
    if sides is None:
        return None
    return {letter: clip_role(team_side, is_goal, side=sides[letter], letter=letter) for letter in LETTERS}


def strip_identity(actions: list[dict[str, Any]], *, keep_side: str | None) -> list[dict[str, Any]]:
    """keep_side 가 아닌 액션에서 선수 식별 필드를 뗀다(제자리). keep_side=None 이면 전부."""
    for action in actions:
        if keep_side is None or _side(action.get("teamSide")) != keep_side:
            for key in IDENTITY_KEYS:
                action.pop(key, None)
    return actions


def mark_display_only(entry: dict[str, Any]) -> dict[str, Any]:
    """표시용 클립으로 만든다(제자리) — 영상·구간·mainAction·isGoal·sceneData 는 그대로."""
    entry["displayOnly"] = True
    entry.pop("involvedPlayers", None)
    view = entry.get("teamView")
    if isinstance(view, dict):
        view.pop("mainPlayerName", None)
        view["highlightTeam"] = "OPPONENT"
        strip_identity([a for a in (view.get("actions") or []) if isinstance(a, dict)], keep_side=None)
    return entry


def player_match(payload: dict[str, Any], side: str) -> str:
    """원래 클립의 그 편 액션 중 선수가 연결된 수 — '연결/전체'. 화면 표시용."""
    ours = [
        a
        for clip in (payload.get("clips") or [])
        if not clip.get("displayOnly")
        for a in ((clip.get("teamView") or {}).get("actions") or [])
        if _side(a.get("teamSide")) == side
    ]
    return f"{sum(1 for a in ours if a.get('playerId'))}/{len(ours)}"


def bundles(metadata: Any) -> dict[str, dict[str, Any]]:
    raw = (metadata or {}).get(META_KEY) if isinstance(metadata, dict) else None
    return {k: dict(v) for k, v in (raw or {}).items() if k in LETTERS and isinstance(v, dict)} \
        if isinstance(raw, dict) else {}


def record(metadata: dict[str, Any], letter: str, *, side: str, status: str,
           payload: dict[str, Any] | None = None, include_analysis: bool = True) -> dict[str, Any]:
    """묶음 하나의 전송 결과를 잡 메타에 남긴다(제자리)."""
    current = bundles(metadata)
    entry = dict(current.get(letter) or {})
    entry["side"] = side
    entry["callback_status"] = status
    if payload is not None:
        clips = payload.get("clips") or []
        entry["result_payload"] = payload
        entry["clips"] = sum(1 for c in clips if not c.get("displayOnly"))
        entry["display_clips"] = sum(1 for c in clips if c.get("displayOnly"))
        if include_analysis:
            entry["player_match"] = player_match(payload, side)
        else:
            entry.pop("player_match", None)
    current[letter] = entry
    metadata[META_KEY] = current
    metadata["callback_status"] = summary_status(metadata)
    return entry


def summary_status(metadata: Any) -> str:
    """잡 목록용 한 줄 — 둘 다 보냈으면 "sent", 아니면 "A: …, B: …"."""
    current = bundles(metadata)
    statuses = {letter: str((current.get(letter) or {}).get("callback_status") or "안 보냄")
                for letter in LETTERS}
    if all(s == "sent" for s in statuses.values()):
        return "sent"
    return ", ".join(f"{letter}: {statuses[letter]}" for letter in LETTERS)


def hold_all(metadata: dict[str, Any], reason: str) -> None:
    """클립을 새로 만들었을 때 — 이미 보낸 묶음도 '다시 보내야 함' 으로 돌린다(제자리)."""
    current = bundles(metadata)
    for letter in current:
        current[letter]["callback_status"] = reason
    if current:
        metadata[META_KEY] = current


def view(metadata: Any) -> dict[str, Any] | None:
    """화면용 요약 — 자체전이 아니면 None. 결과 payload 는 싣지 않는다(무겁다)."""
    sides = bundle_sides(metadata)
    if sides is None:
        return None
    current = bundles(metadata)
    out: dict[str, Any] = {}
    for letter in LETTERS:
        entry = current.get(letter) or {}
        out[letter] = {
            "side": sides[letter],
            "label": TEAM_LABELS[letter],
            "callback_status": entry.get("callback_status"),
            "clips": entry.get("clips"),
            "display_clips": entry.get("display_clips"),
            "player_match": entry.get("player_match"),
        }
    return out


def light_metadata(value: Any) -> Any:
    """목록(brief)용 — 묶음별 result_payload 를 빼고 나머지 상태만 남긴다."""
    if not isinstance(value, dict):
        return value
    return {k: ({kk: vv for kk, vv in v.items() if kk != "result_payload"} if isinstance(v, dict) else v)
            for k, v in value.items()}
