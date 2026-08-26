export type LiteStrokeType =
  | "smash"
  | "drop_shot"
  | "drive"
  | "clear"
  | "overhead_control"
  | "unknown";

export type DrillMode = "open" | "smash" | "drop_shot" | "drive" | "clear";
export type StrokeFamily = "overhead_attack" | "overhead_control" | "lateral" | "unknown";

export type PoseLiteSample = {
  timestamp: number;
  wristSpeed: number;
  armAngularSpeed: number;
  elbowAngle: number;
  shoulderAngle: number;
  contactHeight: number;
  bodyExtension: number;
  wristAboveShoulder: boolean;
  visibility: number;
  trunkRotation?: number;
  kneeFlexion?: number;
  handLocked?: boolean;
};

export type PoseLiteResult = {
  strokeType: LiteStrokeType;
  label: string;
  evidence: number;
  certainty: "likely" | "possible" | "unknown";
  swingIntensity: number;
  postureScore: number;
  reason: string;
  family: StrokeFamily;
};

export type PoseClassifierOptions = {
  drillMode?: DrillMode;
};

const LABELS: Record<LiteStrokeType, string> = {
  smash: "Smash",
  drop_shot: "Drop shot",
  drive: "Drive / tạt",
  clear: "Clear / phông",
  overhead_control: "Clear / Drop chưa phân biệt",
  unknown: "Không chắc",
};

const clamp = (value: number, min = 0, max = 1) =>
  Math.min(max, Math.max(min, value));

const mean = (values: number[]) =>
  values.length
    ? values.reduce((total, value) => total + value, 0) / values.length
    : 0;

function percentile(values: number[], ratio: number) {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * ratio))];
}

const interpolate = (left: number | undefined, right: number | undefined, ratio: number) => {
  const start = left ?? 0;
  const end = right ?? start;
  return start + (end - start) * ratio;
};

export function resamplePoseWindow(samples: PoseLiteSample[], intervalMs = 40) {
  const ordered = [...samples].sort((left, right) => left.timestamp - right.timestamp);
  if (ordered.length < 2 || intervalMs <= 0) return ordered;
  const start = ordered[0].timestamp;
  const end = ordered.at(-1)!.timestamp;
  if (end - start < intervalMs * 2) return ordered;

  const result: PoseLiteSample[] = [];
  let rightIndex = 1;
  for (let timestamp = start; timestamp <= end; timestamp += intervalMs) {
    while (rightIndex < ordered.length - 1 && ordered[rightIndex].timestamp < timestamp) {
      rightIndex += 1;
    }
    const right = ordered[rightIndex];
    const left = ordered[Math.max(0, rightIndex - 1)];
    const span = Math.max(1, right.timestamp - left.timestamp);
    const ratio = clamp((timestamp - left.timestamp) / span);
    const nearest = ratio < 0.5 ? left : right;
    result.push({
      timestamp,
      wristSpeed: interpolate(left.wristSpeed, right.wristSpeed, ratio),
      armAngularSpeed: interpolate(left.armAngularSpeed, right.armAngularSpeed, ratio),
      elbowAngle: interpolate(left.elbowAngle, right.elbowAngle, ratio),
      shoulderAngle: interpolate(left.shoulderAngle, right.shoulderAngle, ratio),
      contactHeight: interpolate(left.contactHeight, right.contactHeight, ratio),
      bodyExtension: interpolate(left.bodyExtension, right.bodyExtension, ratio),
      wristAboveShoulder: nearest.wristAboveShoulder,
      visibility: interpolate(left.visibility, right.visibility, ratio),
      trunkRotation: interpolate(left.trunkRotation, right.trunkRotation, ratio),
      kneeFlexion: interpolate(left.kneeFlexion, right.kneeFlexion, ratio),
      handLocked: nearest.handLocked,
    });
  }
  return result.length >= 5 ? result : ordered;
}

export function classifyPoseWindow(
  samples: PoseLiteSample[],
  options: PoseClassifierOptions = {},
): PoseLiteResult {
  const drillMode = options.drillMode ?? "open";
  if (samples.length < 5) {
    return {
      strokeType: "unknown",
      label: LABELS.unknown,
      evidence: 0,
      certainty: "unknown",
      swingIntensity: 0,
      postureScore: 0,
      reason: "Chuỗi tư thế quá ngắn để so sánh chuyển động.",
      family: "unknown",
    };
  }

  const ordered = resamplePoseWindow(samples);
  const visibleSamples = ordered.filter((sample) => sample.visibility >= 45);
  const usable = visibleSamples.length >= 5 ? visibleSamples : ordered;
  const visibleRatio = visibleSamples.length / ordered.length;
  const duration = ordered.at(-1)!.timestamp - ordered[0].timestamp;
  const wristSeries = usable.map((sample) => sample.wristSpeed);
  const peakWrist = percentile(usable.map((sample) => sample.wristSpeed), 0.9);
  const peakAngular = percentile(usable.map((sample) => sample.armAngularSpeed), 0.9);
  const peakHeight = percentile(usable.map((sample) => sample.contactHeight), 0.85);
  const peakExtension = percentile(usable.map((sample) => sample.bodyExtension), 0.85);
  const elbow = percentile(usable.map((sample) => sample.elbowAngle), 0.72);
  const shoulder = percentile(usable.map((sample) => sample.shoulderAngle), 0.72);
  const overhead = mean(usable.map((sample) => sample.wristAboveShoulder ? 1 : 0));
  const visibility = clamp(mean(usable.map((sample) => sample.visibility)) / 100);
  const trunkRotation = clamp(percentile(usable.map((sample) => sample.trunkRotation ?? 0), 0.85) / 55);
  const kneeDrive = clamp(percentile(usable.map((sample) => sample.kneeFlexion ?? 0), 0.75) / 65);
  const handStability = mean(usable.map((sample) => sample.handLocked === false ? 0 : 1));

  const peakIndex = wristSeries.reduce(
    (bestIndex, value, index) => value > wristSeries[bestIndex] ? index : bestIndex,
    0,
  );
  const leadingSamples = usable.slice(0, Math.max(3, peakIndex));
  const trailingSamples = usable.slice(peakIndex + 1);
  const baselineWrist = percentile(
    (leadingSamples.length >= 3 ? leadingSamples : usable.slice(0, Math.ceil(usable.length / 3)))
      .map((sample) => sample.wristSpeed),
    0.5,
  );
  const recoveryWrist = trailingSamples.length >= 2
    ? percentile(trailingSamples.map((sample) => sample.wristSpeed), 0.5)
    : peakWrist;
  const accelerationContrast = clamp((peakWrist - baselineWrist - 0.12) / 0.95);
  const recoveryContrast = clamp((peakWrist - recoveryWrist - 0.08) / 0.8);
  const temporalShape = accelerationContrast * 0.68 + recoveryContrast * 0.32;

  const speed = clamp((peakWrist - 0.3) / 1.55);
  const angular = clamp((peakAngular - 35) / 470);
  const height = clamp((peakHeight - 42) / 42);
  const extension = clamp((peakExtension - 35) / 55);
  const elbowExtension = clamp((elbow - 90) / 75);
  const shoulderLift = clamp((shoulder - 45) / 100);
  const lowContact = clamp(1 - overhead * 1.1 - height * 0.18);
  const controlledSpeed = clamp(1 - Math.abs(speed - 0.34) / 0.58);
  const mediumSpeed = clamp(1 - Math.abs(speed - 0.5) / 0.62);
  const explosiveSwing = clamp((speed * 0.55 + angular * 0.45 - 0.62) / 0.34);

  const overheadFamily = clamp(overhead * 0.58 + height * 0.24 + shoulderLift * 0.18);
  const lateralFamily = clamp(lowContact * 0.47 + speed * 0.24 + angular * 0.2 + temporalShape * 0.09);
  const smashScore = overheadFamily * 0.3 + speed * 0.2 + angular * 0.18
    + extension * 0.08 + temporalShape * 0.1 + explosiveSwing * 0.09
    + trunkRotation * 0.03 + kneeDrive * 0.02;
  const clearScore = overheadFamily * 0.37 + mediumSpeed * 0.14 + extension * 0.2
    + elbowExtension * 0.17 + height * 0.12;
  const dropScore = overheadFamily * 0.39 + controlledSpeed * 0.27 + height * 0.15
    + (1 - angular) * 0.1 + shoulderLift * 0.09;
  const driveScore = lateralFamily * 0.54 + speed * 0.18 + angular * 0.14
    + shoulderLift * 0.08 + (1 - height) * 0.06;
  const scores: Array<{ type: Exclude<LiteStrokeType, "unknown" | "overhead_control">; score: number }> = [
    { type: "smash", score: smashScore + (drillMode === "smash" ? 0.07 : 0) },
    { type: "clear", score: clearScore + (drillMode === "clear" ? 0.08 : 0) },
    { type: "drop_shot", score: dropScore + (drillMode === "drop_shot" ? 0.08 : 0) },
    { type: "drive", score: driveScore + (drillMode === "drive" ? 0.07 : 0) },
  ];
  scores.sort((left, right) => right.score - left.score);

  let best: { type: Exclude<LiteStrokeType, "unknown">; score: number } = scores[0];
  const explosiveOverhead = overheadFamily >= 0.58
    && speed >= 0.62
    && angular >= 0.44
    && temporalShape >= 0.28;
  const controlledOverhead = overheadFamily >= 0.52 && explosiveSwing < 0.48;
  if (explosiveOverhead) {
    best = { type: "smash", score: smashScore + (drillMode === "smash" ? 0.07 : 0) };
  } else if (controlledOverhead && drillMode === "open") {
    best = { type: "overhead_control", score: Math.max(clearScore, dropScore) };
  } else if (controlledOverhead && (drillMode === "clear" || drillMode === "drop_shot")) {
    best = { type: drillMode, score: drillMode === "clear" ? clearScore + 0.08 : dropScore + 0.08 };
  }
  const margin = Math.max(0, best.score - scores[1].score);
  let evidence = Math.round(clamp(
    best.score * 0.69
      + clamp(margin / 0.28) * 0.12
      + visibility * 0.08
      + temporalShape * 0.08
      + handStability * 0.03,
  ) * 100);

  // Không theo dõi quả cầu nên các nhãn phụ thuộc điểm rơi/quỹ đạo không được
  // phép hiển thị như kết luận chắc chắn.
  const evidenceCap = best.type === "smash" ? 78 : best.type === "overhead_control" ? 64 : 68;
  evidence = Math.min(evidence, evidenceCap);

  const swingIntensity = Math.round(clamp(
    speed * 0.48 + angular * 0.34 + extension * 0.18,
  ) * 100);
  const postureScore = Math.round(clamp(
    elbowExtension * 0.3 + shoulderLift * 0.25 + extension * 0.25
      + visibility * 0.2,
  ) * 100);

  const hasDistinctSwing = peakWrist >= 0.34
    && peakAngular >= 30
    && duration >= 120
    && visibleRatio >= 0.58
    && temporalShape >= 0.12;
  if (!hasDistinctSwing || evidence < 45) {
    const reason = duration < 120
      ? "Chuỗi chuyển động quá ngắn để xác nhận một nhịp vung."
      : visibleRatio < 0.58
        ? "Cơ thể bị che hoặc ra khỏi khung hình ở quá nhiều frame."
        : temporalShape < 0.12
          ? "Chưa thấy nhịp tăng tốc rồi giảm tốc rõ; có thể chỉ là tư thế hoặc camera rung."
          : "Tư thế hoặc nhịp vung chưa đủ khác biệt để gán nhãn.";
    return {
      strokeType: "unknown",
      label: LABELS.unknown,
      evidence,
      certainty: "unknown",
      swingIntensity,
      postureScore,
      reason,
      family: "unknown",
    };
  }

  const certainty = evidence >= 70 ? "likely" : "possible";
  const reasonByType: Record<Exclude<LiteStrokeType, "unknown">, string> = {
    smash: "Tiếp xúc trên đầu, tăng tốc tay mạnh và duỗi người rõ.",
    clear: "Động tác trên đầu với biên độ duỗi tay lớn; cần thấy cầu để xác nhận clear.",
    drop_shot: "Động tác trên đầu nhưng nhịp tay được kiểm soát; cần điểm rơi để xác nhận drop.",
    drive: "Vùng tiếp xúc thấp hơn và tay tăng tốc nhanh; cần quỹ đạo cầu để xác nhận drive.",
    overhead_control: "Đã xác nhận nhóm đánh trên đầu có kiểm soát; chưa thể tách Clear và Drop khi không thấy cầu.",
  };
  const family: StrokeFamily = best.type === "smash"
    ? "overhead_attack"
    : best.type === "drive"
      ? "lateral"
      : "overhead_control";

  return {
    strokeType: best.type,
    label: certainty === "possible" ? `Có khả năng ${LABELS[best.type]}` : LABELS[best.type],
    evidence,
    certainty,
    swingIntensity,
    postureScore,
    reason: reasonByType[best.type],
    family,
  };
}
