/// <reference lib="webworker" />

import {
  classifyPoseWindow,
} from "../lib/pose-lite-classifier";
import { assessMotionWindow } from "../lib/motion-technique";
import { assessFootworkWindow } from "../lib/footwork-analysis";
import type {
  VisionWorkerIncoming,
  VisionWorkerOutgoing,
} from "../lib/vision-worker-protocol";
import type { PoseLandmarker as PoseLandmarkerInstance } from "@mediapipe/tasks-vision";

let landmarker: PoseLandmarkerInstance | null = null;

function respond(message: VisionWorkerOutgoing) {
  self.postMessage(message);
}

self.onmessage = async (event: MessageEvent<VisionWorkerIncoming>) => {
  if (event.data.type === "ping") {
    respond({ type: "ready" });
    return;
  }
  if (event.data.type === "initialize") {
    try {
      if (!landmarker) {
        const { FilesetResolver, PoseLandmarker } = await import("@mediapipe/tasks-vision");
        const vision = await FilesetResolver.forVisionTasks(event.data.wasmUrl);
        landmarker = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: event.data.modelUrl, delegate: "CPU" },
          runningMode: "VIDEO",
          numPoses: 1,
          minPoseDetectionConfidence: 0.48,
          minPosePresenceConfidence: 0.48,
          minTrackingConfidence: 0.5,
        });
        respond({ type: "initialized", connections: PoseLandmarker.POSE_CONNECTIONS });
      } else {
        const { PoseLandmarker } = await import("@mediapipe/tasks-vision");
        respond({ type: "initialized", connections: PoseLandmarker.POSE_CONNECTIONS });
      }
    } catch (error) {
      respond({
        type: "error",
        stage: "initialize",
        message: error instanceof Error ? error.message : "Worker vision initialization failed",
      });
    }
    return;
  }
  if (event.data.type === "detect") {
    try {
      if (!landmarker) throw new Error("Vision model is not initialized");
      const result = landmarker.detectForVideo(event.data.frame, event.data.timestamp);
      const poses = result.landmarks.map((landmarks, index) => ({
        landmarks,
        worldLandmarks: result.worldLandmarks[index],
      }));
      respond({
        type: "frame",
        requestId: event.data.requestId,
        timestamp: event.data.timestamp,
        poses,
      });
    } catch (error) {
      respond({
        type: "error",
        requestId: event.data.requestId,
        stage: "detect",
        message: error instanceof Error ? error.message : "Worker pose detection failed",
      });
    } finally {
      event.data.frame.close();
    }
    return;
  }
  if (event.data.type === "analyze") {
    respond({
      type: "result",
      requestId: event.data.requestId,
      result: classifyPoseWindow(event.data.samples, { drillMode: event.data.drillMode }),
    });
    return;
  }
  if (event.data.type === "analyzeMotion") {
    respond({
      type: "motionResult",
      requestId: event.data.requestId,
      result: assessMotionWindow(event.data.samples, event.data.mode, event.data.dominantSide),
    });
    return;
  }
  if (event.data.type === "analyzeFootwork") {
    respond({
      type: "footworkResult",
      requestId: event.data.requestId,
      result: assessFootworkWindow(event.data.samples, event.data.mode, event.data.dominantSide),
    });
    return;
  }
  if (event.data.type === "close") {
    landmarker?.close();
    landmarker = null;
  }
};

export {};
