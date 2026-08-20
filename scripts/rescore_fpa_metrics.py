#!/usr/bin/env python3
"""저장된 FPA 지표를 **현재 산식**으로 통째로 다시 계산한다 (범용 재채점).

배경
----
EPV·PC·xG·xRC(reception)·xPK(packing) 은 **찍는 순간** 계산돼 로그 텍스트의
`Metrics:` 에 숫자로 박힌다. 로그는 계산식이 아니라 계산 결과(영수증)라서, 산식을
고쳐 배포해도 이미 찍어둔 데이터는 옛 숫자를 그대로 들고 있다.

반면 **점수(xFP 0~100)** 는 어디에도 저장되지 않는다 — `xfp_score.score_clip_actions`
가 조회·전송할 때마다 지표에서 새로 계산한다. 그래서 앵커·백분위·가중치(xfp_score.py,
xfp_anchors_v0.json)만 고쳤다면 이 스크립트는 필요 없다. 배포만 하면 다음 조회부터
바로 반영된다. **이 스크립트가 필요한 건 지표 산식(fpa.py)을 고쳤을 때뿐이다.**

기존 백필과 뭐가 다른가
----------------------
backfill_defense_epv.py 등은 "이 산식이 이렇게 바뀌었다"는 일회성 표적 수정이다.
이 스크립트는 표적이 없다 — 저장된 좌표·프레임·액션으로 `generate_log_entry` 를
처음부터 다시 돌려 **모든 지표를 현재 코드가 내는 값으로** 덮는다. 산식이 또 바뀌어도
스크립트는 그대로 두고 배포 후 다시 돌리면 된다.

왜 로그 텍스트를 1차 소스로 쓰나
------------------------------
행(rows)은 저장 경로에 따라 두 가지 형태로 존재한다. `generate_log_entry` 가 돌려주는
log_data 형태(Time·Team·Player·Action·Receiver·Coord·Tags·DualState·지표)에는
**하프도 공격방향도 좌표 컬럼도 없고**, 로그를 파싱해 만든 형태(parse_logs_to_dataframe)
에는 Half·Direction·StartX/Y·EndX/Y 가 있다. 반면 **로그 텍스트에는 언제나 전부 있다**:

    1H | home | right | 14:23 | Pos(45.2, 30.1) | 10 Pass to 8 | Pos(78.4, 22.0)
       | Tags: Progressive | Metrics: EPV=0.031, ... | DualState: {...}
     ↑     ↑      ↑        ↑         ↑                ↑                    ↑
    half  team  direction time     dots            액션·등번호          프레임 전체

그래서 재계산 재료는 로그에서 뽑고, 행은 StatInput 을 얻는 용도와 결과를 덮어쓸
대상으로만 쓴다. 로그가 없는 행은 행 필드로 대체한다.

원본 스탯 코드
-------------
로그에 유일하게 없는 게 `10zz8` 같은 코드 표기인데 (액션 이름, 태그, 등번호)에서
결정적으로 역산된다. 행에 `StatInput` 이 있으면 그대로 쓰고, 없으면 역산한다
(엑셀로 불러온 행·옛 행은 StatInput 이 아예 없다 — 화면의 '재채점' 버튼이 그런 행을
말없이 건너뛰는 이유다). 역산까지 실패한 행은 **건드리지 않고** 보류로 보고한다.

무엇을 고치나
------------
    ① fpa_saved_logs.logs[*]       로그 텍스트의 `Metrics: ...`
    ② fpa_saved_logs.rows[*]       위 행의 파싱본 (xG/xRC/xPK/EPV/PC)
    ③ highlight_clips.fpa_scenes   scenes[*].rows / scenes[*].logs
    ④ highlight_clip_actions       xg/reception_xg/packing/epv/pc

③ 을 빠뜨리면 안 된다 — 운영자가 그 클립을 dual 로 열어 '클립에 저장' 을 누르는 순간
③ 의 옛 값이 ④ 를 통째로 덮어써서(전체 교체) 백필이 되돌아간다. 기존 지표 백필 3종이
③ 을 건드리지 않아 생긴 구멍이다.

xGOT·GoalMouth 는 손대지 않고 보존한다 — 채점이 만드는 값이 아니라 골문 클릭으로
들어오는 입력값이라 generate_log_entry 가 만들어내지 않는다. 재계산 결과에 도로 얹는다
(화면의 재채점도 같은 규칙 — page.tsx:1942).

멱등성
------
저장된 지표를 참조하지 않고 좌표·프레임에서 새로 계산해 덮으므로 몇 번을 돌려도 결과가
같다. 두 번째 실행이 "변경 0건" 이면 계산이 결정적이라는 뜻 — 가장 강한 검증이다.

운영 부담
--------
경기·클립 단위로 커밋한다. 전체를 한 트랜잭션으로 묶으면 처리한 행의 잠금이 스크립트가
끝날 때까지 유지돼 그동안 콘솔에서 같은 경기를 저장하려는 시도가 대기한다. 큰 JSONB 를
통째로 메모리에 쌓지 않도록 id 목록만 먼저 받고 한 건씩 조회한다.

사용법
------
    DATABASE_URL=... python3 scripts/rescore_fpa_metrics.py                  # 미리보기
    DATABASE_URL=... python3 scripts/rescore_fpa_metrics.py --apply
    DATABASE_URL=... python3 scripts/rescore_fpa_metrics.py --match-id <uuid> --verbose
    DATABASE_URL=... python3 scripts/rescore_fpa_metrics.py --clip-id fpc-2-001 --apply
    DATABASE_URL=... python3 scripts/rescore_fpa_metrics.py --skip-clips     # ①② 만
"""

from __future__ import annotations

import argparse
import re
import sys
from datetime import datetime
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "apps" / "api"))

from app.fpa import (  # noqa: E402
    _decode_dual_pitch_state,
    _format_metrics,
    _parse_metrics,
    _parse_path_points,
    generate_log_entry,
)

# 재계산이 만들어내는 지표. xGOT·GoalMouth 는 여기 없다 — 입력값이라 보존한다.
METRIC_KEYS = ("xG", "xRC", "xPK", "EPV", "PC")

# 행의 지표 키 → highlight_clip_actions 컬럼
METRIC_TO_COLUMN = {
    "xG": "xg",
    "xRC": "reception_xg",
    "xPK": "packing",
    "EPV": "epv",
    "PC": "pc",
}

_POS = re.compile(r"Pos\(\s*(-?[0-9.]+)\s*,\s*(-?[0-9.]+)\s*\)")
_ACTION = re.compile(r"^(\d*)\s*(.+?)(?:\s+to\s+(\d+))?$")

# 액션 이름 → (필요 태그, 스탯 코드). 앞에 오는 규칙이 우선이고, 태그가 None 이면 기본값.
# generate_log_entry 가 코드로부터 태그를 붙이는 규칙(fpa.py:1976~2001)을 그대로 뒤집은 것.
NAME_TO_CODE: dict[str, tuple[tuple[str | None, str], ...]] = {
    "Shot": (("Goal", "ddd"), ("On Target", "dd"), ("Blocked", "db"), (None, "d")),
    "Pass": (("Assist", "zz"), ("Key Pass", "z"), ("Success", "ss"), (None, "s")),
    "Cross": (("Success", "cc"), (None, "c")),
    "Breakthrough": (("Success", "ee"), (None, "e")),
    "Dribble": (("Success", "rr"), (None, "r")),
    "Duel": (("Success", "bb"), (None, "b")),
    # 승격된 이름으로 저장된 옛 행 (fineplay_fpa.canonical_action_name 이 만든 이름)
    "Goal": ((None, "ddd"),),
    "Shot On Target": ((None, "dd"),),
    "Blocked Shot": ((None, "db"),),
    "Assist": ((None, "zz"),),
    "Key Pass": ((None, "z"),),
    # 1:1 액션
    "Penetration": ((None, "pn"),),
    "Press": ((None, "pr"),),
    "Miss": ((None, "m"),),
    "Tackle": ((None, "aa"),),
    "Intercept": ((None, "q"),),
    "Clear": ((None, "w"),),
    "Cutout": ((None, "ww"),),
    "Block": ((None, "qw"),),
    "Catching": ((None, "v"),),
    "Punching": ((None, "vv"),),
    "Save": ((None, "sv"),),
    "Foul": ((None, "f"),),
    "Be Fouled": ((None, "ff"),),
    "Offside": ((None, "o"),),
    "Sprint": ((None, "st"),),
}

# 결과 태그가 붙어야 코드가 확정되는 액션 — 태그가 없으면 추측하지 않고 보류한다.
RESULT_TAGS = {"Success", "Fail", "Goal", "On Target", "Off Target", "Blocked", "Assist", "Key Pass"}

# 손으로 입력했어야만 붙는 태그 — 역산할 때 다시 실어줘야 한다.
# 자동 부여 태그(Success/Fail/Goal/On Target/Off Target/Blocked/Assist/Key Pass/
# Off-ball Run/Retained/Lost/Possession */Progressive/In-box/Out-box/Box Entry/
# Long Throw)는 generate_log_entry 가 좌표·코드에서 다시 만들므로 넣지 않는다.
# Penalty(pk)는 반드시 살려야 한다 — xG 가 좌표 무시하고 PENALTY_XG(0.75) 로 고정된다.
MANUAL_TAG_CODES: tuple[tuple[str, str], ...] = (
    ("Penalty", "pk"),
    ("Set Piece", "sp"),
    ("Header", "h"),
    ("Aerial", "r"),
    ("Foot", "f"),
    ("Weak Foot", "wf"),
    ("Counter Attack", "c"),
    ("Switch", "sw"),
    ("First Time", "ft"),
    ("Suffered", "sf"),
    ("Under Pressure", "up"),
    ("One-on-One", "oo"),
    ("High Cross", "hc"),
    ("Low Cross", "lc"),
)

# dual 에서 입력이 거부되는 액션 — generate_log_entry 가 ValueError 를 낸다.
DUAL_REJECTED = {"Acquisition", "Gain"}

# 재계산이 만들지 않지만 행에 남아 있어야 하는 키 — 클립 귀속·화면 복원용이다.
CARRY_OVER_KEYS = (
    "StatInput", "SceneIndex", "SceneActionIndex", "SceneState",
    "GoalMouth", "GoalMouthX", "GoalMouthY", "xGOT",
)


def _text(value: Any) -> str:
    return str(value if value is not None else "").strip()


def _float_or_none(value: Any) -> float | None:
    text = _text(value)
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


# ---------------------------------------------------------------- 로그 파싱


class LogView:
    """로그 한 줄에서 재채점 재료를 뽑아낸다. 로그가 없으면 행 필드로 대체한다."""

    def __init__(self, log: str, row: dict[str, Any]):
        self.parts = [p.strip() for p in _text(log).split(" | ")] if _text(log) else []
        self.row = row

    def _part(self, index: int) -> str:
        return self.parts[index] if index < len(self.parts) else ""

    def _tagged(self, prefix: str) -> str:
        for part in self.parts[4:]:
            if part.startswith(prefix):
                return part[len(prefix):].strip()
        return ""

    @property
    def half(self) -> str:
        return self._part(0) or _text(self.row.get("Half"))

    @property
    def team(self) -> str:
        return (self._part(1) or _text(self.row.get("Team"))).lower()

    @property
    def direction(self) -> str:
        return (self._part(2) or _text(self.row.get("Direction"))).lower()

    @property
    def timeline(self) -> str:
        return self._part(3) or _text(self.row.get("Time"))

    @property
    def tags(self) -> set[str]:
        text = self._tagged("Tags:") or _text(self.row.get("Tags"))
        return {part.strip() for part in text.split(",") if part.strip()}

    @property
    def dual_state(self) -> str:
        return self._tagged("DualState:") or _text(self.row.get("DualState"))

    @property
    def action(self) -> tuple[str, str, str]:
        """(등번호, 액션 이름, 받는 번호). 압박(pr)처럼 번호 없는 액션은 등번호가 빈다."""
        match = _ACTION.match(self._part(5)) if len(self.parts) > 5 else None
        if match:
            player, name, receiver = match.groups()
            return _text(player), _text(name), _text(receiver)
        return _text(self.row.get("Player")), _text(self.row.get("Action")), _text(self.row.get("Receiver"))

    def dots(self, action_name: str) -> list[dict[str, float]]:
        """원좌표 목록. 로그의 Pos(...) 는 방향 보정 전 값이라 그대로 되먹이면 된다
        (보정본 start_x_adj 는 채점 계산에만 쓰이고 로그엔 안 남는다)."""
        if action_name == "Dribble":
            path = _parse_path_points(self._tagged("Path(").rstrip(")") or self.row.get("PathPoints"))
            if path:
                return [{"meter_x": x, "meter_y": y} for x, y in path]

        if self.parts:
            found = _POS.findall(" | ".join(self.parts[4:]))
            if found:
                return [{"meter_x": float(x), "meter_y": float(y)} for x, y in found]

        start_x, start_y = _float_or_none(self.row.get("StartX")), _float_or_none(self.row.get("StartY"))
        if start_x is None or start_y is None:
            coord = _POS.search(_text(self.row.get("Coord")))
            if not coord:
                return []
            start_x, start_y = float(coord.group(1)), float(coord.group(2))
        dots = [{"meter_x": start_x, "meter_y": start_y}]
        end_x, end_y = _float_or_none(self.row.get("EndX")), _float_or_none(self.row.get("EndY"))
        if end_x is not None and end_y is not None:
            dots.append({"meter_x": end_x, "meter_y": end_y})
        return dots


# ------------------------------------------------------------ 스탯 코드 역산


def _manual_tag_suffix(tags: set[str]) -> str:
    codes = [code for name, code in MANUAL_TAG_CODES if name in tags]
    return ("." + ".".join(codes)) if codes else ""


def stat_input_from(view: LogView) -> tuple[str | None, str]:
    """원본 스탯 코드. 실패하면 (None, 사유).

    저장된 StatInput 이 있으면 그대로 쓴다(가장 정확). 없으면 (액션 이름, 태그,
    등번호)에서 역산한다 — generate_log_entry 의 코드→태그 규칙이 결정적이라 가능하다.
    """
    saved = _text(view.row.get("StatInput"))
    if saved:
        return saved, ""

    player, action, receiver = view.action
    if not action:
        return None, "액션 이름 없음"
    if action in DUAL_REJECTED:
        return None, f"dual 재채점 불가 액션({action})"

    tags = view.tags
    suffix = _manual_tag_suffix(tags)

    if action == "Touch":
        # 번호만 입력하면 Touch 로 잡힌다 (base_action_part.isdigit()).
        if not player:
            return None, "Touch 인데 등번호 없음"
        return player + suffix, ""

    if action == "Throw-in":
        # tt/tr 은 둘 다 성공. 좌표가 둘이면 two-dot 코드(tr), 하나면 tt.
        if tags & {"Success", "Retained", "Possession Retained"}:
            code = "tr" if len(view.dots(action)) >= 2 else "tt"
        else:
            code = "t"
        return f"{player}{code}{receiver}{suffix}", ""

    rules = NAME_TO_CODE.get(action)
    if not rules:
        return None, f"역산 규칙 없는 액션({action})"

    # 성공/실패로 갈리는 액션인데 결과 태그가 하나도 없으면 추측하지 않는다 —
    # 중복코드(성공)/단일코드(실패)가 EPV·PC 를 다르게 만든다.
    if len(rules) > 1 and not (tags & RESULT_TAGS):
        return None, f"결과 태그가 없어 코드 확정 불가({action})"

    code = next((c for required, c in rules if required is None or required in tags), None)
    if code is None:
        return None, f"태그로 코드를 못 가름({action})"

    return f"{player}{code}{receiver}{suffix}", ""


# -------------------------------------------------------------------- 재채점


def _preserve_inputs(new_row: dict[str, Any], new_log: str, old_row: dict[str, Any]) -> tuple[dict[str, Any], str]:
    """채점이 만들지 않는 입력값(xGOT·GoalMouth)을 재계산 결과에 도로 얹는다."""
    old_xgot = _text(old_row.get("xGOT"))
    old_goalmouth = _text(old_row.get("GoalMouth"))

    if old_xgot:
        new_row["xGOT"] = old_xgot
        parts = new_log.split(" | ")
        index = next((i for i, part in enumerate(parts) if part.startswith("Metrics: ")), -1)
        if index >= 0:
            metrics = _parse_metrics(parts[index])
            metrics["xGOT"] = old_xgot
            parts[index] = f"Metrics: {_format_metrics(metrics)}"
            new_log = " | ".join(parts)
        else:
            new_log += f" | Metrics: xGOT={old_xgot}"

    if old_goalmouth:
        new_row["GoalMouth"] = old_goalmouth
        if "GoalMouth: " not in new_log:
            # 파서가 prefix 로 분기하므로(fpa.py:1863~) 뒤에 붙여도 안전하다.
            new_log += f" | GoalMouth: {old_goalmouth}"

    return new_row, new_log


def rescore_row(row: dict[str, Any], log: str) -> tuple[dict[str, Any] | None, str | None, str]:
    """행 하나를 현재 산식으로 다시 채점. 실패하면 (None, None, 사유)."""
    view = LogView(log, row)

    if view.team not in ("home", "away"):
        return None, None, f"팀 값 이상({view.team or '없음'})"
    if view.direction not in ("left", "right"):
        # 복원된 클립은 공격방향이 null 이다 — 추측하면 EPV·PC 가 좌우로 통째로 뒤집힌다.
        return None, None, f"공격방향 없음/이상({view.direction or '없음'})"
    if not view.half or not view.timeline:
        return None, None, "하프/시간 없음"

    stat_input, reason = stat_input_from(view)
    if not stat_input:
        return None, None, reason

    _, action_name, _ = view.action
    dots = view.dots(action_name)
    if not dots:
        return None, None, "좌표 없음"

    try:
        result = generate_log_entry(
            stat_input=stat_input,
            dots=dots,
            half=view.half,
            team=view.team,
            direction=view.direction,
            timeline=view.timeline,
            dual_pitch=_decode_dual_pitch_state(view.dual_state),
        )
    except ValueError as ex:
        return None, None, f"재채점 거부: {ex}"
    except Exception as ex:  # noqa: BLE001 - 한 행 실패가 전체를 멈추면 안 된다
        return None, None, f"재채점 오류: {type(ex).__name__}: {ex}"

    new_log = _text(result.get("log_text"))
    if not new_log:
        return None, None, "재채점 결과 비어 있음"

    # 덮어쓰지 않고 **겹쳐 쓴다** — 행 형태가 두 가지라(log_data 형/로그파싱 형)
    # 통째로 갈아치우면 Half·Direction·StartX/Y 같은 필드가 사라진다. 좌표를 그대로
    # 되먹였으므로 남는 옛 필드도 여전히 유효하다.
    new_row = {**row, **(result.get("log_data") or {})}
    for key in CARRY_OVER_KEYS:
        value = _text(row.get(key))
        if value:
            new_row[key] = value

    new_row, new_log = _preserve_inputs(new_row, new_log, row)
    return new_row, new_log, ""


def _metric_diff(old_row: dict[str, Any], new_row: dict[str, Any]) -> list[str]:
    changed = []
    for key in METRIC_KEYS:
        before, after = _text(old_row.get(key)), _text(new_row.get(key))
        if before != after:
            changed.append(f"{key} {before or '—'}→{after or '—'}")
    return changed


def rescore_rows(rows: list[dict], logs: list[str]) -> tuple[list[dict], list[str], list[dict], list[dict]]:
    """행 묶음을 재채점. (새 rows, 새 logs, 바뀐 것, 보류) 를 돌려준다."""
    new_rows, new_logs = list(rows), list(logs)
    changes: list[dict] = []
    skips: list[dict] = []

    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            skips.append({"index": index, "action": "?", "reason": "행 형식 이상"})
            continue
        log = logs[index] if index < len(logs) else ""
        scored_row, scored_log, reason = rescore_row(row, log)
        if scored_row is None:
            skips.append({"index": index, "action": _text(row.get("Action")) or "?", "reason": reason})
            continue
        diff = _metric_diff(row, scored_row)
        new_rows[index] = scored_row
        if index < len(new_logs):
            new_logs[index] = scored_log
        else:
            new_logs.append(scored_log)
        if diff:
            changes.append({"index": index, "action": _text(row.get("Action")) or "?", "diff": diff})

    return new_rows, new_logs, changes, skips


# ------------------------------------------------------------------- 리포트


def _print_report(label: str, changes: list[dict], skips: list[dict], total: int, verbose: bool) -> None:
    print(f"\n[{label}] 행 {total}건 · 값 변경 {len(changes)}건 · 보류 {len(skips)}건")
    shown = changes if verbose else changes[:5]
    for item in shown:
        print(f"  - row {item['index']:>4} {item['action']:<14} {', '.join(item['diff'])}")
    if not verbose and len(changes) > len(shown):
        print(f"    … 외 {len(changes) - len(shown)}건")
    # 보류는 항상 전부 보여준다 — '조용히 빠지는' 것을 없애는 게 이 스크립트의 목적이다.
    for item in skips:
        print(f"  ! row {item['index']:>4} {item['action']:<14} ({item['reason']})")


def _write_metrics(action, row: dict[str, Any]) -> None:
    for metric_key, column in METRIC_TO_COLUMN.items():
        value = _float_or_none(row.get(metric_key))
        setattr(action, column, round(value, 4) if value is not None else None)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--match-id", action="append", default=[], help="대상 경기 UUID (반복 지정 가능)")
    parser.add_argument("--clip-id", action="append", default=[], help="대상 클립 ID (반복 지정 가능)")
    parser.add_argument("--since", help="updated_at 이 이 날짜 이후인 것만 (YYYY-MM-DD)")
    parser.add_argument("--apply", action="store_true", help="실제로 DB 에 쓴다 (기본은 미리보기)")
    parser.add_argument("--verbose", action="store_true", help="바뀐 행을 전부 출력")
    parser.add_argument("--skip-logs", action="store_true", help="fpa_saved_logs(①②) 를 건너뛴다")
    parser.add_argument("--skip-clips", action="store_true", help="클립 fpa_scenes(③④) 를 건너뛴다")
    args = parser.parse_args()

    from app.db import SessionLocal
    from app.models import FpaSavedLog, HighlightClip, HighlightClipAction

    db = SessionLocal()
    stat = {"matches": 0, "match_rows": 0, "clips": 0, "clip_rows": 0, "actions": 0, "skips": 0}

    try:
        # ---------- ①② fpa_saved_logs ----------
        if not args.skip_logs and not args.clip_id:
            query = db.query(FpaSavedLog)
            if args.match_id:
                query = query.filter(FpaSavedLog.match_id.in_(args.match_id))
            if args.since:
                query = query.filter(FpaSavedLog.updated_at >= datetime.strptime(args.since, "%Y-%m-%d"))
            match_ids = [r[0] for r in query.order_by(FpaSavedLog.updated_at).with_entities(FpaSavedLog.match_id)]

            for match_id in match_ids:
                saved = db.get(FpaSavedLog, match_id)
                if saved is None or not saved.rows:
                    continue
                rows, logs = list(saved.rows or []), list(saved.logs or [])
                new_rows, new_logs, changes, skips = rescore_rows(rows, logs)
                if not changes and not skips:
                    continue

                stat["matches"] += 1
                stat["match_rows"] += len(changes)
                stat["skips"] += len(skips)
                _print_report(f"경기 {saved.match_id}", changes, skips, len(rows), args.verbose)

                if not args.apply or not changes:
                    continue

                saved.rows = new_rows
                saved.logs = new_logs

                # 이 경로로 만들어진 액션은 fpa_match_id 가 채워져 있다(highlight_jobs.py:840).
                by_scene = {
                    (_text(r.get("SceneIndex")), _text(r.get("SceneActionIndex"))): r
                    for r in new_rows
                }
                actions = (
                    db.query(HighlightClipAction)
                    .filter(HighlightClipAction.fpa_match_id == saved.match_id)
                    .all()
                )
                for action in actions:
                    row = by_scene.get((_text(action.fpa_scene_index), _text(action.fpa_scene_action_index)))
                    if row is None:
                        continue
                    _write_metrics(action, row)
                    stat["actions"] += 1

                db.commit()  # 경기 단위로 끊는다 — 잠금 시간을 짧게, 중단돼도 재실행으로 이어짐

        # ---------- ③④ highlight_clips.fpa_scenes ----------
        if not args.skip_clips:
            query = db.query(HighlightClip).filter(HighlightClip.fpa_scenes.isnot(None))
            if args.clip_id:
                query = query.filter(HighlightClip.id.in_(args.clip_id))
            if args.match_id:
                query = query.filter(HighlightClip.match_id.in_(args.match_id))
            clip_ids = [r[0] for r in query.order_by(HighlightClip.id).with_entities(HighlightClip.id)]

            for clip_id in clip_ids:
                clip = db.get(HighlightClip, clip_id)
                if clip is None or not isinstance(clip.fpa_scenes, dict):
                    continue
                scenes = clip.fpa_scenes.get("scenes")
                if not isinstance(scenes, list) or not scenes:
                    continue

                next_scenes: list[Any] = []
                clip_changes: list[dict] = []
                clip_skips: list[dict] = []
                flat_rows: list[dict] = []
                total_rows = 0
                offset = 0

                for scene in scenes:
                    if not isinstance(scene, dict):
                        next_scenes.append(scene)
                        continue
                    rows, logs = list(scene.get("rows") or []), list(scene.get("logs") or [])
                    total_rows += len(rows)
                    new_rows, new_logs, changes, skips = rescore_rows(rows, logs)
                    # 클립 전체 기준 위치로 옮겨 리포트가 액션 seq 와 맞게 읽히도록 한다.
                    clip_changes.extend({**item, "index": item["index"] + offset} for item in changes)
                    clip_skips.extend({**item, "index": item["index"] + offset} for item in skips)
                    offset += len(rows)
                    flat_rows.extend(new_rows)
                    next_scenes.append({**scene, "rows": new_rows, "logs": new_logs})

                if not clip_changes and not clip_skips:
                    continue

                stat["clips"] += 1
                stat["clip_rows"] += len(clip_changes)
                stat["skips"] += len(clip_skips)
                _print_report(f"클립 {clip.id}", clip_changes, clip_skips, total_rows, args.verbose)

                if not args.apply or not clip_changes:
                    continue

                # JSONB 는 통째로 재대입해야 SQLAlchemy 가 변경을 감지한다.
                clip.fpa_scenes = {**clip.fpa_scenes, "scenes": next_scenes}

                # dual 저장 경로(main.py PUT .../actions)는 flat 행 순서대로 seq=1..N 을
                # 매기므로 (clip_id, seq) → flat index 로 정확히 대응된다. 그 경로는
                # fpa_match_id·fpa_scene_index 를 채우지 않아 기존 백필의 매칭 키로는
                # 이 액션들을 아예 못 찾는다.
                actions = (
                    db.query(HighlightClipAction)
                    .filter(HighlightClipAction.clip_id == clip.id)
                    .order_by(HighlightClipAction.seq)
                    .all()
                )
                for action in actions:
                    index = int(action.seq or 0) - 1
                    if 0 <= index < len(flat_rows):
                        _write_metrics(action, flat_rows[index])
                        stat["actions"] += 1

                db.commit()  # 클립 단위로 끊는다

        if args.apply:
            print(
                f"\n반영 완료 — 경기 {stat['matches']}건(행 {stat['match_rows']}) · "
                f"클립 {stat['clips']}건(행 {stat['clip_rows']}) · "
                f"클립 액션 {stat['actions']}건 · 보류 {stat['skips']}건"
            )
            print("멱등 확인: 같은 명령을 한 번 더 돌려 '변경 0건' 이 나오는지 보세요.")
        else:
            print(
                f"\n[미리보기] 경기 {stat['matches']}건(행 {stat['match_rows']}) · "
                f"클립 {stat['clips']}건(행 {stat['clip_rows']}) · 보류 {stat['skips']}건"
            )
            print("실제로 반영하려면 --apply 를 붙여 다시 실행하세요.")
        return 0
    finally:
        db.close()


if __name__ == "__main__":
    sys.exit(main())
