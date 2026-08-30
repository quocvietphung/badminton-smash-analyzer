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
export type PreferredHand = DominantSide | "auto";

export type PoseFrameMemory = {
  timestamp: number;
  leftWrist: PoseLandmark;
  rightWrist: PoseLandmark;
  leftElbowAngle: number;
  rightElbowAngle: number;
  leftWristSpeed: number;
  rightWristSpeed: number;
  leftArmAngularSpeed: number;
  rightArmAngularSpeed: number;
  dominantSide: DominantSide;
  lockedSide: DominantSide | null;
  leftActivity: number;
  rightActivity: number;
  activeFrames: number;
  bodyScale: number;
  leftAnkle: PoseLandmark;
  rightAnkle: PoseLandmark;
  hipMidpoint: PoseLandmark;
  leftAnkleSpeed: number;
  rightAnkleSpeed: number;
  centerSpeed: number;
  centerVerticalSpeed: number;
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
  wristAboveShoulder: boolean;
  confidence: number;
  score: number;
  phase: SmashPhase;
  isContact: boolean;
  handLocked: boolean;
  trunkRotation: number;
  balanceScore: number;
  stanceWidth: number;
  wristAcrossBody: number;
  lateralReach: number;
  leftKneeFlexion: number;
  rightKneeFlexion: number;
  leftAnkleSpeed: number;
  rightAnkleSpeed: number;
  footSpeed: number;
  centerSpeed: number;
  verticalBounce: number;
  landingSymmetry: number;
  ankleHeightDifference: number;
  centerX: number;
  centerY: number;
  leftAnkleX: number;
  leftAnkleY: number;
  rightAnkleX: number;
  rightAnkleY: number;
  bodyScale: number;
};

export type PoseAnalysisOptions = {
  preferredHand?: PreferredHand;
  worldLandmarks?: PoseLandmark[];
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
  Math.hypot(a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0));

export function calculateAngle(
  a: PoseLandmark,
  b: PoseLandmark,
  c: PoseLandmark,
) {
  const ba = [a.x - b.x, a.y - b.y, (a.z ?? 0) - (b.z ?? 0)];
  const bc = [c.x - b.x, c.y - b.y, (c.z ?? 0) - (b.z ?? 0)];
  const denominator = Math.hypot(...ba) * Math.hypot(...bc);

  if (denominator === 0) return 0;

  const cosine = clamp(
    (ba[0] * bc[0] + ba[1] * bc[1] + ba[2] * bc[2]) / denominator,
    -1,
    1,
  );
  return (Math.acos(cosine) * 180) / Math.PI;
}

function wristVelocity(
  current: PoseLandmark,
  previous: PoseLandmark | undefined,
  elapsedSeconds: number,
  bodyScale: number,
) {
  if (!previous || elapsedSeconds <= 0 || elapsedSeconds > 0.25) return 0;
  // Preserve the former score range while removing most zoom/distance dependence.
  const normalizedScale = 0.22 / Math.max(0.08, bodyScale);
  return clamp((distance(current, previous) / elapsedSeconds) * normalizedScale, 0, 6);
}

function normalizedPointVelocity(
  current: PoseLandmark,
  previous: PoseLandmark | undefined,
  elapsedSeconds: number,
  bodyScale: number,
) {
  if (!previous || elapsedSeconds <= 0 || elapsedSeconds > 0.25) return 0;
  return clamp(distance(current, previous) / elapsedSeconds / Math.max(0.08, bodyScale), 0, 12);
}

function angleVelocity(current: number, previous: number | undefined, elapsedSeconds: number) {
  if (previous === undefined || elapsedSeconds <= 0 || elapsedSeconds > 0.25) return 0;
  return clamp(Math.abs(current - previous) / elapsedSeconds, 0, 1800);
}

function smoothVelocity(current: number, previous: number | undefined, alpha: number) {
  if (previous === undefined) return current;
  return previous * (1 - alpha) + current * alpha;
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
  options: PoseAnalysisOptions = {},
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

  const world = options.worldLandmarks?.length === landmarks.length
    ? options.worldLandmarks
    : undefined;
  const geometry = world ?? landmarks;
  const geometryLeftShoulder = geometry[LANDMARK.leftShoulder];
  const geometryRightShoulder = geometry[LANDMARK.rightShoulder];
  const geometryLeftElbow = geometry[LANDMARK.leftElbow];
  const geometryRightElbow = geometry[LANDMARK.rightElbow];
  const geometryLeftWrist = geometry[LANDMARK.leftWrist];
  const geometryRightWrist = geometry[LANDMARK.rightWrist];
  const geometryLeftHip = geometry[LANDMARK.leftHip];
  const geometryRightHip = geometry[LANDMARK.rightHip];

  const shoulderMidpoint = {
    x: (leftShoulder.x + rightShoulder.x) / 2,
    y: (leftShoulder.y + rightShoulder.y) / 2,
  };
  const hipMidpoint = {
    x: (leftHip.x + rightHip.x) / 2,
    y: (leftHip.y + rightHip.y) / 2,
  };
  const torsoLength = distance(shoulderMidpoint, hipMidpoint);
  const shoulderWidth = distance(leftShoulder, rightShoulder);
  const bodyScale = Math.max(0.08, torsoLength, shoulderWidth * 1.15);

  const leftElbowAngle = calculateAngle(geometryLeftShoulder, geometryLeftElbow, geometryLeftWrist);
  const rightElbowAngle = calculateAngle(geometryRightShoulder, geometryRightElbow, geometryRightWrist);
  const elapsedSeconds = previous ? (timestamp - previous.timestamp) / 1000 : 0;
  const velocityScale = previous ? (bodyScale + previous.bodyScale) / 2 : bodyScale;
  const leftSpeed = smoothVelocity(
    wristVelocity(leftWrist, previous?.leftWrist, elapsedSeconds, velocityScale),
    previous?.leftWristSpeed,
    0.35,
  );
  const rightSpeed = smoothVelocity(
    wristVelocity(rightWrist, previous?.rightWrist, elapsedSeconds, velocityScale),
    previous?.rightWristSpeed,
    0.35,
  );
  const leftArmAngularSpeed = smoothVelocity(
    angleVelocity(leftElbowAngle, previous?.leftElbowAngle, elapsedSeconds),
    previous?.leftArmAngularSpeed,
    0.4,
  );
  const rightArmAngularSpeed = smoothVelocity(
    angleVelocity(rightElbowAngle, previous?.rightElbowAngle, elapsedSeconds),
    previous?.rightArmAngularSpeed,
    0.4,
  );
  const decay = 0.965;
  const leftActivity = (previous?.leftActivity ?? 0) * decay
    + leftSpeed + leftArmAngularSpeed / 650;
  const rightActivity = (previous?.rightActivity ?? 0) * decay
    + rightSpeed + rightArmAngularSpeed / 650;
  const isActiveFrame = Math.max(leftSpeed, rightSpeed) > 0.16
    || Math.max(leftArmAngularSpeed, rightArmAngularSpeed) > 24;
  const activeFrames = (previous?.activeFrames ?? 0) + (isActiveFrame ? 1 : 0);
  let lockedSide = previous?.lockedSide ?? null;
  if (options.preferredHand && options.preferredHand !== "auto") {
    lockedSide = options.preferredHand;
  } else if (!lockedSide && activeFrames >= 12) {
    if (leftActivity > rightActivity * 1.3) lockedSide = "left";
    if (rightActivity > leftActivity * 1.3) lockedSide = "right";
  }
  const priorSide = previous?.dominantSide;
  const provisionalSide: DominantSide = priorSide ?? (leftActivity > rightActivity ? "left" : "right");
  const dominantSide = lockedSide ?? provisionalSide;

  const isLeft = dominantSide === "left";
  const shoulder = isLeft ? leftShoulder : rightShoulder;
  const elbow = isLeft ? leftElbow : rightElbow;
  const wrist = isLeft ? leftWrist : rightWrist;
  const hip = isLeft ? leftHip : rightHip;
  const elbowAngle = isLeft ? leftElbowAngle : rightElbowAngle;
  const wristSpeed = isLeft ? leftSpeed : rightSpeed;
  const geometryShoulder = isLeft ? geometryLeftShoulder : geometryRightShoulder;
  const geometryElbow = isLeft ? geometryLeftElbow : geometryRightElbow;
  const geometryHip = isLeft ? geometryLeftHip : geometryRightHip;
  const shoulderAngle = calculateAngle(geometryElbow, geometryShoulder, geometryHip);
  const leftKneeAngle = calculateAngle(leftHip, leftKnee, leftAnkle);
  const rightKneeAngle = calculateAngle(rightHip, rightKnee, rightAnkle);
  const leftKneeFlexion = clamp(180 - leftKneeAngle, 0, 120);
  const rightKneeFlexion = clamp(180 - rightKneeAngle, 0, 120);
  const kneeFlexion = (leftKneeFlexion + rightKneeFlexion) / 2;
  const armAngularSpeed = isLeft ? leftArmAngularSpeed : rightArmAngularSpeed;
  const shoulderLine = shoulderMidpoint.y;
  const hipLine = hipMidpoint.y;
  const verticalTorsoLength = Math.max(0.08, Math.abs(hipLine - shoulderLine));
  const wristHeightInTorso = (shoulderLine - wrist.y) / verticalTorsoLength;
  const contactHeight = clamp(50 + wristHeightInTorso * 30, 0, 100);
  const racketShoulder = isLeft ? leftShoulder : rightShoulder;
  const armReach = distance(racketShoulder, wrist) / bodyScale;
  const kneeExtension = 1 - clamp(kneeFlexion / 90, 0, 1);
  const bodyExtension = clamp(((armReach - 0.42) / 0.95) * 78 + kneeExtension * 22, 0, 100);
  const overhead = wrist.y < shoulder.y;
  const shoulderSlope = Math.atan2(
    rightShoulder.y - leftShoulder.y,
    rightShoulder.x - leftShoulder.x,
  );
  const hipSlope = Math.atan2(rightHip.y - leftHip.y, rightHip.x - leftHip.x);
  const trunkRotation = clamp(Math.abs(shoulderSlope - hipSlope) * (180 / Math.PI), 0, 90);
  const bodyLean = Math.abs(shoulderMidpoint.x - hipMidpoint.x) / bodyScale;
  const stanceWidth = clamp(distance(leftAnkle, rightAnkle) / bodyScale, 0, 2);
  const balanceScore = clamp(100 - bodyLean * 115 - Math.max(0, 0.28 - stanceWidth) * 55, 0, 100);
  const torsoCenterX = (leftShoulder.x + rightShoulder.x + leftHip.x + rightHip.x) / 4;
  const acrossDistance = isLeft ? wrist.x - torsoCenterX : torsoCenterX - wrist.x;
  const wristAcrossBody = clamp((acrossDistance / bodyScale) * 100, 0, 100);
  const lateralReach = clamp((Math.abs(wrist.x - shoulder.x) / bodyScale) * 78, 0, 100);
  const leftAnkleSpeed = smoothVelocity(
    normalizedPointVelocity(leftAnkle, previous?.leftAnkle, elapsedSeconds, velocityScale),
    previous?.leftAnkleSpeed,
    0.4,
  );
  const rightAnkleSpeed = smoothVelocity(
    normalizedPointVelocity(rightAnkle, previous?.rightAnkle, elapsedSeconds, velocityScale),
    previous?.rightAnkleSpeed,
    0.4,
  );
  const centerSpeed = smoothVelocity(
    normalizedPointVelocity(hipMidpoint, previous?.hipMidpoint, elapsedSeconds, velocityScale),
    previous?.centerSpeed,
    0.38,
  );
  const rawVerticalSpeed = previous && elapsedSeconds > 0 && elapsedSeconds <= 0.25
    ? Math.abs(hipMidpoint.y - previous.hipMidpoint.y) / elapsedSeconds / Math.max(0.08, velocityScale)
    : 0;
  const centerVerticalSpeed = smoothVelocity(rawVerticalSpeed, previous?.centerVerticalSpeed, 0.38);
  const ankleHeightDifference = Math.abs(leftAnkle.y - rightAnkle.y) / bodyScale;
  const kneeAsymmetry = Math.abs(leftKneeFlexion - rightKneeFlexion);
  const landingSymmetry = clamp(100 - ankleHeightDifference * 75 - kneeAsymmetry * 1.15, 0, 100);
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
      wristAboveShoulder: overhead,
      confidence,
      score,
      phase,
      isContact,
      handLocked: lockedSide !== null,
      trunkRotation,
      balanceScore,
      stanceWidth,
      wristAcrossBody,
      lateralReach,
      leftKneeFlexion,
      rightKneeFlexion,
      leftAnkleSpeed,
      rightAnkleSpeed,
      footSpeed: Math.max(leftAnkleSpeed, rightAnkleSpeed),
      centerSpeed,
      verticalBounce: centerVerticalSpeed,
      landingSymmetry,
      ankleHeightDifference,
      centerX: hipMidpoint.x,
      centerY: hipMidpoint.y,
      leftAnkleX: leftAnkle.x,
      leftAnkleY: leftAnkle.y,
      rightAnkleX: rightAnkle.x,
      rightAnkleY: rightAnkle.y,
      bodyScale,
    },
    memory: {
      timestamp,
      leftWrist: { ...leftWrist },
      rightWrist: { ...rightWrist },
      leftElbowAngle,
      rightElbowAngle,
      leftWristSpeed: leftSpeed,
      rightWristSpeed: rightSpeed,
      leftArmAngularSpeed,
      rightArmAngularSpeed,
      dominantSide,
      lockedSide,
      leftActivity,
      rightActivity,
      activeFrames,
      bodyScale,
      leftAnkle: { ...leftAnkle },
      rightAnkle: { ...rightAnkle },
      hipMidpoint: { ...hipMidpoint },
      leftAnkleSpeed,
      rightAnkleSpeed,
      centerSpeed,
      centerVerticalSpeed,
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
  wristAboveShoulder: false,
  confidence: 0,
  score: 0,
  phase: "READY",
  isContact: false,
  handLocked: false,
  trunkRotation: 0,
  balanceScore: 0,
  stanceWidth: 0,
  wristAcrossBody: 0,
  lateralReach: 0,
  leftKneeFlexion: 0,
  rightKneeFlexion: 0,
  leftAnkleSpeed: 0,
  rightAnkleSpeed: 0,
  footSpeed: 0,
  centerSpeed: 0,
  verticalBounce: 0,
  landingSymmetry: 0,
  ankleHeightDifference: 0,
  centerX: 0,
  centerY: 0,
  leftAnkleX: 0,
  leftAnkleY: 0,
  rightAnkleX: 0,
  rightAnkleY: 0,
  bodyScale: 0,
};
