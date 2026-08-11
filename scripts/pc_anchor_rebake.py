#!/usr/bin/env python3
"""ΔPC 실측 분포를 뽑아 possession 앵커를 재보정한다.

배경
----
`xfp_anchors_v0.json` 의 possession 앵커는 실측 분포 없이 손으로 잡은 임시값이라
(파일 note 참조), 백분위가 실제보다 부풀어 점수가 높게 나온다.

표본을 고르는 기준 (중요)
------------------------
ΔPC 가 기록된 액션이 전부 PC 로 점수를 받는 건 아니다. `classify_action_code` 가
액션마다 기대효과 군을 하나만 고르기 때문이다 — 패스는 뒤에 슈팅이 있으면 Goal(G2),
아니면 EPV vs PC 중 **큰 쪽**으로 Progression/Possession 이 갈리고, 침투는 항상
Progression(P6), 크로스는 Goal/Progression 이다. 즉 possession(S*) 으로 떨어진
액션만 `MAX(0,ΔPC)` 로 점수를 받는다.

그래서 앵커 표본은 **실제 채점 경로를 그대로 태워** possession 으로 분류된 액션의
ΔPC 만 모은다. 기록된 ΔPC 를 전부 넣으면 EPV 로 점수받는 액션까지 섞여 분포가
왜곡된다(possession 군은 정의상 'PC 가 EPV 를 이긴' 액션들이라 더 큰 값에 쏠린다).

압박(pr, S9)은 점이 아니라 영역 평균이라 델타 스케일이 한 자리 작다 — 같은 앵커를
쓰면 과소평가되므로 `actions` 오버라이드용 앵커를 따로 낸다.

부호
----
`fpa._actor_pc_sign` 이전에 저장된 값은 어웨이 액션의 부호가 뒤집혀 있다. 저장로그
(`fpa_saved_logs`)에 DualState 가 있으면 **현재 산식으로 재계산**해 그 값을 쓰고,
없으면 team_side 로 부호만 맞춘다(`--pc-sign-fixed` 면 이미 고쳐진 것으로 보고 생략).
부호는 분류(EPV vs PC 비교)에도 영향을 주므로 분류 전에 교정한다.

사용법
------
    DATABASE_URL=... python3 scripts/pc_anchor_rebake.py               # 분포+제안 앵커 출력
    DATABASE_URL=... python3 scripts/pc_anchor_rebake.py --write       # 앵커 파일에 반영
    DATABASE_URL=... python3 scripts/pc_anchor_rebake.py --pc-sign-fixed
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

from app.fineplay_fpa import annotate_action_codes  # noqa: E402
from app.fpa import (  # noqa: E402
    _actor_pc_sign,
    _decode_dual_pitch_state,
    _pitch_control_delta,
    _press_region_pitch_control,
)
from app.xfp_score import effect_basis, outcome_family, percentile_to_score, raw_to_percentile  # noqa: E402

_ANCHORS_PATH = Path(__file__).resolve().parent.parent / "apps" / "api" / "app" / "xfp_anchors_v0.json"
_POS = re.compile(r"Pos\(\s*(-?[0-9.]+)\s*,\s*(-?[0-9.]+)\s*\)")
# 압박은 영역 평균이라 점 방식과 스케일이 다르다 — 앵커를 따로 받는 24코드.
_PRESS_CODE = "S9"


def _recomputed_pc(row: dict[str, Any], log_text: str) -> float | None:
    """DualState + 로그 좌표로 현재 산식(행위자 기준 부호 포함) PC 를 다시 계산."""
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
    cells = " · ".join(f"p{int(p * 100)}={quantile(ordered, p):.3f}" for p in (0.1, 0.25, 0.5, 0.75, 0.9))
    print(f"  {cells} · 최대 {ordered[-1]:.3f} · 평균 {sum(ordered) / len(ordered):.3f}")


def _score_histogram(
    code: str,
    values: list[float],
    *,
    label: str = "현재 앵커",
    table: list[float] | None = None,
    points: list[float] | None = None,
) -> None:
    """이 표본이 몇 점을 받는지 — '점수가 높다' 를 수치로 확인."""
    if not values:
        return
    buckets = {"50-69": 0, "70-79": 0, "80-89": 0, "90-94": 0, "95-100": 0}
    scores = []
    for v in values:
        p = _percentile_with(table, points or [], v) if table else raw_to_percentile(code, v)
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
    parser.add_argument("--pc-sign-fixed", action="store_true",
                        help="저장값이 이미 행위자 기준(backfill_pc_actor_sign 적용)이면 지정")
    args = parser.parse_args()

    from app.db import SessionLocal
    from app.models import FpaSavedLog, HighlightClipAction

    anchors = json.loads(_ANCHORS_PATH.read_text(encoding="utf-8"))
    points: list[float] = anchors["percentile_points"]

    db = SessionLocal()
    try:
        # ① 저장로그에서 DualState 로 PC 재계산 — (match_id, scene, action) → 옳은 ΔPC
        recomputed: dict[tuple[Any, str, str], float] = {}
        for saved in db.query(FpaSavedLog).all():
            logs = saved.logs or []
            for index, row in enumerate(saved.rows or []):
                if not isinstance(row, dict):
                    continue
                value = _recomputed_pc(row, logs[index] if index < len(logs) else "")
                if value is None:
                    continue
                key = (saved.match_id, str(row.get("SceneIndex")), str(row.get("SceneActionIndex")))
                recomputed[key] = value

        # ② 클립 액션을 채점 페이로드로 만들어 실제 코드 분류를 태운다
        clips: dict[str, list[dict[str, Any]]] = collections.defaultdict(list)
        for action in db.query(HighlightClipAction).order_by(HighlightClipAction.clip_id, HighlightClipAction.seq):
            extra = action.extra or {}
            key = (action.fpa_match_id, str(action.fpa_scene_index), str(action.fpa_scene_action_index))
            pc = recomputed.get(key)
            source = "재계산"
            if pc is None and action.pc is not None:
                pc = float(action.pc)
                if not args.pc_sign_fixed:
                    pc *= _actor_pc_sign(action.team_side)
                source = "저장값(부호교정)" if not args.pc_sign_fixed else "저장값"
            clips[action.clip_id].append({
                "seq": action.seq,
                "action": action.action_name,
                "teamSide": action.team_side,
                "jersey": action.jersey,
                "xg": action.xg,
                "xgot": action.xgot,
                "epv": action.epv,
                "pc": pc,
                "x": extra.get("x"),
                "y": extra.get("y"),
                "groupIndex": extra.get("groupIndex"),
                "extra": extra,
                "_pcSource": source,
            })
    finally:
        db.close()

    fam_counter: collections.Counter[str] = collections.Counter()
    point_values: list[float] = []
    press_values: list[float] = []
    dropped = 0
    sources: collections.Counter[str] = collections.Counter()
    for actions in clips.values():
        annotate_action_codes(actions)
        for pa in actions:
            code = pa.get("actionCode")
            fam = outcome_family(code) if code else None
            # 표본 기준은 Outcome 군이 아니라 **실제로 무엇으로 재는가**(effect_basis).
            # 수비(S5/S7)는 Outcome 이 Possession 이어도 막아낸 EPV·xG 로 채점하므로
            # ΔPC 앵커 표본에서 빠져야 한다 — 넣으면 통제 경계를 넘는 액션이라 늘 최대치인
            # 값들이 분포 상단을 통째로 끌어올린다.
            basis = effect_basis(code, pa) if code else None
            fam_counter[(fam or "(분류없음)") + ("" if basis == fam else f" → {basis}")] += 1
            if basis != "possession":
                continue
            sources[pa["_pcSource"]] += 1
            value = float(pa.get("pc") or 0)
            if value <= 0:
                dropped += 1  # MAX(0,ΔPC) 에서 탈락 — 점수 자체가 안 붙는다
                continue
            (press_values if code == _PRESS_CODE else point_values).append(value)

    total = sum(fam_counter.values())
    print(f"액션 {total}건 · 클립 {len(clips)}개")
    print("── 기대효과 군 (실제 채점 경로) ──")
    for fam, n in fam_counter.most_common():
        mark = "  ← PC 로 점수" if fam == "possession" else ""
        print(f"  {fam:<12} {n:>4}건 {100 * n / total:>5.1f}%{mark}")
    print(f"  PC 값 출처: {dict(sources)} · ΔPC<=0 으로 점수 못 받은 possession {dropped}건")

    _describe("possession · 점 방식 ΔPC", point_values)
    _score_histogram("S1", point_values)
    _describe(f"possession · 압박({_PRESS_CODE}) 영역 ΔPC", press_values)
    _score_histogram(_PRESS_CODE, press_values)

    proposed_point = _proposed(point_values, points)
    proposed_press = _proposed(press_values, points)
    print("\n── 제안 앵커 (실측 분위수) ──")
    print(f"  families.possession = {proposed_point}")
    print(f"  현재                = {anchors['families']['possession']}")
    if proposed_press:
        print(f"  actions.{_PRESS_CODE} (압박) = {proposed_press}")
    if proposed_point:
        print()
        _score_histogram("S1", point_values, label="제안 앵커", table=proposed_point, points=points)

    if not args.write:
        print("\n[미리보기] 반영하려면 --write")
        return 0
    if len(point_values) < args.min_samples:
        print(f"\n거부: 표본 {len(point_values)}건 < --min-samples {args.min_samples}. "
              "이 표본으로 덮으면 임시값을 다른 임시값으로 바꾸는 것뿐이다.")
        return 1

    anchors["families"]["possession"] = proposed_point
    if proposed_press and len(press_values) >= args.min_samples:
        anchors.setdefault("actions", {})[_PRESS_CODE] = proposed_press
    anchors["source"] = anchors.get("source", "") + f" | possession re-baked from {len(point_values)} scored dPC"
    _ANCHORS_PATH.write_text(json.dumps(anchors, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"\n반영 완료 — {_ANCHORS_PATH}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
