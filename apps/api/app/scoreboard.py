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
# 사용자가 키우고 줄일 수 있는 범위. 100% 가 위 원본 크기다.
# 너무 키우면 판보다 로고가 커져 점수를 덮으므로 위를 막아 둔다.
LOGO_SCALE_MIN = 0.4
LOGO_SCALE_MAX = 2.2


def logo_scale(value: float | None) -> float:
    """로고 배율. 화면은 %로 주고받지만 여기서는 배수로 다룬다."""
    try:
        return max(LOGO_SCALE_MIN, min(LOGO_SCALE_MAX, float(value)))
    except (TypeError, ValueError):
        return 1.0


def r(value: float) -> int:
    """.5 를 늘 위로 올리는 반올림 — **화면(JS Math.round)과 같은 규칙**이다.

    파이썬 round 는 .5 에서 짝수 쪽으로 내려간다(210.5 → 210, JS 는 211). 자리 계산이
    양쪽에서 1px 어긋나면 "미리보기는 맞는데 결과물은 다르다" 가 된다. 눈에 안 보일
    만큼이라도, 두 곳이 같은 답을 내야 고칠 때 헷갈리지 않는다.
    """
    return math.floor(value + 0.5)


def logo_rise_ratio(scale: float) -> float:
    """판 높이 대비, 로고가 판 위로 튀어나오는 비율.

    로고는 늘 **정확히 절반**이 판 위로 올라간다 — 키워도 그 모양을 지킨다.
    키운 만큼 이미지가 세로로 길어지므로, 자리를 잡는 쪽(board_placement)과
    그리는 쪽(render_scoreboard)이 **같은 식**을 써야 로고가 잘리지 않는다.
    """
    return (LOGO_RISE * logo_scale(scale)) / DESIGN_H

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
    logo_size: float = 1.0,
    name_size: float = 1.0,
) -> Image.Image:
    """점수판 한 장을 RGBA 이미지로 그린다. board_width 는 판의 최종 픽셀 폭.

    로고가 있으면 결과 이미지 높이가 판보다 크다(위로 튀어나온 만큼). 얹는 쪽은
    board_placement 가 돌려주는 높이를 그대로 쓰면 된다.
    """
    w = max(160, int(board_width))
    plate_h = max(24, r(w / BOARD_ASPECT))

    logo = _load_logo(logo_path)
    scale = logo_scale(logo_size)
    rise = r(plate_h * logo_rise_ratio(scale)) if logo is not None else 0

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
    # 두 점수 사이의 콜론 — 15:22 처럼 읽히게. 자리는 두 숫자의 **한가운데**다.
    # 로고가 있어도 겹치지 않는다: 로고는 판 위쪽에 걸치고 콜론은 판 한가운데에 있다.
    draw.text(((home_score_x + away_score_x) / 2, mid_y), ":",
              font=score_font, fill=white, anchor="mm")

    # 팀명 — 컬러바와 점수 사이의 빈 자리 **한가운데**에 놓는다.
    #
    # 예전에는 홈은 왼쪽 끝(lm), 어웨이는 오른쪽 끝(rm)에 붙여 그렸다. 그래서 이름이
    # 짧으면 점수 쪽으로만 공간이 크게 남아, 어웨이는 판 끝에 딱 붙고 점수와는 멀리
    # 떨어져 보였다. 가운데로 놓으면 바 쪽·점수 쪽 여백이 같아진다.
    # 폭이 모자라면 종전대로 글자를 줄여 넣는다.
    #
    # 좌표는 **세로 한가운데 줄 기준의 절대값**으로 잡는다. 판이 12° 기운
    # 평행사변형이라 그 줄에서 왼쪽 끝은 off/2, 오른쪽 끝은 W - off/2 다. 기울기
    # 보정은 바(판 가장자리) 쪽 경계에만 붙고, 점수 쪽 경계는 점수와 같은 절대
    # 좌표라 그대로 둔다 — 양쪽에 다 더하면 이름이 점수 쪽으로 밀린다.
    # 팀명 크기 — 점수는 그대로 두고 이름만 줄인다.
    #
    # 배율은 **자동 축소가 정한 크기에** 건다. 최대 크기에 걸면 긴 이름에서는 아무
    # 효과가 없다 — 어차피 폭에 맞춰 더 줄어들기 때문이다. 이렇게 해야 100% 가 지금
    # 보이는 모습이고 60% 가 정확히 그 0.6 배가 된다.
    #
    # 키우는 쪽은 열어 두지 않았다. 폭을 넘으면 점수와 겹치는데, 여기서 넘치게 하면
    # 자동 축소를 둔 이유가 없어진다.
    try:
        name_scale = max(0.4, min(1.0, float(name_size)))
    except (TypeError, ValueError):
        name_scale = 1.0
    name_min = round(d(TEXT_SIZE * 0.45))
    home_left = off / 2 + bar_w + d(24)
    home_right = home_score_x - d(60)
    away_left = away_score_x + d(60)
    away_right = W - off / 2 - bar_w - d(24)
    home_zone = home_right - home_left
    away_zone = away_right - away_left
    home_font = _fit_font(draw, home_name or "HOME", NAME_FONT,
                          text_px, name_min, max(round(d(80)), round(home_zone)))
    away_font = _fit_font(draw, away_name or "AWAY", NAME_FONT,
                          text_px, name_min, max(round(d(80)), round(away_zone)))
    if name_scale < 1.0:
        home_font = _font(NAME_FONT, max(1, round(home_font.size * name_scale)))
        away_font = _font(NAME_FONT, max(1, round(away_font.size * name_scale)))
    draw.text(((home_left + home_right) / 2, mid_y), home_name or "HOME",
              font=home_font, fill=white, anchor="mm")
    draw.text(((away_left + away_right) / 2, mid_y), away_name or "AWAY",
              font=away_font, fill=white, anchor="mm")

    canvas = Image.alpha_composite(canvas, layer)

    # ── 로고 — 판 위쪽 가운데에 절반 걸친다 ────────────────────────────────
    if logo is not None:
        size = max(1, round(d(LOGO_SIZE * scale)))
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
    w = max(160, r(min(by_width, by_height)))
    return w, max(30, r(w / BOARD_ASPECT))


def board_placement(
    video_w: int, video_h: int,
    size_pct: float = 24.33, pos_x: float = 2.18, pos_y: float = 4.42,
    with_logo: bool = False, logo_size: float = 1.0,
    pos_px_x: float | None = None, pos_px_y: float | None = None,
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
    rise = r(plate_h * logo_rise_ratio(logo_size)) if with_logo else 0
    h = plate_h + rise
    margin = max(16, r(video_w * 0.021))
    # 로고는 판 위로 튀어나온 장식이다. 그것까지 여백을 지키게 하면 로고를 넣는 순간
    # 판이 로고 높이만큼 통째로 내려앉아 **위로 올릴 수가 없다** — 실제로 그랬다.
    # 여백은 **판**이 지키고, 로고는 그 위 여백을 파고든다. 다만 화면 밖으로는 안 나간다.
    top = max(0, margin - rise)
    free_x = max(0, video_w - w - 2 * margin)
    free_y = max(0, video_h - h - margin - top)

    def _frac(value: float) -> float:
        try:
            return max(0.0, min(100.0, float(value))) / 100.0
        except (TypeError, ValueError):
            return 0.0

    def _px(value, span: int) -> int | None:
        """사람이 적어 넣은 픽셀 좌표. 화면 밖으로만 안 나가게 묶는다."""
        try:
            return max(0, min(span, r(float(value))))
        except (TypeError, ValueError):
            return None

    # 픽셀이 있으면 픽셀이 이긴다. 비율은 '여백 뺀 범위 안' 이라 숫자로 감이 안 오고,
    # 영상 규격이 달라지면 자리도 밀린다 — 숫자를 적은 사람은 그 자리를 기대한다.
    x = _px(pos_px_x, max(0, video_w - w))
    y = _px(pos_px_y, max(0, video_h - h))
    if x is None:
        x = margin + r(free_x * _frac(pos_x))
    if y is None:
        y = top + r(free_y * _frac(pos_y))
    return w, h, x, y


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
    logo_size: float = 1.0,
    name_size: float = 1.0,
) -> Path:
    """점수판을 PNG 파일로 저장하고 그 경로를 돌려준다(ffmpeg overlay 입력용)."""
    image = render_scoreboard(
        home_name, away_name, home_score, away_score,
        board_width, home_color, away_color, logo_path, logo_size, name_size,
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG")
    return path
