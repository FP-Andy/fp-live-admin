from typing import Literal

from pydantic import BaseModel, Field, model_validator


class FpaDot(BaseModel):
    meter_x: float = Field(ge=0, le=105)
    meter_y: float = Field(ge=0, le=68)
    team: Literal["ally", "opponent"] | None = None
    team_side: Literal["home", "away"] | None = None
    role: str | None = Field(default=None, max_length=40)
    layer: str | None = Field(default=None, max_length=40)
    number: str | None = Field(default=None, max_length=20)
    id: str | None = Field(default=None, max_length=64)
    # 등번호 식별 불확실 — 영상으로 번호를 확정하지 못해 추측으로 찍었다는 표시.
    needs_check: bool | None = None


class FpaPitchState(BaseModel):
    dots: list[FpaDot] = Field(default_factory=list)


class FpaDualPitchPayload(BaseModel):
    before: FpaPitchState = Field(default_factory=FpaPitchState)
    after: FpaPitchState = Field(default_factory=FpaPitchState)
    input_tier: Literal["minimal", "recommended", "rich", "full"] = "minimal"
    actor_team: Literal["home", "away"] | None = None
    primary_row_index: int | None = None


class FpaGenerateLogRequest(BaseModel):
    stat_input: str = Field(min_length=1, max_length=80)
    dots: list[FpaDot] = Field(default_factory=list)
    dual_pitch: FpaDualPitchPayload | None = None
    half: str = Field(min_length=1, max_length=20)
    team: Literal["home", "away"]
    direction: Literal["left", "right"]
    timeline: str = Field(min_length=1, max_length=20)
    sport: Literal["FOOTBALL", "FUTSAL"] = "FOOTBALL"

    @model_validator(mode="after")
    def validate_pitch_coordinates(self):
        """풋살 태깅은 화면·저장·분석 모두 40×20m 실좌표만 받는다."""
        if self.sport != "FUTSAL":
            return self
        dots = [*self.dots]
        if self.dual_pitch:
            dots.extend(self.dual_pitch.before.dots)
            dots.extend(self.dual_pitch.after.dots)
        for dot in dots:
            if dot.meter_x > 40 or dot.meter_y > 20:
                raise ValueError("풋살 FPA 좌표는 파란 코트 기준 0–40m × 0–20m여야 합니다.")
        return self


class FpaGenerateLogResponse(BaseModel):
    log_text: str
    log_data: dict[str, str]


class FpaExportLogsRequest(BaseModel):
    logs: list[str] = Field(default_factory=list)
    rows: list[dict[str, str]] = Field(default_factory=list)
    match_id: str = ""
    teamid_h: str = ""
    teamid_a: str = ""
    sport: Literal["FOOTBALL", "FUTSAL"] = "FOOTBALL"


class FpaVisualizeResponse(BaseModel):
    pass_map: str | None
    heatmap: str | None
    combined_map: str | None


class FpaPlayersResponse(BaseModel):
    players: list[str]


class FpaImportLogsResponse(BaseModel):
    logs: list[str]
    rows: list[dict[str, str]]
    match_id: str = ""
    teamid_h: str = ""
    teamid_a: str = ""


class FpaSavedLogsRequest(BaseModel):
    logs: list[str] = Field(default_factory=list)
    rows: list[dict[str, str]] = Field(default_factory=list)
    teamid_h: str = ""
    teamid_a: str = ""


class FpaSavedLogsResponse(BaseModel):
    match_id: str
    logs: list[str] = Field(default_factory=list)
    rows: list[dict[str, str]] = Field(default_factory=list)
    teamid_h: str = ""
    teamid_a: str = ""
    updated_at: str | None = None


class FcmAnalyzedPlayer(BaseModel):
    player_id: str
    player_name: str = ""
    team: str = ""
    ranking_score: float = 0
    candidates: list[str] = Field(default_factory=list)
    is_goalkeeper: bool = False


class FcmAnalyzeWorkbookResponse(BaseModel):
    players: list[FcmAnalyzedPlayer] = Field(default_factory=list)
    recommended_player_id: str | None = None
