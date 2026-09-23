"""합본 사이에 끼는 전체화면 카드 PNG 렌더링.

하이라이트 합본은 지금까지 클립만 이어 붙였다. 여기에 두 종류의 카드를 끼운다.

    [시작 카드]       ← 무조건 맨 앞
    [1쿼터]           ← 첫 구간은 자동, 그 뒤는 T 태깅 자리
      클립 · 클립
    [2쿼터]
      클립 · 클립 · 클립

카드는 영상 위에 얹는 배너가 아니라 **화면을 채우는 한 장**이다.

**무엇을 그릴지는 이 파일이 정하지 않는다.** 템플릿(highlight_card_templates.py)이
배경 그림과 '고칠 수 있는 항목' 목록을 들고 있고, 여기서는 그 목록을 훑어 그린다.
대회마다 시안이 다르고 고칠 항목도 다르기 때문이다 — 항목을 코드에 박으면 템플릿을
하나 들일 때마다 렌더러를 고쳐야 한다. 시작 카드와 구간 카드 모두 템플릿을 따른다.

좌표는 템플릿의 시안 규격 기준 절대값이다. 출력 크기가 다르면 다 그린 뒤 한 번에
맞춘다(_compose). 요소마다 비율을 따로 계산하지 않으므로 시안과 어긋날 수 없다.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

from .highlight_card_templates import (
    DEFAULT_TEMPLATE_ID,
    TEMPLATES,
    CardField,
    CardTemplate,
    describe,
    get_template,
)
from .scoreboard import _font_dir

__all__ = [
    "DEFAULT_TEMPLATE_ID",
    "TEMPLATES",
    "describe",
    "get_template",
    "render_card",
    "render_card_file",
]

WHITE = (255, 255, 255)

# 로고 항목을 비워 뒀을 때(empty='mark') 그 자리에 들어갈 기본 그림. 영상 우상단에
# 얹는 그 마크를 흰색으로 채워 쓴다 — 주황 배경 위에 주황 마크를 얹으면 보이지 않기
# 때문이다. 흰 파일을 따로 두지 않고 그때그때 칠하므로 마크가 바뀌어도 따라간다.
DEFAULT_TEAM_MARK = "fineplay-mark.png"

_FONT_CACHE: dict[tuple[str, int], ImageFont.FreeTypeFont] = {}
_MARK_CACHE: dict[str, Image.Image | None] = {}


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


def _brand_dir() -> Path:
    """도커(/app/assets/brand)와 로컬 실행(<repo>/assets/brand) 양쪽을 본다."""
    mounted = Path("/app/assets/brand")
    if mounted.exists():
        return mounted
    module_path = Path(__file__).resolve()
    if len(module_path.parents) > 3:
        return module_path.parents[3] / "assets" / "brand"
    return mounted


def _gradient(width: int, height: int,
              colors: tuple[tuple[int, int, int], tuple[int, int, int]]) -> Image.Image:
    """템플릿이 정한 가로 그라디언트. 배경 PNG 가 없을 때의 대타다."""
    left, right = colors
    strip = Image.new("RGB", (max(1, width), 1))
    pixels = strip.load()
    for x in range(max(1, width)):
        f = x / max(1, width - 1)
        pixels[x, 0] = tuple(round(a + (b - a) * f) for a, b in zip(left, right))
    return strip.resize((max(1, width), max(1, height)), Image.NEAREST)


def _base(template: CardTemplate, kind: str) -> Image.Image:
    design = template.design
    path = _brand_dir() / template.background(kind)
    if path.exists():
        try:
            return Image.open(path).convert("RGB").resize(design, Image.LANCZOS)
        except OSError:
            pass
    return _gradient(design[0], design[1], template.gradient)


def _open_logo(path: Path | str | None) -> Image.Image | None:
    if not path:
        return None
    file = Path(path)
    if not file.exists():
        return None
    try:
        return Image.open(file).convert("RGBA")
    except OSError:
        return None


def _white_mark() -> Image.Image | None:
    if DEFAULT_TEAM_MARK in _MARK_CACHE:
        return _MARK_CACHE[DEFAULT_TEAM_MARK]
    source = _open_logo(_brand_dir() / DEFAULT_TEAM_MARK)
    mark = None
    if source is not None:
        # 모양(알파)만 가져오고 색은 전부 흰색으로 덮는다.
        mark = Image.new("RGBA", source.size, (255, 255, 255, 255))
        mark.putalpha(source.getchannel("A"))
    _MARK_CACHE[DEFAULT_TEAM_MARK] = mark
    return mark


def _fit_font(text: str, filename: str, size: int, max_width: float):
    """배정된 폭에 들어갈 때까지 글자 크기를 줄인다."""
    probe = ImageDraw.Draw(Image.new("RGB", (1, 1)))
    while size > 12:
        font = _font(filename, size)
        if probe.textlength(text, font=font) <= max_width:
            return font
        size -= 2
    return _font(filename, 12)


def _text_in(layer: Image.Image, box: tuple[float, float, float, float], text: str,
             filename: str, size: int, max_width: float | None = None,
             shadow: float = 0.0) -> None:
    """상자 한가운데에 한 줄. 시안의 text-shadow 는 옅은 검정 번짐이다."""
    text = (text or "").strip()
    if not text:
        return
    left, top, width, height = box
    cx, cy = left + width / 2, top + height / 2
    font = _fit_font(text, filename, size, max_width if max_width else width)
    draw = ImageDraw.Draw(layer)
    bbox = draw.textbbox((0, 0), text, font=font)
    x = cx - (bbox[2] - bbox[0]) / 2 - bbox[0]
    y = cy - (bbox[3] - bbox[1]) / 2 - bbox[1]
    if shadow > 0:
        blur = Image.new("RGBA", layer.size, (0, 0, 0, 0))
        ImageDraw.Draw(blur).text((x, y), text, font=font, fill=(0, 0, 0, 26))
        layer.alpha_composite(blur.filter(ImageFilter.GaussianBlur(shadow)))
        draw = ImageDraw.Draw(layer)
    draw.text((x, y), text, font=font, fill=WHITE)


def _paste_contained(layer: Image.Image, box: tuple[float, float, float, float],
                     logo: Image.Image, factor: float = 1.0) -> None:
    """상자 안에 비율을 지켜 넣고 가운데 맞춘다. factor 로 그보다 키우거나 줄인다.

    상자에 맞추는 단계는 **원본보다 크게 늘리지 않는다**(지금까지의 동작). 사용자가
    준 배율은 그 위에 곱한다 — 그래야 100% 가 예전 그대로이고, 150% 는 눈에 보이는
    지금 크기의 1.5배가 된다. 여기서 늘리기까지 막으면 작은 원본은 배율을 올려도
    꿈쩍하지 않는다(thumbnail 이 줄이기만 해서 실제로 그랬다).

    키울 때는 **상자 가운데를 붙잡는다.** 오른쪽 아래로 흘러내리면 자리를 매번 다시
    잡아야 한다.
    """
    left, top, width, height = box
    # 상자에 맞춘 크기는 thumbnail 에 맡긴다 — 비율 반올림이 미묘해서, 직접 계산하면
    # 배율을 안 건드린 카드까지 1px 씩 달라진다.
    fitted = logo.copy()
    fitted.thumbnail((max(1, round(width)), max(1, round(height))), Image.LANCZOS)

    target = (max(1, round(fitted.width * factor)), max(1, round(fitted.height * factor)))
    # 배율이 1 이면 예전 그대로다. 키울 때는 줄인 것을 다시 늘리지 않고 **원본에서
    # 한 번에** 뽑는다 — 두 번 거치면 로고가 뭉갠 채로 커진다.
    art = fitted if target == fitted.size else logo.resize(target, Image.LANCZOS)

    layer.paste(art, (round(left + (width - art.width) / 2),
                      round(top + (height - art.height) / 2)), art)


def _moved(spec: CardField, boxes: dict | None
           ) -> tuple[tuple[float, float, float, float], float]:
    """이 항목이 놓일 (자리, 크기배율). 안 건드렸으면 시안 그대로 · 배율 1.0.

    x·y 는 **왼쪽 위 모서리**다. scale 은 로고에만 준다(%) — 글자는 상자가 아니라
    글꼴 크기가 크기를 정하므로, 상자만 늘려 봐야 줄바꿈 폭만 바뀌고 글자는 그대로다.
    """
    left, top, width, height = spec.box
    factor = 1.0
    moved = (boxes or {}).get(spec.id)
    if not isinstance(moved, dict):
        return (left, top, width, height), factor

    def _num(key):
        try:
            return float(moved[key])
        except (TypeError, ValueError, KeyError):
            return None

    x, y = _num("x"), _num("y")
    if x is not None:
        left = x
    if y is not None:
        top = y

    scale = _num("scale")
    if spec.kind == "logo" and scale is not None:
        factor = max(0.2, min(3.0, scale / 100.0))
    return (left, top, width, height), factor


def _draw_field(layer: Image.Image, spec: CardField, value: str,
                logo_path: Path | str | None, boxes: dict | None = None) -> None:
    """항목 하나. 비었을 때 무엇으로 채울지는 항목이 들고 있다(spec.empty)."""
    box, factor = _moved(spec, boxes)
    if spec.kind == "logo":
        logo = _open_logo(logo_path)
        if logo is None and spec.empty == "mark":
            logo = _white_mark()
        if logo is not None:
            _paste_contained(layer, box, logo, factor)
        elif spec.empty == "vs":
            # 그 자리를 빈 구멍으로 두지 않는다. 로고 자리의 크기를 줄였으면 VS 도
            # 같이 줄어야 한다 — 로고를 뺐다고 글자만 커다랗게 남으면 이상하다.
            _text_in(layer, box, "VS", spec.font,
                     max(1, round((spec.empty_size or spec.size) * factor)),
                     box[2] * factor, shadow=10.0)
        return
    _text_in(layer, box, value, spec.font, spec.size, spec.max_width, spec.shadow)


def _compose(template: CardTemplate, kind: str, layer: Image.Image,
             width: int, height: int) -> Image.Image:
    """배경은 화면을 **덮고**, 내용은 **줄여 넣는다**.

    비율이 시안과 같으면 둘 다 단순 축소라 시안 그대로다. 다를 때(합본이 3840x800
    같은 초와이드로 나올 때) 둘을 다르게 다루는 이유:

      · 배경까지 줄여 넣으면 남는 자리를 따로 칠해야 하는데, 바탕이 화면 전체가
        아니라 가운데만 훑게 되어 좌우에 **이음새**가 보인다.
      · 내용까지 덮게 늘리면 위아래가 잘려 팀 이름과 제목이 화면 밖으로 나간다.

    그래서 배경은 덮어 바탕을 화면 끝까지 잇고(장식 일부가 잘린다), 글자와 로고는
    통째로 들어오게 줄인다.
    """
    width, height = max(1, width), max(1, height)
    design_w, design_h = template.design
    base = _base(template, kind)

    cover = max(width / design_w, height / design_h)
    grown = base.resize(
        (max(width, round(design_w * cover)), max(height, round(design_h * cover))),
        Image.LANCZOS,
    )
    left = (grown.width - width) // 2
    top = (grown.height - height) // 2
    card = grown.crop((left, top, left + width, top + height))

    contain = min(width / design_w, height / design_h)
    inner = layer.resize(
        (max(1, round(design_w * contain)), max(1, round(design_h * contain))),
        Image.LANCZOS,
    )
    card.paste(inner, ((width - inner.width) // 2, (height - inner.height) // 2), inner)
    return card


def render_card(
    template: CardTemplate | str | None,
    kind: str,
    width: int,
    height: int,
    values: dict | None = None,
    logos: dict | None = None,
    boxes: dict | None = None,
) -> Image.Image:
    """카드 한 장.

    kind 는 'start' 또는 'section'. values 는 {항목 id: 글자}, logos 는
    {항목 id: 로고 파일 경로}. 템플릿에 없는 항목은 조용히 무시한다 — 템플릿을 바꾸면
    옛 값이 남아 있을 수 있고, 그때 그림이 깨지는 것보다 안 그리는 게 낫다.

    boxes 는 {항목 id: {"x": 시안좌표, "y": 시안좌표}} — 사용자가 옮긴 자리다.
    없거나 모양이 아니면 시안 그대로 그린다.
    """
    spec_owner = template if isinstance(template, CardTemplate) else get_template(template)
    values = values or {}
    logos = logos or {}
    layer = Image.new("RGBA", spec_owner.design, (0, 0, 0, 0))
    for spec in spec_owner.fields(kind):
        _draw_field(layer, spec, str(values.get(spec.id) or ""), logos.get(spec.id), boxes)
    return _compose(spec_owner, kind, layer, width, height)


def render_card_file(path: Path, image: Image.Image) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG")
    return path
