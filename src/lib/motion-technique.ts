import {
  classifyPoseWindow,
  resamplePoseWindow,
  type PoseLiteSample,
} from "./pose-lite-classifier.ts";
import type { DominantSide } from "./pose-metrics.ts";

export type TechniqueMode =
  | "open"
  | "smash"
  | "backhand"
  | "clear"
  | "drop_shot"
  | "drive";

export type MotionTechnique = Exclude<TechniqueMode, "open"> | "overhead_control" | "unknown";

export type FootworkMode =
  | "footwork_auto"
  | "split_step"
  | "running_step"
  | "chasse"
  | "cross_behind"
  | "hop_pivot"
  | "lunge"
  | "jump_landing"
  | "scissor_jump"
  | "china_jump"
  | "forehand_forecourt"
  | "backhand_forecourt"
  | "forehand_rearcourt"
  | "backhand_rearcourt"
  | "recovery_to_base"
  | "six_corner_shadow";

export type FootworkTechnique = Exclude<FootworkMode, "footwork_auto"> | "footwork_unknown";
export type TrainingModule = "stroke" | "footwork";
export type TrainingDrill = TechniqueMode | FootworkMode;

export type MotionPhase =
  | "ready"
  | "loading"
  | "acceleration"
  | "contact_zone"
  | "follow_through"
  | "start"
  | "approach"
  | "hit_balance"
  | "recovery";

export type MotionPhaseScore = {
  phase: MotionPhase;
  score: number;
  status: "good" | "review" | "missing";
};

export type MotionPeakMetrics = {
  elbowAngle: number;
  shoulderAngle: number;
  kneeFlexion: number;
  trunkRotation: number;
  contactHeight: number;
  bodyExtension: number;
  wristSpeed: number;
  armAngularSpeed: number;
  balance: number;
  footSpeed?: number;
  centerSpeed?: number;
  stanceWidth?: number;
  landingSymmetry?: number;
  travel?: number;
  verticalBounce?: number;
  alternation?: number;
};

export type MotionAssessment = {
  module: TrainingModule;
  technique: MotionTechnique | FootworkTechnique;
  label: string;
  evidence: number;
  overallScore: number;
  postureScore: number;
  rhythmScore: number;
  recoveryScore: number;
  captureQuality: number;
  intensity: number;
  dominantSide: DominantSide;
  durationMs: number;
  phases: MotionPhaseScore[];
  metrics: MotionPeakMetrics;
  strengths: string[];
  corrections: string[];
  summary: string;
};

const LABELS: Record<MotionTechnique, string> = {
  smash: "Smash",
  backhand: "Backhand",
  clear: "Clear / phông",
  drop_shot: "Drop shot",
  drive: "Drive / tạt",
  overhead_control: "Cú đánh trên đầu có kiểm soát",
  unknown: "Chuyển động chưa rõ",
};

const clamp = (value: number, min = 0, max = 1) =>
  Math.min(max, Math.max(min, value));

const mean = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

function percentile(values: number[], ratio: number) {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * ratio))];
}

function averageField(samples: PoseLiteSample[], field: keyof PoseLiteSample) {
  return mean(samples.map((sample) => Number(sample[field] ?? 0)));
}

function phaseScore(phase: MotionPhase, rawScore: number): MotionPhaseScore {
  const score = Math.round(clamp(rawScore) * 100);
  return {
    phase,
    score,
    status: score >= 72 ? "good" : score >= 45 ? "review" : "missing",
  };
}

function inferTechnique(samples: PoseLiteSample[]): MotionTechnique {
  const result = classifyPoseWindow(samples, { drillMode: "open" });
  return result.strokeType;
}

function techniqueContactScore(technique: MotionTechnique, values: {
  overhead: number;
  height: number;
  elbow: number;
  shoulder: number;
  extension: number;
  rotation: number;
  acrossBody: number;
  lateralReach: number;
  speed: number;
  compact: number;
}) {
  if (technique === "backhand") {
    return values.acrossBody * 0.27 + values.lateralReach * 0.18
      + values.rotation * 0.18 + values.elbow * 0.12
      + values.speed * 0.15 + values.compact * 0.1;
  }
  if (technique === "drive") {
    return (1 - values.overhead) * 0.18 + values.lateralReach * 0.21
      + values.speed * 0.24 + values.compact * 0.18
      + values.elbow * 0.09 + values.rotation * 0.1;
  }
  if (technique === "drop_shot") {
    return values.overhead * 0.25 + values.height * 0.22 + values.elbow * 0.16
      + values.shoulder * 0.13 + values.extension * 0.12
      + (1 - values.speed) * 0.12;
  }
  if (technique === "clear" || technique === "overhead_control") {
    return values.overhead * 0.24 + values.height * 0.2 + values.elbow * 0.18
      + values.shoulder * 0.12 + values.extension * 0.17 + values.rotation * 0.09;
  }
  return values.overhead * 0.19 + values.height * 0.17 + values.elbow * 0.16
    + values.shoulder * 0.12 + values.extension * 0.14
    + values.rotation * 0.1 + values.speed * 0.12;
}

export function assessMotionWindow(
  rawSamples: PoseLiteSample[],
  mode: TechniqueMode,
  dominantSide: DominantSide,
): MotionAssessment {
  const samples = resamplePoseWindow(rawSamples, 40);
  const technique = mode === "open" ? inferTechnique(samples) : mode;
  const label = LABELS[technique];
  const durationMs = samples.length > 1
    ? Math.max(0, samples.at(-1)!.timestamp - samples[0].timestamp)
    : 0;
  const peakIndex = samples.reduce(
    (best, sample, index) => sample.wristSpeed > samples[best].wristSpeed ? index : best,
    0,
  );
  const beforePeak = samples.slice(0, Math.max(2, peakIndex));
  const opening = samples.slice(0, Math.max(2, Math.ceil(samples.length * 0.25)));
  const closing = samples.slice(Math.max(0, Math.floor(samples.length * 0.72)));
  const visibleRatio = mean(samples.map((sample) => clamp(sample.visibility / 100)));
  const lockedRatio = mean(samples.map((sample) => sample.handLocked === false ? 0 : 1));

  const peakWrist = percentile(samples.map((sample) => sample.wristSpeed), 0.9);
  const peakAngular = percentile(samples.map((sample) => sample.armAngularSpeed), 0.9);
  const peakElbow = percentile(samples.map((sample) => sample.elbowAngle), 0.82);
  const peakShoulder = percentile(samples.map((sample) => sample.shoulderAngle), 0.82);
  const peakHeight = percentile(samples.map((sample) => sample.contactHeight), 0.85);
  const peakExtension = percentile(samples.map((sample) => sample.bodyExtension), 0.85);
  const peakRotation = percentile(samples.map((sample) => sample.trunkRotation ?? 0), 0.85);
  const peakKnee = percentile(beforePeak.map((sample) => sample.kneeFlexion ?? 0), 0.75);
  const peakAcrossBody = percentile(samples.map((sample) => sample.wristAcrossBody ?? 0), 0.82);
  const peakLateralReach = percentile(samples.map((sample) => sample.lateralReach ?? 0), 0.82);
  const averageBalance = mean(samples.map((sample) => sample.balanceScore ?? 70));
  const averageStance = mean(opening.map((sample) => sample.stanceWidth ?? 0.7));
  const openingSpeed = averageField(opening, "wristSpeed");
  const closingSpeed = averageField(closing, "wristSpeed");
  const accelerationContrast = clamp((peakWrist - openingSpeed - 0.1) / 1.05);
  const decelerationContrast = clamp((peakWrist - closingSpeed - 0.08) / 0.92);
  const temporalShape = accelerationContrast * 0.62 + decelerationContrast * 0.38;

  const speed = clamp((peakWrist - 0.24) / 1.65);
  const angular = clamp((peakAngular - 28) / 520);
  const height = clamp((peakHeight - 42) / 45);
  const elbow = clamp((peakElbow - 88) / 80);
  const shoulder = clamp((peakShoulder - 42) / 112);
  const extension = clamp((peakExtension - 30) / 65);
  const rotation = clamp(peakRotation / 52);
  const kneeLoad = clamp(peakKnee / 58);
  const acrossBody = clamp(peakAcrossBody / 100);
  const lateralReach = clamp(peakLateralReach / 100);
  const balance = clamp(averageBalance / 100);
  const stance = clamp((averageStance - 0.25) / 0.85);
  const overhead = mean(samples.map((sample) => sample.wristAboveShoulder ? 1 : 0));
  const compact = clamp(1 - Math.max(0, durationMs - 700) / 700);

  const ready = phaseScore("ready", visibleRatio * 0.3 + balance * 0.25
    + stance * 0.2 + clamp(1 - openingSpeed / 0.8) * 0.25);
  const loading = phaseScore("loading", rotation * 0.34 + kneeLoad * 0.24
    + clamp(1 - averageField(beforePeak, "elbowAngle") / 185) * 0.16
    + visibleRatio * 0.16 + stance * 0.1);
  const acceleration = phaseScore("acceleration", accelerationContrast * 0.42
    + speed * 0.25 + angular * 0.23 + visibleRatio * 0.1);
  const contact = phaseScore("contact_zone", techniqueContactScore(technique, {
    overhead,
    height,
    elbow,
    shoulder,
    extension,
    rotation,
    acrossBody,
    lateralReach,
    speed,
    compact,
  }));
  const follow = phaseScore("follow_through", decelerationContrast * 0.36
    + extension * 0.2 + rotation * 0.16 + balance * 0.18 + visibleRatio * 0.1);
  const recovery = phaseScore("recovery", clamp(1 - closingSpeed / 0.9) * 0.34
    + balance * 0.33 + stance * 0.18 + visibleRatio * 0.15);
  const phases = [ready, loading, acceleration, contact, follow, recovery];

  const postureScore = Math.round((loading.score * 0.23 + contact.score * 0.47
    + follow.score * 0.3));
  const rhythmScore = Math.round(clamp(temporalShape * 0.72
    + clamp(durationMs / 420) * 0.12 + compact * 0.16) * 100);
  const recoveryScore = recovery.score;
  const intensity = Math.round(clamp(speed * 0.48 + angular * 0.34 + extension * 0.18) * 100);
  const captureQuality = Math.round(clamp(visibleRatio * 0.72 + lockedRatio * 0.18
    + clamp(samples.length / 14) * 0.1) * 100);
  const overallScore = Math.round(postureScore * 0.44 + rhythmScore * 0.24
    + recoveryScore * 0.2 + ready.score * 0.12);
  const evidence = Math.min(82, Math.round(captureQuality * 0.53
    + temporalShape * 100 * 0.31 + clamp(samples.length / 16) * 100 * 0.16));

  const strengths: string[] = [];
  const corrections: string[] = [];
  if (loading.score >= 72) strengths.push("Pha kéo vợt có xoay thân và tạo tải rõ.");
  if (acceleration.score >= 72) strengths.push("Nhịp tăng tốc tay rõ trước vùng tiếp xúc.");
  if (contact.score >= 72) strengths.push("Tư thế vùng tiếp xúc phù hợp với bài tập đã chọn.");
  if (recovery.score >= 72) strengths.push("Giữ thăng bằng và giảm tốc tốt sau động tác.");
  if (!strengths.length) strengths.push("Đã ghi nhận đủ chuỗi chuyển động để bắt đầu so sánh các lần lặp.");

  if (ready.score < 58) corrections.push("Ổn định tư thế sẵn sàng và giữ toàn thân trong khung hình.");
  if (loading.score < 60) corrections.push("Chuẩn bị sớm hơn: xoay thân và tạo tải chân trước khi tăng tốc tay.");
  if (acceleration.score < 60) corrections.push("Tách rõ pha kéo vợt và pha tăng tốc, tránh vung đều từ đầu đến cuối.");
  if (contact.score < 60) {
    corrections.push(technique === "backhand"
      ? "Đưa khuỷu và mặt ngoài cẳng tay vào vị trí sớm hơn, giữ động tác gọn trước thân."
      : technique === "drive"
        ? "Giữ động tác gọn, tiếp xúc trước thân và hạn chế biên độ thừa."
        : "Vươn cao hơn và hoàn tất duỗi khuỷu ở vùng tiếp xúc.");
  }
  if (follow.score < 58) corrections.push("Cho tay theo đà tự nhiên nhưng giữ trục thân ổn định.");
  if (recovery.score < 62) corrections.push("Kết thúc động tác bằng tư thế cân bằng để sẵn sàng cho lần tiếp theo.");
  if (captureQuality < 62) corrections.unshift("Cải thiện góc quay: đặt máy ngang hông, thấy trọn đầu–chân và tránh che tay vợt.");

  const summary = technique === "unknown"
    ? "Đã thấy chuyển động nhưng chưa đủ khác biệt để gán nhóm kỹ thuật."
    : `${label}: ${overallScore}/100 chất lượng chuyển động, ưu tiên ${corrections[0]?.toLowerCase() ?? "duy trì nhịp hiện tại"}`;

  return {
    module: "stroke",
    technique,
    label,
    evidence,
    overallScore,
    postureScore,
    rhythmScore,
    recoveryScore,
    captureQuality,
    intensity,
    dominantSide,
    durationMs,
    phases,
    metrics: {
      elbowAngle: Math.round(peakElbow),
      shoulderAngle: Math.round(peakShoulder),
      kneeFlexion: Math.round(peakKnee),
      trunkRotation: Math.round(peakRotation),
      contactHeight: Math.round(peakHeight),
      bodyExtension: Math.round(peakExtension),
      wristSpeed: Number(peakWrist.toFixed(2)),
      armAngularSpeed: Math.round(peakAngular),
      balance: Math.round(averageBalance),
    },
    strengths: strengths.slice(0, 3),
    corrections: corrections.slice(0, 4),
    summary,
  };
}
