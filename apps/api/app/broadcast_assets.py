"""Broadcast image rendering and public-object storage.

The renderer deliberately produces two representations from the same live
snapshot: a lossless PNG for conservative broadcast integrations and a short
animated WebP for browser/OBS overlays and the public showroom.  No browser
or screenshot process is required on the production worker.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from io import BytesIO
import os
from pathlib import Path
import re
from urllib.parse import quote

from PIL import Image, ImageDraw, ImageFont


CANVAS = (1280, 720)
LIVE_ASSET_TYPES = ("attack-direction", "possession", "xg-shot-map")
DOMINANCE_ASSET_TYPES = ("match-dominance-halftime", "match-dominance-fulltime")

_FONT_CACHE: dict[tuple[int, bool], ImageFont.FreeTypeFont | ImageFont.ImageFont] = {}


def _font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    key = (size, bold)
    if key in _FONT_CACHE:
        return _FONT_CACHE[key]
    filename = "KFAGothicBold.otf" if bold else "KFAGothicRegular.otf"
    candidates = (
        Path("/app/assets/fonts") / filename,
        Path(__file__).resolve().parents[3] / "assets" / "fonts" / filename,
    )
    for path in candidates:
        if path.exists():
            _FONT_CACHE[key] = ImageFont.truetype(str(path), size=size)
            return _FONT_CACHE[key]
    _FONT_CACHE[key] = ImageFont.load_default()
    return _FONT_CACHE[key]


def _value(data: dict, *keys: str, default=0):
    current = data
    for key in keys:
        if not isinstance(current, dict):
            return default
        current = current.get(key)
    return default if current is None else current


def _num(value, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def _new_canvas() -> tuple[Image.Image, ImageDraw.ImageDraw]:
    image = Image.new("RGBA", CANVAS, (7, 12, 27, 0))
    return image, ImageDraw.Draw(image)


def _card(draw: ImageDraw.ImageDraw, title: str, subtitle: str) -> None:
    draw.rounded_rectangle((42, 38, 1238, 682), radius=32, fill=(10, 21, 43, 247), outline=(80, 116, 178, 180), width=2)
    draw.text((82, 78), title, font=_font(46, True), fill=(241, 247, 255, 255))
    draw.text((84, 137), subtitle, font=_font(23), fill=(152, 179, 217, 255))
    draw.text((1090, 84), "FINEPLAY", font=_font(22, True), fill=(104, 222, 194, 255))


def _team(snapshot: dict, side: str) -> tuple[str, tuple[int, int, int]]:
    match = snapshot.get("match") or {}
    state = snapshot.get("broadcast_state") or {}
    raw = match.get(side.lower()) or {}
    fallback = "HOME" if side == "HOME" else "AWAY"
    name = str(state.get(f"{side.lower()}_label") or raw.get("name") or fallback)
    default = "#ff7900" if side == "HOME" else "#3d22f3"
    color = str(state.get(f"{side.lower()}_color") or default).lstrip("#")
    try:
        rgb = tuple(int(color[index:index + 2], 16) for index in (0, 2, 4))
        if len(rgb) == 3:
            return name, rgb
    except ValueError:
        pass
    return name, (255, 121, 0) if side == "HOME" else (61, 34, 243)


def _draw_arrow(draw: ImageDraw.ImageDraw, x: int, bottom: int, length: int, width: int, color: tuple[int, int, int], alpha: int = 255) -> None:
    top = bottom - length
    rgba = (*color, alpha)
    draw.line((x, bottom, x, top + width), fill=rgba, width=width)
    draw.polygon(((x, top), (x - width, top + width * 2), (x + width, top + width * 2)), fill=rgba)


def render_attack_direction(snapshot: dict, phase: float = 1.0) -> Image.Image:
    image, draw = _new_canvas()
    _card(draw, "공격 방향", "팀별 공격 루트 비중 · 실시간 갱신")
    analysis = snapshot.get("analysis") or {}
    rows = {str(row.get("team") or "").upper(): row for row in analysis.get("attack_direction") or [] if isinstance(row, dict)}
    for index, side in enumerate(("HOME", "AWAY")):
        x0 = 92 + index * 582
        name, color = _team(snapshot, side)
        row = rows.get(side) or {}
        ratios = row.get("direction_ratio") or {}
        values = (_num(ratios.get("left_pct")), _num(ratios.get("center_pct")), _num(ratios.get("right_pct")))
        # Keep the panel neutral: filling it with the team colour makes the
        # same-colour lane arrows disappear when used as an overlay.
        draw.rounded_rectangle((x0, 194, x0 + 514, 610), radius=24, fill=(16, 31, 56, 250), outline=(*color, 210), width=2)
        draw.text((x0 + 28, 220), name, font=_font(32, True), fill=(*color, 255))
        draw.text((x0 + 28, 264), "LEFT                 CENTER                 RIGHT", font=_font(16, True), fill=(187, 204, 232, 255))
        for lane, value in enumerate(values):
            x = x0 + 94 + lane * 164
            scaled = int((92 + _clamp(value, 0, 100) * 2.1) * _clamp(phase, 0.16, 1.0))
            _draw_arrow(draw, x, 510, scaled, int(12 + value * 0.24), color, 235)
            label = f"{round(value):.0f}%"
            bbox = draw.textbbox((0, 0), label, font=_font(30, True))
            draw.text((x - (bbox[2] - bbox[0]) / 2, 544), label, font=_font(30, True), fill=(244, 248, 255, 255))
    return image


def render_possession(snapshot: dict, phase: float = 1.0) -> Image.Image:
    image, draw = _new_canvas()
    _card(draw, "점유율", "볼 소유 시간 기준 · 실시간 갱신")
    analysis = snapshot.get("analysis") or {}
    possession = analysis.get("possession") or {}
    home = _clamp(_num(possession.get("home_pct")), 0, 100)
    away = _clamp(_num(possession.get("away_pct")), 0, 100)
    if home + away <= 0:
        home, away = 50, 50
    elif abs(home + away - 100) > 0.1:
        total = home + away
        home, away = home / total * 100, away / total * 100
    home_name, home_color = _team(snapshot, "HOME")
    away_name, away_color = _team(snapshot, "AWAY")
    x0, x1, y0, y1 = 120, 1160, 320, 466
    draw.rounded_rectangle((x0, y0, x1, y1), radius=72, fill=(25, 42, 72, 255))
    split = x0 + int((x1 - x0) * (home / 100) * _clamp(phase, 0, 1))
    draw.rounded_rectangle((x0, y0, max(x0 + 1, split), y1), radius=72, fill=(*home_color, 255))
    if split < x1:
        draw.rounded_rectangle((split, y0, x1, y1), radius=72, fill=(*away_color, 255))
    draw.text((120, 230), home_name, font=_font(34, True), fill=(*home_color, 255))
    right_bbox = draw.textbbox((0, 0), away_name, font=_font(34, True))
    draw.text((1160 - (right_bbox[2] - right_bbox[0]), 230), away_name, font=_font(34, True), fill=(*away_color, 255))
    home_text, away_text = f"{home:.0f}%", f"{away:.0f}%"
    draw.text((120, 500), home_text, font=_font(62, True), fill=(245, 249, 255, 255))
    away_bbox = draw.textbbox((0, 0), away_text, font=_font(62, True))
    draw.text((1160 - (away_bbox[2] - away_bbox[0]), 500), away_text, font=_font(62, True), fill=(245, 249, 255, 255))
    draw.text((520, 540), "POSSESSION", font=_font(21, True), fill=(152, 179, 217, 255))
    return image


def render_xg_shot_map(snapshot: dict, phase: float = 1.0) -> Image.Image:
    image, draw = _new_canvas()
    _card(draw, "xG 샷 맵", "누적 슈팅 위치와 기대득점")
    px, py, pw, ph = 138, 195, 1004, 422
    draw.rounded_rectangle((px, py, px + pw, py + ph), radius=22, fill=(17, 74, 67, 255), outline=(137, 225, 205, 255), width=3)
    draw.line((px + pw / 2, py, px + pw / 2, py + ph), fill=(137, 225, 205, 180), width=2)
    draw.ellipse((px + pw / 2 - 62, py + ph / 2 - 62, px + pw / 2 + 62, py + ph / 2 + 62), outline=(137, 225, 205, 180), width=2)
    draw.rectangle((px, py + 122, px + 116, py + ph - 122), outline=(137, 225, 205, 180), width=2)
    draw.rectangle((px + pw - 116, py + 122, px + pw, py + ph - 122), outline=(137, 225, 205, 180), width=2)
    analysis = snapshot.get("analysis") or {}
    shots = [row for row in analysis.get("xg") or [] if isinstance(row, dict)]
    for row in shots:
        side = str(row.get("team") or "HOME").upper()
        _, color = _team(snapshot, "AWAY" if side == "AWAY" else "HOME")
        shot_x = _clamp(_num(row.get("shot_x"), 52.5), 0, 105)
        shot_y = _clamp(_num(row.get("shot_y"), 34), 0, 68)
        x = px + (shot_x / 105) * pw
        y = py + (shot_y / 68) * ph
        radius = int((11 + _clamp(_num(row.get("xg")), 0, 1) * 28) * _clamp(phase, 0.35, 1.0))
        draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=(*color, 212), outline=(255, 255, 255, 235), width=2)
        if row.get("is_goal"):
            draw.text((x - 11, y - 16), "G", font=_font(24, True), fill=(255, 255, 255, 255))
    home_name, home_color = _team(snapshot, "HOME")
    away_name, away_color = _team(snapshot, "AWAY")
    draw.ellipse((146, 642, 164, 660), fill=(*home_color, 255)); draw.text((174, 634), home_name, font=_font(19, True), fill=(217, 228, 245, 255))
    draw.ellipse((528, 642, 546, 660), fill=(*away_color, 255)); draw.text((556, 634), away_name, font=_font(19, True), fill=(217, 228, 245, 255))
    draw.text((926, 634), f"SHOTS {len(shots)}", font=_font(19, True), fill=(152, 179, 217, 255))
    return image


def render_match_dominance(snapshot: dict, phase: float = 1.0, label: str = "FULL TIME") -> Image.Image:
    image, draw = _new_canvas()
    _card(draw, "매치 도미넌스", f"{label} · 경기 흐름 지수")
    x0, x1, middle, top, bottom = 104, 1176, 426, 208, 612
    draw.rounded_rectangle((x0, top, x1, bottom), radius=20, fill=(20, 35, 62, 255))
    draw.line((x0, middle, x1, middle), fill=(183, 204, 235, 180), width=2)
    items = _value(snapshot, "analysis", "match_dominance", "items", default=[])
    if not isinstance(items, list):
        items = []
    displayed = items[:max(1, int(len(items) * _clamp(phase, 0, 1)))] if items else []
    home_name, home_color = _team(snapshot, "HOME")
    away_name, away_color = _team(snapshot, "AWAY")
    points: list[tuple[float, float]] = []
    for index, row in enumerate(displayed):
        value = _clamp(_num((row or {}).get("dominance")), -1, 1)
        x = x0 if len(displayed) <= 1 else x0 + (x1 - x0) * index / (len(displayed) - 1)
        y = middle - value * 178
        points.append((x, y))
    if len(points) == 1:
        draw.ellipse((points[0][0] - 6, points[0][1] - 6, points[0][0] + 6, points[0][1] + 6), fill=(255, 255, 255, 255))
    elif len(points) > 1:
        draw.line(points, fill=(245, 249, 255, 255), width=7, joint="curve")
        for x, y in points:
            draw.ellipse((x - 4, y - 4, x + 4, y + 4), fill=(245, 249, 255, 255))
    draw.text((108, 636), home_name, font=_font(24, True), fill=(*home_color, 255))
    away_bbox = draw.textbbox((0, 0), away_name, font=_font(24, True))
    draw.text((1176 - (away_bbox[2] - away_bbox[0]), 636), away_name, font=_font(24, True), fill=(*away_color, 255))
    return image


def _encode_png(image: Image.Image) -> bytes:
    buffer = BytesIO()
    image.save(buffer, format="PNG", optimize=True)
    return buffer.getvalue()


def _encode_animated_webp(renderer, *args, **kwargs) -> bytes:
    phases = (0.18, 0.36, 0.56, 0.78, 1.0, 1.0)
    frames = [renderer(*args, phase=phase, **kwargs).convert("RGBA") for phase in phases]
    buffer = BytesIO()
    frames[0].save(buffer, format="WEBP", save_all=True, append_images=frames[1:], duration=(90, 90, 90, 110, 160, 1800), loop=0, lossless=False, quality=88, method=6)
    return buffer.getvalue()


def render_asset_pair(asset_type: str, snapshot: dict) -> tuple[bytes, bytes]:
    renderers = {
        "attack-direction": render_attack_direction,
        "possession": render_possession,
        "xg-shot-map": render_xg_shot_map,
        "match-dominance-halftime": lambda data, phase=1.0: render_match_dominance(data, phase=phase, label="HALF TIME"),
        "match-dominance-fulltime": lambda data, phase=1.0: render_match_dominance(data, phase=phase, label="FULL TIME"),
    }
    renderer = renderers.get(asset_type)
    if not renderer:
        raise ValueError(f"Unsupported broadcast asset type: {asset_type}")
    return _encode_png(renderer(snapshot)), _encode_animated_webp(renderer, snapshot)


@dataclass(frozen=True)
class StoredAsset:
    png_url: str
    webp_url: str
    generated_at: str

    def as_dict(self) -> dict[str, str]:
        return {"png_url": self.png_url, "webp_url": self.webp_url, "generated_at": self.generated_at}


class BroadcastAssetStore:
    """Stores generated files locally in development and in S3 for public CDN delivery."""

    def __init__(self) -> None:
        self.runtime_dir = Path(os.getenv("BROADCAST_RUNTIME_DIR", "/app/runtime/broadcast")).resolve()
        self.bucket = os.getenv("BROADCAST_S3_BUCKET", "").strip()
        self.region = os.getenv("BROADCAST_S3_REGION", "").strip() or None
        self.endpoint_url = os.getenv("BROADCAST_S3_ENDPOINT_URL", "").strip() or None
        self.prefix = os.getenv("BROADCAST_S3_PREFIX", "broadcast").strip("/")
        self.cdn_base_url = os.getenv("BROADCAST_CDN_BASE_URL", "").rstrip("/")
        self.public_base_url = os.getenv("BROADCAST_PUBLIC_BASE_URL", "https://broadcast.fineludens.kr").rstrip("/")
        self._client_obj = None

    @property
    def uses_s3(self) -> bool:
        return bool(self.bucket)

    def _client(self):
        if self._client_obj is None:
            try:
                import boto3
            except ImportError as exc:  # pragma: no cover
                raise RuntimeError("boto3 is required for BROADCAST_S3_BUCKET") from exc
            options = {}
            if self.region:
                options["region_name"] = self.region
            if self.endpoint_url:
                options["endpoint_url"] = self.endpoint_url
            self._client_obj = boto3.client("s3", **options)
        return self._client_obj

    @staticmethod
    def _safe_relative_path(relative_path: str) -> str:
        cleaned = re.sub(r"[^A-Za-z0-9_./-]", "_", relative_path).strip("/")
        if not cleaned or ".." in cleaned.split("/"):
            raise ValueError("Invalid broadcast asset path")
        return cleaned

    def _local_path(self, relative_path: str) -> Path:
        path = (self.runtime_dir / "assets" / relative_path).resolve()
        root = (self.runtime_dir / "assets").resolve()
        if root not in path.parents:
            raise ValueError("Invalid broadcast asset path")
        return path

    def _url(self, relative_path: str) -> str:
        if self.uses_s3 and self.cdn_base_url:
            return f"{self.cdn_base_url}/{quote(self.prefix + '/' + relative_path)}"
        return f"{self.public_base_url}/api/broadcast/assets/{quote(relative_path, safe='/')}"

    def put(self, relative_path: str, payload: bytes, content_type: str, cache_control: str, generated_at: str) -> str:
        relative_path = self._safe_relative_path(relative_path)
        if self.uses_s3:
            if not self.cdn_base_url:
                raise RuntimeError("BROADCAST_CDN_BASE_URL must be configured with BROADCAST_S3_BUCKET")
            key = f"{self.prefix}/{relative_path}"
            self._client().put_object(Bucket=self.bucket, Key=key, Body=payload, ContentType=content_type, CacheControl=cache_control, Metadata={"data-as-of": generated_at})
        else:
            path = self._local_path(relative_path)
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(path.suffix + ".tmp")
            temporary.write_bytes(payload)
            temporary.replace(path)
        return self._url(relative_path)

    def resolve_local(self, relative_path: str) -> Path:
        if self.uses_s3:
            raise FileNotFoundError("Broadcast assets are stored in S3")
        return self._local_path(self._safe_relative_path(relative_path))


def store_asset_pair(store: BroadcastAssetStore, relative_base: str, asset_type: str, snapshot: dict, immutable: bool = False) -> StoredAsset:
    png, webp = render_asset_pair(asset_type, snapshot)
    generated_at = datetime.utcnow().isoformat()
    cache_control = "public, max-age=31536000, immutable" if immutable else "public, max-age=55, must-revalidate"
    png_url = store.put(f"{relative_base}.png", png, "image/png", cache_control, generated_at)
    webp_url = store.put(f"{relative_base}.webp", webp, "image/webp", cache_control, generated_at)
    return StoredAsset(png_url=png_url, webp_url=webp_url, generated_at=generated_at)
