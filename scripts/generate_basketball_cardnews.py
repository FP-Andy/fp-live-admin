from __future__ import annotations

import argparse
import json
import math
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from PIL import Image, ImageDraw, ImageFont


CANVAS_W = 1080
CANVAS_H = 1350
SAFE_LEFT = 50
SAFE_TOP = 60
SAFE_RIGHT = 50
SAFE_BOTTOM = 80

HOME_COLOR = (255, 116, 0, 255)
AWAY_COLOR = (37, 99, 235, 255)
GREEN = (34, 197, 94, 255)
BLUE = (37, 99, 235, 255)
RED = (248, 63, 68, 255)
WHITE = (255, 255, 255, 255)
MUTED = (255, 255, 255, 178)
PANEL_BG = (0, 0, 0, 190)
PANEL_BORDER = (255, 255, 255, 105)

ROOT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_RUNTIME_DIR = ROOT_DIR / "runtime"
DEFAULT_OUTPUT_DIR = DEFAULT_RUNTIME_DIR / "basketball-cardnews"
DEFAULT_ADMINWEB_DIR = Path("/Users/andy/Downloads/AdminWeb-main/public/assets")
DEFAULT_FONT_DIR = Path(os.environ.get("CARDNEWS_FONT_DIR", DEFAULT_ADMINWEB_DIR / "fonts"))
DEFAULT_ASSET_DIR = Path(os.environ.get("CARDNEWS_ASSET_DIR", DEFAULT_ADMINWEB_DIR / "cardnews" / "common"))


@dataclass(frozen=True)
class Box:
    x: int
    y: int
    w: int
    h: int

    @property
    def xyxy(self) -> tuple[int, int, int, int]:
        return (self.x, self.y, self.x + self.w, self.y + self.h)

    def inset(self, px: int, py: int | None = None) -> "Box":
        py = px if py is None else py
        return Box(self.x + px, self.y + py, max(0, self.w - px * 2), max(0, self.h - py * 2))

    def split_y(self, ratios: tuple[float, ...]) -> list["Box"]:
        total = sum(ratios)
        boxes: list[Box] = []
        cursor = self.y
        used = 0
        for index, ratio in enumerate(ratios):
            if index == len(ratios) - 1:
                height = self.h - used
            else:
                height = int(round(self.h * ratio / total))
            boxes.append(Box(self.x, cursor, self.w, height))
            cursor += height
            used += height
        return boxes


class FontBook:
    def __init__(self, font_dir: Path = DEFAULT_FONT_DIR) -> None:
        self.font_dir = font_dir
        self.fallback_dir = ROOT_DIR / "assets" / "fonts"
        self._cache: dict[tuple[str, int], ImageFont.FreeTypeFont | ImageFont.ImageFont] = {}

    def get(self, filename: str, size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
        key = (filename, size)
        if key in self._cache:
            return self._cache[key]

        candidates = [
            self.font_dir / filename,
            self.fallback_dir / "KFAGothicBold.otf",
            self.fallback_dir / "KFAGothicRegular.otf",
            Path("/System/Library/Fonts/Supplemental/Arial Unicode.ttf"),
            Path("/Library/Fonts/Arial Unicode.ttf"),
        ]
        for path in candidates:
            if path.exists():
                self._cache[key] = ImageFont.truetype(str(path), size)
                return self._cache[key]
        self._cache[key] = ImageFont.load_default()
        return self._cache[key]


FONTS = FontBook()


def measure(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont) -> tuple[int, int]:
    bbox = draw.textbbox((0, 0), text, font=font)
    return bbox[2] - bbox[0], bbox[3] - bbox[1]


def ellipsize(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.ImageFont, max_width: int) -> str:
    text = str(text)
    if measure(draw, text, font)[0] <= max_width:
        return text
    ellipsis = "..."
    if measure(draw, ellipsis, font)[0] > max_width:
        return ""
    lo, hi = 0, len(text)
    best = ellipsis
    while lo <= hi:
        mid = (lo + hi) // 2
        candidate = text[:mid].rstrip() + ellipsis
        if measure(draw, candidate, font)[0] <= max_width:
            best = candidate
            lo = mid + 1
        else:
            hi = mid - 1
    return best


def fit_one_line(
    draw: ImageDraw.ImageDraw,
    text: Any,
    box: Box,
    font_file: str,
    max_size: int,
    min_size: int,
    fill: tuple[int, int, int, int] = WHITE,
    align: str = "left",
) -> None:
    value = re.sub(r"\s+", " ", str(text or "")).strip()
    if not value or box.w <= 0 or box.h <= 0:
        return

    selected_font = FONTS.get(font_file, min_size)
    selected_text = value
    for size in range(max_size, min_size - 1, -1):
        font = FONTS.get(font_file, size)
        tw, th = measure(draw, value, font)
        if tw <= box.w and th <= box.h:
            selected_font = font
            selected_text = value
            break
    else:
        selected_font = FONTS.get(font_file, min_size)
        selected_text = ellipsize(draw, value, selected_font, box.w)

    tw, th = measure(draw, selected_text, selected_font)
    if align == "center":
        x = box.x + (box.w - tw) / 2
    elif align == "right":
        x = box.x + box.w - tw
    else:
        x = box.x
    bbox = draw.textbbox((0, 0), selected_text, font=selected_font)
    y = box.y + (box.h - th) / 2 - bbox[1]
    draw.text((x, y), selected_text, font=selected_font, fill=fill)


def _tokenize(text: str) -> tuple[list[str], str]:
    normalized = re.sub(r"\s+", " ", str(text or "")).strip()
    if not normalized:
        return [], " "
    if " " in normalized:
        return normalized.split(" "), " "
    return list(normalized), ""


def _wrap_lines(
    draw: ImageDraw.ImageDraw,
    text: str,
    font: ImageFont.ImageFont,
    width: int,
    max_lines: int,
) -> list[str]:
    tokens, joiner = _tokenize(text)
    lines: list[str] = []
    current = ""
    overflow = False

    for token in tokens:
        candidate = token if not current else f"{current}{joiner}{token}"
        if measure(draw, candidate, font)[0] <= width:
            current = candidate
            continue
        if current:
            lines.append(current)
            current = token
        else:
            lines.append(token)
            current = ""
        if len(lines) >= max_lines:
            overflow = True
            break

    if current and len(lines) < max_lines:
        lines.append(current)
    elif current:
        overflow = True

    if len(lines) > max_lines:
        lines = lines[:max_lines]
        overflow = True

    for index, line in enumerate(lines):
        if measure(draw, line, font)[0] > width:
            lines[index] = ellipsize(draw, line, font, width)
    if overflow and lines:
        lines[-1] = ellipsize(draw, lines[-1], font, width)
    return lines


def draw_multiline(
    draw: ImageDraw.ImageDraw,
    text: Any,
    box: Box,
    font_file: str,
    max_size: int,
    min_size: int,
    max_lines: int,
    fill: tuple[int, int, int, int] = WHITE,
    valign: str = "center",
) -> None:
    value = re.sub(r"\s+", " ", str(text or "")).strip()
    if not value or box.w <= 0 or box.h <= 0:
        return

    selected_font = FONTS.get(font_file, min_size)
    selected_lines = [ellipsize(draw, value, selected_font, box.w)]
    selected_line_h = max(1, int(min_size * 1.25))

    for size in range(max_size, min_size - 1, -1):
        font = FONTS.get(font_file, size)
        line_h = int(size * 1.24)
        lines = _wrap_lines(draw, value, font, box.w, max_lines)
        if lines and len(lines) * line_h <= box.h:
            selected_font = font
            selected_lines = lines
            selected_line_h = line_h
            break

    total_h = len(selected_lines) * selected_line_h
    if valign == "top":
        y = box.y
    elif valign == "bottom":
        y = box.y + box.h - total_h
    else:
        y = box.y + (box.h - total_h) / 2

    for line in selected_lines:
        draw.text((box.x, y), line, font=selected_font, fill=fill)
        y += selected_line_h


def paste_cover(canvas: Image.Image, src: Image.Image, box: Box) -> None:
    src = src.convert("RGBA")
    scale = max(box.w / src.width, box.h / src.height)
    size = (max(1, int(src.width * scale)), max(1, int(src.height * scale)))
    resized = src.resize(size, Image.Resampling.LANCZOS)
    left = (resized.width - box.w) // 2
    top = (resized.height - box.h) // 2
    cropped = resized.crop((left, top, left + box.w, top + box.h))
    canvas.alpha_composite(cropped, (box.x, box.y))


def paste_contain(canvas: Image.Image, src: Image.Image, box: Box, bg: tuple[int, int, int, int] | None = None) -> None:
    if box.w <= 0 or box.h <= 0:
        return
    src = src.convert("RGBA")
    layer = Image.new("RGBA", (box.w, box.h), bg or (0, 0, 0, 0))
    scale = min(box.w / src.width, box.h / src.height)
    size = (max(1, int(src.width * scale)), max(1, int(src.height * scale)))
    resized = src.resize(size, Image.Resampling.LANCZOS)
    x = (box.w - resized.width) // 2
    y = (box.h - resized.height) // 2
    layer.alpha_composite(resized, (x, y))
    canvas.alpha_composite(layer, (box.x, box.y))


def alpha_rectangle(
    draw: ImageDraw.ImageDraw,
    xyxy: tuple[float, float, float, float],
    fill: tuple[int, int, int, int],
) -> None:
    x0, y0, x1, y1 = (int(round(value)) for value in xyxy)
    if x1 < x0:
        x0, x1 = x1, x0
    if y1 < y0:
        y0, y1 = y1, y0
    if x1 <= x0 or y1 <= y0:
        return
    layer = Image.new("RGBA", (x1 - x0, y1 - y0), (0, 0, 0, 0))
    layer_draw = ImageDraw.Draw(layer, "RGBA")
    layer_draw.rectangle((0, 0, layer.width, layer.height), fill=fill)
    draw._image.alpha_composite(layer, (x0, y0))


def panel(draw: ImageDraw.ImageDraw, box: Box, radius: int = 18) -> None:
    layer = Image.new("RGBA", (box.w + 1, box.h + 1), (0, 0, 0, 0))
    layer_draw = ImageDraw.Draw(layer, "RGBA")
    layer_draw.rounded_rectangle((0, 0, box.w, box.h), radius=radius, fill=PANEL_BG, outline=PANEL_BORDER, width=1)
    draw._image.alpha_composite(layer, (box.x, box.y))


def load_json(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def load_card_asset(name: str) -> Image.Image | None:
    path = DEFAULT_ASSET_DIR / name
    if not path.exists():
        return None
    return Image.open(path).convert("RGBA")


def new_canvas() -> Image.Image:
    canvas = Image.new("RGBA", (CANVAS_W, CANVAS_H), (12, 12, 12, 255))
    bg = load_card_asset("bg-hexagon-large.png")
    if bg is not None:
        paste_cover(canvas, bg, Box(0, 0, CANVAS_W, CANVAS_H))
    overlay = Image.new("RGBA", (CANVAS_W, CANVAS_H), (0, 0, 0, 52))
    canvas.alpha_composite(overlay)
    return canvas


def save_card(canvas: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(path, quality=95)


def extract_context(match_id: str, runtime_dir: Path) -> dict[str, Any]:
    result_path = runtime_dir / "basketball-shotmaps" / f"{match_id}_result.json"
    margin_path = runtime_dir / "basketball-margin-flow" / f"{match_id}_margin_flow_summary.json"
    rebound_path = runtime_dir / "basketball-rebound-control" / f"{match_id}_rebound_control_by_team_summary.json"

    result = load_json(result_path)
    margin_summary = load_json(margin_path)
    rebound_summary = load_json(rebound_path)

    match = result.get("match", {})
    state = result.get("state", {})
    teams = margin_summary.get("teams") or rebound_summary.get("teams") or {}
    home = teams.get("HOME") or state.get("home", {}).get("name") or match.get("metadata", {}).get("home_team") or "HOME"
    away = teams.get("AWAY") or state.get("away", {}).get("name") or match.get("metadata", {}).get("away_team") or "AWAY"
    round_number = match.get("round_number") or 1

    event_payload = result.get("events", {})
    events = event_payload.get("events") if isinstance(event_payload, dict) else event_payload
    events = events or match.get("metadata", {}).get("basketball_fla", {}).get("events", [])

    final_score = margin_summary.get("final_score") or {}
    if not final_score:
        last_scored = next((event for event in reversed(events) if event.get("home_score_after") is not None), {})
        final_score = {
            "HOME": int(last_scored.get("home_score_after") or 0),
            "AWAY": int(last_scored.get("away_score_after") or 0),
            "margin": int(last_scored.get("margin_after") or 0),
        }

    period_count = int(margin_summary.get("period_count") or match.get("metadata", {}).get("period_count") or 4)
    period_minutes = int(margin_summary.get("period_minutes") or match.get("first_half_minutes") or 7)

    return {
        "match_id": match_id,
        "match": match,
        "home": home,
        "away": away,
        "round_number": round_number,
        "events": events,
        "margin_points": result.get("margin_flow", {}).get("points", []),
        "margin_summary": margin_summary,
        "rebound_summary": rebound_summary,
        "final_score": final_score,
        "period_count": period_count,
        "period_minutes": period_minutes,
        "runtime_dir": runtime_dir,
    }


def match_title(ctx: dict[str, Any]) -> str:
    return f"{ctx['home']} vs {ctx['away']}"


def match_subtitle(ctx: dict[str, Any]) -> str:
    score = ctx["final_score"]
    return f"[BASKETBALL | {ctx['round_number']}R] · {score.get('HOME', 0)}-{score.get('AWAY', 0)}"


def draw_header(
    canvas: Image.Image,
    draw: ImageDraw.ImageDraw,
    ctx: dict[str, Any],
    page_no: str,
    page_title: str,
    description: str,
) -> None:
    fit_one_line(draw, "BASKETBALL CARD NEWS", Box(60, 72, 470, 30), "WantedSans-ExtraBold.otf", 23, 17)
    fit_one_line(draw, f"PAGE {page_no}", Box(870, 88, 140, 34), "WantedSans-ExtraBold.otf", 23, 17, align="right")
    fit_one_line(draw, match_title(ctx), Box(60, 122, 790, 52), "WantedSans-ExtraBold.otf", 46, 26)
    fit_one_line(draw, match_subtitle(ctx), Box(60, 168, 610, 30), "WantedSans-ExtraBold.otf", 24, 17)
    fit_one_line(draw, page_title, Box(60, 230, 720, 58), "Giants-Bold.otf", 53, 34)
    draw.rounded_rectangle((60, 279, 247, 288), radius=5, fill=HOME_COLOR)
    draw_multiline(draw, description, Box(60, 306, 730, 31), "WantedSans-ExtraBold.otf", 20, 14, 1, fill=(255, 255, 255, 225))


def draw_margin_header(
    draw: ImageDraw.ImageDraw,
    ctx: dict[str, Any],
) -> None:
    fit_one_line(draw, "PAGE 02", Box(870, 88, 140, 34), "WantedSans-ExtraBold.otf", 23, 17, align="right")
    fit_one_line(draw, match_title(ctx), Box(60, 92, 790, 54), "WantedSans-ExtraBold.otf", 46, 26)
    fit_one_line(draw, "MARGIN FLOW", Box(60, 206, 720, 62), "Giants-Bold.otf", 54, 34)
    draw.rounded_rectangle((60, 292, 247, 301), radius=5, fill=HOME_COLOR)


def draw_logo(canvas: Image.Image) -> None:
    logo = load_card_asset("logo-fineplay.png")
    if logo is None:
        return
    paste_contain(canvas, logo, Box(440, 1232, 200, 38))


def mmss(seconds: int) -> str:
    seconds = max(0, int(seconds))
    return f"{seconds // 60}:{seconds % 60:02d}"


def event_elapsed(event: dict[str, Any], period_minutes: int) -> int:
    if "_elapsed" in event:
        return int(event.get("_elapsed") or 0)
    period = int(event.get("period") or 1)
    clock = str(event.get("clock") or "00:00")
    parts = [int(part or 0) for part in clock.split(":")[-2:]]
    remaining = parts[0] * 60 + (parts[1] if len(parts) > 1 else 0)
    return (period - 1) * period_minutes * 60 + max(0, period_minutes * 60 - remaining)


def draw_kpi(draw: ImageDraw.ImageDraw, box: Box, label: str, value: str, detail: str) -> None:
    panel(draw, box, radius=14)
    inner = box.inset(18, 12)
    fit_one_line(draw, label, Box(inner.x, inner.y, inner.w, 22), "WantedSans-ExtraBold.otf", 17, 12, fill=MUTED)
    fit_one_line(draw, value, Box(inner.x, inner.y + 31, inner.w, 31), "Giants-Bold.otf", 25, 18)
    fit_one_line(draw, detail, Box(inner.x, inner.y + 65, inner.w, 18), "WantedSans-ExtraBold.otf", 14, 10, fill=(255, 255, 255, 168))


def draw_margin_graph(draw: ImageDraw.ImageDraw, box: Box, ctx: dict[str, Any]) -> None:
    panel(draw, box, radius=18)
    plot = Box(box.x + 70, box.y + 30, box.w - 94, box.h - 82)
    points = sorted(ctx.get("margin_points") or [], key=lambda item: event_elapsed(item, ctx["period_minutes"]))
    total_seconds = int(ctx["period_count"] * ctx["period_minutes"] * 60)

    series: list[tuple[int, int, str | None]] = [(0, 0, None)]
    for point in points:
        series.append((event_elapsed(point, ctx["period_minutes"]), int(point.get("margin_after") or 0), point.get("team")))
    if not series or series[-1][0] < total_seconds:
        series.append((total_seconds, series[-1][1] if series else 0, None))

    max_abs = max([abs(margin) for _, margin, _ in series] + [6])
    y_max = max(6, int(math.ceil(max_abs / 2) * 2))

    def px(t: int) -> float:
        return plot.x + (max(0, min(total_seconds, t)) / max(1, total_seconds)) * plot.w

    def py(v: int) -> float:
        return plot.y + (y_max - max(-y_max, min(y_max, v))) / (y_max * 2) * plot.h

    zero_y = py(0)
    grid_color = (255, 255, 255, 74)
    axis_color = (255, 255, 255, 210)
    draw.rectangle(plot.xyxy, outline=axis_color, width=1)

    step = max(1, int(math.ceil(y_max / 3)))
    while y_max % step != 0 and step < y_max:
        step += 1
    for tick in range(-y_max, y_max + 1, step):
        y = py(tick)
        draw.line((plot.x, y, plot.x + plot.w, y), fill=(255, 255, 255, 118 if tick == 0 else 60), width=2 if tick == 0 else 1)
        fit_one_line(draw, f"{tick:+d}", Box(box.x + 12, int(y - 11), 46, 20), "WantedSans-ExtraBold.otf", 16, 10, align="right")

    for index in range(5):
        t = int(total_seconds * index / 4)
        x = px(t)
        draw.line((x, plot.y, x, plot.y + plot.h), fill=grid_color, width=1)
        fit_one_line(draw, mmss(t), Box(int(x - 38), plot.y + plot.h + 18, 76, 22), "WantedSans-ExtraBold.otf", 15, 10, align="center")

    for index in range(len(series) - 1):
        t0, margin, _ = series[index]
        t1 = series[index + 1][0]
        x0, x1 = px(t0), px(t1)
        y = py(margin)
        if margin > 0:
            alpha_rectangle(draw, (x0, y, x1, zero_y), fill=(255, 116, 0, 62))
        elif margin < 0:
            alpha_rectangle(draw, (x0, zero_y, x1, y), fill=(37, 99, 235, 68))

    for index in range(len(series) - 1):
        t0, margin0, _ = series[index]
        t1, margin1, _ = series[index + 1]
        x0, x1 = px(t0), px(t1)
        y0, y1 = py(margin0), py(margin1)
        draw.line((x0, y0, x1, y0), fill=WHITE, width=4)
        if index < len(series) - 2:
            draw.line((x1, y0, x1, y1), fill=WHITE, width=4)

    for t, margin, team in series[1:-1]:
        color = HOME_COLOR if team == "HOME" else AWAY_COLOR if team == "AWAY" else WHITE
        x, y = px(t), py(margin)
        draw.ellipse((x - 7, y - 7, x + 7, y + 7), fill=color, outline=WHITE, width=2)

    fit_one_line(draw, "HOME LEAD", Box(plot.x + 16, plot.y + 32, 250, 40), "Giants-Bold.otf", 31, 20)
    fit_one_line(draw, "AWAY LEAD", Box(plot.x + 16, plot.y + plot.h - 50, 250, 40), "Giants-Bold.otf", 28, 18)


def time_label(event: dict[str, Any]) -> str:
    if not event:
        return "-"
    return f"{event.get('period', '-')}Q {event.get('clock', '--:--')}"


def render_margin_flow(ctx: dict[str, Any], output_dir: Path) -> Path:
    canvas = new_canvas()
    draw = ImageDraw.Draw(canvas, "RGBA")
    draw_margin_header(draw, ctx)

    kpi_y = 330
    kpi_w = 225
    gap = 20
    score = ctx["final_score"]
    summary = ctx.get("margin_summary") or {}
    max_home = summary.get("max_home_lead") or {}
    max_away = summary.get("max_away_lead") or {}
    kpis = [
        ("FINAL", f"{score.get('HOME', 0)}-{score.get('AWAY', 0)}", f"{ctx['home']} {int(score.get('margin', 0)):+d}"),
        ("MAX HOME", f"{int(max_home.get('margin_after') or 0):+d}", time_label(max_home)),
        ("MAX AWAY", f"{int(max_away.get('margin_after') or 0):+d}", time_label(max_away)),
        ("LEAD CHANGE", str(summary.get("lead_changes", 0)), "0 제외"),
    ]
    for index, (label, value, detail) in enumerate(kpis):
        draw_kpi(draw, Box(60 + index * (kpi_w + gap), kpi_y, kpi_w, 102), label, value, detail)

    draw_margin_graph(draw, Box(60, 450, 960, 548), ctx)

    read_box = Box(60, 1035, 960, 154)
    panel(draw, read_box, radius=18)
    fit_one_line(draw, "FLOW READ", Box(90, 1085, 250, 36), "Giants-Bold.otf", 32, 20)
    read = (
        f"{time_label(max_away)} {ctx['away']}가 최대 {int(max_away.get('margin_after') or 0)}까지 앞섰고, "
        f"후반에 {ctx['home']}가 다시 뒤집었습니다. 최종 {score.get('HOME', 0)}-{score.get('AWAY', 0)}, "
        f"HOME {int(score.get('margin', 0)):+d}."
    )
    draw_multiline(draw, read, Box(90, 1125, 880, 45), "WantedSans-ExtraBold.otf", 20, 14, 2, fill=(255, 255, 255, 232), valign="top")
    draw_logo(canvas)

    path = output_dir / f"{ctx['match_id']}_02_margin_flow_card.png"
    save_card(canvas, path)
    save_card(canvas, output_dir / f"{ctx['match_id']}_02_margin_flow_card_v2.png")
    return path


ZONE_LABELS = {
    "LEFT_CORNER_3": "LC3",
    "RIGHT_CORNER_3": "RC3",
    "LEFT_SHORT_3": "LS3",
    "RIGHT_SHORT_3": "RS3",
    "LEFT_WING_3": "LW3",
    "RIGHT_WING_3": "RW3",
    "TOP_3": "Top 3",
    "LEFT_MID": "L Mid",
    "RIGHT_MID": "R Mid",
    "CENTER_MID": "C Mid",
    "LEFT_PAINT": "L Paint",
    "RIGHT_PAINT": "R Paint",
    "PAINT": "Paint",
    "RESTRICTED_AREA": "RA",
}


def shot_stats(events: Iterable[dict[str, Any]], team: str) -> dict[str, Any]:
    zones: dict[str, dict[str, int]] = {}
    total_attempts = 0
    total_made = 0
    total_points = 0
    for event in events:
        if event.get("type") != "SHOT" or event.get("team") != team:
            continue
        zone_id = event.get("zone_id") or event.get("zoneId")
        if zone_id == "FREE_THROW_ZONE":
            continue
        points = int(event.get("points") or 0)
        made = str(event.get("shot_result") or event.get("shotResult") or "").upper() == "MADE"
        zone = zones.setdefault(str(zone_id or "UNKNOWN"), {"attempts": 0, "made": 0, "points": 0})
        zone["attempts"] += 1
        total_attempts += 1
        if made:
            zone["made"] += 1
            zone["points"] += points
            total_made += 1
            total_points += points

    strong = None
    if zones:
        strong = max(zones.items(), key=lambda item: (item[1]["points"], item[1]["made"], item[1]["attempts"]))
    cold_candidates = [(name, stat) for name, stat in zones.items() if stat["attempts"] > 0 and stat["points"] == 0]
    cold = max(cold_candidates, key=lambda item: item[1]["attempts"]) if cold_candidates else None
    return {
        "attempts": total_attempts,
        "made": total_made,
        "points": total_points,
        "fg_pct": (total_made / total_attempts * 100) if total_attempts else 0,
        "strong": strong,
        "cold": cold,
    }


def crop_shotmap_court(img: Image.Image) -> Image.Image:
    rgba = img.convert("RGBA")
    pixels = rgba.load()
    xs: list[int] = []
    ys: list[int] = []
    max_y = int(rgba.height * 0.88)
    for y in range(0, max_y):
        for x in range(rgba.width):
            r, g, b, a = pixels[x, y]
            if a > 0 and r > 210 and g < 100 and b < 110:
                xs.append(x)
                ys.append(y)
    if not xs or not ys:
        return rgba
    left = max(0, min(xs) - 10)
    right = min(rgba.width, max(xs) + 10)
    top = max(0, min(ys) - 10)
    bottom = min(rgba.height, max(ys) + 10)
    return rgba.crop((left, top, right, bottom))


def draw_team_shot_panel(
    canvas: Image.Image,
    draw: ImageDraw.ImageDraw,
    box: Box,
    team_name: str,
    side_label: str,
    image_path: Path,
    stats: dict[str, Any],
) -> None:
    panel(draw, box, radius=18)
    header, image_area, key_area = box.inset(28, 24).split_y((15, 65, 20))
    fit_one_line(draw, team_name, Box(header.x, header.y + 2, header.w, 36), "WantedSans-ExtraBold.otf", 31, 18)
    sub = f"{side_label} · 코트 샷 {stats['points']}점 · {stats['made']}/{stats['attempts']} FG · {stats['fg_pct']:.1f}%"
    fit_one_line(draw, sub, Box(header.x, header.y + 39, header.w, 24), "WantedSans-ExtraBold.otf", 16, 10)

    if image_path.exists():
        court = crop_shotmap_court(Image.open(image_path))
        paste_contain(canvas, court, image_area.inset(0, 6), bg=(255, 255, 255, 255))

    key_box = key_area.inset(0, 8)
    draw.rounded_rectangle(key_box.xyxy, radius=12, fill=(0, 0, 0, 245), outline=(255, 255, 255, 80), width=1)
    inner = key_box.inset(22, 16)
    fit_one_line(draw, "KEY ZONES", Box(inner.x, inner.y, inner.w, 22), "WantedSans-ExtraBold.otf", 16, 11)
    strong = stats.get("strong")
    cold = stats.get("cold")
    strong_line = "강점 -"
    cold_line = "무득점 -"
    if strong:
        name, stat = strong
        strong_line = f"강점 {ZONE_LABELS.get(name, name)}: {stat['points']}점"
    if cold:
        name, stat = cold
        cold_line = f"무득점 {ZONE_LABELS.get(name, name)}: {stat['attempts']}시도"
    fit_one_line(draw, strong_line, Box(inner.x, inner.y + 34, inner.w, 28), "WantedSans-ExtraBold.otf", 21, 15)
    fit_one_line(draw, cold_line, Box(inner.x, inner.y + 64, inner.w, 28), "WantedSans-ExtraBold.otf", 21, 15)


def render_shot_map(ctx: dict[str, Any], output_dir: Path) -> Path:
    canvas = new_canvas()
    draw = ImageDraw.Draw(canvas, "RGBA")
    draw_header(canvas, draw, ctx, "03", "SHOT MAP", "시도 없음=회색 · 0점=빨강 · 1~3점=노랑 · 4점 이상=초록")
    events = ctx.get("events") or []
    home_stats = shot_stats(events, "HOME")
    away_stats = shot_stats(events, "AWAY")
    shot_dir = ctx["runtime_dir"] / "basketball-shotmaps"

    draw_team_shot_panel(
        canvas,
        draw,
        Box(60, 365, 460, 680),
        ctx["home"],
        "HOME",
        shot_dir / f"{ctx['match_id']}_home_shotmap.svg.png",
        home_stats,
    )
    draw_team_shot_panel(
        canvas,
        draw,
        Box(560, 365, 460, 680),
        ctx["away"],
        "AWAY",
        shot_dir / f"{ctx['match_id']}_away_shotmap.svg.png",
        away_stats,
    )

    note = Box(60, 1070, 960, 102)
    panel(draw, note, radius=18)
    draw_multiline(
        draw,
        "자유투는 FLA 코트 구역이 아니어서 샷맵에서는 제외했습니다.",
        note.inset(28, 20),
        "WantedSans-ExtraBold.otf",
        24,
        17,
        2,
        fill=(255, 255, 255, 232),
    )
    draw_logo(canvas)
    path = output_dir / f"{ctx['match_id']}_03_shot_map_card.png"
    save_card(canvas, path)
    save_card(canvas, output_dir / f"{ctx['match_id']}_03_shot_map_card_v2.png")
    return path


def rebound_stats(ctx: dict[str, Any]) -> dict[str, Any]:
    summary = ctx.get("rebound_summary") or {}
    if summary.get("by_team"):
        return summary["by_team"]

    stats = {
        "HOME": {"ar": 0, "dr": 0, "ra": 0},
        "AWAY": {"ar": 0, "dr": 0, "ra": 0},
    }
    for event in ctx.get("events") or []:
        if event.get("type") != "REBOUND":
            continue
        team = event.get("team")
        rebound_type = str(event.get("rebound_type") or event.get("reboundType") or "").upper()
        if team in stats and rebound_type == "AR":
            stats[team]["ar"] += 1
        elif team in stats and rebound_type == "DR":
            stats[team]["dr"] += 1
        allowed = event.get("rebound_allowed_team") or event.get("reboundAllowedTeam")
        if allowed in stats:
            stats[allowed]["ra"] += 1

    by_team: dict[str, Any] = {}
    for team, raw in stats.items():
        total = raw["ar"] + raw["dr"] + raw["ra"]
        by_team[team] = {
            "total": total,
            "ar": {"count": raw["ar"], "pct": raw["ar"] / total * 100 if total else 0},
            "dr": {"count": raw["dr"], "pct": raw["dr"] / total * 100 if total else 0},
            "ra": {"count": raw["ra"], "pct": raw["ra"] / total * 100 if total else 0},
        }
    return by_team


def draw_donut(canvas: Image.Image, center: tuple[int, int], radius: int, width: int, values: list[tuple[float, tuple[int, int, int, int]]]) -> None:
    scale = 3
    size = (radius * 2 + 10) * scale
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer, "RGBA")
    total = sum(max(0, value) for value, _ in values)
    bbox = (5 * scale, 5 * scale, size - 5 * scale, size - 5 * scale)
    if total <= 0:
        d.ellipse(bbox, outline=(255, 255, 255, 80), width=width * scale)
    else:
        start = -90.0
        for value, color in values:
            extent = 360.0 * max(0, value) / total
            d.pieslice(bbox, start=start, end=start + extent, fill=color)
            start += extent
        inner_r = (radius - width) * scale
        cx = cy = size // 2
        d.ellipse((cx - inner_r, cy - inner_r, cx + inner_r, cy + inner_r), fill=(0, 0, 0, 255))
    layer = layer.resize((size // scale, size // scale), Image.Resampling.LANCZOS)
    canvas.alpha_composite(layer, (center[0] - layer.width // 2, center[1] - layer.height // 2))


def draw_rebound_team_card(
    canvas: Image.Image,
    draw: ImageDraw.ImageDraw,
    box: Box,
    team_name: str,
    stat: dict[str, Any],
) -> None:
    panel(draw, box, radius=18)
    header, chart, legend = box.inset(28, 24).split_y((15, 60, 25))
    fit_one_line(draw, team_name, Box(header.x, header.y + 6, header.w, 42), "WantedSans-ExtraBold.otf", 31, 18, align="center")

    center = (chart.x + chart.w // 2, chart.y + chart.h // 2)
    draw_donut(
        canvas,
        center,
        radius=126,
        width=42,
        values=[
            (float(stat.get("ar", {}).get("count", 0)), GREEN),
            (float(stat.get("dr", {}).get("count", 0)), BLUE),
            (float(stat.get("ra", {}).get("count", 0)), RED),
        ],
    )
    fit_one_line(draw, "총", Box(center[0] - 42, center[1] - 30, 84, 22), "WantedSans-ExtraBold.otf", 16, 12, align="center")
    fit_one_line(draw, str(stat.get("total", 0)), Box(center[0] - 55, center[1] - 3, 110, 58), "Giants-Bold.otf", 44, 28, align="center")

    rows = [
        ("공리", "ar", GREEN),
        ("수리", "dr", BLUE),
        ("리바운드 허용", "ra", RED),
    ]
    row_h = legend.h // 3
    for index, (label, key, color) in enumerate(rows):
        y = legend.y + index * row_h
        draw.rounded_rectangle((legend.x + 2, y + 7, legend.x + 24, y + 29), radius=6, fill=color)
        fit_one_line(draw, label, Box(legend.x + 42, y + 4, 150, 30), "WantedSans-ExtraBold.otf", 22, 14)
        item = stat.get(key, {})
        value = f"{int(item.get('count', 0))} · {float(item.get('pct', 0)):.1f}%"
        fit_one_line(draw, value, Box(legend.x + 205, y + 4, legend.w - 205, 30), "WantedSans-ExtraBold.otf", 21, 13, align="right")


def draw_rebound_definitions(draw: ImageDraw.ImageDraw, box: Box) -> None:
    panel(draw, box, radius=18)
    cols = [
        (GREEN, "공리", "상대 지역에서 리바운드\n높을수록 공격권 유지"),
        (BLUE, "수리", "우리 지역에서 리바운드\n높을수록 수비 마무리"),
        (RED, "리바운드 허용", "우리 지역에서 리바운드 허용\n낮을수록 세컨 찬스 억제"),
    ]
    col_w = box.w // 3
    for index, (color, title, desc) in enumerate(cols):
        col = Box(box.x + index * col_w + 34, box.y + 40, col_w - 68, box.h - 62)
        draw.rounded_rectangle((col.x, col.y, col.x + 24, col.y + 24), radius=7, fill=color)
        fit_one_line(draw, title, Box(col.x + 40, col.y + 2, col.w - 40, 30), "WantedSans-ExtraBold.otf", 24, 16)
        draw_multiline(draw, desc, Box(col.x, col.y + 52, col.w, 54), "WantedSans-ExtraBold.otf", 16, 11, 2, fill=(255, 255, 255, 218), valign="top")


def render_rebound_control(ctx: dict[str, Any], output_dir: Path) -> Path:
    canvas = new_canvas()
    draw = ImageDraw.Draw(canvas, "RGBA")
    draw_header(canvas, draw, ctx, "04", "REBOUND CONTROL", "홈/어웨이 팀별 공리 · 수리 · 리바운드 허용 비율")
    stats = rebound_stats(ctx)

    draw_rebound_team_card(canvas, draw, Box(80, 363, 440, 520), ctx["home"], stats.get("HOME", {}))
    draw_rebound_team_card(canvas, draw, Box(580, 363, 440, 520), ctx["away"], stats.get("AWAY", {}))
    draw_rebound_definitions(draw, Box(60, 929, 960, 172))

    read = (
        f"{ctx['home']}는 공리 비중이 크고 허용이 낮습니다. "
        f"{ctx['away']}는 허용 리바운드가 큽니다."
    )
    read_box = Box(60, 1130, 960, 98)
    panel(draw, read_box, radius=18)
    draw_multiline(draw, read, read_box.inset(30, 22), "WantedSans-ExtraBold.otf", 20, 14, 2, fill=(255, 255, 255, 232), valign="center")
    draw_logo(canvas)
    path = output_dir / f"{ctx['match_id']}_04_rebound_control_card.png"
    save_card(canvas, path)
    save_card(canvas, output_dir / f"{ctx['match_id']}_04_rebound_control_card_v2.png")
    return path


def render_all(match_id: str, runtime_dir: Path, output_dir: Path) -> list[Path]:
    ctx = extract_context(match_id, runtime_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    paths = [
        render_margin_flow(ctx, output_dir),
        render_shot_map(ctx, output_dir),
        render_rebound_control(ctx, output_dir),
    ]
    summary = {
        "match_id": match_id,
        "match_name": ctx.get("match", {}).get("name"),
        "home": ctx["home"],
        "away": ctx["away"],
        "score": {
            "home": ctx["final_score"].get("HOME", 0),
            "away": ctx["final_score"].get("AWAY", 0),
        },
        "cards": ["02_margin_flow", "03_shot_map", "04_rebound_control"],
        "layout": {
            "canvas": [CANVAS_W, CANVAS_H],
            "safe_area": {
                "top": SAFE_TOP,
                "bottom": SAFE_BOTTOM,
                "left": SAFE_LEFT,
                "right": SAFE_RIGHT,
            },
            "overflow_policy": ["font_shrink", "ellipsis", "clip"],
            "fixed_layout": True,
        },
    }
    with (output_dir / f"{match_id}_basketball_cardnews_summary.json").open("w", encoding="utf-8") as fh:
        json.dump(summary, fh, ensure_ascii=False, indent=2)
    return paths


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate fixed-layout basketball card news PNGs.")
    parser.add_argument("match_id", help="Basketball match id")
    parser.add_argument("--runtime-dir", type=Path, default=DEFAULT_RUNTIME_DIR)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT_DIR)
    args = parser.parse_args()

    paths = render_all(args.match_id, args.runtime_dir, args.output_dir)
    for path in paths:
        print(path)


if __name__ == "__main__":
    main()
