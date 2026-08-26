from __future__ import annotations

from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict, Field

from classifier import classify_stroke
from rally import CourtPoint, analyze_trajectory, summarize_rally


app = FastAPI(
    title="SmashLab Analysis API",
    version="0.2.0",
    description="Pose and contact-trajectory analysis for the SmashLab rally MVP.",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
)


class PoseMetricsRequest(BaseModel):
    model_config = ConfigDict(alias_generator=lambda name: "".join(
        word.capitalize() if index else word
        for index, word in enumerate(name.split("_"))
    ), populate_by_name=True)

    wrist_speed: float = Field(ge=0, le=20)
    elbow_angle: float = Field(ge=0, le=180)
    shoulder_angle: float = Field(ge=0, le=180)
    contact_height: float = Field(ge=0, le=100)
    arm_angular_speed: float = Field(default=0, ge=0, le=5000)
    body_extension: float = Field(default=0, ge=0, le=100)
    wrist_above_shoulder: bool = False
    is_contact: bool


class AnalysisResponse(BaseModel):
    model_config = ConfigDict(alias_generator=lambda name: "".join(
        word.capitalize() if index else word
        for index, word in enumerate(name.split("_"))
    ), populate_by_name=True)

    stroke_type: str
    stroke_label: str
    confidence: float
    estimated_shuttle_speed_kmh: float | None
    speed_status: str


class CourtPointPayload(BaseModel):
    x: float = Field(ge=-0.2, le=1.2)
    y: float = Field(ge=-0.2, le=1.2)


class RallyStrokeRequest(BaseModel):
    model_config = ConfigDict(alias_generator=lambda name: "".join(
        word.capitalize() if index else word
        for index, word in enumerate(name.split("_"))
    ), populate_by_name=True)

    index: int = Field(ge=1)
    hitter: str = Field(pattern="^[ABab]$")
    pose_stroke_type: str = "unknown"
    pose_stroke_label: str = "Chưa phân loại"
    wrist_speed: float = Field(default=0, ge=0, le=20)
    arm_angular_speed: float = Field(default=0, ge=0, le=5000)
    contact_height: float = Field(default=0, ge=0, le=100)
    body_extension: float = Field(default=0, ge=0, le=100)
    wrist_above_shoulder: bool = False
    start: CourtPointPayload
    end: CourtPointPayload
    source_confidence: float = Field(default=0.7, ge=0, le=1)


class RallyStrokeResponse(BaseModel):
    model_config = ConfigDict(alias_generator=lambda name: "".join(
        word.capitalize() if index else word
        for index, word in enumerate(name.split("_"))
    ), populate_by_name=True)

    index: int
    hitter: str
    stroke_type: str
    stroke_label: str
    stroke_variant: str
    stroke_variant_label: str | None
    classification_status: str
    classification_basis: str
    estimated_shuttle_speed_kmh: float | None
    start: CourtPointPayload
    end: CourtPointPayload
    length_type: str
    length_label: str
    direction_type: str
    direction_label: str
    landing_zone: str
    court_distance_m: float
    confidence: float


class RallySummaryRequest(BaseModel):
    strokes: list[RallyStrokeResponse]


class RallySummaryResponse(BaseModel):
    model_config = ConfigDict(alias_generator=lambda name: "".join(
        word.capitalize() if index else word
        for index, word in enumerate(name.split("_"))
    ), populate_by_name=True)

    headline: str
    insight: str
    dominant_pattern: str
    long_rate: float
    cross_rate: float
    analysis_version: str = "rally-pose-trajectory-v2"


@app.get("/api")
def api_info() -> dict[str, str]:
    return {
        "name": "SmashLab Analysis API",
        "version": "0.2.0",
        "docs": "/api/docs",
    }


@app.get("/api/health")
def health() -> dict[str, str | bool]:
    return {
        "ok": True,
        "service": "python-fastapi",
        "mode": "pose-plus-contact-trajectory",
    }


@app.post("/api/analyze", response_model=AnalysisResponse)
def analyze_pose_metrics(payload: PoseMetricsRequest) -> AnalysisResponse:
    result = classify_stroke(
        wrist_speed=payload.wrist_speed,
        elbow_angle=payload.elbow_angle,
        shoulder_angle=payload.shoulder_angle,
        contact_height=payload.contact_height,
        arm_angular_speed=payload.arm_angular_speed,
        body_extension=payload.body_extension,
        wrist_above_shoulder=payload.wrist_above_shoulder,
        is_contact=payload.is_contact,
    )
    return AnalysisResponse(
        stroke_type=result.stroke_type,
        stroke_label=result.stroke_label,
        confidence=result.confidence,
        estimated_shuttle_speed_kmh=result.estimated_shuttle_speed_kmh,
        speed_status=(
            "pose_estimate"
            if result.estimated_shuttle_speed_kmh is not None
            else "not_available"
        ),
    )


@app.post("/api/rally/stroke", response_model=RallyStrokeResponse)
def analyze_rally_stroke(payload: RallyStrokeRequest) -> RallyStrokeResponse:
    result = analyze_trajectory(
        hitter=payload.hitter,
        start=CourtPoint(payload.start.x, payload.start.y),
        end=CourtPoint(payload.end.x, payload.end.y),
        source_confidence=payload.source_confidence,
        wrist_speed=payload.wrist_speed,
        arm_angular_speed=payload.arm_angular_speed,
        contact_height=payload.contact_height,
        body_extension=payload.body_extension,
        wrist_above_shoulder=payload.wrist_above_shoulder,
    )
    return RallyStrokeResponse(
        index=payload.index,
        hitter=payload.hitter.upper(),
        stroke_type=result.stroke_type,
        stroke_label=result.stroke_label,
        stroke_variant=result.stroke_variant,
        stroke_variant_label=result.stroke_variant_label,
        classification_status=result.classification_status,
        classification_basis=result.classification_basis,
        estimated_shuttle_speed_kmh=result.estimated_shuttle_speed_kmh,
        start=payload.start,
        end=payload.end,
        length_type=result.length_type,
        length_label=result.length_label,
        direction_type=result.direction_type,
        direction_label=result.direction_label,
        landing_zone=result.landing_zone,
        court_distance_m=result.court_distance_m,
        confidence=result.confidence,
    )


@app.post("/api/rally/summary", response_model=RallySummaryResponse)
def analyze_rally_summary(payload: RallySummaryRequest) -> RallySummaryResponse:
    summary = summarize_rally([
        {
            "length_type": stroke.length_type,
            "direction_type": stroke.direction_type,
        }
        for stroke in payload.strokes
    ])
    return RallySummaryResponse(**summary)
