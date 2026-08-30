import type { PoseLandmark } from "./pose-metrics";
import type {
  DrillMode,
  PoseLiteResult,
  PoseLiteSample,
} from "./pose-lite-classifier";
import type { FootworkMode, MotionAssessment, TechniqueMode } from "./motion-technique";
import type { DominantSide } from "./pose-metrics";

export type VisionWorkerIncoming =
  | { type: "ping" }
  | { type: "initialize"; wasmUrl: string; modelUrl: string }
  | { type: "detect"; requestId: string; frame: ImageBitmap; timestamp: number }
  | { type: "analyze"; requestId: string; samples: PoseLiteSample[]; drillMode: DrillMode }
  | { type: "analyzeMotion"; requestId: string; samples: PoseLiteSample[]; mode: TechniqueMode; dominantSide: DominantSide }
  | { type: "analyzeFootwork"; requestId: string; samples: PoseLiteSample[]; mode: FootworkMode; dominantSide: DominantSide }
  | { type: "close" };

export type VisionWorkerPose = {
  landmarks: PoseLandmark[];
  worldLandmarks?: PoseLandmark[];
};

export type VisionWorkerOutgoing =
  | { type: "ready" }
  | { type: "initialized"; connections: Array<{ start: number; end: number }> }
  | { type: "frame"; requestId: string; timestamp: number; poses: VisionWorkerPose[] }
  | { type: "result"; requestId: string; result: PoseLiteResult }
  | { type: "motionResult"; requestId: string; result: MotionAssessment }
  | { type: "footworkResult"; requestId: string; result: MotionAssessment }
  | { type: "error"; requestId?: string; stage: "initialize" | "detect"; message: string };
