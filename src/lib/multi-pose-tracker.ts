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
  motionHistory: MotionObservation[];
  observedAppearance?: PoseAppearance;
};

export type LockedTargetMemory = {
  appearance: PoseAppearance;
  appearanceGallery?: PoseAppearance[];
  bounds: PoseBounds;
  lastSeenAt: number;
  trajectory?: MotionObservation[];
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
  appearanceGallery: PoseAppearance[];
  observations: MotionObservation[];
  motion: KalmanMotionState;
  missedFrames: number;
  lastSeenAt: number;
};

export type MotionObservation = {
  centerX: number;
  centerY: number;
  bodyScale: number;
  timestamp: number;
};

type KalmanMotionState = {
  values: [number, number, number, number];
  covariance: number[][];
  timestamp: number;
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
const HIGH_CONFIDENCE_DETECTION = 0.58;
const LOW_CONFIDENCE_DETECTION = 0.34;
const LOW_CONFIDENCE_MAX_MATCH_COST = 1.72;
const OBSERVATION_HISTORY_SIZE = 8;
const APPEARANCE_GALLERY_SIZE = 6;
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

function createMotionState(centerX: number, centerY: number, timestamp: number): KalmanMotionState {
  return {
    values: [centerX, centerY, 0, 0],
    covariance: [
      [0.0025, 0, 0, 0],
      [0, 0.0025, 0, 0],
      [0, 0, 0.18, 0],
      [0, 0, 0, 0.18],
    ],
    timestamp,
  };
}

function multiplyMatrices(left: number[][], right: number[][]) {
  return left.map((row) => right[0].map((_, column) =>
    row.reduce((sum, value, index) => sum + value * right[index][column], 0)));
}

function transpose(matrix: number[][]) {
  return matrix[0].map((_, column) => matrix.map((row) => row[column]));
}

function predictMotion(state: KalmanMotionState, timestamp: number): KalmanMotionState {
  if (timestamp <= state.timestamp) return state;
  const elapsedSeconds = Math.min(1.2, (timestamp - state.timestamp) / 1_000);
  const transition = [
    [1, 0, elapsedSeconds, 0],
    [0, 1, 0, elapsedSeconds],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  const predictedValues: [number, number, number, number] = [
    state.values[0] + state.values[2] * elapsedSeconds,
    state.values[1] + state.values[3] * elapsedSeconds,
    state.values[2],
    state.values[3],
  ];
  const elapsedSquared = elapsedSeconds * elapsedSeconds;
  const elapsedCubed = elapsedSquared * elapsedSeconds;
  const elapsedFourth = elapsedSquared * elapsedSquared;
  const processNoise = 0.025;
  const processCovariance = [
    [elapsedFourth / 4 * processNoise, 0, elapsedCubed / 2 * processNoise, 0],
    [0, elapsedFourth / 4 * processNoise, 0, elapsedCubed / 2 * processNoise],
    [elapsedCubed / 2 * processNoise, 0, elapsedSquared * processNoise, 0],
    [0, elapsedCubed / 2 * processNoise, 0, elapsedSquared * processNoise],
  ];
  const predictedCovariance = multiplyMatrices(
    multiplyMatrices(transition, state.covariance),
    transpose(transition),
  ).map((row, rowIndex) => row.map((value, columnIndex) =>
    value + processCovariance[rowIndex][columnIndex]));
  return { values: predictedValues, covariance: predictedCovariance, timestamp };
}

function updateMotion(
  predicted: KalmanMotionState,
  centerX: number,
  centerY: number,
  confidence: number,
): KalmanMotionState {
  const measurementVariance = 0.00045 + (1 - clamp01(confidence)) * 0.0028;
  const covariance = predicted.covariance;
  const s00 = covariance[0][0] + measurementVariance;
  const s01 = covariance[0][1];
  const s10 = covariance[1][0];
  const s11 = covariance[1][1] + measurementVariance;
  const determinant = Math.max(1e-9, s00 * s11 - s01 * s10);
  const inverse = [
    [s11 / determinant, -s01 / determinant],
    [-s10 / determinant, s00 / determinant],
  ];
  const gain = covariance.map((row) => [
    row[0] * inverse[0][0] + row[1] * inverse[1][0],
    row[0] * inverse[0][1] + row[1] * inverse[1][1],
  ]);
  const innovationX = centerX - predicted.values[0];
  const innovationY = centerY - predicted.values[1];
  const values = predicted.values.map((value, index) =>
    value + gain[index][0] * innovationX + gain[index][1] * innovationY) as [number, number, number, number];
  const nextCovariance = covariance.map((row, rowIndex) => row.map((value, columnIndex) =>
    value - gain[rowIndex][0] * covariance[0][columnIndex]
      - gain[rowIndex][1] * covariance[1][columnIndex]));
  for (let row = 0; row < nextCovariance.length; row += 1) {
    nextCovariance[row][row] = Math.max(1e-8, nextCovariance[row][row]);
    for (let column = row + 1; column < nextCovariance[row].length; column += 1) {
      const symmetric = (nextCovariance[row][column] + nextCovariance[column][row]) / 2;
      nextCovariance[row][column] = symmetric;
      nextCovariance[column][row] = symmetric;
    }
  }
  return { values, covariance: nextCovariance, timestamp: predicted.timestamp };
}

function observationCentricMotionUpdate(
  track: TrackMemory,
  detection: DetectionDescriptor,
  timestamp: number,
) {
  const elapsed = timestamp - track.lastSeenAt;
  if (elapsed <= 120 || track.missedFrames === 0) {
    return updateMotion(
      predictMotion(track.motion, timestamp),
      detection.bounds.centerX,
      detection.bounds.centerY,
      detection.confidence,
    );
  }

  // OC-SORT's ORU principle: replay virtual observations across an occlusion so
  // the motion state turns toward the newly observed trajectory instead of
  // carrying a stale pre-occlusion velocity into the next frame.
  const steps = Math.min(8, Math.max(2, Math.ceil(elapsed / 90)));
  let motion = track.motion;
  for (let step = 1; step <= steps; step += 1) {
    const progress = step / steps;
    const virtualTimestamp = track.lastSeenAt + elapsed * progress;
    const virtualX = track.centerX + (detection.bounds.centerX - track.centerX) * progress;
    const virtualY = track.centerY + (detection.bounds.centerY - track.centerY) * progress;
    motion = updateMotion(
      predictMotion(motion, virtualTimestamp),
      virtualX,
      virtualY,
      step === steps ? detection.confidence : Math.min(0.62, detection.confidence),
    );
  }
  return motion;
}

function appendObservation(history: MotionObservation[], observation: MotionObservation) {
  const withoutDuplicate = history.filter((entry) => entry.timestamp !== observation.timestamp);
  return [...withoutDuplicate, observation]
    .sort((left, right) => left.timestamp - right.timestamp)
    .slice(-OBSERVATION_HISTORY_SIZE);
}

function observationDirection(history: MotionObservation[]) {
  const latest = history.at(-1);
  if (!latest) return null;
  const previous = [...history].reverse().find((entry) => latest.timestamp - entry.timestamp >= 35);
  if (!previous) return null;
  return {
    x: latest.centerX - previous.centerX,
    y: latest.centerY - previous.centerY,
    magnitude: Math.hypot(latest.centerX - previous.centerX, latest.centerY - previous.centerY),
  };
}

function directionConsistencyPenalty(track: TrackMemory, detection: DetectionDescriptor, timestamp: number) {
  const direction = observationDirection(track.observations);
  if (!direction || direction.magnitude < track.bodyScale * 0.035) return 0;
  const candidateX = detection.bounds.centerX - track.centerX;
  const candidateY = detection.bounds.centerY - track.centerY;
  const candidateMagnitude = Math.hypot(candidateX, candidateY);
  if (candidateMagnitude < track.bodyScale * 0.025) return 0;
  const cosine = Math.max(-1, Math.min(1,
    (direction.x * candidateX + direction.y * candidateY) / (direction.magnitude * candidateMagnitude)));
  const elapsed = timestamp - track.lastSeenAt;
  const recencyWeight = elapsed <= 160 ? 0.66 : elapsed <= 420 ? 0.38 : 0.18;
  return (1 - cosine) / 2 * recencyWeight;
}

function knownColorConflict(left: PoseAppearance, right: PoseAppearance) {
  return left.shirtColor !== "unknown"
    && right.shirtColor !== "unknown"
    && left.shirtColor !== right.shirtColor
    && left.confidence >= 0.38
    && right.confidence >= 0.38;
}

function appearanceDistanceToGallery(gallery: PoseAppearance[], candidate: PoseAppearance) {
  if (!gallery.length) return 1;
  return Math.min(...gallery.map((appearance) => appearanceDistance(appearance, candidate)));
}

function extendAppearanceGallery(gallery: PoseAppearance[], candidate: PoseAppearance | undefined) {
  if (!candidate || candidate.confidence < 0.3 || candidate.sampleCount < 18) return gallery;
  const anchor = gallery[0];
  if (anchor && (knownColorConflict(anchor, candidate)
    || appearanceDistanceToGallery(gallery, candidate) > 0.48)) return gallery;
  const sufficientlyDifferent = gallery.every((appearance) => appearanceDistance(appearance, candidate) > 0.055);
  if (!sufficientlyDifferent) return gallery;
  return [...gallery, candidate].slice(-APPEARANCE_GALLERY_SIZE);
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

function boundsIntersectionOverUnion(left: PoseBounds, right: PoseBounds) {
  const intersectionWidth = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
  const intersectionHeight = Math.max(0, Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top));
  const intersection = intersectionWidth * intersectionHeight;
  const union = left.width * left.height + right.width * right.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function matchCost(track: TrackMemory, detection: DetectionDescriptor, timestamp: number) {
  const predicted = predictMotion(track.motion, timestamp);
  const predictedX = predicted.values[0];
  const predictedY = predicted.values[1];
  const scale = Math.max(0.1, track.bodyScale, detection.bodyScale);
  const distance = Math.hypot(predictedX - detection.bounds.centerX, predictedY - detection.bounds.centerY) / scale;
  const scalePenalty = Math.abs(Math.log(detection.bodyScale / Math.max(0.01, track.bodyScale))) * 0.34;
  const confidencePenalty = Math.max(0, 0.55 - detection.confidence) * 0.35;
  const overlapPenalty = timestamp - track.lastSeenAt <= 220
    ? (1 - boundsIntersectionOverUnion(track.bounds, detection.bounds)) * 0.2
    : 0;
  const directionPenalty = directionConsistencyPenalty(track, detection, timestamp);
  let appearancePenalty = 0;
  if (detection.appearance && (track.appearanceGallery.length || track.appearance)) {
    const gallery = track.appearanceGallery.length
      ? track.appearanceGallery
      : track.appearance ? [track.appearance] : [];
    appearancePenalty = appearanceDistanceToGallery(gallery, detection.appearance) * 0.92;
    if (track.appearance && knownColorConflict(track.appearance, detection.appearance)) {
      appearancePenalty += 0.58;
    }
  }
  return distance + scalePenalty + confidencePenalty + overlapPenalty + directionPenalty + appearancePenalty;
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

function bestAssignments(
  tracks: TrackMemory[],
  detections: DetectionDescriptor[],
  timestamp: number,
  maxMatchCost = MAX_MATCH_COST,
) {
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
      if (cost > maxMatchCost) return;
      used.add(detectionIndex);
      visit(trackIndex + 1, used, [...assignments, { trackIndex, detectionIndex, cost }], score + cost);
      used.delete(detectionIndex);
    });
  }

  visit(0, new Set(), [], 0);
  return best;
}

function stagedAssignments(tracks: TrackMemory[], detections: DetectionDescriptor[], timestamp: number) {
  const highConfidenceIndexes = detections.flatMap((detection, index) =>
    detection.confidence >= HIGH_CONFIDENCE_DETECTION ? [index] : []);
  const lowConfidenceIndexes = detections.flatMap((detection, index) =>
    detection.confidence >= LOW_CONFIDENCE_DETECTION && detection.confidence < HIGH_CONFIDENCE_DETECTION
      ? [index]
      : []);
  const highAssignments = bestAssignments(
    tracks,
    highConfidenceIndexes.map((index) => detections[index]),
    timestamp,
  ).map((assignment) => ({
    ...assignment,
    detectionIndex: highConfidenceIndexes[assignment.detectionIndex],
  }));
  const assignedTrackIndexes = new Set(highAssignments.map((assignment) => assignment.trackIndex));
  const unmatchedTrackIndexes = tracks.flatMap((_, index) => assignedTrackIndexes.has(index) ? [] : [index]);
  const lowAssignments = bestAssignments(
    unmatchedTrackIndexes.map((index) => tracks[index]),
    lowConfidenceIndexes.map((index) => detections[index]),
    timestamp,
    LOW_CONFIDENCE_MAX_MATCH_COST,
  ).map((assignment) => ({
    trackIndex: unmatchedTrackIndexes[assignment.trackIndex],
    detectionIndex: lowConfidenceIndexes[assignment.detectionIndex],
    cost: assignment.cost,
  }));
  return [...highAssignments, ...lowAssignments];
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
  const assignments = stagedAssignments(activeTracks, detections, timestamp);
  const assignedDetections = new Set(assignments.map((assignment) => assignment.detectionIndex));
  let nextId = state.nextId;
  const nextTracks = activeTracks.map((track, trackIndex) => {
    const assignment = assignments.find((entry) => entry.trackIndex === trackIndex);
    if (!assignment) return { ...track, stableFrames: 0, missedFrames: track.missedFrames + 1 };
    const detection = detections[assignment.detectionIndex];
    const motion = observationCentricMotionUpdate(track, detection, timestamp);
    const appearanceGallery = extendAppearanceGallery(track.appearanceGallery, detection.appearance);
    const appearanceAccepted = Boolean(detection.appearance && (!track.appearance
      || (!knownColorConflict(track.appearance, detection.appearance)
        && appearanceDistanceToGallery(
          track.appearanceGallery.length ? track.appearanceGallery : [track.appearance],
          detection.appearance,
        ) <= 0.48)));
    const observation: MotionObservation = {
      centerX: detection.bounds.centerX,
      centerY: detection.bounds.centerY,
      bodyScale: detection.bodyScale,
      timestamp,
    };
    return {
      id: track.id,
      centerX: detection.bounds.centerX,
      centerY: detection.bounds.centerY,
      velocityX: motion.values[2],
      velocityY: motion.values[3],
      bodyScale: track.bodyScale * 0.55 + detection.bodyScale * 0.45,
      bounds: blendBounds(track.bounds, detection.bounds, track.missedFrames > 0 ? 0.68 : 0.38),
      confidence: detection.confidence,
      stableFrames: track.missedFrames === 0 && timestamp - track.lastSeenAt <= 450
        ? Math.min(30, track.stableFrames + 1)
        : 1,
      appearance: appearanceAccepted
        ? blendAppearance(track.appearance, detection.appearance)
        : track.appearance,
      appearanceGallery,
      observations: appendObservation(track.observations, observation),
      motion,
      missedFrames: 0,
      lastSeenAt: timestamp,
    };
  });

  detections.forEach((detection, detectionIndex) => {
    if (assignedDetections.has(detectionIndex) || detection.confidence < HIGH_CONFIDENCE_DETECTION) return;
    const id = nextId;
    nextId += 1;
    const observation: MotionObservation = {
      centerX: detection.bounds.centerX,
      centerY: detection.bounds.centerY,
      bodyScale: detection.bodyScale,
      timestamp,
    };
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
      appearanceGallery: detection.appearance ? [detection.appearance] : [],
      observations: [observation],
      motion: createMotionState(detection.bounds.centerX, detection.bounds.centerY, timestamp),
      missedFrames: 0,
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
      motionHistory: track.observations,
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

export function createLockedTargetMemory(
  pose: TrackedPose,
  timestamp: number,
): LockedTargetMemory | null {
  const appearance = pose.appearance ?? pose.observedAppearance;
  if (!appearance) return null;
  return {
    appearance,
    appearanceGallery: [appearance],
    bounds: pose.bounds,
    lastSeenAt: timestamp,
    trajectory: pose.motionHistory.slice(-OBSERVATION_HISTORY_SIZE),
  };
}

export function updateLockedTargetMemory(
  memory: LockedTargetMemory,
  pose: TrackedPose,
  timestamp: number,
): LockedTargetMemory {
  const observedAppearance = pose.observedAppearance ?? pose.appearance;
  const currentGallery = memory.appearanceGallery?.length
    ? memory.appearanceGallery
    : [memory.appearance];
  const appearanceGallery = extendAppearanceGallery(currentGallery, observedAppearance);
  const latestObservation: MotionObservation = {
    centerX: pose.bounds.centerX,
    centerY: pose.bounds.centerY,
    bodyScale: Math.max(0.09, pose.bounds.height * 0.42),
    timestamp,
  };
  const trajectory = pose.motionHistory.length
    ? pose.motionHistory.slice(-OBSERVATION_HISTORY_SIZE)
    : appendObservation(memory.trajectory ?? [], latestObservation);
  return {
    ...memory,
    appearanceGallery,
    bounds: pose.bounds,
    lastSeenAt: timestamp,
    trajectory,
  };
}

function predictLockedTarget(memory: LockedTargetMemory, timestamp: number) {
  const history = memory.trajectory ?? [];
  const latest = history.at(-1);
  const previous = latest
    ? [...history].reverse().find((entry) => latest.timestamp - entry.timestamp >= 70)
    : undefined;
  if (!latest || !previous) {
    return {
      centerX: memory.bounds.centerX,
      centerY: memory.bounds.centerY,
      directionX: 0,
      directionY: 0,
    };
  }
  const measuredSeconds = Math.max(0.04, (latest.timestamp - previous.timestamp) / 1_000);
  const velocityX = (latest.centerX - previous.centerX) / measuredSeconds;
  const velocityY = (latest.centerY - previous.centerY) / measuredSeconds;
  const elapsed = Math.max(0, timestamp - memory.lastSeenAt);
  const forecastSeconds = Math.min(0.7, elapsed / 1_000)
    * Math.exp(-Math.max(0, elapsed - 550) / 1_250);
  const forecastX = velocityX * forecastSeconds;
  const forecastY = velocityY * forecastSeconds;
  const maximumForecast = Math.max(0.12, latest.bodyScale * 0.82);
  const forecastMagnitude = Math.hypot(forecastX, forecastY);
  const forecastScale = forecastMagnitude > maximumForecast
    ? maximumForecast / forecastMagnitude
    : 1;
  return {
    centerX: latest.centerX + forecastX * forecastScale,
    centerY: latest.centerY + forecastY * forecastScale,
    directionX: latest.centerX - previous.centerX,
    directionY: latest.centerY - previous.centerY,
  };
}

export function findLockedPoseReacquisition(
  poses: TrackedPose[],
  memory: LockedTargetMemory,
  timestamp: number,
) {
  const elapsed = timestamp - memory.lastSeenAt;
  if (elapsed <= TRACK_TTL_MS || elapsed > LOCK_REACQUISITION_WINDOW_MS) return null;
  if (memory.appearance.confidence < 0.4 || memory.appearance.sampleCount < 18) return null;

  const predicted = predictLockedTarget(memory, timestamp);
  const gallery = memory.appearanceGallery?.length
    ? memory.appearanceGallery
    : [memory.appearance];

  const ranked = poses.flatMap((pose) => {
    const candidate = pose.observedAppearance ?? pose.appearance;
    if (!candidate || candidate.confidence < 0.4 || candidate.sampleCount < 18 || pose.confidence < 0.45) return [];
    const knownColorMismatch = memory.appearance.shirtColor !== "unknown"
      && candidate.shirtColor !== "unknown"
      && memory.appearance.shirtColor !== candidate.shirtColor;
    if (knownColorMismatch) return [];

    const appearanceScore = appearanceDistanceToGallery(gallery, candidate);
    if (appearanceScore > MAX_REACQUISITION_APPEARANCE_DISTANCE) return [];
    const uncertaintyGrowth = 1 + Math.min(0.85, Math.max(0, elapsed - TRACK_TTL_MS) / 2_600);
    const spatialScale = Math.max(0.16, memory.bounds.height * 0.52, pose.bounds.height * 0.52)
      * uncertaintyGrowth;
    const spatialDistance = Math.hypot(
      predicted.centerX - pose.bounds.centerX,
      predicted.centerY - pose.bounds.centerY,
    ) / spatialScale;
    if (spatialDistance > 1.75) return [];
    const candidateDirectionX = pose.bounds.centerX - memory.bounds.centerX;
    const candidateDirectionY = pose.bounds.centerY - memory.bounds.centerY;
    const expectedMagnitude = Math.hypot(predicted.directionX, predicted.directionY);
    const candidateMagnitude = Math.hypot(candidateDirectionX, candidateDirectionY);
    let directionPenalty = 0;
    if (expectedMagnitude > 0.008 && candidateMagnitude > 0.025) {
      const cosine = Math.max(-1, Math.min(1,
        (predicted.directionX * candidateDirectionX + predicted.directionY * candidateDirectionY)
          / (expectedMagnitude * candidateMagnitude)));
      directionPenalty = (1 - cosine) / 2 * 0.24;
    }
    return [{
      pose,
      score: appearanceScore * 0.82 + spatialDistance * 0.14 + directionPenalty,
    }];
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
