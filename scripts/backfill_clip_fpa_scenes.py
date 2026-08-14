#!/usr/bin/env python3
"""이미 저장된 클립 액션에서 dual 태깅 원본(highlight_clips.fpa_scenes)을 되살린다.

배경
----
클립 저장은 오랫동안 '액션' 만 남겼다. 액션은 점수를 매기고 앱으로 보내기 위한 파생형
이라, 그걸로는 dual 을 다시 열어 이어서 수정할 수가 없었다. 그래서 저장 시점에 태깅
원본을 통째로 보관하도록 고쳤는데(HighlightClip.fpa_scenes), **그 전에 저장된 클립**은
컬럼이 NULL 이라 여전히 복원이 안 된다.

이 스크립트는 남아 있는 액션에서 그 원본을 최대한 되살려 채워 넣는다.

무엇이 남아 있나 (실측)
----------------------
`highlight_clip_actions.extra` 에 태깅의 알맹이가 대부분 살아 있다:
  sceneState  = beforeDots/afterDots/passArrows/primary  ← 찍은 그림 자체
  groupIndex  = 장면 묶음                                ← 어느 행이 한 장면인지
  x, y        = 좌표 (원좌표, 공격방향 미적용)
  tags, receiver, goalMouth
액션 이름·팀·등번호·EPV·PC·xG 는 컬럼에 있다.

무엇을 되살릴 수 없나
--------------------
1. **StatInput**(원본 스탯 코드) — 저장이 안 됐다. 다만 코드→태그 규칙이 결정적이라
   (이름, 태그)에서 역산한다: Pass+Assist=zz · Pass+Key Pass=z · Pass+Success=ss ·
   Pass+Fail=s · Shot+Goal=ddd · Shot+On Target=dd · Shot+Blocked=db · Shot+Off Target=d ·
   성공/실패로 갈리는 것(크로스·드리블·돌파·듀얼)은 중복코드=성공/단일코드=실패.
   수비(aa/q/w/ww/qw)·pn·pr 등은 애초에 1:1 이다. 역산이 안 되는 행이 하나라도 있으면
   그 클립은 **건드리지 않는다** — 반쪽 복원은 다시 저장할 때 재채점을 어긋나게 한다.
2. **하프(1H/2H)와 공격방향** — 어디에도 안 남았다. 좌표는 원좌표라 방향을 못 되짚고,
   EPV 로 역산하는 건 하프라인 근처에서 갈리지 않아 조용히 좌우 반전될 위험이 있다.
   그래서 **추측하지 않고 null 로 두고** `reconstructed: true` 를 세운다. 화면이 이걸
   보고 운영자에게 방향 확인을 받는다.
3. **경기 시계(Time)** — 클립 내 구간(start_offset)에서 mm:ss 로 근사한다. 없으면 빈칸.
4. **로그 텍스트** — 화면이 첫 칸(하프)만 쓰므로 '?' 로 채운 한 줄을 만들어 준다.

⚠️ 실행 순서 — 지표 백필을 **먼저** 돌릴 것
------------------------------------------
이 스크립트는 액션의 EPV·PC·xG 를 그대로 베껴 넣는다. 그러니 산식이 바뀌어 지표
백필(예: scripts/backfill_defense_epv.py)을 돌려야 한다면 **그것을 먼저** 돌려라.
순서가 뒤집히면 복원된 태깅이 옛 지표를 들고 있다가, 운영자가 그 클립을 열어
'클립에 저장' 을 누르는 순간 옛 값이 다시 액션에 덮어써진다.

    1) scripts/backfill_defense_epv.py --apply     ← 지표를 먼저 고치고
    2) scripts/backfill_clip_fpa_scenes.py --apply ← 그 다음에 태깅을 복원한다

이미 복원한 뒤에 산식이 또 바뀌었다면, dual 팝업의 '🔄 현재 로직으로 재채점' 버튼이
그 클립의 장면 전부를 지금 로직으로 다시 계산해 준다.

멱등성
------
fpa_scenes 가 이미 있는 클립은 건너뛴다(--force 로 덮어쓰기). 클립 단위로 커밋한다.

사용법
------
    DATABASE_URL=... python3 scripts/backfill_clip_fpa_scenes.py            # 미리보기
    DATABASE_URL=... python3 scripts/backfill_clip_fpa_scenes.py --apply
    DATABASE_URL=... python3 scripts/backfill_clip_fpa_scenes.py --clip-id fpc-2-001 --apply
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "apps" / "api"))

from app.fineplay_fpa import base_action_name  # noqa: E402
from app.fpa import ACTION_CODES  # noqa: E402

SCHEMA = "fineplay.fpa.clip_scenes.v0.1"

# (기본 액션, 태그) → 스탯 코드. generate_log_entry 의 코드→태그 규칙을 그대로 뒤집은 것이다.
CODE_BY_TAG: dict[tuple[str, str], str] = {
    ("Pass", "Assist"): "zz",
    ("Pass", "Key Pass"): "z",
    ("Pass", "Success"): "ss",
    ("Pass", "Fail"): "s",
    ("Cross", "Success"): "cc",
    ("Cross", "Fail"): "c",
    ("Breakthrough", "Success"): "ee",
    ("Breakthrough", "Fail"): "e",
    ("Dribble", "Success"): "rr",
    ("Dribble", "Fail"): "r",
    ("Duel", "Success"): "bb",
    ("Duel", "Fail"): "b",
    ("Shot", "Goal"): "ddd",
    ("Shot", "On Target"): "dd",
    ("Shot", "Blocked"): "db",
    ("Shot", "Off Target"): "d",
    ("Throw-in", "Retained"): "tt",
    ("Throw-in", "Lost"): "t",
}
# 태그를 볼 필요가 없는 액션 — 이름이 코드 하나에만 대응한다.
_NAME_COUNTS = Counter(ACTION_CODES.values())
CODE_BY_NAME = {name: code for code, name in ACTION_CODES.items() if _NAME_COUNTS[name] == 1}

# 태그를 보는 순서 — 좁은 것(어시스트)부터. Success/Fail 은 마지막 갈래다.
_TAG_PRIORITY = ("Goal", "Assist", "Key Pass", "On Target", "Blocked", "Off Target",
                 "Retained", "Lost", "Success", "Fail")


def _tag_set(tags_text: Any) -> set[str]:
    return {part.strip() for part in str(tags_text or "").split(",") if part.strip()}


def stat_input_for(action_name: str, tags_text: Any) -> str | None:
    """저장된 (액션 이름, 태그) → 원본 스탯 코드. 못 정하면 None."""
    base = base_action_name(action_name)
    tags = _tag_set(tags_text)
    # 승격된 이름 자체가 결과를 말해 준다 — 옛 행은 Tags 에 Goal/Assist 가 없을 수 있다.
    if action_name == "Goal":
        tags.add("Goal")
    if action_name == "Assist":
        tags.add("Assist")
    for tag in _TAG_PRIORITY:
        if tag in tags and (base, tag) in CODE_BY_TAG:
            return CODE_BY_TAG[(base, tag)]
    return CODE_BY_NAME.get(base)


def _num_text(value: Any) -> str:
    if value in (None, ""):
        return ""
    try:
        return f"{float(value):.3f}"
    except (TypeError, ValueError):
        return ""


def _mmss(seconds: Any) -> str:
    try:
        total = int(float(seconds))
    except (TypeError, ValueError):
        return ""
    if total < 0:
        return ""
    return f"{total // 60:02d}:{total % 60:02d}"


def _row_from_action(action: Any, stat_input: str) -> dict[str, Any]:
    extra = action.extra or {}
    x, y = extra.get("x"), extra.get("y")
    return {
        "Time": _mmss(action.start_offset),
        "Team": action.team_side or "",
        "Player": action.jersey or "",
        # 저장된 이름은 승격형(Goal/Assist)이다 — 태깅 원본은 기본 이름이고 결과는 Tags 에 있다.
        "Action": base_action_name(action.action_name),
        "Receiver": str(extra.get("receiver") or ""),
        "Coord": f"Pos({x}, {y})" if x is not None and y is not None else "",
        "Tags": str(extra.get("tags") or ""),
        "GoalMouth": str(extra.get("goalMouth") or ""),
        "StatInput": stat_input,
        "xG": _num_text(action.xg),
        "xGOT": _num_text(action.xgot),
        "EPV": _num_text(action.epv),
        "PC": _num_text(action.pc),
    }


def _log_line(row: dict[str, Any]) -> str:
    """화면은 첫 칸(하프)만 이 문자열에서 읽는다. 하프를 모르므로 '?' 로 둔다."""
    coord = row["Coord"] or "Pos(?, ?)"
    return " | ".join([
        "?", row["Team"] or "?", "?", row["Time"] or "--:--",
        coord, f"{row['Player']} {row['Action']}".strip(),
    ])


def _group_key(action: Any, index: int) -> Any:
    """어느 행이 한 장면인가. groupIndex 가 정본이고, 없으면 같은 그림을 공유하는지로 본다."""
    extra = action.extra or {}
    group_index = extra.get("groupIndex")
    if group_index is not None:
        return ("g", group_index)
    scene_state = extra.get("sceneState")
    if scene_state:
        return ("s", json.dumps(scene_state, sort_keys=True, ensure_ascii=False))
    return ("i", index)


def build_scenes(actions: list[Any]) -> tuple[dict[str, Any] | None, list[str]]:
    """(fpa_scenes 페이로드, 못 고치는 이유들). 하나라도 걸리면 페이로드는 None."""
    problems: list[str] = []
    for action in actions:
        if not (action.extra or {}).get("sceneState"):
            problems.append(f"seq={action.seq} {action.action_name}: 그림(sceneState) 없음")
        if stat_input_for(action.action_name, (action.extra or {}).get("tags")) is None:
            problems.append(
                f"seq={action.seq} {action.action_name}: 스탯 코드 역산 실패 "
                f"(tags={sorted(_tag_set((action.extra or {}).get('tags'))) or '없음'})"
            )
    if problems:
        return None, problems

    grouped: dict[Any, list[Any]] = defaultdict(list)
    order: list[Any] = []
    for index, action in enumerate(actions):
        key = _group_key(action, index)
        if key not in grouped:
            order.append(key)
        grouped[key].append(action)

    scenes = []
    for key in order:
        members = grouped[key]
        state = (members[0].extra or {}).get("sceneState") or {}
        rows = []
        for action in members:
            code = stat_input_for(action.action_name, (action.extra or {}).get("tags"))
            rows.append(_row_from_action(action, code or ""))
        scenes.append({
            "rows": rows,
            "logs": [_log_line(row) for row in rows],
            "beforeDots": state.get("beforeDots") or [],
            "afterDots": state.get("afterDots") or [],
            "passArrows": state.get("passArrows") or [],
            "primary": state.get("primary"),
            "clipIndex": 1,
        })

    return {
        "schema": SCHEMA,
        # 화면이 이 표시를 보고 운영자에게 하프·공격방향 확인을 받는다.
        "reconstructed": True,
        "half": None,
        "direction": None,
        "scenes": scenes,
    }, []


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--clip-id", action="append", default=[], help="대상 클립 id (반복 지정 가능)")
    parser.add_argument("--apply", action="store_true", help="실제로 DB 에 쓴다 (기본은 미리보기)")
    parser.add_argument("--force", action="store_true", help="이미 fpa_scenes 가 있는 클립도 덮어쓴다")
    parser.add_argument("--verbose", action="store_true", help="못 고치는 이유를 전부 출력")
    args = parser.parse_args()

    from app.db import SessionLocal
    from app.models import HighlightClip, HighlightClipAction

    db = SessionLocal()
    try:
        query = db.query(HighlightClip.id)
        if args.clip_id:
            query = query.filter(HighlightClip.id.in_(args.clip_id))
        clip_ids = [row[0] for row in query.order_by(HighlightClip.id)]

        done = skipped_existing = skipped_partial = empty = 0
        for clip_id in clip_ids:
            clip = db.get(HighlightClip, clip_id)
            if clip is None:
                continue
            if clip.fpa_scenes and not args.force:
                skipped_existing += 1
                continue
            actions = (
                db.query(HighlightClipAction)
                .filter(HighlightClipAction.clip_id == clip_id)
                .order_by(HighlightClipAction.seq)
                .all()
            )
            if not actions:
                empty += 1
                continue

            payload, problems = build_scenes(actions)
            if payload is None:
                skipped_partial += 1
                print(f"[{clip_id}] 건너뜀 — 액션 {len(actions)}건 중 복원 불가 {len(problems)}건")
                for line in (problems if args.verbose else problems[:3]):
                    print(f"    ! {line}")
                if not args.verbose and len(problems) > 3:
                    print(f"    … 외 {len(problems) - 3}건")
                continue

            rows_total = sum(len(scene["rows"]) for scene in payload["scenes"])
            print(f"[{clip_id}] 장면 {len(payload['scenes'])}개 · 액션 {rows_total}건 복원")
            if args.verbose:
                for i, scene in enumerate(payload["scenes"], 1):
                    names = ", ".join(f"{r['Player']}{r['StatInput']}" for r in scene["rows"])
                    print(f"    장면 {i}: {names}  (점 {len(scene['beforeDots'])}/{len(scene['afterDots'])})")
            done += 1

            if args.apply:
                clip.fpa_scenes = payload
                db.commit()  # 클립 단위로 끊는다 — 잠금을 짧게, 중단돼도 재실행으로 이어짐

        print()
        print(f"{'반영' if args.apply else '미리보기'} — 복원 {done}건 · "
              f"이미 있음 {skipped_existing}건 · 복원 불가 {skipped_partial}건 · 액션 없음 {empty}건")
        if not args.apply and done:
            print("실제로 반영하려면 --apply 를 붙여 다시 실행하세요.")
        if done:
            print("복원된 클립은 하프·공격방향이 비어 있습니다 — dual 에서 확인 후 저장하세요.")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    raise SystemExit(main())
