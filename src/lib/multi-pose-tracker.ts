import type { PoseLandmark } from "./pose-metrics";
import {
  appearanceDistance,
  blendAppearance,
  type PoseAppearance,
} from "./pose-appearance.ts";

export type PoseBounds = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  centerX: number;
  centerY: number;
  width: number;
  height: number;
};

export type PoseObservation = {
  landmarks: PoseLandmark[];
  worldLandmarks?: PoseLandmark[];
  appearance?: PoseAppearance;
};

export type TrackedPose = PoseObservation & {
  trackId: number;
  bounds: PoseBounds;
  confidence: number;
  stableFrames: number;
  lockConfidence: number;
  observedAppearance?: PoseAppearance;
};

export type LockedTargetMemory = {
  appearance: PoseAppearance;
  bounds: PoseBounds;
  lastSeenAt: number;
};

export type LockReacquisitionState = {
  candidateTrackId: number | null;
  consecutiveFrames: number;
  lastObservedAt: number;
};

type TrackMemory = {
  id: number;
  centerX: number;
  centerY: number;
  velocityX: number;
  velocityY: number;
  bodyScale: number;
  bounds: PoseBounds;
  confidence: number;
  stableFrames: number;
  appearance?: PoseAppearance;
  lastSeenAt: number;
};

export type MultiPoseTrackerState = {
  tracks: TrackMemory[];
  nextId: number;
};

type DetectionDescriptor = PoseObservation & {
  detectionIndex: number;
  bounds: PoseBounds;
  bodyScale: number;
  confidence: number;
};

type Assignment = { trackIndex: number; detectionIndex: number; cost: number };

const TRACK_TTL_MS = 1_100;
const LOCK_REACQUISITION_WINDOW_MS = 3_600;
const LOCK_REACQUISITION_CONFIRM_FRAMES = 3;
const MAX_REACQUISITION_FRAME_GAP_MS = 700;
const MAX_REACQUISITION_APPEARANCE_DISTANCE = 0.42;
const MIN_REACQUISITION_SCORE_MARGIN = 0.16;
const MAX_MATCH_COST = 2.8;
const UNMATCHED_TRACK_COST = 1.55;
const UNMATCHED_DETECTION_COST = 1.35;
const LANDMARKS_FOR_BOUNDS = [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
export const MIN_TARGET_LOCK_FRAMES = 5;
export const MIN_TARGET_LOCK_CONFIDENCE = 0.72;

export function createMultiPoseTrackerState(): MultiPoseTrackerState {
  return { tracks: [], nextId: 1 };
}

export function createLockReacquisitionState(): LockReacquisitionState {
  return { candidateTrackId: null, consecutiveFrames: 0, lastObservedAt: 0 };
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function calculateLockConfidence(track: TrackMemory) {
  const temporalConfidence = clamp01(track.stableFrames / (MIN_TARGET_LOCK_FRAMES + 1));
  const landmarkConfidence = clamp01((track.confidence - 0.35) / 0.55);
  const appearanceConfidence = track.appearance
    ? clamp01((track.appearance.confidence - 0.2) / 0.65)
    : 0.35;
  return clamp01(
    temporalConfidence * 0.5
    + landmarkConfidence * 0.32
    + appearanceConfidence * 0.18,
  );
}

export function isTrackedPoseLockReady(pose: TrackedPose) {
  return pose.stableFrames >= MIN_TARGET_LOCK_FRAMES
    && pose.lockConfidence >= MIN_TARGET_LOCK_CONFIDENCE;
}

function averagePoint(left: PoseLandmark | undefined, right: PoseLandmark | undefined) {
  if (!left && !right) return null;
  if (!left) return { x: right!.x, y: right!.y };
  if (!right) return { x: left.x, y: left.y };
  return { x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 };
}

function visible(point: PoseLandmark | undefined) {
  return Boolean(point && (point.visibility ?? 1) >= 0.32);
}

function describePose(observation: PoseObservation, detectionIndex: number): DetectionDescriptor | null {
  const points = LANDMARKS_FOR_BOUNDS
    .map((index) => observation.landmarks[index])
    .filter((point): point is PoseLandmark => visible(point));
  if (points.length < 6) return null;

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const left = Math.max(0, Math.min(...xs) - 0.035);
  const right = Math.min(1, Math.max(...xs) + 0.035);
  const top = Math.max(0, Math.min(...ys) - 0.045);
  const bottom = Math.min(1, Math.max(...ys) + 0.035);
  const shoulder = averagePoint(observation.landmarks[11], observation.landmarks[12]);
  const hip = averagePoint(observation.landmarks[23], observation.landmarks[24]);
  const boundsCenter = { x: (left + right) / 2, y: (top + bottom) / 2 };
  const centerX = hip && shoulder ? hip.x * 0.68 + shoulder.x * 0.32 : hip?.x ?? shoulder?.x ?? boundsCenter.x;
  const centerY = hip && shoulder ? hip.y * 0.68 + shoulder.y * 0.32 : hip?.y ?? shoulder?.y ?? boundsCenter.y;
  const torso = hip && shoulder ? Math.hypot(hip.x - shoulder.x, hip.y - shoulder.y) : 0;
  const height = Math.max(0.08, bottom - top);
  const confidence = points.reduce((sum, point) => sum + (point.visibility ?? 1), 0) / points.length;

  return {
    ...observation,
    detectionIndex,
    bounds: {
      left,
      top,
      right,
      bottom,
      centerX,
      centerY,
      width: right - left,
      height: bottom - top,
    },
    bodyScale: Math.max(0.09, torso * 2.5, height * 0.42),
    confidence,
  };
}

function matchCost(track: TrackMemory, detection: DetectionDescriptor, timestamp: number) {
  const elapsedSeconds = Math.min(0.32, Math.max(0, timestamp - track.lastSeenAt) / 1_000);
  const predictedX = track.centerX + track.velocityX * elapsedSeconds;
  const predictedY = track.centerY + track.velocityY * elapsedSeconds;
  const scale = Math.max(0.1, track.bodyScale, detection.bodyScale);
  const distance = Math.hypot(predictedX - detection.bounds.centerX, predictedY - detection.bounds.centerY) / scale;
  const scalePenalty = Math.abs(Math.log(detection.bodyScale / Math.max(0.01, track.bodyScale))) * 0.34;
  const confidencePenalty = Math.max(0, 0.55 - detection.confidence) * 0.35;
  let appearancePenalty = 0;
  if (track.appearance && detection.appearance) {
    appearancePenalty = appearanceDistance(track.appearance, detection.appearance) * 0.92;
    const knownColors = track.appearance.shirtColor !== "unknown" && detection.appearance.shirtColor !== "unknown";
    if (knownColors && track.appearance.shirtColor !== detection.appearance.shirtColor
      && track.appearance.confidence >= 0.38 && detection.appearance.confidence >= 0.38) {
      appearancePenalty += 0.58;
    }
  }
  return distance + scalePenalty + confidencePenalty + appearancePenalty;
}

function blendBounds(previous: PoseBounds, current: PoseBounds, currentWeight = 0.38): PoseBounds {
  const blend = (left: number, right: number) => left * (1 - currentWeight) + right * currentWeight;
  const left = blend(previous.left, current.left);
  const top = blend(previous.top, current.top);
  const right = blend(previous.right, current.right);
  const bottom = blend(previous.bottom, current.bottom);
  return {
    left,
    top,
    right,
    bottom,
    centerX: blend(previous.centerX, current.centerX),
    centerY: blend(previous.centerY, current.centerY),
    width: right - left,
    height: bottom - top,
  };
}

function bestAssignments(tracks: TrackMemory[], detections: DetectionDescriptor[], timestamp: number) {
  let best: Assignment[] = [];
  let bestScore = Number.POSITIVE_INFINITY;

  function visit(trackIndex: number, used: Set<number>, assignments: Assignment[], score: number) {
    if (score >= bestScore) return;
    if (trackIndex >= tracks.length) {
      const unmatchedDetections = detections.length - used.size;
      const finalScore = score + unmatchedDetections * UNMATCHED_DETECTION_COST;
      if (finalScore >= bestScore) return;
      best = assignments;
      bestScore = finalScore;
      return;
    }

    visit(trackIndex + 1, used, assignments, score + UNMATCHED_TRACK_COST);
    detections.forEach((detection, detectionIndex) => {
      if (used.has(detectionIndex)) return;
      const cost = matchCost(tracks[trackIndex], detection, timestamp);
      if (cost > MAX_MATCH_COST) return;
      used.add(detectionIndex);
      visit(trackIndex + 1, used, [...assignments, { trackIndex, detectionIndex, cost }], score + cost);
      used.delete(detectionIndex);
    });
  }

  visit(0, new Set(), [], 0);
  return best;
}

export function updateMultiPoseTracker(
  state: MultiPoseTrackerState,
  observations: PoseObservation[],
  timestamp: number,
): { state: MultiPoseTrackerState; poses: TrackedPose[] } {
  const activeTracks = state.tracks.filter((track) => timestamp - track.lastSeenAt <= TRACK_TTL_MS);
  const detections = observations
    .map((observation, index) => describePose(observation, index))
    .filter((detection): detection is DetectionDescriptor => Boolean(detection));
  const assignments = bestAssignments(activeTracks, detections, timestamp);
  const assignedDetections = new Set(assignments.map((assignment) => assignment.detectionIndex));
  let nextId = state.nextId;
  const nextTracks = activeTracks.map((track, trackIndex) => {
    const assignment = assignments.find((entry) => entry.trackIndex === trackIndex);
    if (!assignment) return { ...track, stableFrames: 0 };
    const detection = detections[assignment.detectionIndex];
    const elapsedSeconds = Math.max(0.016, Math.min(0.4, timestamp - track.lastSeenAt) / 1_000);
    const measuredVelocityX = (detection.bounds.centerX - track.centerX) / elapsedSeconds;
    const measuredVelocityY = (detection.bounds.centerY - track.centerY) / elapsedSeconds;
    return {
      id: track.id,
      centerX: detection.bounds.centerX,
      centerY: detection.bounds.centerY,
      velocityX: track.velocityX * 0.58 + measuredVelocityX * 0.42,
      velocityY: track.velocityY * 0.58 + measuredVelocityY * 0.42,
      bodyScale: track.bodyScale * 0.55 + detection.bodyScale * 0.45,
      bounds: blendBounds(track.bounds, detection.bounds),
      confidence: detection.confidence,
      stableFrames: timestamp - track.lastSeenAt <= 450
        ? Math.min(30, track.stableFrames + 1)
        : 1,
      appearance: blendAppearance(track.appearance, detection.appearance),
      lastSeenAt: timestamp,
    };
  });

  detections.forEach((detection, detectionIndex) => {
    if (assignedDetections.has(detectionIndex)) return;
    const id = nextId;
    nextId += 1;
    nextTracks.push({
      id,
      centerX: detection.bounds.centerX,
      centerY: detection.bounds.centerY,
      velocityX: 0,
      velocityY: 0,
      bodyScale: detection.bodyScale,
      bounds: detection.bounds,
      confidence: detection.confidence,
      stableFrames: 1,
      appearance: detection.appearance,
      lastSeenAt: timestamp,
    });
  });

  const visiblePoses: TrackedPose[] = [];
  detections.forEach((detection, detectionIndex) => {
    const matched = assignments.find((entry) => entry.detectionIndex === detectionIndex);
    const track = matched
      ? nextTracks.find((entry) => entry.id === activeTracks[matched.trackIndex].id)
      : nextTracks.find((entry) => entry.lastSeenAt === timestamp
        && entry.centerX === detection.bounds.centerX && entry.centerY === detection.bounds.centerY);
    if (!track) return;
    visiblePoses.push({
      trackId: track.id,
      landmarks: detection.landmarks,
      ...(detection.worldLandmarks ? { worldLandmarks: detection.worldLandmarks } : {}),
      bounds: track.bounds,
      confidence: detection.confidence,
      stableFrames: track.stableFrames,
      lockConfidence: calculateLockConfidence(track),
      ...(track.appearance ? { appearance: track.appearance } : {}),
      ...(detection.appearance ? { observedAppearance: detection.appearance } : {}),
    });
  });

  return {
    state: { tracks: nextTracks.sort((left, right) => left.id - right.id), nextId },
    poses: visiblePoses.sort((left, right) => left.trackId - right.trackId),
  };
}

export function hitTestTrackedPose(poses: TrackedPose[], x: number, y: number) {
  return poses
    .filter((pose) => x >= pose.bounds.left - 0.035 && x <= pose.bounds.right + 0.035
      && y >= pose.bounds.top - 0.045 && y <= pose.bounds.bottom + 0.045)
    .sort((left, right) => {
      const leftDistance = Math.hypot(x - left.bounds.centerX, y - left.bounds.centerY);
      const rightDistance = Math.hypot(x - right.bounds.centerX, y - right.bounds.centerY);
      return leftDistance - rightDistance;
    })[0] ?? null;
}

export function findLockedPoseReacquisition(
  poses: TrackedPose[],
  memory: LockedTargetMemory,
  timestamp: number,
) {
  const elapsed = timestamp - memory.lastSeenAt;
  if (elapsed <= TRACK_TTL_MS || elapsed > LOCK_REACQUISITION_WINDOW_MS) return null;
  if (memory.appearance.confidence < 0.4 || memory.appearance.sampleCount < 18) return null;

  const ranked = poses.flatMap((pose) => {
    const candidate = pose.observedAppearance ?? pose.appearance;
    if (!candidate || candidate.confidence < 0.4 || candidate.sampleCount < 18 || pose.confidence < 0.45) return [];
    const knownColorMismatch = memory.appearance.shirtColor !== "unknown"
      && candidate.shirtColor !== "unknown"
      && memory.appearance.shirtColor !== candidate.shirtColor;
    if (knownColorMismatch) return [];

    const appearanceScore = appearanceDistance(memory.appearance, candidate);
    if (appearanceScore > MAX_REACQUISITION_APPEARANCE_DISTANCE) return [];
    const spatialScale = Math.max(0.16, memory.bounds.height * 0.52, pose.bounds.height * 0.52);
    const spatialDistance = Math.hypot(
      memory.bounds.centerX - pose.bounds.centerX,
      memory.bounds.centerY - pose.bounds.centerY,
    ) / spatialScale;
    if (spatialDistance > 1.65) return [];
    return [{ pose, score: appearanceScore + spatialDistance * 0.12 }];
  }).sort((left, right) => left.score - right.score);

  if (!ranked.length) return null;
  if (ranked[1] && ranked[1].score - ranked[0].score < MIN_REACQUISITION_SCORE_MARGIN) return null;
  return ranked[0].pose;
}

export function advanceLockedPoseReacquisition(
  poses: TrackedPose[],
  memory: LockedTargetMemory,
  timestamp: number,
  previous: LockReacquisitionState,
) {
  const candidate = findLockedPoseReacquisition(poses, memory, timestamp);
  if (!candidate) {
    return {
      state: createLockReacquisitionState(),
      candidate: null,
      pose: null,
      progress: 0,
    };
  }

  const continuesCandidate = previous.candidateTrackId === candidate.trackId
    && timestamp >= previous.lastObservedAt
    && timestamp - previous.lastObservedAt <= MAX_REACQUISITION_FRAME_GAP_MS;
  const consecutiveFrames = continuesCandidate ? previous.consecutiveFrames + 1 : 1;
  const state: LockReacquisitionState = {
    candidateTrackId: candidate.trackId,
    consecutiveFrames,
    lastObservedAt: timestamp,
  };
  const confirmed = consecutiveFrames >= LOCK_REACQUISITION_CONFIRM_FRAMES
    && candidate.stableFrames >= LOCK_REACQUISITION_CONFIRM_FRAMES;

  return {
    state,
    candidate,
    pose: confirmed ? candidate : null,
    progress: Math.min(1, consecutiveFrames / LOCK_REACQUISITION_CONFIRM_FRAMES),
  };
}
