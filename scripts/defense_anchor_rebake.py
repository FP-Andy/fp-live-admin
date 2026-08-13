#!/usr/bin/env python3
"""수비 실측 분포를 뽑아 defense 앵커(눈금)를 재보정한다.

배경
----
`xfp_anchors_v0.json` 의 defense 앵커는 실측 태깅 분포가 없어 `_defense_turnover_value`
를 **피치 전역 1m 격자(6,968점)** 에 뿌린 분위수로 잠정 산출한 값이다(파일 source 참조).
그런데 실제 수비는 피치에 고르게 퍼지지 않고 **자기 진영에 몰린다.** 이 스크립트는
**실제로 태깅된 수비 액션**의 값 분포를 뽑아 곡선을 다시 앉힌다.

기대치를 미리 낮춰둘 것 — 효과가 작을 수 있다
--------------------------------------------
전환가치는 x 에 대해 **단조가 아니라 U 자형** 이다(우리 골문 앞이 최고, x≈70 부근이
바닥, 하이프레스에서 다시 올라간다). 그래서 표본이 자기 진영에 쏠려도 분위수가
격자 기준에서 크게 밀리지 않는다. 합성 표본(자기 진영 가중 1,200건)으로 미리 돌려본
결과 중앙 점수가 82 → 80 으로 2점 움직였을 뿐이다. 실측이 어떻게 나올지는 돌려봐야
알지만, "재보정하면 점수대가 확 내려간다" 는 기대는 하지 말 것.

**이 스크립트가 못 고치는 것** — 우리 박스 안 수비가 97~99 로 포화되는 현상은 앵커
문제가 **아니다.** 그 값들이 실제로 수비 가치 분포의 최상단이라서 그렇다(자기 골문
앞의 위협 제거가 가장 값진 수비라는 건 산식의 의도다). 재보정해도 98~99 그대로다.
'루틴 클리어와 결정적 클리어가 같은 98점' 이 걸린다면 그건 눈금이 아니라 **같은
지점 안에서 개별 행위의 난도·맥락을 재는 항이 없다** 는 뜻이고, 별도 설계가 필요하다.

⚠️ 액션별로 쪼개지 말 것
-----------------------
태클·인터셉트·컷아웃·클리어의 **순서는 산식의 회수 성공도**(fpa.DEFENSE_RETENTION)가
만든다. 액션마다 앵커를 따로 주면 백분위가 그 액션 자신의 분포 안에서 매겨지므로
곱셈이 상쇄되고(중간짜리 클리어 = 중간 백분위 = 75점) 순서가 통째로 사라진다.
그래서 이 스크립트는 **네 액션을 한 표본으로 합쳐 곡선 하나**를 낸다. 액션별 분포는
구성을 보라고 출력만 하고, `actions` 오버라이드는 쓰지 않는다.

표본을 고르는 기준
-----------------
1. 대상은 수비 화살표 코드(태클·인터셉트·컷아웃·클리어)뿐이다. **블록은 제외** —
   막은 슛 xG 라 goal 곡선으로 재고, 애초에 단위가 다르다.
2. 저장된 EPV 를 **믿지 않고 좌표에서 다시 계산**한다. 저장값은 옛 산식(상대 공격방향
   ΔEPV)과 새 산식이 섞여 있을 수 있고, 회수 성공도 개정 이후의 백필이 돌았는지도
   보장되지 않는다. 좌표와 액션 이름은 변하지 않으므로 여기서 다시 재는 게 정확하다.
   (그래서 `backfill_defense_epv.py` 를 안 돌렸어도 이 스크립트는 옳은 분포를 낸다.)
3. 공격방향(direction)을 못 읽는 행은 **버린다.** 임의로 가정하면 x 가 좌우 반전돼
   값이 조용히 틀린다 — 백필 스크립트와 같은 원칙이다.

산식을 바꾸면 여기도 다시 돌려야 한다
-----------------------------------
앵커는 '그 산식이 내는 값의 분포' 다. `DEFENSE_TURNOVER_WEIGHT` 나 `DEFENSE_RETENTION`
을 건드리면 값의 스케일이 바뀌므로 이 스크립트를 다시 돌려 눈금을 맞춰야 한다.

사용법
------
    DATABASE_URL=... python3 scripts/defense_anchor_rebake.py           # 분포+제안 앵커 출력
    DATABASE_URL=... python3 scripts/defense_anchor_rebake.py --write   # 앵커 파일에 반영
    DATABASE_URL=... python3 scripts/defense_anchor_rebake.py --verbose
"""

from __future__ import annotations

import argparse
import collections
import json
import math
import re
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "apps" / "api"))

from app.fpa import (  # noqa: E402
    ACTION_CODES,
    DEFENSE_ARROW_CODES,
    DEFENSE_RETENTION,
    DEFENSE_TURNOVER_WEIGHT,
    FIELD_W,
    _defense_turnover_value,
)
from app.xfp_score import percentile_to_score, raw_to_percentile  # noqa: E402

_ANCHORS_PATH = Path(__file__).resolve().parent.parent / "apps" / "api" / "app" / "xfp_anchors_v0.json"
_POS = re.compile(r"Pos\(\s*(-?[0-9.]+)\s*,\s*(-?[0-9.]+)\s*\)")

# 수비 화살표 코드 → 액션 이름. 블록(qw)은 goal 곡선이라 여기 없다.
DEFENSE_ACTION_NAMES = {ACTION_CODES[code] for code in DEFENSE_ARROW_CODES if code in ACTION_CODES}
# 24코드는 자기 진영 S5 / 상대 진영 S7 로 갈리지만 둘 다 같은 defense 곡선을 쓴다.
_DEFENSE_CODE = "S5"


def _direction(log_text: str) -> str:
    """로그 헤더 `half | team | direction | time | ...` 에서 공격방향."""
    parts = [part.strip() for part in (log_text or "").split(" | ")]
    return parts[2].lower() if len(parts) > 2 else ""


def _recomputed_value(log_text: str, action_name: str) -> tuple[float | None, str]:
    """(현재 산식 값, 건너뛴 이유). 값이 있으면 이유는 빈 문자열."""
    direction = _direction(log_text)
    if direction not in ("left", "right"):
        return None, "공격방향 없음 — 좌우 반전 위험"
    positions = _POS.findall(log_text or "")
    if not positions:
        return None, "좌표 없음(로그에 Pos 미기록)"
    # 끊은 지점 = 화살표 끝점(두 번째 Pos). 점 1개면 그 점이 끊은 지점.
    end_x, end_y = (float(positions[1][0]), float(positions[1][1])) if len(positions) > 1 else (
        float(positions[0][0]), float(positions[0][1])
    )
    end_x_adj = FIELD_W - end_x if direction == "left" else end_x
    value = _defense_turnover_value(end_x_adj, end_y, action_name)
    return (value, "") if value is not None else (None, "EPV 격자 밖 좌표")


def quantile(sorted_values: list[float], p: float) -> float:
    """선형 보간 분위수 (numpy 없이 — DB 세션만 있으면 돌아야 한다)."""
    if not sorted_values:
        return float("nan")
    if len(sorted_values) == 1:
        return sorted_values[0]
    pos = p * (len(sorted_values) - 1)
    lo = int(math.floor(pos))
    hi = min(lo + 1, len(sorted_values) - 1)
    return sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * (pos - lo)


def _percentile_with(table: list[float], points: list[float], raw: float) -> float:
    """`raw_to_percentile` 과 같은 보간을, 임의의 앵커 표로 (제안 앵커 미리보기용)."""
    if raw <= table[0]:
        return points[0] * (raw / table[0]) if table[0] > 0 else points[0]
    if raw >= table[-1]:
        over = (raw - table[-1]) / table[-1]
        return min(0.999, points[-1] + (0.999 - points[-1]) * min(over, 1.0))
    for k in range(1, len(table)):
        if raw <= table[k]:
            lo_v, hi_v = table[k - 1], table[k]
            t = (raw - lo_v) / (hi_v - lo_v) if hi_v > lo_v else 0.0
            return points[k - 1] + (points[k] - points[k - 1]) * t
    return points[-1]


def _describe(name: str, values: list[float]) -> None:
    print(f"\n── {name} (n={len(values)}) ──")
    if not values:
        return
    ordered = sorted(values)
    cells = " · ".join(f"p{int(p * 100)}={quantile(ordered, p):.4f}" for p in (0.1, 0.25, 0.5, 0.75, 0.9))
    print(f"  {cells} · 최소 {ordered[0]:.4f} · 최대 {ordered[-1]:.4f} · 평균 {sum(ordered) / len(ordered):.4f}")


def _score_histogram(
    values: list[float],
    *,
    label: str,
    table: list[float] | None = None,
    points: list[float] | None = None,
) -> None:
    """이 표본이 몇 점을 받는지 — '우리 진영에 뭉친다' 를 수치로 확인."""
    if not values:
        return
    buckets = {"50-69": 0, "70-79": 0, "80-89": 0, "90-94": 0, "95-100": 0}
    scores = []
    for v in values:
        p = _percentile_with(table, points or [], v) if table else raw_to_percentile(_DEFENSE_CODE, v, "defense")
        if p is None:
            continue
        s = percentile_to_score(p)
        scores.append(s)
        key = ("50-69" if s < 70 else "70-79" if s < 80 else "80-89" if s < 90 else "90-94" if s < 95 else "95-100")
        buckets[key] += 1
    if not scores:
        return
    total = len(scores)
    print(f"  {label} 기준 점수 (n={total}, 중앙 {sorted(scores)[total // 2]}점)")
    for key, count in buckets.items():
        bar = "█" * round(30 * count / total)
        print(f"    {key:>7}: {count:>4}건 {100 * count / total:>5.1f}% {bar}")


def _proposed(values: list[float], points: list[float]) -> list[float] | None:
    if not values:
        return None
    ordered = sorted(values)
    out: list[float] = []
    for p in points:
        q = quantile(ordered, p)
        # 앵커는 단조 증가여야 보간이 성립한다 — 겹치면 아주 조금 밀어준다.
        if out and q <= out[-1]:
            q = out[-1] + 1e-4
        out.append(round(q, 4))
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--write", action="store_true", help="제안 앵커를 xfp_anchors_v0.json 에 반영")
    parser.add_argument("--min-samples", type=int, default=100, help="이 표본수 미만이면 --write 거부 (기본 100)")
    parser.add_argument("--match-id", action="append", default=[], help="대상 경기 UUID (반복 지정 가능)")
    parser.add_argument("--verbose", action="store_true", help="건너뛴 행을 전부 출력")
    args = parser.parse_args()

    from app.db import SessionLocal
    from app.models import FpaSavedLog

    anchors = json.loads(_ANCHORS_PATH.read_text(encoding="utf-8"))
    points: list[float] = anchors["percentile_points"]
    current: list[float] = anchors["families"]["defense"]

    db = SessionLocal()
    try:
        query = db.query(FpaSavedLog)
        if args.match_id:
            query = query.filter(FpaSavedLog.match_id.in_(args.match_id))

        values: list[float] = []
        by_action: dict[str, list[float]] = collections.defaultdict(list)
        skips: collections.Counter = collections.Counter()
        skip_rows: list[str] = []

        match_ids = [row[0] for row in query.with_entities(FpaSavedLog.match_id)]
        for match_id in match_ids:
            saved = db.get(FpaSavedLog, match_id)
            if saved is None:
                continue
            logs = saved.logs or []
            for index, row in enumerate(saved.rows or []):
                if not isinstance(row, dict):
                    continue
                action_name = str(row.get("Action") or "")
                if action_name not in DEFENSE_ACTION_NAMES:
                    continue
                log_text = logs[index] if index < len(logs) else ""
                value, reason = _recomputed_value(log_text, action_name)
                if value is None:
                    skips[reason] += 1
                    skip_rows.append(f"    {saved.match_id} row {index:>4} {action_name:<10} ({reason})")
                    continue
                values.append(value)
                by_action[action_name].append(value)

        print("=" * 78)
        print("수비 앵커 재보정 — 실측 태깅 분포")
        print("=" * 78)
        print(f"  산식: {DEFENSE_TURNOVER_WEIGHT} × EPV(상대) + "
              f"{1 - DEFENSE_TURNOVER_WEIGHT:.2f} × 회수계수 × EPV(우리)")
        print(f"  회수계수: " + " · ".join(f"{k} {v:.2f}" for k, v in DEFENSE_RETENTION.items()))
        print(f"  표본: 저장로그의 수비 화살표 행을 좌표에서 재계산 (블록 제외)")

        if skips:
            print(f"\n  건너뛴 행 {sum(skips.values())}건")
            for reason, count in skips.most_common():
                print(f"    - {reason}: {count}건")
            if args.verbose:
                for line in skip_rows:
                    print(line)

        if not values:
            print("\n표본이 없습니다 — 저장된 수비 행이 없거나 전부 건너뛰었습니다.")
            return 1

        _describe("전체 (앵커 표본)", values)
        for action in sorted(by_action, key=lambda a: -len(by_action[a])):
            _describe(f"참고 · {action}", by_action[action])
        print("\n  ↑ 액션별 분포는 구성을 보라고 찍는다. 앵커는 위 '전체' 하나만 쓴다 —")
        print("    액션별로 쪼개면 회수계수의 곱셈이 백분위에서 상쇄돼 순서가 사라진다.")

        proposed = _proposed(values, points)
        print()
        print("=" * 78)
        print("앵커 비교")
        print("=" * 78)
        print(f"  {'백분위':>7} {'현재':>10} {'제안':>10}")
        print("  " + "-" * 32)
        for p, cur, new in zip(points, current, proposed):
            print(f"  {p:>7.2f} {cur:>10.4f} {new:>10.4f}")

        print()
        print("=" * 78)
        print("이 표본이 받는 점수 — 재보정 전후")
        print("=" * 78)
        _score_histogram(values, label="현재 앵커")
        print()
        _score_histogram(values, label="제안 앵커", table=proposed, points=points)

        print()
        print("=" * 78)
        print("회수계수 순서가 살아 있나 — 기준 지점 고정 비교")
        print("=" * 78)
        print("  ⚠️ 액션별 '중앙 점수' 로는 이걸 못 본다. 클리어는 우리 골문 근처에 몰려")
        print("     있어서 계수가 낮아도 중앙값이 가장 높게 나온다 — 위치 효과지 순서가")
        print("     깨진 게 아니다. 순서는 **같은 지점에서** 비교해야 보인다.")
        actions = sorted(DEFENSE_RETENTION, key=lambda a: -DEFENSE_RETENTION[a])
        print(f"\n  {'기준 지점':<22}", end="")
        for action in actions:
            print(f" {action:>10}", end="")
        print()
        print("  " + "-" * (22 + 11 * len(actions)))
        for label, x, y in (("우리 박스 안 (8,34)", 8.0, 34.0),
                            ("우리 진영 (25,34)", 25.0, 34.0),
                            ("중앙선 (52,34)", 52.5, 34.0),
                            ("하이프레스 (90,34)", 90.0, 34.0)):
            print(f"  {label:<22}", end="")
            row = []
            for action in actions:
                value = _defense_turnover_value(x, y, action)
                score = percentile_to_score(_percentile_with(proposed, points, value))
                row.append(score)
                print(f" {score:>10}", end="")
            print("   ← 순서 깨짐" if row != sorted(row, reverse=True) else "")

        print("\n  참고 · 실측 표본의 액션별 중앙 점수 (위치 효과가 섞인 값이다)")
        print(f"    {'액션':<12} {'n':>5} {'중앙 점수':>10}")
        print("    " + "-" * 30)
        for action in sorted(by_action, key=lambda a: -DEFENSE_RETENTION.get(a, 0.0)):
            vals = by_action[action]
            scores = sorted(percentile_to_score(_percentile_with(proposed, points, v)) for v in vals)
            print(f"    {action:<12} {len(vals):>5} {scores[len(scores) // 2]:>10}")

        if not args.write:
            print("\n[미리보기] 반영하려면 --write")
            return 0
        if len(values) < args.min_samples:
            print(f"\n표본 {len(values)}건 < 최소 {args.min_samples}건 — --write 거부. "
                  f"강행하려면 --min-samples 를 낮추세요.")
            return 1

        anchors["families"]["defense"] = proposed
        _ANCHORS_PATH.write_text(json.dumps(anchors, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"\n반영 완료 — {_ANCHORS_PATH}")
        print("  ⚠️ 앵커만 바뀌었을 뿐 저장된 EPV 는 그대로다. 산식도 함께 바꿨다면")
        print("     scripts/backfill_defense_epv.py 를 돌려 저장값을 맞추세요.")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
