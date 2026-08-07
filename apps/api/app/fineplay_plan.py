"""신청 옵션 → xFP 산출 지시 판정 (노션 "FPC 매니페스트 options 판정 규칙", 2026-08-06).

한 줄 규칙: claim 매니페스트의 `options` 중 selected 된 optionType 에
`FREE_XFP_TOKEN`/`XFP_SINGLE`/`FULL_REPORT` 가 하나라도 있으면 xFP 산출,
하나도 없으면(= `BASIC_HIGHLIGHT` 뿐이면) 클립 영상만 전송한다.

경계 두 가지가 중요하다:
- **판정 근거는 옵션뿐이다.** 멤버십 팀은 백엔드가 제출 시점에 XFP_SINGLE 을
  0원으로 실어 보내므로(ADR-0001 #20) 콘솔이 멤버십을 알 필요가 없다.
- **판정 시점은 claim 스냅샷이다.** claim 때 굳혀 job_metadata["plan"] 에 넣고
  produce·재전송·UI 가 전부 그 스냅샷만 본다. 신청 옵션이 나중에 바뀌어도
  이미 받은 작업의 산출 범위는 흔들리지 않는다.

basic 건에서 빠지는 것(2026-08-06 확정 — 노션 §2 개정): 채점 필드뿐 아니라
teamView·involvedPlayers·sceneData·sceneMotionKey·clipScore 전부. 무료 건은
FPA dual 태깅 자체를 하지 않기 때문이고, clipScore 자리값 50 을 실으면
백엔드가 경기 평점(matchPlayerScores)으로 파생해 무료 유저 앱에 "평점 50" 이
뜨기 때문이다. 남는 것은 clipKey·구간·mainAction·highlightVideo.
"""

from __future__ import annotations

from typing import Any

# xFP 산출을 지시하는 옵션. FREE_XFP_TOKEN 은 이름만 무료(월 지급 토큰 소모)고
# 산출 대상이다 — BASIC_HIGHLIGHT 단독만 미산출이다.
XFP_OPTION_TYPES = frozenset({"FREE_XFP_TOKEN", "XFP_SINGLE", "FULL_REPORT"})

TIER_XFP = "xfp"
TIER_BASIC = "basic"

# basic 전송에서 제거하는 클립 레벨 키.
_CLIP_ANALYSIS_KEYS = ("teamView", "involvedPlayers")
# 혹시 액션 레벨에 남아도 새지 않게 — strip 은 마지막 안전망이라 중복해서 훑는다.
_ACTION_ANALYSIS_KEYS = ("xfpScore", "xfpPercentile", "sceneData", "sceneMotionKey")


def selected_option_types(options: Any) -> list[str]:
    """매니페스트 options[] → selected 된 optionType 목록.

    백엔드는 selected 된 것만 실어 보내지만(FpcJobService), 계약상 selected:false
    가 섞여 올 수 있어 명시적으로 걸러낸다. 문자열 리스트로 오는 형태도 받는다.
    """
    out: list[str] = []
    if not isinstance(options, (list, tuple)):
        return out
    for item in options:
        if isinstance(item, str):
            code = item.strip()
            selected = True
        elif isinstance(item, dict):
            code = str(item.get("optionType") or item.get("type") or "").strip()
            # 키가 없으면 "실려 왔다 = 선택됐다" 로 본다(백엔드가 selected 만 보냄).
            selected = bool(item.get("selected", True))
        else:
            continue
        if code and selected:
            out.append(code.upper())
    return out


def tier_from_options(options: Any) -> str:
    """옵션 목록 → 'xfp' | 'basic'. 누락·빈 배열은 basic(안전 폴백, 노션 §5)."""
    codes = set(selected_option_types(options))
    return TIER_XFP if codes & XFP_OPTION_TYPES else TIER_BASIC


def plan_from_manifest(manifest: Any, *, source: str = "manifest") -> dict[str, Any]:
    """claim 매니페스트 → 저장용 plan 스냅샷."""
    options = (manifest or {}).get("options") if isinstance(manifest, dict) else None
    codes = selected_option_types(options)
    return {
        "tier": tier_from_options(options),
        "options": codes,
        # options 키 자체가 없었는지 구분한다 — UI 가 "옵션 미상" 을 표시해
        # 운영자가 무료 확정인지 정보 누락인지 알 수 있게.
        "source": source if isinstance(options, (list, tuple)) else "none",
    }


def resolve_plan(metadata: Any, *, side: str | None = None) -> dict[str, Any]:
    """잡 메타데이터 → plan. claim 때 굳힌 스냅샷이 1순위.

    우선순위:
      1. 사전 작업(standalone)에서 side 를 지정하면 links[side].plan/options —
         한 태깅본이 홈/어웨이 두 신청으로 나가고 각 신청의 옵션이 다를 수 있다.
      2. job_metadata["plan"] (claim 스냅샷).
      3. 매니페스트 재판정 (스냅샷 이전에 claim 된 잡).

    사전 작업 잡 자체는 xFP 태깅을 하려고 만드는 것이라 **작업 지시**는 xfp 지만,
    **전송 판정**은 연결된 신청의 옵션을 따른다. 연결에 옵션 정보가 없으면
    잡 기본값으로 흘리지 않고 basic 으로 떨군다(안전 폴백, 노션 §5).
    """
    metadata = metadata if isinstance(metadata, dict) else {}

    if side and metadata.get("standalone"):
        link = (metadata.get("links") or {}).get(side)
        if isinstance(link, dict):
            plan = link.get("plan")
            if isinstance(plan, dict) and plan.get("tier"):
                return plan
            if "options" in link:
                return plan_from_manifest({"options": link.get("options")}, source="link")
        return {"tier": TIER_BASIC, "options": [], "source": "link-none"}

    plan = metadata.get("plan")
    if isinstance(plan, dict) and plan.get("tier") in (TIER_XFP, TIER_BASIC):
        return plan

    return plan_from_manifest(metadata.get("manifest") or {}, source="manifest")


def xfp_enabled(metadata: Any, *, side: str | None = None) -> bool:
    return resolve_plan(metadata, side=side).get("tier") != TIER_BASIC


def strip_analysis(payload: dict[str, Any]) -> dict[str, Any]:
    """basic 건 페이로드에서 분석 산출물을 제거한다 (제자리 수정 후 반환).

    조립 단계에서 이미 안 담는 게 정석이고 이건 마지막 안전망이다 — 전송 경로가
    produce·클레임 재전송·사전작업 사이드별로 셋이라, 새 경로가 생겨도 여기만
    통과하면 무료 건에 채점이 새지 않는다.
    """
    for clip in (payload or {}).get("clips") or []:
        if not isinstance(clip, dict):
            continue
        for key in _CLIP_ANALYSIS_KEYS:
            clip.pop(key, None)
        for key in _ACTION_ANALYSIS_KEYS:
            clip.pop(key, None)
    return payload


def prepare_payload(payload: dict[str, Any], metadata: Any, *, side: str | None = None) -> dict[str, Any]:
    """전송 직전 관문 — basic 이면 분석 산출물을 떼고 넘긴다."""
    if not xfp_enabled(metadata, side=side):
        return strip_analysis(payload)
    return payload
