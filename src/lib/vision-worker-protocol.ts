import type { PoseLandmark } from "./pose-metrics";
import type {
  DrillMode,
  PoseLiteResult,
  PoseLiteSample,
} from "./pose-lite-classifier";

export type VisionWorkerIncoming =
  | { type: "ping" }
  | { type: "initialize"; wasmUrl: string; modelUrl: string }
  | { type: "detect"; requestId: string; frame: ImageBitmap; timestamp: number }
  | { type: "analyze"; requestId: string; samples: PoseLiteSample[]; drillMode: DrillMode }
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
  | { type: "error"; requestId?: string; stage: "initialize" | "detect"; message: string };
