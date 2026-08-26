"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  Camera,
  Check,
  CircleDashed,
  Maximize2,
  MessageCircleMore,
  Minimize2,
  ScanLine,
  Sparkles,
} from "lucide-react";
import type { PoseLandmarker } from "@mediapipe/tasks-vision";
import {
  analyzePose,
  type PreferredHand,
  type PoseFrameMemory,
  type PoseLandmark,
} from "@/lib/pose-metrics";
import {
  classifyPoseWindow,
  type DrillMode,
  type LiteStrokeType,
  type PoseLiteResult,
  type PoseLiteSample,
} from "@/lib/pose-lite-classifier";
import {
  assignStablePlayerIds,
  resetPlayerTracking,
  type DetectedPose,
  type PlayerTrackingState,
} from "@/lib/pose-tracking";
import type {
  VisionWorkerOutgoing,
  VisionWorkerPose,
} from "@/lib/vision-worker-protocol";
import {
  courtDistance,
  createCourtMapper,
  DEFAULT_COURT_CORNERS,
  poseFootPoint,
  type CourtPoint,
} from "@/lib/rally-geometry";
import {
  assessCourtCorners,
  averageCornerDistance,
  detectCourtCornersFromVideo,
  normalizeCourtCorners,
  sourcePointToStage,
  stagePointToSource,
  validateCourtCorners,
} from "@/lib/court-calibration";
import { readRecentRallies, saveRally } from "@/lib/device-storage";
import { publishAnalysisSnapshot } from "@/lib/analysis-session-store";
import type { AnalysisSource } from "@/lib/analysis-types";
import type { StudioLanguage, StudioView } from "@/lib/studio-types";
import styles from "./rally-analyzer.module.css";

type AnalyzerStatus = "idle" | "loading" | "live" | "error";
type DataSource = AnalysisSource;
type PlayerId = "A" | "B";
type CalibrationState = "default" | "detecting" | "manual" | "review" | "failed" | "calibrated";
type CalibrationMethod = "auto" | "manual" | null;
type StorageStatus = "checking" | "indexeddb" | "localstorage";
type WorkerStatus = "checking" | "ready" | "fallback";
type VideoGeometry = {
  sourceWidth: number;
  sourceHeight: number;
  stageWidth: number;
  stageHeight: number;
};
type Connection = { start: number; end: number };

type StrokeEvent = PoseLiteResult & {
  index: number;
  hitter: PlayerId;
  position: CourtPoint;
  recordedAt: string;
};

type SessionSummary = {
  headline: string;
  insight: string;
  averageEvidence: number;
};

type SessionHistory = {
  id: string;
  createdAt: string;
  strokes: StrokeEvent[];
  summary: SessionSummary;
  movement: Record<PlayerId, number>;
  paths: Record<PlayerId, CourtPoint[]>;
  calibrated: boolean;
};

type SwingCandidate = {
  startedAt: number;
  peakAt: number;
  peakEnergy: number;
  position: CourtPoint;
};

const HISTORY_FALLBACK_KEY = "smashlab-pose-lite-history-v1";
const CALIBRATION_KEY = "smashlab-court-calibration-v3";
const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const CORNER_LABELS = ["Xa trái", "Xa phải", "Gần phải", "Gần trái"];
const PLAYER_COLOR: Record<PlayerId, string> = { A: "#5cffca", B: "#ffcf5c" };
const CLASSIFICATIONS: Array<{ type: LiteStrokeType; label: string }> = [
  { type: "smash", label: "Smash" },
  { type: "drop_shot", label: "Drop shot" },
  { type: "clear", label: "Clear / phông" },
  { type: "drive", label: "Drive / tạt" },
  { type: "overhead_control", label: "Clear / Drop chưa tách" },
  { type: "unknown", label: "Không chắc" },
];
const EN_CLASSIFICATIONS: Array<{ type: LiteStrokeType; label: string }> = [
  { type: "smash", label: "Smash" },
  { type: "drop_shot", label: "Drop shot" },
  { type: "clear", label: "Clear" },
  { type: "drive", label: "Drive" },
  { type: "overhead_control", label: "Clear / Drop unresolved" },
  { type: "unknown", label: "Uncertain" },
];

const UI_COPY = {
  vi: {
    liveAria: "Phân tích kỹ thuật cầu lông bằng tư thế",
    controlKicker: "Pose Lite · đánh đơn beta",
    openCamera: "Mở camera",
    opening: "Đang khởi động…",
    demo: "Xem demo",
    autoCourt: "Tự tìm sân",
    findingCourt: "Đang tìm sân…",
    manualCourt: "Căn tay",
    stopCamera: "Tắt camera",
    finish: "Kết thúc & xem báo cáo",
    newSession: "Phiên mới",
    steps: ["Mở camera", "Căn khung sân", "Phân tích phiên"],
    readiness: "Trạng thái sẵn sàng",
    camera: "Camera",
    cameraOn: "Đang hoạt động",
    cameraOff: "Chưa mở",
    players: "Vận động viên",
    court: "Khung sân",
    courtReady: "Đã căn",
    courtPending: "Chưa căn",
    engine: "Pose Lite",
    engineReady: "Sẵn sàng",
    enginePending: "Đang kiểm tra",
    cameraTitle: "Đặt điện thoại nhìn trọn hai vận động viên",
    cameraCopy: "Ưu tiên quay ngang, giữ máy cố định và để toàn bộ cơ thể nằm trong khung hình.",
    directCamera: "Bật camera trực tiếp",
    cameraOffBadge: "CAMERA TẮT",
    latest: "Sự kiện gần nhất",
    demoNotice: "DEMO · Dữ liệu minh họa giao diện, không lấy từ camera.",
    liveNotice: "LIVE · Chỉ phân tích tư thế; chưa có quỹ đạo cầu, điểm rơi hoặc km/h.",
    movements: "Động tác",
    strongSmash: "Smash bằng chứng cao",
    evidence: "Mức phù hợp Pose",
    movement: "Di chuyển",
    liveFeed: "Dòng sự kiện Live",
    noEvents: "Chưa có động tác. Hãy đứng trọn người trong khung hình và thực hiện một cú đánh.",
    askCoach: "Hỏi Coach",
    openReport: "Mở báo cáo đầy đủ",
    reportKicker: "Báo cáo hiện tại",
    reportEmpty: "Chưa có phiên để phân tích",
    reportEmptyCopy: "Mở camera để ghi một phiên mới hoặc dùng dữ liệu demo để xem trước giao diện báo cáo.",
    backLive: "Về màn hình Live",
    classification: "Phân loại kỹ thuật",
    classificationCopy: "Phân loại theo tầng, có trạng thái chưa phân biệt",
    classificationNote: "Chế độ tự do không ép Clear hoặc Drop khi pose chưa thấy quỹ đạo. Chọn bài tập cụ thể để dùng ngữ cảnh huấn luyện.",
    heatmap: "Heatmap di chuyển",
    playerPosition: "Vị trí vận động viên",
    hasData: "ĐÃ CÓ DỮ LIỆU",
    needsCourt: "CẦN CĂN SÂN",
    log: "Nhật ký phân tích",
    everyMovement: "Từng động tác trong phiên",
    event: "sự kiện",
    sessionInsight: "Nhận xét phiên",
    notEnough: "Chưa đủ dữ liệu",
    finishHint: "Kết thúc phiên sau khi ghi nhận vài động tác để lưu bản phân tích trên thiết bị.",
    averageEvidence: "Mức phù hợp trung bình",
    localMemory: "Bộ nhớ thiết bị",
    recentSessions: "12 phiên gần nhất",
    noHistory: "Chưa có phiên nào được lưu trên thiết bị này.",
    limitations: "Pose Lite chỉ ước tính kỹ thuật từ chuỗi tư thế. Ứng dụng chưa nhìn thấy cầu/vợt, chưa đo km/h và chưa kết luận chiến thuật rally.",
    diagnostics: "Chẩn đoán thiết bị",
    diagnosticsTitle: "Hệ thống xử lý trên thiết bị",
    diagnosticsCopy: "Thông tin kỹ thuật được tách khỏi màn hình Live để người chơi tập trung vào phiên tập.",
    classificationEngine: "Phân loại",
    storage: "Lịch sử",
    deviceOnly: "Không gửi video lên máy chủ",
    fullScreen: "Toàn màn hình",
    exitFullScreen: "Thoát toàn màn hình",
  },
  en: {
    liveAria: "Pose-based badminton technique analysis",
    controlKicker: "Pose Lite · singles beta",
    openCamera: "Open camera",
    opening: "Starting…",
    demo: "View demo",
    autoCourt: "Detect court",
    findingCourt: "Detecting…",
    manualCourt: "Manual corners",
    stopCamera: "Stop camera",
    finish: "Finish & view report",
    newSession: "New session",
    steps: ["Open camera", "Calibrate court", "Analyze session"],
    readiness: "Readiness status",
    camera: "Camera",
    cameraOn: "Active",
    cameraOff: "Not started",
    players: "Players",
    court: "Court frame",
    courtReady: "Calibrated",
    courtPending: "Not calibrated",
    engine: "Pose Lite",
    engineReady: "Ready",
    enginePending: "Checking",
    cameraTitle: "Frame the full bodies of both players",
    cameraCopy: "Use landscape when possible, keep the phone stable and include the players from head to toe.",
    directCamera: "Start live camera",
    cameraOffBadge: "CAMERA OFF",
    latest: "Latest event",
    demoNotice: "DEMO · Interface sample data, not captured from camera.",
    liveNotice: "LIVE · Pose analysis only; no shuttle trajectory, landing point or km/h.",
    movements: "Movements",
    strongSmash: "High-evidence smash",
    evidence: "Pose match level",
    movement: "Movement",
    liveFeed: "Live event feed",
    noEvents: "No movement yet. Keep the full body in frame and perform a stroke.",
    askCoach: "Ask Coach",
    openReport: "Open full report",
    reportKicker: "Current report",
    reportEmpty: "No session to analyze yet",
    reportEmptyCopy: "Open the camera to record a new session or load sample data to preview the report.",
    backLive: "Back to Live",
    classification: "Stroke classification",
    classificationCopy: "Hierarchical labels with an unresolved state",
    classificationNote: "Open mode does not force Clear or Drop without trajectory. Select a drill to apply training context.",
    heatmap: "Movement heatmap",
    playerPosition: "Player position",
    hasData: "DATA READY",
    needsCourt: "CALIBRATE COURT",
    log: "Analysis log",
    everyMovement: "Every movement in this session",
    event: "events",
    sessionInsight: "Session insight",
    notEnough: "Not enough data",
    finishHint: "Finish after a few movements to save an on-device session report.",
    averageEvidence: "Average pose match",
    localMemory: "Device storage",
    recentSessions: "12 recent sessions",
    noHistory: "No session has been saved on this device.",
    limitations: "Pose Lite estimates stroke groups from pose sequences. It cannot see the shuttle or racket, measure km/h, or conclude rally tactics.",
    diagnostics: "Device diagnostics",
    diagnosticsTitle: "On-device processing system",
    diagnosticsCopy: "Technical information lives here so athletes can stay focused during Live mode.",
    classificationEngine: "Classifier",
    storage: "History",
    deviceOnly: "Video never leaves the device",
    fullScreen: "Full screen",
    exitFullScreen: "Exit full screen",
  },
} as const;

type RallyAnalyzerProps = {
  view: StudioView;
  language: StudioLanguage;
  onNavigate: (view: StudioView) => void;
  onAskCoach: (prompt: string) => void;
};

function isSessionHistory(value: unknown): value is SessionHistory {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SessionHistory>;
  return typeof candidate.id === "string"
    && typeof candidate.createdAt === "string"
    && Array.isArray(candidate.strokes)
    && candidate.strokes.every((stroke) => typeof stroke?.evidence === "number")
    && Boolean(candidate.paths?.A && candidate.paths?.B);
}

function createSummary(
  strokes: StrokeEvent[],
  calibrated: boolean,
  language: StudioLanguage,
): SessionSummary {
  const averageEvidence = strokes.length
    ? Math.round(strokes.reduce((total, stroke) => total + stroke.evidence, 0) / strokes.length)
    : 0;
  const counts = (language === "vi" ? CLASSIFICATIONS : EN_CLASSIFICATIONS).map((item) => ({
    ...item,
    count: strokes.filter((stroke) => stroke.strokeType === item.type).length,
  })).sort((left, right) => right.count - left.count);
  const dominant = counts[0];
  const uncertain = strokes.filter((stroke) => stroke.certainty !== "likely").length;

  return {
    headline: language === "vi"
      ? `${strokes.length} động tác vung tay được ghi nhận`
      : `${strokes.length} swing movements recorded`,
    insight: strokes.length
      ? language === "vi"
        ? `${dominant.label} xuất hiện nhiều nhất (${dominant.count}). ${uncertain} sự kiện cần xem lại vì camera chưa theo dõi quả cầu.${calibrated ? " Heatmap di chuyển dùng khung sân đã căn." : " Hãy căn bốn góc sân trước khi dùng số mét di chuyển."}`
        : `${dominant.label} appears most often (${dominant.count}). Review ${uncertain} events because the shuttle is not tracked.${calibrated ? " Movement uses the calibrated court frame." : " Calibrate four court corners before using movement distance."}`
      : language === "vi" ? "Chưa có đủ chuyển động để tạo nhận xét." : "Not enough movement to create an insight.",
    averageEvidence,
  };
}

function drawPoses(
  canvas: HTMLCanvasElement,
  poses: Array<{ player: PlayerId; landmarks: PoseLandmark[] }>,
  connections: Connection[],
) {
  const context = canvas.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.lineCap = "round";
  context.lineJoin = "round";

  poses.forEach(({ player, landmarks }) => {
    context.strokeStyle = PLAYER_COLOR[player];
    context.lineWidth = Math.max(2, canvas.width / 480);
    context.shadowColor = PLAYER_COLOR[player];
    context.shadowBlur = 8;
    connections.forEach((connection) => {
      const start = landmarks[connection.start];
      const end = landmarks[connection.end];
      if (!start || !end || (start.visibility ?? 1) < 0.42 || (end.visibility ?? 1) < 0.42) return;
      context.beginPath();
      context.moveTo(start.x * canvas.width, start.y * canvas.height);
      context.lineTo(end.x * canvas.width, end.y * canvas.height);
      context.stroke();
    });
    context.shadowBlur = 0;
    const foot = poseFootPoint(landmarks);
    context.beginPath();
    context.fillStyle = PLAYER_COLOR[player];
    context.arc(foot.x * canvas.width, foot.y * canvas.height, 7, 0, Math.PI * 2);
    context.fill();
  });
}

function CourtHeatmap({ paths }: { paths: Record<PlayerId, CourtPoint[]> }) {
  const toX = (point: CourtPoint) => 10 + point.x * 80;
  const toY = (point: CourtPoint) => 10 + point.y * 200;
  const polyline = (points: CourtPoint[]) => points.map((point) => `${toX(point)},${toY(point)}`).join(" ");

  return (
    <svg viewBox="0 0 100 220" className={styles.courtSvg} role="img" aria-label="Heatmap vị trí hai vận động viên">
      <defs>
        <radialGradient id="heat-player-a">
          <stop offset="0" stopColor="#5cffca" stopOpacity=".65" />
          <stop offset="1" stopColor="#5cffca" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="heat-player-b">
          <stop offset="0" stopColor="#ffcf5c" stopOpacity=".58" />
          <stop offset="1" stopColor="#ffcf5c" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect x="10" y="10" width="80" height="200" rx="2" className={styles.courtBase} />
      <path d="M10 110h80M10 76h80M10 144h80M50 10v66M50 144v66M18 10v200M82 10v200" className={styles.courtLines} />
      {paths.A.slice(-40).map((point, index) => (
        <circle key={`a-${index}`} cx={toX(point)} cy={toY(point)} r="10" fill="url(#heat-player-a)" />
      ))}
      {paths.B.slice(-40).map((point, index) => (
        <circle key={`b-${index}`} cx={toX(point)} cy={toY(point)} r="10" fill="url(#heat-player-b)" />
      ))}
      {paths.A.length > 1 ? <polyline points={polyline(paths.A)} className={styles.playerPathA} /> : null}
      {paths.B.length > 1 ? <polyline points={polyline(paths.B)} className={styles.playerPathB} /> : null}
      <text x="50" y="108" textAnchor="middle" className={styles.netLabel}>LƯỚI</text>
      <text x="14" y="204" className={styles.playerLabel}>A · GẦN</text>
      <text x="14" y="20" className={styles.playerLabel}>B · XA</text>
    </svg>
  );
}

function StatusNode({ label, value, detail, tone = "ready" }: {
  label: string;
  value: string;
  detail: string;
  tone?: "ready" | "pending";
}) {
  return (
    <article className={`${styles.statusNode} ${styles[tone]}`}>
      <span><i />{label}</span>
      <strong>{value}</strong>
      <small>{detail}</small>
    </article>
  );
}

export default function RallyAnalyzer({ view, language, onNavigate, onAskCoach }: RallyAnalyzerProps) {
  const [status, setStatus] = useState<AnalyzerStatus>("idle");
  const [recording, setRecording] = useState(false);
  const [dataSource, setDataSource] = useState<DataSource>("none");
  const [poseCount, setPoseCount] = useState(0);
  const [currentStroke, setCurrentStroke] = useState("Đang chờ động tác vung tay");
  const [strokes, setStrokes] = useState<StrokeEvent[]>([]);
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [movement, setMovement] = useState<Record<PlayerId, number>>({ A: 0, B: 0 });
  const [paths, setPaths] = useState<Record<PlayerId, CourtPoint[]>>({ A: [], B: [] });
  const [history, setHistory] = useState<SessionHistory[]>([]);
  const [storageStatus, setStorageStatus] = useState<StorageStatus>("checking");
  const [workerStatus, setWorkerStatus] = useState<WorkerStatus>("checking");
  const [drillMode, setDrillMode] = useState<DrillMode>("open");
  const [handPreferences, setHandPreferences] = useState<Record<PlayerId, PreferredHand>>({
    A: "auto",
    B: "auto",
  });
  const [errorMessage, setErrorMessage] = useState("");
  const [corners, setCorners] = useState<CourtPoint[]>(DEFAULT_COURT_CORNERS);
  const [calibrationState, setCalibrationState] = useState<CalibrationState>("default");
  const [previousCorners, setPreviousCorners] = useState<CourtPoint[]>(DEFAULT_COURT_CORNERS);
  const [calibrationConfidence, setCalibrationConfidence] = useState<number | null>(null);
  const [calibrationDiagnostics, setCalibrationDiagnostics] = useState("");
  const [calibrationMethod, setCalibrationMethod] = useState<CalibrationMethod>(null);
  const [draggingCorner, setDraggingCorner] = useState<number | null>(null);
  const [videoGeometry, setVideoGeometry] = useState<VideoGeometry | null>(null);
  const [focusMode, setFocusMode] = useState(false);
  const ui = UI_COPY[language];

  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const landmarkerRef = useRef<PoseLandmarker | null>(null);
  const connectionsRef = useRef<Connection[]>([]);
  const animationRef = useRef<number | null>(null);
  const runningRef = useRef(false);
  const recordingRef = useRef(false);
  const lastVideoTimeRef = useRef(-1);
  const mapperRef = useRef(createCourtMapper(DEFAULT_COURT_CORNERS));
  const calibratedRef = useRef(false);
  const memoriesRef = useRef<Record<PlayerId, PoseFrameMemory | null>>({ A: null, B: null });
  const samplesRef = useRef<Record<PlayerId, PoseLiteSample[]>>({ A: [], B: [] });
  const candidatesRef = useRef<Record<PlayerId, SwingCandidate | null>>({ A: null, B: null });
  const lastContactRef = useRef<Record<PlayerId, number>>({ A: -10_000, B: -10_000 });
  const nextStrokeRef = useRef(1);
  const strokesRef = useRef<StrokeEvent[]>([]);
  const pathsRef = useRef<Record<PlayerId, CourtPoint[]>>({ A: [], B: [] });
  const movementRef = useRef<Record<PlayerId, number>>({ A: 0, B: 0 });
  const lastPathSampleRef = useRef<Record<PlayerId, number>>({ A: 0, B: 0 });
  const classifierWorkerRef = useRef<Worker | null>(null);
  const classifierResolversRef = useRef(new Map<string, (result: PoseLiteResult) => void>());
  const workerInitializedRef = useRef(false);
  const workerFrameBusyRef = useRef(false);
  const workerInitResolverRef = useRef<{
    resolve: () => void;
    reject: (error: Error) => void;
  } | null>(null);
  const processFrameRef = useRef<(poses: VisionWorkerPose[], timestamp: number) => void>(() => undefined);
  const trackingStateRef = useRef<PlayerTrackingState>(resetPlayerTracking());
  const drillModeRef = useRef<DrillMode>("open");
  const handPreferencesRef = useRef<Record<PlayerId, PreferredHand>>({ A: "auto", B: "auto" });
  const pendingClassificationsRef = useRef(new Set<Promise<void>>());
  const sessionGenerationRef = useRef(0);
  const snapshotCalibratedRef = useRef(false);
  const draggingCornerRef = useRef<number | null>(null);
  const draggingPointerRef = useRef<number | null>(null);

  useEffect(() => {
    recordingRef.current = recording;
  }, [recording]);

  useEffect(() => {
    drillModeRef.current = drillMode;
  }, [drillMode]);

  useEffect(() => {
    handPreferencesRef.current = handPreferences;
    memoriesRef.current = { A: null, B: null };
  }, [handPreferences]);

  useEffect(() => {
    if (!focusMode) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.classList.add("smashlab-focus");
    return () => {
      document.body.style.overflow = previousOverflow;
      document.documentElement.classList.remove("smashlab-focus");
    };
  }, [focusMode]);

  useEffect(() => {
    mapperRef.current = createCourtMapper(corners);
  }, [corners]);

  useEffect(() => {
    if (typeof Worker === "undefined") return;
    const worker = new Worker(new URL("../workers/vision-worker.ts", import.meta.url));
    const resolvers = classifierResolversRef.current;
    classifierWorkerRef.current = worker;
    worker.onmessage = (event: MessageEvent<VisionWorkerOutgoing>) => {
      if (event.data.type === "ready") {
        setWorkerStatus("ready");
        return;
      }
      if (event.data.type === "initialized") {
        connectionsRef.current = event.data.connections;
        workerInitializedRef.current = true;
        workerInitResolverRef.current?.resolve();
        workerInitResolverRef.current = null;
        setWorkerStatus("ready");
        return;
      }
      if (event.data.type === "frame") {
        workerFrameBusyRef.current = false;
        processFrameRef.current(event.data.poses, event.data.timestamp);
        return;
      }
      if (event.data.type === "error") {
        workerFrameBusyRef.current = false;
        if (event.data.stage === "initialize") {
          workerInitializedRef.current = false;
          workerInitResolverRef.current?.reject(new Error(event.data.message));
          workerInitResolverRef.current = null;
          setWorkerStatus("fallback");
        }
        return;
      }
      if (event.data.type !== "result") return;
      const resolve = resolvers.get(event.data.requestId);
      if (resolve) {
        resolvers.delete(event.data.requestId);
        resolve(event.data.result);
      }
    };
    worker.onerror = () => {
      workerFrameBusyRef.current = false;
      workerInitializedRef.current = false;
      workerInitResolverRef.current?.reject(new Error("Vision worker failed"));
      workerInitResolverRef.current = null;
      setWorkerStatus("fallback");
    };
    worker.postMessage({ type: "ping" });
    return () => {
      worker.terminate();
      classifierWorkerRef.current = null;
      workerInitializedRef.current = false;
      resolvers.clear();
    };
  }, []);

  useEffect(() => {
    const calibrationTimer = window.setTimeout(() => {
      try {
        const saved = window.localStorage.getItem(CALIBRATION_KEY);
        if (saved) {
          const parsed = JSON.parse(saved) as { corners?: CourtPoint[] };
          if (parsed.corners && validateCourtCorners(parsed.corners)) {
            setCorners(parsed.corners);
            mapperRef.current = createCourtMapper(parsed.corners);
            calibratedRef.current = true;
            setCalibrationState("calibrated");
          }
        }
      } catch {
        window.localStorage.removeItem(CALIBRATION_KEY);
      }
    }, 0);

    void (async () => {
      try {
        const stored = await readRecentRallies<SessionHistory>(12);
        setHistory(stored.filter(isSessionHistory));
        setStorageStatus("indexeddb");
      } catch {
        const fallback = window.localStorage.getItem(HISTORY_FALLBACK_KEY);
        const parsed = fallback ? JSON.parse(fallback) as unknown[] : [];
        setHistory(parsed.filter(isSessionHistory).slice(0, 12));
        setStorageStatus("localstorage");
      }
    })();
    return () => window.clearTimeout(calibrationTimer);
  }, []);

  useEffect(() => {
    if (status !== "live") return;
    const stage = stageRef.current;
    const video = videoRef.current;
    if (!stage || !video) return;
    const updateGeometry = () => setVideoGeometry({
      sourceWidth: video.videoWidth || stage.clientWidth,
      sourceHeight: video.videoHeight || stage.clientHeight,
      stageWidth: stage.clientWidth,
      stageHeight: stage.clientHeight,
    });
    updateGeometry();
    const observer = new ResizeObserver(updateGeometry);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [status]);

  useEffect(() => {
    const calibratedForSnapshot = snapshotCalibratedRef.current;
    publishAnalysisSnapshot({
      source: dataSource,
      capturedAt: new Date().toISOString(),
      calibrated: calibratedForSnapshot,
      strokes: strokes.map((stroke) => ({
        index: stroke.index,
        hitter: stroke.hitter,
        strokeType: stroke.strokeType,
        label: stroke.label,
        evidence: stroke.evidence,
        certainty: stroke.certainty,
        swingIntensity: stroke.swingIntensity,
        postureScore: stroke.postureScore,
        reason: stroke.reason,
        family: stroke.family,
        position: calibratedForSnapshot ? stroke.position : undefined,
      })),
      movement: { ...movementRef.current },
      summary,
    });
  }, [calibrationState, dataSource, strokes, summary]);

  const classifySamples = useCallback((samples: PoseLiteSample[]) => {
    const worker = classifierWorkerRef.current;
    if (!worker || workerStatus === "fallback") {
      return Promise.resolve(classifyPoseWindow(samples, { drillMode: drillModeRef.current }));
    }
    return new Promise<PoseLiteResult>((resolve) => {
      const requestId = crypto.randomUUID();
      classifierResolversRef.current.set(requestId, resolve);
      worker.postMessage({
        type: "analyze",
        requestId,
        samples,
        drillMode: drillModeRef.current,
      });
    });
  }, [workerStatus]);

  const saveHistory = useCallback((item: SessionHistory) => {
    const optimistic = [item, ...history.filter((entry) => entry.id !== item.id)].slice(0, 12);
    setHistory(optimistic);
    void saveRally(item, 12).then((saved) => {
      setHistory(saved.filter(isSessionHistory));
      setStorageStatus("indexeddb");
    }).catch(() => {
      window.localStorage.setItem(HISTORY_FALLBACK_KEY, JSON.stringify(optimistic));
      setStorageStatus("localstorage");
    });
  }, [history]);

  const resetSession = useCallback((source: DataSource = "none") => {
    sessionGenerationRef.current += 1;
    pendingClassificationsRef.current.clear();
    strokesRef.current = [];
    pathsRef.current = { A: [], B: [] };
    movementRef.current = { A: 0, B: 0 };
    samplesRef.current = { A: [], B: [] };
    candidatesRef.current = { A: null, B: null };
    memoriesRef.current = { A: null, B: null };
    trackingStateRef.current = resetPlayerTracking();
    lastContactRef.current = { A: -10_000, B: -10_000 };
    lastPathSampleRef.current = { A: 0, B: 0 };
    nextStrokeRef.current = 1;
    snapshotCalibratedRef.current = source === "live" && calibratedRef.current;
    setStrokes([]);
    setPaths({ A: [], B: [] });
    setMovement({ A: 0, B: 0 });
    setSummary(null);
    setCurrentStroke("Đang chờ động tác vung tay");
    setDataSource(source);
  }, []);

  const samplePlayerPath = useCallback((player: PlayerId, point: CourtPoint, now: number) => {
    if (!calibratedRef.current || now - lastPathSampleRef.current[player] < 220) return;
    lastPathSampleRef.current[player] = now;
    const previous = pathsRef.current[player].at(-1);
    if (previous) {
      const delta = courtDistance(previous, point);
      if (delta < 2.2) movementRef.current[player] += delta;
    }
    const next = [...pathsRef.current[player], point].slice(-100);
    pathsRef.current = { ...pathsRef.current, [player]: next };
    setPaths({ ...pathsRef.current });
    setMovement({ ...movementRef.current });
  }, []);

  const registerStroke = useCallback((
    player: PlayerId,
    samples: PoseLiteSample[],
    position: CourtPoint,
  ) => {
    const index = nextStrokeRef.current;
    const generation = sessionGenerationRef.current;
    nextStrokeRef.current += 1;
    setCurrentStroke(`Đang phân tích chuyển động của VĐV ${player}…`);
    const pending = classifySamples(samples).then((result) => {
      if (generation !== sessionGenerationRef.current) return;
      const event: StrokeEvent = {
        ...result,
        index,
        hitter: player,
        position,
        recordedAt: new Date().toISOString(),
      };
      const next = [...strokesRef.current, event].sort((left, right) => left.index - right.index);
      strokesRef.current = next;
      setStrokes(next);
      setCurrentStroke(`VĐV ${player} · ${result.label} · ${result.evidence}/100 bằng chứng`);
    });
    pendingClassificationsRef.current.add(pending);
    void pending.finally(() => pendingClassificationsRef.current.delete(pending));
  }, [classifySamples]);

  const processDetectedPoses = useCallback((poses: DetectedPose[], now: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const tracked = assignStablePlayerIds(poses, trackingStateRef.current, now);
    trackingStateRef.current = tracked.state;
    setPoseCount(tracked.assignments.length);
    drawPoses(canvas, tracked.assignments, connectionsRef.current);

    tracked.assignments.forEach(({ player, landmarks, worldLandmarks }) => {
      const analysis = analyzePose(
        landmarks,
        now,
        memoriesRef.current[player],
        lastContactRef.current[player],
        {
          preferredHand: handPreferencesRef.current[player],
          worldLandmarks,
        },
      );
      memoriesRef.current[player] = analysis.memory;
      const sourceFoot = poseFootPoint(landmarks);
      const courtPoint = mapperRef.current(sourceFoot);
      samplePlayerPath(player, courtPoint, now);

      const metrics = analysis.metrics;
      const sample: PoseLiteSample = {
        timestamp: now,
        wristSpeed: metrics.wristSpeed,
        armAngularSpeed: metrics.armAngularSpeed,
        elbowAngle: metrics.elbowAngle,
        shoulderAngle: metrics.shoulderAngle,
        contactHeight: metrics.contactHeight,
        bodyExtension: metrics.bodyExtension,
        wristAboveShoulder: metrics.wristAboveShoulder,
        visibility: metrics.confidence,
        trunkRotation: metrics.trunkRotation,
        kneeFlexion: metrics.kneeFlexion,
        handLocked: metrics.handLocked,
      };
      samplesRef.current[player] = [...samplesRef.current[player], sample].slice(-42);

      if (!recordingRef.current) return;
      const handReady = handPreferencesRef.current[player] !== "auto" || metrics.handLocked;
      const energy = metrics.wristSpeed + Math.min(metrics.armAngularSpeed / 480, 1.25);
      const canCollect = handReady
        && metrics.confidence > 52
        && metrics.wristSpeed > 0.32
        && metrics.armAngularSpeed > 30
        && now - lastContactRef.current[player] > 720;
      const candidate = candidatesRef.current[player];
      if (canCollect && !candidate) {
        candidatesRef.current[player] = {
          startedAt: now,
          peakAt: now,
          peakEnergy: energy,
          position: courtPoint,
        };
      } else if (canCollect && candidate && energy > candidate.peakEnergy) {
        candidatesRef.current[player] = {
          ...candidate,
          peakAt: now,
          peakEnergy: energy,
          position: courtPoint,
        };
      }

      const active = candidatesRef.current[player];
      if (!active) return;
      const age = now - active.startedAt;
      const speedDropped = now - active.peakAt > 90 && metrics.wristSpeed < 0.38;
      const timedOut = age > 560;
      if (age > 130 && (speedDropped || timedOut)) {
        candidatesRef.current[player] = null;
        const windowSamples = samplesRef.current[player]
          .filter((entry) => entry.timestamp >= active.startedAt - 340)
          .slice(-34);
        const valid = active.peakEnergy > 0.64 && windowSamples.length >= 5;
        if (valid && now - lastContactRef.current[player] > 820) {
          lastContactRef.current[player] = now;
          registerStroke(player, windowSamples, active.position);
        }
      }
    });
  }, [registerStroke, samplePlayerPath]);

  useEffect(() => {
    processFrameRef.current = processDetectedPoses;
  }, [processDetectedPoses]);

  const startDetectionLoop = useCallback(() => {
    function detectFrame() {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!runningRef.current || !video || !canvas) return;

      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.currentTime !== lastVideoTimeRef.current) {
        const now = video.currentTime > 0 ? video.currentTime * 1_000 : performance.now();
        const worker = classifierWorkerRef.current;
        if (worker && workerInitializedRef.current && !workerFrameBusyRef.current) {
          lastVideoTimeRef.current = video.currentTime;
          workerFrameBusyRef.current = true;
          const requestId = crypto.randomUUID();
          void createImageBitmap(video).then((frame) => {
            if (!runningRef.current || !classifierWorkerRef.current) {
              frame.close();
              workerFrameBusyRef.current = false;
              return;
            }
            classifierWorkerRef.current.postMessage(
              { type: "detect", requestId, frame, timestamp: now },
              [frame],
            );
          }).catch(() => {
            workerFrameBusyRef.current = false;
          });
        } else if (!workerInitializedRef.current && landmarkerRef.current) {
          lastVideoTimeRef.current = video.currentTime;
          const result = landmarkerRef.current.detectForVideo(video, now);
          processFrameRef.current(result.landmarks.map((landmarks, index) => ({
            landmarks,
            worldLandmarks: result.worldLandmarks[index],
          })), now);
        }
      }
      animationRef.current = requestAnimationFrame(detectFrame);
    }
    detectFrame();
  }, []);

  const initializeWorkerVision = useCallback(() => {
    if (workerInitializedRef.current) return Promise.resolve();
    const worker = classifierWorkerRef.current;
    if (!worker) return Promise.reject(new Error("Web Worker is unavailable"));
    setWorkerStatus("checking");
    return new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        workerInitResolverRef.current = null;
        reject(new Error("Vision Worker initialization timed out"));
      }, 15_000);
      workerInitResolverRef.current = {
        resolve: () => {
          window.clearTimeout(timeout);
          resolve();
        },
        reject: (error) => {
          window.clearTimeout(timeout);
          reject(error);
        },
      };
      worker.postMessage({ type: "initialize", wasmUrl: WASM_URL, modelUrl: MODEL_URL });
    });
  }, []);

  const stopCamera = useCallback(() => {
    runningRef.current = false;
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    landmarkerRef.current?.close();
    landmarkerRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    canvasRef.current?.getContext("2d")?.clearRect(
      0,
      0,
      canvasRef.current.width,
      canvasRef.current.height,
    );
    recordingRef.current = false;
    setRecording(false);
    setPoseCount(0);
    workerFrameBusyRef.current = false;
    setStatus("idle");
    setFocusMode(false);
  }, []);

  useEffect(() => stopCamera, [stopCamera]);

  const startCamera = useCallback(async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("error");
      setErrorMessage("Trình duyệt này không hỗ trợ camera trực tiếp.");
      return;
    }
    resetSession("live");
    setStatus("loading");
    setErrorMessage("");
    try {
      const workerVisionPromise = initializeWorkerVision()
        .then(() => true)
        .catch(() => false);
      let cameraTimedOut = false;
      const cameraPromise = navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            facingMode: { ideal: "environment" },
            width: { ideal: 1280 },
            height: { ideal: 720 },
            frameRate: { ideal: 30, min: 20 },
          },
        });
      void cameraPromise.then((lateStream) => {
        if (cameraTimedOut) lateStream.getTracks().forEach((track) => track.stop());
      }).catch(() => undefined);
      let cameraTimeout: number | undefined;
      const stream = await (async () => {
        try {
          return await Promise.race([
            cameraPromise,
            new Promise<never>((_, reject) => {
              cameraTimeout = window.setTimeout(() => {
                cameraTimedOut = true;
                reject(new DOMException("Camera permission timed out", "TimeoutError"));
              }, 12_000);
            }),
          ]);
        } finally {
          if (cameraTimeout !== undefined) window.clearTimeout(cameraTimeout);
        }
      })();
      streamRef.current = stream;
      const workerVisionReady = await workerVisionPromise;
      if (!workerVisionReady) {
        setWorkerStatus("fallback");
        const { FilesetResolver, PoseLandmarker } = await import("@mediapipe/tasks-vision");
        const vision = await FilesetResolver.forVisionTasks(WASM_URL);
        let landmarker: PoseLandmarker;
        try {
          landmarker = await PoseLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
            runningMode: "VIDEO",
            numPoses: 2,
            minPoseDetectionConfidence: 0.48,
            minPosePresenceConfidence: 0.48,
            minTrackingConfidence: 0.5,
          });
        } catch {
          landmarker = await PoseLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
            runningMode: "VIDEO",
            numPoses: 2,
            minPoseDetectionConfidence: 0.48,
            minPosePresenceConfidence: 0.48,
            minTrackingConfidence: 0.5,
          });
        }
        landmarkerRef.current = landmarker;
        connectionsRef.current = PoseLandmarker.POSE_CONNECTIONS;
      }
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas) throw new Error("Camera stage is unavailable");
      video.srcObject = stream;
      await video.play();
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;
      lastVideoTimeRef.current = -1;
      runningRef.current = true;
      recordingRef.current = true;
      setRecording(true);
      setStatus("live");
      startDetectionLoop();
    } catch (error) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      setStatus("error");
      setRecording(false);
      setDataSource("none");
      setErrorMessage(error instanceof DOMException && error.name === "NotAllowedError"
        ? "Bạn cần cho phép camera để phân tích trực tiếp."
        : error instanceof DOMException && error.name === "TimeoutError"
          ? "Camera chưa phản hồi. Hãy kiểm tra quyền camera của trình duyệt rồi thử lại."
        : "Không thể khởi động camera hoặc MediaPipe Pose Lite.");
    }
  }, [initializeWorkerVision, resetSession, startDetectionLoop]);

  const finishSession = useCallback(async () => {
    recordingRef.current = false;
    setRecording(false);
    await Promise.allSettled([...pendingClassificationsRef.current]);
    const completed = strokesRef.current;
    if (!completed.length) {
      setErrorMessage("Chưa ghi nhận được động tác rõ ràng. Hãy đứng trọn người trong khung hình và thử lại.");
      return;
    }
    const sessionSummary = createSummary(completed, calibratedRef.current, language);
    setSummary(sessionSummary);
    setErrorMessage("");
    saveHistory({
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      strokes: completed,
      summary: sessionSummary,
      movement: { ...movementRef.current },
      paths: { ...pathsRef.current },
      calibrated: calibratedRef.current,
    });
    onNavigate("sessions");
  }, [language, onNavigate, saveHistory]);

  const startNewSession = useCallback(() => {
    resetSession("live");
    recordingRef.current = true;
    setRecording(true);
    setErrorMessage("");
  }, [resetSession]);

  const runDemo = useCallback(() => {
    const demoStrokes: StrokeEvent[] = [
      { index: 1, hitter: "A", strokeType: "smash", label: "Smash", evidence: 74, certainty: "likely", swingIntensity: 91, postureScore: 84, reason: "Tiếp xúc trên đầu, tăng tốc tay mạnh và duỗi người rõ.", family: "overhead_attack", position: { x: .28, y: .82 }, recordedAt: new Date().toISOString() },
      { index: 2, hitter: "B", strokeType: "clear", label: "Có khả năng Clear / phông", evidence: 62, certainty: "possible", swingIntensity: 64, postureScore: 79, reason: "Cần thấy quỹ đạo cầu để xác nhận clear.", family: "overhead_control", position: { x: .72, y: .2 }, recordedAt: new Date().toISOString() },
      { index: 3, hitter: "A", strokeType: "drive", label: "Có khả năng Drive / tạt", evidence: 57, certainty: "possible", swingIntensity: 72, postureScore: 66, reason: "Cần thấy quỹ đạo cầu để xác nhận drive.", family: "lateral", position: { x: .68, y: .66 }, recordedAt: new Date().toISOString() },
      { index: 4, hitter: "B", strokeType: "drop_shot", label: "Có khả năng Drop shot", evidence: 59, certainty: "possible", swingIntensity: 46, postureScore: 73, reason: "Cần thấy điểm rơi để xác nhận drop shot.", family: "overhead_control", position: { x: .36, y: .28 }, recordedAt: new Date().toISOString() },
      { index: 5, hitter: "A", strokeType: "unknown", label: "Không chắc", evidence: 38, certainty: "unknown", swingIntensity: 41, postureScore: 52, reason: "Tư thế chưa đủ khác biệt để gán nhãn.", family: "unknown", position: { x: .22, y: .7 }, recordedAt: new Date().toISOString() },
    ];
    const demoPaths = {
      A: [{ x: .3, y: .84 }, { x: .45, y: .65 }, { x: .7, y: .72 }, { x: .25, y: .78 }],
      B: [{ x: .72, y: .18 }, { x: .55, y: .35 }, { x: .34, y: .25 }, { x: .65, y: .22 }],
    };
    strokesRef.current = demoStrokes;
    pathsRef.current = demoPaths;
    movementRef.current = { A: 4.8, B: 4.2 };
    snapshotCalibratedRef.current = true;
    setStrokes(demoStrokes);
    setPaths(demoPaths);
    setMovement({ ...movementRef.current });
    setSummary(createSummary(demoStrokes, true, language));
    setDataSource("demo");
    recordingRef.current = false;
    setRecording(false);
    setErrorMessage("");
    setCurrentStroke("Dữ liệu minh họa · không lấy từ camera");
  }, [language]);

  useEffect(() => {
    const handleDemoRequest = () => {
      runDemo();
      onNavigate("sessions");
    };
    window.addEventListener("smashlab:demo", handleDemoRequest);
    return () => window.removeEventListener("smashlab:demo", handleDemoRequest);
  }, [onNavigate, runDemo]);

  const beginManualCalibration = useCallback(() => {
    if (status !== "live") {
      setErrorMessage("Hãy mở camera trước khi căn bốn góc sân.");
      return;
    }
    if (calibrationState === "default" || calibrationState === "calibrated") {
      setPreviousCorners(corners.length === 4 ? corners : DEFAULT_COURT_CORNERS);
    }
    setCorners([]);
    setCalibrationConfidence(null);
    setCalibrationDiagnostics("");
    setCalibrationMethod("manual");
    setCalibrationState("manual");
    draggingCornerRef.current = null;
    draggingPointerRef.current = null;
    setDraggingCorner(null);
    recordingRef.current = false;
    setRecording(false);
    setErrorMessage("");
  }, [calibrationState, corners, status]);

  const autoCalibrateCourt = useCallback(async () => {
    const video = videoRef.current;
    if (status !== "live" || !video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
      setErrorMessage("Camera chưa có khung hình để tự tìm sân.");
      return;
    }
    if (calibrationState === "default" || calibrationState === "calibrated") {
      setPreviousCorners(corners.length === 4 ? corners : DEFAULT_COURT_CORNERS);
    }
    recordingRef.current = false;
    setRecording(false);
    setCorners([]);
    setCalibrationConfidence(null);
    setCalibrationDiagnostics("");
    setCalibrationMethod("auto");
    setCalibrationState("detecting");
    draggingCornerRef.current = null;
    draggingPointerRef.current = null;
    setDraggingCorner(null);
    setErrorMessage("");
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

    const detectedFrames: NonNullable<ReturnType<typeof detectCourtCornersFromVideo>>[] = [];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (attempt > 0) await new Promise<void>((resolve) => window.setTimeout(resolve, 90));
      const candidate = detectCourtCornersFromVideo(video);
      if (candidate) detectedFrames.push(candidate);
    }
    const detection = detectedFrames.reduce<typeof detectedFrames[number] | null>(
      (best, candidate) => !best || candidate.confidence > best.confidence ? candidate : best,
      null,
    );
    if (!detection) {
      setCalibrationState("failed");
      setErrorMessage("Không tìm đủ vạch sân. Hãy giữ camera cố định, nhìn trọn sân hoặc chọn căn tay.");
      return;
    }

    const normalized = normalizeCourtCorners([...detection.corners]);
    const averageDrift = detectedFrames.length > 1
      ? detectedFrames.reduce((total, candidate) => (
        total + averageCornerDistance(normalized, normalizeCourtCorners([...candidate.corners]))
      ), 0) / detectedFrames.length
      : 0.16;
    const stability = Math.max(0, Math.min(1, 1 - averageDrift / 0.12));
    const adjustedConfidence = detection.confidence * (0.72 + stability * 0.28);
    setCorners(normalized);
    setCalibrationConfidence(adjustedConfidence);
    setCalibrationDiagnostics(
      `Tìm thấy ở ${detectedFrames.length}/4 khung · độ ổn định ${Math.round(stability * 100)}% · ${detection.diagnostics}`,
    );
    setCalibrationState("review");
  }, [calibrationState, corners, status]);

  const sourcePointFromClient = useCallback((clientX: number, clientY: number) => {
    const stage = stageRef.current;
    const video = videoRef.current;
    if (!stage || !video) return null;
    const rectangle = stage.getBoundingClientRect();
    return stagePointToSource(
      {
        x: (clientX - rectangle.left) / rectangle.width,
        y: (clientY - rectangle.top) / rectangle.height,
      },
      video.videoWidth || rectangle.width,
      video.videoHeight || rectangle.height,
      rectangle.width,
      rectangle.height,
    );
  }, []);

  const captureCorner = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (calibrationState !== "manual") return;
    if (event.target instanceof Element && event.target.closest("[data-calibration-controls]")) return;
    const point = sourcePointFromClient(event.clientX, event.clientY);
    if (!point) return;
    const next = [...corners, point].slice(0, 4);
    if (next.length === 4) {
      setCorners(normalizeCourtCorners(next));
      setCalibrationState("review");
    } else {
      setCorners(next);
    }
  }, [calibrationState, corners, sourcePointFromClient]);

  const startCornerDrag = useCallback((index: number, event: ReactPointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    draggingCornerRef.current = index;
    draggingPointerRef.current = event.pointerId;
    setDraggingCorner(index);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Some mobile browsers omit pointer capture; window listeners below keep dragging active.
    }
  }, []);

  useEffect(() => {
    const moveActiveCorner = (event: PointerEvent) => {
      const index = draggingCornerRef.current;
      if (index === null || draggingPointerRef.current !== event.pointerId) return;
      event.preventDefault();
      const point = sourcePointFromClient(event.clientX, event.clientY);
      if (!point) return;
      setCorners((current) => current.map((corner, cornerIndex) => (
        cornerIndex === index ? point : corner
      )));
      setCalibrationConfidence(null);
      setCalibrationDiagnostics("Khung đã được chỉnh tay; kiểm tra lại bốn giao điểm trước khi dùng.");
    };
    const stopActiveCorner = (event: PointerEvent) => {
      if (draggingPointerRef.current !== event.pointerId) return;
      draggingCornerRef.current = null;
      draggingPointerRef.current = null;
      setDraggingCorner(null);
    };

    window.addEventListener("pointermove", moveActiveCorner, { passive: false });
    window.addEventListener("pointerup", stopActiveCorner);
    window.addEventListener("pointercancel", stopActiveCorner);
    return () => {
      window.removeEventListener("pointermove", moveActiveCorner);
      window.removeEventListener("pointerup", stopActiveCorner);
      window.removeEventListener("pointercancel", stopActiveCorner);
    };
  }, [sourcePointFromClient]);

  const confirmCalibration = useCallback(() => {
    if (!validateCourtCorners(corners)) {
      setErrorMessage("Khung sân chưa hợp lệ. Hãy giữ và kéo các điểm để hai góc xa nằm phía trên, hai góc gần nằm phía dưới.");
      return;
    }
    mapperRef.current = createCourtMapper(corners);
    calibratedRef.current = true;
    window.localStorage.setItem(CALIBRATION_KEY, JSON.stringify({ corners }));
    setCalibrationState("calibrated");
    setCalibrationConfidence(null);
    setCalibrationDiagnostics("");
    setCalibrationMethod(null);
    draggingCornerRef.current = null;
    draggingPointerRef.current = null;
    setDraggingCorner(null);
    resetSession("live");
    recordingRef.current = true;
    setRecording(true);
    setErrorMessage("");
  }, [corners, resetSession]);

  const cancelCalibration = useCallback(() => {
    setCorners(previousCorners);
    mapperRef.current = createCourtMapper(previousCorners);
    setCalibrationState(calibratedRef.current ? "calibrated" : "default");
    setCalibrationConfidence(null);
    setCalibrationDiagnostics("");
    setCalibrationMethod(null);
    draggingCornerRef.current = null;
    draggingPointerRef.current = null;
    setDraggingCorner(null);
    setErrorMessage("");
    if (status === "live") {
      recordingRef.current = true;
      setRecording(true);
    }
  }, [previousCorners, status]);

  const stageCorner = (point: CourtPoint) => {
    if (!videoGeometry) return point;
    return sourcePointToStage(
      point,
      videoGeometry.sourceWidth,
      videoGeometry.sourceHeight,
      videoGeometry.stageWidth,
      videoGeometry.stageHeight,
    );
  };

  const loadHistory = (item: SessionHistory) => {
    strokesRef.current = item.strokes;
    pathsRef.current = item.paths;
    movementRef.current = item.movement;
    snapshotCalibratedRef.current = item.calibrated;
    setStrokes(item.strokes);
    setPaths(item.paths);
    setMovement(item.movement);
    setSummary(item.summary);
    setDataSource("history");
    recordingRef.current = false;
    setRecording(false);
    setCurrentStroke("Đang xem phiên đã lưu trên thiết bị");
  };

  const averageEvidence = strokes.length
    ? Math.round(strokes.reduce((total, stroke) => total + stroke.evidence, 0) / strokes.length)
    : 0;
  const strongSmashes = strokes.filter((stroke) => stroke.strokeType === "smash" && stroke.certainty === "likely").length;
  const classificationCounts = (language === "vi" ? CLASSIFICATIONS : EN_CLASSIFICATIONS).map((item) => ({
    ...item,
    count: strokes.filter((stroke) => stroke.strokeType === item.type).length,
  }));
  const courtAssessment = assessCourtCorners(corners);
  const unstableAutoFrame = calibrationMethod === "auto"
    && calibrationConfidence !== null
    && calibrationConfidence < 0.68;
  const displayedCourtQuality = courtAssessment.valid
    ? courtAssessment.quality === "good" && !unstableAutoFrame ? "good" : "review"
    : "invalid";
  const calibrationWarnings = unstableAutoFrame
    ? ["Kết quả tự động chưa ổn định giữa các khung hình; nên kéo lại từng góc.", ...courtAssessment.warnings]
    : courtAssessment.warnings;
  const resetManualCalibration = useCallback(() => {
    setCorners([]);
    setCalibrationConfidence(null);
    setCalibrationDiagnostics("");
    setCalibrationMethod("manual");
    setCalibrationState("manual");
    draggingCornerRef.current = null;
    draggingPointerRef.current = null;
    setDraggingCorner(null);
    setErrorMessage("");
  }, []);

  const calibrated = calibrationState === "calibrated";
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(language === "vi" ? "vi-VN" : "en-GB", {
    dateStyle: "short",
    timeStyle: "short",
  }), [language]);
  const currentStep = status !== "live" ? 0 : calibrated ? 2 : 1;
  const hasReport = strokes.length > 0;
  const statusHeadline = recording
    ? language === "vi" ? "Đang phân tích trực tiếp trên thiết bị" : "Analyzing live on this device"
    : status === "loading"
      ? language === "vi" ? "Đang mở camera và tải Pose Lite…" : "Opening camera and loading Pose Lite…"
      : dataSource === "demo"
        ? language === "vi" ? "Đang xem dữ liệu minh họa" : "Viewing sample data"
        : dataSource === "history"
          ? language === "vi" ? "Đang xem phiên đã lưu" : "Viewing a saved session"
          : status === "live"
            ? language === "vi" ? "Camera đã sẵn sàng" : "Camera is ready"
            : language === "vi" ? "Sẵn sàng mở camera" : "Ready to open camera";

  return (
    <section className={styles.analyzer} aria-label={ui.liveAria}>
      <div className={styles.controlBar} id="live-studio" hidden={view !== "live"}>
        <div>
          <span className={styles.kicker}>{ui.controlKicker}</span>
          <strong>{statusHeadline}</strong>
        </div>
        <div className={styles.controlActions}>
          <button type="button" className={styles.ghostButton} onClick={() => { runDemo(); onNavigate("sessions"); }}><Sparkles />{ui.demo}</button>
          <button type="button" className={styles.ghostButton} onClick={() => void autoCalibrateCourt()} disabled={status !== "live" || calibrationState === "detecting"}>
            <ScanLine />{calibrationState === "detecting" ? ui.findingCourt : ui.autoCourt}
          </button>
          <button type="button" className={styles.ghostButton} onClick={beginManualCalibration} disabled={status !== "live" || calibrationState === "detecting"}>{ui.manualCourt}</button>
          {status === "live" ? (
            <button type="button" className={styles.ghostButton} onClick={stopCamera}>{ui.stopCamera}</button>
          ) : (
            <button type="button" className={styles.primaryButton} onClick={() => void startCamera()} disabled={status === "loading"}><Camera />{status === "loading" ? ui.opening : ui.openCamera}</button>
          )}
          {status === "live" ? (
            recording ? (
              <button type="button" className={styles.stopButton} onClick={() => void finishSession()}>{ui.finish}</button>
            ) : (
              <button type="button" className={styles.primaryButton} onClick={startNewSession}>{ui.newSession}</button>
            )
          ) : null}
        </div>
      </div>

      <ol className={styles.sessionSteps} hidden={view !== "live"} aria-label={language === "vi" ? "Các bước bắt đầu phiên" : "Session setup steps"}>
        {ui.steps.map((step, index) => (
          <li key={step} className={index === currentStep ? styles.currentStep : index < currentStep ? styles.completedStep : ""}>
            <span>{index < currentStep ? <Check /> : index + 1}</span>
            <strong>{step}</strong>
          </li>
        ))}
      </ol>

      <section className={styles.poseSetup} hidden={view !== "live"} aria-label={language === "vi" ? "Thiết lập nhận diện" : "Recognition setup"}>
        <div className={styles.setupIntro}>
          <span>{language === "vi" ? "NHẬN DIỆN ỔN ĐỊNH" : "STABLE RECOGNITION"}</span>
          <strong>{language === "vi" ? "Khóa ngữ cảnh trước khi tập" : "Lock context before training"}</strong>
          <small>{language === "vi" ? "Chọn bài tập và tay cầm vợt giúp giảm nhầm nhãn khi camera chưa thấy quả cầu." : "Drill and racket-hand context reduce ambiguity when the shuttle is not tracked."}</small>
        </div>
        <label>
          <span>{language === "vi" ? "Bài tập" : "Drill"}</span>
          <select value={drillMode} onChange={(event) => setDrillMode(event.target.value as DrillMode)}>
            <option value="open">{language === "vi" ? "Tự do · không đoán Clear/Drop" : "Open · do not guess Clear/Drop"}</option>
            <option value="smash">Smash</option>
            <option value="clear">Clear</option>
            <option value="drop_shot">Drop shot</option>
            <option value="drive">Drive</option>
          </select>
        </label>
        {(["A", "B"] as PlayerId[]).map((player) => (
          <label key={player}>
            <span>{language === "vi" ? `Tay vợt VĐV ${player}` : `Player ${player} hand`}</span>
            <select
              value={handPreferences[player]}
              onChange={(event) => setHandPreferences((current) => ({
                ...current,
                [player]: event.target.value as PreferredHand,
              }))}
            >
              <option value="auto">{language === "vi" ? "Tự nhận rồi khóa" : "Auto detect & lock"}</option>
              <option value="right">{language === "vi" ? "Tay phải" : "Right"}</option>
              <option value="left">{language === "vi" ? "Tay trái" : "Left"}</option>
            </select>
          </label>
        ))}
      </section>

      <section className={styles.readinessBar} hidden={view !== "live"} aria-label={ui.readiness}>
        <article className={status === "live" ? styles.readyItem : ""}><span>{status === "live" ? <Check /> : <Camera />}</span><div><small>{ui.camera}</small><strong>{status === "live" ? ui.cameraOn : ui.cameraOff}</strong></div></article>
        <article className={poseCount === 2 ? styles.readyItem : ""}><span>{poseCount === 2 ? <Check /> : <CircleDashed />}</span><div><small>{ui.players}</small><strong>{poseCount}/2</strong></div></article>
        <article className={calibrated ? styles.readyItem : ""}><span>{calibrated ? <Check /> : <ScanLine />}</span><div><small>{ui.court}</small><strong>{calibrated ? ui.courtReady : ui.courtPending}</strong></div></article>
        <article className={workerStatus !== "checking" ? styles.readyItem : ""}><span>{workerStatus !== "checking" ? <Check /> : <CircleDashed />}</span><div><small>{ui.engine}</small><strong>{workerStatus !== "checking" ? ui.engineReady : ui.enginePending}</strong></div></article>
      </section>

      <div className={styles.statusPanel} hidden={view !== "settings"}>
        <div className={styles.statusIntro}>
          <span className={styles.kicker}>{ui.diagnostics}</span>
          <strong>{ui.diagnosticsTitle}</strong>
          <p>{ui.diagnosticsCopy}</p>
        </div>
        <div className={styles.statusGrid}>
          <StatusNode label={ui.camera} value={status === "live" ? ui.cameraOn : ui.cameraOff} detail="WebRTC · rear camera" tone={status === "live" ? "ready" : "pending"} />
          <StatusNode label={ui.players} value={`${poseCount}/2`} detail="MediaPipe Pose Lite" tone={poseCount ? "ready" : "pending"} />
          <StatusNode label={ui.classificationEngine} value={workerStatus === "ready" ? "Web Worker" : language === "vi" ? "Trên thiết bị" : "On device"} detail="Temporal pose sequence" tone={workerStatus === "checking" ? "pending" : "ready"} />
          <StatusNode
            label={ui.court}
            value={calibrated ? ui.courtReady : calibrationState === "detecting" ? ui.findingCourt : calibrationState === "review" ? language === "vi" ? "Chờ xác nhận" : "Review frame" : ui.courtPending}
            detail={language === "vi" ? "Tự tìm + cho phép chỉnh tay" : "Automatic + manual adjustment"}
            tone={calibrated ? "ready" : "pending"}
          />
          <StatusNode label={ui.storage} value={storageStatus === "indexeddb" ? "IndexedDB" : storageStatus === "localstorage" ? "Local fallback" : ui.enginePending} detail={language === "vi" ? "Tối đa 12 phiên trên máy" : "Up to 12 on-device sessions"} tone={storageStatus === "checking" ? "pending" : "ready"} />
        </div>
      </div>

      <div className={`${styles.workspace} ${view === "live" ? styles.liveWorkspace : view === "sessions" ? styles.reportWorkspace : ""}`} hidden={view === "coach" || view === "settings"}>
        <div className={styles.liveColumn}>
          <div className={styles.captureSection} hidden={view !== "live"}>
          <div
            ref={stageRef}
            className={`${styles.videoStage} ${focusMode ? styles.focusStage : ""} ${calibrationState === "manual" ? styles.isCalibrating : ""} ${draggingCorner !== null ? styles.isDraggingCourt : ""}`}
            onPointerDown={captureCorner}
          >
            <video ref={videoRef} className={styles.video} playsInline muted />
            <canvas ref={canvasRef} className={styles.poseCanvas} />

            <div className={styles.videoStatusRow}>
              <span className={`${styles.liveBadge} ${status === "live" ? styles.liveOn : ""}`}><i />{status === "live" ? "LIVE" : ui.cameraOffBadge}</span>
              <span>{language === "vi" ? "ĐÁNH ĐƠN" : "SINGLES"}</span>
              <span>{language === "vi" ? "TRÊN THIẾT BỊ" : "ON DEVICE"}</span>
              <button type="button" className={styles.focusButton} onClick={(event) => { event.stopPropagation(); setFocusMode((current) => !current); }} aria-label={focusMode ? ui.exitFullScreen : ui.fullScreen}>
                {focusMode ? <Minimize2 /> : <Maximize2 />}
              </button>
            </div>

            {status !== "live" ? (
              <div className={styles.cameraEmpty}>
                <div className={styles.radar} aria-hidden="true">⌁</div>
                <h2>{ui.cameraTitle}</h2>
                <p>{ui.cameraCopy}</p>
                <button type="button" onClick={() => void startCamera()} disabled={status === "loading"}><Camera />{status === "loading" ? ui.opening : ui.directCamera}</button>
              </div>
            ) : null}

            {corners.length === 4 && status === "live" ? (
              <svg className={styles.calibrationOverlay} viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                <polygon points={corners.map((corner) => {
                  const point = stageCorner(corner);
                  return `${point.x * 100},${point.y * 100}`;
                }).join(" ")} />
              </svg>
            ) : null}

            {(["detecting", "manual", "review", "failed"] as CalibrationState[]).includes(calibrationState) && status === "live" ? (
              <div
                className={styles.calibrationPanel}
                data-calibration-controls
                onPointerDown={(event) => event.stopPropagation()}
                onPointerUp={(event) => event.stopPropagation()}
              >
                <span>{calibrationMethod === "manual" ? "Hiệu chuẩn thủ công" : "Hiệu chuẩn tự động"}</span>
                <strong>
                  {calibrationState === "detecting"
                    ? "Đang tìm các vạch sân…"
                    : calibrationState === "review"
                      ? calibrationMethod === "auto"
                        ? `Đã tìm thấy sân${calibrationConfidence === null ? "" : ` · ${Math.round(calibrationConfidence * 100)}% chất lượng khung`}`
                        : "Đã đặt đủ bốn góc"
                      : calibrationState === "failed"
                        ? "Không tự tìm đủ bốn vạch"
                        : `Chạm ${CORNER_LABELS[corners.length] ?? "đủ bốn góc"}`}
                </strong>
                <p>
                  {calibrationState === "review"
                    ? calibrationMethod === "auto"
                      ? `${calibrationDiagnostics || "Kiểm tra bốn góc trước khi dùng."} Giữ và kéo từng số nếu cần.`
                      : "Các góc đã được tự sắp xếp. Giữ và kéo từng số để đặt chính xác lên giao điểm vạch sân."
                    : "Chạm bốn góc theo thứ tự bất kỳ; ứng dụng sẽ tự sắp xếp lại."}
                </p>
                <div className={styles.cornerChecklist} aria-label="Trạng thái bốn góc sân">
                  {CORNER_LABELS.map((label, index) => (
                    <span key={label} className={corners[index] ? styles.cornerReady : ""}>
                      <b>{index + 1}</b>{label}
                    </span>
                  ))}
                </div>
                {calibrationState === "review" ? (
                  <div className={`${styles.calibrationQuality} ${styles[displayedCourtQuality]}`}>
                    <strong>{displayedCourtQuality === "good" ? "Khung hợp lý" : displayedCourtQuality === "review" ? "Nên kiểm tra lại" : "Khung chưa hợp lệ"}</strong>
                    <span>{courtAssessment.score}/100 kiểm tra hình học</span>
                    {calibrationWarnings.length ? (
                      <ul>{calibrationWarnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
                    ) : <p>Bốn góc có thứ tự, độ phủ và phối cảnh phù hợp để đo di chuyển.</p>}
                  </div>
                ) : null}
                <div className={styles.calibrationActions}>
                  {(calibrationState === "review" || (calibrationState === "manual" && corners.length === 4)) ? <button type="button" className={styles.confirmButton} onClick={confirmCalibration} disabled={!courtAssessment.valid}>Dùng khung này</button> : null}
                  {calibrationState === "review" || calibrationState === "failed" ? <button type="button" onClick={() => void autoCalibrateCourt()}>Tìm lại</button> : null}
                  {calibrationState !== "detecting" && calibrationState !== "manual" ? <button type="button" onClick={beginManualCalibration}>Căn tay</button> : null}
                  {calibrationState === "manual" && corners.length > 0 ? <button type="button" onClick={resetManualCalibration}>Căn lại</button> : null}
                  {calibrationState !== "detecting" ? <button type="button" onClick={cancelCalibration}>Hủy</button> : null}
                </div>
              </div>
            ) : null}

            {corners.map((corner, index) => {
              if (status !== "live" || (calibrationState !== "manual" && calibrationState !== "review")) return null;
              const point = stageCorner(corner);
              return (
                <button
                  type="button"
                  key={index}
                  className={`${styles.cornerPoint} ${draggingCorner === index ? styles.draggingPoint : ""}`}
                  style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
                  aria-label={`Kéo góc sân ${index + 1}`}
                  onClick={(event) => event.stopPropagation()}
                  onPointerDown={(event) => startCornerDrag(index, event)}
                >
                  {index + 1}
                </button>
              );
            })}

            <div className={styles.currentEvent} aria-live="polite">
              <span>{ui.latest}</span>
              <strong>{currentStroke}</strong>
            </div>
          </div>

          {errorMessage ? <p className={styles.errorMessage}>{errorMessage}</p> : null}
          {dataSource === "demo" ? <p className={styles.demoNotice}>{ui.demoNotice}</p> : null}
          {dataSource === "live" ? <p className={styles.liveNotice}>{ui.liveNotice}</p> : null}
          </div>

          <section className={styles.reportHero} hidden={view !== "sessions"}>
            <div>
              <span>{ui.reportKicker}</span>
              <strong>{summary?.headline ?? (hasReport ? `${strokes.length} ${ui.event}` : ui.reportEmpty)}</strong>
              <p>{summary?.insight ?? ui.reportEmptyCopy}</p>
            </div>
            <div className={styles.reportActions}>
              <button type="button" className={styles.ghostButton} onClick={() => onNavigate("live")}><Camera />{ui.backLive}</button>
              <button type="button" className={styles.primaryButton} disabled={!hasReport} onClick={() => onAskCoach(language === "vi" ? "Hãy phân tích phiên hiện tại và cho tôi 3 ưu tiên cải thiện cụ thể." : "Analyze this session and give me three concrete improvement priorities.")}><MessageCircleMore />{ui.askCoach}</button>
            </div>
          </section>

          <div className={styles.statsGrid}>
            <article><span>{ui.movements}</span><strong>{strokes.length}</strong><small>{language === "vi" ? "cửa sổ chuyển động" : "movement windows"}</small></article>
            <article><span>{ui.strongSmash}</span><strong>{strongSmashes}</strong><small>{language === "vi" ? "từ 70/100" : "from 70/100"}</small></article>
            <article><span>{ui.evidence}</span><strong>{averageEvidence ? averageEvidence >= 70 ? language === "vi" ? "Mạnh" : "Strong" : averageEvidence >= 50 ? language === "vi" ? "Vừa" : "Medium" : language === "vi" ? "Yếu" : "Low" : "—"}</strong><small>{averageEvidence ? `${averageEvidence}/100 · ${language === "vi" ? "không phải accuracy" : "not validated accuracy"}` : language === "vi" ? "chưa có dữ liệu" : "no data"}</small></article>
            <article>
              <span>{ui.movement}</span>
              <strong>{calibrated || dataSource === "demo" || dataSource === "history" ? `${(movement.A + movement.B).toFixed(1)}m` : "—"}</strong>
              <small>{dataSource === "demo" ? "dữ liệu minh họa" : dataSource === "history" ? "phiên đã lưu" : calibrated ? "khung sân đã căn" : "cần căn 4 góc"}</small>
            </article>
          </div>

          <section className={styles.liveFeed} hidden={view !== "live"}>
            <div className={styles.panelHeader}>
              <div><span>{ui.liveFeed}</span><strong>{strokes.length ? `${strokes.length} ${ui.event}` : ui.latest}</strong></div>
              {hasReport ? <button type="button" onClick={() => onNavigate("sessions")}>{ui.openReport}</button> : null}
            </div>
            <div className={styles.liveEventList}>
              {strokes.length ? strokes.slice(-3).reverse().map((stroke) => (
                <article key={`live-${stroke.index}-${stroke.hitter}`}>
                  <span className={styles.logIndex}>{String(stroke.index).padStart(2, "0")}</span>
                  <div><strong>{language === "vi" ? "VĐV" : "Player"} {stroke.hitter} · {stroke.label}</strong><span>{stroke.reason}</span></div>
                  <button type="button" onClick={() => onAskCoach(`${language === "vi" ? "Phân tích sự kiện" : "Analyze event"} ${stroke.index}: ${stroke.label}. ${stroke.reason}`)} aria-label={`${ui.askCoach}: ${stroke.label}`}><MessageCircleMore /></button>
                </article>
              )) : <p>{ui.noEvents}</p>}
            </div>
          </section>

          <section className={styles.classificationPanel} hidden={view !== "sessions"}>
            <div className={styles.panelHeader}>
              <div><span>{ui.classification}</span><strong>{ui.classificationCopy}</strong></div>
              <small>POSE LITE</small>
            </div>
            <div className={styles.classificationGrid}>
              {classificationCounts.map((item) => (
                <article key={item.type}><span>{item.label}</span><strong>{item.count}</strong></article>
              ))}
            </div>
            <p>{ui.classificationNote}</p>
          </section>

          <section className={styles.heatPanel} hidden={view !== "sessions"}>
            <div className={styles.panelHeader}>
              <div><span>{ui.playerPosition}</span><strong>{ui.heatmap}</strong></div>
              <small>{calibrated || dataSource === "demo" || dataSource === "history" ? ui.hasData : ui.needsCourt}</small>
            </div>
            <CourtHeatmap paths={paths} />
            <div className={styles.legend}><span><i className={styles.aDot} />VĐV A</span><span><i className={styles.bDot} />VĐV B</span></div>
          </section>
        </div>

        <aside className={styles.analysisColumn} hidden={view !== "sessions"}>
          <section className={styles.logPanel}>
            <div className={styles.panelHeader}>
              <div><span>{ui.log}</span><strong>{ui.everyMovement}</strong></div>
              <small>{strokes.length} {ui.event}</small>
            </div>
            <div className={styles.logList}>
              {strokes.length ? strokes.map((stroke) => (
                <article key={`${stroke.index}-${stroke.hitter}`}>
                  <span className={styles.logIndex}>{String(stroke.index).padStart(2, "0")}</span>
                  <div>
                    <strong>{language === "vi" ? "VĐV" : "Player"} {stroke.hitter} · {stroke.label}</strong>
                    <span>{stroke.reason}</span>
                  </div>
                  <div className={styles.logMeta}>
                    <strong>{stroke.evidence}/100</strong>
                    <span>{language === "vi" ? "vung" : "swing"} {stroke.swingIntensity}</span>
                    <button type="button" onClick={() => onAskCoach(`${language === "vi" ? "Phân tích sự kiện" : "Analyze event"} ${stroke.index}: ${stroke.label}. ${stroke.reason}`)}><MessageCircleMore />{ui.askCoach}</button>
                  </div>
                </article>
              )) : <p>{ui.noEvents}</p>}
            </div>
          </section>

          <section className={styles.insightPanel}>
            <span>{ui.sessionInsight}</span>
            <strong>{summary?.headline ?? ui.notEnough}</strong>
            <p>{summary?.insight ?? ui.finishHint}</p>
            <small>{ui.averageEvidence}: {summary?.averageEvidence ?? 0}/100 · {language === "vi" ? "không phải độ chính xác đã kiểm định" : "not validated accuracy"}</small>
            <button type="button" disabled={!hasReport} onClick={() => onAskCoach(language === "vi" ? "Dựa trên báo cáo hiện tại, hãy tạo một bài tập 20 phút để tôi cải thiện." : "Create a 20-minute practice plan based on this report.")}><MessageCircleMore />{ui.askCoach}</button>
          </section>

          <section className={styles.historyPanel}>
            <div className={styles.panelHeader}>
              <div><span>{ui.localMemory}</span><strong>{ui.recentSessions}</strong></div>
              <small>{storageStatus === "indexeddb" ? "INDEXEDDB" : "LOCAL"}</small>
            </div>
            <div className={styles.historyList}>
              {history.length ? history.map((item) => (
                <button type="button" key={item.id} onClick={() => loadHistory(item)}>
                  <div>
                    <strong>{item.summary.headline}</strong>
                    <span>{dateFormatter.format(new Date(item.createdAt))}</span>
                  </div>
                  <span>{item.summary.averageEvidence}/100</span>
                </button>
              )) : <p>{ui.noHistory}</p>}
            </div>
          </section>

          <p className={styles.disclaimer}>{ui.limitations}</p>
        </aside>
      </div>
    </section>
  );
}
