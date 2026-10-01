"""템플릿 에디터 — 운영자가 올린 PSD/이미지에서 템플릿을 만든다.

SUFA 세트를 들일 때 손으로 하던 일을 서버가 한다: PSD 의 글자 레이어에서 내용·자리·
크기·자간·색을 읽어 '고칠 수 있는 항목' 후보를 만들고, 로고·단색 도형 레이어를
로고 자리·팀 색 영역 후보로 내놓는다. 어느 후보가 팀명이고 점수인지는 **사람이
정한다** — 레이어 이름은 파일마다 제각각이라 완전 자동은 SUFA 에서도 틀렸다.

일반 이미지(PNG/JPG)는 후보를 못 뽑는다 — 글자가 픽셀로 구워져 있어 어디가 항목인지
알 수 없다. 배경으로만 받고, 항목 상자는 화면에서 손으로 놓는다.

흐름은 두 단계다:
  ① 분석: 파일을 pending 에 보관하고 후보 목록을 돌려준다.
  ② 생성: 사람이 역할을 정해 보내면, 글자 레이어와 '로고로 지정된 레이어' 를 숨긴
     배경 PNG 를 구워 템플릿으로 저장한다.
"""

from __future__ import annotations

import json
import uuid
from pathlib import Path

from PIL import Image

from .highlight_card_store import template_dir

#: 분석해 둔 원본(PSD/이미지)을 잠깐 두는 자리. 생성까지 이어지지 않으면 그냥 남는
#: 쓰레기라, 생성 때 쓰고 지운다.
def pending_dir() -> Path:
    path = template_dir() / "pending"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _walk(node):
    for layer in node:
        yield layer
        if layer.is_group():
            yield from _walk(layer)


def _text_style(layer) -> dict:
    """글자 레이어 하나의 스타일 — 크기·자간·색. PSD 스타일런에서 읽는다.

    크기에는 레이어 변형(transform)의 배율을 곱한다 — SUFA 점수판 제목이 60pt 에
    배율 0.465 로 실제 28pt 였다. 이걸 빼먹으면 두 배로 크게 그린다.
    """
    size, tracking, color = 40.0, 0, "#FFFFFF"
    try:
        runs = layer.engine_dict["StyleRun"]["RunArray"]
        st = runs[0]["StyleSheet"]["StyleSheetData"]
        size = float(st.get("FontSize", 40.0))
        tracking = int(float(st.get("Tracking", 0)))
        fill = st.get("FillColor", {}).get("Values")
        if fill and len(fill) >= 4:
            # ARGB 0~1.
            r, g, b = (max(0, min(255, round(float(v) * 255))) for v in fill[1:4])
            color = f"#{r:02X}{g:02X}{b:02X}"
    except Exception:  # noqa: BLE001 - 스타일을 못 읽어도 자리·내용은 쓸 수 있다
        pass
    try:
        scale = float(layer.transform[0])
        if 0 < scale < 10:
            size *= scale
    except Exception:  # noqa: BLE001
        pass
    return {"size": max(8, round(size)), "tracking": tracking, "color": color}


def _sample_color(image: Image.Image, box: tuple[int, int, int, int]) -> str:
    """상자 한가운데의 불투명 픽셀 색. 팀 색 영역 후보의 '바탕에 구워진 색' 이 된다."""
    left, top, right, bottom = box
    cx = max(0, min(image.width - 1, (left + right) // 2))
    cy = max(0, min(image.height - 1, (top + bottom) // 2))
    r, g, b, a = image.convert("RGBA").getpixel((cx, cy))
    return f"#{r:02X}{g:02X}{b:02X}"


def analyze(data: bytes, filename: str) -> dict:
    """올린 파일을 분석해 후보 목록을 돌려주고, 원본을 pending 에 보관한다."""
    token = uuid.uuid4().hex
    suffix = Path(filename).suffix.lower()

    if suffix not in {".psd", ".psb"}:
        # 일반 이미지 — 배경으로만 쓴다. 후보는 없다.
        import io

        with Image.open(io.BytesIO(data)) as im:
            im = im.convert("RGBA")
            im.save(pending_dir() / f"{token}.png")
            preview = im.copy()
            preview.thumbnail((1200, 1200), Image.LANCZOS)
            preview.save(pending_dir() / f"{token}.full.png")
            return {"token": token, "kind": "image", "design": list(im.size),
                    "texts": [], "objects": [],
                    "note": "이미지는 글자가 픽셀로 구워져 있어 항목을 자동으로 못 읽습니다."
                            " 배경으로 쓰고, 항목은 손으로 놓으세요."}

    from psd_tools import PSDImage

    src = pending_dir() / f"{token}.psd"
    src.write_bytes(data)
    psd = PSDImage.open(src)
    width, height = psd.size

    texts, objects = [], []
    composite = psd.composite(force=True).convert("RGBA")
    # 후보 상자를 시안 위에 겹쳐 보여 주려면 시안 자체가 화면에 있어야 한다.
    # 원본 합성본을 미리보기용으로 줄여 같이 저장한다(긴 변 1200 — 화면용이다).
    preview = composite.copy()
    preview.thumbnail((1200, 1200), Image.LANCZOS)
    preview.save(pending_dir() / f"{token}.full.png")
    for idx, layer in enumerate(_walk(psd)):
        if layer.is_group() or not layer.visible:
            continue
        left, top, right, bottom = layer.bbox
        w, h = right - left, bottom - top
        if w <= 0 or h <= 0:
            continue
        if layer.kind == "type":
            style = _text_style(layer)
            texts.append({
                "layer": idx,
                "content": str(layer.text or "").replace("\r", " ").replace("\n", " ").strip(),
                "box": [left, top, w, h],
                **style,
            })
        elif layer.kind in {"smartobject", "shape", "pixel"}:
            # 로고 자리·팀 색 영역 후보. 판 전체 같은 큰 것은 배경의 일부다 — 뺀다.
            if w >= width * 0.9 and h >= height * 0.9:
                continue
            objects.append({
                "layer": idx,
                "name": str(layer.name or f"레이어 {idx}"),
                "box": [left, top, w, h],
                "sample_color": _sample_color(composite, layer.bbox),
            })

    return {"token": token, "kind": "psd", "design": [width, height],
            "texts": texts, "objects": objects}


def compose_background(token: str, hide_layers: list[int], dest: Path) -> tuple[int, int]:
    """pending 의 PSD 에서 글자 전부와 지정한 레이어를 숨겨 배경 PNG 를 굽는다.

    글자는 무조건 숨긴다 — 항목이 됐든 안 됐든 우리가 다시 그릴 자리이고, 남기면
    시안 글자 위에 우리 글자가 겹쳐 찍힌다(SUFA 에서 실제로 그랬다).
    """
    psd_path = pending_dir() / f"{token}.psd"
    png_path = pending_dir() / f"{token}.png"
    if png_path.exists() and not psd_path.exists():
        # 일반 이미지 — 그대로 옮긴다.
        with Image.open(png_path) as im:
            im = im.convert("RGBA")
            dest.parent.mkdir(parents=True, exist_ok=True)
            im.save(dest)
            return im.size

    from psd_tools import PSDImage

    psd = PSDImage.open(psd_path)
    wanted = set(int(i) for i in hide_layers)
    for idx, layer in enumerate(_walk(psd)):
        if layer.is_group():
            continue
        if layer.kind == "type" or idx in wanted:
            layer.visible = False
    image = psd.composite(force=True).convert("RGBA")
    dest.parent.mkdir(parents=True, exist_ok=True)
    image.save(dest)
    return image.size


def discard_pending(token: str) -> None:
    for path in pending_dir().glob(f"{token}*"):
        path.unlink(missing_ok=True)


def cached_background(token: str, hide_layers: list[int]) -> Path:
    """숨김 조합별로 배경을 한 번만 굽는다.

    초안 미리보기는 역할을 바꿀 때마다 다시 그리는데, PSD 합성은 몇 초짜리 일이다.
    같은 숨김 조합이면 파일을 다시 안 굽는다 — 항목 값·자리만 바뀌는 경우가 대부분이다.
    """
    key = "-".join(str(i) for i in sorted(set(int(i) for i in hide_layers))) or "none"
    dest = pending_dir() / f"{token}.bg.{key}.png"
    if not dest.exists():
        compose_background(token, hide_layers, dest)
    return dest


def spec_from_request(raw) -> dict:
    """생성 요청의 spec(JSON)을 읽고 최소한만 검증한다. 자세한 검증은 필드별로."""
    if isinstance(raw, dict):
        return raw
    try:
        spec = json.loads(str(raw or "{}"))
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"spec 을 읽을 수 없습니다(JSON): {exc}")
    if not isinstance(spec, dict):
        raise ValueError("spec 은 객체여야 합니다.")
    return spec
