"""하이라이트 영상 위에 얹을 점수판 PNG 렌더링.

디자인 원본(Figma)은 828.46 x 157.76 의 둥근 판(radius 14)에
``linear-gradient(90deg, #1B2B3F 0%, rgba(27,43,63,0.8) 100%)`` 배경이다.
여기서는 그 비율·색·라운드를 그대로 지키면서 목표 폭에 맞춰 다시 그린다.

판 안에는 [홈 컬러바][홈 팀명] [점수] [원정 팀명][원정 컬러바] 가 들어간다.
팀명은 배정된 폭에 맞춰 글자 크기를 자동으로 줄여 점수와 겹치지 않게 한다.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageFont

# 디자인 원본 치수. 아래 좌표들은 전부 이 폭 기준의 비율로 환산해 쓴다.
DESIGN_W = 828.46
DESIGN_H = 157.76
BOARD_ASPECT = DESIGN_W / DESIGN_H  # ≈ 5.251

# linear-gradient(90deg, #1B2B3F 0%, rgba(27,43,63,0.8) 100%)
PLATE_RGB = (27, 43, 63)
PLATE_ALPHA_LEFT = 255
PLATE_ALPHA_RIGHT = 204  # 0.8

DEFAULT_HOME_COLOR = "#2F6FED"
DEFAULT_AWAY_COLOR = "#E8452F"

# 작은 판에서도 글자가 뭉개지지 않게 2배로 그린 뒤 줄인다.
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


def _plate(width: int, height: int, radius: int) -> Image.Image:
    """왼쪽은 불투명, 오른쪽은 80% 로 옅어지는 둥근 판."""
    # 가로 한 줄만 만들어 늘린다 — 픽셀을 하나씩 찍는 것보다 훨씬 빠르다.
    row = Image.new("RGBA", (width, 1))
    span = max(1, width - 1)
    row.putdata([
        (*PLATE_RGB, PLATE_ALPHA_LEFT
         + round((PLATE_ALPHA_RIGHT - PLATE_ALPHA_LEFT) * x / span))
        for x in range(width)
    ])
    plate = row.resize((width, height))

    mask = Image.new("L", (width, height), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, width - 1, height - 1], radius=radius, fill=255,
    )
    plate.putalpha(ImageChops.multiply(plate.getchannel("A"), mask))
    return plate


def _fit_font(draw: ImageDraw.ImageDraw, text: str, filename: str,
              max_size: int, min_size: int, max_width: int):
    """배정된 폭 안에 들어갈 때까지 글자 크기를 줄인다."""
    size = max_size
    while size > min_size:
        font = _font(filename, size)
        if draw.textlength(text, font=font) <= max_width:
            return font
        size -= 2
    return _font(filename, min_size)


def render_scoreboard(
    home_name: str,
    away_name: str,
    home_score: int,
    away_score: int,
    board_width: int,
    home_color: str | None = None,
    away_color: str | None = None,
) -> Image.Image:
    """점수판 한 장을 RGBA 이미지로 그린다. board_width 는 최종 픽셀 폭."""
    w = max(120, int(board_width))
    h = max(24, round(w / BOARD_ASPECT))

    s = SUPERSAMPLE
    W, H = w * s, h * s
    # 디자인 좌표(828.46 기준)를 실제 픽셀로 옮기는 배율.
    k = W / DESIGN_W

    def d(value: float) -> int:
        return round(value * k)

    board = _plate(W, H, d(14))
    layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    home_rgb = _hex_rgb(home_color, DEFAULT_HOME_COLOR)
    away_rgb = _hex_rgb(away_color, DEFAULT_AWAY_COLOR)

    # ── 양 끝 팀 컬러바 ──
    bar_w, bar_h = d(14), d(92)
    bar_top = (H - bar_h) // 2
    bar_r = bar_w // 2
    draw.rounded_rectangle(
        [d(26), bar_top, d(26) + bar_w, bar_top + bar_h],
        radius=bar_r, fill=(*home_rgb, 255),
    )
    draw.rounded_rectangle(
        [W - d(26) - bar_w, bar_top, W - d(26), bar_top + bar_h],
        radius=bar_r, fill=(*away_rgb, 255),
    )

    # ── 가운데 점수 ──
    pill_w, pill_h = d(184), d(96)
    pill_left = (W - pill_w) // 2
    pill_top = (H - pill_h) // 2
    draw.rounded_rectangle(
        [pill_left, pill_top, pill_left + pill_w, pill_top + pill_h],
        radius=d(10), fill=(12, 20, 31, 210),
    )
    score_text = f"{max(0, int(home_score))} - {max(0, int(away_score))}"
    score_font = _fit_font(
        draw, score_text, "Paperlogy-8ExtraBold.ttf",
        max_size=d(60), min_size=d(26), max_width=pill_w - d(24),
    )
    draw.text(
        (pill_left + pill_w / 2, H / 2), score_text,
        font=score_font, fill=(255, 255, 255, 255), anchor="mm",
    )

    # ── 팀명. 점수 알약과 겹치지 않도록 남는 폭 안에서만 그린다 ──
    name_font_max, name_font_min = d(46), d(22)
    zone_w = pill_left - d(20) - (d(26) + bar_w + d(20))
    home_font = _fit_font(
        draw, home_name or "HOME", "KFAGothicBold.otf",
        name_font_max, name_font_min, max(d(60), zone_w),
    )
    away_font = _fit_font(
        draw, away_name or "AWAY", "KFAGothicBold.otf",
        name_font_max, name_font_min, max(d(60), zone_w),
    )
    draw.text(
        (d(26) + bar_w + d(20), H / 2), home_name or "HOME",
        font=home_font, fill=(255, 255, 255, 255), anchor="lm",
    )
    draw.text(
        (W - d(26) - bar_w - d(20), H / 2), away_name or "AWAY",
        font=away_font, fill=(255, 255, 255, 255), anchor="rm",
    )

    board = Image.alpha_composite(board, layer)
    return board.resize((w, h), Image.LANCZOS)


def board_size_for_video(
    video_w: int, video_h: int, size_pct: float = 28.0,
) -> tuple[int, int]:
    """영상 규격에 맞는 점수판 픽셀 크기.

    기본은 가로의 size_pct%. 다만 3840x800 같은 파노라마 원본에서는 그 값이
    화면 높이의 태반을 먹으므로 세로 18% 로도 한 번 더 묶는다.
    """
    pct = max(10.0, min(60.0, float(size_pct))) / 100.0
    by_width = video_w * pct
    by_height = video_h * 0.18 * BOARD_ASPECT
    w = max(160, round(min(by_width, by_height)))
    return w, max(30, round(w / BOARD_ASPECT))


def render_scoreboard_file(
    path: Path,
    home_name: str,
    away_name: str,
    home_score: int,
    away_score: int,
    board_width: int,
    home_color: str | None = None,
    away_color: str | None = None,
) -> Path:
    """점수판을 PNG 파일로 저장하고 그 경로를 돌려준다(ffmpeg overlay 입력용)."""
    image = render_scoreboard(
        home_name, away_name, home_score, away_score,
        board_width, home_color, away_color,
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG")
    return path
