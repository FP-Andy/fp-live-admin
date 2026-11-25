"""xFP 검증 조회 — FPC 액션과 FinePlay 운영 저장본을 액션 단위로 대조한다 (T6, 2026-11-25).

REST(콘솔, 관리자 세션)와 MCP(AI 도구, 읽기 전용 토큰)가 **이 모듈 하나**를 같이 쓴다. 같은 필터면 같은 행·같은 집계다.

경계(보안 검증용 요약)
- 조회만 한다. 잡·클립·액션·태깅·게시 점수를 쓰지 않고, 재전송·재채점·저장 경로를 부르지 않는다.
  `/source-url` 도 부르지 않는다(영상 검사 기록이 생긴다). 서명 URL 을 만들지 않는다 — 재생 가능 여부는 키가 있는지로만 본다.
- 운영 저장본은 FinePlay `GET /api/internal/xfp/validation/published`(기존 FPC 서비스 토큰)로 50개씩 묶어 읽는다.
- 응답은 허용 목록으로 만든다. 행위자는 팀 내 등번호로만 내보낸다 — playerId·userId·이름·라인업·스토리지 키는 칸이 없다.
- 미계산은 None(→ JSON null), 관측된 0 은 0 그대로 둔다.

조인: requestId(+side) + clipKey + seq. 양쪽에 값이 있으면 팀·액션 코드·등번호도 대조한다.
붙지 않거나 어긋난 행도 지우지 않고 join/issues 로 남긴다(집계에서 사라지지 않게).

설계: 볼트 FinePlay-Brain/연결성/29_xFP_검증조회_MCP_설계.md
"""
from __future__ import annotations

import base64
import copy
import csv
import io
import zipfile
import hashlib
import json
import logging
import os
import threading
import time
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from typing import Any, Callable, Iterable
from urllib.parse import urlencode
from uuid import UUID

from sqlalchemy.orm import Session

from . import fineplay_scrimmage
from .fineplay_fpa import annotate_action_codes, base_action_name, canonical_action_name
from .models import AuditLog, HighlightClip, HighlightClipAction, HighlightJob, Match

log = logging.getLogger("fpc.xfp_validation")

SCHEMA_VERSION = "xfp-validation/v1"
MODELS = ("pc", "epv", "xg", "xgot", "xrc")
RANGE_KEYS = MODELS + ("xfpScore",)
PAGE_DEFAULT = 50
PAGE_MAX = 200
BACKEND_BATCH = 50
JOIN_STATES = ("matched", "mismatch", "fpcOnly", "publishedOnly")
ISSUE_CODES = (
    "NO_REQUEST_LINK", "REQUEST_NOT_FOUND", "PAIR_NOT_CREATED", "IS_PAIR_ROW", "NOT_SCRIMMAGE",
    "BACKEND_UNAVAILABLE", "NOT_PUBLISHED", "PUBLISHED_ACTION_MISSING", "FPC_ACTION_MISSING",
    "FPC_CLIP_MISSING", "TEAM_MISMATCH", "ACTION_CODE_MISMATCH", "JERSEY_MISMATCH", "JERSEY_UNVERIFIABLE",
)
TIME_SOURCES = ("recorded", "manual", "inferred", "unknown")
DUAL_SOURCES = ("original", "metricsOnly", "missing")
# 저장본 대상 상태 → 행 사유 코드
_TARGET_ISSUE = {
    "NOT_FOUND": "REQUEST_NOT_FOUND",
    "PAIR_NOT_CREATED": "PAIR_NOT_CREATED",
    "IS_PAIR_ROW": "IS_PAIR_ROW",
    "NOT_SCRIMMAGE": "NOT_SCRIMMAGE",
    "BACKEND_UNAVAILABLE": "BACKEND_UNAVAILABLE",
}


class ValidationInputError(ValueError):
    """필터·커서가 잘못됐다 — REST 는 400, MCP 는 isError 결과로 돌려준다."""


# ── 운영 저장본 읽기(배치 + 짧은 캐시) ───────────────────────────────────────

PublishedFetcher = Callable[[list[str]], dict[str, dict]]

_CACHE: dict[str, tuple[float, dict]] = {}
_CACHE_LOCK = threading.Lock()


def _cache_seconds() -> float:
    try:
        return max(0.0, float(os.getenv("FPC_XFP_VALIDATION_CACHE_SECONDS", "60")))
    except ValueError:
        return 60.0


def clear_cache() -> None:
    with _CACHE_LOCK:
        _CACHE.clear()


def backend_fetcher(client: Any) -> PublishedFetcher:
    """FinePlayClient 로 50개씩 읽는다. 실패한 묶음은 BACKEND_UNAVAILABLE 로 표시(행은 남는다)."""

    def fetch(targets: list[str]) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for i in range(0, len(targets), BACKEND_BATCH):
            chunk = targets[i:i + BACKEND_BATCH]
            try:
                body = client.get_validation_published(chunk)
                for result in body.get("results") or []:
                    if isinstance(result, dict) and result.get("target"):
                        out[str(result["target"]).upper()] = result
            except Exception as exc:  # 네트워크·401·5xx — 토큰은 메시지에 없다(httpx 는 헤더를 싣지 않는다)
                log.warning("[xfp-validation] 저장본 조회 실패 — %s개 대상: %s", len(chunk), type(exc).__name__)
                for t in chunk:
                    out[t] = {"target": t, "status": "BACKEND_UNAVAILABLE", "clips": [],
                              "error": type(exc).__name__}
        return out

    return fetch


def _fetch_published(targets: Iterable[str], fetcher: PublishedFetcher) -> dict[str, dict]:
    wanted = sorted({t.upper() for t in targets if t})
    now = time.monotonic()
    ttl = _cache_seconds()
    hit: dict[str, dict] = {}
    miss: list[str] = []
    with _CACHE_LOCK:
        for t in wanted:
            cached = _CACHE.get(t)
            if cached and now - cached[0] < ttl:
                hit[t] = cached[1]
            else:
                miss.append(t)
    if miss:
        fresh = fetcher(miss)
        with _CACHE_LOCK:
            for t in miss:
                result = fresh.get(t) or {"target": t, "status": "BACKEND_UNAVAILABLE", "clips": []}
                hit[t] = result
                # 실패는 캐시하지 않는다 — 다음 호출에서 다시 읽는다.
                if result.get("status") != "BACKEND_UNAVAILABLE" and ttl > 0:
                    _CACHE[t] = (now, result)
    return hit


# ── 필터 ─────────────────────────────────────────────────────────────────────

def _as_list(value: Any) -> list[str]:
    if value is None or value == "":
        return []
    if isinstance(value, str):
        return [v.strip() for v in value.split(",") if v.strip()]
    if isinstance(value, (list, tuple, set)):
        return [str(v).strip() for v in value if str(v).strip()]
    return [str(value).strip()]


def _as_float(value: Any, name: str) -> float | None:
    if value is None or value == "":
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        raise ValidationInputError(f"{name} 는 숫자여야 합니다: {value!r}") from None


def _as_date(value: Any, name: str) -> str | None:
    if value is None or value == "":
        return None
    try:
        return date.fromisoformat(str(value)[:10]).isoformat()
    except ValueError:
        raise ValidationInputError(f"{name} 는 YYYY-MM-DD 입니다: {value!r}") from None


@dataclass
class Filters:
    job_ids: list[str] = field(default_factory=list)
    request_ids: list[int] = field(default_factory=list)
    sides: list[str] = field(default_factory=list)
    action_codes: list[str] = field(default_factory=list)
    actions: list[str] = field(default_factory=list)
    base_actions: list[str] = field(default_factory=list)
    has_models: list[str] = field(default_factory=list)
    value_source: str = "published"
    min_value: dict[str, float] = field(default_factory=dict)
    max_value: dict[str, float] = field(default_factory=dict)
    joins: list[str] = field(default_factory=list)
    issues: list[str] = field(default_factory=list)
    date_from: str | None = None
    date_to: str | None = None
    archived_only: bool = False

    def fingerprint(self) -> str:
        raw = json.dumps(self.__dict__, sort_keys=True, ensure_ascii=False, default=str)
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:16]

    def echo(self) -> dict[str, Any]:
        """응답·감사 로그에 남길 필터 범위(빈 칸은 뺀다)."""
        return {k: v for k, v in {
            "jobIds": self.job_ids, "requestIds": self.request_ids, "sides": self.sides,
            "actionCodes": self.action_codes, "actions": self.actions, "baseActions": self.base_actions,
            "hasModels": self.has_models, "valueSource": self.value_source,
            "minValue": self.min_value, "maxValue": self.max_value, "join": self.joins, "issues": self.issues,
            "dateFrom": self.date_from, "dateTo": self.date_to, "archivedOnly": self.archived_only or None,
        }.items() if v not in (None, [], {}, "")}


def parse_filters(raw: dict[str, Any] | None) -> Filters:
    """MCP 인자(JSON)와 REST 쿼리(문자열·쉼표)를 같은 Filters 로 바꾼다."""
    raw = dict(raw or {})
    f = Filters()
    f.job_ids = _as_list(raw.get("jobIds"))
    try:
        f.request_ids = [int(v) for v in _as_list(raw.get("requestIds"))]
    except ValueError:
        raise ValidationInputError("requestIds 는 숫자 목록입니다.") from None
    sides = _as_list(raw.get("side") if raw.get("side") is not None else raw.get("sides"))
    f.sides = []
    for s in sides:
        norm = s.upper() if s.upper() in ("A", "B") else s.lower()
        if norm not in ("A", "B", "home", "away", "-"):
            raise ValidationInputError(f"side 는 A·B(자체전)·home·away(사전 작업)·-(일반) 입니다: {s!r}")
        f.sides.append(norm)
    f.action_codes = [c.upper() for c in _as_list(raw.get("actionCodes"))]
    f.actions = _as_list(raw.get("actions"))
    f.base_actions = _as_list(raw.get("baseActions"))
    f.has_models = [m.lower() for m in _as_list(raw.get("hasModels"))]
    for m in f.has_models:
        if m not in MODELS:
            raise ValidationInputError(f"hasModels 는 {', '.join(MODELS)} 중에서: {m!r}")
    vs = str(raw.get("valueSource") or "published")
    if vs not in ("published", "fpcCurrent"):
        raise ValidationInputError("valueSource 는 published 또는 fpcCurrent 입니다.")
    f.value_source = vs
    for bound, target in (("minValue", f.min_value), ("maxValue", f.max_value)):
        value = raw.get(bound)
        if isinstance(value, str) and value.strip():
            try:
                value = json.loads(value)
            except ValueError:
                raise ValidationInputError(f"{bound} 는 {{\"pc\":0.1}} 형태의 JSON 입니다.") from None
        if value in (None, ""):
            value = {}
        if not isinstance(value, dict):
            raise ValidationInputError(f"{bound} 는 객체입니다.")
        for key, v in value.items():
            if key not in RANGE_KEYS:
                raise ValidationInputError(f"{bound} 키는 {', '.join(RANGE_KEYS)} 중에서: {key!r}")
            num = _as_float(v, f"{bound}.{key}")
            if num is not None:
                target[key] = num
    # REST 편의: min_pc=0.1&max_epv=0.5
    for key in RANGE_KEYS:
        for prefix, target in (("min_", f.min_value), ("max_", f.max_value)):
            num = _as_float(raw.get(prefix + key), prefix + key)
            if num is not None:
                target[key] = num
    f.joins = _as_list(raw.get("join"))
    for j in f.joins:
        if j not in JOIN_STATES:
            raise ValidationInputError(f"join 은 {', '.join(JOIN_STATES)} 중에서: {j!r}")
    f.issues = [i.upper() for i in _as_list(raw.get("issues"))]
    for i in f.issues:
        if i not in ISSUE_CODES:
            raise ValidationInputError(f"issues 는 {', '.join(ISSUE_CODES)} 중에서: {i!r}")
    f.date_from = _as_date(raw.get("dateFrom"), "dateFrom")
    f.date_to = _as_date(raw.get("dateTo"), "dateTo")
    archived = raw.get("archivedOnly")
    f.archived_only = archived is True or str(archived).lower() in ("1", "true", "yes")
    return f


def parse_limit(value: Any) -> int:
    if value is None or value == "":
        return PAGE_DEFAULT
    try:
        n = int(value)
    except (TypeError, ValueError):
        raise ValidationInputError("limit 는 정수입니다.") from None
    if n < 1:
        raise ValidationInputError("limit 는 1 이상입니다.")
    return min(n, PAGE_MAX)


# ── 커서(keyset) ─────────────────────────────────────────────────────────────

def _encode_cursor(sort_key: list, fingerprint: str) -> str:
    raw = json.dumps({"k": sort_key, "f": fingerprint}, separators=(",", ":"), ensure_ascii=False)
    return base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii").rstrip("=")


def _decode_cursor(cursor: str | None, fingerprint: str) -> list | None:
    if not cursor:
        return None
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        data = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
        key = data["k"]
        fp = data["f"]
    except Exception:
        raise ValidationInputError("cursor 가 올바르지 않습니다.") from None
    if fp != fingerprint:
        raise ValidationInputError("cursor 는 같은 필터로만 씁니다 — 필터가 바뀌었으면 cursor 없이 처음부터 부르세요.")
    return key


def _page(items: list[dict], *, key: Callable[[dict], list], limit: int, cursor: str | None,
          fingerprint: str) -> tuple[list[dict], str | None]:
    after = _decode_cursor(cursor, fingerprint)
    ordered = sorted(items, key=key)
    if after is not None:
        ordered = [r for r in ordered if key(r) > after]
    page = ordered[:limit]
    next_cursor = _encode_cursor(key(page[-1]), fingerprint) if len(ordered) > limit and page else None
    return page, next_cursor


# ── 범위(경기 × side) ─────────────────────────────────────────────────────────

@dataclass
class Scope:
    job: HighlightJob
    side: str | None          # None(일반·합본) | "A"/"B"(자체전 분할) | "home"/"away"(사전 작업 링크)
    request_id: int | None
    target: str | None        # 저장본 조회 키 "460" / "470:B"
    clip_filter: Callable[[HighlightClip], bool]
    match_name: str | None = None
    published: dict | None = None

    @property
    def side_key(self) -> str:
        return self.side or "-"


def _int_or_none(value: Any) -> int | None:
    try:
        return int(str(value).strip()) if value not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _job_scopes(job: HighlightJob) -> list[Scope]:
    meta = dict(job.job_metadata or {})
    everything = lambda clip: True  # noqa: E731
    if meta.get("standalone"):
        links = meta.get("links") or {}
        scopes = []
        for side in ("home", "away"):
            link = links.get(side) if isinstance(links, dict) else None
            if not isinstance(link, dict):
                continue
            rid = _int_or_none(link.get("analysis_request_id"))
            # 전송 규칙과 같다(_build_clip_result_payload side_filter) — team_side 없는 옛 클립은 양쪽에 들어간다.
            scopes.append(Scope(job, side, rid, str(rid) if rid else None,
                                lambda clip, s=side: not clip.team_side or clip.team_side == s))
        return scopes or [Scope(job, None, None, None, everything)]
    rid = _int_or_none(meta.get("analysis_request_id"))
    sides = fineplay_scrimmage.bundle_sides(meta)
    # 자체전 분할: 묶음 기록이 있거나 아직 한 번도 안 보냈으면 A/B 로 본다. 묶음 기록 없이 보낸 옛 합본은 한 덩어리.
    if sides is not None and (fineplay_scrimmage.bundles(meta) or not meta.get("callback_status")):
        return [
            Scope(job, letter, rid, f"{rid}:{letter}" if rid else None,
                  lambda clip, letter=letter: fineplay_scrimmage.clip_role(
                      clip.team_side, clip.is_goal, side=sides[letter], letter=letter) == "own")
            for letter in fineplay_scrimmage.LETTERS
        ]
    return [Scope(job, None, rid, str(rid) if rid else None, everything)]


def _job_created(job: HighlightJob) -> str:
    return job.created_at.isoformat() if isinstance(job.created_at, datetime) else ""


def _load_scopes(db: Session, f: Filters) -> list[Scope]:
    q = db.query(HighlightJob).filter(HighlightJob.mode == "fineplay")
    if f.job_ids:
        q = q.filter(HighlightJob.id.in_(f.job_ids))
    if f.date_from:
        q = q.filter(HighlightJob.created_at >= datetime.fromisoformat(f.date_from))
    if f.date_to:
        q = q.filter(HighlightJob.created_at < datetime.fromisoformat(f.date_to) + timedelta(days=1))
    jobs = q.order_by(HighlightJob.created_at, HighlightJob.id).all()
    match_ids = []
    for job in jobs:
        mid = (job.job_metadata or {}).get("match_id")
        try:
            match_ids.append(UUID(str(mid))) if mid else None
        except (ValueError, TypeError):
            pass
    names = {str(m.id): m.name for m in db.query(Match).filter(Match.id.in_(match_ids)).all()} if match_ids else {}
    scopes: list[Scope] = []
    for job in jobs:
        meta = job.job_metadata or {}
        if f.archived_only and not meta.get("clip_archived"):
            continue
        for scope in _job_scopes(job):
            if f.sides and scope.side_key not in f.sides:
                continue
            if f.request_ids and scope.request_id not in f.request_ids:
                continue
            scope.match_name = names.get(str(meta.get("match_id"))) or meta.get("display_name") or job.id
            scopes.append(scope)
    return scopes


# ── 듀얼 원본(fpa_scenes) ─────────────────────────────────────────────────────

def _flat_scene_rows(fpa_scenes: Any) -> list[tuple[int, int, dict, dict]]:
    """(장면 번호 1부터, 장면 안 행 번호 1부터, 행, 장면) — 저장 때 rows 를 이 순서로 펼쳐 seq 를 매긴다."""
    scenes = (fpa_scenes or {}).get("scenes") if isinstance(fpa_scenes, dict) else None
    out = []
    if not isinstance(scenes, list):
        return out
    for s_idx, scene in enumerate(scenes, start=1):
        if not isinstance(scene, dict):
            continue
        for r_idx, row in enumerate(scene.get("rows") or [], start=1):
            if isinstance(row, dict):
                out.append((s_idx, r_idx, row, scene))
    return out


def _norm_jersey(value: Any) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    if text.isdigit():
        return text.lstrip("0") or "0"
    return text


def _scene_link(action: HighlightClipAction, flat: list) -> tuple[int, int, dict, dict] | None:
    """seq 번째 행이 이 액션과 같은 행일 때만(팀·등번호·기본 액션 일치) 연결한다. 추정 매칭은 없다."""
    idx = int(action.seq or 0) - 1
    if idx < 0 or idx >= len(flat):
        return None
    s_idx, r_idx, row, scene = flat[idx]
    if str(row.get("Team") or "").strip().lower() != str(action.team_side or "").strip().lower():
        return None
    if _norm_jersey(row.get("Player")) != _norm_jersey(action.jersey):
        return None
    if base_action_name(row.get("Action")) != base_action_name(action.action_name):
        return None
    return s_idx, r_idx, row, scene


def _dot_side(dot: dict, actor_side: str | None) -> str:
    side = str(dot.get("teamSide") or "").strip().lower()
    if side in ("home", "away"):
        return side
    rel = str(dot.get("team") or "").strip().lower()
    if actor_side in ("home", "away") and rel in ("ally", "opponent"):
        return actor_side if rel == "ally" else ("away" if actor_side == "home" else "home")
    return "unknownSide"


def _valid_dots(dots: Any, actor_side: str | None) -> list[tuple[str, dict]]:
    """유효 태깅 점 — 잔상(ghost)·같은 id 중복·같은 편 같은 좌표 중복을 뺀다."""
    out: list[tuple[str, dict]] = []
    seen_ids: set[str] = set()
    seen_pos: set[tuple] = set()
    for dot in dots if isinstance(dots, list) else []:
        if not isinstance(dot, dict) or dot.get("ghost") is True:
            continue
        side = _dot_side(dot, actor_side)
        did = str(dot.get("id") or "").strip()
        if did:
            if did in seen_ids:
                continue
            seen_ids.add(did)
        try:
            pos = (side, round(float(dot.get("meter_x")), 2), round(float(dot.get("meter_y")), 2))
        except (TypeError, ValueError):
            pos = None
        if pos is not None:
            if pos in seen_pos:
                continue
            seen_pos.add(pos)
        out.append((side, dot))
    return out


def _count(dots: list[tuple[str, dict]]) -> dict[str, int]:
    counts = {"home": 0, "away": 0, "unknownSide": 0}
    for side, _ in dots:
        counts[side] = counts.get(side, 0) + 1
    return counts


def _dual(action: HighlightClipAction | None, link: tuple | None, *, with_coords: bool) -> dict[str, Any]:
    if action is None:
        return {"source": "missing", "sceneIndex": None, "sceneRowIndex": None, "before": None, "after": None}
    if link is None:
        has_metrics = any(getattr(action, col) is not None for col in ("pc", "epv", "xg", "xgot", "reception_xg"))
        return {"source": "metricsOnly" if has_metrics else "missing",
                "sceneIndex": None, "sceneRowIndex": None, "before": None, "after": None}
    s_idx, r_idx, row, scene = link
    actor = str(action.team_side or "").strip().lower() or None
    before = _valid_dots(scene.get("beforeDots"), actor)
    after = _valid_dots(scene.get("afterDots"), actor)
    out: dict[str, Any] = {"source": "original", "sceneIndex": s_idx, "sceneRowIndex": r_idx,
                           "before": _count(before), "after": _count(after)}
    if with_coords:
        def dot_view(side: str, d: dict) -> dict:
            return {"id": d.get("id"), "teamSide": side if side != "unknownSide" else None,
                    "jersey": _norm_jersey(d.get("number")), "role": d.get("role"),
                    "x": d.get("meter_x"), "y": d.get("meter_y"), "needsCheck": bool(d.get("needsCheck"))}
        arrows = []
        for a in scene.get("passArrows") or []:
            if isinstance(a, dict):
                arrows.append({k: a.get(k) for k in ("side", "x1", "y1", "x2", "y2", "code", "rowIndex")})
        out["coordinates"] = {
            "coordinateSystem": f"meters({row.get('Sport') or 'FOOTBALL'}: FOOTBALL 105x68, FUTSAL 40x20, FPA 편집기 저장 좌표)",
            "half": row.get("Half"), "direction": row.get("Direction"),
            "beforeDots": [dot_view(s, d) for s, d in before],
            "afterDots": [dot_view(s, d) for s, d in after],
            "passArrows": arrows,
            "primaryRowIndex": scene.get("primary"),
            "rowCoord": row.get("Coord"), "rowReceiver": row.get("Receiver"), "rowTags": row.get("Tags"),
        }
    return out


def _parse_time(value: Any) -> float | None:
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


# ── 행 ───────────────────────────────────────────────────────────────────────

def _console_base() -> str:
    # MCP 응답은 콘솔 밖(AI 도구)에서 읽히므로 절대 주소로 준다. 로컬 시연은 env 로 바꾼다.
    return (os.getenv("FPC_CONSOLE_BASE_URL") or "https://console.fineludens.kr").rstrip("/")


def console_url(job_id: str, side: str | None, clip_id: str | None, t: float | None, time_source: str) -> str:
    params: dict[str, Any] = {"jobId": job_id}
    if side in ("A", "B"):
        params["side"] = side
    if clip_id:
        params["clipId"] = clip_id
        params["t"] = f"{float(t or 0):.2f}".rstrip("0").rstrip(".") if t else "0"
        params["ts"] = time_source
    return f"{_console_base()}/admin/highlight/clips?{urlencode(params)}"


def _fpc_action_dict(a: HighlightClipAction) -> dict[str, Any]:
    """현재 FPC 값 계산용 — 콘솔 상세(_serialize_clip_action)와 같은 칸. 바깥으로는 허용 목록만 나간다."""
    name = canonical_action_name(a.action_name, (a.extra or {}).get("tags"))
    return {
        "seq": a.seq, "action": name, "baseAction": base_action_name(a.action_name),
        "teamSide": a.team_side, "jersey": a.jersey,
        "xg": a.xg, "xgot": a.xgot, "receptionXg": a.reception_xg, "packing": a.packing,
        "epv": a.epv, "pc": a.pc, "startOffset": a.start_offset, "endOffset": a.end_offset,
        "extra": copy.deepcopy(a.extra) if a.extra else a.extra,
    }


def _published_block(pub: dict | None, pub_clip: dict | None, pipeline: str | None) -> dict | None:
    if pub is None:
        return None
    return {
        "actionCode": pub.get("actionCode"), "xfpScore": pub.get("xfpScore"),
        "xfpPercentile": pub.get("xfpPercentile"),
        "pc": pub.get("pc"), "epv": pub.get("epv"), "xg": pub.get("xg"), "xgot": pub.get("xgot"),
        "xrc": pub.get("xrc"), "clipPrimary": pub.get("clipPrimary"),
        "teamSide": pub.get("teamSide"), "jersey": pub.get("jersey"),
        "startOffset": pub.get("startOffset"), "endOffset": pub.get("endOffset"),
        "clipStartSec": (pub_clip or {}).get("startTimeSeconds"), "clipEndSec": (pub_clip or {}).get("endTimeSeconds"),
        "clipKey": (pub_clip or {}).get("clipKey"),
        "storedIn": pub.get("storedIn"),
        "pipelineVersion": (pub_clip or {}).get("pipelineVersion") or pipeline,
    }


def _scope_meta(scope: Scope) -> dict[str, Any]:
    pub = scope.published or {}
    meta = scope.job.job_metadata or {}
    return {
        "jobId": scope.job.id, "matchId": meta.get("match_id"), "matchName": scope.match_name,
        "jobCreatedAt": _job_created(scope.job), "side": scope.side, "requestId": scope.request_id,
        "resolvedRequestId": pub.get("resolvedRequestId"),
    }


def _build_rows(scope: Scope, clips: list[HighlightClip], actions_by_clip: dict[str, list[HighlightClipAction]],
                *, with_coords: bool = False) -> list[dict]:
    meta = _scope_meta(scope)
    pub = scope.published
    if scope.request_id is None:
        scope_issue = "NO_REQUEST_LINK"
    elif pub is None:
        scope_issue = "BACKEND_UNAVAILABLE"
    else:
        scope_issue = _TARGET_ISSUE.get(str(pub.get("status") or ""), None)
    pipeline = (pub or {}).get("pipelineVersion")
    pub_clips = {str(c.get("fpcClipKey") or c.get("clipKey")): c for c in (pub or {}).get("clips") or []} \
        if scope_issue is None else {}
    rows: list[dict] = []
    created = meta["jobCreatedAt"]
    in_scope = [c for c in clips if scope.clip_filter(c)]
    seen_pub_clips: set[str] = set()

    for clip in sorted(in_scope, key=lambda c: (c.order_index or 0, c.id)):
        fpc_actions = sorted(actions_by_clip.get(clip.id, []), key=lambda a: (a.seq or 0, a.id or 0))
        current = annotate_action_codes([_fpc_action_dict(a) for a in fpc_actions]) if fpc_actions else []
        flat = _flat_scene_rows(clip.fpa_scenes)
        pub_clip = pub_clips.get(clip.id)
        if pub_clip is not None:
            seen_pub_clips.add(clip.id)
        pub_by_seq: dict[int, dict] = {}
        pub_noseq: list[dict] = []
        for pa in (pub_clip or {}).get("actions") or []:
            seq = pa.get("seq")
            if isinstance(seq, int) and seq not in pub_by_seq:
                pub_by_seq[seq] = pa
            else:
                pub_noseq.append(pa)
        fpc_seqs = set()
        duration = clip.duration_seconds or max(0.0, (clip.end_sec or 0) - (clip.start_sec or 0))
        playable = bool(clip.horizontal_s3_key)
        for a, cur in zip(fpc_actions, current):
            fpc_seqs.add(a.seq)
            pa = pub_by_seq.get(a.seq)
            issues: list[str] = []
            if scope_issue:
                issues.append(scope_issue)
            elif pub_clip is None:
                issues.append("NOT_PUBLISHED")
            elif pa is None:
                issues.append("PUBLISHED_ACTION_MISSING")
            if pa is not None:
                if pa.get("teamSide") and a.team_side and str(pa["teamSide"]).lower() != str(a.team_side).lower():
                    issues.append("TEAM_MISMATCH")
                if pa.get("actionCode") and cur.get("actionCode") and pa["actionCode"] != cur["actionCode"]:
                    issues.append("ACTION_CODE_MISMATCH")
                if a.jersey and not pa.get("jersey"):
                    issues.append("JERSEY_UNVERIFIABLE")
                elif a.jersey and _norm_jersey(pa.get("jersey")) != _norm_jersey(a.jersey):
                    issues.append("JERSEY_MISMATCH")
            mismatch = any(i in issues for i in ("TEAM_MISMATCH", "ACTION_CODE_MISMATCH", "JERSEY_MISMATCH"))
            join = "fpcOnly" if pa is None else ("mismatch" if mismatch else "matched")
            link = _scene_link(a, flat)
            time_source = "unknown"
            if link is not None and a.start_offset is not None:
                t = _parse_time(link[2].get("Time"))
                if t is not None and 0 < t <= duration + 1 and abs(round(min(t, duration), 2) - float(a.start_offset)) < 0.011:
                    time_source = "recorded"
            t_start = a.start_offset
            rows.append({
                "rowKey": f"{scope.job.id}|{scope.side_key}|{clip.id}|{a.seq}",
                **meta,
                "clipId": clip.id, "clipKey": clip.id, "clipOrder": clip.order_index, "seq": a.seq,
                "fpcActionId": a.id, "sceneIndex": a.fpa_scene_index, "sceneActionIndex": a.fpa_scene_action_index,
                "action": cur.get("action"), "baseAction": cur.get("baseAction"),
                "tags": (a.extra or {}).get("tags"), "teamSide": a.team_side, "jersey": _norm_jersey(a.jersey),
                "join": join, "issues": issues,
                "published": _published_block(pa, pub_clip, pipeline),
                "fpcCurrent": {
                    "actionCode": cur.get("actionCode"), "xfpScore": cur.get("xfpScore"),
                    "pc": a.pc, "epv": a.epv, "xg": a.xg, "xgot": a.xgot, "xrc": a.reception_xg,
                },
                "video": {
                    "clipStartSec": clip.start_sec, "clipEndSec": clip.end_sec, "secondsBase": "clip=원본 영상 기준, action=클립 시작 0",
                    "actionStartSec": t_start, "actionEndSec": a.end_offset, "timeSource": time_source,
                    "playable": playable, "unplayableReason": None if playable else "NO_RENDERED_CLIP",
                    "consoleUrl": console_url(scope.job.id, scope.side, clip.id, t_start, time_source),
                },
                "dual": _dual(a, link, with_coords=with_coords),
                "_sort": [created, scope.job.id, scope.side_key, int(clip.order_index or 0), clip.id, int(a.seq or 0), 0],
            })
        # 저장본에만 있는 액션(FPC 에서 지워졌거나 다시 태깅됨)
        for pa in [p for s, p in sorted(pub_by_seq.items()) if s not in fpc_seqs] + pub_noseq:
            rows.append(_published_only_row(scope, meta, clip.id, clip.order_index or 0, pub_clip, pa, pipeline,
                                            "FPC_ACTION_MISSING", playable=playable))
    # 저장본에만 있는 클립(표시용 골 클립은 점수 대상이 아니라 제외)
    for key, pub_clip in pub_clips.items():
        if key in seen_pub_clips or pub_clip.get("displayOnly"):
            continue
        for pa in pub_clip.get("actions") or []:
            rows.append(_published_only_row(scope, meta, key, 10 ** 6, pub_clip, pa, pipeline,
                                            "FPC_CLIP_MISSING", playable=False))
    return rows


def _published_only_row(scope: Scope, meta: dict, clip_id: str, order: int, pub_clip: dict | None, pa: dict,
                        pipeline: str | None, issue: str, *, playable: bool) -> dict:
    seq = pa.get("seq")
    seq_key = seq if isinstance(seq, int) else 10 ** 6
    return {
        "rowKey": f"{scope.job.id}|{scope.side_key}|{clip_id}|{seq if seq is not None else 'none'}",
        **meta,
        "clipId": clip_id if issue != "FPC_CLIP_MISSING" else None, "clipKey": clip_id, "clipOrder": None,
        "seq": seq, "fpcActionId": None, "sceneIndex": None, "sceneActionIndex": None,
        "action": None, "baseAction": None, "tags": None,
        "teamSide": pa.get("teamSide"), "jersey": _norm_jersey(pa.get("jersey")),
        "join": "publishedOnly", "issues": [issue],
        "published": _published_block(pa, pub_clip, pipeline),
        "fpcCurrent": None,
        "video": {
            "clipStartSec": (pub_clip or {}).get("startTimeSeconds"), "clipEndSec": (pub_clip or {}).get("endTimeSeconds"),
            "secondsBase": "clip=원본 영상 기준, action=클립 시작 0",
            "actionStartSec": pa.get("startOffset"), "actionEndSec": pa.get("endOffset"), "timeSource": "unknown",
            "playable": playable, "unplayableReason": None if playable else issue,
            "consoleUrl": console_url(scope.job.id, scope.side, clip_id if issue != "FPC_CLIP_MISSING" else None,
                                      pa.get("startOffset"), "unknown"),
        },
        "dual": {"source": "missing", "sceneIndex": None, "sceneRowIndex": None, "before": None, "after": None},
        "_sort": [meta["jobCreatedAt"], scope.job.id, scope.side_key, int(order), clip_id, int(seq_key), 1],
    }


# ── 수집 ─────────────────────────────────────────────────────────────────────

@dataclass
class Collected:
    scopes: list[Scope]
    rows: list[dict]
    clips_by_job: dict[str, list[HighlightClip]]
    actions_by_clip: dict[str, list[HighlightClipAction]]


def collect(db: Session, f: Filters, fetcher: PublishedFetcher, *, with_coords: bool = False) -> Collected:
    scopes = _load_scopes(db, f)
    targets = [s.target for s in scopes if s.target]
    published = _fetch_published(targets, fetcher) if targets else {}
    for s in scopes:
        s.published = published.get(s.target.upper()) if s.target else None
    job_ids = sorted({s.job.id for s in scopes})
    clips = db.query(HighlightClip).filter(HighlightClip.job_id.in_(job_ids)).all() if job_ids else []
    clips_by_job: dict[str, list[HighlightClip]] = {}
    for c in clips:
        clips_by_job.setdefault(c.job_id, []).append(c)
    clip_ids = [c.id for c in clips]
    actions_by_clip: dict[str, list[HighlightClipAction]] = {}
    for i in range(0, len(clip_ids), 500):
        for a in db.query(HighlightClipAction).filter(HighlightClipAction.clip_id.in_(clip_ids[i:i + 500])).all():
            actions_by_clip.setdefault(a.clip_id, []).append(a)
    rows: list[dict] = []
    for s in scopes:
        rows.extend(_build_rows(s, clips_by_job.get(s.job.id, []), actions_by_clip, with_coords=with_coords))
    return Collected(scopes, rows, clips_by_job, actions_by_clip)


def _value(row: dict, source: str, model: str) -> Any:
    block = row.get(source) or {}
    return block.get(model)


def _row_matches(row: dict, f: Filters) -> bool:
    if f.joins and row["join"] not in f.joins:
        return False
    if f.issues and not any(i in row["issues"] for i in f.issues):
        return False
    if f.action_codes:
        codes = {(row.get("published") or {}).get("actionCode"), (row.get("fpcCurrent") or {}).get("actionCode")}
        if not codes & set(f.action_codes):
            return False
    if f.actions and row.get("action") not in f.actions:
        return False
    if f.base_actions and row.get("baseAction") not in f.base_actions:
        return False
    for m in f.has_models:
        if _value(row, f.value_source, m) is None:
            return False
    for key, lo in f.min_value.items():
        v = _value(row, f.value_source, key)
        if v is None or v < lo:
            return False
    for key, hi in f.max_value.items():
        v = _value(row, f.value_source, key)
        if v is None or v > hi:
            return False
    return True


def _public(row: dict) -> dict:
    return {k: v for k, v in row.items() if not k.startswith("_")}


# ── 공개 함수(REST·MCP 공통) ──────────────────────────────────────────────────

def list_matches(db: Session, raw: dict | None, fetcher: PublishedFetcher, *, limit: Any = None,
                 cursor: str | None = None) -> dict:
    f = parse_filters(raw)
    n = parse_limit(limit)
    c = collect(db, f, fetcher)
    by_scope: dict[tuple, list[dict]] = {}
    for r in c.rows:
        by_scope.setdefault((r["jobId"], r["side"] or "-"), []).append(r)
    items = []
    for s in c.scopes:
        pub = s.published or {}
        rows = by_scope.get((s.job.id, s.side_key), [])
        in_scope = [cl for cl in c.clips_by_job.get(s.job.id, []) if s.clip_filter(cl)]
        meta = s.job.job_metadata or {}
        pub_clips = pub.get("clips") or []
        items.append({
            **_scope_meta(s),
            "archived": bool(meta.get("clip_archived")),
            "sourceDeleted": bool(meta.get("source_deleted")),
            "linkStatus": "NO_REQUEST_LINK" if s.request_id is None else (pub.get("status") or "BACKEND_UNAVAILABLE"),
            "requestStatus": pub.get("requestStatus"), "pipelineVersion": pub.get("pipelineVersion"),
            "fpcClipCount": len(in_scope),
            "fpcActionCount": sum(len(c.actions_by_clip.get(cl.id, [])) for cl in in_scope),
            "publishedClipCount": sum(1 for pc in pub_clips if not pc.get("displayOnly")),
            "publishedDisplayClipCount": sum(1 for pc in pub_clips if pc.get("displayOnly")),
            "publishedActionCount": sum(len(pc.get("actions") or []) for pc in pub_clips if not pc.get("displayOnly")),
            "rowCount": len(rows),
            "joinCounts": _counter(r["join"] for r in rows),
            "consoleUrl": console_url(s.job.id, s.side, None, None, "unknown"),
            "_sort": [_job_created(s.job), s.job.id, s.side_key],
        })
    page, next_cursor = _page(items, key=lambda r: r["_sort"], limit=n, cursor=cursor, fingerprint=f.fingerprint())
    return {"schemaVersion": SCHEMA_VERSION, "filters": f.echo(), "total": len(items),
            "matches": [_public(r) for r in page], "nextCursor": next_cursor}


def search_actions(db: Session, raw: dict | None, fetcher: PublishedFetcher, *, limit: Any = None,
                   cursor: str | None = None) -> dict:
    f = parse_filters(raw)
    n = parse_limit(limit)
    c = collect(db, f, fetcher)
    rows = [r for r in c.rows if _row_matches(r, f)]
    page, next_cursor = _page(rows, key=lambda r: r["_sort"], limit=n, cursor=cursor, fingerprint=f.fingerprint())
    return {"schemaVersion": SCHEMA_VERSION, "filters": f.echo(), "total": len(rows),
            "matchCount": len({(r["jobId"], r["side"]) for r in rows}),
            "actions": [_public(r) for r in page], "nextCursor": next_cursor}


def action_detail(db: Session, row_key: str, fetcher: PublishedFetcher) -> dict:
    parts = str(row_key or "").split("|")
    if len(parts) != 4 or not parts[0]:
        raise ValidationInputError("rowKey 는 search_xfp_actions 결과의 rowKey 를 그대로 넣습니다(jobId|side|clipKey|seq).")
    c = collect(db, Filters(job_ids=[parts[0]]), fetcher, with_coords=True)
    for r in c.rows:
        if r["rowKey"] == row_key:
            return {"schemaVersion": SCHEMA_VERSION, "action": _public(r)}
    raise LookupError("해당 rowKey 의 행이 없습니다(삭제됐거나 키가 틀렸습니다).")


def _counter(values: Iterable[Any]) -> dict[str, int]:
    out: dict[str, int] = {}
    for v in values:
        k = str(v) if v is not None else "null"
        out[k] = out.get(k, 0) + 1
    return dict(sorted(out.items(), key=lambda kv: (-kv[1], kv[0])))


def _quantiles(values: list[float]) -> dict[str, Any]:
    if not values:
        return {"count": 0, "min": None, "p25": None, "median": None, "p75": None, "max": None, "mean": None}
    v = sorted(values)

    def q(p: float) -> float:
        pos = (len(v) - 1) * p
        lo = int(pos)
        hi = min(lo + 1, len(v) - 1)
        return round(v[lo] + (v[hi] - v[lo]) * (pos - lo), 4)

    return {"count": len(v), "min": v[0], "p25": q(0.25), "median": q(0.5), "p75": q(0.75), "max": v[-1],
            "mean": round(sum(v) / len(v), 4)}


def summarize(db: Session, raw: dict | None, fetcher: PublishedFetcher) -> dict:
    f = parse_filters(raw)
    c = collect(db, f, fetcher)
    rows = [r for r in c.rows if _row_matches(r, f)]
    models = {}
    for m in MODELS:
        pub_vals = [r["published"][m] for r in rows if r.get("published") and r["published"].get(m) is not None]
        cur_vals = [r["fpcCurrent"][m] for r in rows if r.get("fpcCurrent") and r["fpcCurrent"].get(m) is not None]
        models[m] = {
            "publishedPresent": len(pub_vals), "fpcCurrentPresent": len(cur_vals),
            "publishedZero": sum(1 for x in pub_vals if x == 0),
            "published": _quantiles([float(x) for x in pub_vals]),
        }
    scores = [r["published"]["xfpScore"] for r in rows if r.get("published") and r["published"].get("xfpScore") is not None]
    buckets: dict[str, int] = {}
    for s in scores:
        lo = min(90, max(50, int(s) // 10 * 10))
        label = f"{lo}-{lo + 9 if lo < 90 else 100}"
        buckets[label] = buckets.get(label, 0) + 1
    all_present = sum(1 for r in rows if r.get("published") and all(r["published"].get(m) is not None
                                                                     for m in ("pc", "epv", "xrc")))
    return {
        "schemaVersion": SCHEMA_VERSION, "filters": f.echo(),
        "scope": {"matches": len({(r["jobId"], r["side"]) for r in rows}), "rows": len(rows),
                  "scopeStatuses": _counter(
                      ("NO_REQUEST_LINK" if s.request_id is None else (s.published or {}).get("status") or "BACKEND_UNAVAILABLE")
                      for s in c.scopes)},
        "join": _counter(r["join"] for r in rows),
        "issues": _counter(i for r in rows for i in r["issues"]),
        "actionCodes": {"published": _counter((r.get("published") or {}).get("actionCode") for r in rows if r.get("published")),
                        "fpcCurrent": _counter((r.get("fpcCurrent") or {}).get("actionCode") for r in rows if r.get("fpcCurrent"))},
        "models": models,
        "pcEpvXrcAllPresent": all_present,
        "xfpScore": {**_quantiles([float(s) for s in scores]), "buckets": dict(sorted(buckets.items()))},
        "pipelineVersions": _counter((r.get("published") or {}).get("pipelineVersion") for r in rows if r.get("published")),
        "timeSource": _counter(r["video"]["timeSource"] for r in rows),
        "dualSource": _counter(r["dual"]["source"] for r in rows),
    }


# ── 감사 ─────────────────────────────────────────────────────────────────────

def audit_read(db: Session, *, principal: str, principal_name: str | None, tool: str, scope: dict,
               result: dict) -> None:
    """조회 감사 — 주체·대상 범위·시각·결과만. 경기 데이터는 건드리지 않는다(감사 행만 추가)."""
    log.info("[xfp-validation][audit] principal=%s tool=%s scope=%s result=%s",
             principal, tool, json.dumps(scope, ensure_ascii=False, default=str),
             json.dumps(result, ensure_ascii=False, default=str))
    try:
        db.add(AuditLog(actor_id=principal, actor_name=principal_name, actor_role="xfp.validation.read",
                        action=f"xfp_validation.{tool}", target_type="xfp_validation", target_id=None,
                        severity="INFO", details={"scope": scope, "result": result}))
        db.commit()
    except Exception:  # 감사 적재 실패가 조회를 막지는 않는다 — 위 로그 한 줄은 남았다
        db.rollback()
        log.exception("[xfp-validation] 감사 적재 실패")


# ── 내려받기(보관함 버튼) — 같은 행·같은 집계를 파일로 ─────────────────────────────

CSV_COLUMNS = [
    "rowKey", "jobId", "matchId", "matchName", "side", "requestId", "resolvedRequestId", "clipKey", "seq",
    "action", "baseAction", "tags", "teamSide", "jersey", "join", "issues",
    "published.actionCode", "published.xfpScore", "published.xfpPercentile", "published.pc", "published.epv",
    "published.xg", "published.xgot", "published.xrc", "published.clipPrimary", "published.pipelineVersion",
    "fpcCurrent.actionCode", "fpcCurrent.xfpScore", "fpcCurrent.pc", "fpcCurrent.epv", "fpcCurrent.xg",
    "fpcCurrent.xgot", "fpcCurrent.xrc",
    "video.clipStartSec", "video.clipEndSec", "video.actionStartSec", "video.actionEndSec", "video.timeSource",
    "video.playable", "video.unplayableReason", "video.consoleUrl",
    "dual.source", "dual.sceneIndex", "dual.before.home", "dual.before.away", "dual.before.unknownSide",
    "dual.after.home", "dual.after.away", "dual.after.unknownSide",
]


def _cell(row: dict, column: str) -> Any:
    value: Any = row
    for part in column.split("."):
        value = value.get(part) if isinstance(value, dict) else None
    if isinstance(value, list):
        return ";".join(str(v) for v in value)
    if value is None:
        return ""  # CSV 빈 칸 = null. 관측된 0 은 "0" 으로 남는다(dual.json·summary.json 은 null 그대로)
    return value


def export_zip(db: Session, raw: dict | None, fetcher: PublishedFetcher) -> tuple[bytes, dict]:
    """actions.csv(행) + dual.json(같은 rowKey 의 듀얼, 좌표 포함) + summary.json(같은 필터 집계). 0건이어도 구조는 같다."""
    f = parse_filters(raw)
    c = collect(db, f, fetcher, with_coords=True)
    rows = sorted((r for r in c.rows if _row_matches(r, f)), key=lambda r: r["_sort"])
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(CSV_COLUMNS)
    for r in rows:
        w.writerow([_cell(r, col) for col in CSV_COLUMNS])
    dual = [{"rowKey": r["rowKey"], **r["dual"]} for r in rows]
    summary = summarize(db, raw, fetcher)
    meta = {"schemaVersion": SCHEMA_VERSION, "filters": f.echo(), "rows": len(rows),
            "note": "CSV 빈 칸 = null(미계산), 0 = 관측된 0. xrc = 패스 receptionXg. published = FinePlay 운영 저장본, "
                    "fpcCurrent = 내려받은 시점 FPC 값."}
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("actions.csv", "\ufeff" + buf.getvalue())  # 엑셀 한글 깨짐 방지 BOM
        z.writestr("dual.json", json.dumps({**meta, "actions": dual}, ensure_ascii=False, indent=1, default=str))
        z.writestr("summary.json", json.dumps(summary, ensure_ascii=False, indent=1, default=str))
    return out.getvalue(), {"rows": len(rows)}
