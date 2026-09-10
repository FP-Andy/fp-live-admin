"""영상 위에 얹을 중계 점수판 PNG 렌더링.

디자인 원본(Figma, 2026-09-09 교체)은 928.75 x 182 의 **평행사변형** 판이다.
좌우 12° 로 기울어 있고, 판 배경은 ``linear-gradient(90deg, #1B2B3F 0%,
rgba(27,43,63,0.7) 100%)``. 양 끝에 팀 컬러바(각 폭의 10.28%)가 같은 기울기로 붙는다.

    ╱────────────────────────────────╱
   ╱ ■  여주        0  0       목포 ■╱      ■ = 팀 컬러바
  ╱────────────────────────────────╱

판 위쪽 가운데에는 대회 로고가 **절반 걸쳐** 놓인다(위로 61px 튀어나온다). 그래서
결과 이미지는 판보다 세로가 길다 — 얹는 쪽(board_placement)이 그 높이를 그대로 쓴다.
로고가 없으면 그 여백 없이 판만 그린다.

기울기·비율·좌표는 전부 DESIGN_* 기준의 비율로 환산해 쓰므로, 목표 폭이 얼마든
같은 모양이 나온다.

이전 디자인(828.46 x 157.76 둥근 사각형)에서 이걸로 교체했다. 시간 표시는 뺐다 —
하이라이트 클립은 경기 시계를 따라가지 않아 숫자가 의미를 갖지 못한다.
"""

from __future__ import annotations

import math
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont

# ── 디자인 원본 치수 ─────────────────────────────────────────────────────────
# Figma 가 뽑아준 width/height 는 **기울어진 도형의 바운딩 박스**다. 실제로 화면에서
# 차지하는 폭은 기울기 여유분(높이 × tan12° ≈ 38.7)만큼 좁다. 시안 스크린샷 두 장을
# 픽셀로 재보니 판 비율이 4.94:1 이었고, 바운딩(5.10:1)이 아니라 이 값이 맞다.
DESIGN_W = 928.75          # 바운딩 폭 — 아래 좌표들이 이 기준이라 그대로 둔다
DESIGN_H = 182.0
BOARD_ASPECT = 4.94        # 실측(스크린샷 257px : 52px)

# 기울기. 시안 스크린샷에서 잰 값이 12.2°(세로 51px 당 가로 11px)였고,
# 도형이 딱 떨어지는 각도로 그려졌다고 보아 12° 로 확정했다(2026-09-09).
SKEW_DEG = 12.0
SKEW = math.tan(math.radians(SKEW_DEG))  # ≈ 0.2126

# linear-gradient(90deg, #1B2B3F 0%, rgba(27,43,63,0.7) 100%)
PLATE_RGB = (27, 43, 63)
PLATE_ALPHA_LEFT = 255
PLATE_ALPHA_RIGHT = 179  # 0.7

# 컬러바 폭 — CSS 의 95.46 은 바운딩이라 10.28% 로 나오지만, 기울기 여유분을 빼면
# 수평 두께는 그보다 얇다. 실측 6.23% 를 쓴다(검산: (95.46 − 38.7)/928.75 = 6.11%).
BAR_W_RATIO = 0.0623
DEFAULT_HOME_COLOR = "#FF7400"
DEFAULT_AWAY_COLOR = "#0000FF"

# 로고 — 원본 122.02 정사각, 판 위로 61.01 튀어나온다(정확히 절반).
LOGO_SIZE = 122.02
LOGO_RISE = 61.01

# 글자 — 팀명·점수 모두 Paperlogy 900(=8ExtraBold), 69.3816px.
TEXT_SIZE = 69.3816
NAME_FONT = "Paperlogy-8ExtraBold.ttf"
SCORE_FONT = "Paperlogy-8ExtraBold.ttf"

# 작은 판에서도 글자·사선이 뭉개지지 않게 2배로 그린 뒤 줄인다.
SUPERSAMPLE = 2

_FONT_CACHE: dict[tuple[str, int], ImageFont.FreeTypeFont] = {}


def _font_dir() -> Path:
    """도커(/app/assets/fonts)와 로컬 실행(<repo>/assets/fonts) 양쪽을 본다."""
    mounted = Path("/app/assets/fonts")
    if mounted.exists():
        return mounted
    module_path = Path(__file__).resolve()
    if len(module_path.parents) > 3:
        return module_path.parents[3] / "assets" / "fonts"
    return mounted


def _font(filename: str, size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    key = (filename, size)
    cached = _FONT_CACHE.get(key)
    if cached is not None:
        return cached
    path = _font_dir() / filename
    if not path.exists():
        return ImageFont.load_default()
    font = ImageFont.truetype(str(path), size=size)
    _FONT_CACHE[key] = font
    return font


def _hex_rgb(value: str | None, fallback: str) -> tuple[int, int, int]:
    raw = (value or "").strip().lstrip("#")
    if len(raw) == 3:
        raw = "".join(ch * 2 for ch in raw)
    if len(raw) != 6:
        raw = fallback.lstrip("#")
    try:
        return (int(raw[0:2], 16), int(raw[2:4], 16), int(raw[4:6], 16))
    except ValueError:
        fb = fallback.lstrip("#")
        return (int(fb[0:2], 16), int(fb[2:4], 16), int(fb[4:6], 16))


def _slanted(x_left_at_bottom: float, width: float, height: float) -> list[tuple[float, float]]:
    """평행사변형 네 점. 위쪽이 오른쪽으로 offset 만큼 밀린다.

    x 는 **아래 변 기준**이다. 위 변은 offset 만큼 오른쪽에 있다 — 시안에서 위쪽이
    오른쪽으로 기울어 있기 때문이다(스크린샷에서 y 가 커질수록 x 가 작아졌다).
    """
    off = height * SKEW
    x0 = x_left_at_bottom
    return [
        (x0 + off, 0.0),
        (x0 + off + width, 0.0),
        (x0 + width, height),
        (x0, height),
    ]


def _fit_font(draw: ImageDraw.ImageDraw, text: str, filename: str,
              max_size: int, min_size: int, max_width: int):
    """배정된 폭 안에 들어갈 때까지 글자 크기를 줄인다."""
    size = max(min_size, max_size)
    while size > min_size:
        font = _font(filename, size)
        if draw.textlength(text, font=font) <= max_width:
            return font
        size -= 2
    return _font(filename, min_size)


def _load_logo(logo_path: Path | str | None) -> Image.Image | None:
    """대회 로고. 없거나 못 읽으면 None — 그때는 로고 없이 판만 그린다."""
    if not logo_path:
        return None
    path = Path(logo_path)
    if not path.exists():
        return None
    try:
        return Image.open(path).convert("RGBA")
    except Exception:
        return None


def render_scoreboard(
    home_name: str,
    away_name: str,
    home_score: int,
    away_score: int,
    board_width: int,
    home_color: str | None = None,
    away_color: str | None = None,
    logo_path: Path | str | None = None,
) -> Image.Image:
    """점수판 한 장을 RGBA 이미지로 그린다. board_width 는 판의 최종 픽셀 폭.

    로고가 있으면 결과 이미지 높이가 판보다 크다(위로 튀어나온 만큼). 얹는 쪽은
    board_placement 가 돌려주는 높이를 그대로 쓰면 된다.
    """
    w = max(160, int(board_width))
    plate_h = max(24, round(w / BOARD_ASPECT))

    logo = _load_logo(logo_path)
    rise = round(plate_h * (LOGO_RISE / DESIGN_H)) if logo is not None else 0

    s = SUPERSAMPLE
    W = w * s
    PH = plate_h * s
    RISE = rise * s
    H = PH + RISE
    k = W / DESIGN_W  # 디자인 좌표 → 실제 픽셀

    def d(value: float) -> float:
        return value * k

    canvas = Image.new("RGBA", (W, H), (0, 0, 0, 0))

    # ── 판(그라데이션) ────────────────────────────────────────────────────
    # 가로 한 줄을 만들어 늘린 뒤, 평행사변형 마스크로 잘라낸다.
    row = Image.new("RGBA", (W, 1))
    span = max(1, W - 1)
    row.putdata([
        (*PLATE_RGB, PLATE_ALPHA_LEFT
         + round((PLATE_ALPHA_RIGHT - PLATE_ALPHA_LEFT) * x / span))
        for x in range(W)
    ])
    plate = row.resize((W, PH))

    off = PH * SKEW
    mask = Image.new("L", (W, PH), 0)
    ImageDraw.Draw(mask).polygon(
        [(off, 0), (W, 0), (W - off, PH), (0, PH)], fill=255,
    )
    plate.putalpha(mask)
    canvas.alpha_composite(plate, (0, RISE))

    # ── 팀 컬러바 ────────────────────────────────────────────────────────
    bars = Image.new("RGBA", (W, PH), (0, 0, 0, 0))
    bdraw = ImageDraw.Draw(bars)
    bar_w = W * BAR_W_RATIO
    home_rgb = _hex_rgb(home_color, DEFAULT_HOME_COLOR)
    away_rgb = _hex_rgb(away_color, DEFAULT_AWAY_COLOR)
    bdraw.polygon(_slanted(0.0, bar_w, PH), fill=(*home_rgb, 255))
    bdraw.polygon(_slanted(W - off - bar_w, bar_w, PH), fill=(*away_rgb, 255))
    # 판 밖으로 삐져나오지 않게 같은 마스크로 한 번 더 자른다.
    bars.putalpha(ImageChops.multiply(bars.getchannel("A"), mask))
    canvas.alpha_composite(bars, (0, RISE))

    # ── 글자 ─────────────────────────────────────────────────────────────
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    mid_y = RISE + PH / 2
    text_px = round(d(TEXT_SIZE))
    white = (255, 255, 255, 255)

    # 점수 — 원본에서 두 숫자의 중심이 각각 37.3% / 53.4% 자리다.
    home_score_x = d(346.09 + 23.5)
    away_score_x = d(496.40 + 23.5)
    score_font = _font(SCORE_FONT, text_px)
    draw.text((home_score_x, mid_y), str(max(0, int(home_score))),
              font=score_font, fill=white, anchor="mm")
    draw.text((away_score_x, mid_y), str(max(0, int(away_score))),
              font=score_font, fill=white, anchor="mm")

    # 팀명 — 점수와 겹치지 않게 남는 폭 안에서 줄인다.
    name_min = round(d(TEXT_SIZE * 0.45))
    home_zone = home_score_x - d(60) - (bar_w + d(24))
    away_zone = (W - off - bar_w - d(24)) - (away_score_x + d(60))
    home_font = _fit_font(draw, home_name or "HOME", NAME_FONT,
                          text_px, name_min, max(round(d(80)), round(home_zone)))
    away_font = _fit_font(draw, away_name or "AWAY", NAME_FONT,
                          text_px, name_min, max(round(d(80)), round(away_zone)))
    draw.text((bar_w + d(24) + off / 2, mid_y), home_name or "HOME",
              font=home_font, fill=white, anchor="lm")
    draw.text((W - off - bar_w - d(24) + off / 2, mid_y), away_name or "AWAY",
              font=away_font, fill=white, anchor="rm")

    canvas = Image.alpha_composite(canvas, layer)

    # ── 로고 — 판 위쪽 가운데에 절반 걸친다 ────────────────────────────────
    if logo is not None:
        size = max(1, round(d(LOGO_SIZE)))
        fitted = logo.resize((size, size), Image.LANCZOS)
        # 원본 기준 중심 x = 383.07 + 61.01 = 444.08 (폭의 47.8%)
        cx = round(d(444.08))
        canvas.alpha_composite(fitted, (cx - size // 2, 0))

    return canvas.resize((w, plate_h + rise), Image.LANCZOS)


def board_size_for_video(
    video_w: int, video_h: int, size_pct: float = 24.33,
) -> tuple[int, int]:
    """영상 규격에 맞는 **판** 픽셀 크기(로고 여백 제외).

    기본은 가로의 size_pct%. 다만 3840x800 같은 파노라마 원본에서는 그 값이
    화면 높이의 태반을 먹으므로 세로 18% 로도 한 번 더 묶는다.
    """
    pct = max(10.0, min(60.0, float(size_pct))) / 100.0
    by_width = video_w * pct
    by_height = video_h * 0.18 * BOARD_ASPECT
    w = max(160, round(min(by_width, by_height)))
    return w, max(30, round(w / BOARD_ASPECT))


def board_placement(
    video_w: int, video_h: int,
    size_pct: float = 24.33, pos_x: float = 2.18, pos_y: float = 4.42,
    with_logo: bool = False,
) -> tuple[int, int, int, int]:
    """점수판 크기와 놓일 자리. (폭, **이미지 전체 높이**, 왼쪽 x, 위쪽 y)

    pos_x/pos_y 는 여백을 뺀 '놓을 수 있는 범위' 안에서의 비율(0~100)이다.
    (0,0) 왼쪽 위 · (50,50) 정중앙 · (100,100) 오른쪽 아래.
    기본값 (0,0) 은 중계 점수판이 가장 많이 놓이는 좌상단이다.

    로고가 있으면 이미지가 판보다 세로로 길다. 그 높이를 그대로 돌려주므로
    얹는 쪽은 로고까지 포함해 자리를 잡는다 — 위쪽에 붙였을 때 로고가 화면 밖으로
    잘리지 않는다.
    """
    w, plate_h = board_size_for_video(video_w, video_h, size_pct)
    h = plate_h + (round(plate_h * (LOGO_RISE / DESIGN_H)) if with_logo else 0)
    margin = max(16, round(video_w * 0.021))
    free_x = max(0, video_w - w - 2 * margin)
    free_y = max(0, video_h - h - 2 * margin)

    def _frac(value: float) -> float:
        try:
            return max(0.0, min(100.0, float(value))) / 100.0
        except (TypeError, ValueError):
            return 0.0

    return w, h, margin + round(free_x * _frac(pos_x)), margin + round(free_y * _frac(pos_y))


def render_scoreboard_file(
    path: Path,
    home_name: str,
    away_name: str,
    home_score: int,
    away_score: int,
    board_width: int,
    home_color: str | None = None,
    away_color: str | None = None,
    logo_path: Path | str | None = None,
) -> Path:
    """점수판을 PNG 파일로 저장하고 그 경로를 돌려준다(ffmpeg overlay 입력용)."""
    image = render_scoreboard(
        home_name, away_name, home_score, away_score,
        board_width, home_color, away_color, logo_path,
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG")
    return path
