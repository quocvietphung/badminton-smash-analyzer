import { resamplePoseWindow, type PoseLiteSample } from "./pose-lite-classifier.ts";
import type {
  FootworkMode,
  FootworkTechnique,
  MotionAssessment,
  MotionPhase,
  MotionPhaseScore,
} from "./motion-technique.ts";
import type { DominantSide } from "./pose-metrics.ts";
import type { StudioLanguage } from "./studio-types.ts";

export type FootworkCatalogItem = {
  value: FootworkMode;
  group: "foundation" | "court_pattern" | "advanced";
  labelVi: string;
  labelEn: string;
  labelDe: string;
  short: string;
};

export const FOOTWORK_CATALOG: FootworkCatalogItem[] = [
  { value: "footwork_auto", group: "foundation", labelVi: "Tự nhận bộ pháp", labelEn: "Auto detect footwork", labelDe: "Beinarbeit automatisch erkennen", short: "AUTO" },
  { value: "split_step", group: "foundation", labelVi: "Split step / bước tách", labelEn: "Split step", labelDe: "Split Step", short: "SS" },
  { value: "running_step", group: "foundation", labelVi: "Running step / bước chạy", labelEn: "Running step", labelDe: "Laufschritt", short: "RUN" },
  { value: "chasse", group: "foundation", labelVi: "Chassé / bước đuổi", labelEn: "Chassé", labelDe: "Chassé-Schritt", short: "CH" },
  { value: "cross_behind", group: "foundation", labelVi: "Cross-behind / bước chéo sau", labelEn: "Cross-behind step", labelDe: "Kreuzschritt nach hinten", short: "XB" },
  { value: "hop_pivot", group: "foundation", labelVi: "Hop & pivot / bật và xoay", labelEn: "Hop and pivot", labelDe: "Hüpf- und Drehschritt", short: "HP" },
  { value: "lunge", group: "foundation", labelVi: "Lunge / bước chùng", labelEn: "Lunge", labelDe: "Ausfallschritt", short: "LG" },
  { value: "jump_landing", group: "foundation", labelVi: "Jump & landing / bật nhảy và tiếp đất", labelEn: "Jump and landing", labelDe: "Sprung und Landung", short: "JL" },
  { value: "forehand_forecourt", group: "court_pattern", labelVi: "Di chuyển lên trước thuận tay", labelEn: "Forehand forecourt movement", labelDe: "Vorhandbewegung ins Vorderfeld", short: "FF" },
  { value: "backhand_forecourt", group: "court_pattern", labelVi: "Di chuyển lên trước trái tay", labelEn: "Backhand forecourt movement", labelDe: "Rückhandbewegung ins Vorderfeld", short: "BF" },
  { value: "forehand_rearcourt", group: "court_pattern", labelVi: "Di chuyển cuối sân thuận tay", labelEn: "Forehand rearcourt movement", labelDe: "Vorhandbewegung ins Hinterfeld", short: "FR" },
  { value: "backhand_rearcourt", group: "court_pattern", labelVi: "Di chuyển cuối sân trái tay", labelEn: "Backhand rearcourt movement", labelDe: "Rückhandbewegung ins Hinterfeld", short: "BR" },
  { value: "recovery_to_base", group: "court_pattern", labelVi: "Hồi vị về vị trí cơ bản", labelEn: "Recovery to base position", labelDe: "Rückkehr zur Grundposition", short: "RC" },
  { value: "six_corner_shadow", group: "court_pattern", labelVi: "Shadow footwork 6 góc", labelEn: "Six-corner shadow footwork", labelDe: "Sechs-Ecken-Schattenlauf", short: "6C" },
  { value: "scissor_jump", group: "advanced", labelVi: "Scissor jump / bật đổi chân", labelEn: "Scissor jump", labelDe: "Umsprung", short: "SJ" },
  { value: "china_jump", group: "advanced", labelVi: "China jump / bật ngang", labelEn: "China jump", labelDe: "Chinasprung", short: "CJ" },
];

const UNKNOWN_LABELS: Record<StudioLanguage, string> = {
  vi: "Bộ pháp chưa rõ",
  en: "Unclassified footwork",
  de: "Nicht eindeutig klassifizierte Beinarbeit",
};

function labelForTechnique(technique: FootworkTechnique, language: StudioLanguage) {
  if (technique === "footwork_unknown") return UNKNOWN_LABELS[language];
  const item = FOOTWORK_CATALOG.find((entry) => entry.value === technique);
  if (language === "vi") return item?.labelVi ?? UNKNOWN_LABELS.vi;
  if (language === "de") return item?.labelDe ?? UNKNOWN_LABELS.de;
  return item?.labelEn ?? UNKNOWN_LABELS.en;
}

const clamp = (value: number, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const mean = (values: number[]) => values.length
  ? values.reduce((sum, value) => sum + value, 0) / values.length
  : 0;

function percentile(values: number[], ratio: number) {
  if (!values.length) return 0;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor((ordered.length - 1) * ratio))];
}

function scorePhase(phase: MotionPhase, scoreValue: number): MotionPhaseScore {
  const score = Math.round(clamp(scoreValue) * 100);
  return { phase, score, status: score >= 72 ? "good" : score >= 45 ? "review" : "missing" };
}

function alternationScore(samples: PoseLiteSample[]) {
  let activeFrames = 0;
  let changes = 0;
  let previousSign = 0;
  for (const sample of samples) {
    const delta = (sample.leftAnkleSpeed ?? 0) - (sample.rightAnkleSpeed ?? 0);
    if (Math.abs(delta) < 0.12) continue;
    activeFrames += 1;
    const sign = Math.sign(delta);
    if (previousSign && sign !== previousSign) changes += 1;
    previousSign = sign;
  }
  return clamp((changes / Math.max(1, activeFrames - 1)) * 4.2);
}

function normalizedTravel(samples: PoseLiteSample[]) {
  const first = samples[0];
  const scale = Math.max(0.08, mean(samples.map((sample) => sample.bodyScale ?? 0.2)));
  const positions = samples.map((sample) => ({
    x: (sample.centerX ?? first.centerX ?? 0) - (first.centerX ?? 0),
    y: (sample.centerY ?? first.centerY ?? 0) - (first.centerY ?? 0),
  }));
  const distances = positions.map((point) => Math.hypot(point.x, point.y) / scale);
  const peak = Math.max(0, ...distances);
  const final = distances.at(-1) ?? peak;
  return { peak, final, returnRatio: peak > 0.12 ? clamp(1 - final / peak) : 0 };
}

function crossingAndSwitch(samples: PoseLiteSample[]) {
  const relative = samples.map((sample) => (sample.leftAnkleX ?? 0) - (sample.rightAnkleX ?? 0));
  const meaningful = relative.filter((value) => Math.abs(value) > 0.012);
  if (meaningful.length < 2) return { crossing: 0, switchScore: 0 };
  const start = Math.sign(meaningful[0]);
  const signChanges = meaningful.filter((value) => Math.sign(value) !== start).length;
  const crossing = clamp(signChanges / Math.max(2, meaningful.length * 0.25));
  const switchScore = Math.sign(meaningful.at(-1) ?? 0) !== start ? 1 : crossing * 0.55;
  return { crossing, switchScore };
}

function inferFootwork(values: {
  flight: number;
  travel: number;
  crossing: number;
  switchScore: number;
  kneeLoad: number;
  stance: number;
  stanceExpansion: number;
  alternation: number;
  rotation: number;
}): FootworkTechnique {
  if (values.flight > 0.55 && values.switchScore > 0.55 && values.rotation > 0.32) return "scissor_jump";
  if (values.flight > 0.58 && values.travel > 0.62) return "china_jump";
  if (values.flight > 0.52) return "jump_landing";
  if (values.crossing > 0.58 && values.travel > 0.38) return "cross_behind";
  if (values.kneeLoad > 0.6 && values.stance > 0.56 && values.travel > 0.35) return "lunge";
  if (values.alternation > 0.62 && values.travel > 0.5) return "running_step";
  if (values.travel > 0.4 && values.crossing < 0.35) return "chasse";
  if (values.stanceExpansion > 0.38 && values.kneeLoad > 0.28) return "split_step";
  if (values.rotation > 0.42 && values.flight > 0.22) return "hop_pivot";
  return "footwork_unknown";
}

function skillScore(skill: FootworkTechnique, values: {
  kneeLoad: number;
  stance: number;
  stanceExpansion: number;
  footSpeed: number;
  centerSpeed: number;
  travel: number;
  alternation: number;
  crossing: number;
  switchScore: number;
  flight: number;
  landing: number;
  balance: number;
  rotation: number;
  recoveryReturn: number;
}) {
  const general = values.footSpeed * 0.18 + values.centerSpeed * 0.14
    + values.balance * 0.25 + values.landing * 0.18 + values.recoveryReturn * 0.25;
  if (skill === "split_step") return values.stanceExpansion * 0.29 + values.kneeLoad * 0.24
    + values.flight * 0.17 + values.balance * 0.18 + values.footSpeed * 0.12;
  if (skill === "running_step") return values.alternation * 0.28 + values.travel * 0.22
    + values.footSpeed * 0.2 + values.centerSpeed * 0.16 + values.balance * 0.14;
  if (skill === "chasse") return (1 - values.crossing) * 0.25 + values.travel * 0.24
    + values.footSpeed * 0.2 + values.balance * 0.18 + values.recoveryReturn * 0.13;
  if (skill === "cross_behind") return values.crossing * 0.29 + values.travel * 0.2
    + values.rotation * 0.17 + values.footSpeed * 0.17 + values.balance * 0.17;
  if (skill === "hop_pivot") return values.flight * 0.25 + values.rotation * 0.27
    + values.landing * 0.19 + values.balance * 0.17 + values.footSpeed * 0.12;
  if (skill === "lunge") return values.kneeLoad * 0.29 + values.stance * 0.22
    + values.travel * 0.17 + values.balance * 0.17 + values.recoveryReturn * 0.15;
  if (skill === "jump_landing") return values.flight * 0.29 + values.landing * 0.29
    + values.kneeLoad * 0.16 + values.balance * 0.16 + values.recoveryReturn * 0.1;
  if (skill === "scissor_jump") return values.flight * 0.22 + values.switchScore * 0.24
    + values.rotation * 0.2 + values.landing * 0.18 + values.balance * 0.16;
  if (skill === "china_jump") return values.flight * 0.24 + values.travel * 0.24
    + values.landing * 0.2 + values.footSpeed * 0.17 + values.balance * 0.15;
  if (skill === "recovery_to_base") return values.recoveryReturn * 0.42
    + values.balance * 0.28 + values.centerSpeed * 0.16 + values.landing * 0.14;
  if (["forehand_forecourt", "backhand_forecourt"].includes(skill)) {
    return values.kneeLoad * 0.23 + values.travel * 0.19 + values.stance * 0.16
      + values.recoveryReturn * 0.2 + values.balance * 0.14 + values.footSpeed * 0.08;
  }
  if (["forehand_rearcourt", "backhand_rearcourt"].includes(skill)) {
    return values.travel * 0.2 + values.rotation * 0.19 + values.footSpeed * 0.16
      + values.landing * 0.15 + values.recoveryReturn * 0.16 + values.balance * 0.14;
  }
  if (skill === "six_corner_shadow") return general * 0.72 + values.alternation * 0.14 + values.travel * 0.14;
  return general;
}

const FOOTWORK_FEEDBACK = {
  vi: {
    startStrength: "Pha xuất phát có tải gối và mở trụ rõ.",
    approachStrength: "Nhịp chân tạo được chuyển động tiếp cận rõ ràng.",
    hitStrength: "Hình thái chân phù hợp với bài tập bộ pháp đã chọn.",
    recoveryStrength: "Kết thúc cân bằng và có xu hướng trở lại vị trí ban đầu.",
    baselineStrength: "Đã ghi nhận đủ chuỗi chân để bắt đầu so sánh các lần lặp.",
    startCorrection: "Hạ trọng tâm và tạo split step rõ trước khi di chuyển.",
    approachCorrection: "Giữ nhịp chân ngắn, liên tục và tránh đứng thẳng khi đang tiếp cận.",
    lungeCorrection: "Tăng độ dài bước chùng nhưng giữ gối và thân trong trạng thái kiểm soát.",
    jumpCorrection: "Tiếp đất mềm hơn, phân bố tải đều và giữ thân ở giữa hai chân.",
    hitCorrection: "Làm rõ hình thái chân của bài tập đã chọn và giữ thân cân bằng khi đổi hướng.",
    recoveryCorrection: "Đẩy khỏi chân trụ sớm hơn và hoàn tất hồi vị trước lần lặp tiếp theo.",
    captureCorrection: "Đặt máy ngang hông, thấy rõ cả hai bàn chân và chừa khoảng di chuyển quanh VĐV.",
    maintain: "Duy trì nhịp hiện tại.",
    summary: (label: string, score: number, priority: string) => `${label}: ${score}/100 chất lượng chuyển động. Ưu tiên: ${priority}`,
  },
  en: {
    startStrength: "The start phase shows clear knee loading and stance preparation.",
    approachStrength: "The foot rhythm creates a distinct approach movement.",
    hitStrength: "Lower-body form matches the selected footwork drill.",
    recoveryStrength: "The movement finishes in balance and returns toward the starting position.",
    baselineStrength: "The lower-body sequence is complete enough to compare repetitions.",
    startCorrection: "Lower the center of mass and use a distinct split step before moving.",
    approachCorrection: "Keep the steps short and continuous; avoid standing upright during the approach.",
    lungeCorrection: "Increase lunge length while keeping the knee and trunk under control.",
    jumpCorrection: "Land more softly, distribute the load evenly and keep the trunk centered between the feet.",
    hitCorrection: "Make the selected footwork pattern more distinct and stay balanced when changing direction.",
    recoveryCorrection: "Push off the support leg earlier and complete recovery before the next repetition.",
    captureCorrection: "Place the phone at hip height, keep both feet visible and leave enough movement space around the athlete.",
    maintain: "Maintain the current rhythm.",
    summary: (label: string, score: number, priority: string) => `${label}: ${score}/100 motion quality. Priority: ${priority}`,
  },
  de: {
    startStrength: "In der Startphase sind Kniebelastung und Vorbereitung des Stands klar erkennbar.",
    approachStrength: "Der Laufrhythmus erzeugt eine deutlich erkennbare Annäherungsbewegung.",
    hitStrength: "Die Beinstellung passt zur gewählten Lauftechnikübung.",
    recoveryStrength: "Die Bewegung endet ausbalanciert und führt zurück in Richtung Ausgangsposition.",
    baselineStrength: "Der Bewegungsablauf der Beine ist vollständig genug, um Wiederholungen zu vergleichen.",
    startCorrection: "Senke den Körperschwerpunkt und nutze vor der Bewegung einen klaren Split Step.",
    approachCorrection: "Halte die Schritte kurz und flüssig; richte dich während der Annäherung nicht vollständig auf.",
    lungeCorrection: "Vergrößere den Ausfallschritt und halte dabei Knie und Rumpf kontrolliert.",
    jumpCorrection: "Lande weicher, verteile die Belastung gleichmäßig und halte den Rumpf mittig zwischen den Füßen.",
    hitCorrection: "Führe das gewählte Lauftechnikmuster deutlicher aus und bleibe beim Richtungswechsel ausbalanciert.",
    recoveryCorrection: "Drücke dich früher vom Stützbein ab und schließe die Rückkehr vor der nächsten Wiederholung ab.",
    captureCorrection: "Platziere das Smartphone auf Hüfthöhe, halte beide Füße sichtbar und lasse ausreichend Bewegungsraum um die Person.",
    maintain: "Behalte den aktuellen Rhythmus bei.",
    summary: (label: string, score: number, priority: string) => `${label}: ${score}/100 Bewegungsqualität. Priorität: ${priority}`,
  },
} as const;

export function localizeFootworkAssessment(
  assessment: MotionAssessment,
  language: StudioLanguage,
): MotionAssessment {
  if (assessment.module !== "footwork") return assessment;
  const copy = FOOTWORK_FEEDBACK[language];
  const scoreFor = (phase: MotionPhase) => assessment.phases.find((entry) => entry.phase === phase)?.score ?? 0;
  const start = scoreFor("start");
  const approach = scoreFor("approach");
  const hitBalance = scoreFor("hit_balance");
  const recovery = scoreFor("recovery");
  const technique = assessment.technique as FootworkTechnique;
  const label = labelForTechnique(technique, language);
  const strengths: string[] = [];
  const corrections: string[] = [];

  if (start >= 72) strengths.push(copy.startStrength);
  if (approach >= 72) strengths.push(copy.approachStrength);
  if (hitBalance >= 72) strengths.push(copy.hitStrength);
  if (recovery >= 72) strengths.push(copy.recoveryStrength);
  if (!strengths.length) strengths.push(copy.baselineStrength);
  if (start < 58) corrections.push(copy.startCorrection);
  if (approach < 60) corrections.push(copy.approachCorrection);
  if (hitBalance < 60) corrections.push(technique === "lunge"
    ? copy.lungeCorrection
    : technique === "jump_landing" || technique === "scissor_jump" || technique === "china_jump"
      ? copy.jumpCorrection
      : copy.hitCorrection);
  if (recovery < 62) corrections.push(copy.recoveryCorrection);
  if (assessment.captureQuality < 64) corrections.unshift(copy.captureCorrection);

  return {
    ...assessment,
    label,
    strengths: strengths.slice(0, 3),
    corrections: corrections.slice(0, 4),
    summary: copy.summary(label, assessment.overallScore, corrections[0] ?? copy.maintain),
  };
}

export function assessFootworkWindow(
  rawSamples: PoseLiteSample[],
  mode: FootworkMode,
  dominantSide: DominantSide,
  language: StudioLanguage = "vi",
): MotionAssessment {
  const samples = resamplePoseWindow(rawSamples, 40);
  const opening = samples.slice(0, Math.max(2, Math.ceil(samples.length * 0.24)));
  const closing = samples.slice(Math.max(0, Math.floor(samples.length * 0.74)));
  const durationMs = samples.length > 1 ? samples.at(-1)!.timestamp - samples[0].timestamp : 0;
  const visibility = mean(samples.map((sample) => clamp(sample.visibility / 100)));
  const peakFootSpeedRaw = percentile(samples.map((sample) => sample.footSpeed ?? 0), 0.9);
  const peakCenterSpeedRaw = percentile(samples.map((sample) => sample.centerSpeed ?? 0), 0.88);
  const peakBounceRaw = percentile(samples.map((sample) => sample.verticalBounce ?? 0), 0.88);
  const peakKneeRaw = percentile(samples.map((sample) => Math.max(
    sample.leftKneeFlexion ?? sample.kneeFlexion ?? 0,
    sample.rightKneeFlexion ?? sample.kneeFlexion ?? 0,
  )), 0.86);
  const peakStanceRaw = percentile(samples.map((sample) => sample.stanceWidth ?? 0), 0.86);
  const openingStance = mean(opening.map((sample) => sample.stanceWidth ?? 0));
  const landingRaw = mean(closing.map((sample) => sample.landingSymmetry ?? 0));
  const balanceRaw = mean(samples.map((sample) => sample.balanceScore ?? 0));
  const rotationRaw = percentile(samples.map((sample) => sample.trunkRotation ?? 0), 0.86);
  const alternation = alternationScore(samples);
  const travelData = normalizedTravel(samples);
  const crossingData = crossingAndSwitch(samples);
  const footSpeed = clamp((peakFootSpeedRaw - 0.18) / 3.4);
  const centerSpeed = clamp((peakCenterSpeedRaw - 0.08) / 2.35);
  const flight = clamp((peakBounceRaw - 0.08) / 1.65);
  const kneeLoad = clamp((peakKneeRaw - 8) / 62);
  const stance = clamp((peakStanceRaw - 0.28) / 0.95);
  const stanceExpansion = clamp((peakStanceRaw - openingStance - 0.04) / 0.52);
  const landing = clamp(landingRaw / 100);
  const balance = clamp(balanceRaw / 100);
  const rotation = clamp(rotationRaw / 58);
  const travel = clamp((travelData.peak - 0.08) / 1.35);

  const values = {
    kneeLoad,
    stance,
    stanceExpansion,
    footSpeed,
    centerSpeed,
    travel,
    alternation,
    crossing: crossingData.crossing,
    switchScore: crossingData.switchScore,
    flight,
    landing,
    balance,
    rotation,
    recoveryReturn: travelData.returnRatio,
  };
  const technique = mode === "footwork_auto" ? inferFootwork(values) : mode;
  const start = scorePhase("start", visibility * 0.3 + kneeLoad * 0.22
    + stanceExpansion * 0.2 + footSpeed * 0.14 + balance * 0.14);
  const approach = scorePhase("approach", footSpeed * 0.28 + centerSpeed * 0.23
    + travel * 0.2 + alternation * 0.14 + balance * 0.15);
  const hitBalance = scorePhase("hit_balance", skillScore(technique, values));
  const recovery = scorePhase("recovery", travelData.returnRatio * 0.35 + balance * 0.27
    + landing * 0.2 + clamp(1 - mean(closing.map((sample) => sample.centerSpeed ?? 0)) / 1.25) * 0.18);
  const phases = [start, approach, hitBalance, recovery];
  const postureScore = Math.round(hitBalance.score * 0.52 + start.score * 0.23 + recovery.score * 0.25);
  const rhythmScore = Math.round(clamp(footSpeed * 0.32 + centerSpeed * 0.2
    + alternation * 0.18 + clamp(1 - Math.abs(durationMs - 760) / 1_250) * 0.3) * 100);
  const captureQuality = Math.round(clamp(visibility * 0.76
    + clamp(samples.length / 15) * 0.12 + landing * 0.12) * 100);
  const overallScore = Math.round(postureScore * 0.42 + rhythmScore * 0.25
    + recovery.score * 0.23 + approach.score * 0.1);
  const evidence = Math.min(82, Math.round(captureQuality * 0.58
    + clamp(samples.length / 16) * 22 + clamp(Math.max(footSpeed, centerSpeed)) * 20));

  return localizeFootworkAssessment({
    module: "footwork",
    technique,
    label: "",
    evidence,
    overallScore,
    postureScore,
    rhythmScore,
    recoveryScore: recovery.score,
    captureQuality,
    intensity: Math.round(clamp(footSpeed * 0.42 + centerSpeed * 0.3 + flight * 0.28) * 100),
    dominantSide,
    durationMs,
    phases,
    metrics: {
      elbowAngle: 0,
      shoulderAngle: 0,
      kneeFlexion: Math.round(peakKneeRaw),
      trunkRotation: Math.round(rotationRaw),
      contactHeight: 0,
      bodyExtension: 0,
      wristSpeed: 0,
      armAngularSpeed: 0,
      balance: Math.round(balanceRaw),
      footSpeed: Number(peakFootSpeedRaw.toFixed(2)),
      centerSpeed: Number(peakCenterSpeedRaw.toFixed(2)),
      stanceWidth: Number(peakStanceRaw.toFixed(2)),
      landingSymmetry: Math.round(landingRaw),
      travel: Number(travelData.peak.toFixed(2)),
      verticalBounce: Number(peakBounceRaw.toFixed(2)),
      alternation: Math.round(alternation * 100),
    },
    strengths: [],
    corrections: [],
    summary: "",
  }, language);
}
