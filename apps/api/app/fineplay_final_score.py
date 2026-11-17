"""분석관이 확정하는 경기 최종 점수 (2026-11-11 FinePlay C-21 ②).

점수판용 ``scoreBefore/scoreAfter`` 는 클립마다 그 순간 점수라, 클립을 안 만든 골이 마지막
클립 뒤에 있으면 경기 최종 점수와 다르다. 그래서 분석관이 화면에서 한 번 확정하고, 확정한
값만 FinePlay 결과에 ``finalScore`` 로 싣는다. 확정 전이면 키를 아예 넣지 않는다 — FinePlay 는
키가 없으면 신청자가 넣은 점수를 그대로 둔다.

저장은 잡 메타(``job_metadata["final_score"]``)에 한다. 점수판·FPA 연결·사이드별 링크와 같은
자리이고, 컬럼을 늘리지 않으니 스키마 패치가 필요 없다(README "Runtime schema patch").

    {"home": 2, "away": 1, "confirmed_at": "2026-11-11T03:00:00Z",
     "confirmed_by": {"id": 3, "email": "..."}}

점수는 콘솔 화면과 같이 **[홈, 원정]** 으로 둔다. FinePlay 신청 관점(우리 : 상대)으로는
보낼 때 바꾼다 — 일반 잡은 ``fpa_link.our_side``, 사전 작업은 링크된 사이드가 '우리'다.
자체전은 A팀(신청 라인업) = 우리, B팀 = 상대로 같은 규칙이다.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

FINAL_SCORE_KEY = "final_score"
MAX_SCORE = 99


def normalize(home: Any, away: Any) -> tuple[int, int]:
    """0~99 정수 둘. 아니면 ValueError — 화면 입력을 그대로 받으므로 문자열 숫자도 받는다."""
    out: list[int] = []
    for raw in (home, away):
        if isinstance(raw, bool):
            raise ValueError("점수는 숫자여야 합니다.")
        try:
            value = int(str(raw).strip())
        except (TypeError, ValueError):
            raise ValueError("점수는 숫자여야 합니다.") from None
        if value < 0 or value > MAX_SCORE:
            raise ValueError(f"점수는 0~{MAX_SCORE} 사이여야 합니다.")
        out.append(value)
    return out[0], out[1]


def stored(metadata: Any) -> dict[str, Any] | None:
    """확정해 둔 값. 모양이 깨졌으면 없는 것으로 본다(보내지 않는 쪽이 안전하다)."""
    raw = (metadata or {}).get(FINAL_SCORE_KEY) if isinstance(metadata, dict) else None
    if not isinstance(raw, dict):
        return None
    try:
        home, away = normalize(raw.get("home"), raw.get("away"))
    except ValueError:
        return None
    return {**raw, "home": home, "away": away}


def our_side(metadata: Any, side: str | None = None) -> str:
    """'우리' 사이드 — 사전 작업은 넘겨받은 링크 사이드, 일반 잡은 FPA 연결의 our_side(없으면 홈)."""
    if side in ("home", "away"):
        return side
    fpa_link = (metadata or {}).get("fpa_link") if isinstance(metadata, dict) else None
    value = str((fpa_link or {}).get("our_side") or "home").strip().lower()
    return value if value in ("home", "away") else "home"


def suggested(metadata: Any) -> tuple[int, int] | None:
    """화면 기본값 — 태깅 순서상 마지막 클립의 scoreAfter([홈, 원정]). 점수판을 안 썼으면 None.

    정렬은 렌더와 같은 (매니페스트 영상 순서, 시작 초)다. 마지막 클립 뒤의 '점수만' 골은 여기
    안 잡히므로, 화면은 태그로 다시 센 값을 먼저 쓰고 이건 화면을 안 연 잡의 기본값이다.
    """
    meta = metadata if isinstance(metadata, dict) else {}
    clips = [c for c in (meta.get("clips") or []) if isinstance(c, dict)]
    videos = ((meta.get("manifest") or {}).get("videos") or []) if isinstance(meta.get("manifest"), dict) else []
    order = {str(v.get("videoId") or v.get("id") or ""): i for i, v in enumerate(videos) if isinstance(v, dict)}

    def key(c: dict) -> tuple[int, float]:
        try:
            start = float(c.get("start") or 0)
        except (TypeError, ValueError):
            start = 0.0
        return (order.get(str(c.get("sourceVideoId") or ""), 0), start)

    for clip in sorted(clips, key=key, reverse=True):
        after = clip.get("scoreAfter")
        if isinstance(after, (list, tuple)) and len(after) == 2:
            try:
                return normalize(after[0], after[1])
            except ValueError:
                continue
    return None


def confirm(metadata: dict, home: Any, away: Any, *, actor: dict[str, Any] | None,
            now: datetime | None = None) -> tuple[dict[str, Any], bool]:
    """확정(또는 고침). (저장할 값, 바뀌었는가). 같은 값을 다시 확정하면 시각·확정자를 그대로 둔다."""
    h, a = normalize(home, away)
    before = stored(metadata)
    if before and before["home"] == h and before["away"] == a:
        return before, False
    at = (now or datetime.now(timezone.utc)).astimezone(timezone.utc).replace(microsecond=0)
    value = {
        "home": h,
        "away": a,
        "confirmed_at": at.isoformat().replace("+00:00", "Z"),
        "confirmed_by": actor or None,
    }
    if before:
        value["previous"] = {"home": before["home"], "away": before["away"],
                             "confirmed_at": before.get("confirmed_at")}
    return value, True


def for_request(metadata: Any, side: str | None = None) -> dict[str, Any] | None:
    """analysis-results 의 finalScore — 신청 관점 {our, opponent, confirmedAt}. 확정 전이면 None."""
    value = stored(metadata)
    if not value:
        return None
    ours = our_side(metadata, side)
    our, opponent = (value["home"], value["away"]) if ours == "home" else (value["away"], value["home"])
    out: dict[str, Any] = {"our": our, "opponent": opponent}
    if value.get("confirmed_at"):
        out["confirmedAt"] = value["confirmed_at"]
    return out


def for_competition(metadata: Any) -> dict[str, Any] | None:
    """competition-results 의 finalScore — 대회는 '우리 팀'이 없어 teams[].side 기준 {home, away, confirmedAt}."""
    value = stored(metadata)
    if not value:
        return None
    out: dict[str, Any] = {"home": value["home"], "away": value["away"]}
    if value.get("confirmed_at"):
        out["confirmedAt"] = value["confirmed_at"]
    return out


def attach(payload: dict[str, Any], metadata: Any, side: str | None = None) -> dict[str, Any]:
    """전송 직전 — 확정값이 있으면 싣고, 없으면 키를 뺀다(예전에 저장해 둔 payload 를 다시 보낼 때도 맞게)."""
    if not isinstance(payload, dict):
        return payload
    score = for_request(metadata, side)
    if score:
        payload["finalScore"] = score
    else:
        payload.pop("finalScore", None)
    return payload


def attach_competition(payload: dict[str, Any], metadata: Any) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return payload
    score = for_competition(metadata)
    if score:
        payload["finalScore"] = score
    else:
        payload.pop("finalScore", None)
    return payload
