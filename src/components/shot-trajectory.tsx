"use client";

import { useState, type PointerEvent } from "react";
import type { StudioLanguage } from "@/lib/studio-types";
import type { Estimated3D, Measured3D, TrackingCheck, TrajectoryEstimate } from "@/lib/match/types";
import {
  SIDE_VIEW,
  TEMPLATE_ORDER,
  buildShotPath,
  checksOf,
  resolveLabels,
  sideTemplate,
  uncertaintyView,
  zoomBox,
  type PathPoint,
  type Provenance,
  type ShuttleObservation,
  type SixType,
} from "@/lib/match/shot-trajectory";
import { useSourceFrame } from "@/lib/match/source-frame";
import styles from "./shot-trajectory.module.css";

type Mode = "measured" | "side";
type Zoom = "path" | "frame";

const BEFORE = "#4aa3ff";
const AFTER = "#f2c94c";
const CONTACT = "#ff6b6b";
const REJECTED = "#8fa3bd";
const SIDE_LINE = "#6ee7c1";
const SIDE_CONTACT = "#f6d27a";
const MAX_WARNINGS_SHOWN = 3;

type Copy = {
  title: string;
  modeMeasured: string;
  modeSide: string;
  zoomPath: string;
  zoomFrame: string;
  measuredNote: string;
  sideNote: string;
  previewNote: string;
  frameToggle: string;
  on: string;
  off: string;
  legendMeasured: string;
  legendRefined: string;
  legendRejected: string;
  legendBreak: string;
  legendContact: string;
  provMeasured: string;
  provRefined: string;
  aiLabel: string;
  reviewed: string;
  noReview: string;
  unconfirmed: string;
  confirmed: string;
  uncertainChip: string;
  rankedLabel: string;
  quality: string;
  qualityValues: Record<TrajectoryEstimate["evidence_quality"], string>;
  observed: (before: number, expectedBefore: number, after: number, expectedAfter: number, refined: number, rejected: number, breaks: number) => string;
  fileCheck: (matched: number, differ: number, absent: number) => string;
  hiddenFromRecord: (count: number) => string;
  truncVideoEnd: string;
  truncTracking: string;
  imageSpeed: (value: number, basis: string) => string;
  imageSpeedNone: string;
  basisConfirmed: string;
  basisCandidate: string;
  sources: (detected: number, interpolated: number) => string;
  warnConstant: (axis: "x" | "y", value: number, from: number, to: number, length: number, range: number) => string;
  warnRepeatedDetection: (x: number, y: number, from: number, to: number) => string;
  warnRepeatedInterpolation: (x: number, y: number, from: number, to: number) => string;
  warnRepeatedMixed: (x: number, y: number, from: number, to: number) => string;
  warnJumpRemoved: (from: number, to: number, entry: number | null, back: number | null) => string;
  warnImplausible: (from: number, to: number, speed: number, limit: number) => string;
  warnMore: (count: number) => string;
  estimated3d: string;
  estimatedRejected: (reasons: string) => string;
  estimatedAvailable: (speed: number, low: number, high: number) => string;
  measured3dNotRun: string;
  empty: string;
  unknownSide: string;
  net: string;
  playerCourt: string;
  opponentCourt: string;
  contactWord: string;
  readout: (frame: number, time: string, x: string, y: string, provenance: string) => string;
  classTitles: Record<SixType, string>;
  classShort: Record<SixType, string>;
};

const SHORT: Record<SixType, string> = { smash: "Smash", clear: "Clear", drop: "Drop", drive: "Drive", net_shot: "Net", lift: "Lift" };

const COPY: Record<StudioLanguage, Copy> = {
  en: {
    title: "Shot trajectory",
    modeMeasured: "Actual 2D",
    modeSide: "Side view",
    zoomPath: "Zoom to path",
    zoomFrame: "Full frame",
    measuredNote: "Actual 2D — image positions in pixels (TrackNet detections after the observed-2D check). Not metres, not km/h.",
    sideNote: "Illustrative trajectory — not measured 3D shuttle height.",
    previewNote: "Template preview only. The label is unchanged.",
    frameToggle: "Video frame",
    on: "on",
    off: "off",
    legendMeasured: "TrackNet detection",
    legendRefined: "InpaintNet fill (not a detection)",
    legendRejected: "removed by the observed-2D check",
    legendBreak: "× = new run after a gap",
    legendContact: "contact candidate",
    provMeasured: "TrackNet detection",
    provRefined: "InpaintNet fill",
    aiLabel: "AI label",
    reviewed: "Reviewed label",
    noReview: "No person label yet",
    unconfirmed: "Contact not confirmed",
    confirmed: "Contact confirmed",
    uncertainChip: "Uncertain label",
    rankedLabel: "Rule scores (not probabilities)",
    quality: "Evidence quality",
    qualityValues: { high: "high", medium: "medium", low: "low" },
    observed: (before, expectedBefore, after, expectedAfter, refined, rejected, breaks) =>
      `before ${before}/${expectedBefore} · after ${after}/${expectedAfter} · InpaintNet ${refined} · removed ${rejected} · runs broken ${breaks}`,
    fileCheck: (matched, differ, absent) => `file check: ${matched} match · ${differ} differ · ${absent} absent`,
    hiddenFromRecord: (count) => `${count} visible shuttle frames neither kept nor removed`,
    truncVideoEnd: "after-window short: the video ended",
    truncTracking: "after-window short: the shuttle was not tracked",
    imageSpeed: (value, basis) => `Image-space speed ${value} px/s (±3 frames, valid steps only · ${basis})`,
    imageSpeedNone: "Image-space speed: unavailable (too few valid TrackNet steps)",
    basisConfirmed: "confirmed contact",
    basisCandidate: "candidate, not official",
    sources: (detected, interpolated) => `${detected} TrackNet · ${interpolated} InpaintNet`,
    warnConstant: (axis, value, from, to, length, range) =>
      `${axis} stays at ${value} for ${length} frames (${from}–${to}) while ${axis === "x" ? "y" : "x"} moves ${range} px: check the shuttle on the video`,
    warnRepeatedDetection: (x, y, from, to) => `the same TrackNet position (${x}, ${y}) in frames ${from} and ${to}: check for a repeated video frame or a stuck detection`,
    warnRepeatedInterpolation: (x, y, from, to) => `the same InpaintNet position (${x}, ${y}) in frames ${from} and ${to}: an interpolation, not a detection`,
    warnRepeatedMixed: (x, y, from, to) => `the same position (${x}, ${y}) in frames ${from} and ${to}, one TrackNet and one InpaintNet`,
    warnJumpRemoved: (from, to, entry, back) =>
      `tracker jump removed: frames ${from}–${to} left the track${entry !== null ? ` by ${entry} px` : ""}${back !== null ? ` and it resumed at frame ${back}` : ""}`,
    warnImplausible: (from, to, speed, limit) => `implausible step ${from}→${to} (${speed} px/s, limit ${limit} px/s): kept, never used as a speed`,
    warnMore: (count) => `${count} more tracking checks`,
    estimated3d: "Estimated 3D — monocular experimental",
    estimatedRejected: (reasons) => `Physical trajectory unavailable (${reasons})`,
    estimatedAvailable: (speed, low, high) => `${speed} km/h, range ${low}–${high} km/h (estimate from one camera, not a measurement)`,
    measured3dNotRun: "Measured 3D: NOT RUN — stereo input unavailable",
    empty: "Trajectory unavailable — insufficient shuttle tracking data.",
    unknownSide: "Unclassified — no template is drawn.",
    net: "Net",
    playerCourt: "Player's court",
    opponentCourt: "Opponent's court",
    contactWord: "Contact",
    readout: (frame, time, x, y, provenance) => `frame ${frame} · ${time} s · x ${x} · y ${y} · ${provenance}`,
    classTitles: { smash: "Smash", clear: "Clear", drop: "Drop", drive: "Drive", net_shot: "Net shot", lift: "Lift" },
    classShort: SHORT,
  },
  vi: {
    title: "Quỹ đạo cú đánh",
    modeMeasured: "Thực đo 2D",
    modeSide: "Side view minh họa",
    zoomPath: "Phóng quỹ đạo",
    zoomFrame: "Toàn khung hình",
    measuredNote: "Thực đo 2D — vị trí trên ảnh bằng pixel (điểm TrackNet sau bước kiểm tra observed-2D). Không phải mét hay km/h.",
    sideNote: "Quỹ đạo minh họa — không phải độ cao 3D đo được.",
    previewNote: "Chỉ xem mẫu. Nhãn không đổi.",
    frameToggle: "Khung hình video",
    on: "bật",
    off: "tắt",
    legendMeasured: "điểm TrackNet",
    legendRefined: "điểm InpaintNet bù (không phải phát hiện)",
    legendRejected: "bị bộ kiểm tra observed-2D loại",
    legendBreak: "× = đoạn mới sau khoảng trống",
    legendContact: "ứng viên chạm",
    provMeasured: "điểm TrackNet",
    provRefined: "điểm InpaintNet bù",
    aiLabel: "Nhãn AI",
    reviewed: "Nhãn đã duyệt",
    noReview: "Chưa có nhãn người",
    unconfirmed: "Chạm chưa được xác nhận",
    confirmed: "Chạm đã xác nhận",
    uncertainChip: "Nhãn không chắc chắn",
    rankedLabel: "Điểm luật (không phải xác suất)",
    quality: "Chất lượng bằng chứng",
    qualityValues: { high: "cao", medium: "trung bình", low: "thấp" },
    observed: (before, expectedBefore, after, expectedAfter, refined, rejected, breaks) =>
      `trước ${before}/${expectedBefore} · sau ${after}/${expectedAfter} · InpaintNet ${refined} · bị loại ${rejected} · đứt đoạn ${breaks}`,
    fileCheck: (matched, differ, absent) => `đối chiếu file: khớp ${matched} · lệch ${differ} · vắng ${absent}`,
    hiddenFromRecord: (count) => `${count} khung shuttle nhìn thấy nhưng không được giữ cũng không bị loại`,
    truncVideoEnd: "cửa sổ sau chạm ngắn: hết video",
    truncTracking: "cửa sổ sau chạm ngắn: shuttle không được theo dõi",
    imageSpeed: (value, basis) => `Tốc độ trên ảnh ${value} px/s (±3 khung, chỉ bước hợp lệ · ${basis})`,
    imageSpeedNone: "Tốc độ trên ảnh: không có (quá ít bước TrackNet hợp lệ)",
    basisConfirmed: "chạm đã xác nhận",
    basisCandidate: "ứng viên, không chính thức",
    sources: (detected, interpolated) => `${detected} TrackNet · ${interpolated} InpaintNet`,
    warnConstant: (axis, value, from, to, length, range) =>
      `${axis} giữ ở ${value} trong ${length} khung (${from}–${to}) khi ${axis === "x" ? "y" : "x"} đổi ${range} px: kiểm tra quả cầu trên video`,
    warnRepeatedDetection: (x, y, from, to) => `cùng vị trí TrackNet (${x}, ${y}) ở khung ${from} và ${to}: kiểm tra khung video trùng hoặc detector bị kẹt`,
    warnRepeatedInterpolation: (x, y, from, to) => `cùng vị trí InpaintNet (${x}, ${y}) ở khung ${from} và ${to}: điểm nội suy, không phải phát hiện`,
    warnRepeatedMixed: (x, y, from, to) => `cùng vị trí (${x}, ${y}) ở khung ${from} và ${to}, một TrackNet và một InpaintNet`,
    warnJumpRemoved: (from, to, entry, back) =>
      `đã loại bước nhảy tracker: khung ${from}–${to} rời quỹ đạo${entry !== null ? ` ${entry} px` : ""}${back !== null ? ` rồi quay lại ở khung ${back}` : ""}`,
    warnImplausible: (from, to, speed, limit) => `bước phi lý ${from}→${to} (${speed} px/s, giới hạn ${limit} px/s): giữ điểm, không dùng làm tốc độ`,
    warnMore: (count) => `còn ${count} cảnh báo theo dõi`,
    estimated3d: "3D ước lượng — một camera, thử nghiệm",
    estimatedRejected: (reasons) => `Không có quỹ đạo vật lý (${reasons})`,
    estimatedAvailable: (speed, low, high) => `${speed} km/h, khoảng ${low}–${high} km/h (ước lượng từ một camera, không phải phép đo)`,
    measured3dNotRun: "3D đo bằng stereo: CHƯA CHẠY — không có dữ liệu stereo",
    empty: "Không có quỹ đạo — dữ liệu theo dõi cầu chưa đủ.",
    unknownSide: "Chưa phân loại — không vẽ mẫu.",
    net: "Lưới",
    playerCourt: "Sân người đánh",
    opponentCourt: "Sân đối phương",
    contactWord: "Chạm",
    readout: (frame, time, x, y, provenance) => `khung ${frame} · ${time} s · x ${x} · y ${y} · ${provenance}`,
    classTitles: { smash: "Smash / Đập cầu", clear: "Clear / Phông cầu", drop: "Drop / Thả cầu", drive: "Drive / Cầu đẩy", net_shot: "Net / Cầu lưới", lift: "Lift / Cầu nâng" },
    classShort: SHORT,
  },
  de: {
    title: "Schlagbahn",
    modeMeasured: "Gemessen 2D",
    modeSide: "Side View (Illustration)",
    zoomPath: "Bahn vergrößern",
    zoomFrame: "Ganzes Bild",
    measuredNote: "Gemessen 2D — Bildpositionen in Pixeln (TrackNet-Erkennungen nach der Observed-2D-Prüfung). Keine Meter, keine km/h.",
    sideNote: "Illustrative Flugbahn — keine gemessene 3D-Höhe des Federballs.",
    previewNote: "Nur Vorschau der Vorlage. Das Label bleibt unverändert.",
    frameToggle: "Videobild",
    on: "an",
    off: "aus",
    legendMeasured: "TrackNet-Erkennung",
    legendRefined: "InpaintNet-Füllung (keine Erkennung)",
    legendRejected: "von der Observed-2D-Prüfung entfernt",
    legendBreak: "× = neuer Abschnitt nach einer Lücke",
    legendContact: "Schlagkandidat",
    provMeasured: "TrackNet-Erkennung",
    provRefined: "InpaintNet-Füllung",
    aiLabel: "KI-Label",
    reviewed: "Geprüftes Label",
    noReview: "Noch kein Personen-Label",
    unconfirmed: "Treffer nicht bestätigt",
    confirmed: "Treffer bestätigt",
    uncertainChip: "Unsichere Zuordnung",
    rankedLabel: "Regelwerte (keine Wahrscheinlichkeiten)",
    quality: "Qualität der Evidenz",
    qualityValues: { high: "hoch", medium: "mittel", low: "niedrig" },
    observed: (before, expectedBefore, after, expectedAfter, refined, rejected, breaks) =>
      `vor ${before}/${expectedBefore} · nach ${after}/${expectedAfter} · InpaintNet ${refined} · entfernt ${rejected} · Abschnittsbrüche ${breaks}`,
    fileCheck: (matched, differ, absent) => `Dateiabgleich: ${matched} stimmen · ${differ} weichen ab · ${absent} fehlen`,
    hiddenFromRecord: (count) => `${count} sichtbare Ballbilder weder behalten noch entfernt`,
    truncVideoEnd: "Fenster nach dem Schlag kurz: Video zu Ende",
    truncTracking: "Fenster nach dem Schlag kurz: Ball nicht verfolgt",
    imageSpeed: (value, basis) => `Bildgeschwindigkeit ${value} px/s (±3 Bilder, nur gültige Schritte · ${basis})`,
    imageSpeedNone: "Bildgeschwindigkeit: nicht verfügbar (zu wenige gültige TrackNet-Schritte)",
    basisConfirmed: "bestätigter Kontakt",
    basisCandidate: "Kandidat, nicht offiziell",
    sources: (detected, interpolated) => `${detected} TrackNet · ${interpolated} InpaintNet`,
    warnConstant: (axis, value, from, to, length, range) =>
      `${axis} bleibt bei ${value} über ${length} Bilder (${from}–${to}), während ${axis === "x" ? "y" : "x"} sich um ${range} px ändert: Ball im Video prüfen`,
    warnRepeatedDetection: (x, y, from, to) => `gleiche TrackNet-Position (${x}, ${y}) in den Bildern ${from} und ${to}: wiederholtes Videobild oder hängende Erkennung prüfen`,
    warnRepeatedInterpolation: (x, y, from, to) => `gleiche InpaintNet-Position (${x}, ${y}) in den Bildern ${from} und ${to}: eine Interpolation, keine Erkennung`,
    warnRepeatedMixed: (x, y, from, to) => `gleiche Position (${x}, ${y}) in den Bildern ${from} und ${to}, einmal TrackNet und einmal InpaintNet`,
    warnJumpRemoved: (from, to, entry, back) =>
      `Tracker-Sprung entfernt: Bilder ${from}–${to} verließen die Bahn${entry !== null ? ` um ${entry} px` : ""}${back !== null ? ` und sie setzte bei Bild ${back} wieder ein` : ""}`,
    warnImplausible: (from, to, speed, limit) => `unplausibler Schritt ${from}→${to} (${speed} px/s, Grenze ${limit} px/s): behalten, nie als Geschwindigkeit genutzt`,
    warnMore: (count) => `${count} weitere Verfolgungshinweise`,
    estimated3d: "Geschätzt 3D — monokular, experimentell",
    estimatedRejected: (reasons) => `Physikalische Flugbahn nicht verfügbar (${reasons})`,
    estimatedAvailable: (speed, low, high) => `${speed} km/h, Bereich ${low}–${high} km/h (Schätzung aus einer Kamera, keine Messung)`,
    measured3dNotRun: "Gemessen 3D: NICHT AUSGEFÜHRT — kein Stereo-Eingang",
    empty: "Bahn nicht verfügbar — unzureichende Ballverfolgung.",
    unknownSide: "Nicht klassifiziert — keine Vorlage gezeichnet.",
    net: "Netz",
    playerCourt: "Eigene Seite",
    opponentCourt: "Gegenseite",
    contactWord: "Schlag",
    readout: (frame, time, x, y, provenance) => `Bild ${frame} · ${time} s · x ${x} · y ${y} · ${provenance}`,
    classTitles: { smash: "Smash", clear: "Clear", drop: "Drop", drive: "Drive", net_shot: "Netzschlag", lift: "Lift" },
    classShort: SHORT,
  },
};

function num(value: number, digits = 1): string {
  return value.toFixed(digits);
}

function provenanceWord(copy: Copy, provenance: Provenance): string {
  return provenance === "refined" ? copy.provRefined : copy.provMeasured;
}

/** The text of one backend tracking check. Every check names its TrackNet and InpaintNet points apart. */
function checkText(copy: Copy, check: TrackingCheck): string {
  switch (check.kind) {
    case "constant_x":
    case "constant_y":
      return `${copy.warnConstant(check.kind === "constant_x" ? "x" : "y", check.value, check.from, check.to, check.length, Math.round(check.other_range_px))} · ${copy.sources(check.detected, check.interpolated)}`;
    case "repeated_detection":
      return copy.warnRepeatedDetection(check.x, check.y, check.from, check.to);
    case "repeated_interpolation":
      return copy.warnRepeatedInterpolation(check.x, check.y, check.from, check.to);
    case "repeated_mixed":
      return copy.warnRepeatedMixed(check.x, check.y, check.from, check.to);
    case "tracker_jump_removed":
      return `${copy.warnJumpRemoved(check.from, check.to, check.entry_step_px === null ? null : Math.round(check.entry_step_px), check.return_frame)} · ${copy.sources(check.detected, check.interpolated)}`;
    case "implausible_step":
      return copy.warnImplausible(check.from, check.to, Math.round(check.speed_px_s), Math.round(check.limit_px_s));
  }
}

export default function ShotTrajectory({
  language,
  record,
  loading,
  playerColour,
  shuttle,
  fps,
  sourceUrl,
  estimated3d = null,
  measured3d = null,
}: {
  language: StudioLanguage;
  record: TrajectoryEstimate | null;
  loading: boolean;
  playerColour: (player: string | null) => string;
  shuttle: Map<number, ShuttleObservation> | null;
  fps: number;
  sourceUrl: string | null;
  estimated3d?: Estimated3D | null;
  measured3d?: Measured3D | null;
}) {
  const copy = COPY[language];
  const [mode, setMode] = useState<Mode>("measured");
  const [zoom, setZoom] = useState<Zoom>("path");
  // A template preview belongs to one shot: it is dropped when the selection moves to another shot.
  const [previewFor, setPreviewFor] = useState<{ shotId: string; label: SixType } | null>(null);
  const [hover, setHover] = useState<PathPoint | null>(null);
  const [showFrame, setShowFrame] = useState(true);
  // The background is the frame at the contact candidate. Hooks run before any early return.
  const backgroundFrame = useSourceFrame(sourceUrl, record ? record.frame : 0, fps, showFrame && mode === "measured" && record !== null);

  if (loading) {
    return (
      <section className={styles.card} aria-busy="true" aria-labelledby="shot-traj-title">
        <h4 id="shot-traj-title" className={styles.title}>{copy.title}</h4>
        <div className={styles.skeleton} />
      </section>
    );
  }

  const lastFrame = shuttle && shuttle.size > 0 ? Math.max(...shuttle.keys()) : null;
  const path = record ? buildShotPath(record, shuttle, lastFrame) : null;
  const labels = record ? resolveLabels(record) : null;
  if (!record || !path || !labels || path.points.length < 2) {
    return (
      <section className={styles.card} aria-labelledby="shot-traj-title">
        <h4 id="shot-traj-title" className={styles.title}>{copy.title}</h4>
        <p className={styles.empty}>{copy.empty}</p>
      </section>
    );
  }

  const [frameWidth, frameHeight] = record.frame_size?.[0] && record.frame_size?.[1] ? record.frame_size : [1920, 1080];
  const box = zoom === "path" ? zoomBox(frameWidth, frameHeight, path.points) : { x: 0, y: 0, width: frameWidth, height: frameHeight };
  const size = Math.max(box.width, box.height);
  const preview = previewFor && previewFor.shotId === record.shot_id ? previewFor.label : null;
  const templateLabel = preview ?? labels.sideLabel;
  const template = sideTemplate(templateLabel);
  const titleLabel = templateLabel ? copy.classTitles[templateLabel] : null;
  const aiTitle = labels.aiLabel ? copy.classTitles[labels.aiLabel] : "–";
  const aiScore = labels.aiLabel ? labels.scores[labels.aiLabel] : undefined;
  const uncertainty = uncertaintyView(labels);
  const ranked = uncertainty.ranked.map((item) => `${copy.classShort[item.label as SixType] ?? item.label} ${num(item.score, 2)}`).join(" · ");
  const warnings = checksOf(record);
  const speed = record.image_speed ?? null;
  const basis = speed?.basis === "confirmed_contact" ? copy.basisConfirmed : copy.basisCandidate;
  const { integrity, counts } = path;
  const matched = path.points.filter((point) => point.matchesFile === true).length;
  const truncated = counts.truncatedAfterReason === "video_end" ? copy.truncVideoEnd : counts.truncatedAfterReason === "tracking" ? copy.truncTracking : null;

  function nearestPoint(event: PointerEvent<SVGSVGElement>): PathPoint | null {
    const svg = event.currentTarget;
    const matrix = svg.getScreenCTM();
    if (!matrix) return null;
    const point = svg.createSVGPoint();
    point.x = event.clientX;
    point.y = event.clientY;
    const local = point.matrixTransform(matrix.inverse());
    let best: PathPoint | null = null;
    let bestDistance = Infinity;
    for (const candidate of path!.points) {
      const distance = Math.hypot(candidate.xPx - local.x, candidate.yPx - local.y);
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    return best && bestDistance <= size * 0.04 ? best : null;
  }

  return (
    <section className={styles.card} aria-labelledby="shot-traj-title">
      <header className={styles.header}>
        <h4 id="shot-traj-title" className={styles.title}>{copy.title}</h4>
        <div className={styles.controls}>
          <div className={styles.seg} role="group" aria-label={copy.title}>
            <button type="button" aria-pressed={mode === "measured"} onClick={() => setMode("measured")}>{copy.modeMeasured}</button>
            <button type="button" aria-pressed={mode === "side"} onClick={() => setMode("side")}>{copy.modeSide}</button>
          </div>
          {mode === "measured" ? (
            <>
              <div className={styles.seg} role="group" aria-label={copy.zoomPath}>
                <button type="button" aria-pressed={zoom === "path"} onClick={() => setZoom("path")}>{copy.zoomPath}</button>
                <button type="button" aria-pressed={zoom === "frame"} onClick={() => setZoom("frame")}>{copy.zoomFrame}</button>
              </div>
              {sourceUrl ? (
                <button type="button" className={styles.frameToggle} aria-pressed={showFrame} onClick={() => setShowFrame((value) => !value)}>
                  {copy.frameToggle}: {showFrame ? copy.on : copy.off}
                </button>
              ) : null}
            </>
          ) : null}
        </div>
      </header>

      <p className={styles.note}>{mode === "measured" ? copy.measuredNote : copy.sideNote}</p>

      <div className={styles.chips}>
        <span className={styles.chip}>
          <span className={styles.chipKey}>{copy.aiLabel}</span>
          <strong>{aiTitle}</strong>
          {aiScore !== undefined ? <span className={styles.chipMeta}>{num(aiScore, 2)}</span> : null}
        </span>
        {uncertainty.uncertain ? <span className={styles.chip} data-tone="warn">{copy.uncertainChip}</span> : null}
        <span className={styles.chip} data-tone={labels.reviewedLabel ? "ok" : "muted"}>
          <span className={styles.chipKey}>{labels.reviewedLabel ? copy.reviewed : copy.noReview}</span>
          {labels.reviewedLabel ? <strong>{copy.classTitles[labels.reviewedLabel]}</strong> : null}
        </span>
        <span className={styles.chip}>
          <i className={styles.swatch} style={{ background: playerColour(record.player) }} aria-hidden="true" />
          <strong>{record.player ?? "–"}</strong>
          <span className={styles.chipMeta}>{num(record.timestamp_s, 2)} s · f {record.frame}</span>
        </span>
        <span className={styles.chip} data-tone={record.contact_status === "confirmed" ? "ok" : "warn"}>
          {record.contact_status === "confirmed" ? copy.confirmed : copy.unconfirmed}
        </span>
        <span className={styles.chip}>
          <span className={styles.chipKey}>{copy.quality}</span>
          <strong>{copy.qualityValues[record.evidence_quality]}</strong>
        </span>
      </div>

      {mode === "measured" ? (
        <div className={styles.stage}>
          <svg
            viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
            className={styles.svg}
            role="img"
            aria-label={copy.measuredNote}
            onPointerMove={(event) => setHover(nearestPoint(event))}
            onPointerLeave={() => setHover(null)}
          >
            {backgroundFrame ? (
              <image href={backgroundFrame} x={0} y={0} width={frameWidth} height={frameHeight} preserveAspectRatio="none" opacity={0.85} />
            ) : null}
            {path.runs.map((run, runIndex) => (
              <g key={`run-${runIndex}`}>
                {run.slice(1).map((next, index) => {
                  const previous = run[index];
                  const colour = next.role === "before" ? BEFORE : AFTER;
                  const dashed = previous.provenance === "refined" || next.provenance === "refined";
                  return (
                    <line
                      key={`seg-${previous.frame}-${next.frame}`}
                      x1={previous.xPx}
                      y1={previous.yPx}
                      x2={next.xPx}
                      y2={next.yPx}
                      stroke={colour}
                      strokeWidth={size * 0.0045}
                      strokeLinecap="round"
                      strokeDasharray={dashed ? `${size * 0.012} ${size * 0.01}` : undefined}
                    />
                  );
                })}
                {runIndex > 0 ? (
                  <g className={styles.breakMark} transform={`translate(${run[0].xPx} ${run[0].yPx})`}>
                    <line x1={-size * 0.012} y1={-size * 0.012} x2={size * 0.012} y2={size * 0.012} />
                    <line x1={-size * 0.012} y1={size * 0.012} x2={size * 0.012} y2={-size * 0.012} />
                  </g>
                ) : null}
              </g>
            ))}
            {path.points.map((point) => {
              if (point.role === "contact") return null;
              const colour = point.role === "before" ? BEFORE : AFTER;
              if (point.provenance === "measured") {
                return <circle key={`pt-${point.frame}`} cx={point.xPx} cy={point.yPx} r={size * 0.0055} fill={colour} />;
              }
              // InpaintNet fills are drawn as dotted rings, never as detection dots.
              return (
                <circle
                  key={`pt-${point.frame}`}
                  cx={point.xPx}
                  cy={point.yPx}
                  r={size * 0.0065}
                  fill="none"
                  stroke={colour}
                  strokeWidth={size * 0.0025}
                  strokeDasharray={`${size * 0.003} ${size * 0.003}`}
                />
              );
            })}
            {path.rejected.map((mark) => (
              // A point the sanitizer removed: a grey cross, never joined to the path.
              <g key={`rej-${mark.frame}`} className={styles.rejectedMark} transform={`translate(${mark.xPx} ${mark.yPx})`}>
                <title>{`${mark.frame} · ${copy.legendRejected} (${mark.reason})`}</title>
                <line x1={-size * 0.01} y1={-size * 0.01} x2={size * 0.01} y2={size * 0.01} stroke={REJECTED} strokeWidth={size * 0.003} />
                <line x1={-size * 0.01} y1={size * 0.01} x2={size * 0.01} y2={-size * 0.01} stroke={REJECTED} strokeWidth={size * 0.003} />
              </g>
            ))}
            {path.lastObserved ? (
              <circle cx={path.lastObserved.xPx} cy={path.lastObserved.yPx} r={size * 0.03} fill="none" stroke="#ffffff" strokeWidth={size * 0.0025} strokeDasharray={`${size * 0.005} ${size * 0.005}`} />
            ) : null}
            {path.contact ? (
              <circle cx={path.contact.xPx} cy={path.contact.yPx} r={size * 0.018} fill={CONTACT} stroke="#ffffff" strokeWidth={size * 0.003} />
            ) : null}
            {hover ? <circle cx={hover.xPx} cy={hover.yPx} r={size * 0.024} fill="none" stroke="#ffffff" strokeWidth={size * 0.002} /> : null}
          </svg>
          {hover ? (
            <div className={styles.readout} aria-live="polite">
              {copy.readout(hover.frame, num(hover.timeS, 3), num(hover.xPx, 1), num(hover.yPx, 1), provenanceWord(copy, hover.provenance))}
            </div>
          ) : null}
        </div>
      ) : (
        <div className={styles.stage}>
          <svg viewBox={`0 0 ${SIDE_VIEW.width} ${SIDE_VIEW.height}`} className={styles.svg} role="img" aria-label={copy.sideNote}>
            <rect x="0" y="0" width={SIDE_VIEW.width} height={SIDE_VIEW.height} rx="14" className={styles.sideBg} />
            {titleLabel ? (
              <text x={SIDE_VIEW.width - 26} y="40" textAnchor="end" className={styles.sideTitle}>{titleLabel}</text>
            ) : null}
            <circle cx="26" cy="28" r="6" fill={SIDE_CONTACT} />
            <text x="40" y="33" className={styles.sideContactWord}>{copy.contactWord}</text>
            <rect x={SIDE_VIEW.netX - 1} y={SIDE_VIEW.netTop} width="2" height={SIDE_VIEW.ground - SIDE_VIEW.netTop} className={styles.net} />
            <path d={`M${SIDE_VIEW.netX} ${SIDE_VIEW.netTop} H${SIDE_VIEW.netX + 14}`} className={styles.netFlag} />
            <text x={SIDE_VIEW.netX + 6} y={SIDE_VIEW.ground - 8} className={styles.sideLabel}>{copy.net}</text>
            <line x1="24" y1={SIDE_VIEW.ground} x2={SIDE_VIEW.width - 24} y2={SIDE_VIEW.ground} className={styles.ground} />
            <text x="24" y="224" className={styles.sideLabel}>{copy.playerCourt}</text>
            <text x={SIDE_VIEW.width - 24} y="224" textAnchor="end" className={styles.sideLabel}>{copy.opponentCourt}</text>
            {template ? (
              <>
                <path d={template.d} className={styles.sidePath} />
                <circle cx={template.contact.x} cy={template.contact.y} r="9" fill={SIDE_CONTACT} stroke="#0f2129" strokeWidth="3" />
                <circle cx={template.contact.x} cy={template.contact.y} r="3.5" fill="#ffffff" />
                <circle cx={template.end.x} cy={template.end.y} r="7" fill={SIDE_LINE} />
              </>
            ) : (
              <text x={SIDE_VIEW.width / 2} y="168" textAnchor="middle" className={styles.sideLabel}>{copy.unknownSide}</text>
            )}
            <text x={SIDE_VIEW.width / 2} y="250" textAnchor="middle" className={styles.sideCaption}>{copy.sideNote}</text>
            {preview && preview !== labels.sideLabel ? (
              <text x={SIDE_VIEW.width / 2} y="264" textAnchor="middle" className={styles.sideCaption}>{copy.previewNote}</text>
            ) : null}
          </svg>
        </div>
      )}

      {mode === "side" ? (
        <div className={styles.templates} role="radiogroup" aria-label={copy.modeSide}>
          {TEMPLATE_ORDER.map((label) => {
            const active = (preview ?? labels.sideLabel) === label;
            return (
              <button
                key={label}
                type="button"
                role="radio"
                aria-checked={active}
                className={styles.templateButton}
                onClick={() => setPreviewFor(label === labels.sideLabel ? null : { shotId: record.shot_id, label })}
              >
                {copy.classShort[label]}
              </button>
            );
          })}
        </div>
      ) : null}

      <footer className={styles.footer}>
        {mode === "measured" ? (
          <div className={styles.legend}>
            <span><i style={{ background: BEFORE }} />{copy.legendMeasured}</span>
            <span><i className={styles.ringRefined} />{copy.legendRefined}</span>
            <span><i className={styles.crossRejected} />{copy.legendRejected}</span>
            <span>{copy.legendBreak}</span>
            <span><i className={styles.dotContact} />{copy.legendContact}</span>
          </div>
        ) : null}
        <div className={styles.facts}>
          <span>{copy.observed(counts.before, counts.expectedBefore, counts.after, counts.expectedAfter, counts.refined, counts.rejected, counts.breaks)}</span>
          <span>{speed && speed.px_per_s !== null ? copy.imageSpeed(Math.round(speed.px_per_s), basis) : copy.imageSpeedNone}</span>
          {integrity.checked ? <span>{copy.fileCheck(matched, integrity.mismatches, integrity.missingFromFile)}</span> : null}
          {integrity.visibleButMissing > 0 ? <span className={styles.warn}>{copy.hiddenFromRecord(integrity.visibleButMissing)}</span> : null}
          {truncated ? <span className={styles.warn}>{truncated}</span> : null}
          {ranked ? <span>{copy.rankedLabel}: {ranked}</span> : null}
        </div>
        {warnings.slice(0, MAX_WARNINGS_SHOWN).map((warning) => (
          <p key={`${warning.kind}-${warning.from}-${warning.to}`} className={styles.warning}>{checkText(copy, warning)}</p>
        ))}
        {warnings.length > MAX_WARNINGS_SHOWN ? <p className={styles.warning}>{copy.warnMore(warnings.length - MAX_WARNINGS_SHOWN)}</p> : null}
        {estimated3d ? (
          <p className={styles.note}>
            <strong>{copy.estimated3d}:</strong>{" "}
            {estimated3d.status === "available" && estimated3d.speed_candidate_kmh !== null && estimated3d.speed_range_kmh
              ? copy.estimatedAvailable(estimated3d.speed_candidate_kmh, estimated3d.speed_range_kmh[0], estimated3d.speed_range_kmh[1])
              : copy.estimatedRejected(estimated3d.rejection_reasons.join(", ") || estimated3d.status)}
          </p>
        ) : null}
        {measured3d ? <p className={styles.note}>{copy.measured3dNotRun}</p> : null}
      </footer>
    </section>
  );
}
