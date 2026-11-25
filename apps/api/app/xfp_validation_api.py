"""xFP 검증 조회 — 콘솔 REST(관리자 세션) + MCP(Streamable HTTP, 읽기 전용 토큰) (T6, 2026-11-25).

둘 다 `xfp_validation` 서비스 하나를 쓴다 — 같은 필터면 같은 행 수·같은 집계.

인증 경계
- REST `/api/highlight/xfp-validation/*`: 콘솔 관리자 세션(require_admin = 보관함과 같은 권한). Authorization 헤더는 읽지 않는다.
- MCP `/api/mcp/xfp-validation`: `Authorization: Bearer <FPC_XFP_MCP_TOKEN>`(회전용 `FPC_XFP_MCP_TOKEN_NEXT`) 하나뿐.
  범위는 `xfp.validation.read` 고정 — 이 토큰으로 할 수 있는 일은 아래 도구 4개(조회)뿐이다. 세션 쿠키는 읽지 않는다.
  토큰 미설정이면 전부 401(fail-closed). 비교는 상수시간(hmac.compare_digest).
- 브라우저 출처(Origin)가 붙은 MCP 요청은 `FPC_XFP_MCP_ALLOWED_ORIGINS` 에 있을 때만 받는다(DNS rebinding 방지, MCP 규격 권고).

MCP 구현 범위: JSON-RPC 2.0 over POST, 응답은 application/json 한 번(서버→클라이언트 스트림 없음, 세션 없음).
GET/DELETE 는 405 — 규격상 서버가 SSE 스트림을 제공하지 않을 때의 응답이다.
"""
from __future__ import annotations

import hmac
import json
import os
from typing import Any, Callable

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import JSONResponse, Response
from starlette.concurrency import run_in_threadpool
from sqlalchemy.orm import Session

from . import xfp_validation as svc
from .auth import require_admin
from .db import get_db
from .fineplay_client import FinePlayClient
from .models import User

router = APIRouter()

SCOPE = "xfp.validation.read"
MCP_PATH = "/api/mcp/xfp-validation"
SUPPORTED_PROTOCOLS = ("2025-06-18", "2025-03-26", "2024-11-05")
SERVER_INFO = {"name": "fpc-xfp-validation", "title": "FPC xFP 검증 조회(읽기 전용)", "version": "1.0.0"}


def get_fetcher() -> svc.PublishedFetcher:
    """운영 저장본 읽기 — 테스트는 app.dependency_overrides 로 바꾼다."""
    return svc.backend_fetcher(FinePlayClient())


# ── 콘솔 REST ────────────────────────────────────────────────────────────────

_FILTER_PARAMS = ("jobIds", "requestIds", "side", "actionCodes", "actions", "baseActions", "hasModels", "valueSource",
                  "minValue", "maxValue", "join", "issues", "dateFrom", "dateTo", "archivedOnly")


def _query_filters(request: Request) -> dict[str, Any]:
    q = request.query_params
    raw: dict[str, Any] = {k: q.get(k) for k in _FILTER_PARAMS if q.get(k) not in (None, "")}
    for key in svc.RANGE_KEYS:
        for prefix in ("min_", "max_"):
            if q.get(prefix + key) not in (None, ""):
                raw[prefix + key] = q.get(prefix + key)
    return raw


def _rest(db: Session, user: User, tool: str, run: Callable[[], dict], scope: dict) -> dict:
    try:
        out = run()
    except svc.ValidationInputError as exc:
        svc.audit_read(db, principal=f"admin:{user.id}", principal_name=user.name, tool=tool, scope=scope,
                       result={"status": "rejected", "reason": str(exc)})
        raise HTTPException(status_code=400, detail=str(exc)) from None
    except LookupError as exc:
        svc.audit_read(db, principal=f"admin:{user.id}", principal_name=user.name, tool=tool, scope=scope,
                       result={"status": "not_found"})
        raise HTTPException(status_code=404, detail=str(exc)) from None
    svc.audit_read(db, principal=f"admin:{user.id}", principal_name=user.name, tool=tool, scope=scope,
                   result=_result_brief(out))
    return out


@router.get("/api/highlight/xfp-validation/matches")
def rest_matches(request: Request, limit: int | None = None, cursor: str | None = None,
                 db: Session = Depends(get_db), user: User = Depends(require_admin),
                 fetcher: svc.PublishedFetcher = Depends(get_fetcher)):
    raw = _query_filters(request)
    return _rest(db, user, "list_xfp_matches",
                 lambda: svc.list_matches(db, raw, fetcher, limit=limit, cursor=cursor), raw)


@router.get("/api/highlight/xfp-validation/actions")
def rest_actions(request: Request, limit: int | None = None, cursor: str | None = None,
                 db: Session = Depends(get_db), user: User = Depends(require_admin),
                 fetcher: svc.PublishedFetcher = Depends(get_fetcher)):
    raw = _query_filters(request)
    return _rest(db, user, "search_xfp_actions",
                 lambda: svc.search_actions(db, raw, fetcher, limit=limit, cursor=cursor), raw)


@router.get("/api/highlight/xfp-validation/actions/detail")
def rest_action_detail(rowKey: str = Query(...), db: Session = Depends(get_db),
                       user: User = Depends(require_admin), fetcher: svc.PublishedFetcher = Depends(get_fetcher)):
    return _rest(db, user, "get_xfp_action_detail", lambda: svc.action_detail(db, rowKey, fetcher),
                 {"rowKey": rowKey})


@router.get("/api/highlight/xfp-validation/summary")
def rest_summary(request: Request, db: Session = Depends(get_db), user: User = Depends(require_admin),
                 fetcher: svc.PublishedFetcher = Depends(get_fetcher)):
    raw = _query_filters(request)
    return _rest(db, user, "summarize_xfp", lambda: svc.summarize(db, raw, fetcher), raw)


@router.get("/api/highlight/xfp-validation/export")
def rest_export(request: Request, db: Session = Depends(get_db), user: User = Depends(require_admin),
                fetcher: svc.PublishedFetcher = Depends(get_fetcher)):
    """보관함 '검증 자료' 버튼 — 같은 필터의 actions.csv + dual.json + summary.json ZIP."""
    raw = _query_filters(request)
    principal = f"admin:{user.id}"
    try:
        data, brief = svc.export_zip(db, raw, fetcher)
    except svc.ValidationInputError as exc:
        svc.audit_read(db, principal=principal, principal_name=user.name, tool="export_zip", scope=raw,
                       result={"status": "rejected", "reason": str(exc)})
        raise HTTPException(status_code=400, detail=str(exc)) from None
    svc.audit_read(db, principal=principal, principal_name=user.name, tool="export_zip", scope=raw,
                   result={"status": "ok", **brief})
    name = "xfp-validation-" + ("-".join(svc._as_list(raw.get("jobIds")))[:60] or "all") + ".zip"
    return Response(content=data, media_type="application/zip",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


def _result_brief(out: dict) -> dict:
    """감사 로그용 결과 요약 — 숫자만(행 내용은 남기지 않는다)."""
    brief: dict[str, Any] = {"status": "ok"}
    for key in ("total", "matchCount"):
        if key in out:
            brief[key] = out[key]
    for key in ("matches", "actions"):
        if isinstance(out.get(key), list):
            brief["returned"] = len(out[key])
    if "scope" in out:
        brief["rows"] = (out.get("scope") or {}).get("rows")
    if "action" in out:
        brief["returned"] = 1
    return brief


# ── MCP ──────────────────────────────────────────────────────────────────────

_FILTER_SCHEMA: dict[str, Any] = {
    "jobIds": {"type": "array", "items": {"type": "string"}, "description": "FPC 작업 id(예: fpc-470). 비우면 전체"},
    "requestIds": {"type": "array", "items": {"type": "integer"}, "description": "FinePlay 분석 신청 id(자체전은 원 신청 id)"},
    "side": {"type": "array", "items": {"type": "string", "enum": ["A", "B", "home", "away", "-"]},
             "description": "A·B=자체전 묶음, home·away=사전 작업 링크, -=일반 경기"},
    "actionCodes": {"type": "array", "items": {"type": "string"}, "description": "24코드(G1~S14 등). 저장본 또는 FPC 현재 코드 중 하나라도 맞으면 포함"},
    "actions": {"type": "array", "items": {"type": "string"}, "description": "FPC 액션 이름(예: Key Pass, Assist, Pass, Shot, Goal, Tackle, Interception)"},
    "baseActions": {"type": "array", "items": {"type": "string"}, "description": "상위 액션(예: Pass — 키패스·어시스트 포함)"},
    "hasModels": {"type": "array", "items": {"type": "string", "enum": list(svc.MODELS)},
                  "description": "이 원시값이 모두 있는(null 아님, 0 포함) 행만"},
    "valueSource": {"type": "string", "enum": ["published", "fpcCurrent"],
                    "description": "hasModels·값 범위를 볼 칸. published=FinePlay 운영 저장본(기본), fpcCurrent=FPC 현재값"},
    "minValue": {"type": "object", "description": "모델별 최솟값(예: {\"pc\":0.1,\"xfpScore\":80})",
                 "properties": {k: {"type": "number"} for k in svc.RANGE_KEYS}, "additionalProperties": False},
    "maxValue": {"type": "object", "description": "모델별 최댓값",
                 "properties": {k: {"type": "number"} for k in svc.RANGE_KEYS}, "additionalProperties": False},
    "join": {"type": "array", "items": {"type": "string", "enum": list(svc.JOIN_STATES)},
             "description": "조인 상태 matched·mismatch·fpcOnly·publishedOnly"},
    "issues": {"type": "array", "items": {"type": "string", "enum": list(svc.ISSUE_CODES)},
               "description": "이 사유 코드 중 하나라도 있는 행"},
    "dateFrom": {"type": "string", "description": "작업 생성일(UTC) 시작 YYYY-MM-DD"},
    "dateTo": {"type": "string", "description": "작업 생성일(UTC) 끝 YYYY-MM-DD(포함)"},
    "archivedOnly": {"type": "boolean", "description": "보관(아카이브)된 경기만"},
}
_PAGE_SCHEMA = {
    "limit": {"type": "integer", "minimum": 1, "maximum": svc.PAGE_MAX, "description": f"쪽 크기(기본 {svc.PAGE_DEFAULT})"},
    "cursor": {"type": "string", "description": "앞 응답의 nextCursor. 필터를 바꾸면 쓰지 말 것"},
}
_READ_ONLY = {"readOnlyHint": True, "destructiveHint": False, "idempotentHint": True, "openWorldHint": False}

TOOLS: list[dict[str, Any]] = [
    {
        "name": "list_xfp_matches",
        "title": "xFP 경기 목록",
        "description": "FPC 경기(작업×side) 목록 — 신청 연결, 운영 저장본 상태, FPC·저장본 클립/액션 수, 조인 상태 수. "
                       "자체전은 A·B 두 줄, 사전 작업은 home·away 링크별 줄이다.",
        "inputSchema": {"type": "object", "properties": {
            k: _FILTER_SCHEMA[k] for k in ("jobIds", "requestIds", "side", "dateFrom", "dateTo", "archivedOnly")
        } | _PAGE_SCHEMA, "additionalProperties": False},
        "annotations": _READ_ONLY,
    },
    {
        "name": "search_xfp_actions",
        "title": "xFP 액션 검색(경기 가로지르기)",
        "description": "전체 운영 경기에서 액션 행을 찾는다. 행 = 식별자 + published(FinePlay 운영 저장 점수·원시값·pipelineVersion) + "
                       "fpcCurrent(FPC 현재 원시값, 조회 시점 규칙) + video(원본 기준 클립 초, 클립 내 액션 초, timeSource, consoleUrl) + "
                       "dual(태깅 출처·팀별 Before/After 유효 태깅 수) + join/issues(붙지 않거나 어긋난 사유). "
                       "미계산은 null, 0 은 0. xrc = 패스 xRC(receptionXg). 페이지는 nextCursor 로 넘긴다. "
                       "예: PC·EPV·xRC 가 모두 있는 키패스 → actions=[\"Key Pass\"], hasModels=[\"pc\",\"epv\",\"xrc\"].",
        "inputSchema": {"type": "object", "properties": dict(_FILTER_SCHEMA) | _PAGE_SCHEMA, "additionalProperties": False},
        "annotations": _READ_ONLY,
    },
    {
        "name": "get_xfp_action_detail",
        "title": "xFP 액션 상세(듀얼 좌표)",
        "description": "search_xfp_actions 의 rowKey 하나의 전체 행 + 듀얼 태깅 좌표(before/after 점·화살표, 미터 좌표). "
                       "원본 장면을 이 액션에 확실히 연결할 수 없으면 좌표 없이 dual.source=metricsOnly|missing 이다(추정 매칭 없음).",
        "inputSchema": {"type": "object", "properties": {"rowKey": {"type": "string", "description": "jobId|side|clipKey|seq"}},
                        "required": ["rowKey"], "additionalProperties": False},
        "annotations": _READ_ONLY,
    },
    {
        "name": "summarize_xfp",
        "title": "xFP 집계",
        "description": "search_xfp_actions 와 같은 필터의 **전체 범위**(페이지 아님) 집계 — 모델별 원시값 보유 수(저장본·FPC 현재), "
                       "0 개수, 분포, xfpScore 분포·구간, 액션 코드별 수, 조인 상태·누락 사유, pipelineVersion, 영상 시점 출처, 듀얼 출처.",
        "inputSchema": {"type": "object", "properties": dict(_FILTER_SCHEMA), "additionalProperties": False},
        "annotations": _READ_ONLY,
    },
]
_TOOL_NAMES = {t["name"] for t in TOOLS}

INSTRUCTIONS = (
    "FPC xFP 검증 조회(읽기 전용). 기준 데이터는 FinePlay 에 저장된 운영 결과(published)다. fpcCurrent 는 조회 시점 FPC 값이라 "
    "published 와 다를 수 있다. 대표 모델 판정·후보/탈락 근거·리플레이 재채점은 이 서버 범위 밖이다. "
    "summarize_xfp 로 범위를 먼저 보고 search_xfp_actions 로 행을 받고, 좌표가 필요할 때만 get_xfp_action_detail 을 부른다."
)


def _mcp_tokens() -> list[bytes]:
    return [t.strip().encode("utf-8") for t in (os.getenv("FPC_XFP_MCP_TOKEN"), os.getenv("FPC_XFP_MCP_TOKEN_NEXT"))
            if t and t.strip()]


def _mcp_principal(request: Request) -> str | None:
    tokens = _mcp_tokens()
    header = request.headers.get("authorization") or ""
    if not tokens or not header.startswith("Bearer "):
        return None
    presented = header[len("Bearer "):].strip().encode("utf-8")
    matched = None
    for i, token in enumerate(tokens):
        if hmac.compare_digest(token, presented):
            matched = "current" if i == 0 else "next"
    return f"mcp-token:{matched}" if matched else None


def _unauthorized() -> JSONResponse:
    return JSONResponse(status_code=401, content={"error": "invalid_token", "message": "유효한 MCP 읽기 토큰이 필요합니다."},
                        headers={"WWW-Authenticate": f'Bearer realm="fpc-xfp-validation", scope="{SCOPE}"'})


def _origin_allowed(request: Request) -> bool:
    origin = request.headers.get("origin")
    if not origin:
        return True
    allowed = {o.strip().rstrip("/") for o in (os.getenv("FPC_XFP_MCP_ALLOWED_ORIGINS") or "").split(",") if o.strip()}
    return origin.rstrip("/") in allowed


def _rpc_error(rid: Any, code: int, message: str) -> dict:
    return {"jsonrpc": "2.0", "id": rid, "error": {"code": code, "message": message}}


def _tool_result(payload: dict, *, is_error: bool = False) -> dict:
    text = json.dumps(payload, ensure_ascii=False, default=str, separators=(",", ":"))
    return {"content": [{"type": "text", "text": text}], "structuredContent": payload, "isError": is_error}


def _call_tool(db: Session, principal: str, name: str, args: dict, fetcher: svc.PublishedFetcher) -> dict:
    args = dict(args or {})
    scope = {k: v for k, v in args.items() if k != "cursor"}
    allowed = set(next(t for t in TOOLS if t["name"] == name)["inputSchema"]["properties"])
    unknown = sorted(set(args) - allowed)
    if unknown:
        # 오타 난 필터가 조용히 무시되면 '전체'가 돌아간다 — 거절해서 다시 부르게 한다.
        return _tool_result({"error": "invalid_arguments",
                             "message": f"모르는 인자: {', '.join(unknown)} (가능: {', '.join(sorted(allowed))})"},
                            is_error=True)
    try:
        if name == "list_xfp_matches":
            out = svc.list_matches(db, args, fetcher, limit=args.pop("limit", None), cursor=args.pop("cursor", None))
        elif name == "search_xfp_actions":
            out = svc.search_actions(db, args, fetcher, limit=args.pop("limit", None), cursor=args.pop("cursor", None))
        elif name == "get_xfp_action_detail":
            out = svc.action_detail(db, str(args.get("rowKey") or ""), fetcher)
        else:  # summarize_xfp
            out = svc.summarize(db, args, fetcher)
    except svc.ValidationInputError as exc:
        svc.audit_read(db, principal=principal, principal_name=None, tool=name, scope=scope,
                       result={"status": "rejected", "reason": str(exc)})
        return _tool_result({"error": "invalid_arguments", "message": str(exc)}, is_error=True)
    except LookupError as exc:
        svc.audit_read(db, principal=principal, principal_name=None, tool=name, scope=scope, result={"status": "not_found"})
        return _tool_result({"error": "not_found", "message": str(exc)}, is_error=True)
    svc.audit_read(db, principal=principal, principal_name=None, tool=name, scope=scope, result=_result_brief(out))
    return _tool_result(out)


def _handle(db: Session, principal: str, msg: Any, fetcher: svc.PublishedFetcher) -> dict | None:
    if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0" or not isinstance(msg.get("method"), str):
        if isinstance(msg, dict) and "method" not in msg and ("result" in msg or "error" in msg):
            return None  # 클라이언트가 보낸 응답 — 서버는 요청을 보내지 않으므로 무시
        return _rpc_error(msg.get("id") if isinstance(msg, dict) else None, -32600, "Invalid Request")
    method = msg["method"]
    rid = msg.get("id")
    is_notification = "id" not in msg
    params = msg.get("params") or {}
    if is_notification:
        return None  # notifications/initialized·cancelled 등 — 202
    if method == "initialize":
        requested = str((params or {}).get("protocolVersion") or "")
        version = requested if requested in SUPPORTED_PROTOCOLS else SUPPORTED_PROTOCOLS[0]
        return {"jsonrpc": "2.0", "id": rid, "result": {
            "protocolVersion": version,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": SERVER_INFO,
            "instructions": INSTRUCTIONS,
        }}
    if method == "ping":
        return {"jsonrpc": "2.0", "id": rid, "result": {}}
    if method == "tools/list":
        return {"jsonrpc": "2.0", "id": rid, "result": {"tools": TOOLS}}
    if method == "tools/call":
        name = (params or {}).get("name")
        if name not in _TOOL_NAMES:
            return _rpc_error(rid, -32602, f"Unknown tool: {name}")
        args = (params or {}).get("arguments") or {}
        if not isinstance(args, dict):
            return _rpc_error(rid, -32602, "arguments 는 객체입니다.")
        return {"jsonrpc": "2.0", "id": rid, "result": _call_tool(db, principal, name, args, fetcher)}
    if method in ("resources/list", "prompts/list"):
        key = "resources" if method == "resources/list" else "prompts"
        return {"jsonrpc": "2.0", "id": rid, "result": {key: []}}
    return _rpc_error(rid, -32601, f"Method not found: {method}")


@router.post(MCP_PATH)
async def mcp_post(request: Request, db: Session = Depends(get_db),
                   fetcher: svc.PublishedFetcher = Depends(get_fetcher)):
    if not _origin_allowed(request):
        return JSONResponse(status_code=403, content={"error": "origin_not_allowed"})
    principal = _mcp_principal(request)
    if principal is None:
        return _unauthorized()
    version = request.headers.get("mcp-protocol-version")
    if version and version not in SUPPORTED_PROTOCOLS:
        return JSONResponse(status_code=400, content=_rpc_error(None, -32600, f"Unsupported MCP-Protocol-Version: {version}"))
    try:
        body = json.loads(await request.body() or b"null")
    except ValueError:
        return JSONResponse(status_code=400, content=_rpc_error(None, -32700, "Parse error"))
    if isinstance(body, list):
        if not body:
            return JSONResponse(status_code=400, content=_rpc_error(None, -32600, "Invalid Request"))
        # DB 조회·FinePlay 호출은 동기라 스레드풀에서 돌린다(이벤트 루프를 막지 않게).
        replies = [r for r in [await run_in_threadpool(_handle, db, principal, m, fetcher) for m in body] if r is not None]
        return JSONResponse(content=replies) if replies else Response(status_code=202)
    reply = await run_in_threadpool(_handle, db, principal, body, fetcher)
    return JSONResponse(content=reply) if reply is not None else Response(status_code=202)


@router.get(MCP_PATH)
@router.delete(MCP_PATH)
def mcp_no_stream(request: Request):
    # 인증 전에 405 를 주면 경로 존재가 드러나지만, 경로 자체는 공개 문서(설계 메모)에 있다. 쓰기 동작은 없다.
    return Response(status_code=405, headers={"Allow": "POST"})
