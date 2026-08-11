#!/usr/bin/env python3
"""저장된 수비 액션의 EPV 를 현재 산식(소유권 전환가치)으로 다시 계산한다.

배경
----
수비 액션의 EPV 는 **태깅 시점에 계산돼 DB 에 저장**된다. 산식이 바뀌어도 이미
저장된 행은 옛 값을 그대로 들고 있다. 지금 저장된 값은 옛 방식(상대 공격방향
ΔEPV = 상대가 그 패스로 늘린 양, 0.003~0.005 수준)이라, 새 defense 앵커의
하한(0.0144)보다 작아 **전부 최저점(50점)** 으로 나온다.

이 스크립트는 저장된 좌표로 `_defense_turnover_value` 를 다시 돌려 EPV 를 채운다.
재태깅은 필요 없다 — 필요한 건 '끊은 지점' 좌표뿐이고 로그에 남아 있다.

무엇을 고치나
------------
1. `fpa_saved_logs.rows[*]["EPV"]` 와 짝이 되는 `logs[*]` 문자열의 `EPV=...` 표기
2. `highlight_clip_actions.epv` — 위 행에서 파생된 값 (SceneIndex/SceneActionIndex 매칭)

대상은 수비 화살표 코드(태클·차단·컷아웃·클리어)로 기록된 행뿐이다. 블록(Block)은
xG 승계라 산식이 안 바뀌었고, 그 외 액션도 손대지 않는다.

좌표
----
로그 헤더의 `direction` 으로 공격방향을 정규화한다(`left` 면 x 를 뒤집는다 —
generate_log_entry 와 같은 규칙). 끊은 지점 = 두 번째 `Pos(...)`, 없으면 첫 번째
(화살표 없이 점 1개로 찍은 경우 그 점이 곧 끊은 지점).

멱등성
------
저장값을 건드리지 않고 좌표에서 **새로 계산**해 덮어쓰므로, 몇 번을 돌려도 결과가
같다. 이미 새 산식으로 저장된 행은 계산값이 같아 변경 목록에 뜨지 않는다.

운영 부담
--------
**경기 단위로 커밋**한다. 전체를 한 트랜잭션으로 묶으면 처리한 행의 잠금이 스크립트가
끝날 때까지 유지돼, 그동안 콘솔에서 같은 경기를 저장하려는 시도가 대기한다. 경기마다
끊으면 잠금이 수십 ms 로 짧아지고, 중간에 멈춰도 멱등이라 다시 돌리면 남은 것만
처리된다. 경기도 한 건씩 읽어(match_id 목록 → 개별 조회) 큰 JSONB 를 통째로 메모리에
쌓지 않는다.

사용법
------
    DATABASE_URL=... python3 scripts/backfill_defense_epv.py            # 미리보기
    DATABASE_URL=... python3 scripts/backfill_defense_epv.py --apply
    DATABASE_URL=... python3 scripts/backfill_defense_epv.py --match-id <uuid>
"""

from __future__ import annotations

import argparse
import math
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "apps" / "api"))

from app.fpa import ACTION_CODES, DEFENSE_ARROW_CODES, FIELD_W, _defense_turnover_value  # noqa: E402

# 수비 화살표 코드 → 액션 이름 (로그·행에는 이름으로 기록된다)
DEFENSE_ACTION_NAMES = {ACTION_CODES[code] for code in DEFENSE_ARROW_CODES if code in ACTION_CODES}

_EPV_IN_TEXT = re.compile(r"(EPV=)(-?[0-9.]+)")
_POS = re.compile(r"Pos\(\s*(-?[0-9.]+)\s*,\s*(-?[0-9.]+)\s*\)")
_DECIMALS = 3


def _fmt(value: float) -> str:
    return f"{value:.{_DECIMALS}f}"


def _parse_float(value: Any) -> float | None:
    try:
        number = float(str(value).strip())
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _direction(log_text: str) -> str:
    """로그 헤더 `half | team | direction | time | ...` 에서 공격방향."""
    parts = [part.strip() for part in (log_text or "").split(" | ")]
    return parts[2].lower() if len(parts) > 2 else ""


def _recomputed_epv(log_text: str) -> float | None:
    """로그의 끊은 지점 좌표로 현재 산식(소유권 전환가치)을 다시 계산.

    공격방향(direction)을 못 읽으면 계산하지 않는다 — 임의로 가정하면 x 를 뒤집을지가
    갈려 값이 좌우 반전된 채 조용히 저장된다. 못 고치는 것보다 나쁘다.
    """
    if _direction(log_text) not in ("left", "right"):
        return None
    positions = _POS.findall(log_text or "")
    if not positions:
        return None
    # 끊은 지점 = 화살표 끝점(두 번째 Pos). 점 1개면 그 점이 끊은 지점.
    end_x, end_y = (float(positions[1][0]), float(positions[1][1])) if len(positions) > 1 else (
        float(positions[0][0]), float(positions[0][1])
    )
    end_x_adj = FIELD_W - end_x if _direction(log_text) == "left" else end_x
    return _defense_turnover_value(end_x_adj, end_y)


def _plan_for_log(saved: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(고칠 목록, 못 고치는 목록)."""
    fixes: list[dict[str, Any]] = []
    skips: list[dict[str, Any]] = []
    logs = saved.logs or []
    for index, row in enumerate(saved.rows or []):
        if not isinstance(row, dict):
            continue
        if str(row.get("Action") or "") not in DEFENSE_ACTION_NAMES:
            continue
        log_text = logs[index] if index < len(logs) else ""
        expected = _recomputed_epv(log_text)
        stored = _parse_float(row.get("EPV"))
        item = {
            "index": index,
            "action": str(row.get("Action") or ""),
            "stored": stored,
            "expected": expected,
            "scene": row.get("SceneIndex"),
            "scene_action": row.get("SceneActionIndex"),
        }
        if expected is None:
            reason = ("공격방향(direction) 없음 — 좌우 반전 위험이라 건너뜀"
                      if _direction(log_text) not in ("left", "right")
                      else "좌표 없음(로그에 Pos 미기록)")
            skips.append(dict(item, reason=reason))
            continue
        if stored is not None and abs(stored - expected) < 10 ** -_DECIMALS / 2:
            continue  # 이미 새 산식
        fixes.append(item)
    return fixes, skips


def _apply_to_text(log_text: str, new_epv: float) -> str:
    return _EPV_IN_TEXT.sub(lambda m: m.group(1) + _fmt(new_epv), log_text or "")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--match-id", action="append", default=[], help="대상 경기 UUID (반복 지정 가능)")
    parser.add_argument("--since", help="updated_at 이 이 날짜 이후인 것만 (YYYY-MM-DD)")
    parser.add_argument("--apply", action="store_true", help="실제로 DB 에 쓴다 (기본은 미리보기)")
    parser.add_argument("--verbose", action="store_true", help="행 단위로 전부 출력")
    args = parser.parse_args()

    from app.db import SessionLocal
    from app.models import FpaSavedLog, HighlightClipAction

    db = SessionLocal()
    try:
        query = db.query(FpaSavedLog)
        if args.match_id:
            query = query.filter(FpaSavedLog.match_id.in_(args.match_id))
        if args.since:
            query = query.filter(FpaSavedLog.updated_at >= datetime.strptime(args.since, "%Y-%m-%d"))

        total_fix = total_skip = touched_matches = clip_action_fix = 0
        # 경기 id 만 먼저 받고 한 건씩 조회한다 — 큰 JSONB 를 전부 메모리에 쌓지 않고,
        # 커밋도 경기마다 끊어 잠금 시간을 짧게 유지한다.
        match_ids = [row[0] for row in query.order_by(FpaSavedLog.updated_at).with_entities(FpaSavedLog.match_id)]
        for match_id in match_ids:
            saved = db.get(FpaSavedLog, match_id)
            if saved is None:
                continue
            fixes, skips = _plan_for_log(saved)
            if not fixes and not skips:
                continue
            touched_matches += 1
            total_fix += len(fixes)
            total_skip += len(skips)
            print(f"\n[{saved.match_id}] updated={saved.updated_at:%Y-%m-%d} "
                  f"고칠 행 {len(fixes)}건 · 보류 {len(skips)}건")
            for item in (fixes if args.verbose else fixes[:5]):
                stored = "—" if item["stored"] is None else f"{item['stored']:+.3f}"
                print(f"  - row {item['index']:>4} {item['action']:<10} {stored} → {item['expected']:+.3f}")
            if not args.verbose and len(fixes) > 5:
                print(f"    … 외 {len(fixes) - 5}건")
            for item in skips:
                print(f"  ! row {item['index']:>4} {item['action']:<10} ({item['reason']})")

            if not args.apply or not fixes:
                continue

            rows = list(saved.rows or [])
            logs = list(saved.logs or [])
            corrected: dict[tuple[str, str], float] = {}
            for item in fixes:
                index, new_epv = item["index"], item["expected"]
                rows[index] = dict(rows[index], EPV=_fmt(new_epv))
                if index < len(logs):
                    logs[index] = _apply_to_text(logs[index], new_epv)
                corrected[(str(item["scene"]), str(item["scene_action"]))] = new_epv
            saved.rows = rows
            saved.logs = logs

            actions = (
                db.query(HighlightClipAction)
                .filter(HighlightClipAction.fpa_match_id == saved.match_id)
                .all()
            )
            for action in actions:
                new_epv = corrected.get((str(action.fpa_scene_index), str(action.fpa_scene_action_index)))
                if new_epv is None:
                    continue
                action.epv = round(new_epv, 4)
                clip_action_fix += 1

            db.commit()  # 경기 단위로 끊는다 — 잠금 시간을 짧게, 중단돼도 재실행으로 이어짐

        if args.apply:
            print(f"\n반영 완료 — 경기 {touched_matches}건 · FPA 행 {total_fix}건 · "
                  f"클립 액션 {clip_action_fix}건 · 보류 {total_skip}건")
        else:
            print(f"\n[미리보기] 경기 {touched_matches}건 · 고칠 FPA 행 {total_fix}건 · 보류 {total_skip}건")
            print("실제로 반영하려면 --apply 를 붙여 다시 실행하세요.")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
