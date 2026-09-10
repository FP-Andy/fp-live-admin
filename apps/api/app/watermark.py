"""하이라이트에 새기는 우리 로고(브랜드 마크).

점수판(scoreboard.py)과 달리 경기 내용에 따라 바뀌지 않는다 — 영상 내내 같은 그림이
같은 자리에 얹힌다. 그래서 조각마다 다시 그릴 필요가 없고, 한 번 구운 PNG 를 돌려 쓴다.

투명도는 ffmpeg 이 아니라 **PNG 알파에 미리 곱해 둔다.** overlay 필터에 투명도를 걸려면
체인이 한 단계 더 늘어나는데, 어차피 영상 내내 같은 값이라 그림에 박아 두는 편이 싸고
합치기 명령도 단순해진다.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image

MARK_FILE = "fineplay-mark.png"

# 기본값 — 우상단, 영상 가로의 5%, 반쯤 비치게.
# 중계 화면의 방송사 로고(bug)가 보통 이 정도 크기·자리다. 경기 화면을 가리지 않으면서
# 누가 만든 영상인지는 알아볼 수 있는 선.
DEFAULT_SIZE_PCT = 5.0
DEFAULT_OPACITY = 0.55
DEFAULT_POS_X = 100.0   # 0=왼쪽, 100=오른쪽
DEFAULT_POS_Y = 0.0     # 0=위,   100=아래

_MARK_CACHE: dict[str, Image.Image] = {}


def _mark_source() -> Path:
    """도커(/app/assets/brand)와 로컬 실행(<repo>/assets/brand) 양쪽을 본다."""
    mounted = Path("/app/assets/brand")
    if (mounted / MARK_FILE).exists():
        return mounted / MARK_FILE
    module_path = Path(__file__).resolve()
    return module_path.parents[3] / "assets" / "brand" / MARK_FILE


def _source_image() -> Image.Image:
    key = str(_mark_source())
    cached = _MARK_CACHE.get(key)
    if cached is None:
        cached = Image.open(key).convert("RGBA")
        _MARK_CACHE[key] = cached
    return cached


def mark_size_for_video(video_w: int, video_h: int, size_pct: float = DEFAULT_SIZE_PCT) -> tuple[int, int]:
    """영상 규격에 맞는 로고 픽셀 크기. 원본 비율을 지킨다.

    가로의 size_pct% 를 기준으로 하되, 파노라마(3840x800)처럼 납작한 원본에서
    세로를 다 먹지 않게 화면 높이의 20% 로도 한 번 더 묶는다.
    """
    src = _source_image()
    ratio = src.height / src.width
    pct = max(1.0, min(25.0, float(size_pct))) / 100.0
    w = video_w * pct
    if w * ratio > video_h * 0.20:
        w = (video_h * 0.20) / ratio
    width = max(24, round(w))
    return width, max(24, round(width * ratio))


def mark_placement(
    video_w: int, video_h: int,
    size_pct: float = DEFAULT_SIZE_PCT,
    pos_x: float = DEFAULT_POS_X,
    pos_y: float = DEFAULT_POS_Y,
) -> tuple[int, int, int, int]:
    """로고 크기와 놓일 자리. (폭, 높이, 왼쪽 x, 위쪽 y)

    pos_x/pos_y 는 여백을 뺀 '놓을 수 있는 범위' 안에서의 비율(0~100)이고, 여백 규칙은
    점수판과 같다 — 둘이 같은 안쪽 격자 위에 앉아야 화면이 정돈돼 보인다.
    """
    w, h = mark_size_for_video(video_w, video_h, size_pct)
    margin = max(16, round(video_w * 0.021))
    free_x = max(0, video_w - w - 2 * margin)
    free_y = max(0, video_h - h - 2 * margin)

    def _frac(value: float) -> float:
        try:
            return max(0.0, min(100.0, float(value))) / 100.0
        except (TypeError, ValueError):
            return 0.0

    return w, h, margin + round(free_x * _frac(pos_x)), margin + round(free_y * _frac(pos_y))


def render_watermark(width: int, opacity: float = DEFAULT_OPACITY) -> Image.Image:
    """그 폭에 맞춘 로고. 투명도가 알파에 곱해져 있다."""
    src = _source_image()
    ratio = src.height / src.width
    size = (max(1, int(width)), max(1, round(width * ratio)))
    img = src.resize(size, Image.LANCZOS)
    alpha = max(0.0, min(1.0, float(opacity)))
    if alpha < 1.0:
        band = img.getchannel("A").point(lambda v: round(v * alpha))
        img.putalpha(band)
    return img


def render_watermark_file(out_path: Path, width: int, opacity: float = DEFAULT_OPACITY) -> Path:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    render_watermark(width, opacity).save(out_path)
    return out_path
