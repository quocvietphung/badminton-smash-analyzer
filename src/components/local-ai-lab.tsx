"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Film,
  Loader2,
  MessageCircleMore,
  RefreshCw,
  Server,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import type { StudioLanguage } from "@/lib/studio-types";
import {
  apiUrl,
  artifactUrl,
  clampProgress,
  fetchJson,
  formatBytes,
  formatPercent,
  formatSeconds,
  heatmapCells,
  isTerminalStatus,
  LOCAL_AI_ARTIFACT_NAMES,
  LOCAL_AI_MAX_UPLOAD_BYTES,
  LOCAL_AI_POLL_INTERVAL_MS,
  LocalAiApiError,
  readStoredJobId,
  LOCAL_AI_PROXY_BASE,
  trajectorySegments,
  visibleRatio,
  writeStoredJobId,
  type LocalAiHealth,
  type LocalAiJob,
  type LocalAiSample,
  type TrajectoryFrame,
} from "@/lib/local-ai/client";
import { publishAnalysisSnapshot } from "@/lib/analysis-session-store";
import { buildVideoAnalysisSnapshot, type VideoAnalysisResults } from "@/lib/video-analysis";
import type { MatchDocument } from "@/lib/match/types";
import { EvidenceViewer } from "./evidence-viewer";
import { MatchDashboard } from "./match-dashboard";
import { ModelPanel } from "./model-panel";
import { StatisticsPanel } from "./statistics-panel";
import { measuredRemainingSeconds } from "@/lib/local-ai/estimate";
import { WORKFLOW_COPY } from "@/lib/local-ai/copy-workflow";
import { sendVideo, type UploadSession } from "@/lib/local-ai/upload";
import { SampleLibrary, type SampleMode } from "./sample-library";
import styles from "./local-ai-lab.module.css";

type Results = {
  video: { width: number; height: number; fps: number; frames_analysed: number; duration_s: number | null };
  identity?: VideoAnalysisResults["identity"];
  players: {
    tracks_total: number;
    tracks_confirmed: number;
    max_concurrent_confirmed: number;
    mean_detection_score: number;
    detector: string;
    logical_identities?: number;
    mode?: string;
  };
  movement: {
    units: string;
    per_player: Array<{
      track_id: number;
      observed_frames: number;
      coverage_ratio: number;
      segments: number;
      path_length_norm: number;
      avg_speed_norm_per_s: number;
    }>;
    heatmap: { normalised: number[][]; total_observations: number };
    court_plane?: {
      units: string;
      per_player: Array<{
        track_id: number;
        observed_frames: number;
        path_length_m: number;
        avg_speed_m_per_s: number;
        share_inside_doubles_outline: number;
      }>;
      heatmap: { normalised: number[][]; total_observations: number } | null;
    };
  };
  shuttle: {
    frames_total: number;
    frames_visible: number;
    frames_detected: number;
    frames_interpolated: number;
    visible_ratio: number;
    visible_runs: number;
    longest_visible_run_frames: number;
    mean_confidence_detected: number;
    step_px_per_frame_p95: number | null;
    units: string;
  };
  court: {
    status: string;
    reason: string;
    template?: string;
    score?: number;
    coverage?: number;
  };
  rally_segmentation: { status: string; reason: string };
  shot_classification: { status: string; reason: string };
  confidence: Record<string, number | string>;
  limitations: string[];
  artifacts: Record<string, string | null>;
};

type ShuttleFile = { frames: TrajectoryFrame[]; source_width: number; source_height: number };
type MetricsFile = {
  wall_seconds: number;
  frames_per_second: number | null;
  cpu_seconds: number;
  cpu_utilisation_mean: number | null;
  peak_rss_mb: number;
  detector_ms_per_frame: number | null;
  output_bytes: Record<string, number>;
  threads: number;
};
type ReportFile = {
  pipeline_version: string;
  models: Array<{ name: string; licence: string; task: string; applied?: boolean }>;
  runtime: { onnxruntime: string; opencv: string; numpy: string };
  deviations_from_reference: string[];
};

type HealthState = { state: "checking" } | { state: "offline"; message: string } | { state: "ready"; health: LocalAiHealth };
type Copy = (typeof COPY)[StudioLanguage];

/** A results section that stays closed until the reader asks for it, so the page shows the main dashboard first. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className={styles.group}>
      <summary className={styles.groupSummary}>{title}</summary>
      <div className={styles.groupBody}>{children}</div>
    </details>
  );
}

const COPY = {
  en: {
    eyebrow: "Video analysis · local Docker backend",
    title: "Analyse a badminton video on this machine",
    intro:
      "Upload an MP4 or MOV, or pick a test sample. The local Docker backend tracks the shuttle with TrackNetV3 and people with YOLOX, then writes an annotated MP4 and JSON exports. The video stays on this machine.",
    backend: "Local backend",
    backendChecking: "Checking the backend…",
    backendReady: "Backend ready",
    backendDegraded: "Backend running with missing models or database",
    backendOffline: "Backend not reachable. Start it with docker compose up -d --build.",
    recheck: "Check again",
    models: "Models",
    ffmpeg: "ffmpeg",
    limits: "Limits",
    sourceTitle: "Choose a video",
    uploadLabel: "Upload an MP4 or MOV video",
    uploadHint: "Maximum 200 MB and 120 seconds. Frames stay on this machine.",
    uploadButton: "Analyse uploaded video",
    sampleLabel: "Test samples (CC-licensed, trimmed to 15 s)",
    sampleButton: "Analyse sample",
    sampleMissing: "Sample file not on disk. Run scripts/download-test-data.sh.",
    unsupportedFile: "Only MP4 or MOV files can be analysed.",
    tooLarge: "The file is larger than 200 MB.",
    submitting: "Sending to the local backend…",
    jobTitle: "Analysis job",
    queued: "Queued",
    running: "Running",
    completed: "Completed",
    failed: "Failed",
    stage: "Stage",
    progress: "Progress",
    attempts: "Attempt",
    elapsed: "Elapsed",
    resultsTitle: "Results",
    groupEvidence: "Evidence: original and annotated video, identity events, corrections",
    groupModels: "AI models that ran",
    groupStats: "Measured statistics and exports",
    groupTechnical: "Technical details: court, players, heatmaps, trajectory, measurements",
    video: "Annotated video",
    videoNote: "Boxes are person detections; the shuttle marker is a detection in image coordinates.",
    court: "Court calibration",
    courtOk: "Calibrated: floor-plane metres are shown below.",
    courtFailed: "Not calibrated. Only image-space values are reported.",
    courtScore: "Fit score",
    heatmap: "Player occupancy (image space)",
    heatmapNote: "Share of confirmed foot points per cell. Not a tactical claim.",
    courtHeatmap: "Occupancy on the court plane",
    shuttle: "Shuttle trajectory (detections in image coordinates)",
    shuttleLegend: "Solid: TrackNet detection · Dashed: InpaintNet interpolation",
    shuttleStats: "Shuttle visibility",
    visibleRatio: "Visible frames",
    detectedFrames: "Detected frames",
    interpolatedFrames: "Interpolated frames",
    runs: "Visible runs",
    meanConfidence: "Mean detection confidence",
    stepP95: "Image step, 95th percentile (px per frame)",
    players: "Players",
    tracks: "Confirmed tracks",
    maxConcurrent: "Max players per frame",
    detectionScore: "Mean detection score",
    movementTable: "Movement per track",
    track: "Track",
    frames: "Frames",
    coverage: "Coverage",
    segments: "Segments",
    pathNorm: "Path (normalised image units)",
    speedNorm: "Speed (normalised image units / s)",
    pathM: "Path on court (m, approx.)",
    speedM: "Speed on court (m/s, approx.)",
    inside: "Inside outline",
    unsupportedTitle: "Rally statistics",
    rally: "Rally segmentation",
    shots: "Shot classification",
    unsupported: "Not supported in this build",
    metrics: "Processing measurements",
    wall: "Wall time",
    fps: "Frames per second",
    cpu: "CPU time",
    rss: "Peak memory (MB)",
    detectorMs: "Detector time per frame (ms)",
    downloads: "Files",
    inference: "Inference report",
    licence: "Licence",
    limitations: "Limitations",
    error: "Error",
    newJob: "New analysis",
    askCoach: "Ask the coach",
    retry: "Refresh status",
    notReady: "This result is not ready yet.",
    loadingResults: "Loading results…",
    stages: {
      queued: "Queued",
      starting: "Starting",
      probe: "Reading video",
      background: "Background and court calibration",
      analyse: "Tracking shuttle and players",
      refine: "Refining shuttle path",
      analytics: "Computing statistics",
      render: "Rendering annotated video",
      done: "Finishing",
      completed: "Completed",
      failed: "Failed",
    },
  },
  vi: {
    eyebrow: "Phân tích video · backend Docker trên máy",
    title: "Phân tích video cầu lông trên máy này",
    intro:
      "Tải lên MP4 hoặc MOV, hoặc chọn video mẫu. Backend Docker trên máy theo dõi cầu bằng TrackNetV3 và người chơi bằng YOLOX, rồi xuất video MP4 có chú thích và file JSON. Video chỉ ở trên máy này.",
    backend: "Backend cục bộ",
    backendChecking: "Đang kiểm tra backend…",
    backendReady: "Backend sẵn sàng",
    backendDegraded: "Backend đang chạy nhưng thiếu mô hình hoặc cơ sở dữ liệu",
    backendOffline: "Không kết nối được backend. Hãy chạy docker compose up -d --build.",
    recheck: "Kiểm tra lại",
    models: "Mô hình",
    ffmpeg: "ffmpeg",
    limits: "Giới hạn",
    sourceTitle: "Chọn video",
    uploadLabel: "Tải lên video MP4 hoặc MOV",
    uploadHint: "Tối đa 200 MB và 120 giây. Khung hình chỉ nằm trên máy này.",
    uploadButton: "Phân tích video đã tải",
    sampleLabel: "Video mẫu (giấy phép CC, cắt còn 15 giây)",
    sampleButton: "Phân tích video mẫu",
    sampleMissing: "Chưa có file mẫu trên máy. Hãy chạy scripts/download-test-data.sh.",
    unsupportedFile: "Chỉ phân tích được file MP4 hoặc MOV.",
    tooLarge: "File lớn hơn 200 MB.",
    submitting: "Đang gửi tới backend cục bộ…",
    jobTitle: "Tác vụ phân tích",
    queued: "Đang chờ",
    running: "Đang chạy",
    completed: "Hoàn tất",
    failed: "Thất bại",
    stage: "Giai đoạn",
    progress: "Tiến độ",
    attempts: "Lần thử",
    elapsed: "Đã chạy",
    resultsTitle: "Kết quả",
    groupEvidence: "Bằng chứng: video gốc và video chú thích, sự kiện định danh, hiệu chỉnh",
    groupModels: "Mô hình AI đã chạy",
    groupStats: "Thống kê đo được và tệp xuất",
    groupTechnical: "Chi tiết kỹ thuật: sân, người chơi, bản đồ nhiệt, quỹ đạo, số đo",
    video: "Video có chú thích",
    videoNote: "Khung là phát hiện người chơi; điểm cầu là phát hiện trong tọa độ ảnh.",
    court: "Hiệu chỉnh sân",
    courtOk: "Đã hiệu chỉnh: số liệu mét trên mặt sân được hiển thị bên dưới.",
    courtFailed: "Chưa hiệu chỉnh. Chỉ hiển thị số liệu trong không gian ảnh.",
    courtScore: "Điểm khớp",
    heatmap: "Mật độ vị trí người chơi (không gian ảnh)",
    heatmapNote: "Tỉ lệ điểm chân được xác nhận trong mỗi ô. Không phải nhận định chiến thuật.",
    courtHeatmap: "Mật độ trên mặt sân",
    shuttle: "Quỹ đạo cầu (phát hiện trong tọa độ ảnh)",
    shuttleLegend: "Nét liền: phát hiện TrackNet · Nét đứt: nội suy InpaintNet",
    shuttleStats: "Độ hiển thị của cầu",
    visibleRatio: "Khung có cầu",
    detectedFrames: "Khung phát hiện",
    interpolatedFrames: "Khung nội suy",
    runs: "Đoạn hiển thị",
    meanConfidence: "Độ tin cậy phát hiện trung bình",
    stepP95: "Bước di chuyển ảnh, phân vị 95 (px mỗi khung)",
    players: "Người chơi",
    tracks: "Quỹ đạo đã xác nhận",
    maxConcurrent: "Số người tối đa mỗi khung",
    detectionScore: "Điểm phát hiện trung bình",
    movementTable: "Di chuyển theo quỹ đạo",
    track: "Quỹ đạo",
    frames: "Khung",
    coverage: "Độ phủ",
    segments: "Đoạn",
    pathNorm: "Quãng đường (đơn vị ảnh chuẩn hóa)",
    speedNorm: "Tốc độ (đơn vị ảnh chuẩn hóa / giây)",
    pathM: "Quãng đường trên sân (m, ước lượng)",
    speedM: "Tốc độ trên sân (m/s, ước lượng)",
    inside: "Trong biên sân",
    unsupportedTitle: "Thống kê pha cầu",
    rally: "Phân đoạn pha cầu",
    shots: "Phân loại cú đánh",
    unsupported: "Chưa hỗ trợ trong bản này",
    metrics: "Số đo xử lý",
    wall: "Thời gian thực",
    fps: "Khung mỗi giây",
    cpu: "Thời gian CPU",
    rss: "Bộ nhớ đỉnh (MB)",
    detectorMs: "Thời gian bộ phát hiện mỗi khung (ms)",
    downloads: "Tệp",
    inference: "Báo cáo suy luận",
    licence: "Giấy phép",
    limitations: "Giới hạn",
    error: "Lỗi",
    newJob: "Phân tích mới",
    askCoach: "Hỏi Coach",
    retry: "Làm mới trạng thái",
    notReady: "Kết quả này chưa sẵn sàng.",
    loadingResults: "Đang tải kết quả…",
    stages: {
      queued: "Đang chờ",
      starting: "Đang khởi động",
      probe: "Đọc video",
      background: "Nền và hiệu chỉnh sân",
      analyse: "Theo dõi cầu và người chơi",
      refine: "Làm mượt quỹ đạo cầu",
      analytics: "Tính thống kê",
      render: "Dựng video có chú thích",
      done: "Hoàn tất",
      completed: "Hoàn tất",
      failed: "Thất bại",
    },
  },
  de: {
    eyebrow: "Videoanalyse · lokales Docker-Backend",
    title: "Badminton-Video auf diesem Rechner analysieren",
    intro:
      "Lade eine MP4- oder MOV-Datei hoch oder wähle ein Testbeispiel. Das lokale Docker-Backend verfolgt den Federball mit TrackNetV3 und die Personen mit YOLOX und erstellt ein annotiertes MP4 und JSON-Exporte. Das Video bleibt auf diesem Rechner.",
    backend: "Lokales Backend",
    backendChecking: "Backend wird geprüft…",
    backendReady: "Backend bereit",
    backendDegraded: "Backend läuft, aber Modelle oder Datenbank fehlen",
    backendOffline: "Backend nicht erreichbar. Starte es mit docker compose up -d --build.",
    recheck: "Erneut prüfen",
    models: "Modelle",
    ffmpeg: "ffmpeg",
    limits: "Grenzen",
    sourceTitle: "Video wählen",
    uploadLabel: "MP4- oder MOV-Video hochladen",
    uploadHint: "Maximal 200 MB und 120 Sekunden. Bilder bleiben auf diesem Rechner.",
    uploadButton: "Hochgeladenes Video analysieren",
    sampleLabel: "Testbeispiele (CC-lizenziert, auf 15 s gekürzt)",
    sampleButton: "Beispiel analysieren",
    sampleMissing: "Beispieldatei fehlt. Führe scripts/download-test-data.sh aus.",
    unsupportedFile: "Nur MP4- oder MOV-Dateien können analysiert werden.",
    tooLarge: "Die Datei ist größer als 200 MB.",
    submitting: "Wird an das lokale Backend gesendet…",
    jobTitle: "Analyseauftrag",
    queued: "In Warteschlange",
    running: "Läuft",
    completed: "Fertig",
    failed: "Fehlgeschlagen",
    stage: "Phase",
    progress: "Fortschritt",
    attempts: "Versuch",
    elapsed: "Laufzeit",
    resultsTitle: "Ergebnisse",
    groupEvidence: "Belege: Originalvideo und annotiertes Video, Identitätsereignisse, Korrekturen",
    groupModels: "KI-Modelle, die gelaufen sind",
    groupStats: "Gemessene Statistik und Exporte",
    groupTechnical: "Technische Details: Feld, Spieler, Wärmekarten, Flugbahn, Messwerte",
    video: "Annotiertes Video",
    videoNote: "Rahmen sind Personenerkennungen; der Federball-Marker ist eine Erkennung in Bildkoordinaten.",
    court: "Feldkalibrierung",
    courtOk: "Kalibriert: Werte in Metern auf der Feldebene werden unten angezeigt.",
    courtFailed: "Nicht kalibriert. Es werden nur Werte im Bildraum angezeigt.",
    courtScore: "Passungswert",
    heatmap: "Spieler-Aufenthalt (Bildraum)",
    heatmapNote: "Anteil bestätigter Fußpunkte je Zelle. Keine taktische Aussage.",
    courtHeatmap: "Aufenthalt auf der Feldebene",
    shuttle: "Federball-Flugbahn (Erkennungen in Bildkoordinaten)",
    shuttleLegend: "Durchgezogen: TrackNet-Erkennung · Gestrichelt: InpaintNet-Interpolation",
    shuttleStats: "Sichtbarkeit des Federballs",
    visibleRatio: "Sichtbare Bilder",
    detectedFrames: "Erkannte Bilder",
    interpolatedFrames: "Interpolierte Bilder",
    runs: "Sichtbare Abschnitte",
    meanConfidence: "Mittlere Erkennungssicherheit",
    stepP95: "Bildschritt, 95. Perzentil (px pro Bild)",
    players: "Spieler",
    tracks: "Bestätigte Tracks",
    maxConcurrent: "Max. Personen pro Bild",
    detectionScore: "Mittlerer Erkennungswert",
    movementTable: "Bewegung je Track",
    track: "Track",
    frames: "Bilder",
    coverage: "Abdeckung",
    segments: "Abschnitte",
    pathNorm: "Strecke (normierte Bildeinheiten)",
    speedNorm: "Geschwindigkeit (normierte Bildeinheiten / s)",
    pathM: "Strecke auf dem Feld (m, ca.)",
    speedM: "Geschwindigkeit auf dem Feld (m/s, ca.)",
    inside: "Innerhalb der Linien",
    unsupportedTitle: "Ballwechsel-Statistik",
    rally: "Ballwechsel-Segmentierung",
    shots: "Schlagklassifikation",
    unsupported: "In dieser Version nicht unterstützt",
    metrics: "Verarbeitungsmessung",
    wall: "Echtzeit",
    fps: "Bilder pro Sekunde",
    cpu: "CPU-Zeit",
    rss: "Speicherspitze (MB)",
    detectorMs: "Erkennerzeit pro Bild (ms)",
    downloads: "Dateien",
    inference: "Inferenzbericht",
    licence: "Lizenz",
    limitations: "Einschränkungen",
    error: "Fehler",
    newJob: "Neue Analyse",
    askCoach: "Coach fragen",
    retry: "Status aktualisieren",
    notReady: "Dieses Ergebnis ist noch nicht bereit.",
    loadingResults: "Ergebnisse werden geladen…",
    stages: {
      queued: "In Warteschlange",
      starting: "Startet",
      probe: "Video wird gelesen",
      background: "Hintergrund und Kalibrierung",
      analyse: "Federball und Spieler werden verfolgt",
      refine: "Flugbahn wird geglättet",
      analytics: "Statistiken werden berechnet",
      render: "Annotiertes Video wird erstellt",
      done: "Abschluss",
      completed: "Fertig",
      failed: "Fehlgeschlagen",
    },
  },
} as const;

function stageText(copy: Copy, stage: string | null): string {
  if (!stage) return "–";
  const labels = copy.stages as Record<string, string>;
  return labels[stage] ?? stage;
}

const ACCEPTED_TYPES = ["video/mp4", "video/quicktime"];
const ACCEPTED_SUFFIXES = [".mp4", ".mov"];

function isAcceptedFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return ACCEPTED_TYPES.includes(file.type) || ACCEPTED_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

export default function LocalAiLab({
  language,
  initialJobId = null,
  onOpenCoach,
  onOpenSessions,
}: {
  language: StudioLanguage;
  initialJobId?: string | null;
  onOpenCoach?: () => void;
  onOpenSessions?: () => void;
}) {
  const copy: Copy = COPY[language];
  const apiBase = LOCAL_AI_PROXY_BASE;
  const [health, setHealth] = useState<HealthState>({ state: "checking" });
  const [samples, setSamples] = useState<LocalAiSample[]>([]);
  const [selectedSample, setSelectedSample] = useState<string | null>(null);
  const [uploadFraction, setUploadFraction] = useState<number | null>(null);
  const [completedJobBySample, setCompletedJobBySample] = useState<Record<string, string>>({});
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(initialJobId);
  const [job, setJob] = useState<LocalAiJob | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [results, setResults] = useState<Results | null>(null);
  const [match, setMatch] = useState<MatchDocument | null>(null);
  const [shuttle, setShuttle] = useState<ShuttleFile | null>(null);
  const [metrics, setMetrics] = useState<MetricsFile | null>(null);
  const [report, setReport] = useState<ReportFile | null>(null);
  const [pollNonce, setPollNonce] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [evidenceRevision, setEvidenceRevision] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  // The job this page started. A completed job that was not started here is an earlier result, shown as cached.
  const [createdJobId, setCreatedJobId] = useState<string | null>(null);
  const jobStatus = job?.status ?? null;
  const loadingResults = jobStatus === "completed" && results === null && pollError === null;
  const resultIsCached = job !== null && job.status === "completed" && job.job_id !== createdJobId;

  // Backend health and samples load once on mount. State is written only after the awaited responses.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const body = await fetchJson<LocalAiHealth>(apiUrl(apiBase, "/health"));
        if (active) setHealth({ state: "ready", health: body });
      } catch (error) {
        if (active) setHealth({ state: "offline", message: error instanceof Error ? error.message : "unknown" });
      }
      try {
        const body = await fetchJson<{ samples: LocalAiSample[] }>(apiUrl(apiBase, "/api/v1/samples"));
        if (!active) return;
        setSamples(body.samples);
        setSelectedSample((current) => current ?? body.samples.find((sample) => sample.available)?.id ?? null);
      } catch {
        if (active) setSamples([]);
      }
      const restored = readStoredJobId(typeof window !== "undefined" ? window.localStorage : null);
      if (active && restored && !initialJobId) setJobId(restored);
    })();
    return () => {
      active = false;
    };
  }, [apiBase, initialJobId, pollNonce]);

  // Map each sample to its newest completed analysis, so that the library can offer "View results".
  useEffect(() => {
    let active = true;
    fetchJson<{ analyses: Array<{ job_id: string; status: string; source: { sample_id: string | null } }> }>(
      apiUrl(apiBase, "/api/v1/analyses?limit=100"),
    ).then(
      (listing) => {
        if (!active) return;
        const mapping: Record<string, string> = {};
        for (const item of listing.analyses) {
          const sampleId = item.source.sample_id;
          if (sampleId && item.status === "completed" && !(sampleId in mapping)) mapping[sampleId] = item.job_id;
        }
        setCompletedJobBySample(mapping);
      },
      () => {
        if (active) setCompletedJobBySample({});
      },
    );
    return () => {
      active = false;
    };
  }, [apiBase, jobStatus, evidenceRevision]);

  // Poll the job until it is completed or failed. A retry button bumps pollNonce to restart the loop.
  useEffect(() => {
    if (!jobId) return;
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const body = await fetchJson<LocalAiJob>(apiUrl(apiBase, `/api/v1/analyses/${jobId}`));
        if (!active) return;
        setJob(body);
        setPollError(null);
        if (!isTerminalStatus(body.status)) timer = window.setTimeout(poll, LOCAL_AI_POLL_INTERVAL_MS);
      } catch (error) {
        if (!active) return;
        if (error instanceof LocalAiApiError && error.code === "unknown_job") {
          setJobId(null);
          setJob(null);
          setPollError(null);
          return;
        }
        setPollError(error instanceof Error ? error.message : "unknown");
        timer = window.setTimeout(poll, LOCAL_AI_POLL_INTERVAL_MS * 2);
      }
    };
    void poll();
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [apiBase, jobId, pollNonce]);

  useEffect(() => {
    if (!job || isTerminalStatus(job.status)) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [job]);

  // Load the artifacts of a completed job once.
  useEffect(() => {
    if (!jobId || jobStatus !== "completed") return;
    let active = true;
    (async () => {
      try {
        const [resultBody, shuttleBody, metricsBody, reportBody, matchBody] = await Promise.all([
          fetchJson<Results>(apiUrl(apiBase, `/api/v1/analyses/${jobId}/results`)),
          fetchJson<ShuttleFile>(artifactUrl(apiBase, jobId, "shuttle_trajectory.json")),
          fetchJson<MetricsFile>(artifactUrl(apiBase, jobId, "metrics.json")),
          fetchJson<ReportFile>(artifactUrl(apiBase, jobId, "inference_report.json")),
          fetchJson<MatchDocument>(apiUrl(apiBase, `/api/v1/analyses/${jobId}/match`)),
        ]);
        if (!active) return;
        setResults(resultBody);
        setShuttle(shuttleBody);
        setMetrics(metricsBody);
        setReport(reportBody);
        setMatch(matchBody);
      } catch (error) {
        if (active) setPollError(error instanceof Error ? error.message : "unknown");
      }
    })();
    return () => {
      active = false;
    };
  }, [apiBase, jobId, jobStatus, evidenceRevision]);

  // Share the completed analysis with the AI Coach: derived values from results.json only.
  useEffect(() => {
    if (!results || !jobId || !job) return;
    publishAnalysisSnapshot(buildVideoAnalysisSnapshot(results, {
      jobId,
      sourceKind: job.source.kind === "upload" ? "upload" : "sample",
      sourceName: job.source.name,
      capturedAt: new Date(job.created_at * 1000).toISOString(),
    }, match));
  }, [results, match, jobId, job]);

  function beginRun() {
    setFormError(null);
    setResults(null);
    setMatch(null);
    setShuttle(null);
    setMetrics(null);
    setReport(null);
  }

  // A run on a sample starts a new inference job. The form is URL-encoded, which the studio's proxy forwards.
  async function startSampleAnalysis(sampleId: string, mode: SampleMode) {
    setSubmitting(true);
    beginRun();
    try {
      const created = await fetchJson<LocalAiJob>(apiUrl(apiBase, "/api/v1/analyses"), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ sample_id: sampleId, mode }).toString(),
      });
      writeStoredJobId(typeof window !== "undefined" ? window.localStorage : null, created.job_id);
      setJobId(created.job_id);
      setJob(created);
      setCreatedJobId(created.job_id);
    } catch (error) {
      setFormError(error instanceof LocalAiApiError ? `${error.code}: ${error.message}` : copy.error);
    } finally {
      setSubmitting(false);
    }
  }

  // An upload asks the server for a single-use ticket, then sends the file straight to the backend.
  async function onSubmitUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file) return;
    const work = WORKFLOW_COPY[language];
    if (!isAcceptedFile(file)) {
      setFormError(work.uploadTypeError);
      return;
    }
    if (file.size > LOCAL_AI_MAX_UPLOAD_BYTES) {
      setFormError(work.uploadSizeError);
      return;
    }
    setSubmitting(true);
    setUploadFraction(0);
    beginRun();
    try {
      const session = await fetchJson<UploadSession>("/api/upload-session", { method: "POST" });
      const created = await sendVideo(session, file, setUploadFraction);
      writeStoredJobId(typeof window !== "undefined" ? window.localStorage : null, created.job_id);
      setJobId(created.job_id);
      setJob(created);
      setCreatedJobId(created.job_id);
    } catch (error) {
      setFormError(error instanceof LocalAiApiError ? `${error.code}: ${error.message}` : work.uploadFailed);
    } finally {
      setSubmitting(false);
      setUploadFraction(null);
    }
  }

  function startNewAnalysis() {
    setJobId(null);
    setJob(null);
    setResults(null);
    setShuttle(null);
    setMetrics(null);
    setReport(null);
    setFile(null);
    setFormError(null);
    setPollError(null);
    if (fileInput.current) fileInput.current.value = "";
  }

  const elapsedSeconds = job ? ((job.finished_at ?? now / 1000) - job.created_at) : null;
  const remainingEstimate =
    job && !isTerminalStatus(job.status) && elapsedSeconds !== null
      ? measuredRemainingSeconds(job.progress, elapsedSeconds)
      : null;
  const segments = useMemo(() => (shuttle ? trajectorySegments(shuttle.frames) : []), [shuttle]);
  const cells = useMemo(() => (results ? heatmapCells(results.movement.heatmap.normalised) : []), [results]);
  const courtCells = useMemo(
    () => (results?.movement.court_plane?.heatmap ? heatmapCells(results.movement.court_plane.heatmap.normalised) : []),
    [results],
  );

  const backendLine =
    health.state === "checking"
      ? copy.backendChecking
      : health.state === "offline"
        ? WORKFLOW_COPY[language].offlineTitle
        : health.health.status === "ok"
          ? copy.backendReady
          : copy.backendDegraded;

  return (
    <section className={styles.lab} aria-labelledby="local-ai-title">
      <header className={styles.intro}>
        <p className={styles.eyebrow}>{copy.eyebrow}</p>
        <h2 id="local-ai-title">{copy.title}</h2>
        <p>{copy.intro}</p>
      </header>

      <div className={styles.grid}>
        <article className={styles.card} aria-live="polite">
          <header className={styles.cardHeader}>
            <Server aria-hidden="true" />
            <strong>{copy.backend}</strong>
            <button type="button" className={styles.ghostButton} onClick={() => setPollNonce((value) => value + 1)}>
              <RefreshCw aria-hidden="true" />
              {copy.recheck}
            </button>
          </header>
          <p className={health.state === "offline" ? styles.bad : styles.good}>
            {health.state === "ready" && health.health.status === "ok" ? <CheckCircle2 aria-hidden="true" /> : null}
            {health.state === "offline" ? <AlertTriangle aria-hidden="true" /> : null}
            {backendLine}
          </p>
          <dl className={styles.facts}>
            <div>
              <dt>{copy.models}</dt>
              <dd>
                {health.state === "ready"
                  ? Object.entries(health.health.models)
                      .map(([name, present]) => `${name}: ${present ? "✓" : "✗"}`)
                      .join(" · ")
                  : "–"}
              </dd>
            </div>
            <div>
              <dt>{copy.ffmpeg}</dt>
              <dd>{health.state === "ready" ? (health.health.ffmpeg ? "✓" : "✗") : "–"}</dd>
            </div>
            <div>
              <dt>{copy.limits}</dt>
              <dd>
                {health.state === "ready"
                  ? `${health.health.limits.max_upload_mb} MB · ${health.health.limits.max_duration_s} s`
                  : "–"}
              </dd>
            </div>
          </dl>
        </article>

        <article className={styles.card}>
          <header className={styles.cardHeader}>
            <Upload aria-hidden="true" />
            <strong>{copy.sourceTitle}</strong>
          </header>
          <form onSubmit={onSubmitUpload} className={styles.form}>
            <label className={styles.fileLabel}>
              <span>{copy.uploadLabel}</span>
              <input
                ref={fileInput}
                type="file"
                accept="video/mp4,video/quicktime,.mp4,.mov"
                onChange={(event) => {
                  setFile(event.currentTarget.files?.[0] ?? null);
                  setFormError(null);
                }}
              />
            </label>
            <p className={styles.muted}>
              {copy.uploadHint}
              {file ? ` · ${file.name} (${formatBytes(file.size)})` : ""}
            </p>
            <button type="submit" className={styles.primaryButton} disabled={!file || submitting || health.state !== "ready"}>
              {submitting ? <Loader2 aria-hidden="true" className={styles.spin} /> : <Upload aria-hidden="true" />}
              {WORKFLOW_COPY[language].uploadButton}
              {uploadFraction !== null ? ` · ${WORKFLOW_COPY[language].uploadProgress} ${Math.round(uploadFraction * 100)} %` : null}
            </button>
          </form>

          <SampleLibrary
            apiBase={apiBase}
            language={language}
            samples={samples}
            selectedId={selectedSample}
            onSelect={setSelectedSample}
            completedJobBySample={completedJobBySample}
            busy={submitting || health.state !== "ready"}
            offline={health.state === "offline"}
            onRun={startSampleAnalysis}
            onOpenSaved={(savedJobId) => {
              // Remember the saved job for the Coach, then show it in the Sessions page with its sample and other runs.
              writeStoredJobId(typeof window !== "undefined" ? window.localStorage : null, savedJobId);
              if (onOpenSessions) onOpenSessions();
            }}
          />
          {formError ? (
            <p role="alert" className={styles.bad}>
              {formError}
            </p>
          ) : null}
        </article>
      </div>

      {jobId && job ? (
        <article className={styles.card} aria-live="polite">
          <header className={styles.cardHeader}>
            <Film aria-hidden="true" />
            <strong>{copy.jobTitle}</strong>
            <span className={`${styles.badge} ${styles[`badge_${job.status}`]}`}>{copy[job.status]}</span>
            <button type="button" className={styles.ghostButton} onClick={startNewAnalysis}>
              {copy.newJob}
            </button>
          </header>
          <p className={styles.muted}>
            {job.source.name} · {copy.stage}: {stageText(copy, job.stage)} · {copy.attempts} {job.attempts} · {copy.elapsed}{" "}
            {formatSeconds(elapsedSeconds)}
          </p>
          {resultIsCached ? (
            <p className={styles.muted} role="status">
              <span className={styles.badge}>{WORKFLOW_COPY[language].cachedLabel}</span> {WORKFLOW_COPY[language].cachedNotice}
            </p>
          ) : null}
          <div
            className={styles.progress}
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(clampProgress(job.progress) * 100)}
            aria-label={copy.progress}
          >
            <span style={{ width: formatPercent(job.progress) }} />
          </div>
          {remainingEstimate !== null ? (
            <p className={styles.muted}>
              {WORKFLOW_COPY[language].estimateLabel}: ~{Math.max(1, Math.round(remainingEstimate / 60))} min ·{" "}
              {WORKFLOW_COPY[language].estimateNote}
            </p>
          ) : null}
          {job.status === "failed" && job.error ? (
            <p role="alert" className={styles.bad}>
              {copy.error}: {job.error.code} — {job.error.message}
            </p>
          ) : null}
          {pollError ? <p className={styles.muted}>{pollError}</p> : null}
          {job.status !== "completed" && job.status !== "failed" ? (
            <button type="button" className={styles.ghostButton} onClick={() => setPollNonce((value) => value + 1)}>
              <RefreshCw aria-hidden="true" />
              {copy.retry}
            </button>
          ) : null}
        </article>
      ) : null}

      {job?.status === "completed" && results ? (
        <section className={styles.results} aria-labelledby="local-ai-results-title">
          <div className={styles.resultsHeader}>
            <h3 id="local-ai-results-title">{copy.resultsTitle}</h3>
            {onOpenCoach ? (
              <button type="button" className={styles.ghostButton} onClick={onOpenCoach}>
                <MessageCircleMore aria-hidden="true" />
                {copy.askCoach}
              </button>
            ) : null}
          </div>

          <MatchDashboard apiBase={apiBase} jobId={job.job_id} language={language} revision={evidenceRevision} />

          <Group title={copy.groupEvidence}>
            <EvidenceViewer
              apiBase={apiBase}
              jobId={job.job_id}
              language={language}
              meta={{
                sourceName: job.source.name,
                width: results.video.width,
                height: results.video.height,
                fps: results.video.fps,
                frames: results.video.frames_analysed,
                mode: results.players.mode ?? "singles",
                logicalIdentities: results.players.logical_identities ?? 2,
                courtStatus: results.court.status,
              }}
              revision={evidenceRevision}
              onChanged={() => setEvidenceRevision((value) => value + 1)}
            />
          </Group>
          <Group title={copy.groupModels}>
            <ModelPanel apiBase={apiBase} jobId={job.job_id} language={language} revision={evidenceRevision} />
          </Group>
          <Group title={copy.groupStats}>
            <StatisticsPanel
              apiBase={apiBase}
              jobId={job.job_id}
              language={language}
              results={results}
              metrics={metrics}
              revision={evidenceRevision}
              shotCount={match ? match.shots.items.length : null}
            />
          </Group>

          <Group title={copy.groupTechnical}>
            <div className={styles.grid}>
              <article className={styles.card}>
                <header className={styles.cardHeader}>
                  <strong>{copy.court}</strong>
                </header>
                {results.court.status === "calibrated" ? (
                  <p className={styles.good}>
                    <CheckCircle2 aria-hidden="true" />
                    {copy.courtOk}
                  </p>
                ) : (
                  <p className={styles.muted}>
                    <AlertTriangle aria-hidden="true" />
                    {copy.courtFailed} {results.court.reason}
                  </p>
                )}
                {results.court.status === "calibrated" ? (
                  <p className={styles.muted}>
                    {copy.courtScore}: {Number(results.court.score ?? 0).toFixed(2)} · {results.court.template}
                  </p>
                ) : null}
              </article>

              <article className={styles.card}>
                <header className={styles.cardHeader}>
                  <strong>{copy.players}</strong>
                </header>
                <dl className={styles.facts}>
                  <div>
                    <dt>{copy.tracks}</dt>
                    <dd>{results.players.tracks_confirmed}</dd>
                  </div>
                  <div>
                    <dt>{copy.maxConcurrent}</dt>
                    <dd>{results.players.max_concurrent_confirmed}</dd>
                  </div>
                  <div>
                    <dt>{copy.detectionScore}</dt>
                    <dd>{Number(results.players.mean_detection_score).toFixed(2)}</dd>
                  </div>
                </dl>
              </article>
            </div>

            <div className={styles.grid}>
              <article className={styles.card}>
                <header className={styles.cardHeader}>
                  <strong>{copy.heatmap}</strong>
                </header>
                <div className={styles.heatmap} role="img" aria-label={copy.heatmap}>
                  {Array.from({ length: results.movement.heatmap.normalised.length * (results.movement.heatmap.normalised[0]?.length ?? 0) }).map((_, index) => {
                    const cols = results.movement.heatmap.normalised[0]?.length ?? 1;
                    const row = Math.floor(index / cols);
                    const col = index % cols;
                    const cell = cells.find((item) => item.row === row && item.col === col);
                    return (
                      <span
                        key={index}
                        className={styles.heatCell}
                        style={{ background: cell ? `rgba(101, 244, 200, ${0.12 + 0.88 * cell.intensity})` : "transparent" }}
                      />
                    );
                  })}
                </div>
                <p className={styles.muted}>{copy.heatmapNote}</p>
              </article>

              {results.movement.court_plane?.heatmap ? (
                <article className={styles.card}>
                  <header className={styles.cardHeader}>
                    <strong>{copy.courtHeatmap}</strong>
                  </header>
                  <div className={styles.courtHeatmap} role="img" aria-label={copy.courtHeatmap}>
                    {Array.from({ length: results.movement.court_plane.heatmap.normalised.length * (results.movement.court_plane.heatmap.normalised[0]?.length ?? 0) }).map((_, index) => {
                      const cols = results.movement.court_plane?.heatmap?.normalised[0]?.length ?? 1;
                      const row = Math.floor(index / cols);
                      const col = index % cols;
                      const cell = courtCells.find((item) => item.row === row && item.col === col);
                      return (
                        <span
                          key={index}
                          className={styles.heatCell}
                          style={{ background: cell ? `rgba(101, 244, 200, ${0.12 + 0.88 * cell.intensity})` : "transparent" }}
                        />
                      );
                    })}
                  </div>
                </article>
              ) : null}
            </div>

            {shuttle ? (
              <article className={styles.card}>
                <header className={styles.cardHeader}>
                  <strong>{copy.shuttle}</strong>
                </header>
                <svg
                  className={styles.trajectory}
                  viewBox={`0 0 ${shuttle.source_width} ${shuttle.source_height}`}
                  role="img"
                  aria-label={copy.shuttle}
                >
                  <rect x={0} y={0} width={shuttle.source_width} height={shuttle.source_height} className={styles.frameRect} />
                  {segments.map((segment, index) => (
                    <polyline
                      key={index}
                      points={segment.points.map((point) => `${point.x},${point.y}`).join(" ")}
                      className={segment.refined ? styles.trailRefined : styles.trail}
                      vectorEffect="non-scaling-stroke"
                    />
                  ))}
                </svg>
                <p className={styles.muted}>{copy.shuttleLegend}</p>
                <dl className={styles.facts}>
                  <div>
                    <dt>{copy.visibleRatio}</dt>
                    <dd>{Math.round(visibleRatio(shuttle.frames) * 100)}%</dd>
                  </div>
                  <div>
                    <dt>{copy.detectedFrames}</dt>
                    <dd>{results.shuttle.frames_detected}</dd>
                  </div>
                  <div>
                    <dt>{copy.interpolatedFrames}</dt>
                    <dd>{results.shuttle.frames_interpolated}</dd>
                  </div>
                  <div>
                    <dt>{copy.runs}</dt>
                    <dd>{results.shuttle.visible_runs}</dd>
                  </div>
                  <div>
                    <dt>{copy.meanConfidence}</dt>
                    <dd>{Number(results.shuttle.mean_confidence_detected).toFixed(2)}</dd>
                  </div>
                  <div>
                    <dt>{copy.stepP95}</dt>
                    <dd>{results.shuttle.step_px_per_frame_p95 ?? "–"}</dd>
                  </div>
                </dl>
              </article>
            ) : null}

            <article className={styles.card}>
              <header className={styles.cardHeader}>
                <strong>{copy.movementTable}</strong>
              </header>
              <div className={styles.tableWrap}>
                <table className={styles.table}>
                  <thead>
                    <tr>
                      <th>{copy.track}</th>
                      <th>{copy.frames}</th>
                      <th>{copy.coverage}</th>
                      <th>{copy.segments}</th>
                      <th>{copy.pathNorm}</th>
                      <th>{copy.speedNorm}</th>
                      {results.movement.court_plane ? <th>{copy.pathM}</th> : null}
                      {results.movement.court_plane ? <th>{copy.speedM}</th> : null}
                      {results.movement.court_plane ? <th>{copy.inside}</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {results.movement.per_player.map((row) => {
                      const court = results.movement.court_plane?.per_player.find((item) => item.track_id === row.track_id);
                      return (
                        <tr key={row.track_id}>
                          <td>P{row.track_id}</td>
                          <td>{row.observed_frames}</td>
                          <td>{Math.round(row.coverage_ratio * 100)}%</td>
                          <td>{row.segments}</td>
                          <td>{row.path_length_norm.toFixed(3)}</td>
                          <td>{row.avg_speed_norm_per_s.toFixed(3)}</td>
                          {results.movement.court_plane ? <td>{court ? court.path_length_m.toFixed(1) : "–"}</td> : null}
                          {results.movement.court_plane ? <td>{court ? court.avg_speed_m_per_s.toFixed(2) : "–"}</td> : null}
                          {results.movement.court_plane ? (
                            <td>{court ? `${Math.round(court.share_inside_doubles_outline * 100)}%` : "–"}</td>
                          ) : null}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className={styles.muted}>{results.movement.units}</p>
            </article>

            {metrics ? (
              <article className={styles.card}>
                <header className={styles.cardHeader}>
                  <strong>{copy.metrics}</strong>
                </header>
                <dl className={styles.facts}>
                  <div>
                    <dt>{copy.wall}</dt>
                    <dd>{formatSeconds(metrics.wall_seconds)}</dd>
                  </div>
                  <div>
                    <dt>{copy.fps}</dt>
                    <dd>{metrics.frames_per_second ?? "–"}</dd>
                  </div>
                  <div>
                    <dt>{copy.cpu}</dt>
                    <dd>{formatSeconds(metrics.cpu_seconds)}</dd>
                  </div>
                  <div>
                    <dt>{copy.rss}</dt>
                    <dd>{metrics.peak_rss_mb}</dd>
                  </div>
                  <div>
                    <dt>{copy.detectorMs}</dt>
                    <dd>{metrics.detector_ms_per_frame ?? "–"}</dd>
                  </div>
                </dl>
              </article>
            ) : null}

            {report ? (
              <article className={styles.card}>
                <header className={styles.cardHeader}>
                  <strong>{copy.inference}</strong>
                </header>
                <ul className={styles.modelList}>
                  {report.models.map((model) => (
                    <li key={model.name}>
                      <strong>{model.name}</strong> — {model.task} · {copy.licence}: {model.licence}
                    </li>
                  ))}
                </ul>
                <p className={styles.muted}>
                  ONNX Runtime {report.runtime.onnxruntime} · OpenCV {report.runtime.opencv} · NumPy {report.runtime.numpy}
                </p>
              </article>
            ) : null}

            <article className={styles.card}>
              <header className={styles.cardHeader}>
                <strong>{copy.limitations}</strong>
              </header>
              <ul className={styles.modelList}>
                {results.limitations.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <p className={styles.muted}>
                {copy.downloads}: {LOCAL_AI_ARTIFACT_NAMES.filter((name) => name !== "court_coordinates.json").join(", ")}
              </p>
            </article>
          </Group>
        </section>
      ) : null}

      {job?.status === "completed" && !results && loadingResults ? <p className={styles.muted}>{copy.loadingResults}</p> : null}
      {job && job.status !== "completed" && job.status !== "failed" ? (
        <p className={styles.muted}>
          <Loader2 aria-hidden="true" className={styles.spin} /> {copy.notReady}
        </p>
      ) : null}
    </section>
  );
}
