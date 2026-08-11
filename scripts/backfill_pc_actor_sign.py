#!/usr/bin/env python3
"""저장된 PC 값을 행위자 기준으로 되돌린다 (어웨이 액션 부호 수정 소급 적용).

배경
----
`_pitch_control_at` 은 항상 홈 기준(+1 = 홈 완전지배)인데, 채점(`xfp_score`)이 보는 건
'행위자 팀의 이득'이다. 어웨이 팀 액션은 부호를 뒤집어야 하는데 그러지 않아서,
어웨이가 공간을 잡은 좋은 액션이 음수가 되어 `MAX(0, ΔPC)` 에서 통째로 탈락하고,
반대로 공간을 내준 액션이 양수로 점수를 받았다. `fpa._actor_pc_sign` 이 이걸 고쳤지만,
**이미 저장된 값은 그대로**라 이 스크립트로 소급한다.

무엇을 고치나
------------
1. `fpa_saved_logs.rows[*]["PC"]` 와 짝이 되는 `logs[*]` 문자열의 `PC=...` 표기
2. `highlight_clip_actions.pc` — 위 행에서 파생된 값 (SceneIndex/SceneActionIndex 로 매칭)

`xfpScore`/`xfpPercentile` 은 DB 에 저장되지 않고 PC 에서 매번 다시 계산되므로
(`xfp_score.score_clip_actions`, `fineplay_fpa.annotate_action_codes`) 따로 손댈 게 없다.

대상은 DualState 의 `actor_team == "away"` 이고 PC 가 기록된 행뿐이다. 홈 액션과
`actor_team` 이 없는 구버전 로그는 고칠 근거가 없어 건드리지 않는다 (`_actor_pc_sign` 과 동일 규칙).

멱등성
------
부호를 그냥 뒤집으면 두 번 돌릴 때 원위치한다. 그래서 **DualState 로 PC 를 다시 계산해**
저장값과 비교하고, '뒤집으면 재계산값과 맞는' 행만 고친다 — 이미 고쳐진 행은 저장값이
재계산값과 같으므로 건너뛴다. 재계산이 불가능하거나(좌표 파싱 실패 등) 뒤집어도
재계산값과 안 맞는 행은 **고치지 않고 목록으로 보고**한다. 압박(pr) 처럼 모델 자체가
바뀐 행이 여기 걸린다 — 이 스크립트는 부호만 되돌리지, 모델 변경분까지 소급하지 않는다.

사용법
------
    # 무엇이 바뀌는지만 본다 (기본값 — 아무것도 쓰지 않는다)
    DATABASE_URL=... python3 scripts/backfill_pc_actor_sign.py

    # 특정 경기만
    DATABASE_URL=... python3 scripts/backfill_pc_actor_sign.py --match-id <uuid>

    # 최근 것만
    DATABASE_URL=... python3 scripts/backfill_pc_actor_sign.py --since 2026-07-01

    # 실제 반영
    DATABASE_URL=... python3 scripts/backfill_pc_actor_sign.py --apply
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "apps" / "api"))

from app.fpa import (  # noqa: E402
    _decode_dual_pitch_state,
    _pitch_control_delta,
    _press_region_pitch_control,
)

# app.db / app.models 는 sqlalchemy 를 요구한다 — 이 스크립트의 계산 로직만 따로 부르거나
# --help 를 볼 때까지 그 의존성을 끌어오지 않도록 main() 안에서 임포트한다.

# 로그 문자열의 지표 표기 — "Metrics: EPV=0.011, PC=-1.891"
_PC_IN_TEXT = re.compile(r"(PC=)(-?[0-9.]+)")
# "Pos(31.0, 40.0)" — 첫 번째가 시작점, 패스류는 두 번째가 도착점.
_POS = re.compile(r"Pos\(\s*(-?[0-9.]+)\s*,\s*(-?[0-9.]+)\s*\)")
# 표기 자릿수 (fpa._metric_text_value 와 동일)
_DECIMALS = 3


def _fmt(value: float) -> str:
    return f"{value:.{_DECIMALS}f}"


def _parse_float(value: Any) -> float | None:
    try:
        number = float(str(value).strip())
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _actor_team(row: dict[str, Any]) -> str:
    state = _decode_dual_pitch_state(row.get("DualState"))
    return str((state or {}).get("actor_team") or "").lower()


def _recomputed_pc(row: dict[str, Any], log_text: str) -> float | None:
    """DualState + 로그의 좌표로 PC 를 현재 산식(부호 수정 포함)으로 다시 계산한다."""
    state = _decode_dual_pitch_state(row.get("DualState"))
    if not state:
        return None
    if str(row.get("Action") or "") == "Press":
        press = _press_region_pitch_control(state)
        return press[2] if press else None
    positions = _POS.findall(log_text or "")
    if not positions:
        return None
    start = (float(positions[0][0]), float(positions[0][1]))
    end = (float(positions[1][0]), float(positions[1][1])) if len(positions) > 1 else start
    return _pitch_control_delta(state, start, end)


def _apply_to_text(log_text: str, new_pc: float) -> str:
    return _PC_IN_TEXT.sub(lambda m: m.group(1) + _fmt(new_pc), log_text or "")


def _plan_for_log(saved: Any) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """(고칠 목록, 못 고치는 목록). 각 항목은 행 인덱스와 옛/새 값."""
    fixes: list[dict[str, Any]] = []
    skips: list[dict[str, Any]] = []
    rows = saved.rows or []
    logs = saved.logs or []
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            continue
        stored = _parse_float(row.get("PC"))
        if stored is None:
            continue
        if _actor_team(row) != "away":
            continue
        log_text = logs[index] if index < len(logs) else ""
        expected = _recomputed_pc(row, log_text)
        item = {
            "index": index,
            "action": str(row.get("Action") or ""),
            "stored": stored,
            "expected": expected,
            "scene": row.get("SceneIndex"),
            "scene_action": row.get("SceneActionIndex"),
        }
        if expected is None:
            skips.append(dict(item, reason="재계산 불가(DualState/좌표 없음)"))
            continue
        if abs(stored - expected) < 10 ** -_DECIMALS / 2:
            continue  # 이미 고쳐졌다
        if abs(-stored - expected) < 10 ** -_DECIMALS / 2:
            fixes.append(item)
        else:
            skips.append(dict(item, reason="부호만으로 설명 안 됨(모델 변경분 포함)"))
    return fixes, skips


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--match-id", action="append", default=[], help="대상 경기 UUID (반복 지정 가능)")
    parser.add_argument("--since", help="fpa_saved_logs.updated_at 이 이 날짜 이후인 것만 (YYYY-MM-DD)")
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
        saved_logs = query.order_by(FpaSavedLog.updated_at).all()

        total_fix = total_skip = touched_matches = clip_action_fix = 0
        for saved in saved_logs:
            fixes, skips = _plan_for_log(saved)
            if not fixes and not skips:
                continue
            touched_matches += 1
            total_fix += len(fixes)
            total_skip += len(skips)
            print(f"\n[{saved.match_id}] updated={saved.updated_at:%Y-%m-%d} "
                  f"고칠 행 {len(fixes)}건 · 보류 {len(skips)}건")
            for item in fixes if args.verbose else fixes[:3]:
                print(f"  - row {item['index']:>4} {item['action']:<10} "
                      f"{item['stored']:+.3f} → {item['expected']:+.3f}")
            if not args.verbose and len(fixes) > 3:
                print(f"    … 외 {len(fixes) - 3}건")
            for item in skips:
                recomputed = "—" if item["expected"] is None else f"{item['expected']:+.3f}"
                print(f"  ! row {item['index']:>4} {item['action']:<10} "
                      f"저장 {item['stored']:+.3f} / 재계산 {recomputed}  ({item['reason']})")

            if not args.apply or not fixes:
                continue

            rows = list(saved.rows or [])
            logs = list(saved.logs or [])
            corrected: dict[tuple[str, str], float] = {}
            for item in fixes:
                index, new_pc = item["index"], item["expected"]
                rows[index] = dict(rows[index], PC=_fmt(new_pc))
                if index < len(logs):
                    logs[index] = _apply_to_text(logs[index], new_pc)
                corrected[(str(item["scene"]), str(item["scene_action"]))] = new_pc
            saved.rows = rows
            saved.logs = logs

            # 파생값(highlight_clip_actions.pc)에는 교정된 행 값을 그대로 쓴다.
            # 여기서 다시 부호를 뒤집으면 두 번 실행 시 원위치하므로, 값을 '맞춰 넣는다'.
            actions = (
                db.query(HighlightClipAction)
                .filter(HighlightClipAction.fpa_match_id == saved.match_id)
                .all()
            )
            for action in actions:
                if action.pc is None:
                    continue
                new_pc = corrected.get((str(action.fpa_scene_index), str(action.fpa_scene_action_index)))
                if new_pc is None:
                    continue
                action.pc = round(new_pc, 4) + 0.0
                clip_action_fix += 1

        if args.apply:
            db.commit()
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
