export type PoseLandmark = {
  x: number;
  y: number;
  z?: number;
  visibility?: number;
};

export type SmashPhase =
  | "READY"
  | "PREPARATION"
  | "LOADING"
  | "ACCELERATION"
  | "CONTACT"
  | "FOLLOW_THROUGH";

export type DominantSide = "left" | "right";

export type PoseFrameMemory = {
  timestamp: number;
  leftWrist: PoseLandmark;
  rightWrist: PoseLandmark;
  leftElbowAngle: number;
  rightElbowAngle: number;
};

export type SmashMetrics = {
  dominantSide: DominantSide;
  elbowAngle: number;
  shoulderAngle: number;
  kneeFlexion: number;
  wristSpeed: number;
  armAngularSpeed: number;
  contactHeight: number;
  bodyExtension: number;
  confidence: number;
  score: number;
  phase: SmashPhase;
  isContact: boolean;
};

const LANDMARK = {
  leftShoulder: 11,
  rightShoulder: 12,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
  leftHip: 23,
  rightHip: 24,
  leftKnee: 25,
  rightKnee: 26,
  leftAnkle: 27,
  rightAnkle: 28,
} as const;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const distance = (a: PoseLandmark, b: PoseLandmark) =>
  Math.hypot(a.x - b.x, a.y - b.y);

export function calculateAngle(
  a: PoseLandmark,
  b: PoseLandmark,
  c: PoseLandmark,
) {
  const baX = a.x - b.x;
  const baY = a.y - b.y;
  const bcX = c.x - b.x;
  const bcY = c.y - b.y;
  const denominator = Math.hypot(baX, baY) * Math.hypot(bcX, bcY);

  if (denominator === 0) return 0;

  const cosine = clamp((baX * bcX + baY * bcY) / denominator, -1, 1);
  return (Math.acos(cosine) * 180) / Math.PI;
}

function wristVelocity(
  current: PoseLandmark,
  previous: PoseLandmark | undefined,
  elapsedSeconds: number,
) {
  if (!previous || elapsedSeconds <= 0 || elapsedSeconds > 0.25) return 0;
  return distance(current, previous) / elapsedSeconds;
}

function angleVelocity(current: number, previous: number | undefined, elapsedSeconds: number) {
  if (previous === undefined || elapsedSeconds <= 0 || elapsedSeconds > 0.25) return 0;
  return Math.abs(current - previous) / elapsedSeconds;
}

function confidenceFor(points: PoseLandmark[]) {
  const visible = points.map((point) => point.visibility ?? 1);
  return (visible.reduce((sum, value) => sum + value, 0) / visible.length) * 100;
}

export function analyzePose(
  landmarks: PoseLandmark[],
  timestamp: number,
  previous: PoseFrameMemory | null,
  lastContactAt: number,
): { metrics: SmashMetrics; memory: PoseFrameMemory } {
  const leftShoulder = landmarks[LANDMARK.leftShoulder];
  const rightShoulder = landmarks[LANDMARK.rightShoulder];
  const leftElbow = landmarks[LANDMARK.leftElbow];
  const rightElbow = landmarks[LANDMARK.rightElbow];
  const leftWrist = landmarks[LANDMARK.leftWrist];
  const rightWrist = landmarks[LANDMARK.rightWrist];
  const leftHip = landmarks[LANDMARK.leftHip];
  const rightHip = landmarks[LANDMARK.rightHip];
  const leftKnee = landmarks[LANDMARK.leftKnee];
  const rightKnee = landmarks[LANDMARK.rightKnee];
  const leftAnkle = landmarks[LANDMARK.leftAnkle];
  const rightAnkle = landmarks[LANDMARK.rightAnkle];

  const leftElbowAngle = calculateAngle(leftShoulder, leftElbow, leftWrist);
  const rightElbowAngle = calculateAngle(rightShoulder, rightElbow, rightWrist);
  const elapsedSeconds = previous ? (timestamp - previous.timestamp) / 1000 : 0;
  const leftSpeed = wristVelocity(leftWrist, previous?.leftWrist, elapsedSeconds);
  const rightSpeed = wristVelocity(rightWrist, previous?.rightWrist, elapsedSeconds);
  const dominantSide: DominantSide = leftSpeed > rightSpeed ? "left" : "right";

  const isLeft = dominantSide === "left";
  const shoulder = isLeft ? leftShoulder : rightShoulder;
  const elbow = isLeft ? leftElbow : rightElbow;
  const wrist = isLeft ? leftWrist : rightWrist;
  const hip = isLeft ? leftHip : rightHip;
  const elbowAngle = isLeft ? leftElbowAngle : rightElbowAngle;
  const previousElbowAngle = previous
    ? isLeft
      ? previous.leftElbowAngle
      : previous.rightElbowAngle
    : undefined;
  const wristSpeed = isLeft ? leftSpeed : rightSpeed;
  const shoulderAngle = calculateAngle(elbow, shoulder, hip);
  const leftKneeAngle = calculateAngle(leftHip, leftKnee, leftAnkle);
  const rightKneeAngle = calculateAngle(rightHip, rightKnee, rightAnkle);
  const kneeFlexion = clamp(180 - (leftKneeAngle + rightKneeAngle) / 2, 0, 120);
  const armAngularSpeed = angleVelocity(elbowAngle, previousElbowAngle, elapsedSeconds);
  const shoulderLine = (leftShoulder.y + rightShoulder.y) / 2;
  const ankleLine = (leftAnkle.y + rightAnkle.y) / 2;
  const hipLine = (leftHip.y + rightHip.y) / 2;
  const torsoLength = Math.max(0.08, hipLine - shoulderLine);
  const bodyExtension = clamp(((ankleLine - wrist.y) / torsoLength) * 40, 0, 100);
  const contactHeight = clamp((1 - wrist.y) * 100, 0, 100);
  const overhead = wrist.y < shoulder.y;
  const isContact =
    wristSpeed > 0.48 &&
    armAngularSpeed > 50 &&
    elbowAngle > 90 &&
    shoulderAngle > 50;

  let phase: SmashPhase = "PREPARATION";
  if (isContact) {
    phase = "CONTACT";
  } else if (timestamp - lastContactAt < 700) {
    phase = "FOLLOW_THROUGH";
  } else if (wristSpeed > 0.58) {
    phase = "ACCELERATION";
  } else if (overhead || elbowAngle < 115) {
    phase = "LOADING";
  }

  const elbowScore = clamp(100 - Math.abs(160 - elbowAngle) * 2.2, 0, 100);
  const shoulderScore = clamp(100 - Math.abs(120 - shoulderAngle) * 1.5, 0, 100);
  const speedScore = clamp((wristSpeed / 2.4) * 100, 0, 100);
  const heightScore = clamp((contactHeight - 42) * 2.2, 0, 100);
  const score =
    elbowScore * 0.3 + shoulderScore * 0.22 + speedScore * 0.28 + heightScore * 0.2;

  const confidence = confidenceFor([
    shoulder,
    elbow,
    wrist,
    hip,
    leftKnee,
    rightKnee,
    leftAnkle,
    rightAnkle,
  ]);

  return {
    metrics: {
      dominantSide,
      elbowAngle,
      shoulderAngle,
      kneeFlexion,
      wristSpeed,
      armAngularSpeed,
      contactHeight,
      bodyExtension,
      confidence,
      score,
      phase,
      isContact,
    },
    memory: {
      timestamp,
      leftWrist: { ...leftWrist },
      rightWrist: { ...rightWrist },
      leftElbowAngle,
      rightElbowAngle,
    },
  };
}

export const initialMetrics: SmashMetrics = {
  dominantSide: "right",
  elbowAngle: 0,
  shoulderAngle: 0,
  kneeFlexion: 0,
  wristSpeed: 0,
  armAngularSpeed: 0,
  contactHeight: 0,
  bodyExtension: 0,
  confidence: 0,
  score: 0,
  phase: "READY",
  isContact: false,
};
