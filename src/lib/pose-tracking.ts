import { poseFootPoint, type CourtPoint } from "./rally-geometry.ts";
import type { PoseLandmark } from "./pose-metrics.ts";

export type TrackedPlayerId = "A" | "B";

export type DetectedPose = {
  landmarks: PoseLandmark[];
  worldLandmarks?: PoseLandmark[];
};

type TrackAnchor = {
  foot: CourtPoint;
  torso: CourtPoint;
  velocity: CourtPoint;
  lastSeenAt: number;
};

export type PlayerTrackingState = Partial<Record<TrackedPlayerId, TrackAnchor>>;

export type AssignedPose = DetectedPose & {
  player: TrackedPlayerId;
};

const PLAYER_IDS: TrackedPlayerId[] = ["A", "B"];
const TRACK_EXPIRY_MS = 1_200;

const distance = (left: CourtPoint, right: CourtPoint) =>
  Math.hypot(left.x - right.x, left.y - right.y);

function torsoCenter(landmarks: PoseLandmark[]): CourtPoint {
  const points = [landmarks[11], landmarks[12], landmarks[23], landmarks[24]]
    .filter(Boolean);
  if (!points.length) return poseFootPoint(landmarks);
  return {
    x: points.reduce((total, point) => total + point.x, 0) / points.length,
    y: points.reduce((total, point) => total + point.y, 0) / points.length,
  };
}

function poseAnchor(pose: DetectedPose) {
  return {
    foot: poseFootPoint(pose.landmarks),
    torso: torsoCenter(pose.landmarks),
  };
}

function predictedPoint(anchor: TrackAnchor, timestamp: number) {
  const elapsedFrames = Math.min(4, Math.max(0, timestamp - anchor.lastSeenAt) / 33.333);
  return {
    x: anchor.foot.x + anchor.velocity.x * elapsedFrames,
    y: anchor.foot.y + anchor.velocity.y * elapsedFrames,
  };
}

function assignmentCost(pose: DetectedPose, track: TrackAnchor | undefined, timestamp: number) {
  if (!track || timestamp - track.lastSeenAt > TRACK_EXPIRY_MS) return 1.5;
  const anchor = poseAnchor(pose);
  return distance(anchor.foot, predictedPoint(track, timestamp)) * 0.72
    + distance(anchor.torso, track.torso) * 0.28;
}

function updateTrack(previous: TrackAnchor | undefined, pose: DetectedPose, timestamp: number): TrackAnchor {
  const next = poseAnchor(pose);
  const elapsedFrames = previous
    ? Math.max(1, Math.min(5, (timestamp - previous.lastSeenAt) / 33.333))
    : 1;
  const instantaneousVelocity = previous
    ? {
        x: (next.foot.x - previous.foot.x) / elapsedFrames,
        y: (next.foot.y - previous.foot.y) / elapsedFrames,
      }
    : { x: 0, y: 0 };
  return {
    foot: next.foot,
    torso: next.torso,
    velocity: previous
      ? {
          x: previous.velocity.x * 0.62 + instantaneousVelocity.x * 0.38,
          y: previous.velocity.y * 0.62 + instantaneousVelocity.y * 0.38,
        }
      : instantaneousVelocity,
    lastSeenAt: timestamp,
  };
}

function initializeAssignments(poses: DetectedPose[]) {
  return [...poses]
    .sort((left, right) => poseFootPoint(right.landmarks).y - poseFootPoint(left.landmarks).y)
    .slice(0, 2)
    .map((pose, index) => ({ ...pose, player: PLAYER_IDS[index] }));
}

export function assignStablePlayerIds(
  poses: DetectedPose[],
  previousState: PlayerTrackingState,
  timestamp: number,
): { assignments: AssignedPose[]; state: PlayerTrackingState } {
  const usable = poses.filter((pose) => pose.landmarks.length >= 29).slice(0, 2);
  if (!usable.length) return { assignments: [], state: previousState };

  const hasRecentTrack = PLAYER_IDS.some((player) => {
    const track = previousState[player];
    return track && timestamp - track.lastSeenAt <= TRACK_EXPIRY_MS;
  });

  let assignments: AssignedPose[];
  if (!hasRecentTrack) {
    assignments = initializeAssignments(usable);
  } else if (usable.length === 1) {
    const bestPlayer = assignmentCost(usable[0], previousState.A, timestamp)
      <= assignmentCost(usable[0], previousState.B, timestamp) ? "A" : "B";
    assignments = [{ ...usable[0], player: bestPlayer }];
  } else {
    const directCost = assignmentCost(usable[0], previousState.A, timestamp)
      + assignmentCost(usable[1], previousState.B, timestamp);
    const swappedCost = assignmentCost(usable[0], previousState.B, timestamp)
      + assignmentCost(usable[1], previousState.A, timestamp);
    assignments = directCost <= swappedCost
      ? [{ ...usable[0], player: "A" }, { ...usable[1], player: "B" }]
      : [{ ...usable[0], player: "B" }, { ...usable[1], player: "A" }];
  }

  const state = { ...previousState };
  assignments.forEach((assignment) => {
    state[assignment.player] = updateTrack(previousState[assignment.player], assignment, timestamp);
  });
  return { assignments, state };
}

export function resetPlayerTracking(): PlayerTrackingState {
  return {};
}
