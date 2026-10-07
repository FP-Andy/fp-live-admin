"""FPA sceneState를 공통 sceneData로 변환하고 콘솔 화면 그대로 MP4를 만든다.

피치·선수·공·글꼴·모션은 웹 SceneMotionView 하나가 렌더한다.
Python은 장면 데이터, 버전별 객체 키와 캐시·업로드만 담당한다.
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import tempfile
import threading
from pathlib import Path
from typing import Any

from .scene_motion_renderer import SCENE_RENDER_VERSION, render_scene_data

_SCENE_RENDER_LOCK = threading.Lock()

FIELD_W = 105.0
FIELD_H = 68.0


def _parse_dots(value: Any) -> list[dict[str, Any]]:
    dots: list[dict[str, Any]] = []
    if not isinstance(value, list):
        return dots
    for item in value:
        if not isinstance(item, dict):
            continue
        # 잔상(ghost) — dual 태깅 화면이 라인업을 미리 깔아둔 '아직 활성화 안 한' 자리.
        # 콘솔이 저장 전에 걷어내지만, 옛 초안이나 다른 클라이언트가 실어 보낼 수 있어
        # 여기서도 막는다. 실제로 그 자리에 없던 선수가 씬모션에 나오면 안 된다.
        if item.get("ghost") is True:
            continue
        try:
            x = float(item.get("meter_x", item.get("x")))
            y = float(item.get("meter_y", item.get("y")))
        except (TypeError, ValueError):
            continue
        if not (math.isfinite(x) and math.isfinite(y)):
            continue
        dots.append({
            "id": str(item.get("id") or "") or None,
            "x": min(max(x, 0.0), FIELD_W),
            "y": min(max(y, 0.0), FIELD_H),
            "team": str(item.get("team") or "").strip().lower() or None,
            "teamSide": str(item.get("teamSide") or "").strip().lower() or None,
            "role": str(item.get("role") or "").strip().lower() or None,
            "number": str(item.get("number") or "").strip() or None,
        })
    return dots


# dual 에서 **볼 경로**를 화살표로 그리는 액션 코드.
#   수비(aa/q/ww/qw/w) — 상대 볼 경로(start=상대 볼 출발점, end=끊은/클리어한 지점)
#   경합(b/bb)        — 볼이 온 경로(start=볼이 온 곳, end=경합 지점)
# 셋 다 '아군이 의도한 패스' 가 아니라 공이 실제로 지나온 길이라 패스와 다른 색을 준다.
_DEFENSE_ARROW_CODES = {"aa", "q", "ww", "qw", "w", "b", "bb"}
# 실패 패스/크로스 입력 코드(단자 = 실패) — 빨간 화살표로 구분, 공은 실패 지점까지 이동.
_FAIL_ARROW_CODES = {"s", "c"}
# 화살표의 code 는 전체 스탯 입력("10s8"·"5aa.up")이다 — 프론트 statInputActionCode 와
# 같은 규칙으로 액션 코드만 추출한다 (앞 등번호·뒤 수신 번호·태그(.) 제거).
_STAT_CODE_RE = re.compile(r"^\d*([a-z]+)\d*$")


def _arrow_action_code(stat_input: Any) -> str:
    base = str(stat_input or "").strip().split(".", 1)[0].lower()
    m = _STAT_CODE_RE.match(base)
    return m.group(1) if m else ""


def _parse_arrows(value: Any) -> list[dict[str, Any]]:
    """SceneState.passArrows — 라이브 캔버스 논리좌표(1050x680, y반전)를 미터로 변환.

    같은 패스가 before/after 캔버스에 한 번씩 기록되므로 하나만 남긴다. 짝 키는
    **rowIndex**(미러 복사본이 공유하는 값)다 — 좌표로 맞추면 한쪽 캔버스에서만
    궤적을 고친 화살표가 서로 다른 값이 되어 중복 제거를 빠져나가고, 공이 옛 경로와
    새 경로를 잇달아 두 번 지나간다(그 사이는 _chain_path 가 직선으로 이어 되돌아온다).
    rowIndex 가 없는 구버전 기록은 종전대로 좌표로 맞춘다.

    양쪽이 갈렸을 때는 **before 쪽을 정본으로** 삼는다 — 미러가 before→after 방향이라
    before 가 원본 캔버스다.

    화살표의 code(어떤 액션으로 그렸는지)로 수비(상대 볼 경로) 여부를 판별해 넘긴다.
    """
    arrows: list[dict[str, Any]] = []
    index_by_key: dict[Any, int] = {}
    side_by_key: dict[Any, str] = {}
    if not isinstance(value, list):
        return arrows
    for item in value:
        if not isinstance(item, dict):
            continue
        try:
            x1, y1 = float(item["x1"]), float(item["y1"])
            x2, y2 = float(item["x2"]), float(item["y2"])
        except (KeyError, TypeError, ValueError):
            continue
        if not all(math.isfinite(v) for v in (x1, y1, x2, y2)):
            continue
        row_index = item.get("rowIndex")
        key: Any = ("row", row_index) if row_index is not None else (round(x1), round(y1), round(x2), round(y2))
        side = str(item.get("side") or "").lower()
        code_l = _arrow_action_code(item.get("code"))
        kind = (
            "defense" if code_l in _DEFENSE_ARROW_CODES
            else "fail" if code_l in _FAIL_ARROW_CODES
            else "pass"
        )
        arrow = {
            "kind": kind,
            "x1": x1 / 1050 * FIELD_W, "y1": (1 - y1 / 680) * FIELD_H,
            "x2": x2 / 1050 * FIELD_W, "y2": (1 - y2 / 680) * FIELD_H,
        }
        if key in index_by_key:
            # 이미 담은 짝이 before 가 아니고 이번 게 before 면 정본으로 교체한다.
            # 순서(체인 순번)는 처음 자리를 유지해야 공 경로가 어긋나지 않는다.
            if side == "before" and side_by_key.get(key) != "before":
                arrows[index_by_key[key]] = arrow
                side_by_key[key] = side
            continue
        index_by_key[key] = len(arrows)
        side_by_key[key] = side
        arrows.append(arrow)
    return arrows


# 걷어낸 공이 터치라인 밖으로 나가는 꼬리를 붙일 최소 거리(m).
# 이미 라인에 붙어 찍은 클리어는 꼬리가 1픽셀짜리라 붙여도 안 보이고,
# 마지막 프레임에서 공만 살짝 튀어 보인다.
CLEAR_EXIT_MIN_M = 1.5

# 공의 출구 좌표만 계산한다. 모션 구간과 타이밍은 화면·MP4 공통의
# SceneMotionView가 담당하므로 서버에서 별도로 그리거나 시간을 분배하지 않는다.


def _clear_exit_point(x: float, y: float) -> tuple[float, float] | None:
    """걷어낸 지점 → **가장 가까운 터치라인** 위의 지점. 너무 가까우면 None.

    공격방향을 안 봐도 되는 게 이 규칙의 장점이다 — y 하나로 결정되므로 방향
    정보가 없는 장면(옛 기록에서 복원한 클립 등)에서도 똑같이 동작한다.
    라인 **위**에서 끝낸다(밖으로 더 보내지 않는다) — 핸드오프 좌표계가 0~68 이라
    범위를 넘기면 앱·mp4 가 서로 다르게 자를 수 있다.
    """
    near_y = 0.0 if y <= FIELD_H / 2 else FIELD_H
    if abs(near_y - y) < CLEAR_EXIT_MIN_M:
        return None
    return (x, near_y)


def _clear_exit_target(path: list[tuple[float, float]]) -> tuple[float, float] | None:
    """공 경로 끝에서 가장 가까운 터치라인 밖 지점 (클리어 전용). 없으면 None.

    클리어는 화살표가 '상대 볼 출발점 → 끊은 지점' 이라 공이 걷어낸 자리에서 그냥
    멈춘다 — 보는 쪽에선 치워냈다는 느낌이 전혀 안 난다. 그래서 끝점에서 가장 가까운
    터치라인까지 한 구간을 더 굴린다.

    **경로에 이어 붙이지 않고 따로 돌려준다.** 이어 붙이면 공이 그 길이까지 포함해
    시간을 나눠 쓰는 바람에 걷어낸 지점을 수비수보다 **먼저** 지나간다(CLEAR_EXIT_SEC
    주석). 호출부가 별도 구간으로 재생한다.

    **그려진 화살표도 건드리지 않는다.** 이 꼬리는 태깅된 경로가 아니라 연출이라,
    측정된 선처럼 보이면 안 된다(공만 지나간다). 채점에도 안 들어간다 — 렌더 전용이다.

    꼬리를 짧게 자르는 안은 검토 후 채택하지 않았다 — CLEAR_EXIT_MIN_M 위 주석 참조.
    """
    if not path:
        return None
    return _clear_exit_point(path[-1][0], path[-1][1])


def _chain_path(arrows: list[dict]) -> list[tuple[float, float]]:
    """화살표 체인 → 공이 지나갈 **연속** 경로.

    각 화살표는 자기 시작점에서 출발한다. 앞 화살표의 끝과 다음 화살표의 시작이
    떨어져 있으면(인터셉트처럼 흐름이 끊기는 장면) 그 사이를 **직선 구간으로 이어**
    공이 계속 굴러가게 한다.

    이 규칙을 안 지키면 두 가지로 깨진다:
    - 화살표를 각각 독립 재생 → 공이 순간이동해 "두 번 나간다"(구 mp4 렌더)
    - 시작점을 버리고 끝점만 연결 → 모서리를 잘라 화살표와 어긋난다(구 sceneData)

    mp4 와 sceneData 가 이 함수를 공유해야 콘솔 검수 화면과 앱 화면이 일치한다.
    """
    return _chain_spans(arrows)[0]


def _chain_spans(
    arrows: list[dict],
) -> tuple[list[tuple[float, float]], list[tuple[float, float]]]:
    """[_chain_path] + 화살표별 (경로 시작 거리, 길이).

    spans[i] 는 화살표 i 가 전체 경로에서 차지하는 구간이다. 끊긴 곳에 삽입된
    직선 구간의 길이도 누적에 포함되므로, 이 값으로 그리면 **화살표가 드러나는
    속도가 공의 진행과 정확히 맞는다.**
    """
    path: list[tuple[float, float]] = []
    spans: list[tuple[float, float]] = []
    travelled = 0.0
    for ar in arrows:
        start = (float(ar["x1"]), float(ar["y1"]))
        end = (float(ar["x2"]), float(ar["y2"]))
        if not path:
            path.append(start)
        else:
            gap = math.hypot(path[-1][0] - start[0], path[-1][1] - start[1])
            if gap > 1e-6:
                path.append(start)  # 끊긴 구간 — 직선으로 잇는다
                travelled += gap
        length = math.hypot(end[0] - start[0], end[1] - start[1])
        spans.append((travelled, length))
        travelled += length
        path.append(end)
    return path, spans


def _pair_dots(before: list[dict], after: list[dict]) -> list[tuple[dict, dict]]:
    """replay 룸과 같은 매칭: id → number+teamSide → number → index. 미매칭 after 는 제자리."""
    used: set[int] = set()
    pairs: list[tuple[dict, dict]] = []
    for i, b in enumerate(before):
        candidates = [
            lambda d, _j: b["id"] and d["id"] == b["id"],
            lambda d, _j: b["number"] and d["number"] == b["number"] and d["teamSide"] == b["teamSide"],
            lambda d, _j: b["number"] and d["number"] == b["number"],
            lambda _d, j: j == i,
        ]
        target = b
        for pred in candidates:
            found = next((j for j, d in enumerate(after) if j not in used and pred(d, j)), None)
            if found is not None:
                used.add(found)
                target = after[found]
                break
        pairs.append((b, target))
    for j, d in enumerate(after):
        if j not in used:
            pairs.append((d, d))
    return pairs


def _find_actor_pair(
    pairs: list[tuple[dict, dict]],
    jersey: str | None,
    side: str | None,
) -> tuple[dict, dict] | None:
    """행위자 점 찾기 — 등번호+사이드 일치 우선, 다음 등번호만 일치."""
    number = str(jersey or "").strip()
    if not number:
        return None
    side = str(side or "").strip().lower() or None
    matches = [
        (b, a) for b, a in pairs
        if (b["number"] or a["number"]) == number
    ]
    if not matches:
        return None
    if side:
        for b, a in matches:
            if (b["teamSide"] or a["teamSide"]) == side:
                return (b, a)
    return matches[0]


def _goal_mouth_xy(value: Any) -> tuple[float, float] | None:
    """extra.goalMouth("gx,gy,방향") → (gx, gy). 인셋 표시용."""
    parts = str(value or "").strip().split(",")
    try:
        return (float(parts[0]), float(parts[1]))
    except (ValueError, IndexError):
        return None


# 골키퍼 액션 — 골대·궤적이 **반대편**이다 (2026-09-07).
#
# goalMouth 문자열에 실리는 방향은 태깅 팀(우리)의 공격방향이다. 슛이면 그 방향 끝의
# 골대가 맞지만, **세이브는 상대가 우리 골대로 쏜 것**이라 반대편 골대다. 그대로 두면
# 오른쪽 공격일 때 골대 패널이 왼쪽(상대 골대 쪽)에 뜨고 공도 그쪽으로 날아간다 —
# 실제로는 우리 골대가 왼쪽이니 패널은 오른쪽(빈 하프)에 떠야 하고 공은 왼쪽으로 가야 한다.
#
# gx(골 폭 안의 좌우)도 같이 미러된다. gx 는 **슈터 시점** 기준인데, 상대 슈터는 우리와
# 반대 방향을 보고 있기 때문이다.
GK_MIRROR_ACTIONS = {"Save", "Catching", "Punching"}

# 세이브 연출 — 슛과 같은 아크만 그리면 **공이 골대로 들어간 그림**이라 막은 건지
# 먹힌 건지 구분이 안 된다(2026-09-14). 닿는 지점에 장갑을 세우고 공을 거기서 막는다.
#
# **세이브(Save)만 해당한다.** 캐칭·펀칭은 골문 좌표(goalMouth)를 받지 않아 패널 자체가
# 안 뜬다 — 점수가 '시작점 위협 × 회수계수' 라 골대 UI 로 가지 않는 설계다
# (live/page.tsx 의 GK_CLAIM_ARROW_CODES 주석). 그 둘은 피치 위 화살표로만 보인다.
GK_SAVE_ACTION = "Save"

# 막은 뒤의 처리 — 태그로 갈린다(fpa.SAVE_TAG_CODES: sv.c / sv.p).
#
#   catch  잡았다 — 공이 장갑에 붙어 멈춘다. 소유권까지 가져왔다는 그림이다
#   punch  쳐냈다 — 골대 밖으로 튕겨 나간다
#   (없음) 옛 기록 — 어느 쪽인지 모른다. 쳐내기로 그린다(막았다까지만 말한다)
GK_SAVE_CATCH_TAG = "Catch"
GK_SAVE_PUNCH_TAG = "Punch"

def _mirror_goal_mouth(value: Any) -> Any:
    """goalMouth 문자열의 방향만 뒤집는다 — 골키퍼 액션용(GK_MIRROR_ACTIONS 주석)."""
    text = str(value or "").strip()
    if not text:
        return value
    parts = text.split(",")
    if len(parts) < 3:
        # 방향이 없으면 기본이 right 로 읽히므로(아래) 명시적으로 left 를 붙인다.
        return ",".join([*parts, "left"]) if len(parts) == 2 else value
    parts[2] = "right" if parts[2].strip().lower() == "left" else "left"
    return ",".join(parts)


def _shot_target_from_goal_mouth(value: Any) -> tuple[float, float] | None:
    """extra.goalMouth("gx,gy,공격방향") → 골라인 위 미터 좌표.

    gx(0~1)는 골 폭 7.32m(피치 y 30.34~37.66m)에 투영한다. 높이(gy)는 탑다운에서 생략.
    공격방향 right = x=105 골대, left = x=0 골대(좌우 미러).

    골키퍼 액션은 호출부에서 `_mirror_goal_mouth` 로 방향을 뒤집어 넘긴다.
    """
    text = str(value or "").strip()
    if not text:
        return None
    parts = text.split(",")
    try:
        gx = min(max(float(parts[0]), 0.0), 1.0)
    except (ValueError, IndexError):
        return None
    direction = parts[2].strip().lower() if len(parts) > 2 else "right"
    # gx 는 슈터 시점(골대 정면) 왼쪽 포스트=0. 탑다운은 y 가 클수록 화면 위이므로,
    # 오른쪽 공격(+x)을 보는 슈터의 왼쪽 = 화면 위(y=37.66) → gx 증가 = y 감소.
    # 왼쪽 공격은 시선이 반대라 미러.
    if direction == "left":
        return (0.0, 30.34 + gx * 7.32)
    return (FIELD_W, 37.66 - gx * 7.32)


def _to_handoff(x: float, y: float) -> tuple[float, float]:
    """미터(105×68, y↑) → 앱 씬모션 핸드오프 좌표계(x 0~100 · y 0~68, y↑)."""
    return (round(x / FIELD_W * 100.0, 2), round(y, 2))


def build_scene_data(
    scene_state: dict[str, Any],
    *,
    actor_jersey: str | None = None,
    actor_side: str | None = None,
    goal_mouth_text: Any = None,
    caption: str | None = None,
    movers: list[dict[str, Any]] | None = None,
    clear_exit: bool = False,
    is_save: bool = False,
    save_caught: bool = False,
) -> dict[str, Any] | None:
    """SceneState → 앱 네이티브 씬모션(씬모션ui_handoff scene_view.dart)용 좌표 데이터.

    mp4(sceneMotionKey)와 병행 전송 — 앱은 sceneData 가 있으면 네이티브 렌더, 없으면 mp4.
    players: before(x,y)→after(toX,toY) 이동, passes: kind pass(성공 톤)/defense(상대 볼
    경로 = 핸드오프 실패-빨강), ball.path: mp4 와 같은 규칙의 공 경로(화살표 체인→슛 지점).
    """
    before = _parse_dots(scene_state.get("beforeDots") or scene_state.get("before"))
    after = _parse_dots(scene_state.get("afterDots") or scene_state.get("after"))
    if not before and not after:
        return None
    pairs = _pair_dots(before, after)
    arrows = _parse_arrows(scene_state.get("passArrows"))

    players: list[dict[str, Any]] = []
    for b, a in pairs:
        side = b["teamSide"] or a["teamSide"]
        if side is None:
            side = "home" if (b["team"] or a["team"]) != "opponent" else "away"
        fx, fy = _to_handoff(b["x"], b["y"])
        tx, ty = _to_handoff(a["x"], a["y"])
        entry: dict[str, Any] = {"team": side, "x": fx, "y": fy, "toX": tx, "toY": ty}
        number = b["number"] or a["number"]
        if number:
            entry["number"] = number
        if (b["role"] or a["role"]) == "gk":
            entry["gk"] = True
        players.append(entry)

    passes = []
    for ar in arrows:
        x1, y1 = _to_handoff(ar["x1"], ar["y1"])
        x2, y2 = _to_handoff(ar["x2"], ar["y2"])
        passes.append({"kind": ar.get("kind") or "pass", "x1": x1, "y1": y1, "x2": x2, "y2": y2})

    # 공 경로 — mp4 렌더와 같은 규칙: 화살표 체인 → (없으면) 행위자 이동 → 슛이면 골라인 지점 추가.
    actor_pair = _find_actor_pair(pairs, actor_jersey, actor_side)
    # 공은 패스 화살표 체인을 따른다 — 수비(상대 볼 경로)는 그 장면에 패스가 없을 때만 사용.
    path_m: list[tuple[float, float]] = []
    if arrows:
        # mp4 렌더와 같은 규칙 — 수비 화살표도 포함하고, 끊긴 사이는 직선으로 잇는다.
        path_m = _chain_path(arrows)
    elif actor_pair is not None:
        b, a = actor_pair
        if math.hypot(a["x"] - b["x"], a["y"] - b["y"]) > 0.8:
            path_m = [(b["x"], b["y"]), (a["x"], a["y"])]
    shot_target = _shot_target_from_goal_mouth(goal_mouth_text)
    if shot_target is not None:
        if not path_m:
            if actor_pair is not None:
                path_m = [(actor_pair[1]["x"], actor_pair[1]["y"])]
            else:
                path_m = [(FIELD_W / 2, FIELD_H / 2)]
        path_m.append(shot_target)
    exit_m: tuple[float, float] | None = None
    if shot_target is None and clear_exit:
        # 클리어 — 걷어낸 자리에서 가장 가까운 터치라인까지 공만 더 굴린다.
        # **path 에 붙이지 않는다**: 붙이면 공이 그 길이까지 시간을 나눠 써서
        # 걷어낸 지점을 수비수보다 먼저 지나간다(CLEAR_EXIT_SEC 주석).
        # 화면과 MP4가 이 sceneData를 함께 사용한다.
        exit_m = _clear_exit_target(path_m)

    # 이동 셰브론(핸드오프 arrow_move_*) — 드리블/돌파=공 있는 이동, 침투=공 없는 이동.
    # 행위자 점의 before→after 이동 방향으로 회전, 위치는 이동 경로 중점.
    moves: list[dict[str, Any]] = []
    for mv in movers or []:
        pair = _find_actor_pair(pairs, str(mv.get("jersey") or "") or None, mv.get("side"))
        if pair is None:
            continue
        b, a = pair
        dx, dy = a["x"] - b["x"], a["y"] - b["y"]
        if math.hypot(dx, dy) <= 0.8:
            continue
        mx, my = _to_handoff((b["x"] + a["x"]) / 2, (b["y"] + a["y"]) / 2)
        # 핸드오프 각도: 0=오른쪽, 시계방향 + (화면 좌표) — y↑ 좌표라 부호 반전.
        deg = math.degrees(math.atan2(-dy, dx))
        moves.append({"type": mv["type"], "x": mx, "y": my, "deg": round(deg, 1)})

    data: dict[str, Any] = {"v": 1, "players": players}
    # 우리 팀(헥사곤+등번호) = 이 장면을 태깅할 때 선택한 팀 — 홈 고정이 아니다.
    if actor_side in ("home", "away"):
        data["ours"] = actor_side
    if passes:
        data["passes"] = passes
    if moves:
        data["moves"] = moves
    if path_m:
        ball: dict[str, Any] = {
            "path": [{"x": px, "y": py} for px, py in (_to_handoff(x, y) for x, y in path_m)]
        }
        if exit_m is not None:
            # 클리어 전용 — 이동 구간이 끝난 **뒤에** 공만 여기로 굴러 나간다.
            # path 와 별개라, 이 필드를 모르는 옛 앱은 걷어낸 자리에서 멈출 뿐
            # 타이밍이 어긋나지는 않는다.
            ex, ey = _to_handoff(*exit_m)
            ball["exit"] = {"x": ex, "y": ey}
        data["ball"] = ball
    gm = _goal_mouth_xy(goal_mouth_text)
    if gm is not None:
        shot_info: dict[str, Any] = {"gx": gm[0], "gy": gm[1]}
        if shot_target is not None:
            # 앱 정면 골대 패널용 — 공격 방향(패널은 반대편 하프)과 아크 출발 방향(3단계).
            direction = "left" if shot_target[0] == 0.0 else "right"
            shot_info["dir"] = direction
            if len(path_m) >= 2:
                origin_y = path_m[-2][1]
                sgx = (origin_y - 30.34) / 7.32 if direction == "left" else (37.66 - origin_y) / 7.32
                shot_info["start"] = "left" if sgx < 0.35 else ("right" if sgx > 0.65 else "center")
        if is_save:
            # 골키퍼가 막는 장면 — 아크 끝에 장갑을 세운다(GK_SAVE_ACTION 주석).
            # 값이 'catch' 면 공이 장갑에 붙어 멈추고, 'punch' 면 골대 밖으로 쳐낸다.
            # 이 키가 없으면 종전대로 슛이다.
            shot_info["save"] = "catch" if save_caught else "punch"
        data["shot"] = shot_info
    if caption:
        data["caption"] = caption
    return data


# 장면 그룹핑용 경계 센티널 — sceneState 없는 행을 만나면 그룹을 끊는다.
_GROUP_BOUNDARY = object()


def _row_has_tag(row: dict[str, Any], tag: str) -> bool:
    """액션 행에 이 태그가 있나. 태그가 실리는 자리가 경로마다 다르다 —
    dual 행은 "Tags", 전송 페이로드는 extra.tags, 옛 코드는 최상위 "tags".
    (xfp_score._has_tag 와 같은 규칙)
    """
    extra = row.get("extra")
    for raw in (
        row.get("tags"),
        row.get("Tags"),
        extra.get("tags") if isinstance(extra, dict) else None,
    ):
        if raw is None:
            continue
        if isinstance(raw, (list, tuple, set)):
            if tag in {str(t).strip() for t in raw}:
                return True
        elif tag in {part.strip() for part in str(raw).split(",") if part.strip()}:
            return True
    return False


def scene_motion_stamp(scene_data: Any) -> str:
    """그 장면 좌표의 지문. 좌표가 바뀌면 값이 바뀐다.

    키에 섞어 **옛 mp4 가 새 좌표에 딸려오지 않게** 한다. 예전에는 키가 (클립, seq)
    뿐이라, 좌표를 고쳐도 같은 키를 가리켜 **고치기 전 모션이 그대로 나왔다.**
    (뒤에서 덮어쓰기는 했지만, 그 화면에는 이미 옛 링크가 나간 뒤였다.)
    """
    if scene_data is None:
        return ""
    try:
        canonical = json.dumps(scene_data, sort_keys=True, separators=(",", ":"),
                               ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        canonical = repr(scene_data)
    return hashlib.sha1(canonical.encode("utf-8")).hexdigest()[:10]


def scene_motion_key(prefix: str, clip_key: str, seq: Any, scene_data: Any = None) -> str:
    """장면 모션 mp4 의 S3 키.

    렌더(attach_scene_motions)와 조회(검수 화면)가 **같은 값**을 만들어야 해서 함수로
    둔다 — 한쪽만 고치면 이미 올라간 mp4 를 못 찾고 매번 다시 렌더한다.

    좌표 지문이 뒤에 붙는다. 좌표를 고치면 키가 달라져 옛 mp4 를 가리키지 않는다.
    렌더러 버전도 경로에 넣어 구형 그림으로 만든 MP4와 섞이지 않게 한다.
    """
    stamp = scene_motion_stamp(scene_data)
    tail = f"-{stamp}" if stamp else ""
    return f"{prefix.rstrip('/')}/scene-motion/{SCENE_RENDER_VERSION}/{clip_key}-a{seq}{tail}.mp4"


def attach_scene_motions(
    db_actions: list[dict[str, Any]],
    payload_actions: list[dict[str, Any]] | None,
    *,
    clip_key: str,
    storage: Any,
    prefix: str,
) -> list[str]:
    """장면(태깅 단위)당 모션 mp4 를 1개 렌더·업로드하고 대표 액션에 sceneMotionKey 를 단다.

    같은 장면의 행들은 동일한 sceneState 를 공유하므로 행마다 렌더하면 같은 모션이
    중복된다. 그룹(groupIndex, 없으면 연속 동일 sceneState)당 대표 행 하나에만 붙인다.
    대표 행: 골대 클릭 보유(슛 — 궤적 유지) > 그룹 주 액션(isGroupMain) > 첫 행.

    db_actions: extra 를 포함한 상세 액션(렌더 소스). 여기에 sceneMotionKey 도 세팅된다.
    payload_actions: teamView.actions 처럼 extra 가 빠진 병렬 목록(있으면 seq 로 매칭해 세팅).
    반환: 실패/경고 메시지 목록 (실패해도 예외는 던지지 않는다 — 전송은 계속).
    """
    warnings: list[str] = []
    storage_ok = storage is not None and getattr(storage, "configured", False)
    by_seq = {a.get("seq"): a for a in (payload_actions or [])}

    groups: list[list[dict[str, Any]]] = []
    prev_key: Any = _GROUP_BOUNDARY
    for action in db_actions:
        extra = action.get("extra") or {}
        state = extra.get("sceneState")
        if not isinstance(state, dict):
            prev_key = _GROUP_BOUNDARY  # 장면 경계 리셋
            continue
        gkey = extra.get("groupIndex") if extra.get("groupIndex") is not None else state
        if prev_key is _GROUP_BOUNDARY or gkey != prev_key:
            groups.append([])
        groups[-1].append(action)
        prev_key = gkey

    for members in groups:
        rep = next((a for a in members if (a.get("extra") or {}).get("goalMouth")), None)
        if rep is None:
            rep = next((a for a in members if (a.get("extra") or {}).get("isGroupMain")), members[0])
        # 골 장면이면 자막으로 명시 — 득점자 등번호까지.
        goal_member = next((a for a in members if str(a.get("action") or "") == "Goal"), None)
        caption = None
        if goal_member is not None:
            jersey = str(goal_member.get("jersey") or "").strip()
            caption = f"골! #{jersey}" if jersey else "골!"
        extra = rep.get("extra") or {}
        state = extra.get("sceneState")
        seq = rep.get("seq")
        target = by_seq.get(seq)
        # 이동 셰브론 대상 — 그룹 안 드리블/돌파(공 O)·침투(공 X) 행위자들.
        movers = []
        for member in members:
            name = str(member.get("action") or "")
            mtype = (
                "dribble" if name in ("Dribble", "Breakthrough")
                else "penetrate" if name == "Penetration"
                else None
            )
            if mtype and member.get("jersey"):
                movers.append({
                    "jersey": str(member["jersey"]),
                    "side": str(member.get("teamSide") or "") or None,
                    "type": mtype,
                })
        # 클리어 연출 — 걷어낸 자리에서 공이 터치라인 밖으로 나가게 꼬리를 붙인다.
        # 그룹 안에 클리어가 있으면 그 장면의 끝은 '치워냈다' 이므로 대표 행이
        # 무엇이든 붙인다. 슛이 같이 있으면 붙이지 않는다(끝이 슛이다 — 각 함수가 판단).
        clear_exit = any(str(m.get("action") or "") == "Clear" for m in members)
        # 골키퍼 액션이면 골대·궤적이 반대편이다 — GK_MIRROR_ACTIONS 주석 참조.
        # 대표 행(goalMouth 를 들고 있는 행) 기준으로 판단한다.
        goal_mouth_text = extra.get("goalMouth")
        rep_action = str(rep.get("action") or "")
        if rep_action in GK_MIRROR_ACTIONS:
            goal_mouth_text = _mirror_goal_mouth(goal_mouth_text)
        # **대표 행이 세이브일 때만.** goalMouth 를 들고 있는 행이 곧 골대 패널의
        # 주인이라, 같은 장면에 찍힌 상대 슛까지 세이브로 그리면 안 된다.
        is_save = rep_action == GK_SAVE_ACTION
        # 마무리는 태그로 갈린다(sv.c / sv.p). 옛 기록은 태그가 없어 쳐내기로 그린다.
        save_caught = is_save and _row_has_tag(rep, GK_SAVE_CATCH_TAG)
        # 앱 네이티브 씬모션용 좌표 데이터 — 스토리지·렌더와 무관하게 항상 싣는다.
        # (앱은 sceneData 우선, 없으면 sceneMotionKey mp4 폴백)
        data = build_scene_data(
            state,
            actor_jersey=str(rep.get("jersey") or "") or None,
            actor_side=str(rep.get("teamSide") or "") or None,
            goal_mouth_text=goal_mouth_text,
            caption=caption,
            movers=movers,
            clear_exit=clear_exit,
            is_save=is_save,
            save_caught=save_caught,
        )
        if data:
            rep["sceneData"] = data
            if target is not None:
                target["sceneData"] = data
        if not storage_ok:
            continue
        # 좌표 지문을 섞는다 — 조회 쪽(main.py)도 같은 sceneData 로 같은 키를 만든다.
        key = scene_motion_key(prefix, clip_key, seq, rep.get("sceneData"))
        try:
            # Serialise expensive captures and recheck after waiting: repeated
            # clip refreshes reuse the current MP4 instead of re-rendering it.
            with _SCENE_RENDER_LOCK:
                if not storage.exists(key):
                    if not data:
                        continue
                    with tempfile.TemporaryDirectory() as tmp:
                        out = Path(tmp) / "motion.mp4"
                        render_scene_data(data, out)
                        storage.upload(out, key, content_type="video/mp4")
            rep["sceneMotionKey"] = key
            if target is not None:
                target["sceneMotionKey"] = key
        except Exception as exc:  # 렌더/업로드 실패는 전송을 막지 않는다
            warnings.append(f"scene-motion {clip_key}-a{seq}: {exc}")
    return warnings
