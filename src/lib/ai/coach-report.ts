// Deterministic Coach report: written from the coach-dataset/v1 document of one analysis, with no language model.
// Every line copies a value the backend measured and names where it comes from: one contact (its frame and video
// timestamp) or the whole analysed range (first and last frame). A value that does not exist is written as
// "Unavailable" or "Not evaluated", never filled in. Shot labels are trajectory estimates and are always marked
// unverified. Speeds stay in image pixels per second; nothing is converted to km/h or m/s.
import type { StudioLanguage } from "../studio-types";

export const SIX_CLASSES = ["smash", "clear", "drop", "drive", "net_shot", "lift"] as const;
type SixClass = (typeof SIX_CLASSES)[number];

type SpeedStats = { basis?: string; count?: number; max?: number | null; median?: number | null };
type SpeedSummary = { basis?: string; count?: number; max_px_per_s?: number | null; mean_px_per_s?: number | null };

type DatasetPlayer = {
  contacts?: number;
  confirmed_contacts?: number;
  shot_estimates?: Partial<Record<SixClass, number>>;
  manual_labels?: Record<string, number>;
  image_speed_official_px_s?: SpeedStats;
  image_speed_candidates_px_s?: SpeedStats;
  movement?: {
    court_distance_m?: number | null;
    image_path_px?: number | null;
    court_zone_share?: { front_court: number | null; mid_court: number | null; back_court: number | null } | null;
    tracking_coverage?: number | null;
  };
};

export type DatasetShot = {
  shot_id?: string;
  time_s: number;
  frame: number;
  player: string | null;
  contact_status: string;
  estimate_label: string;
  manual_label: string | null;
  image_speed_px_s: number | null;
  estimated_3d_status?: string | null;
  evidence_quality?: string;
  review_status?: string;
};

/** The parts of coach-dataset/v1 the report reads. Unknown fields are ignored. */
export type CoachDatasetDoc = {
  schema: string;
  job_id: string;
  rule_version?: string;
  speed_summary?: {
    unit?: string;
    official?: SpeedSummary | null;
    candidates?: SpeedSummary | null;
    estimated_3d?: { available?: number; rejected?: number; rejection_reasons?: Record<string, number> } | null;
    measured_3d?: { status?: string } | null;
  };
  source?: { name?: string | null; fps?: number | null; frames?: number | null; duration_s?: number | null;
    court_status?: string | null; court_template?: string | null };
  players?: Record<string, DatasetPlayer>;
  movement_comparison?: { metric?: string; values?: Record<string, number | null>; more_movement?: string | null;
    difference_percent?: number | null; compared?: [string, string] };
  shots?: DatasetShot[];
  shot_counts?: { rows?: number; accepted_by_gate?: number; needs_review?: number; person_labelled?: number };
};

export function isCoachDataset(value: unknown): value is CoachDatasetDoc {
  if (!value || typeof value !== "object") return false;
  const doc = value as { schema?: unknown; job_id?: unknown };
  return doc.schema === "smashlab.coach-dataset/v1" && typeof doc.job_id === "string";
}

export type ReportEvidence =
  | { kind: "frame"; frame: number; timeS: number }
  | { kind: "range"; firstFrame: number; lastFrame: number; startS: number; endS: number };

export type ReportTone = "fact" | "estimate" | "unavailable" | "note";

export type ReportLine = { text: string; tone: ReportTone; evidence: ReportEvidence | null };

export type ReportSectionId = "overview" | "movement" | "shots" | "speed" | "timeline" | "not_evaluated";

export type ReportSection = { id: ReportSectionId; title: string; lines: ReportLine[] };

export type CoachReport = {
  jobId: string;
  title: string;
  subtitle: string;
  sections: ReportSection[];
  markdown: string;
};

/** Optional facts from the studio's analysis snapshot, used only when the dataset lacks them. */
export type ReportContext = { sourceName?: string; framesAnalysed?: number | null; durationS?: number | null; fps?: number | null };

type Copy = {
  title: string;
  subtitle: (rule: string) => string;
  sections: Record<ReportSectionId, string>;
  unavailable: string;
  notEvaluated: string;
  clip: (name: string, duration: string, fps: string, frames: string) => string;
  courtCalibrated: (template: string) => string;
  courtNotCalibrated: string;
  contacts: (rows: number, confirmed: number, review: number, gate: number, people: number) => string;
  distanceM: (player: string, value: string) => string;
  distancePx: (player: string, value: string) => string;
  coverage: (player: string, value: string) => string;
  zones: (player: string, front: string, mid: string, back: string) => string;
  zonesUnavailable: string;
  comparison: (more: string, other: string, percent: string, unit: string) => string;
  comparisonEqual: string;
  movementNote: string;
  playerShots: (player: string, contacts: number, confirmed: number) => string;
  mostFrequent: (player: string, label: string, count: number, of: number) => string;
  estimateSpread: (player: string, spread: string) => string;
  personLabels: (player: string, spread: string) => string;
  noContacts: (player: string) => string;
  officialSpeed: (count: number, max: string, mean: string) => string;
  officialUnavailable: string;
  candidateSpeed: (count: number, max: string, mean: string) => string;
  fastestCandidate: (value: string, player: string, label: string) => string;
  playerCandidate: (player: string, max: string, median: string) => string;
  estimated3d: (available: number, rejected: number, reasons: string) => string;
  measured3d: string;
  pixelNote: string;
  timelineRow: (time: string, frame: number, player: string, label: string, speed: string, status: string) => string;
  timelineEmpty: string;
  statuses: Record<string, string>;
  notEvaluatedItems: string[];
  classes: Record<SixClass, string>;
  reasons: Record<string, string>;
  pixelUnit: string;
  metreUnit: string;
  unverified: string;
  evidenceFrame: (frame: number, time: string) => string;
  evidenceRange: (first: number, last: number, start: string, end: string) => string;
};

const COPY: Record<StudioLanguage, Copy> = {
  en: {
    title: "Data report",
    subtitle: (rule) => `Written from this analysis only, without a language model. Shot labels: ${rule}, unverified.`,
    sections: { overview: "Overview", movement: "Movement", shots: "Shots (trajectory estimates)", speed: "Image-space speed",
      timeline: "Contact timeline", not_evaluated: "Not evaluated" },
    unavailable: "Unavailable",
    notEvaluated: "Not evaluated",
    clip: (name, duration, fps, frames) => `${name}: ${duration} s at ${fps} fps, ${frames} frames analysed.`,
    courtCalibrated: (template) => `Court calibrated (${template}). Distances are floor-plane metres, flat-floor approximation.`,
    courtNotCalibrated: "Court not calibrated. Distances are image pixels; court zones are unavailable.",
    contacts: (rows, confirmed, review, gate, people) =>
      `${rows} contacts: ${confirmed} confirmed by a person, ${review} need review, ${gate} accepted by the evidence gate, ${people} labelled by a person.`,
    distanceM: (player, value) => `${player} moved ${value} m on the floor.`,
    distancePx: (player, value) => `${player} moved ${value} px in the image.`,
    coverage: (player, value) => `${player} was tracked in ${value}% of the frames.`,
    zones: (player, front, mid, back) => `${player} court zones: front ${front}%, mid ${mid}%, back ${back}%.`,
    zonesUnavailable: "Court zones: unavailable without a calibrated court.",
    comparison: (more, other, percent, unit) => `${more} moved ${percent}% more than ${other} (${unit}).`,
    comparisonEqual: "Neither player moved more than the other in this measure.",
    movementNote: "Movement is a measured quantity. It says nothing about shot quality.",
    playerShots: (player, contacts, confirmed) => `${player}: ${contacts} contacts, ${confirmed} confirmed by a person.`,
    mostFrequent: (player, label, count, of) => `${player} most frequent estimate: ${label} (${count} of ${of}), unverified.`,
    estimateSpread: (player, spread) => `${player} estimates: ${spread}.`,
    personLabels: (player, spread) => `${player} labels from a person: ${spread}.`,
    noContacts: (player) => `${player}: no contacts in this analysis.`,
    officialSpeed: (count, max, mean) => `Official (confirmed contacts only): ${count} values, max ${max} px/s, mean ${mean} px/s.`,
    officialUnavailable: "Official speed: unavailable. No contact is confirmed by a person yet.",
    candidateSpeed: (count, max, mean) => `Automatic candidates (not official): ${count} values, max ${max} px/s, mean ${mean} px/s.`,
    fastestCandidate: (value, player, label) => `Highest candidate value: ${value} px/s, ${player}, estimate ${label} (unverified).`,
    playerCandidate: (player, max, median) => `${player} candidates: max ${max} px/s, median ${median} px/s.`,
    estimated3d: (available, rejected, reasons) => `Estimated 3D (one camera, experimental): ${available} available, ${rejected} rejected${reasons}.`,
    measured3d: "Measured 3D: not run. It needs two synchronised, calibrated cameras.",
    pixelNote: "px/s are image-space values. They are not physical speeds and are never converted to km/h.",
    timelineRow: (time, frame, player, label, speed, status) => `${time} s · frame ${frame} · ${player} · ${label} · ${speed} · ${status}`,
    timelineEmpty: "No contacts in this analysis.",
    statuses: { candidate: "candidate", confirmed: "confirmed", rejected: "rejected", needs_review: "needs review",
      accepted_by_gate: "accepted by the gate" },
    notEvaluatedItems: [
      "Accuracy of the shot labels and contacts: no ground truth for this clip.",
      "Rally winners and scores.",
      "Technique or form scores.",
      "Racket contact and shuttle speed in km/h.",
    ],
    classes: { smash: "smash", clear: "clear", drop: "drop", drive: "drive", net_shot: "net shot", lift: "lift" },
    reasons: {
      contact_not_confirmed: "contact not confirmed",
      insufficient_3d_camera_calibration: "no independent 3D camera calibration",
      interpolation_dominates: "mostly filled-in points",
      too_few_reliable_observations: "too few reliable points",
      tracking_gaps_dominate: "too many tracking gaps",
    },
    pixelUnit: "image pixels",
    metreUnit: "floor metres",
    unverified: "unverified",
    evidenceFrame: (frame, time) => `frame ${frame} · ${time} s`,
    evidenceRange: (first, last, start, end) => `frames ${first}–${last} · ${start}–${end} s`,
  },
  vi: {
    title: "Báo cáo từ dữ liệu",
    subtitle: (rule) => `Chỉ viết từ phân tích này, không dùng mô hình ngôn ngữ. Nhãn cú đánh: ${rule}, chưa kiểm chứng.`,
    sections: { overview: "Tổng quan", movement: "Di chuyển", shots: "Cú đánh (ước lượng quỹ đạo)", speed: "Tốc độ trong ảnh",
      timeline: "Dòng thời gian tiếp xúc", not_evaluated: "Chưa đánh giá" },
    unavailable: "Không có",
    notEvaluated: "Chưa đánh giá",
    clip: (name, duration, fps, frames) => `${name}: ${duration} s, ${fps} fps, đã phân tích ${frames} khung hình.`,
    courtCalibrated: (template) => `Sân đã hiệu chỉnh (${template}). Quãng đường tính bằng mét trên mặt sân, xấp xỉ sàn phẳng.`,
    courtNotCalibrated: "Sân chưa hiệu chỉnh. Quãng đường tính bằng pixel trong ảnh; không có vùng sân.",
    contacts: (rows, confirmed, review, gate, people) =>
      `${rows} lần tiếp xúc: ${confirmed} do người xác nhận, ${review} cần xem lại, ${gate} qua cổng bằng chứng, ${people} do người gán nhãn.`,
    distanceM: (player, value) => `${player} di chuyển ${value} m trên mặt sân.`,
    distancePx: (player, value) => `${player} di chuyển ${value} px trong ảnh.`,
    coverage: (player, value) => `${player} được theo dõi trong ${value}% số khung hình.`,
    zones: (player, front, mid, back) => `Vùng sân của ${player}: trước ${front}%, giữa ${mid}%, cuối ${back}%.`,
    zonesUnavailable: "Vùng sân: không có khi sân chưa hiệu chỉnh.",
    comparison: (more, other, percent, unit) => `${more} di chuyển nhiều hơn ${other} ${percent}% (${unit}).`,
    comparisonEqual: "Không người nào di chuyển nhiều hơn theo số đo này.",
    movementNote: "Di chuyển là đại lượng đo được. Nó không nói gì về chất lượng cú đánh.",
    playerShots: (player, contacts, confirmed) => `${player}: ${contacts} lần tiếp xúc, ${confirmed} do người xác nhận.`,
    mostFrequent: (player, label, count, of) => `Ước lượng thường gặp nhất của ${player}: ${label} (${count}/${of}), chưa kiểm chứng.`,
    estimateSpread: (player, spread) => `Ước lượng của ${player}: ${spread}.`,
    personLabels: (player, spread) => `Nhãn do người gán cho ${player}: ${spread}.`,
    noContacts: (player) => `${player}: không có lần tiếp xúc nào trong phân tích này.`,
    officialSpeed: (count, max, mean) => `Chính thức (chỉ tiếp xúc đã xác nhận): ${count} giá trị, cao nhất ${max} px/s, trung bình ${mean} px/s.`,
    officialUnavailable: "Tốc độ chính thức: không có. Chưa có lần tiếp xúc nào được người xác nhận.",
    candidateSpeed: (count, max, mean) => `Ứng viên tự động (không chính thức): ${count} giá trị, cao nhất ${max} px/s, trung bình ${mean} px/s.`,
    fastestCandidate: (value, player, label) => `Giá trị ứng viên cao nhất: ${value} px/s, ${player}, ước lượng ${label} (chưa kiểm chứng).`,
    playerCandidate: (player, max, median) => `Ứng viên của ${player}: cao nhất ${max} px/s, trung vị ${median} px/s.`,
    estimated3d: (available, rejected, reasons) => `3D ước lượng (một camera, thử nghiệm): ${available} có kết quả, ${rejected} bị loại${reasons}.`,
    measured3d: "3D đo được: chưa chạy. Cần hai camera đồng bộ và đã hiệu chỉnh.",
    pixelNote: "px/s là giá trị trong ảnh. Đây không phải tốc độ vật lý và không bao giờ được đổi sang km/h.",
    timelineRow: (time, frame, player, label, speed, status) => `${time} s · khung ${frame} · ${player} · ${label} · ${speed} · ${status}`,
    timelineEmpty: "Không có lần tiếp xúc nào trong phân tích này.",
    statuses: { candidate: "ứng viên", confirmed: "đã xác nhận", rejected: "đã loại", needs_review: "cần xem lại",
      accepted_by_gate: "qua cổng bằng chứng" },
    notEvaluatedItems: [
      "Độ chính xác của nhãn cú đánh và điểm tiếp xúc: clip này không có dữ liệu chuẩn (ground truth).",
      "Người thắng pha cầu và điểm số.",
      "Điểm kỹ thuật hay tư thế.",
      "Điểm chạm vợt và tốc độ cầu theo km/h.",
    ],
    classes: { smash: "đập cầu (smash)", clear: "phông cầu (clear)", drop: "thả cầu (drop)", drive: "cầu đẩy (drive)",
      net_shot: "cầu lưới (net shot)", lift: "cầu nâng (lift)" },
    reasons: {
      contact_not_confirmed: "tiếp xúc chưa được xác nhận",
      insufficient_3d_camera_calibration: "chưa có hiệu chỉnh camera 3D độc lập",
      interpolation_dominates: "phần lớn là điểm nội suy",
      too_few_reliable_observations: "quá ít điểm tin cậy",
      tracking_gaps_dominate: "quá nhiều khoảng mất dấu",
    },
    pixelUnit: "pixel trong ảnh",
    metreUnit: "mét trên mặt sân",
    unverified: "chưa kiểm chứng",
    evidenceFrame: (frame, time) => `khung ${frame} · ${time} s`,
    evidenceRange: (first, last, start, end) => `khung ${first}–${last} · ${start}–${end} s`,
  },
  de: {
    title: "Datenbericht",
    subtitle: (rule) => `Nur aus dieser Analyse geschrieben, ohne Sprachmodell. Schlagarten: ${rule}, unverifiziert.`,
    sections: { overview: "Überblick", movement: "Bewegung", shots: "Schläge (Flugbahn-Schätzungen)", speed: "Bildraum-Geschwindigkeit",
      timeline: "Kontakt-Zeitleiste", not_evaluated: "Nicht bewertet" },
    unavailable: "Nicht verfügbar",
    notEvaluated: "Nicht bewertet",
    clip: (name, duration, fps, frames) => `${name}: ${duration} s bei ${fps} fps, ${frames} Frames analysiert.`,
    courtCalibrated: (template) => `Feld kalibriert (${template}). Distanzen sind Meter auf der Bodenebene, Näherung ebener Boden.`,
    courtNotCalibrated: "Feld nicht kalibriert. Distanzen sind Bildpixel; Feldzonen sind nicht verfügbar.",
    contacts: (rows, confirmed, review, gate, people) =>
      `${rows} Kontakte: ${confirmed} von einer Person bestätigt, ${review} zu prüfen, ${gate} vom Evidenz-Filter angenommen, ${people} von einer Person benannt.`,
    distanceM: (player, value) => `${player} legte ${value} m auf dem Boden zurück.`,
    distancePx: (player, value) => `${player} legte ${value} px im Bild zurück.`,
    coverage: (player, value) => `${player} wurde in ${value}% der Frames verfolgt.`,
    zones: (player, front, mid, back) => `Feldzonen von ${player}: vorne ${front}%, Mitte ${mid}%, hinten ${back}%.`,
    zonesUnavailable: "Feldzonen: ohne kalibriertes Feld nicht verfügbar.",
    comparison: (more, other, percent, unit) => `${more} bewegte sich ${percent}% mehr als ${other} (${unit}).`,
    comparisonEqual: "In diesem Maß bewegte sich keiner mehr als der andere.",
    movementNote: "Bewegung ist eine gemessene Größe. Sie sagt nichts über die Schlagqualität.",
    playerShots: (player, contacts, confirmed) => `${player}: ${contacts} Kontakte, ${confirmed} von einer Person bestätigt.`,
    mostFrequent: (player, label, count, of) => `Häufigste Schätzung von ${player}: ${label} (${count} von ${of}), unverifiziert.`,
    estimateSpread: (player, spread) => `Schätzungen von ${player}: ${spread}.`,
    personLabels: (player, spread) => `Bezeichnungen einer Person für ${player}: ${spread}.`,
    noContacts: (player) => `${player}: keine Kontakte in dieser Analyse.`,
    officialSpeed: (count, max, mean) => `Offiziell (nur bestätigte Kontakte): ${count} Werte, max. ${max} px/s, Mittel ${mean} px/s.`,
    officialUnavailable: "Offizielle Geschwindigkeit: nicht verfügbar. Noch kein Kontakt ist von einer Person bestätigt.",
    candidateSpeed: (count, max, mean) => `Automatische Kandidaten (nicht offiziell): ${count} Werte, max. ${max} px/s, Mittel ${mean} px/s.`,
    fastestCandidate: (value, player, label) => `Höchster Kandidatenwert: ${value} px/s, ${player}, Schätzung ${label} (unverifiziert).`,
    playerCandidate: (player, max, median) => `Kandidaten von ${player}: max. ${max} px/s, Median ${median} px/s.`,
    estimated3d: (available, rejected, reasons) => `Geschätztes 3D (eine Kamera, experimentell): ${available} verfügbar, ${rejected} abgelehnt${reasons}.`,
    measured3d: "Gemessenes 3D: nicht ausgeführt. Es braucht zwei synchronisierte, kalibrierte Kameras.",
    pixelNote: "px/s sind Bildraumwerte. Sie sind keine physikalischen Geschwindigkeiten und werden nie in km/h umgerechnet.",
    timelineRow: (time, frame, player, label, speed, status) => `${time} s · Frame ${frame} · ${player} · ${label} · ${speed} · ${status}`,
    timelineEmpty: "Keine Kontakte in dieser Analyse.",
    statuses: { candidate: "Kandidat", confirmed: "bestätigt", rejected: "abgelehnt", needs_review: "zu prüfen",
      accepted_by_gate: "vom Filter angenommen" },
    notEvaluatedItems: [
      "Genauigkeit der Schlagarten und Kontakte: keine Ground Truth für diesen Clip.",
      "Ballwechsel-Gewinner und Punktestand.",
      "Technik- oder Haltungsbewertungen.",
      "Schlägerkontakt und Ballgeschwindigkeit in km/h.",
    ],
    classes: { smash: "Smash", clear: "Clear", drop: "Drop", drive: "Drive", net_shot: "Netzschlag", lift: "Lift" },
    reasons: {
      contact_not_confirmed: "Kontakt nicht bestätigt",
      insufficient_3d_camera_calibration: "keine unabhängige 3D-Kamerakalibrierung",
      interpolation_dominates: "überwiegend aufgefüllte Punkte",
      too_few_reliable_observations: "zu wenige verlässliche Punkte",
      tracking_gaps_dominate: "zu viele Tracking-Lücken",
    },
    pixelUnit: "Bildpixel",
    metreUnit: "Bodenmeter",
    unverified: "unverifiziert",
    evidenceFrame: (frame, time) => `Frame ${frame} · ${time} s`,
    evidenceRange: (first, last, start, end) => `Frames ${first}–${last} · ${start}–${end} s`,
  },
};

/** Numbers are written as the backend stored them (no locale grouping), so every value can be found in the data. */
export function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
}

function percent(share: number): string {
  return (Math.round(share * 1000) / 10).toFixed(1);
}

function seconds(value: number): string {
  return value.toFixed(2);
}

function classLabel(copy: Copy, label: string | null | undefined): string {
  return label && (SIX_CLASSES as readonly string[]).includes(label) ? copy.classes[label as SixClass] : copy.unavailable;
}

function shotEvidence(shot: DatasetShot): ReportEvidence {
  return { kind: "frame", frame: shot.frame, timeS: shot.time_s };
}

export function evidenceLabel(evidence: ReportEvidence, language: StudioLanguage): string {
  const copy = COPY[language];
  return evidence.kind === "frame"
    ? copy.evidenceFrame(evidence.frame, seconds(evidence.timeS))
    : copy.evidenceRange(evidence.firstFrame, evidence.lastFrame, seconds(evidence.startS), seconds(evidence.endS));
}

function analysedRange(dataset: CoachDatasetDoc, context: ReportContext): ReportEvidence | null {
  const frames = dataset.source?.frames ?? context.framesAnalysed ?? null;
  const fps = dataset.source?.fps ?? context.fps ?? null;
  if (!frames || frames <= 0) return null;
  const duration = dataset.source?.duration_s ?? context.durationS ?? (fps ? frames / fps : null);
  if (duration === null || duration === undefined) return null;
  const lastFrame = frames - 1;
  return { kind: "range", firstFrame: 0, lastFrame, startS: 0, endS: fps ? lastFrame / fps : duration };
}

function line(text: string, tone: ReportTone, evidence: ReportEvidence | null = null): ReportLine {
  return { text, tone, evidence };
}

/** The report of one analysis, or null when there is no coach dataset to write it from. */
export function buildCoachReport(dataset: CoachDatasetDoc | null, language: StudioLanguage, context: ReportContext = {}): CoachReport | null {
  if (!dataset || !isCoachDataset(dataset)) return null;
  const copy = COPY[language];
  const range = analysedRange(dataset, context);
  const shots = [...(dataset.shots ?? [])].sort((a, b) => a.time_s - b.time_s || a.frame - b.frame);
  const players = Object.keys(dataset.players ?? {}).sort();
  const calibrated = dataset.source?.court_status === "calibrated";
  const counts = dataset.shot_counts ?? {};
  const confirmedTotal = players.reduce((sum, player) => sum + (dataset.players?.[player]?.confirmed_contacts ?? 0), 0);

  const overview: ReportLine[] = [];
  const frames = dataset.source?.frames ?? context.framesAnalysed ?? null;
  const duration = dataset.source?.duration_s ?? context.durationS ?? null;
  const fps = dataset.source?.fps ?? context.fps ?? null;
  overview.push(line(copy.clip(
    dataset.source?.name || context.sourceName || dataset.job_id.slice(0, 8),
    duration === null ? copy.unavailable : formatNumber(duration),
    fps === null ? copy.unavailable : formatNumber(fps),
    frames === null ? copy.unavailable : formatNumber(frames),
  ), "fact", range));
  // The court is calibrated on the median background of frames sampled across the whole clip.
  overview.push(line(calibrated ? copy.courtCalibrated(dataset.source?.court_template || "") : copy.courtNotCalibrated,
    calibrated ? "fact" : "unavailable", calibrated ? range : null));
  overview.push(line(copy.contacts(counts.rows ?? shots.length, confirmedTotal, counts.needs_review ?? 0,
    counts.accepted_by_gate ?? 0, counts.person_labelled ?? 0), "fact", range));

  const movement: ReportLine[] = [];
  for (const player of players) {
    const block = dataset.players?.[player]?.movement ?? {};
    if (calibrated && typeof block.court_distance_m === "number") {
      movement.push(line(copy.distanceM(player, formatNumber(block.court_distance_m)), "fact", range));
    } else if (typeof block.image_path_px === "number") {
      movement.push(line(copy.distancePx(player, formatNumber(block.image_path_px)), "fact", range));
    } else {
      movement.push(line(`${player}: ${copy.unavailable}`, "unavailable"));
    }
    if (typeof block.tracking_coverage === "number") {
      movement.push(line(copy.coverage(player, percent(block.tracking_coverage)), "fact", range));
    }
    const zones = block.court_zone_share;
    if (calibrated && zones && zones.front_court !== null && zones.mid_court !== null && zones.back_court !== null) {
      movement.push(line(copy.zones(player, percent(zones.front_court), percent(zones.mid_court), percent(zones.back_court)), "fact", range));
    }
  }
  if (!calibrated) movement.push(line(copy.zonesUnavailable, "unavailable"));
  const comparison = dataset.movement_comparison;
  if (comparison?.more_movement && typeof comparison.difference_percent === "number") {
    // Singles compares P1 with P2; doubles compares the identity that moved most with the one that moved least.
    const other = comparison.compared?.[1] ?? players.find((player) => player !== comparison.more_movement) ?? "";
    const unit = comparison.metric === "court_distance_m" ? copy.metreUnit : copy.pixelUnit;
    movement.push(line(copy.comparison(comparison.more_movement, other, formatNumber(comparison.difference_percent), unit), "fact", range));
  } else if (comparison) {
    movement.push(line(copy.comparisonEqual, "note"));
  }
  movement.push(line(copy.movementNote, "note"));

  const shotLines: ReportLine[] = [];
  for (const player of players) {
    const block = dataset.players?.[player] ?? {};
    const own = shots.filter((shot) => shot.player === player);
    if (!block.contacts) {
      shotLines.push(line(copy.noContacts(player), "unavailable"));
      continue;
    }
    shotLines.push(line(copy.playerShots(player, block.contacts, block.confirmed_contacts ?? 0), "fact", range));
    const estimates = SIX_CLASSES.map((cls) => [cls, block.shot_estimates?.[cls] ?? 0] as const).filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1] || SIX_CLASSES.indexOf(a[0]) - SIX_CLASSES.indexOf(b[0]));
    if (estimates.length) {
      const [top, topCount] = estimates[0];
      const example = own.find((shot) => shot.estimate_label === top);
      shotLines.push(line(copy.mostFrequent(player, copy.classes[top], topCount, block.contacts), "estimate",
        example ? shotEvidence(example) : range));
      shotLines.push(line(copy.estimateSpread(player, estimates.map(([cls, n]) => `${copy.classes[cls]} ${n}`).join(", ")), "estimate", range));
    }
    const manual = Object.entries(block.manual_labels ?? {}).filter(([, n]) => n > 0);
    if (manual.length) {
      shotLines.push(line(copy.personLabels(player, manual.map(([cls, n]) => `${classLabel(copy, cls)} ${n}`).join(", ")), "fact", range));
    }
  }

  const speed: ReportLine[] = [];
  const official = dataset.speed_summary?.official;
  if (official && (official.count ?? 0) > 0 && typeof official.max_px_per_s === "number") {
    const fastest = shots.find((shot) => shot.contact_status === "confirmed" && shot.image_speed_px_s === official.max_px_per_s);
    speed.push(line(copy.officialSpeed(official.count ?? 0, formatNumber(official.max_px_per_s),
      typeof official.mean_px_per_s === "number" ? formatNumber(official.mean_px_per_s) : copy.unavailable),
    "fact", fastest ? shotEvidence(fastest) : range));
  } else {
    speed.push(line(copy.officialUnavailable, "unavailable"));
  }
  const candidates = dataset.speed_summary?.candidates;
  if (candidates && (candidates.count ?? 0) > 0 && typeof candidates.max_px_per_s === "number") {
    speed.push(line(copy.candidateSpeed(candidates.count ?? 0, formatNumber(candidates.max_px_per_s),
      typeof candidates.mean_px_per_s === "number" ? formatNumber(candidates.mean_px_per_s) : copy.unavailable), "estimate", range));
    const fastest = shots.find((shot) => shot.contact_status !== "confirmed" && shot.image_speed_px_s === candidates.max_px_per_s);
    if (fastest) {
      speed.push(line(copy.fastestCandidate(formatNumber(candidates.max_px_per_s), fastest.player ?? "?", classLabel(copy, fastest.estimate_label)),
        "estimate", shotEvidence(fastest)));
    }
  }
  for (const player of players) {
    const stats = dataset.players?.[player]?.image_speed_candidates_px_s;
    if (stats && (stats.count ?? 0) > 0 && typeof stats.max === "number" && typeof stats.median === "number") {
      speed.push(line(copy.playerCandidate(player, formatNumber(stats.max), formatNumber(stats.median)), "estimate", range));
    }
  }
  const estimated = dataset.speed_summary?.estimated_3d;
  if (estimated) {
    const reasons = Object.entries(estimated.rejection_reasons ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([code, n]) => `${copy.reasons[code] ?? code.replaceAll("_", " ")} ${n}`);
    speed.push(line(copy.estimated3d(estimated.available ?? 0, estimated.rejected ?? 0, reasons.length ? ` (${reasons.join(", ")})` : ""),
      (estimated.available ?? 0) > 0 ? "estimate" : "unavailable"));
  }
  speed.push(line(copy.measured3d, "unavailable"));
  speed.push(line(copy.pixelNote, "note"));

  const timeline: ReportLine[] = shots.length
    ? shots.map((shot) => line(copy.timelineRow(
      seconds(shot.time_s),
      shot.frame,
      shot.player ?? "?",
      shot.manual_label && (SIX_CLASSES as readonly string[]).includes(shot.manual_label)
        ? classLabel(copy, shot.manual_label)
        : `${classLabel(copy, shot.estimate_label)} (${copy.unverified})`,
      typeof shot.image_speed_px_s === "number" ? `${formatNumber(shot.image_speed_px_s)} px/s` : copy.unavailable,
      copy.statuses[shot.contact_status] ?? shot.contact_status,
    ), shot.contact_status === "confirmed" ? "fact" : "estimate", shotEvidence(shot)))
    : [line(copy.timelineEmpty, "unavailable")];

  const notEvaluated = copy.notEvaluatedItems.map((text) => line(text, "unavailable"));

  const sections: ReportSection[] = [
    { id: "overview", title: copy.sections.overview, lines: overview },
    { id: "movement", title: copy.sections.movement, lines: movement },
    { id: "shots", title: copy.sections.shots, lines: shotLines },
    { id: "speed", title: copy.sections.speed, lines: speed },
    { id: "timeline", title: copy.sections.timeline, lines: timeline },
    { id: "not_evaluated", title: copy.sections.not_evaluated, lines: notEvaluated },
  ];
  const subtitle = copy.subtitle(dataset.rule_version ?? "trajectory-rules");
  return { jobId: dataset.job_id, title: copy.title, subtitle, sections, markdown: reportMarkdown(copy.title, subtitle, sections, language) };
}

function reportMarkdown(title: string, subtitle: string, sections: ReportSection[], language: StudioLanguage): string {
  const parts = [`# ${title}`, "", subtitle, ""];
  for (const section of sections) {
    parts.push(`## ${section.title}`, "");
    for (const item of section.lines) {
      parts.push(`- ${item.text}${item.evidence ? ` (${evidenceLabel(item.evidence, language)})` : ""}`);
    }
    parts.push("");
  }
  return parts.join("\n").trimEnd() + "\n";
}
