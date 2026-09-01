import {
  classifyPoseWindow,
  resamplePoseWindow,
  type PoseLiteSample,
} from "./pose-lite-classifier.ts";
import type { DominantSide } from "./pose-metrics.ts";
import type { StudioLanguage } from "./studio-types.ts";

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

const LABELS: Record<StudioLanguage, Record<MotionTechnique, string>> = {
  vi: {
    smash: "Smash / đập cầu",
    backhand: "Backhand / trái tay",
    clear: "Clear / phông cầu",
    drop_shot: "Drop shot / bỏ nhỏ",
    drive: "Drive / tạt cầu",
    overhead_control: "Cú đánh trên đầu có kiểm soát",
    unknown: "Chuyển động chưa rõ",
  },
  en: {
    smash: "Smash",
    backhand: "Backhand",
    clear: "Clear",
    drop_shot: "Drop shot",
    drive: "Drive",
    overhead_control: "Controlled overhead stroke",
    unknown: "Unclassified movement",
  },
  de: {
    smash: "Smash",
    backhand: "Rückhand",
    clear: "Clear",
    drop_shot: "Drop",
    drive: "Drive",
    overhead_control: "Kontrollierter Überkopfschlag",
    unknown: "Nicht eindeutig klassifizierte Bewegung",
  },
};

const FEEDBACK = {
  vi: {
    loadingStrength: "Pha kéo vợt có xoay thân và tạo tải rõ.",
    accelerationStrength: "Nhịp tăng tốc tay rõ trước vùng tiếp xúc.",
    contactStrength: "Tư thế vùng tiếp xúc phù hợp với bài tập đã chọn.",
    recoveryStrength: "Giữ thăng bằng và giảm tốc tốt sau động tác.",
    baselineStrength: "Đã ghi nhận đủ chuỗi chuyển động để bắt đầu so sánh các lần lặp.",
    readyCorrection: "Ổn định tư thế sẵn sàng và giữ toàn thân trong khung hình.",
    loadingCorrection: "Chuẩn bị sớm hơn: xoay thân và tạo tải chân trước khi tăng tốc tay.",
    accelerationCorrection: "Tách rõ pha kéo vợt và pha tăng tốc, tránh vung đều từ đầu đến cuối.",
    backhandCorrection: "Đưa khuỷu và mặt ngoài cẳng tay vào vị trí sớm hơn, giữ động tác gọn trước thân.",
    driveCorrection: "Giữ động tác gọn, đưa vùng tiếp xúc ra trước thân và hạn chế biên độ thừa.",
    overheadCorrection: "Vươn cao hơn và hoàn tất duỗi khuỷu ở vùng tiếp xúc.",
    followCorrection: "Cho tay theo đà tự nhiên nhưng giữ trục thân ổn định.",
    recoveryCorrection: "Kết thúc động tác bằng tư thế cân bằng để sẵn sàng cho lần tiếp theo.",
    captureCorrection: "Cải thiện góc quay: đặt máy ngang hông, thấy trọn đầu–chân và tránh che tay vợt.",
    unknownSummary: "Đã thấy chuyển động nhưng chưa đủ khác biệt để gán nhóm kỹ thuật.",
    maintain: "Duy trì nhịp hiện tại.",
    summary: (label: string, score: number, priority: string) => `${label}: ${score}/100 chất lượng chuyển động. Ưu tiên: ${priority}`,
  },
  en: {
    loadingStrength: "The loading phase shows clear trunk rotation and lower-body loading.",
    accelerationStrength: "The racket arm accelerates clearly before the contact zone.",
    contactStrength: "Contact-zone posture matches the selected drill.",
    recoveryStrength: "Balance and deceleration are well controlled after the stroke.",
    baselineStrength: "The motion sequence is complete enough to compare repetitions.",
    readyCorrection: "Stabilize the ready position and keep the full body in frame.",
    loadingCorrection: "Prepare earlier: rotate the trunk and load the legs before accelerating the arm.",
    accelerationCorrection: "Separate loading from acceleration more clearly; avoid swinging at one constant speed.",
    backhandCorrection: "Position the elbow and outer forearm earlier, keeping the action compact and in front of the body.",
    driveCorrection: "Keep the action compact, move the contact zone in front of the body and reduce unnecessary backswing.",
    overheadCorrection: "Reach higher and complete elbow extension through the contact zone.",
    followCorrection: "Allow a natural follow-through while keeping the trunk stable.",
    recoveryCorrection: "Finish in a balanced position so you are ready for the next repetition.",
    captureCorrection: "Improve the camera angle: place the phone at hip height, keep the athlete visible from head to toe and avoid occluding the racket arm.",
    unknownSummary: "Movement was detected, but the pattern is not distinct enough to classify.",
    maintain: "Maintain the current rhythm.",
    summary: (label: string, score: number, priority: string) => `${label}: ${score}/100 motion quality. Priority: ${priority}`,
  },
  de: {
    loadingStrength: "In der Ausholphase sind Rumpfrotation und Belastungsaufbau klar erkennbar.",
    accelerationStrength: "Der Schlagarm beschleunigt deutlich vor der Treffzone.",
    contactStrength: "Die Körperposition in der Treffzone passt zur gewählten Übung.",
    recoveryStrength: "Gleichgewicht und Abbremsen sind nach dem Schlag gut kontrolliert.",
    baselineStrength: "Der Bewegungsablauf ist vollständig genug, um Wiederholungen zu vergleichen.",
    readyCorrection: "Stabilisiere die Bereitschaftsposition und bleibe vollständig im Bild.",
    loadingCorrection: "Bereite früher vor: Rotiere den Rumpf und belaste die Beine, bevor der Schlagarm beschleunigt.",
    accelerationCorrection: "Trenne Aushol- und Beschleunigungsphase deutlicher; vermeide eine gleichförmige Schlagbewegung.",
    backhandCorrection: "Bringe Ellbogen und Außenseite des Unterarms früher in Position und halte die Bewegung kompakt vor dem Körper.",
    driveCorrection: "Halte die Bewegung kompakt, verlagere die Treffzone vor den Körper und reduziere unnötiges Ausholen.",
    overheadCorrection: "Strecke dich höher und führe die Ellbogenstreckung durch die Treffzone zu Ende.",
    followCorrection: "Lass den Schlag natürlich ausschwingen und halte dabei den Rumpf stabil.",
    recoveryCorrection: "Beende die Bewegung ausbalanciert, damit du für die nächste Wiederholung bereit bist.",
    captureCorrection: "Verbessere den Kamerawinkel: Smartphone auf Hüfthöhe, Person vollständig von Kopf bis Fuß im Bild und Schlagarm frei sichtbar.",
    unknownSummary: "Eine Bewegung wurde erkannt, das Muster ist jedoch nicht eindeutig genug für eine Klassifizierung.",
    maintain: "Behalte den aktuellen Rhythmus bei.",
    summary: (label: string, score: number, priority: string) => `${label}: ${score}/100 Bewegungsqualität. Priorität: ${priority}`,
  },
} as const;

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

export function localizeMotionAssessment(
  assessment: MotionAssessment,
  language: StudioLanguage,
): MotionAssessment {
  if (assessment.module !== "stroke") return assessment;
  const copy = FEEDBACK[language];
  const scoreFor = (phase: MotionPhase) => assessment.phases.find((entry) => entry.phase === phase)?.score ?? 0;
  const loading = scoreFor("loading");
  const acceleration = scoreFor("acceleration");
  const contact = scoreFor("contact_zone");
  const follow = scoreFor("follow_through");
  const recovery = scoreFor("recovery");
  const ready = scoreFor("ready");
  const technique = assessment.technique as MotionTechnique;
  const label = LABELS[language][technique];
  const strengths: string[] = [];
  const corrections: string[] = [];

  if (loading >= 72) strengths.push(copy.loadingStrength);
  if (acceleration >= 72) strengths.push(copy.accelerationStrength);
  if (contact >= 72) strengths.push(copy.contactStrength);
  if (recovery >= 72) strengths.push(copy.recoveryStrength);
  if (!strengths.length) strengths.push(copy.baselineStrength);
  if (ready < 58) corrections.push(copy.readyCorrection);
  if (loading < 60) corrections.push(copy.loadingCorrection);
  if (acceleration < 60) corrections.push(copy.accelerationCorrection);
  if (contact < 60) corrections.push(technique === "backhand"
    ? copy.backhandCorrection
    : technique === "drive"
      ? copy.driveCorrection
      : copy.overheadCorrection);
  if (follow < 58) corrections.push(copy.followCorrection);
  if (recovery < 62) corrections.push(copy.recoveryCorrection);
  if (assessment.captureQuality < 62) corrections.unshift(copy.captureCorrection);

  return {
    ...assessment,
    label,
    strengths: strengths.slice(0, 3),
    corrections: corrections.slice(0, 4),
    summary: technique === "unknown"
      ? copy.unknownSummary
      : copy.summary(label, assessment.overallScore, corrections[0] ?? copy.maintain),
  };
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
  language: StudioLanguage = "vi",
): MotionAssessment {
  const samples = resamplePoseWindow(rawSamples, 40);
  const technique = mode === "open" ? inferTechnique(samples) : mode;
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

  return localizeMotionAssessment({
    module: "stroke",
    technique,
    label: "",
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
    strengths: [],
    corrections: [],
    summary: "",
  }, language);
}
