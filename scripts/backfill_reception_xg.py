#!/usr/bin/env python3
"""저장된 패스 액션의 '받은 지점 기대득점(reception_xg)' 을 소급 계산한다.

배경
----
어시스트·키패스 채점이 연결 슛 xG 계승에서 **받은 지점의 기대득점**으로 바뀌었다
(fpa._reception_chance_xg). 이 값은 태깅 시점에 계산돼 DB 에 저장되므로, 그 전에
찍은 행은 `reception_xg` 가 NULL 이다. NULL 이면 채점이 기존 방식(연결 슛 xG)으로
폴백하므로 점수가 나오긴 하지만, 새 산식이 적용되지 않는다.

xFP 점수 자체는 DB 에 저장되지 않고 전송할 때마다 다시 계산되므로, 이 스크립트로
원시값만 채워 두면 **재전송하는 순간 새 산식으로 채점된다**.

무엇을 채우나
------------
`highlight_clip_actions.reception_xg` — 패스류(Pass·Cross·Assist·Key Pass) 행만.

재계산에 필요한 것
----------------
1. **받은 지점 좌표** — `extra.receiver`(리시버 등번호)로 `extra.sceneState.beforeDots`
   에서 아군 점을 찾는다.
2. **프레임의 상대 점** — 같은 sceneState 에서 team=opponent 인 점들. 수비콘 계산용.
   상대 점이 없으면 콘이 0 이 되어 위치만으로 계산된다(= estimate_xg 와 같은 값).
3. **공격방향** — 액션에는 없다. 같은 **클립**의 다른 행에 있는 `extra.goalMouth`
   ("gx,gy,방향") 에서 빌린다. 한 클립은 한 흐름이라 공격방향이 바뀌지 않는다
   (실측 확인: 클립 10개 전부 방향이 하나였다). 클립에 goalMouth 가 하나도 없으면
   **고치지 않고 보류로 보고**한다 — 임의로 가정하면 좌우가 반전돼 엉뚱한 값이
   조용히 저장된다. 못 고치는 것보다 나쁘다.

멱등성
------
저장값을 참조하지 않고 좌표에서 새로 계산해 덮어쓰므로 몇 번을 돌려도 결과가 같다.
이미 값이 있는 행은 기본적으로 건너뛴다(--force 로 재계산 가능).

사용법
------
    DATABASE_URL=... python3 scripts/backfill_reception_xg.py            # 미리보기
    DATABASE_URL=... python3 scripts/backfill_reception_xg.py --apply
    DATABASE_URL=... python3 scripts/backfill_reception_xg.py --clip-id fpc-1-004
    DATABASE_URL=... python3 scripts/backfill_reception_xg.py --apply --force
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "apps" / "api"))

from app.fpa import _reception_chance_xg  # noqa: E402
from app.fineplay_fpa import canonical_action_name  # noqa: E402

# 받는 사람이 있는 패스류만 대상. 승격된 이름(Assist/Key Pass)도 포함한다.
PASS_ACTIONS = {"Pass", "Cross", "Assist", "Key Pass"}
_DECIMALS = 4


def _direction_of(goal_mouth: Any) -> str | None:
    """extra.goalMouth = 'gx,gy,방향' 의 세 번째 필드."""
    parts = str(goal_mouth or "").split(",")
    if len(parts) < 3:
        return None
    d = parts[2].strip().lower()
    return d if d in ("left", "right") else None


def _clip_directions(rows: list[Any]) -> dict[str, str]:
    """클립 id → 공격방향. 한 클립에 방향이 둘 이상이면 그 클립은 제외한다."""
    seen: dict[str, set[str]] = {}
    for row in rows:
        d = _direction_of((row.extra or {}).get("goalMouth"))
        if d:
            seen.setdefault(row.clip_id, set()).add(d)
    return {clip: next(iter(ds)) for clip, ds in seen.items() if len(ds) == 1}


def _reception_point(extra: dict[str, Any]) -> tuple[float, float] | None:
    """받은 지점 = 리시버 등번호에 해당하는 before 프레임의 아군 점."""
    state = extra.get("sceneState")
    if not isinstance(state, dict):
        return None
    receiver = str(extra.get("receiver") or "").strip()
    if not receiver:
        return None
    for dot in state.get("beforeDots") or []:
        if not isinstance(dot, dict):
            continue
        if str(dot.get("number") or "").strip() != receiver:
            continue
        if str(dot.get("team") or "").strip().lower() != "ally":
            continue
        x = dot.get("meter_x", dot.get("x"))
        y = dot.get("meter_y", dot.get("y"))
        if x is None or y is None:
            continue
        try:
            return (float(x), float(y))
        except (TypeError, ValueError):
            return None
    return None


def _tags_of(extra: dict[str, Any]) -> set[str]:
    return {p.strip() for p in str(extra.get("tags") or "").split(",") if p.strip()}


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--clip-id", action="append", default=[], help="대상 클립 id (반복 지정 가능)")
    parser.add_argument("--apply", action="store_true", help="실제로 DB 에 쓴다 (기본은 미리보기)")
    parser.add_argument("--force", action="store_true", help="이미 값이 있는 행도 다시 계산한다")
    parser.add_argument("--verbose", action="store_true", help="행 단위로 전부 출력")
    args = parser.parse_args()

    from app.db import SessionLocal
    from app.models import HighlightClipAction

    db = SessionLocal()
    try:
        query = db.query(HighlightClipAction)
        if args.clip_id:
            query = query.filter(HighlightClipAction.clip_id.in_(args.clip_id))
        rows = query.order_by(HighlightClipAction.clip_id, HighlightClipAction.seq).all()

        directions = _clip_directions(rows)
        fixes: list[dict[str, Any]] = []
        skips: list[dict[str, Any]] = []

        for row in rows:
            extra = row.extra or {}
            action = canonical_action_name(row.action_name, extra.get("tags"))
            if action not in PASS_ACTIONS:
                continue
            if row.reception_xg is not None and not args.force:
                continue

            item = {"clip": row.clip_id, "seq": row.seq, "action": action, "row": row}

            direction = directions.get(row.clip_id)
            if direction is None:
                skips.append(dict(item, reason="클립에 goalMouth 가 없어 공격방향 불명 — 좌우 반전 위험"))
                continue

            point = _reception_point(extra)
            if point is None:
                skips.append(dict(item, reason="받은 지점 좌표 없음(리시버 번호·프레임 결락)"))
                continue

            end_x_adj = (105.0 - point[0]) if direction == "left" else point[0]
            value = _reception_chance_xg(
                extra.get("sceneState"),
                str(row.team_side or "").strip().lower() or None,
                direction,
                end_x_adj,
                point[1],
                _tags_of(extra),
            )
            if value is None:
                skips.append(dict(item, reason="계산 실패(좌표 비정상)"))
                continue
            fixes.append(dict(item, value=round(value, _DECIMALS),
                              point=point, direction=direction))

        by_clip: dict[str, list[dict[str, Any]]] = {}
        for item in fixes + skips:
            by_clip.setdefault(item["clip"], []).append(item)

        for clip in sorted(by_clip):
            clip_fixes = [i for i in by_clip[clip] if "value" in i]
            clip_skips = [i for i in by_clip[clip] if "value" not in i]
            print(f"\n[{clip}] 채울 행 {len(clip_fixes)}건 · 보류 {len(clip_skips)}건")
            shown = clip_fixes if args.verbose else clip_fixes[:5]
            for item in shown:
                old = "—" if item["row"].reception_xg is None else f"{item['row'].reception_xg:.4f}"
                print(f"  - seq {item['seq']:>3} {item['action']:<10} "
                      f"받은지점 ({item['point'][0]:>5.1f},{item['point'][1]:>5.1f}) "
                      f"{item['direction']:<5} {old} → {item['value']:.4f}")
            if not args.verbose and len(clip_fixes) > 5:
                print(f"    … 외 {len(clip_fixes) - 5}건")
            for item in clip_skips:
                print(f"  ! seq {item['seq']:>3} {item['action']:<10} ({item['reason']})")

            if not args.apply or not clip_fixes:
                continue
            for item in clip_fixes:
                item["row"].reception_xg = item["value"]
            db.commit()  # 클립 단위로 끊는다 — 잠금 시간을 짧게, 중단돼도 재실행으로 이어짐

        print()
        if args.apply:
            print(f"반영 완료 — 클립 {len(by_clip)}건 · 채운 행 {len(fixes)}건 · 보류 {len(skips)}건")
            print("※ xFP 점수는 저장되지 않으므로, 해당 클립을 **재전송**하면 새 산식으로 채점된다.")
        else:
            print(f"[미리보기] 클립 {len(by_clip)}건 · 채울 행 {len(fixes)}건 · 보류 {len(skips)}건")
            print("실제로 반영하려면 --apply 를 붙여 다시 실행하세요.")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
