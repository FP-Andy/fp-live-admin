"""FinePlay 신청 골라 가져오기 · 매니페스트 비교 · FHL job.json 구간 → 클립 (2026-11-25, T4).

왜 따로 두나
------------
1. 골라 가져오기 — 예전 [새 작업 가져오기]는 대기열을 받자마자 **전부** claim 했다. claim 하는 순간 FinePlay 에서는
   ANALYZING(분석 중)이 되고 팀에 알림이 간다. 지금 처리하지 않을 신청까지 '분석 중'이 됐다. FinePlay 의
   GET /jobs 는 claim 없이 매니페스트만 주므로, 먼저 그걸로 미리보기를 보여 주고 고른 것만 claim 한다.
2. 매니페스트 다시 받기 — 통째로 갈아끼우면 FPC 에서 손본 라인업(직접 넣은 선수)이 사라진다. 갈아끼우기 전에
   무엇이 바뀌는지 보여 준다.
3. FHL job.json — 대회 중에는 노트북 FHL 합본으로 원본을 바꾼다. 합본만 오면 다시 태깅해야 한다(이중 태깅).
   FinePlay 가 매니페스트 videos[].fhlJob 에 FHL 의 클립 구간을 실어 주면 그 구간대로 바로 자른다.

이 모듈은 DB·네트워크를 만지지 않는 순수 함수만 둔다(테스트 고정용).
"""

from __future__ import annotations

from typing import Any, Callable

from .fineplay_plan import plan_from_manifest

# ── FHL 구간 → 클립 ──────────────────────────────────────────────────────────

FHL_SCHEMA = "fhl-job/v2"
# FHL 이 카드·인트로와 클립 사이에 넣는 전환 길이. job.json 에 이음매 길이가 따로 없어 이 값으로 추정한다
# (FHL 0.19.1: 클립↔클립 0.2초, 카드↔클립 0.4초). 클립끼리 겹친 구간은 실제 겹친 만큼 깎는다.
FHL_CARD_JOIN_SEC = 0.4
# 이보다 작은 틈은 하드컷으로 본다(프레임·반올림 차이)
FHL_GAP_EPS = 0.05
# 깎은 뒤 이보다 짧아지면 깎지 않은 구간을 쓴다
FHL_MIN_CLIP_SEC = 1.0
# 장면 클립이 아닌 종류 — 점수판만 올리는 골, 구간 카드 자리. 합본에 장면이 없거나 카드다
FHL_SKIP_KINDS = {"home_goal_only", "away_goal_only", "section"}


def _num(v: Any) -> float | None:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if f == f and f not in (float("inf"), float("-inf")) else None


def _score(v: Any) -> list[int] | None:
    if not isinstance(v, (list, tuple)) or len(v) != 2:
        return None
    try:
        return [max(0, int(v[0])), max(0, int(v[1]))]
    except (TypeError, ValueError):
        return None


def fhl_video(manifest: dict) -> tuple[dict, dict] | None:
    """FHL 기록이 붙은 첫 영상 (video, fhlJob). 없으면 None."""
    for v in (manifest or {}).get("videos") or []:
        if isinstance(v, dict) and isinstance(v.get("fhlJob"), dict) and (v["fhlJob"].get("clips") or []):
            return v, v["fhlJob"]
    return None


def fhl_clip_entries(manifest: dict, fpc_our_side: str = "home") -> dict:
    """매니페스트의 FHL 기록을 신청 태깅 clips 항목(생성 요청과 같은 모양)으로 바꾼다.

    돌려주는 것: {videoId, clips:[...], skipped:{kind: n}, trimmed: n, ourSide}
    - 종류: home*/away* = FHL 의 홈/원정. FHL 홈이 신청팀(ourSide=home)이면 그 쪽이 FPC 의 우리 사이드다.
    - 점수 [홈, 원정] 도 FPC 슬롯(홈/원정) 기준으로 뒤집는다.
    - 전환 구간: 이웃 클립과 겹치면 겹친 만큼, 카드·인트로(틈)와 닿으면 FHL_CARD_JOIN_SEC 만큼 안쪽으로 깎는다.
    """
    found = fhl_video(manifest)
    if not found:
        return {"videoId": None, "clips": [], "skipped": {}, "trimmed": 0, "ourSide": None}
    video, job = found
    fpc_our = "away" if str(fpc_our_side).lower() == "away" else "home"
    fpc_opp = "home" if fpc_our == "away" else "away"
    fhl_home_is_team = str(job.get("ourSide") or "home").lower() != "away"
    # FHL 홈이 FPC 의 어느 슬롯인가
    fhl_home_slot = fpc_our if fhl_home_is_team else fpc_opp
    swap_scores = fhl_home_slot != "home"
    export_duration = _num(job.get("exportDuration"))

    raw = []
    for c in job.get("clips") or []:
        if not isinstance(c, dict):
            continue
        s, e = _num(c.get("exportStart")), _num(c.get("exportEnd"))
        if s is None or e is None or e <= s:
            continue
        raw.append((s, e, c))
    raw.sort(key=lambda t: t[0])

    clips: list[dict] = []
    skipped: dict[str, int] = {}
    trimmed = 0
    for i, (s, e, c) in enumerate(raw):
        kind = str(c.get("kind") or "")
        if kind in FHL_SKIP_KINDS or not (kind.startswith("home") or kind.startswith("away")):
            skipped[kind or "(없음)"] = skipped.get(kind or "(없음)", 0) + 1
            continue
        prev_end = raw[i - 1][1] if i > 0 else None
        next_start = raw[i + 1][0] if i + 1 < len(raw) else None
        # 머리: 앞 클립과 겹치면 겹친 만큼, 앞에 틈(카드·인트로)이 있으면 카드 전환만큼
        if prev_end is not None and prev_end > s + FHL_GAP_EPS:
            head = prev_end - s
        elif (prev_end is not None and s - prev_end > FHL_GAP_EPS) or (prev_end is None and s > FHL_GAP_EPS):
            head = FHL_CARD_JOIN_SEC
        else:
            head = 0.0
        # 꼬리: 뒤 클립과 겹치면 겹친 만큼, 뒤에 틈(카드)이나 합본 끝까지 남은 게 있으면 카드 전환만큼
        if next_start is not None and next_start < e - FHL_GAP_EPS:
            tail = e - next_start
        elif (next_start is not None and next_start - e > FHL_GAP_EPS) or (
                next_start is None and export_duration is not None and export_duration - e > FHL_GAP_EPS):
            tail = FHL_CARD_JOIN_SEC
        else:
            tail = 0.0
        start, end = s + head, e - tail
        if end - start < FHL_MIN_CLIP_SEC:
            start, end = s, e
        elif head or tail:
            trimmed += 1

        is_home_kind = kind.startswith("home")
        team = fhl_home_slot if is_home_kind else ("away" if fhl_home_slot == "home" else "home")
        before, after = _score(c.get("scoreBefore")), _score(c.get("scoreAfter"))
        if swap_scores:
            before = [before[1], before[0]] if before else None
            after = [after[1], after[0]] if after else None
        tag = _num(c.get("tagExport"))
        goal_at = round(min(max(tag - start, 0.0), end - start), 3) if tag is not None else None
        clips.append({
            "start": round(start, 3),
            "end": round(end, 3),
            "team": team,
            "mainAction": None,
            "makeVertical": False,
            "sourceVideoId": str(video.get("videoId") or "") or None,
            "clipId": None,
            "scoreBefore": before,
            "scoreAfter": after,
            "goalAt": goal_at,
            "isGoal": kind.endswith("_goal"),
            # 어디서 왔는지 — 화면이 'FHL n번' 으로 보여 준다. 렌더·전송은 이 키를 읽지 않는다
            "fhlOrder": c.get("order"),
        })
    return {"videoId": video.get("videoId"), "clips": clips, "skipped": skipped, "trimmed": trimmed,
            "ourSide": "home" if fhl_home_is_team else "away"}


# ── 미리보기 ────────────────────────────────────────────────────────────────

def _uniform(block: dict | None) -> dict | None:
    if not isinstance(block, dict):
        return None
    u = block.get("uniform") if isinstance(block.get("uniform"), dict) else {}
    primary = u.get("primaryArgb") if u else None
    if primary is None:
        primary = block.get("jerseyColorArgb")
    if primary is None and not u:
        return None
    return {"kind": u.get("kind"), "primaryArgb": primary, "secondaryArgb": u.get("secondaryArgb"),
            "imageUrl": u.get("imageUrl")}


def _lineup_rows(lineup: Any) -> list[dict]:
    out = []
    for p in lineup or []:
        if not isinstance(p, dict):
            continue
        out.append({
            "jerseyNumber": p.get("jerseyNumber"),
            "name": p.get("name"),
            "positionSlot": p.get("positionSlot"),
            "isSubstitute": bool(p.get("isSubstitute")),
        })
    return out


def preview_row(manifest: dict, existing: dict | None, own_worker_id: str) -> dict:
    """대기열 매니페스트 1건 → 미리보기 한 줄. 영상은 개수·길이 한 줄로만.

    existing: 이미 FPC 에 있는 잡의 {status, archived, job_id} (없으면 None)
    state: new(고를 수 있음) / imported(이미 가져옴) / taken(다른 워커가 잡았던 건 — 표시만)
    """
    m = manifest or {}
    team = m.get("team") or {}
    opp = m.get("opponent") or {}
    match = m.get("match") or {}
    videos = [v for v in (m.get("videos") or []) if isinstance(v, dict)]
    total = sum(int(v.get("durationSeconds") or 0) for v in videos)
    sources = sorted({str(v.get("source") or "UPLOAD").upper() for v in videos})
    fhl = fhl_video(m)
    claim = m.get("claim") or {}
    claimed_by = str(claim.get("claimedBy") or "").strip()
    if existing:
        state = "imported"
    elif claimed_by and claimed_by != own_worker_id:
        state = "taken"
    else:
        state = "new"
    plan = plan_from_manifest(m)
    return {
        "analysisRequestId": m.get("analysisRequestId"),
        "state": state,
        "existing": existing,
        "claimedBy": claimed_by or None,
        "leaseExpiresAt": claim.get("leaseExpiresAt"),
        "submittedAt": m.get("submittedAt"),
        "teamName": team.get("teamName"),
        "teamId": team.get("teamId"),
        "tier": plan.get("tier"),
        "options": plan.get("options"),
        "matchKind": m.get("matchKind"),
        "matchDate": match.get("matchDate"),
        "placeName": match.get("placeName"),
        "opponentName": opp.get("name"),
        "score": [match.get("ourScore"), match.get("opponentScore")],
        "uniform": _uniform(team),
        "opponentUniform": _uniform(opp),
        "formation": m.get("formation"),
        "lineup": _lineup_rows(m.get("lineup")),
        "opponentFormation": m.get("opponentFormation"),
        "opponentLineup": _lineup_rows(m.get("opponentLineup")) if m.get("opponentLineup") else None,
        "competition": m.get("competition"),
        "videos": {"count": len(videos), "totalSeconds": total, "sources": sources},
        "fhl": ({"clips": len(fhl[1].get("clips") or []), "exportDuration": fhl[1].get("exportDuration"),
                 "ourSide": fhl[1].get("ourSide")} if fhl else None),
    }


def walk_queue(poll: Callable[[int, Any], list], *, limit: int = 20, max_pages: int = 25) -> tuple[list[dict], bool]:
    """대기열을 limit 건씩 cursor(마지막 신청 번호)로 끝까지 읽는다 → (매니페스트들, 잘림 여부).

    FinePlay 는 후보를 limit×3 만큼 읽어 영상 준비가 안 된 건을 거른 뒤 limit 건을 준다 — 그래서 한 쪽이
    limit 보다 적어도 뒤에 더 있을 수 있다. 빈 쪽이 나올 때까지 읽는다.
    """
    out: list[dict] = []
    seen: set = set()
    cursor = None
    for _ in range(max_pages):
        page = poll(limit, cursor)
        page = page if isinstance(page, list) else (page.get("jobs") or [])
        fresh = [m for m in page if isinstance(m, dict) and m.get("analysisRequestId") not in seen]
        if not fresh:
            return out, False
        for m in fresh:
            seen.add(m.get("analysisRequestId"))
            out.append(m)
        ids = [m.get("analysisRequestId") for m in fresh if isinstance(m.get("analysisRequestId"), (int, str))]
        try:
            cursor = max(int(i) for i in ids)
        except (TypeError, ValueError):
            return out, False
    return out, True


# ── 매니페스트 비교 ──────────────────────────────────────────────────────────

def _key(p: dict) -> str:
    n = str(p.get("jerseyNumber") if p.get("jerseyNumber") is not None else "").strip()
    return n or f"name:{str(p.get('name') or '').strip()}"


def lineup_diff(old: Any, new: Any) -> dict:
    """등번호 기준 비교 → {added, removed, changed, same}. removed 의 manualAdded = FPC 에서 직접 넣은 선수."""
    old_rows = {_key(p): p for p in (old or []) if isinstance(p, dict)}
    new_rows = {_key(p): p for p in (new or []) if isinstance(p, dict)}
    added, removed, changed = [], [], []
    same = 0
    for k, p in new_rows.items():
        if k not in old_rows:
            added.append({"jerseyNumber": p.get("jerseyNumber"), "name": p.get("name"),
                          "positionSlot": p.get("positionSlot"), "isSubstitute": bool(p.get("isSubstitute"))})
            continue
        o = old_rows[k]
        fields = {}
        for f in ("name", "positionSlot"):
            if str(o.get(f) or "") != str(p.get(f) or ""):
                fields[f] = [o.get(f), p.get(f)]
        if bool(o.get("isSubstitute")) != bool(p.get("isSubstitute")):
            fields["isSubstitute"] = [bool(o.get("isSubstitute")), bool(p.get("isSubstitute"))]
        if fields:
            changed.append({"jerseyNumber": p.get("jerseyNumber"), "name": p.get("name"), "fields": fields})
        else:
            same += 1
    for k, o in old_rows.items():
        if k not in new_rows:
            removed.append({"jerseyNumber": o.get("jerseyNumber"), "name": o.get("name"),
                            "positionSlot": o.get("positionSlot"), "manualAdded": bool(o.get("manualAdded"))})
    return {"added": added, "removed": removed, "changed": changed, "same": same}


def keep_manual_players(old: Any, new: Any) -> tuple[list, list]:
    """새 라인업 + FPC 에서 직접 넣은 선수 중 새 라인업에 없는 등번호 → (합친 라인업, 남긴 선수)."""
    new_list = [p for p in (new or []) if isinstance(p, dict)]
    keys = {_key(p) for p in new_list}
    kept = [p for p in (old or []) if isinstance(p, dict) and p.get("manualAdded") and _key(p) not in keys]
    return new_list + kept, kept


def manifest_diff(old: dict, new: dict) -> dict:
    """매니페스트 다시 받기 전 비교 — 라인업·포메이션·상대·스코어·날짜·장소·영상·FHL."""
    old, new = old or {}, new or {}
    om, nm = old.get("match") or {}, new.get("match") or {}
    fields = []

    def cmp(label: str, a: Any, b: Any):
        if (a if a not in ("", None) else None) != (b if b not in ("", None) else None):
            fields.append({"label": label, "before": a, "after": b})

    cmp("포메이션", old.get("formation"), new.get("formation"))
    cmp("상대", (old.get("opponent") or {}).get("name"), (new.get("opponent") or {}).get("name"))
    cmp("스코어", [om.get("ourScore"), om.get("opponentScore")], [nm.get("ourScore"), nm.get("opponentScore")])
    cmp("날짜", om.get("matchDate"), nm.get("matchDate"))
    cmp("장소", om.get("placeName"), nm.get("placeName"))
    cmp("대회", (old.get("competition") or {}).get("name"), (new.get("competition") or {}).get("name"))

    def vids(m):
        return [{"videoId": v.get("videoId"), "source": v.get("source"),
                 "durationSeconds": v.get("durationSeconds"),
                 "fhlClips": len(((v.get("fhlJob") or {}).get("clips")) or []) if isinstance(v.get("fhlJob"), dict) else 0}
                for v in (m.get("videos") or []) if isinstance(v, dict)]

    ov, nv = vids(old), vids(new)
    out = {
        "fields": fields,
        "lineup": lineup_diff(old.get("lineup"), new.get("lineup")),
        "videos": {"before": ov, "after": nv, "changed": ov != nv},
    }
    if old.get("opponentLineup") or new.get("opponentLineup"):
        out["opponentLineup"] = lineup_diff(old.get("opponentLineup"), new.get("opponentLineup"))
    return out
