from __future__ import annotations

from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict, Field

from classifier import classify_stroke


app = FastAPI(
    title="SmashLab Analysis API",
    version="0.1.0",
    description="Lightweight pose-metric analysis for the SmashLab MVP.",
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


@app.get("/api")
def api_info() -> dict[str, str]:
    return {
        "name": "SmashLab Analysis API",
        "version": "0.1.0",
        "docs": "/api/docs",
    }


@app.get("/api/health")
def health() -> dict[str, str | bool]:
    return {
        "ok": True,
        "service": "python-fastapi",
        "mode": "pose-metrics",
    }


@app.post("/api/analyze", response_model=AnalysisResponse)
def analyze_pose_metrics(payload: PoseMetricsRequest) -> AnalysisResponse:
    result = classify_stroke(
        wrist_speed=payload.wrist_speed,
        elbow_angle=payload.elbow_angle,
        shoulder_angle=payload.shoulder_angle,
        contact_height=payload.contact_height,
        is_contact=payload.is_contact,
    )
    return AnalysisResponse(
        stroke_type=result.stroke_type,
        stroke_label=result.stroke_label,
        confidence=result.confidence,
        estimated_shuttle_speed_kmh=result.estimated_shuttle_speed_kmh,
        speed_status="calibration_required",
    )
