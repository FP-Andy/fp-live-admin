"""FPA 장면 모션(before→after) 서버 렌더 — 클립 액션별 mp4 생성.

SceneState(fineplay.fpa.scene_state.v0.1: beforeDots/afterDots)를 받아
105x68 피치 위 점 이동 애니메이션 프레임을 그리고 ffmpeg 로 mp4(yuv420p)를 만든다.
결과는 S3 에 올라가 앱 클립 상세 '장면 변화' 섹션에서 무음 루프로 재생된다.

전/후 점 매칭 규칙은 /admin/fpa/replay 와 동일: id → 등번호+teamSide → 등번호 → index.
"""

from __future__ import annotations

import math
import subprocess
import tempfile
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont

FIELD_W = 105.0
FIELD_H = 68.0

# 콘솔 /admin/fpa/replay 뷰와 동일 사양 — 캔버스 1050x680(=fpa-field.png 원본 크기),
# 홈=주황/어웨이=파랑 점 22px, 시안 화살표 4px, 3s ease-out 이동.
OUT_W = 1050
OUT_H = 680
# 골대(골라인 바깥)를 그릴 여백 — 피치를 안쪽으로 스케일해 확보. 캔버스 크기는 유지.
PITCH_MARGIN_X = 26
_INNER_W = OUT_W - PITCH_MARGIN_X * 2
_INNER_H = round(_INNER_W * OUT_H / OUT_W)  # 피치 원본 비율 유지
_INNER_X0 = PITCH_MARGIN_X
_INNER_Y0 = (OUT_H - _INNER_H) // 2

FPS = 25
HOLD_BEFORE_SEC = 0.4
MOVE_SEC = 3.0
HOLD_AFTER_SEC = 0.8

BG_COLOR = (10, 14, 12)
HOME_COLOR = (255, 146, 26)      # replay .fpa-replay-dot 주황 그라데이션 중간값
HOME_TEXT = (28, 28, 28)
AWAY_COLOR = (62, 122, 251)      # replay .fpa-replay-dot.away 파랑 그라데이션 중간값
AWAY_TEXT = (247, 251, 255)
ARROW_COLOR = (22, 194, 194)     # replay 화살표 #16c2c2
GK_RING = (0, 0, 0)

_FIELD_IMG_PATH = Path(__file__).parent / "fpa-field.png"


def _parse_dots(value: Any) -> list[dict[str, Any]]:
    dots: list[dict[str, Any]] = []
    if not isinstance(value, list):
        return dots
    for item in value:
        if not isinstance(item, dict):
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


def _parse_arrows(value: Any) -> list[dict[str, float]]:
    """SceneState.passArrows — 라이브 캔버스 논리좌표(1050x680, y반전)를 미터로 변환.

    같은 패스가 before/after 캔버스에 한 번씩(동일 좌표) 기록되므로
    좌표 기준으로 중복 제거한다 — 안 하면 공이 같은 경로를 두 번 이동한다.
    """
    arrows: list[dict[str, float]] = []
    seen: set[tuple[int, int, int, int]] = set()
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
        key = (round(x1), round(y1), round(x2), round(y2))
        if key in seen:
            continue
        seen.add(key)
        arrows.append({
            "x1": x1 / 1050 * FIELD_W, "y1": (1 - y1 / 680) * FIELD_H,
            "x2": x2 / 1050 * FIELD_W, "y2": (1 - y2 / 680) * FIELD_H,
        })
    return arrows


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


def _to_px(x: float, y: float) -> tuple[float, float]:
    return (
        _INNER_X0 + (x / FIELD_W) * _INNER_W,
        _INNER_Y0 + (1 - y / FIELD_H) * _INNER_H,
    )


LINE_COLOR = (240, 245, 242)
LINE_W = 5

_field_img_cache: Image.Image | None = None


def _new_frame() -> Image.Image:
    global _field_img_cache
    if _field_img_cache is None:
        _field_img_cache = _build_background()
    img = Image.new("RGB", (OUT_W, OUT_H), BG_COLOR)
    img.paste(_field_img_cache)
    return img


def _build_background() -> Image.Image:
    """캔버스 전체 합성 배경 — 이음새 없는 스트라이프 잔디 + 경기장 라인 + 골대.

    fpa-field.png 에서 표본한 스트라이프 색(어둠/밝음)·폭(필드/20, 하프당 5+5)·노이즈(σ≈9)로
    잔디를 캔버스 전체에 깔고, 실측 좌표(_to_px)로 라인을 직접 그린다.
    이미지 조각 붙이기가 아니라서 여백 이음새·AA 잔상이 원천적으로 없다.
    """
    import numpy as np

    dark = np.array([74.0, 139.0, 52.0])
    light = np.array([84.0, 160.0, 68.0])
    stripe_w = _INNER_W / 20.0
    xs = np.arange(OUT_W)
    stripe_idx = np.floor((xs - _INNER_X0) / stripe_w).astype(int)
    is_light = (stripe_idx % 2) == 1
    base_row = np.where(is_light[:, None], light[None, :], dark[None, :])
    arr = np.tile(base_row[None, :, :], (OUT_H, 1, 1))
    # 경기장 밖(여백)은 좌우·상하 동일한 톤으로 — 스트라이프가 짝수(20)개라
    # 좌우 여백 명암이 반대로 떨어져 골대가 비대칭으로 보이는 것을 막는다.
    surround = dark * 0.92
    arr[:, :_INNER_X0, :] = surround
    arr[:, _INNER_X0 + _INNER_W:, :] = surround
    arr[:_INNER_Y0, :, :] = surround
    arr[_INNER_Y0 + _INNER_H:, :, :] = surround
    rng = np.random.default_rng(20260728)  # 결정적 노이즈 — 렌더마다 동일
    arr = arr + rng.normal(0.0, 9.0, size=arr.shape)
    arr = np.clip(arr, 0, 255).astype("uint8")
    img = Image.fromarray(arr, "RGB")
    draw = ImageDraw.Draw(img)
    _draw_pitch_lines(draw)
    _bake_goals(draw)
    return img


def _draw_pitch_lines(draw: ImageDraw.ImageDraw) -> None:
    """실측 규격 경기장 라인(미터 좌표 → _to_px)."""

    def rect(x1: float, y1: float, x2: float, y2: float) -> None:
        a = _to_px(x1, y2)
        b = _to_px(x2, y1)
        draw.rectangle([a, b], outline=LINE_COLOR, width=LINE_W)

    rect(0, 0, FIELD_W, FIELD_H)
    draw.line([_to_px(FIELD_W / 2, FIELD_H), _to_px(FIELD_W / 2, 0)],
              fill=LINE_COLOR, width=LINE_W)
    # 센터서클(9.15m) + 센터스팟
    cx, cy = _to_px(FIELD_W / 2, FIELD_H / 2)
    r = 9.15 / FIELD_W * _INNER_W
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=LINE_COLOR, width=LINE_W)
    draw.ellipse([cx - 4, cy - 4, cx + 4, cy + 4], fill=LINE_COLOR)
    # 페널티박스(16.5m)·골에어리어(5.5m)
    rect(0, 13.84, 16.5, 54.16)
    rect(FIELD_W - 16.5, 13.84, FIELD_W, 54.16)
    rect(0, 24.84, 5.5, 43.16)
    rect(FIELD_W - 5.5, 24.84, FIELD_W, 43.16)
    # 페널티스팟(11m) + 아크(스팟 중심 9.15m, 박스 밖 ±53°)
    for spot_x, a0, a1 in ((11.0, -53, 53), (FIELD_W - 11.0, 127, 233)):
        sx, sy = _to_px(spot_x, FIELD_H / 2)
        draw.ellipse([sx - 4, sy - 4, sx + 4, sy + 4], fill=LINE_COLOR)
        draw.arc([sx - r, sy - r, sx + r, sy + r], a0, a1,
                 fill=LINE_COLOR, width=LINE_W)


def _bake_goals(draw: ImageDraw.ImageDraw) -> None:
    """골라인 바깥 골대 프레임(그물 없음) — 실측 폭 7.32m(y 30.34~37.66), 깊이 ~2m."""
    goal_depth = 2.0 / FIELD_W * _INNER_W
    for side in ("left", "right"):
        _, y_top = _to_px(0, 37.66)
        _, y_bot = _to_px(0, 30.34)
        if side == "left":
            x_line = _INNER_X0
            x_out = x_line - goal_depth
        else:
            x_line = _INNER_X0 + _INNER_W
            x_out = x_line + goal_depth
        # ㄷ자(경기장 쪽 개방) — 골라인 위에 겹치면 그 변만 두꺼워 보인다.
        # draw.line 조합은 모서리 접합이 어긋나므로, 픽셀 정렬된 사각형 3조각으로 채운다.
        half = LINE_W // 2
        yt, yb = round(y_top), round(y_bot)
        xo, xl = round(x_out), round(x_line)
        post = [xo - half, yt - half, xo + half, yb + half]
        top_bar = [min(xo - half, xl), yt - half, max(xo + half, xl), yt + half]
        bot_bar = [min(xo - half, xl), yb - half, max(xo + half, xl), yb + half]
        for box in (post, top_bar, bot_bar):
            draw.rectangle(box, fill=LINE_COLOR)


def _draw_arrow(
    draw: ImageDraw.ImageDraw,
    start: tuple[float, float],
    end: tuple[float, float],
) -> None:
    """시안색 패스 화살표 — 콘솔 replay 의 line(#16c2c2, 4px) + 화살촉."""
    draw.line([start, end], fill=ARROW_COLOR, width=6)
    dx, dy = end[0] - start[0], end[1] - start[1]
    length = math.hypot(dx, dy)
    if length < 1:
        return
    ux, uy = dx / length, dy / length
    head = 19.0
    left = (end[0] - ux * head - uy * head * 0.55, end[1] - uy * head + ux * head * 0.55)
    right = (end[0] - ux * head + uy * head * 0.55, end[1] - uy * head - ux * head * 0.55)
    draw.polygon([end, left, right], fill=ARROW_COLOR)


def _draw_ball(draw: ImageDraw.ImageDraw, x: float, y: float) -> None:
    """⚽ 모사 — 흰 공 + 중앙 검은 오각형 (콘솔 replay 의 이모지 공 대응)."""
    r = 13.0
    draw.ellipse([x - r, y - r, x + r, y + r], fill=(250, 250, 250), outline=(25, 25, 25), width=2)
    pent = []
    for k in range(5):
        ang = math.radians(-90 + k * 72)
        pent.append((x + math.cos(ang) * r * 0.42, y + math.sin(ang) * r * 0.42))
    draw.polygon(pent, fill=(25, 25, 25))


def _draw_goal_inset(draw: ImageDraw.ImageDraw, gx: float, gy: float) -> None:
    """정면 골대 인셋(우상단) — dual 골대 클릭 지점(높이 포함)에 공 마커.

    gx: 0(왼쪽 포스트)~1(오른쪽 포스트), gy: 0(땅)~1(크로스바).
    """
    panel_w, panel_h = 300, 130
    px0 = OUT_W - panel_w - 18
    py0 = 18
    draw.rounded_rectangle(
        [px0, py0, px0 + panel_w, py0 + panel_h],
        radius=10,
        fill=(10, 14, 12),
        outline=(96, 108, 102),
        width=2,
    )
    # 골문(7.32:2.44 = 3:1) — 패널 안 중앙, 바닥선 위.
    goal_w, goal_h = 240, 80
    gx0 = px0 + (panel_w - goal_w) / 2
    gy1 = py0 + panel_h - 22  # 바닥선
    gy0 = gy1 - goal_h
    # 바닥선
    draw.line([(px0 + 12, gy1), (px0 + panel_w - 12, gy1)], fill=(150, 160, 155), width=2)
    # 네트(은은한 격자)
    for k in range(1, 6):
        x = gx0 + goal_w * k / 6
        draw.line([(x, gy0), (x, gy1)], fill=(52, 60, 56), width=1)
    for k in range(1, 3):
        y = gy0 + goal_h * k / 3
        draw.line([(gx0, y), (gx0 + goal_w, y)], fill=(52, 60, 56), width=1)
    # 골대 프레임(포스트 2 + 크로스바)
    draw.line([(gx0, gy1), (gx0, gy0)], fill=(240, 245, 242), width=4)
    draw.line([(gx0 + goal_w, gy1), (gx0 + goal_w, gy0)], fill=(240, 245, 242), width=4)
    draw.line([(gx0 - 2, gy0), (gx0 + goal_w + 2, gy0)], fill=(240, 245, 242), width=4)
    # 공 마커 — 클릭 지점(높이 반영)
    bx = gx0 + min(max(gx, 0.0), 1.0) * goal_w
    by = gy1 - min(max(gy, 0.0), 1.0) * goal_h
    r = 9.0
    draw.ellipse([bx - r, by - r, bx + r, by + r], fill=(250, 250, 250), outline=(25, 25, 25), width=2)
    pent = []
    for k in range(5):
        ang = math.radians(-90 + k * 72)
        pent.append((bx + math.cos(ang) * r * 0.42, by + math.sin(ang) * r * 0.42))
    draw.polygon(pent, fill=(25, 25, 25))


def _ease(t: float) -> float:
    """콘솔 replay 의 cubic-bezier(0.22,0.84,0.28,1) 근사 — 강한 ease-out."""
    return 1 - (1 - t) ** 3


def _load_font(size: int) -> ImageFont.ImageFont:
    for name in ("DejaVuSans-Bold.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def render_scene_motion(
    scene_state: dict[str, Any],
    out_path: Path,
    *,
    actor_jersey: str | None = None,
    actor_side: str | None = None,
    shot_target: tuple[float, float] | None = None,
    goal_mouth: tuple[float, float] | None = None,
) -> bool:
    """SceneState → mp4. 점이 하나도 없으면 False (렌더 생략).

    공 경로: passArrows 가 있으면 화살표 체인, 없으면(드리블 등) 행위자 점의
    before→after 이동을 따라간다(actor_jersey/actor_side 로 행위자 점을 찾는다).
    """
    before = _parse_dots(scene_state.get("beforeDots") or scene_state.get("before"))
    after = _parse_dots(scene_state.get("afterDots") or scene_state.get("after"))
    if not before and not after:
        return False
    pairs = _pair_dots(before, after)
    arrows = _parse_arrows(scene_state.get("passArrows"))
    ball_offset = (0.0, 0.0)
    actor_pair = _find_actor_pair(pairs, actor_jersey, actor_side)
    if not arrows and shot_target is None:
        if actor_pair is not None:
            b, a = actor_pair
            # 이동이 사실상 없으면(제자리 액션) 공 생략.
            if math.hypot(a["x"] - b["x"], a["y"] - b["y"]) > 0.8:
                arrows = [{"x1": b["x"], "y1": b["y"], "x2": a["x"], "y2": a["y"]}]
                # 드리블 공은 행위자 점과 겹치지 않게 발끝(우하단)에 붙인다.
                ball_offset = (0.9, -1.1)
    if shot_target is not None:
        # 슛 경로 — 슈터 최종 위치(없으면 마지막 화살표 끝)에서 골라인 지점으로.
        if actor_pair is not None:
            sx, sy = actor_pair[1]["x"], actor_pair[1]["y"]
        elif arrows:
            sx, sy = arrows[-1]["x2"], arrows[-1]["y2"]
        else:
            sx, sy = FIELD_W / 2, FIELD_H / 2
        arrows.append({"x1": sx, "y1": sy, "x2": shot_target[0], "y2": shot_target[1]})
        ball_offset = (0.0, 0.0)

    font = _load_font(15)
    dot_r = 14.0

    hold_before = int(HOLD_BEFORE_SEC * FPS)
    move = max(1, int(MOVE_SEC * FPS))
    hold_after = int(HOLD_AFTER_SEC * FPS)
    total = hold_before + move + hold_after

    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        for f in range(total):
            if f < hold_before:
                t = 0.0
            elif f < hold_before + move:
                t = _ease((f - hold_before) / move)
            else:
                t = 1.0

            img = _new_frame()
            draw = ImageDraw.Draw(img)

            # 패스 화살표 — 콘솔 replay 와 같은 시안색 실선 + 화살촉.
            for ar in arrows:
                _draw_arrow(
                    draw,
                    _to_px(ar["x1"], ar["y1"]),
                    _to_px(ar["x2"], ar["y2"]),
                )

            for b, a in pairs:
                x = b["x"] + (a["x"] - b["x"]) * t
                y = b["y"] + (a["y"] - b["y"]) * t
                px, py = _to_px(x, y)
                # 콘솔 replay 는 teamSide(home/away)로 색을 나눈다 — 없으면 ally→home 폴백.
                side = b["teamSide"] or a["teamSide"]
                if side is None:
                    side = "home" if (b["team"] or a["team"]) != "opponent" else "away"
                fill = HOME_COLOR if side == "home" else AWAY_COLOR
                text_color = HOME_TEXT if side == "home" else AWAY_TEXT
                draw.ellipse(
                    [px - dot_r, py - dot_r, px + dot_r, py + dot_r],
                    fill=fill,
                )
                if (b["role"] or a["role"]) == "gk":
                    # replay .gk = 안쪽 어두운 링(inset).
                    draw.ellipse(
                        [px - dot_r + 1, py - dot_r + 1, px + dot_r - 1, py + dot_r - 1],
                        outline=GK_RING,
                        width=3,
                    )
                number = b["number"] or a["number"]
                if number:
                    draw.text((px, py), number, fill=text_color, font=font, anchor="mm")

            # 공 — 패스 화살표 체인을 따라 순서대로 이동 (콘솔 replay 의 ball 재현).
            if arrows:
                n = len(arrows)
                pos = min(max(t, 0.0), 1.0) * n
                idx = min(int(pos), n - 1)
                local_t = pos - idx
                ar = arrows[idx]
                bx = ar["x1"] + (ar["x2"] - ar["x1"]) * local_t + ball_offset[0]
                by = ar["y1"] + (ar["y2"] - ar["y1"]) * local_t + ball_offset[1]
                bpx, bpy = _to_px(bx, by)
                _draw_ball(draw, bpx, bpy)

            # 정면 골대 인셋 — 슛 액션(골대 클릭 좌표 보유)일 때만.
            if goal_mouth is not None:
                _draw_goal_inset(draw, goal_mouth[0], goal_mouth[1])

            img.save(tmpdir / f"f{f:04d}.png")

        out_path.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(
            [
                "ffmpeg", "-y", "-loglevel", "error",
                "-framerate", str(FPS),
                "-i", str(tmpdir / "f%04d.png"),
                "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "27",
                "-movflags", "+faststart",
                str(out_path),
            ],
            check=True,
        )
    return True


def _goal_mouth_xy(value: Any) -> tuple[float, float] | None:
    """extra.goalMouth("gx,gy,방향") → (gx, gy). 인셋 표시용."""
    parts = str(value or "").strip().split(",")
    try:
        return (float(parts[0]), float(parts[1]))
    except (ValueError, IndexError):
        return None


def _shot_target_from_goal_mouth(value: Any) -> tuple[float, float] | None:
    """extra.goalMouth("gx,gy,공격방향") → 골라인 위 미터 좌표.

    gx(0~1)는 골 폭 7.32m(피치 y 30.34~37.66m)에 투영한다. 높이(gy)는 탑다운에서 생략.
    공격방향 right = x=105 골대, left = x=0 골대(좌우 미러).
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
    if direction == "left":
        return (0.0, 37.66 - gx * 7.32)
    return (FIELD_W, 30.34 + gx * 7.32)


def attach_scene_motions(
    db_actions: list[dict[str, Any]],
    payload_actions: list[dict[str, Any]] | None,
    *,
    clip_key: str,
    storage: Any,
    prefix: str,
) -> list[str]:
    """extra.sceneState 가 있는 액션마다 모션 mp4 를 렌더·업로드하고 sceneMotionKey 를 단다.

    db_actions: extra 를 포함한 상세 액션(렌더 소스). 여기에 sceneMotionKey 도 세팅된다.
    payload_actions: teamView.actions 처럼 extra 가 빠진 병렬 목록(있으면 seq 로 매칭해 세팅).
    반환: 실패/경고 메시지 목록 (실패해도 예외는 던지지 않는다 — 전송은 계속).
    """
    warnings: list[str] = []
    if storage is None or not getattr(storage, "configured", False):
        return warnings
    by_seq = {a.get("seq"): a for a in (payload_actions or [])}
    for action in db_actions:
        extra = action.get("extra") or {}
        state = extra.get("sceneState")
        if not isinstance(state, dict):
            continue
        seq = action.get("seq")
        key = f"{prefix.rstrip('/')}/scene-motion/{clip_key}-a{seq}.mp4"
        try:
            with tempfile.TemporaryDirectory() as tmp:
                out = Path(tmp) / "motion.mp4"
                if not render_scene_motion(
                    state,
                    out,
                    actor_jersey=str(action.get("jersey") or "") or None,
                    actor_side=str(action.get("teamSide") or "") or None,
                    shot_target=_shot_target_from_goal_mouth(extra.get("goalMouth")),
                    goal_mouth=_goal_mouth_xy(extra.get("goalMouth")),
                ):
                    continue
                storage.upload(out, key, content_type="video/mp4")
            action["sceneMotionKey"] = key
            target = by_seq.get(seq)
            if target is not None:
                target["sceneMotionKey"] = key
        except Exception as exc:  # 렌더/업로드 실패는 전송을 막지 않는다
            warnings.append(f"scene-motion {clip_key}-a{seq}: {exc}")
    return warnings
