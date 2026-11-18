// Copy for the trajectory estimate: timeline badges, the shot drawer and the dataset export. EN, VI and DE for every string.
import type { StudioLanguage } from "@/lib/studio-types";

export type TrajectoryCopy = {
  badge: string;
  badgeShort: string;
  manual: string;
  needsReview: string;
  passedGates: string;
  notConfirmed: string;
  pxs: string;
  quality: string;
  tier: string;
  tierFull: string;
  tierPartial: string;
  tierFallback: string;
  qualityHigh: string;
  qualityMedium: string;
  qualityLow: string;
  top3: string;
  scores: string;
  speedBefore: string;
  speedAfter: string;
  change: string;
  direction: string;
  dirUp: string;
  dirDown: string;
  dirLeft: string;
  dirRight: string;
  dirLevel: string;
  curvature: string;
  apex: string;
  apexAt: string;
  flight: string;
  length: string;
  missing: string;
  noMissing: string;
  whyBest: string;
  whyReview: string;
  warnings: string;
  job: string;
  run: string;
  rule: string;
  notBuilt: string;
  miniChart: string;
  courtMap: string;
  playerFoot: string;
  sideNear: string;
  sideFar: string;
  relFront: string;
  relMid: string;
  relBack: string;
  accept: string;
  acceptNote: string;
  exportLabel: string;
  exportNote: string;
  disclaimer: string;
  seconds: string;
  unavailable: string;
  before: string;
  after: string;
  contact: string;
  noRecord: string;
  legend: string;
  trailTitle: string;
  trailNote: string;
  trailOff: string;
  build: string;
};

export const TRAJECTORY_COPY: Record<StudioLanguage, TrajectoryCopy> = {
  en: {
    badge: "Trajectory estimate · unverified",
    badgeShort: "Trajectory estimate",
    manual: "Manual",
    needsReview: "Needs review",
    passedGates: "Passed rule gates",
    notConfirmed: "Contact not confirmed",
    pxs: "px/s",
    quality: "Evidence quality",
    tier: "Evidence tier",
    tierFull: "full trajectory",
    tierPartial: "partial trajectory",
    tierFallback: "contact fallback",
    qualityHigh: "high",
    qualityMedium: "medium",
    qualityLow: "low",
    top3: "Top 3",
    scores: "Six-class rule scores (not calibrated probabilities)",
    speedBefore: "Speed before contact",
    speedAfter: "Speed after contact",
    change: "Speed change",
    direction: "Initial direction",
    dirUp: "up",
    dirDown: "down",
    dirLeft: "left",
    dirRight: "right",
    dirLevel: "level",
    curvature: "Curvature (rad per step)",
    apex: "Apex",
    apexAt: "highest point at",
    flight: "Observed flight",
    length: "Trajectory length",
    missing: "Missing features",
    noMissing: "none",
    whyBest: "Why this class ranks first",
    whyReview: "Why it needs review",
    warnings: "Quality warnings",
    job: "Job",
    run: "Dataset run",
    rule: "Rule version",
    notBuilt: "The trajectory dataset for this analysis is not built yet.",
    miniChart: "Shuttle trajectory around the contact (image pixels)",
    courtMap: "Court map at the contact",
    playerFoot: "Player foot position",
    sideNear: "near side",
    sideFar: "far side",
    relFront: "front court",
    relMid: "mid court",
    relBack: "back court",
    accept: "Accept as manual correction",
    acceptNote: "Creates a separate manual correction. The estimate is not applied automatically.",
    exportLabel: "Export shot trajectory dataset",
    exportNote: "JSON Lines: one record per Shot timeline row of this analysis.",
    disclaimer: "Automatic estimate from the shuttle trajectory and speed in image pixels. Not ground truth, not validated.",
    seconds: "s",
    unavailable: "not available",
    before: "before",
    after: "after",
    contact: "contact",
    noRecord: "No trajectory estimate for this contact.",
    legend: "Trajectory estimate colours",
    trailTitle: "Shuttle trail",
    trailNote: "TrackNet detections in image pixels. Not a flight measurement.",
    trailOff: "Trail off",
    build: "Build trajectory dataset",
  },
  vi: {
    badge: "Ước lượng từ quỹ đạo · chưa kiểm chứng",
    badgeShort: "Ước lượng từ quỹ đạo",
    manual: "Thủ công",
    needsReview: "Cần xem lại",
    passedGates: "Đạt cổng luật",
    notConfirmed: "Lần chạm chưa được xác nhận",
    pxs: "px/s",
    quality: "Chất lượng bằng chứng",
    tier: "Mức bằng chứng",
    tierFull: "quỹ đạo đầy đủ",
    tierPartial: "quỹ đạo một phần",
    tierFallback: "dự phòng quanh lần chạm",
    qualityHigh: "cao",
    qualityMedium: "trung bình",
    qualityLow: "thấp",
    top3: "Top 3",
    scores: "Điểm luật cho sáu lớp (không phải xác suất đã hiệu chỉnh)",
    speedBefore: "Tốc độ trước lần chạm",
    speedAfter: "Tốc độ sau lần chạm",
    change: "Thay đổi tốc độ",
    direction: "Hướng ban đầu",
    dirUp: "lên",
    dirDown: "xuống",
    dirLeft: "trái",
    dirRight: "phải",
    dirLevel: "ngang",
    curvature: "Độ cong (rad mỗi bước)",
    apex: "Đỉnh",
    apexAt: "điểm cao nhất lúc",
    flight: "Thời gian bay quan sát được",
    length: "Độ dài quỹ đạo",
    missing: "Đặc trưng còn thiếu",
    noMissing: "không có",
    whyBest: "Vì sao lớp này đứng đầu",
    whyReview: "Vì sao cần xem lại",
    warnings: "Cảnh báo chất lượng",
    job: "Analysis",
    run: "Lượt dữ liệu",
    rule: "Phiên bản luật",
    notBuilt: "Dữ liệu quỹ đạo của analysis này chưa được tạo.",
    miniChart: "Quỹ đạo cầu quanh lần chạm (pixel ảnh)",
    courtMap: "Bản đồ sân tại lần chạm",
    playerFoot: "Vị trí chân người chơi",
    sideNear: "phía gần",
    sideFar: "phía xa",
    relFront: "trước sân",
    relMid: "giữa sân",
    relBack: "cuối sân",
    accept: "Chấp nhận như hiệu chỉnh thủ công",
    acceptNote: "Tạo một hiệu chỉnh thủ công riêng. Ước lượng không được áp dụng tự động.",
    exportLabel: "Xuất dataset quỹ đạo cú đánh",
    exportNote: "JSON Lines: một bản ghi cho mỗi dòng của Shot timeline trong analysis này.",
    disclaimer: "Ước lượng tự động từ quỹ đạo và tốc độ cầu trên pixel ảnh. Không phải ground truth, chưa được kiểm chứng.",
    seconds: "s",
    unavailable: "không có",
    before: "trước",
    after: "sau",
    contact: "lần chạm",
    noRecord: "Không có ước lượng quỹ đạo cho lần chạm này.",
    legend: "Màu nhãn ước lượng",
    trailTitle: "Vệt cầu",
    trailNote: "Điểm TrackNet tính bằng pixel trên ảnh. Không phải phép đo đường bay.",
    trailOff: "Tắt vệt",
    build: "Tạo dataset quỹ đạo",
  },
  de: {
    badge: "Flugbahn-Schätzung · nicht verifiziert",
    badgeShort: "Flugbahn-Schätzung",
    manual: "Manuell",
    needsReview: "Prüfung nötig",
    passedGates: "Regelprüfung bestanden",
    notConfirmed: "Kontakt nicht bestätigt",
    pxs: "px/s",
    quality: "Evidenzqualität",
    tier: "Evidenzstufe",
    tierFull: "vollständige Flugbahn",
    tierPartial: "teilweise Flugbahn",
    tierFallback: "Ersatz um den Kontakt",
    qualityHigh: "hoch",
    qualityMedium: "mittel",
    qualityLow: "niedrig",
    top3: "Top 3",
    scores: "Regelwerte für sechs Klassen (keine kalibrierten Wahrscheinlichkeiten)",
    speedBefore: "Geschwindigkeit vor dem Kontakt",
    speedAfter: "Geschwindigkeit nach dem Kontakt",
    change: "Geschwindigkeitsänderung",
    direction: "Anfangsrichtung",
    dirUp: "oben",
    dirDown: "unten",
    dirLeft: "links",
    dirRight: "rechts",
    dirLevel: "waagerecht",
    curvature: "Krümmung (rad pro Schritt)",
    apex: "Scheitelpunkt",
    apexAt: "höchster Punkt bei",
    flight: "beobachtete Flugdauer",
    length: "Flugbahnlänge",
    missing: "Fehlende Merkmale",
    noMissing: "keine",
    whyBest: "Warum diese Klasse vorn liegt",
    whyReview: "Warum Prüfung nötig ist",
    warnings: "Qualitätshinweise",
    job: "Analyse",
    run: "Datenlauf",
    rule: "Regelversion",
    notBuilt: "Der Flugbahn-Datensatz dieser Analyse ist noch nicht erstellt.",
    miniChart: "Federballflugbahn um den Kontakt (Bildpixel)",
    courtMap: "Feldkarte am Kontakt",
    playerFoot: "Fußposition des Spielers",
    sideNear: "nahe Seite",
    sideFar: "ferne Seite",
    relFront: "vordere Feldhälfte",
    relMid: "Feldmitte",
    relBack: "hintere Feldhälfte",
    accept: "Als manuelle Korrektur übernehmen",
    acceptNote: "Erstellt eine eigene manuelle Korrektur. Die Schätzung wird nicht automatisch übernommen.",
    exportLabel: "Flugbahn-Datensatz exportieren",
    exportNote: "JSON Lines: ein Datensatz pro Zeile der Schlagzeitleiste dieser Analyse.",
    disclaimer: "Automatische Schätzung aus Flugbahn und Geschwindigkeit im Bildraum (Pixel). Keine Ground Truth, nicht validiert.",
    seconds: "s",
    unavailable: "nicht verfügbar",
    before: "vor",
    after: "nach",
    contact: "Kontakt",
    noRecord: "Keine Flugbahn-Schätzung für diesen Kontakt.",
    legend: "Farben der Flugbahn-Schätzung",
    trailTitle: "Federballspur",
    trailNote: "TrackNet-Erkennungen in Bildpixeln. Keine Flugmessung.",
    trailOff: "Spur aus",
    build: "Flugbahn-Datensatz erstellen",
  },
};
