from __future__ import annotations

import base64
import io
import re
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

import matplotlib
import numpy as np
import pandas as pd
from matplotlib.colors import LinearSegmentedColormap
from mplsoccer import Pitch
from PIL import Image, ImageDraw, ImageFont
from scipy.ndimage import gaussian_filter

matplotlib.use("Agg")

import matplotlib.pyplot as plt

TEMPLATE_DIR = Path("/app/templetes")
FONT_DIR = Path("/app/assets/fonts")
FONT_BOLD = FONT_DIR / "KFAGothicBold.otf"
FONT_REGULAR = FONT_DIR / "KFAGothicRegular.otf"


@dataclass(frozen=True)
class FcmCardLayout:
    output_size: tuple[int, int] = (1920, 1080)
    heatmap_box: tuple[int, int, int, int] = (73, 113, 627, 425)
    passmap_box: tuple[int, int, int, int] = (73, 629, 627, 425)
    name_center_x: int = 1195
    name_y: int = 318
    player_font_size: int = 112
    stat_x: int = 810
    stat_y: int = 558
    stat_gap: int = 94
    stat_font_size: int = 56
    bullet_radius: int = 7
    bullet_gap: int = 20
    bullet_offset_y: int = 22


DEFAULT_HEATMAP_COLORS = (
    (0.00, (0.30, 0.54, 0.42, 0.00)),
    (0.04, (0.30, 0.54, 0.42, 0.38)),
    (0.22, (0.85, 0.87, 0.31, 0.84)),
    (0.72, (0.80, 0.67, 0.29, 0.95)),
    (0.90, (0.68, 0.41, 0.32, 0.98)),
    (1.00, (0.62, 0.31, 0.29, 1.00)),
)

DEFAULT_PASS_STYLES = {
    "assist": {"color": "#FF8A3D", "alpha": 1.00, "lw": 8.0, "zorder": 4},
    "key": {"color": "#FF8A3D", "alpha": 1.00, "lw": 7.4, "zorder": 4},
    "fail": {"color": "#F15B6C", "alpha": 0.98, "lw": 6.8, "zorder": 3},
    "success": {"color": "#8ADC5E", "alpha": 0.96, "lw": 6.8, "zorder": 3},
}


@dataclass(frozen=True)
class PitchTheme:
    pitch_color: str = "none"
    line_color: str = "white"
    line_alpha: float = 1.0
    linewidth: float = 2.2
    stripe: bool = False
    shade_middle: bool = False
    line_zorder: int = 1
    tight_layout: bool = True


@dataclass(frozen=True)
class HeatmapStyle:
    figsize: tuple[float, float] = (5.8, 3.9)
    dpi: int = 360
    transparent: bool = True
    alpha: float = 1.00
    grid_size: int = 900
    point_radius_x: float = 8.2
    point_radius_y: float = 6.5
    point_falloff: float = 1.9
    point_peak_value: float = 5.2
    overlap_boost: float = 1.42
    color_cap_value: float = 6.1
    visibility_floor: float = 0.015
    alpha_power: float = 0.76
    min_alpha: float = 0.74
    blur_sigma: float = 1.35
    interpolation: str = "bicubic"
    cmap: LinearSegmentedColormap = field(
        default_factory=lambda: LinearSegmentedColormap.from_list(
            "fineplay_heat_aggressive",
            (
                (0.00, (0.30, 0.54, 0.42, 0.00)),
                (0.03, (0.30, 0.54, 0.42, 0.36)),
                (0.155, (0.86, 0.88, 0.30, 0.88)),
                (0.52, (0.83, 0.64, 0.27, 0.97)),
                (0.72, (0.70, 0.40, 0.31, 0.99)),
                (1.00, (0.58, 0.25, 0.25, 1.00)),
            ),
        )
    )


@dataclass(frozen=True)
class PassMapStyle:
    figsize: tuple[float, float] = (5.8, 3.9)
    dpi: int = 220
    transparent: bool = True
    arrow_width: float = 4.8
    headwidth: float = 5.8
    headlength: float = 6.6
    headaxislength: float = 5.2
    minlength: float = 0.6
    pass_styles: dict = field(default_factory=lambda: DEFAULT_PASS_STYLES.copy())


def _normalize_team_key(value: str) -> str:
    text = value.strip().lower()
    text = re.sub(r"\s+", "", text)
    for token in ("fc", "footballclub", "citizenfc", "citizensfc", "시민축구단", "축구단", "한수원", "wfc"):
        text = text.replace(token, "")
    return text


def find_template_path(team_name: str) -> Path | None:
    if not TEMPLATE_DIR.exists():
        return None

    normalized = _normalize_team_key(team_name)
    candidates = sorted(TEMPLATE_DIR.glob("*.png"))

    for path in candidates:
        if _normalize_team_key(path.stem) == normalized:
            return path
    for path in candidates:
        stem = _normalize_team_key(path.stem)
        if normalized in stem or stem in normalized:
            return path
    return None


def _decode_base64_image(payload: str | None) -> Image.Image | None:
    if not payload:
        return None
    raw = payload.split(",", 1)[-1]
    return Image.open(io.BytesIO(base64.b64decode(raw))).convert("RGBA")


def _buffer_to_image(buffer: io.BytesIO) -> Image.Image:
    buffer.seek(0)
    return Image.open(buffer).convert("RGBA")


def _normalize_player_value(value: object) -> str:
    text = str(value).strip()
    if text.endswith(".0"):
        try:
            as_float = float(text)
            if as_float.is_integer():
                return str(int(as_float))
        except ValueError:
            pass
    return text


def _coerce_pitch_coordinates(
    df: pd.DataFrame,
    x_col: str,
    y_col: str,
    pitch_length: float = 105.0,
    pitch_width: float = 68.0,
) -> pd.DataFrame:
    coords = df.copy()
    coords[x_col] = pd.to_numeric(coords[x_col], errors="coerce")
    coords[y_col] = pd.to_numeric(coords[y_col], errors="coerce")
    coords = coords.dropna(subset=[x_col, y_col])
    if coords.empty:
        return coords

    max_x = coords[x_col].max()
    max_y = coords[y_col].max()

    if max_x <= 1.2 and max_y <= 1.2:
        coords[x_col] = coords[x_col] * pitch_length
        coords[y_col] = coords[y_col] * pitch_width
    elif max_x <= pitch_length + 0.5 and max_y <= pitch_width + 0.5:
        pass
    elif max_x <= 100.5 and max_y <= 100.5:
        coords[x_col] = coords[x_col] * (pitch_length / 100.0)
        coords[y_col] = coords[y_col] * (pitch_width / 100.0)

    coords[x_col] = coords[x_col].clip(0, pitch_length)
    coords[y_col] = coords[y_col].clip(0, pitch_width)
    return coords


def _classify_pass_tag(tags: object) -> str:
    if pd.isna(tags):
        return "success"
    tokens = {
        token.strip()
        for token in (
            str(tags)
            .replace("/", ",")
            .replace("|", ",")
            .replace(";", ",")
            .strip()
            .lower()
            .split(",")
        )
        if token.strip()
    }
    joined = " ".join(sorted(tokens))
    if "assist" in tokens or "assist" in joined:
        return "assist"
    if "key" in tokens or "key pass" in joined or "chance created" in joined:
        return "key"
    if "fail" in tokens or "unsuccessful" in tokens or "incomplete" in joined:
        return "fail"
    return "success"


def _build_pitch(
    pitch_theme: PitchTheme,
    figsize: tuple[float, float],
):
    pitch = Pitch(
        pitch_type="custom",
        pitch_length=105,
        pitch_width=68,
        pad_left=0,
        pad_right=0,
        pad_top=0,
        pad_bottom=0,
        pitch_color=pitch_theme.pitch_color,
        line_color=pitch_theme.line_color,
        linewidth=pitch_theme.linewidth,
        stripe=pitch_theme.stripe,
        shade_middle=pitch_theme.shade_middle,
        line_zorder=pitch_theme.line_zorder,
        corner_arcs=True,
    )
    fig, ax = pitch.draw(figsize=figsize, tight_layout=pitch_theme.tight_layout)
    fig.patch.set_alpha(0)
    ax.set_axis_off()
    return fig, ax


def _render_reference_heatmap(workbook_bytes: bytes, player_id: str) -> Image.Image | None:
    df = pd.read_excel(io.BytesIO(workbook_bytes), sheet_name="Data")
    df["Player"] = df["Player"].map(_normalize_player_value)
    player_df = df.loc[df["Player"] == _normalize_player_value(player_id)].copy()
    player_df = _coerce_pitch_coordinates(player_df, "StartX_adj", "StartY_adj")
    if len(player_df) < 3:
        return None

    style = HeatmapStyle()
    fig, ax = _build_pitch(PitchTheme(), style.figsize)
    x = player_df["StartX_adj"].to_numpy()
    y = player_df["StartY_adj"].to_numpy()
    grid_x, grid_y = np.mgrid[0:105:complex(style.grid_size), 0:68:complex(style.grid_size)]
    density = np.zeros_like(grid_x, dtype=float)

    for point_x, point_y in zip(x, y):
        dx = (grid_x - point_x) / style.point_radius_x
        dy = (grid_y - point_y) / style.point_radius_y
        distance = np.sqrt(dx**2 + dy**2)
        blob = (np.clip(1 - distance, 0, 1) ** style.point_falloff) * style.point_peak_value
        density += blob

    if density.max() <= 0:
        plt.close(fig)
        return None

    density = np.where(density > style.point_peak_value, density * style.overlap_boost, density)
    density = gaussian_filter(density, sigma=style.blur_sigma)
    color_density = np.clip(density / style.color_cap_value, 0, 1)
    visible_density = np.clip(
        (density - style.visibility_floor) / max(1e-9, style.color_cap_value - style.visibility_floor),
        0,
        1,
    )
    rgba = style.cmap(color_density)
    rgba[..., 3] = np.where(
        visible_density > 0,
        (style.min_alpha + (1 - style.min_alpha) * (visible_density ** style.alpha_power)) * style.alpha,
        0,
    )
    rgba[visible_density <= 0, 3] = 0
    ax.imshow(
        np.transpose(rgba, (1, 0, 2)),
        origin="lower",
        extent=(0, 105, 0, 68),
        interpolation=style.interpolation,
        zorder=2,
    )

    buffer = io.BytesIO()
    fig.savefig(buffer, dpi=style.dpi, transparent=style.transparent)
    plt.close(fig)
    return _buffer_to_image(buffer)


def _render_reference_passmap(workbook_bytes: bytes, player_id: str) -> Image.Image | None:
    df = pd.read_excel(io.BytesIO(workbook_bytes), sheet_name="Data")
    df["Player"] = df["Player"].map(_normalize_player_value)
    player_df = df.loc[df["Player"] == _normalize_player_value(player_id)].copy()
    passes = player_df[player_df["Action"].astype(str).isin(["Pass", "Cross"])].copy()
    passes = _coerce_pitch_coordinates(passes, "StartX_adj", "StartY_adj")
    if passes.empty:
        return None

    end_coords = _coerce_pitch_coordinates(passes, "EndX_adj", "EndY_adj")
    if end_coords.empty:
        return None
    end_coords["pass_category"] = end_coords["Tags"].apply(_classify_pass_tag)

    style = PassMapStyle()
    fig, ax = _build_pitch(PitchTheme(), style.figsize)
    for category, style_config in style.pass_styles.items():
        category_df = end_coords.loc[end_coords["pass_category"] == category]
        if category_df.empty:
            continue
        dx = category_df["EndX_adj"] - category_df["StartX_adj"]
        dy = category_df["EndY_adj"] - category_df["StartY_adj"]
        ax.quiver(
            category_df["StartX_adj"],
            category_df["StartY_adj"],
            dx,
            dy,
            angles="xy",
            scale_units="xy",
            scale=1,
            color=style_config["color"],
            alpha=style_config["alpha"],
            width=style.arrow_width / 1000.0,
            headwidth=style.headwidth,
            headlength=style.headlength,
            headaxislength=style.headaxislength,
            minlength=style.minlength,
            linewidths=style_config["lw"],
            zorder=style_config["zorder"],
        )

    buffer = io.BytesIO()
    fig.savefig(buffer, dpi=style.dpi, transparent=style.transparent)
    plt.close(fig)
    return _buffer_to_image(buffer)


def render_reference_heatmap(workbook_bytes: bytes, player_id: str) -> Image.Image | None:
    return _render_reference_heatmap(workbook_bytes, player_id)


def render_reference_passmap(workbook_bytes: bytes, player_id: str) -> Image.Image | None:
    return _render_reference_passmap(workbook_bytes, player_id)


def _fit_to_box(image: Image.Image, box: tuple[int, int, int, int]) -> Image.Image:
    _, _, target_w, target_h = box
    source_w, source_h = image.size
    scale = min(target_w / source_w, target_h / source_h)
    resized = image.resize(
        (max(1, int(round(source_w * scale))), max(1, int(round(source_h * scale)))),
        Image.Resampling.LANCZOS,
    )
    canvas = Image.new("RGBA", (target_w, target_h), (0, 0, 0, 0))
    offset_x = (target_w - resized.size[0]) // 2
    offset_y = (target_h - resized.size[1]) // 2
    canvas.alpha_composite(resized, (offset_x, offset_y))
    return canvas


def _draw_shadowed_text(
    draw: ImageDraw.ImageDraw,
    position: tuple[int, int],
    text: str,
    font: ImageFont.FreeTypeFont,
    fill: str = "white",
) -> None:
    draw.text(position, text, font=font, fill=fill)


def _load_fonts(layout: FcmCardLayout) -> tuple[ImageFont.FreeTypeFont, ImageFont.FreeTypeFont]:
    return (
        ImageFont.truetype(str(FONT_BOLD), layout.player_font_size),
        ImageFont.truetype(str(FONT_REGULAR), layout.stat_font_size),
    )


def build_card_image(
    *,
    background_path: Path,
    player_id: str,
    player_name: str,
    selected_stats: list[str],
    workbook_bytes: bytes | None = None,
    layout: FcmCardLayout | None = None,
) -> bytes:
    card_layout = layout or FcmCardLayout()
    player_font, stat_font = _load_fonts(card_layout)

    background = Image.open(background_path).convert("RGBA")
    if background.size != card_layout.output_size:
        background = background.resize(card_layout.output_size, Image.Resampling.LANCZOS)

    composite = background.copy()

    if workbook_bytes:
        try:
            heatmap = _render_reference_heatmap(workbook_bytes, player_id)
            passmap = _render_reference_passmap(workbook_bytes, player_id)
            if heatmap:
                heatmap_layer = _fit_to_box(heatmap, card_layout.heatmap_box)
                composite.alpha_composite(heatmap_layer, (card_layout.heatmap_box[0], card_layout.heatmap_box[1]))
            if passmap:
                passmap_layer = _fit_to_box(passmap, card_layout.passmap_box)
                composite.alpha_composite(passmap_layer, (card_layout.passmap_box[0], card_layout.passmap_box[1]))
        except Exception:
            pass

    draw = ImageDraw.Draw(composite)
    title_text = f"NO.{player_id} {player_name}"
    title_box = draw.textbbox((0, 0), title_text, font=player_font)
    title_x = card_layout.name_center_x - ((title_box[2] - title_box[0]) // 2)
    _draw_shadowed_text(draw, (title_x, card_layout.name_y), title_text, player_font)

    for index, stat in enumerate(selected_stats[:5]):
        y = card_layout.stat_y + (index * card_layout.stat_gap)
        bullet_top = y + card_layout.bullet_offset_y
        bullet_left = card_layout.stat_x
        draw.ellipse(
            (
                bullet_left,
                bullet_top,
                bullet_left + (card_layout.bullet_radius * 2),
                bullet_top + (card_layout.bullet_radius * 2),
            ),
            fill="white",
        )
        _draw_shadowed_text(
            draw,
            (card_layout.stat_x + (card_layout.bullet_radius * 2) + card_layout.bullet_gap, y),
            stat,
            stat_font,
        )

    output = io.BytesIO()
    composite.save(output, format="PNG")
    output.seek(0)
    return output.getvalue()


def build_cards_zip(card_payloads: list[tuple[str, bytes]]) -> bytes:
    zip_buffer = io.BytesIO()
    with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for filename, card_bytes in card_payloads:
            archive.writestr(filename, card_bytes)
    zip_buffer.seek(0)
    return zip_buffer.getvalue()
