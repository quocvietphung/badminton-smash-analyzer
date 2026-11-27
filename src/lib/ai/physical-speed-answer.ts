// The Coach's answer to a shuttle speed question in km/h or m/s, when the analysis has no physical speed. The model did
// not keep the two-sentence rule of analysis-instructions.ts (it wrote three sentences and quoted a candidate speed in
// px/s), so for this question the answer is written from the analysis data. It names the limit and the most frequent
// reason, and gives no speed value and no candidate. Kept free of server-only imports so the rules can be tested.
import type { StudioLanguage } from "../studio-types";

export type PhysicalSpeedFacts = {
  /** speed_summary.estimated_3d.rejection_reasons: the number of contacts each reason rejected. */
  rejectionReasons?: Record<string, number>;
  /** speed_summary.measured_3d.status: "not_run" without two synchronised cameras. */
  measuredStatus?: string;
};

// Physical units (km/h, m/s, mph, kph) in English, Vietnamese and German.
const PHYSICAL_UNIT = /km\s*\/\s*h\b|\bkmh\b|\bkph\b|\bmph\b|\bm\s*\/\s*s\b|km\/gi[ờo]|m[ée]t\/gi[âa]y|m\/gi[âa]y|pro (?:stunde|sekunde)/iu;
// The shuttle, and not a player: a question about a player's speed stays with the model.
const SHUTTLE = /(?<!\p{L})(?:shuttle|shuttlecock|federball|cầu)(?!\p{L})/iu;
const PLAYER = /(?<!\p{L})(?:P[1-4]|players?|spieler|spielerin|người chơi|vận động viên|cầu thủ)(?!\p{L})/iu;

// When several reasons tie, the calibration reason wins: it is the cause of the missing physical speed.
const REASON_PRIORITY = ["insufficient_3d_camera_calibration", "interpolation_dominates", "contact_not_confirmed"];

const REASON_CLAUSE: Record<StudioLanguage, Record<string, string>> = {
  en: {
    insufficient_3d_camera_calibration: "the 3D camera calibration is not sufficient",
    interpolation_dominates: "most shuttle frames were interpolated",
    contact_not_confirmed: "the contacts are not confirmed",
  },
  de: {
    insufficient_3d_camera_calibration: "die 3D-Kamerakalibrierung nicht ausreichend ist",
    interpolation_dominates: "der überwiegende Teil der Shuttle-Bilder interpoliert ist",
    contact_not_confirmed: "die Kontakte nicht bestätigt sind",
  },
  vi: {
    insufficient_3d_camera_calibration: "hiệu chỉnh camera 3D chưa đủ",
    interpolation_dominates: "phần lớn khung hình cầu được nội suy",
    contact_not_confirmed: "các tiếp xúc chưa được xác nhận",
  },
};

const COPY: Record<StudioLanguage, {
  rejected: (clause: string) => string;
  noEstimate: string;
  notRun: string;
  noValue: string;
}> = {
  en: {
    rejected: (clause) => `Physical trajectory unavailable: the 3D estimate was rejected because ${clause}.`,
    noEstimate: "Physical trajectory unavailable: no 3D speed estimate passed the checks.",
    notRun: "The two-camera measurement was not run, so no km/h or m/s value is given.",
    noValue: "No km/h or m/s value is given.",
  },
  de: {
    rejected: (clause) => `Physische Flugbahn nicht verfügbar: Die 3D-Schätzung wurde verworfen, weil ${clause}.`,
    noEstimate: "Physische Flugbahn nicht verfügbar: Keine 3D-Geschwindigkeitsschätzung hat die Prüfungen bestanden.",
    notRun: "Die Messung mit zwei Kameras wurde nicht durchgeführt, daher wird kein km/h- oder m/s-Wert angegeben.",
    noValue: "Es wird kein km/h- oder m/s-Wert angegeben.",
  },
  vi: {
    rejected: (clause) => `Quỹ đạo vật lý không khả dụng: ước lượng 3D bị loại vì ${clause}.`,
    noEstimate: "Quỹ đạo vật lý không khả dụng: không có ước lượng tốc độ 3D nào vượt qua kiểm tra.",
    notRun: "Phép đo bằng hai camera chưa được thực hiện, nên không đưa ra giá trị km/h hay m/s.",
    noValue: "Không đưa ra giá trị km/h hay m/s.",
  },
};

/** The most frequent rejection reason. A tie goes to the calibration reason, then to the order in REASON_PRIORITY. */
export function mostFrequentReason(reasons: Record<string, number> | undefined): string | null {
  const ranked = Object.entries(reasons ?? {}).filter(([, count]) => count > 0);
  if (!ranked.length) return null;
  const rank = (key: string) => {
    const index = REASON_PRIORITY.indexOf(key);
    return index === -1 ? REASON_PRIORITY.length : index;
  };
  ranked.sort(([a, countA], [b, countB]) => countB - countA || rank(a) - rank(b) || a.localeCompare(b));
  return ranked[0][0];
}

/** Two sentences written from the data: the limit with its most frequent reason, then whether a km/h or m/s value exists. */
export function physicalSpeedAnswer(language: StudioLanguage, facts: PhysicalSpeedFacts): string {
  const copy = COPY[language];
  const reason = mostFrequentReason(facts.rejectionReasons);
  const clause = reason ? REASON_CLAUSE[language][reason] : undefined;
  const first = clause ? copy.rejected(clause) : copy.noEstimate;
  const second = facts.measuredStatus === "not_run" ? copy.notRun : copy.noValue;
  return `${first} ${second}`;
}

function objectOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** The facts the answer needs, read from the coach dataset (coach-dataset/v1). A missing part stays undefined. */
export function physicalSpeedFacts(dataset: Record<string, unknown> | null): PhysicalSpeedFacts {
  const summary = objectOf(dataset?.speed_summary);
  const estimated = objectOf(summary.estimated_3d);
  const measured = objectOf(summary.measured_3d);
  const counts = Object.fromEntries(
    Object.entries(objectOf(estimated.rejection_reasons)).filter((entry): entry is [string, number] => typeof entry[1] === "number"),
  );
  return {
    rejectionReasons: Object.keys(counts).length ? counts : undefined,
    measuredStatus: typeof measured.status === "string" ? measured.status : undefined,
  };
}

/** Whether the question asks for the shuttle's speed in a physical unit. */
export function isShuttleSpeedQuestion(question: string): boolean {
  return PHYSICAL_UNIT.test(question) && SHUTTLE.test(question) && !PLAYER.test(question);
}

/** The app's own answer, or null when the model answers: no analysis selected, a physical speed exists, or another question. */
export function physicalSpeedReply(input: {
  question: string;
  analysisSelected: boolean;
  status: string;
  language: StudioLanguage;
  facts: PhysicalSpeedFacts;
}): string | null {
  if (!input.analysisSelected || input.status === "available") return null;
  if (!isShuttleSpeedQuestion(input.question)) return null;
  return physicalSpeedAnswer(input.language, input.facts);
}
