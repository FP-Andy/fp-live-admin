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

REPOSITORY_ROOT = Path(__file__).resolve().parents[3]
TEMPLATE_DIR = Path("/app/templetes") if Path("/app/templetes").exists() else REPOSITORY_ROOT / "templetes"
FONT_DIR = Path("/app/assets/fonts") if Path("/app/assets/fonts").exists() else REPOSITORY_ROOT / "assets/fonts"
FONT_BOLD = FONT_DIR / "KFAGothicBold.otf"
FONT_REGULAR = FONT_DIR / "KFAGothicRegular.otf"
GOALKEEPER_ASSET_DIR = (
    Path("/app/assets/fcm/goalkeeper")
    if Path("/app/assets/fcm/goalkeeper").exists()
    else REPOSITORY_ROOT / "assets/fcm/goalkeeper"
)
GOALKEEPER_TEMPLATE_PATH = GOALKEEPER_ASSET_DIR / "template.png"
PAPERLOGY_REGULAR = FONT_DIR / "Paperlogy-4Regular.ttf"
PAPERLOGY_BOLD = FONT_DIR / "Paperlogy-7Bold.ttf"
PAPERLOGY_EXTRABOLD = FONT_DIR / "Paperlogy-8ExtraBold.ttf"


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


def _load_paperlogy_font(path: Path, size: int) -> ImageFont.FreeTypeFont:
    """Use the supplied Paperlogy family with a safe local fallback."""
    try:
        return ImageFont.truetype(str(path), size)
    except OSError:
        return ImageFont.truetype(str(FONT_BOLD if path != PAPERLOGY_REGULAR else FONT_REGULAR), size)


def _fit_logo_to_box(image: Image.Image, box_size: tuple[int, int]) -> Image.Image:
    max_w, max_h = box_size
    logo = image.convert("RGBA")
    logo.thumbnail((max_w, max_h), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", box_size, (0, 0, 0, 0))
    canvas.alpha_composite(logo, ((max_w - logo.width) // 2, (max_h - logo.height) // 2))
    return canvas


def _goalkeeper_event_markers(workbook_bytes: bytes, player_id: str) -> tuple[list[tuple[float, float]], list[tuple[float, float]]]:
    """Return save/conceded marker coordinates mapped into a 0..1 goal mouth.

    FPA currently stores pitch coordinates rather than a dedicated goal-mouth
    coordinate. The lateral Y value is therefore used as the reliable horizontal
    position; the distance to the goal becomes a gentle vertical offset. This
    keeps the save map informative now and is forward compatible with a future
    goal-mouth x/y field.
    """
    df = pd.read_excel(io.BytesIO(workbook_bytes), sheet_name="Data")
    if df.empty or "Player" not in df.columns or "Action" not in df.columns:
        return [], []
    df["Player"] = df["Player"].map(_normalize_player_value)
    player_df = df.loc[df["Player"] == _normalize_player_value(player_id)].copy()
    if player_df.empty:
        return [], []

    team_values = player_df.get("Team", pd.Series("", index=player_df.index)).dropna().astype(str)
    player_team = team_values.mode().iloc[0] if not team_values.empty else ""
    action_labels = player_df["Action"].fillna("").astype(str).str.strip().str.lower()
    player_tags = player_df.get("Tags", pd.Series("", index=player_df.index)).fillna("").astype(str)
    save_rows = player_df.loc[(action_labels == "save") & ~player_tags.str.contains("penalty", case=False, regex=False)]

    opponent_df = df.copy()
    if player_team and "Team" in opponent_df.columns:
        opponent_df = opponent_df.loc[opponent_df["Team"].fillna("").astype(str) != player_team]
    opponent_action = opponent_df.get("Action", pd.Series("", index=opponent_df.index)).fillna("").astype(str).str.lower()
    opponent_tags = opponent_df.get("Tags", pd.Series("", index=opponent_df.index)).fillna("").astype(str).str.lower()
    opponent_result = opponent_df.get("Result", pd.Series("", index=opponent_df.index)).fillna("").astype(str).str.lower()
    goal_rows = opponent_df.loc[
        opponent_action.isin({"goal", "scored"})
        | opponent_tags.str.contains(r"(?:^|[,|;/\s])goal(?:$|[,|;/\s])", regex=True)
        | opponent_result.str.contains("goal", regex=False)
    ]

    def to_goal_coords(rows: pd.DataFrame) -> list[tuple[float, float]]:
        if rows.empty:
            return []
        y_col = "StartY_adj" if "StartY_adj" in rows.columns else "StartY"
        x_col = "StartX_adj" if "StartX_adj" in rows.columns else "StartX"
        points: list[tuple[float, float]] = []
        for index, row in rows.iterrows():
            raw_y = pd.to_numeric(row.get(y_col), errors="coerce")
            raw_x = pd.to_numeric(row.get(x_col), errors="coerce")
            if pd.isna(raw_y):
                raw_y = 34.0
            if raw_y <= 1.2:
                raw_y *= 68.0
            elif raw_y > 68.5 and raw_y <= 100.5:
                raw_y *= 0.68
            horizontal = float(np.clip(raw_y / 68.0, 0.06, 0.94))
            if pd.isna(raw_x):
                vertical = 0.50
            else:
                if raw_x <= 1.2:
                    raw_x *= 105.0
                elif raw_x > 105.5 and raw_x <= 1000:
                    raw_x = raw_x / 100.0 * 105.0
                distance_to_goal = min(float(raw_x), max(0.0, 105.0 - float(raw_x)))
                vertical = float(np.clip(0.30 + distance_to_goal / 32.0, 0.20, 0.76))
            points.append((horizontal, vertical))
        return points

    return to_goal_coords(save_rows), to_goal_coords(goal_rows)


def _draw_goalkeeper_penalties(
    draw: ImageDraw.ImageDraw,
    position: tuple[int, int],
    penalties: list[str],
    font: ImageFont.FreeTypeFont,
) -> None:
    if not penalties:
        return
    x, y = position
    label = "승부차기 :"
    draw.text((x, y), label, font=font, fill="white")
    label_box = draw.textbbox((x, y), label, font=font)
    cursor = label_box[2] + 18
    for value in penalties[:10]:
        normalized = str(value).upper()
        color = "#00C653" if normalized == "O" else "#FF1616"
        draw.text((cursor, y), normalized, font=font, fill=color)
        cursor += draw.textlength(normalized, font=font) + 5


def build_goalkeeper_card_image(
    *,
    player_id: str,
    player_name: str,
    selected_stats: list[str],
    workbook_bytes: bytes | None,
    team_logo_path: Path | None = None,
    background_path: Path | None = None,
    replace_template_logo: bool = True,
    penalty_shootout: list[str] | None = None,
) -> bytes:
    """Build the 1920×1080 Paperlogy goalkeeper card from the supplied design."""
    template_path = background_path if background_path and background_path.exists() else GOALKEEPER_TEMPLATE_PATH
    if not template_path.exists():
        raise ValueError("골키퍼 카드 기본 템플릿을 찾을 수 없습니다")
    composite = Image.open(template_path).convert("RGBA")
    if composite.size != (1920, 1080):
        composite = composite.resize((1920, 1080), Image.Resampling.LANCZOS)

    # The bundled design reference contains a sample crest. For the automatic
    # fallback, remove only that area and overlay the actual match logo.
    if replace_template_logo:
        logo_mask = Image.new("RGBA", (400, 280), "#14192d")
        composite.alpha_composite(logo_mask, (1450, 50))
    if team_logo_path and team_logo_path.exists():
        try:
            logo = _fit_logo_to_box(Image.open(team_logo_path), (220, 220))
            composite.alpha_composite(logo, (1520, 84))
        except Exception:
            pass

    goal_path = GOALKEEPER_ASSET_DIR / "goal.png"
    save_path = GOALKEEPER_ASSET_DIR / "save.png"
    conceded_path = GOALKEEPER_ASSET_DIR / "conceded.png"
    if goal_path.exists():
        composite.alpha_composite(Image.open(goal_path).convert("RGBA"), (255, 222))

    if workbook_bytes:
        try:
            save_points, conceded_points = _goalkeeper_event_markers(workbook_bytes, player_id)
            if save_path.exists():
                marker = Image.open(save_path).convert("RGBA")
                for horizontal, vertical in save_points:
                    x = int(311 + (656 * horizontal) - marker.width / 2)
                    y = int(281 + (292 * vertical) - marker.height / 2)
                    composite.alpha_composite(marker, (x, y))
            if conceded_path.exists():
                marker = Image.open(conceded_path).convert("RGBA")
                for horizontal, vertical in conceded_points:
                    x = int(311 + (656 * horizontal) - marker.width / 2)
                    y = int(281 + (292 * vertical) - marker.height / 2)
                    composite.alpha_composite(marker, (x, y))
        except Exception:
            # A map failure must not prevent an otherwise usable card export.
            pass

    draw = ImageDraw.Draw(composite)
    name_font = _load_paperlogy_font(PAPERLOGY_EXTRABOLD, 92)
    stat_font = _load_paperlogy_font(PAPERLOGY_BOLD, 46)
    stat_small_font = _load_paperlogy_font(PAPERLOGY_BOLD, 37)
    number_name = f"NO.{player_id} {player_name}".strip()
    max_name_width = 760
    while draw.textlength(number_name, font=name_font) > max_name_width and name_font.size > 58:
        name_font = _load_paperlogy_font(PAPERLOGY_EXTRABOLD, name_font.size - 2)
    name_width = draw.textlength(number_name, font=name_font)
    draw.text((1450 - name_width / 2, 428), number_name, font=name_font, fill="white")

    visible_stats = [stat.strip() for stat in selected_stats if stat and stat.strip()][:5]
    rows = [visible_stats[0:2], visible_stats[2:4], visible_stats[4:5]]
    row_y = (756, 842, 929)
    columns = (260, 960)
    for row_index, stats in enumerate(rows):
        for column_index, stat in enumerate(stats):
            font = stat_font if len(stat) <= 28 else stat_small_font
            x = columns[column_index]
            if row_index == 0 and column_index == 0 and stat.startswith("실점") and conceded_path.exists():
                icon = Image.open(conceded_path).convert("RGBA")
                composite.alpha_composite(icon, (x, row_y[row_index] + 7))
                x += 62
            draw.text((x, row_y[row_index]), stat, font=font, fill="white")

    _draw_goalkeeper_penalties(
        draw,
        (960, row_y[2]),
        penalty_shootout or [],
        stat_font,
    )
    output = io.BytesIO()
    composite.save(output, format="PNG")
    return output.getvalue()


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
    card_type: str = "PLAYER",
    penalty_shootout: list[str] | None = None,
    team_logo_path: Path | None = None,
    replace_template_logo: bool = False,
) -> bytes:
    if card_type.upper() == "GOALKEEPER":
        return build_goalkeeper_card_image(
            player_id=player_id,
            player_name=player_name,
            selected_stats=selected_stats,
            workbook_bytes=workbook_bytes,
            team_logo_path=team_logo_path,
            background_path=background_path,
            replace_template_logo=replace_template_logo,
            penalty_shootout=penalty_shootout,
        )
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
