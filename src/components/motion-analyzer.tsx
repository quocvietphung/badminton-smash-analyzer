"use client";

import type { PoseLandmarker } from "@mediapipe/tasks-vision";
import {
  Activity,
  Armchair,
  Camera,
  CameraOff,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  Dumbbell,
  Footprints,
  Gauge,
  Hand,
  History,
  Maximize2,
  MessageCircleMore,
  Minimize2,
  RotateCcw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Target,
  TrendingUp,
  UserRoundCheck,
  X,
  Zap,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  assessMotionWindow,
  localizeMotionAssessment,
  type FootworkMode,
  type MotionAssessment,
  type MotionPhase,
  type TechniqueMode,
  type TrainingModule,
} from "@/lib/motion-technique";
import {
  assessFootworkWindow,
  FOOTWORK_CATALOG,
  localizeFootworkAssessment,
} from "@/lib/footwork-analysis";
import {
  analyzePose,
  initialMetrics,
  type PreferredHand,
  type PoseFrameMemory,
  type SmashMetrics,
} from "@/lib/pose-metrics";
import type { PoseLiteSample } from "@/lib/pose-lite-classifier";
import {
  advanceLockedPoseReacquisition,
  createLockReacquisitionState,
  createLockedTargetMemory,
  createMultiPoseTrackerState,
  hitTestTrackedPose,
  isTrackedPoseLockReady,
  updateLockedTargetMemory,
  updateMultiPoseTracker,
  type LockedTargetMemory,
  type PoseObservation,
  type TrackedPose,
} from "@/lib/multi-pose-tracker";
import {
  appearanceIdentityConflict,
  extractTorsoAppearance,
  horizontalPosition,
  shirtColorCss,
  type HorizontalPosition,
  type PoseAppearance,
  type ShirtColor,
} from "@/lib/pose-appearance";
import type {
  VisionWorkerOutgoing,
  VisionWorkerPose,
} from "@/lib/vision-worker-protocol";
import {
  readRecentMotionSessions,
  saveMotionSession,
} from "@/lib/device-storage";
import { publishAnalysisSnapshot } from "@/lib/analysis-session-store";
import type {
  AnalysisMovement,
  AnalysisSource,
  AnalysisSummary,
} from "@/lib/analysis-types";
import type { StudioLanguage, StudioView } from "@/lib/studio-types";
import styles from "./motion-analyzer.module.css";

type AnalyzerStatus = "idle" | "loading" | "live" | "error";
type WorkerStatus = "checking" | "ready" | "fallback";
type StorageStatus = "checking" | "indexeddb" | "localstorage";
type TargetStatus = "waiting" | "selecting" | "locked" | "lost";
type Connection = { start: number; end: number };
type SwingCandidate = { startedAt: number; peakAt: number; peakEnergy: number };
type AthleteOption = {
  trackId: number;
  shirtColor: ShirtColor;
  position: HorizontalPosition;
  lockConfidence: number;
  lockReady: boolean;
};
type AthleteColorMemory = {
  displayed: ShirtColor;
  candidate: ShirtColor;
  candidateFrames: number;
};
type FocusReticle = {
  x: number;
  y: number;
  token: number;
};
type MotionSession = {
  id: string;
  createdAt: string;
  trainingModule: TrainingModule;
  drillMode: TechniqueMode | FootworkMode;
  preferredHand: PreferredHand;
  movements: AnalysisMovement[];
  summary: AnalysisSummary;
};

type SessionDropdownOption<T extends string> = {
  value: T;
  label: string;
  group?: string;
};

const HISTORY_FALLBACK_KEY = "smashlab-motion-history-v1";
const WASM_URL = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm";
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const APPEARANCE_WIDTH = 320;
const APPEARANCE_HEIGHT = 180;

const TECHNIQUES: Array<{ value: TechniqueMode; labelEn: string; labelDe: string; labelVi: string; short: string }> = [
  { value: "open", labelEn: "Auto detect motion group", labelDe: "Bewegungsgruppe automatisch erkennen", labelVi: "Tự nhận nhóm động tác", short: "AUTO" },
  { value: "smash", labelEn: "Smash", labelDe: "Smash", labelVi: "Smash", short: "SM" },
  { value: "backhand", labelEn: "Backhand", labelDe: "Rückhand", labelVi: "Backhand", short: "BH" },
  { value: "clear", labelEn: "Clear", labelDe: "Clear", labelVi: "Clear / phông", short: "CL" },
  { value: "drop_shot", labelEn: "Drop shot", labelDe: "Drop", labelVi: "Drop shot", short: "DR" },
  { value: "drive", labelEn: "Drive", labelDe: "Drive", labelVi: "Drive / tạt", short: "DV" },
];

const FOOTWORK_GROUP_LABELS = {
  foundation: { vi: "Nền tảng BWF", en: "BWF foundations", de: "BWF-Grundlagen" },
  court_pattern: { vi: "Mẫu di chuyển", en: "Movement patterns", de: "Bewegungsmuster" },
  advanced: { vi: "Bật nhảy nâng cao", en: "Advanced jumps", de: "Fortgeschrittene Sprünge" },
} as const;

const SHIRT_COLOR_LABELS: Record<ShirtColor, Record<StudioLanguage, string>> = {
  red: { vi: "áo đỏ", en: "red shirt", de: "rotes Trikot" },
  orange: { vi: "áo cam", en: "orange shirt", de: "oranges Trikot" },
  yellow: { vi: "áo vàng", en: "yellow shirt", de: "gelbes Trikot" },
  green: { vi: "áo xanh lá", en: "green shirt", de: "grünes Trikot" },
  blue: { vi: "áo xanh dương", en: "blue shirt", de: "blaues Trikot" },
  purple: { vi: "áo tím", en: "purple shirt", de: "violettes Trikot" },
  pink: { vi: "áo hồng", en: "pink shirt", de: "rosa Trikot" },
  white: { vi: "áo trắng", en: "white shirt", de: "weißes Trikot" },
  gray: { vi: "áo xám", en: "gray shirt", de: "graues Trikot" },
  black: { vi: "áo đen", en: "black shirt", de: "schwarzes Trikot" },
  unknown: { vi: "màu áo chưa rõ", en: "shirt color unclear", de: "Trikotfarbe unklar" },
};

const POSITION_LABELS: Record<HorizontalPosition, Record<StudioLanguage, string>> = {
  left: { vi: "bên trái", en: "left", de: "links" },
  center: { vi: "ở giữa", en: "center", de: "mittig" },
  right: { vi: "bên phải", en: "right", de: "rechts" },
};

const PHASE_COPY: Record<MotionPhase, Record<StudioLanguage, string>> = {
  ready: { vi: "Sẵn sàng", en: "Ready", de: "Bereit" },
  loading: { vi: "Kéo vợt", en: "Loading", de: "Ausholen" },
  acceleration: { vi: "Tăng tốc", en: "Acceleration", de: "Beschleunigung" },
  contact_zone: { vi: "Vùng tiếp xúc", en: "Contact zone", de: "Treffzone" },
  follow_through: { vi: "Theo đà", en: "Follow-through", de: "Ausschwung" },
  start: { vi: "Khởi động", en: "Start", de: "Start" },
  approach: { vi: "Tiếp cận", en: "Approach", de: "Annäherung" },
  hit_balance: { vi: "Trụ & cân bằng", en: "Plant & balance", de: "Stand & Balance" },
  recovery: { vi: "Hồi vị", en: "Recovery", de: "Rückkehr" },
};

const UI = {
  vi: {
    module: "MOTION CAPTURE · ON-DEVICE",
    title: "Phòng lab kỹ thuật cá nhân",
    description: "Chọn một bài tập, đặt camera thấy trọn cơ thể và thực hiện từng lần lặp. SmashLab chuyên chấm chuỗi khớp, nhịp vung và khả năng hồi vị.",
    footworkTitle: "Phòng lab bộ pháp cá nhân",
    footworkDescription: "Phân tích split step, bước tiếp cận, trụ chân, tiếp đất và hồi vị từ chuỗi hông–gối–cổ chân.",
    camera: "Camera",
    cameraOff: "Chưa mở",
    cameraOn: "Đang hoạt động",
    athlete: "Vận động viên",
    athleteReady: "Đã khóa đúng mục tiêu",
    athleteMissing: "Chưa chọn mục tiêu",
    targetLabel: "Mục tiêu phân tích",
    targetSelect: "Bạn muốn khóa VĐV nào?",
    targetGuide: "Chạm trực tiếp vào người như lấy nét camera, hoặc chọn theo màu áo và vị trí.",
    changeTarget: "Đổi người",
    collapseTarget: "Thu gọn",
    confirmTargetTitle: "Xác nhận VĐV cần phân tích",
    confirmTargetCopy: "Hệ thống đối chiếu chuyển động, tỷ lệ cơ thể và vùng thân áo qua nhiều khung hình trước khi khóa. Nếu mất dấu, việc chấm sẽ dừng thay vì chuyển sang người khác.",
    confirmTarget: "Khóa VĐV đã xác minh",
    chooseAgain: "Chọn lại",
    targetUnavailable: "VĐV vừa chọn không còn trong khung. Hãy chạm chọn lại.",
    targetLocked: "VĐV đã xác minh",
    targetLost: "Đang mất dấu mục tiêu · hệ thống đã tạm dừng chấm",
    targetRecovering: "Đang xác minh lại mục tiêu",
    targetVerifying: "Đang xác minh",
    targetReady: "Sẵn sàng khóa",
    lockConfidence: "Độ tin cậy khóa",
    lockSignals: "Chuyển động · tỷ lệ cơ thể · vùng thân áo",
    lockSafety: "Không nhận diện khuôn mặt · không tự đổi sang người khác",
    targetRequired: "Hãy chọn VĐV cần phân tích trước khi ghi set",
    detectedPeople: "người trong khung",
    engine: "Motion Engine",
    engineReady: "Sẵn sàng",
    storage: "Lịch sử",
    setup: "Thiết lập bài tập",
    sessionSetup: "Thiết lập phiên",
    sessionSetupCopy: "Chọn mô-đun, bài tập và tay thuận trước khi mở camera.",
    sessionSummary: "Chạm để thay đổi bài tập và kiểm tra hệ thống",
    closeSessionSetup: "Đóng thiết lập phiên",
    moduleLabel: "Mô-đun phân tích",
    strokeModule: "Kỹ thuật vợt",
    footworkModule: "Bộ pháp",
    technique: "Kỹ thuật cần tập",
    footwork: "Bộ pháp cần tập",
    hand: "Tay cầm vợt",
    dominantSide: "Tay thuận / chân vợt",
    autoHand: "Tự nhận rồi khóa",
    right: "Tay phải",
    left: "Tay trái",
    openCamera: "Mở camera",
    opening: "Đang khởi động…",
    stopCamera: "Tắt camera",
    cameraSettings: "Thiết lập trong camera",
    options: "Tùy chọn",
    closeSettings: "Đóng thiết lập",
    startSet: "Bắt đầu ghi set",
    stopSet: "Kết thúc set",
    newSet: "Set mới",
    demo: "Xem dữ liệu mẫu",
    focus: "Toàn màn hình",
    exitFocus: "Thoát toàn màn hình",
    cameraTitle: "Đặt camera thấy trọn VĐV cần phân tích",
    cameraCopy: "Có thể có tối đa 4 người trong khung. Chọn theo màu áo/vị trí hoặc chạm đúng VĐV, rồi xác nhận trước khi khóa.",
    footworkCameraCopy: "Đặt máy ngang hông, thấy rõ hai bàn chân và chừa đủ khoảng trống cho toàn bộ hướng di chuyển.",
    liveWaiting: "Đang chờ một nhịp vung rõ",
    footworkWaiting: "Đang chờ một chu kỳ chân rõ",
    notRecording: "Camera đã sẵn sàng · bấm Bắt đầu ghi set",
    recording: "ĐANG GHI SET",
    demoNotice: "DỮ LIỆU MẪU · Chỉ minh họa bố cục báo cáo, không lấy từ camera.",
    privacy: "Video và mốc cơ thể được xử lý trên thiết bị",
    reps: "Lần lặp",
    score: "Điểm chuyển động",
    consistency: "Độ ổn định",
    capture: "Chất lượng khung hình",
    liveMetrics: "Chỉ số chuyển động trực tiếp",
    phase: "Pha hiện tại",
    elbow: "Góc khuỷu",
    shoulder: "Góc vai",
    rotation: "Xoay thân",
    knee: "Gập gối",
    extension: "Độ duỗi cơ thể",
    balance: "Thăng bằng",
    footSpeed: "Tốc độ chân tương đối",
    centerSpeed: "Chuyển động trọng tâm tương đối",
    stance: "Độ rộng trụ",
    landing: "Cân bằng tiếp đất",
    footworkCatalog: "Danh mục bộ pháp",
    catalogCopy: "Các thành phần và mẫu di chuyển được tổ chức theo chu kỳ Start → Approach → Hit → Recovery của BWF.",
    latest: "Lần lặp gần nhất",
    noReps: "Chưa có lần lặp. Hãy bấm ghi set rồi thực hiện động tác dứt khoát, có nhịp chuẩn bị và hồi vị.",
    noFootworkReps: "Chưa có chu kỳ chân. Hãy bấm ghi set, thực hiện bộ pháp rồi hồi vị cân bằng trước lần tiếp theo.",
    reportTitle: "Báo cáo Motion Capture",
    reportEmpty: "Chưa có set kỹ thuật để báo cáo",
    reportEmptyCopy: "Mở camera để ghi động tác thật hoặc dùng dữ liệu mẫu để xem cấu trúc báo cáo.",
    backLive: "Về phòng tập",
    askCoach: "Hỏi AI Coach",
    profile: "Hồ sơ kỹ thuật",
    phaseQuality: "Chất lượng 6 pha",
    strengths: "Điểm đang làm tốt",
    corrections: "Ưu tiên cần sửa",
    repetitions: "Nhật ký từng lần lặp",
    recent: "Phiên gần đây trên máy",
    noHistory: "Chưa có set nào được lưu trên thiết bị này.",
    diagnostics: "Hệ thống Motion Capture",
    diagnosticsCopy: "MediaPipe chạy trong Web Worker khi thiết bị hỗ trợ. Không tải video lên Vercel hoặc Azure.",
    limitation: "Motion Capture chấm hình thái chuyển động cơ thể. Hệ thống không nhìn thấy mặt vợt hoặc quả cầu, vì vậy không xác nhận chất lượng tiếp xúc, đường cầu hay tốc độ km/h.",
    footworkLimitation: "Bộ pháp được chấm từ mốc hông, gối và cổ chân theo thời gian. Hệ thống không biết vị trí thật trên sân, phản ứng với cầu hoặc khoảng cách mét nếu chưa hiệu chuẩn không gian.",
  },
  en: {
    module: "MOTION CAPTURE · ON-DEVICE",
    title: "Personal technique lab",
    description: "Choose a drill, frame the full body and perform one repetition at a time. SmashLab specializes in joint sequence, swing rhythm and recovery.",
    footworkTitle: "Personal footwork lab",
    footworkDescription: "Analyze split step, approach, planting, landing and recovery from hip–knee–ankle motion sequences.",
    camera: "Camera",
    cameraOff: "Not started",
    cameraOn: "Active",
    athlete: "Athlete",
    athleteReady: "Target locked",
    athleteMissing: "No target selected",
    targetLabel: "Analysis target",
    targetSelect: "Which athlete do you want to lock?",
    targetGuide: "Tap an athlete like camera focus, or choose by shirt color and position.",
    changeTarget: "Change athlete",
    collapseTarget: "Collapse",
    confirmTargetTitle: "Confirm analysis target",
    confirmTargetCopy: "Motion, body scale and torso appearance are verified across multiple frames before locking. If tracking is lost, scoring pauses instead of switching people.",
    confirmTarget: "Lock verified athlete",
    chooseAgain: "Choose again",
    targetUnavailable: "The selected athlete is no longer visible. Please tap again.",
    targetLocked: "Verified athlete",
    targetLost: "Target temporarily lost · scoring is paused",
    targetRecovering: "Re-verifying target",
    targetVerifying: "Verifying",
    targetReady: "Ready to lock",
    lockConfidence: "Lock confidence",
    lockSignals: "Motion · body scale · torso appearance",
    lockSafety: "No face recognition · never auto-switches people",
    targetRequired: "Select the athlete to analyze before recording",
    detectedPeople: "people in frame",
    engine: "Motion Engine",
    engineReady: "Ready",
    storage: "History",
    setup: "Drill setup",
    sessionSetup: "Session setup",
    sessionSetupCopy: "Choose the module, drill and dominant hand before opening the camera.",
    sessionSummary: "Tap to change the drill and check the system",
    closeSessionSetup: "Close session setup",
    moduleLabel: "Analysis module",
    strokeModule: "Racket technique",
    footworkModule: "Footwork",
    technique: "Technique drill",
    footwork: "Footwork drill",
    hand: "Racket hand",
    dominantSide: "Dominant / racket side",
    autoHand: "Auto detect and lock",
    right: "Right hand",
    left: "Left hand",
    openCamera: "Open camera",
    opening: "Starting…",
    stopCamera: "Stop camera",
    cameraSettings: "In-camera setup",
    options: "Options",
    closeSettings: "Close setup",
    startSet: "Start recording",
    stopSet: "Finish recording",
    newSet: "New recording",
    demo: "View sample data",
    focus: "Full screen",
    exitFocus: "Exit full screen",
    cameraTitle: "Frame the athlete you want to analyze",
    cameraCopy: "Up to four people may be visible. Choose by shirt color/position or tap the athlete, then confirm before locking.",
    footworkCameraCopy: "Place the camera at hip height, keep both feet visible and leave room for the complete movement path.",
    liveWaiting: "Waiting for a distinct swing",
    footworkWaiting: "Waiting for a distinct footwork cycle",
    notRecording: "Camera ready · tap Start recording",
    recording: "RECORDING",
    demoNotice: "SAMPLE DATA · Interface preview only, not captured from camera.",
    privacy: "Video and body landmarks stay on device",
    reps: "Repetitions",
    score: "Motion score",
    consistency: "Consistency",
    capture: "Capture quality",
    liveMetrics: "Live motion metrics",
    phase: "Current phase",
    elbow: "Elbow angle",
    shoulder: "Shoulder angle",
    rotation: "Trunk rotation",
    knee: "Knee flexion",
    extension: "Body extension",
    balance: "Balance",
    footSpeed: "Relative foot speed",
    centerSpeed: "Relative center movement",
    stance: "Stance width",
    landing: "Landing balance",
    footworkCatalog: "Footwork catalogue",
    catalogCopy: "Components and movement patterns follow the BWF Start → Approach → Hit → Recovery cycle.",
    latest: "Latest repetition",
    noReps: "No repetition yet. Start recording, then perform a distinct preparation, swing and recovery.",
    noFootworkReps: "No footwork cycle yet. Start recording, perform the drill, then recover before the next repetition.",
    reportTitle: "Motion Capture report",
    reportEmpty: "No recorded technique session",
    reportEmptyCopy: "Record a real set or load sample data to preview the report structure.",
    backLive: "Back to training",
    askCoach: "Ask AI Coach",
    profile: "Technique profile",
    phaseQuality: "Six-phase quality",
    strengths: "What is working",
    corrections: "Improvement priorities",
    repetitions: "Repetition log",
    recent: "Recent on-device sessions",
    noHistory: "No session has been saved on this device.",
    diagnostics: "Motion Capture system",
    diagnosticsCopy: "MediaPipe runs in a Web Worker when supported. Video is never uploaded to Vercel or Azure.",
    limitation: "Motion Capture scores body movement form. It cannot see the racket face or shuttle, so it does not confirm contact quality, trajectory or km/h.",
    footworkLimitation: "Footwork is scored from hip, knee and ankle landmarks over time. The system does not know real court position, shuttle reaction or metric distance without spatial calibration.",
  },
  de: {
    module: "MOTION CAPTURE · AUF DEM GERÄT",
    title: "Persönliches Techniklabor",
    description: "Wähle eine Übung, erfasse den ganzen Körper und führe jede Wiederholung einzeln aus. SmashLab bewertet Gelenkfolge, Schlagrhythmus und Rückkehr.",
    footworkTitle: "Persönliches Beinarbeitslabor",
    footworkDescription: "Analysiere Split Step, Annäherung, Stützphase, Landung und Rückkehr anhand der Hüft-Knie-Sprunggelenk-Kette.",
    camera: "Kamera",
    cameraOff: "Nicht gestartet",
    cameraOn: "Aktiv",
    athlete: "Athlet",
    athleteReady: "Ziel fixiert",
    athleteMissing: "Kein Ziel ausgewählt",
    targetLabel: "Analyseziel",
    targetSelect: "Welchen Athleten möchtest du fixieren?",
    targetGuide: "Tippe wie beim Kamerafokus auf eine Person oder wähle nach Trikotfarbe und Position.",
    changeTarget: "Person wechseln",
    collapseTarget: "Einklappen",
    confirmTargetTitle: "Analyseziel bestätigen",
    confirmTargetCopy: "Bewegung, Körpermaß und Rumpferscheinung werden über mehrere Bilder geprüft. Bei Zielverlust pausiert die Bewertung, anstatt die Person zu wechseln.",
    confirmTarget: "Geprüften Athleten fixieren",
    chooseAgain: "Neu wählen",
    targetUnavailable: "Der ausgewählte Athlet ist nicht mehr sichtbar. Bitte erneut antippen.",
    targetLocked: "Athlet verifiziert",
    targetLost: "Ziel kurzzeitig verloren · Bewertung pausiert",
    targetRecovering: "Ziel wird erneut geprüft",
    targetVerifying: "Wird geprüft",
    targetReady: "Bereit zum Fixieren",
    lockConfidence: "Fixierqualität",
    lockSignals: "Bewegung · Körpermaß · Rumpferscheinung",
    lockSafety: "Keine Gesichtserkennung · kein automatischer Personenwechsel",
    targetRequired: "Wähle vor der Aufnahme den zu analysierenden Athleten",
    detectedPeople: "Personen im Bild",
    engine: "Motion Engine",
    engineReady: "Bereit",
    storage: "Verlauf",
    setup: "Übung einrichten",
    sessionSetup: "Aufzeichnung einrichten",
    sessionSetupCopy: "Wähle Modul, Übung und dominante Hand, bevor du die Kamera öffnest.",
    sessionSummary: "Tippen, um Übung und Systemstatus zu ändern",
    closeSessionSetup: "Aufzeichnungseinstellungen schließen",
    moduleLabel: "Analysemodul",
    strokeModule: "Schlagtechnik",
    footworkModule: "Beinarbeit",
    technique: "Technikübung",
    footwork: "Beinarbeitsübung",
    hand: "Schlägerhand",
    dominantSide: "Dominante / Schlägerseite",
    autoHand: "Automatisch erkennen und fixieren",
    right: "Rechte Hand",
    left: "Linke Hand",
    openCamera: "Kamera öffnen",
    opening: "Wird gestartet…",
    stopCamera: "Kamera ausschalten",
    cameraSettings: "Kamera-Einstellungen",
    options: "Optionen",
    closeSettings: "Einstellungen schließen",
    startSet: "Aufzeichnung starten",
    stopSet: "Aufzeichnung beenden",
    newSet: "Neue Aufzeichnung",
    demo: "Beispieldaten ansehen",
    focus: "Vollbild",
    exitFocus: "Vollbild beenden",
    cameraTitle: "Erfasse den zu analysierenden Athleten vollständig",
    cameraCopy: "Bis zu vier Personen können sichtbar sein. Wähle nach Trikotfarbe/Position oder tippe auf den Athleten und bestätige danach die Fixierung.",
    footworkCameraCopy: "Platziere die Kamera auf Hüfthöhe, halte beide Füße sichtbar und lasse Platz für den gesamten Bewegungsweg.",
    liveWaiting: "Warte auf eine klare Schlagbewegung",
    footworkWaiting: "Warte auf einen klaren Beinarbeitszyklus",
    notRecording: "Kamera bereit · Aufzeichnung starten",
    recording: "AUFZEICHNUNG LÄUFT",
    demoNotice: "BEISPIELDATEN · Nur zur Vorschau des Berichts, nicht von der Kamera aufgenommen.",
    privacy: "Video und Körperlandmarken bleiben auf dem Gerät",
    reps: "Wiederholungen",
    score: "Bewegungsscore",
    consistency: "Konstanz",
    capture: "Aufnahmequalität",
    liveMetrics: "Live-Bewegungsdaten",
    phase: "Aktuelle Phase",
    elbow: "Ellbogenwinkel",
    shoulder: "Schulterwinkel",
    rotation: "Rumpfrotation",
    knee: "Kniebeugung",
    extension: "Körperstreckung",
    balance: "Balance",
    footSpeed: "Relative Fußgeschwindigkeit",
    centerSpeed: "Relative Schwerpunktbewegung",
    stance: "Standbreite",
    landing: "Landestabilität",
    footworkCatalog: "Beinarbeitskatalog",
    catalogCopy: "Komponenten und Bewegungsmuster folgen dem BWF-Zyklus Start → Annäherung → Schlag → Rückkehr.",
    latest: "Letzte Wiederholung",
    noReps: "Noch keine Wiederholung. Starte die Aufzeichnung und führe Vorbereitung, Schlag und Rückkehr deutlich aus.",
    noFootworkReps: "Noch kein Beinarbeitszyklus. Starte die Aufzeichnung, führe die Übung aus und kehre vor der nächsten Wiederholung stabil zurück.",
    reportTitle: "Motion-Capture-Bericht",
    reportEmpty: "Keine aufgezeichnete Technikeinheit",
    reportEmptyCopy: "Zeichne eine echte Einheit auf oder lade Beispieldaten, um die Berichtsstruktur anzusehen.",
    backLive: "Zurück zum Training",
    askCoach: "AI Coach fragen",
    profile: "Technikprofil",
    phaseQuality: "Qualität der sechs Phasen",
    strengths: "Was gut funktioniert",
    corrections: "Verbesserungsprioritäten",
    repetitions: "Wiederholungsprotokoll",
    recent: "Letzte Einheiten auf diesem Gerät",
    noHistory: "Auf diesem Gerät wurde noch keine Einheit gespeichert.",
    diagnostics: "Motion-Capture-System",
    diagnosticsCopy: "MediaPipe läuft, wenn unterstützt, in einem Web Worker. Video wird weder zu Vercel noch zu Azure hochgeladen.",
    limitation: "Motion Capture bewertet die Körperbewegung. Schlägerfläche und Federball sind nicht sichtbar; Kontaktqualität, Flugbahn und km/h werden daher nicht bestätigt.",
    footworkLimitation: "Beinarbeit wird über zeitliche Hüft-, Knie- und Sprunggelenk-Landmarken bewertet. Ohne räumliche Kalibrierung kennt das System weder echte Feldposition noch Reaktion auf den Ball oder metrische Distanzen.",
  },
} as const;

const SYSTEM_COPY: Record<StudioLanguage, {
  techniqueChart: string;
  bodyScaleUnit: string;
  poseModel: string;
  poseModelDetail: string;
  workerReady: string;
  workerFallback: string;
  motionFeatures: string;
  motionFeaturesDetail: string;
  sixPhaseAssessment: string;
  footworkEngine: string;
  footworkEngineDetail: string;
  fourPhaseCycle: string;
  racketHand: string;
  lockedPerSession: string;
  privacy: string;
  onDeviceVideo: string;
  reducedMetricsOnly: string;
  live: string;
  off: string;
  autoHandShort: string;
  cameraUnavailable: string;
}> = {
  vi: {
    techniqueChart: "Biểu đồ hồ sơ kỹ thuật",
    bodyScaleUnit: "× tỷ lệ cơ thể",
    poseModel: "Mô hình tư thế",
    poseModelDetail: "MediaPipe Pose Lite · tối đa 4 người",
    workerReady: "Web Worker · khóa mục tiêu",
    workerFallback: "Luồng chính dự phòng · khóa mục tiêu",
    motionFeatures: "Đặc trưng chuyển động",
    motionFeaturesDetail: "Khớp 3D + cửa sổ thời gian",
    sixPhaseAssessment: "Đánh giá chuỗi 6 pha",
    footworkEngine: "Bộ chấm bộ pháp",
    footworkEngineDetail: "Hông + gối + cổ chân",
    fourPhaseCycle: "Chu kỳ chuyển động 4 pha của BWF",
    racketHand: "Tay cầm vợt",
    lockedPerSession: "Khóa trong từng phiên",
    privacy: "Quyền riêng tư",
    onDeviceVideo: "Video xử lý trên thiết bị",
    reducedMetricsOnly: "Chỉ chỉ số rút gọn được gửi tới AI Coach",
    live: "TRỰC TIẾP",
    off: "TẮT",
    autoHandShort: "TỰ NHẬN TAY",
    cameraUnavailable: "Không thể truy cập camera. Hãy kiểm tra quyền camera và thử lại.",
  },
  en: {
    techniqueChart: "Technique profile chart",
    bodyScaleUnit: "× body scale",
    poseModel: "Pose model",
    poseModelDetail: "MediaPipe Pose Lite · up to 4 people",
    workerReady: "Web Worker · target lock",
    workerFallback: "Main-thread fallback · target lock",
    motionFeatures: "Motion features",
    motionFeaturesDetail: "3D joints + temporal window",
    sixPhaseAssessment: "Six-phase sequence assessment",
    footworkEngine: "Footwork engine",
    footworkEngineDetail: "Hips + knees + ankles",
    fourPhaseCycle: "BWF four-phase movement cycle",
    racketHand: "Racket hand",
    lockedPerSession: "Locked for each session",
    privacy: "Privacy",
    onDeviceVideo: "On-device video processing",
    reducedMetricsOnly: "Only reduced metrics are sent to AI Coach",
    live: "LIVE",
    off: "OFF",
    autoHandShort: "AUTO HAND",
    cameraUnavailable: "Camera access failed. Check camera permission and try again.",
  },
  de: {
    techniqueChart: "Diagramm des Technikprofils",
    bodyScaleUnit: "× Körpermaß",
    poseModel: "Posenmodell",
    poseModelDetail: "MediaPipe Pose Lite · bis zu 4 Personen",
    workerReady: "Web Worker · Zielfixierung",
    workerFallback: "Ersatzbetrieb im Hauptthread · Zielfixierung",
    motionFeatures: "Bewegungsmerkmale",
    motionFeaturesDetail: "3D-Gelenke + zeitliches Analysefenster",
    sixPhaseAssessment: "Bewertung des sechsphasigen Ablaufs",
    footworkEngine: "Analyse der Lauftechnik",
    footworkEngineDetail: "Hüfte + Knie + Sprunggelenke",
    fourPhaseCycle: "Vierphasiger BWF-Bewegungszyklus",
    racketHand: "Schlägerhand",
    lockedPerSession: "Für jede Einheit festgelegt",
    privacy: "Datenschutz",
    onDeviceVideo: "Videoverarbeitung auf dem Gerät",
    reducedMetricsOnly: "Nur reduzierte Messwerte werden an AI Coach gesendet",
    live: "LIVE",
    off: "AUS",
    autoHandShort: "HAND AUTOMATISCH",
    cameraUnavailable: "Kein Kamerazugriff. Prüfe die Kameraberechtigung und versuche es erneut.",
  },
};

function drawTrackedPoses(
  canvas: HTMLCanvasElement,
  poses: TrackedPose[],
  connections: Connection[],
  selectedTrackId: number | null,
  language: StudioLanguage,
) {
  const context = canvas.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.lineCap = "round";
  context.lineJoin = "round";
  poses.forEach((pose) => {
    const selected = pose.trackId === selectedTrackId;
    const accent = selected ? "#68f5ca" : "#ffd96a";
    const softAccent = selected ? "#dffdf4" : "#fff4bd";
    context.save();
    context.strokeStyle = accent;
    context.fillStyle = softAccent;
    context.globalAlpha = selected ? 1 : 0.72;
    context.lineWidth = Math.max(selected ? 2.4 : 1.5, canvas.width / (selected ? 500 : 720));
    context.shadowColor = accent;
    context.shadowBlur = selected ? 10 : 3;
    connections.forEach(({ start, end }) => {
      const left = pose.landmarks[start];
      const right = pose.landmarks[end];
      if (!left || !right || (left.visibility ?? 1) < 0.42 || (right.visibility ?? 1) < 0.42) return;
      context.beginPath();
      context.moveTo(left.x * canvas.width, left.y * canvas.height);
      context.lineTo(right.x * canvas.width, right.y * canvas.height);
      context.stroke();
    });
    context.shadowBlur = 0;
    [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28].forEach((index) => {
      const point = pose.landmarks[index];
      if (!point || (point.visibility ?? 1) < 0.42) return;
      context.beginPath();
      context.arc(point.x * canvas.width, point.y * canvas.height, Math.max(selected ? 3 : 2, canvas.width / 240), 0, Math.PI * 2);
      context.fill();
    });

    const x = pose.bounds.left * canvas.width;
    const y = pose.bounds.top * canvas.height;
    const width = pose.bounds.width * canvas.width;
    const height = pose.bounds.height * canvas.height;
    context.strokeStyle = accent;
    context.lineWidth = Math.max(selected ? 3 : 2, canvas.width / 640);
    context.setLineDash(selected ? [] : [8, 7]);
    context.strokeRect(x, y, width, height);
    context.setLineDash([]);

    const color = pose.appearance?.shirtColor ?? "unknown";
    const colorLabel = SHIRT_COLOR_LABELS[color][language]
      .replace(/^áo /, "")
      .replace(/ shirt$/, "")
      .replace(/ Trikot$/, "");
    const prefix = selected
      ? language === "vi" ? "ĐÃ KHÓA" : language === "de" ? "FIXIERT" : "LOCKED"
      : language === "vi" ? "VĐV" : language === "de" ? "ATHLET" : "ATHLETE";
    const label = `${prefix} ${pose.trackId} · ${colorLabel}`.toUpperCase();
    const fontSize = Math.max(12, Math.round(canvas.width / 75));
    context.font = `800 ${fontSize}px ui-monospace, SFMono-Regular, monospace`;
    const labelWidth = context.measureText(label).width + 20;
    const labelHeight = fontSize + 14;
    const labelY = Math.max(0, y - labelHeight - 5);
    context.globalAlpha = 0.94;
    context.fillStyle = selected ? "#59f3c5" : "#f3cd5c";
    context.fillRect(x, labelY, labelWidth, labelHeight);
    context.fillStyle = "#03110d";
    context.textBaseline = "middle";
    context.fillText(label, x + 10, labelY + labelHeight / 2);
    context.restore();
  });
}

function phaseLabel(phase: MotionPhase, language: StudioLanguage) {
  return PHASE_COPY[phase][language];
}

function shirtColorLabel(color: ShirtColor, language: StudioLanguage) {
  return SHIRT_COLOR_LABELS[color][language];
}

function positionLabel(position: HorizontalPosition, language: StudioLanguage) {
  return POSITION_LABELS[position][language];
}

function techniqueLabel(mode: TechniqueMode, language: StudioLanguage) {
  const item = TECHNIQUES.find((entry) => entry.value === mode);
  if (language === "vi") return item?.labelVi;
  if (language === "de") return item?.labelDe;
  return item?.labelEn;
}

function catalogLabel(mode: FootworkMode, language: StudioLanguage) {
  const item = FOOTWORK_CATALOG.find((entry) => entry.value === mode);
  if (language === "vi") return item?.labelVi;
  if (language === "de") return item?.labelDe;
  return item?.labelEn;
}

function SessionDropdown<T extends string>({
  value,
  options,
  disabled = false,
  ariaLabel,
  onChange,
}: {
  value: T;
  options: Array<SessionDropdownOption<T>>;
  disabled?: boolean;
  ariaLabel: string;
  onChange: (value: T) => void;
}) {
  const [open, setOpen] = useState(false);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];
  const groups = options.reduce<Array<{ label?: string; options: Array<SessionDropdownOption<T>> }>>((result, option) => {
    const current = result.at(-1);
    if (!current || current.label !== option.group) result.push({ label: option.group, options: [option] });
    else current.options.push(option);
    return result;
  }, []);

  const closeAndFocus = () => {
    setOpen(false);
    requestAnimationFrame(() => detailsRef.current?.querySelector<HTMLElement>("summary")?.focus());
  };

  return (
    <details
      ref={detailsRef}
      className={styles.sessionDropdown}
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          closeAndFocus();
        }
      }}
    >
      <summary
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        onClick={(event) => {
          if (disabled) event.preventDefault();
        }}
      >
        <span>{selected?.label ?? value}</span>
        <ChevronDown aria-hidden="true" />
      </summary>
      <div className={styles.sessionDropdownMenu} role="listbox" aria-label={ariaLabel}>
        {groups.map((group, groupIndex) => (
          <div
            className={styles.sessionDropdownGroup}
            key={`${group.label ?? "default"}-${groupIndex}`}
            role={group.label ? "group" : "presentation"}
            aria-label={group.label}
          >
            {group.label ? <span className={styles.sessionDropdownGroupLabel}>{group.label}</span> : null}
            {group.options.map((option) => {
              const active = option.value === value;
              return (
                <button
                  type="button"
                  key={option.value}
                  role="option"
                  aria-selected={active}
                  className={active ? styles.sessionDropdownOptionActive : undefined}
                  onClick={() => {
                    onChange(option.value);
                    closeAndFocus();
                  }}
                >
                  <span>{option.label}</span>
                  {active ? <Check aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </details>
  );
}

function stableShirtColor(
  memory: Map<number, AthleteColorMemory>,
  trackId: number,
  detected: ShirtColor,
) {
  const current = memory.get(trackId);
  if (!current) {
    memory.set(trackId, { displayed: detected, candidate: detected, candidateFrames: 1 });
    return detected;
  }
  if (detected === "unknown" || detected === current.displayed) {
    current.candidate = current.displayed;
    current.candidateFrames = 0;
    return current.displayed;
  }
  if (detected === current.candidate) current.candidateFrames += 1;
  else {
    current.candidate = detected;
    current.candidateFrames = 1;
  }
  const requiredFrames = current.displayed === "unknown" ? 3 : 7;
  if (current.candidateFrames >= requiredFrames) {
    current.displayed = detected;
    current.candidateFrames = 0;
  }
  return current.displayed;
}

function addPoseAppearances(
  video: HTMLVideoElement,
  scratchCanvas: HTMLCanvasElement,
  poses: VisionWorkerPose[],
): PoseObservation[] {
  try {
    scratchCanvas.width = APPEARANCE_WIDTH;
    scratchCanvas.height = APPEARANCE_HEIGHT;
    const context = scratchCanvas.getContext("2d", { willReadFrequently: true });
    if (!context) return poses;
    context.drawImage(video, 0, 0, APPEARANCE_WIDTH, APPEARANCE_HEIGHT);
    const frame = context.getImageData(0, 0, APPEARANCE_WIDTH, APPEARANCE_HEIGHT);
    return poses.map((pose) => {
      const appearance = extractTorsoAppearance(
        frame.data,
        APPEARANCE_WIDTH,
        APPEARANCE_HEIGHT,
        pose.landmarks,
      );
      return appearance ? { ...pose, appearance } : pose;
    });
  } catch {
    return poses;
  }
}

function livePhaseLabel(phase: SmashMetrics["phase"], language: StudioLanguage) {
  const labels: Record<SmashMetrics["phase"], Record<StudioLanguage, string>> = {
    READY: { vi: "Sẵn sàng", en: "Ready", de: "Bereit" },
    PREPARATION: { vi: "Chuẩn bị", en: "Preparation", de: "Vorbereitung" },
    LOADING: { vi: "Kéo vợt", en: "Loading", de: "Ausholen" },
    ACCELERATION: { vi: "Tăng tốc", en: "Acceleration", de: "Beschleunigung" },
    CONTACT: { vi: "Vùng tiếp xúc", en: "Contact zone", de: "Treffzone" },
    FOLLOW_THROUGH: { vi: "Theo đà", en: "Follow-through", de: "Ausschwung" },
  };
  return labels[phase][language];
}

function liveFootworkPhaseLabel(metrics: SmashMetrics, language: StudioLanguage) {
  const moving = metrics.footSpeed > 0.34 || metrics.centerSpeed > 0.22;
  if (!moving) return language === "vi" ? "Sẵn sàng / hồi vị" : language === "de" ? "Bereit / Rückkehr" : "Ready / recovery";
  if (metrics.verticalBounce > 0.5 || metrics.kneeFlexion > 30) {
    return language === "vi" ? "Khởi động & tạo tải" : language === "de" ? "Start & Belastung" : "Start & loading";
  }
  if (metrics.centerSpeed > 0.48) return language === "vi" ? "Tiếp cận" : language === "de" ? "Annäherung" : "Approach";
  return language === "vi" ? "Trụ & cân bằng" : language === "de" ? "Stand & Balance" : "Plant & balance";
}

function footworkLabel(mode: FootworkMode, language: StudioLanguage) {
  return catalogLabel(mode, language);
}

function createSummary(movements: AnalysisMovement[], language: StudioLanguage): AnalysisSummary {
  if (!movements.length) {
    return {
      headline: language === "vi" ? "Chưa có lần lặp" : language === "de" ? "Keine Wiederholungen" : "No repetitions",
      insight: language === "vi" ? "Chưa đủ dữ liệu để tạo báo cáo." : language === "de" ? "Nicht genügend Daten für einen Bericht." : "Not enough data to create a report.",
      averageScore: 0,
      consistency: 0,
      strongestPhase: "—",
      priority: "—",
    };
  }
  const averageScore = Math.round(movements.reduce((sum, item) => sum + item.overallScore, 0) / movements.length);
  const variance = movements.reduce((sum, item) => sum + (item.overallScore - averageScore) ** 2, 0) / movements.length;
  const consistency = Math.round(Math.max(0, 100 - Math.sqrt(variance) * 3.2));
  const phaseScores = movements[0].phases.map(({ phase }) => ({
    phase,
    score: Math.round(movements.reduce((sum, movement) =>
      sum + (movement.phases.find((entry) => entry.phase === phase)?.score ?? 0), 0) / movements.length),
  })).sort((left, right) => right.score - left.score);
  const correctionCounts = new Map<string, number>();
  movements.forEach((movement) => movement.corrections.forEach((correction) =>
    correctionCounts.set(correction, (correctionCounts.get(correction) ?? 0) + 1)));
  const priority = [...correctionCounts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0]
    ?? (language === "vi" ? "Duy trì nhịp hiện tại" : language === "de" ? "Aktuellen Rhythmus beibehalten" : "Maintain the current rhythm");
  const strongestPhase = phaseLabel(phaseScores[0]?.phase ?? "ready", language);
  return {
    headline: language === "vi"
      ? `${movements.length} lần lặp · ${averageScore}/100 điểm chuyển động`
      : language === "de"
        ? `${movements.length} Wiederholungen · ${averageScore}/100 Bewegungsscore`
        : `${movements.length} reps · ${averageScore}/100 motion score`,
    insight: language === "vi"
      ? `Pha ổn định nhất là ${strongestPhase}. Ưu tiên tiếp theo: ${priority}`
      : language === "de"
        ? `Die stabilste Phase ist ${strongestPhase}. Nächste Priorität: ${priority}`
        : `The strongest phase is ${strongestPhase}. Next priority: ${priority}`,
    averageScore,
    consistency,
    strongestPhase,
    priority,
  };
}

function localizeAnalysisMovement(
  movement: AnalysisMovement,
  language: StudioLanguage,
): AnalysisMovement {
  const localized = movement.module === "footwork"
    ? localizeFootworkAssessment(movement, language)
    : localizeMotionAssessment(movement, language);
  return { ...localized, index: movement.index, recordedAt: movement.recordedAt };
}

function isMotionSession(value: unknown): value is MotionSession {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<MotionSession>;
  return typeof session.id === "string"
    && typeof session.createdAt === "string"
    && Array.isArray(session.movements)
    && session.movements.every((movement) => typeof movement?.overallScore === "number")
    && Boolean(session.summary);
}

function demoSamples(index: number, technique: TechniqueMode): PoseLiteSample[] {
  return Array.from({ length: 18 }, (_, step) => {
    const progress = step / 17;
    const peak = Math.exp(-((progress - 0.56) ** 2) / 0.017);
    const loading = Math.exp(-((progress - 0.32) ** 2) / 0.045);
    const recovery = Math.max(0, (progress - 0.62) / 0.38);
    const isBackhand = technique === "backhand";
    const isDrive = technique === "drive";
    const variation = 1 - index * 0.018;
    return {
      timestamp: step * 40,
      wristSpeed: (0.13 + peak * (isDrive ? 1.35 : 1.72)) * variation,
      armAngularSpeed: 24 + peak * (isDrive ? 390 : 520) * variation,
      elbowAngle: 108 + peak * (isBackhand ? 38 : 55),
      shoulderAngle: 58 + peak * (isDrive ? 50 : 82),
      contactHeight: isDrive ? 55 + peak * 10 : 58 + peak * 31,
      bodyExtension: 38 + peak * (isDrive ? 29 : 53),
      wristAboveShoulder: !isDrive && progress > 0.32 && progress < 0.76,
      visibility: 91 - index,
      trunkRotation: 10 + loading * 28 + peak * 15,
      kneeFlexion: 12 + loading * 34 - recovery * 8,
      handLocked: true,
      balanceScore: 88 - index,
      stanceWidth: 0.72,
      wristAcrossBody: isBackhand ? 42 + peak * 48 : 8 + peak * 8,
      lateralReach: isDrive || isBackhand ? 34 + peak * 51 : 18 + peak * 29,
    };
  });
}

function demoFootworkSamples(index: number, skill: FootworkMode): PoseLiteSample[] {
  return Array.from({ length: 24 }, (_, step) => {
    const progress = step / 23;
    const approach = Math.sin(Math.min(1, progress / 0.55) * Math.PI / 2);
    const recovery = progress <= 0.55 ? 1 : Math.max(0, 1 - (progress - 0.55) / 0.45);
    const pulse = Math.exp(-((progress - 0.46) ** 2) / 0.035);
    const alternating = Math.sin(progress * Math.PI * 6);
    const variation = 1 - index * 0.016;
    const centerX = 0.5 + approach * recovery * 0.12;
    return {
      timestamp: step * 45,
      wristSpeed: 0.08,
      armAngularSpeed: 12,
      elbowAngle: 118,
      shoulderAngle: 68,
      contactHeight: 48,
      bodyExtension: 42,
      wristAboveShoulder: false,
      visibility: 94 - index,
      trunkRotation: 8 + pulse * (skill === "hop_pivot" || skill === "scissor_jump" ? 34 : 12),
      kneeFlexion: 14 + pulse * 43,
      leftKneeFlexion: 14 + pulse * 48,
      rightKneeFlexion: 13 + pulse * 38,
      handLocked: true,
      balanceScore: 91 - index,
      stanceWidth: 0.62 + pulse * (skill === "lunge" ? 0.68 : 0.36),
      wristAcrossBody: 0,
      lateralReach: 0,
      leftAnkleSpeed: (0.22 + Math.max(0, alternating) * 2.1 + pulse * 0.9) * variation,
      rightAnkleSpeed: (0.22 + Math.max(0, -alternating) * 2.1 + pulse * 0.8) * variation,
      footSpeed: (0.35 + Math.abs(alternating) * 2.05 + pulse * 0.95) * variation,
      centerSpeed: (0.14 + pulse * 1.25) * variation,
      verticalBounce: 0.1 + pulse * (["jump_landing", "scissor_jump", "china_jump"].includes(skill) ? 1.38 : 0.48),
      landingSymmetry: 90 - index,
      ankleHeightDifference: pulse * 0.14,
      centerX,
      centerY: 0.57 - pulse * 0.035,
      leftAnkleX: centerX - 0.06 - alternating * 0.028,
      leftAnkleY: 0.93 - pulse * 0.035,
      rightAnkleX: centerX + 0.06 + alternating * 0.028,
      rightAnkleY: 0.93 - pulse * 0.028,
      bodyScale: 0.21,
    };
  });
}

function createDemoMovements(
  trainingModule: TrainingModule,
  strokeMode: TechniqueMode,
  footworkMode: FootworkMode,
  language: StudioLanguage,
): AnalysisMovement[] {
  if (trainingModule === "footwork") {
    const selected = footworkMode === "footwork_auto" ? "lunge" : footworkMode;
    return Array.from({ length: 5 }, (_, index) => ({
      ...assessFootworkWindow(demoFootworkSamples(index, selected), selected, "right", language),
      index: index + 1,
      recordedAt: new Date(Date.now() - (5 - index) * 7_000).toISOString(),
    }));
  }
  const selected = strokeMode === "open" ? "smash" : strokeMode;
  return Array.from({ length: 5 }, (_, index) => ({
    ...assessMotionWindow(demoSamples(index, selected), selected, "right", language),
    index: index + 1,
    recordedAt: new Date(Date.now() - (5 - index) * 7_000).toISOString(),
  }));
}

function ScoreRing({ value, label }: { value: number; label: string }) {
  const radius = 48;
  const circumference = 2 * Math.PI * radius;
  return (
    <div className={styles.scoreRing}>
      <svg viewBox="0 0 116 116" aria-hidden="true">
        <circle cx="58" cy="58" r={radius} />
        <circle cx="58" cy="58" r={radius} strokeDasharray={circumference} strokeDashoffset={circumference * (1 - value / 100)} />
      </svg>
      <div><strong>{value}</strong><span>/100</span><small>{label}</small></div>
    </div>
  );
}

function TechniqueRadar({ movement, ariaLabel }: { movement: AnalysisMovement; ariaLabel: string }) {
  const values = [movement.postureScore, movement.rhythmScore, movement.recoveryScore, movement.metrics.balance, movement.captureQuality];
  const points = values.map((value, index) => {
    const angle = -Math.PI / 2 + (index * Math.PI * 2) / values.length;
    const radius = 18 + value * 0.34;
    return `${60 + Math.cos(angle) * radius},${60 + Math.sin(angle) * radius}`;
  }).join(" ");
  return (
    <svg className={styles.radar} viewBox="0 0 120 120" aria-label={ariaLabel}>
      {[20, 35, 50].map((radius) => (
        <polygon key={radius} points={values.map((_, index) => {
          const angle = -Math.PI / 2 + (index * Math.PI * 2) / values.length;
          return `${60 + Math.cos(angle) * radius},${60 + Math.sin(angle) * radius}`;
        }).join(" ")} />
      ))}
      {values.map((_, index) => {
        const angle = -Math.PI / 2 + (index * Math.PI * 2) / values.length;
        return <line key={index} x1="60" y1="60" x2={60 + Math.cos(angle) * 50} y2={60 + Math.sin(angle) * 50} />;
      })}
      <polygon className={styles.radarValue} points={points} />
    </svg>
  );
}

type MotionAnalyzerProps = {
  view: StudioView;
  language: StudioLanguage;
  onNavigate: (view: StudioView) => void;
  onAskCoach: (prompt: string) => void;
};

export default function MotionAnalyzer({ view, language, onNavigate, onAskCoach }: MotionAnalyzerProps) {
  const copy = UI[language];
  const systemCopy = SYSTEM_COPY[language];
  const [status, setStatus] = useState<AnalyzerStatus>("idle");
  const [recording, setRecording] = useState(false);
  const [source, setSource] = useState<AnalysisSource>("none");
  const [athleteDetected, setAthleteDetected] = useState(false);
  const [visibleAthletes, setVisibleAthletes] = useState<AthleteOption[]>([]);
  const [selectedTrackId, setSelectedTrackId] = useState<number | null>(null);
  const [targetStatus, setTargetStatus] = useState<TargetStatus>("waiting");
  const [targetRecoveryProgress, setTargetRecoveryProgress] = useState(0);
  const [targetPickerExpanded, setTargetPickerExpanded] = useState(true);
  const [pendingTarget, setPendingTarget] = useState<AthleteOption | null>(null);
  const [focusReticle, setFocusReticle] = useState<FocusReticle | null>(null);
  const [workerStatus, setWorkerStatus] = useState<WorkerStatus>("checking");
  const [storageStatus, setStorageStatus] = useState<StorageStatus>("checking");
  const [trainingModule, setTrainingModule] = useState<TrainingModule>("stroke");
  const [mode, setMode] = useState<TechniqueMode>("smash");
  const [footworkMode, setFootworkMode] = useState<FootworkMode>("split_step");
  const [preferredHand, setPreferredHand] = useState<PreferredHand>("right");
  const [metrics, setMetrics] = useState<SmashMetrics>(initialMetrics);
  const [currentMessage, setCurrentMessage] = useState<string>(copy.liveWaiting);
  const [movements, setMovements] = useState<AnalysisMovement[]>([]);
  const [summary, setSummary] = useState<AnalysisSummary | null>(null);
  const [history, setHistory] = useState<MotionSession[]>([]);
  const [errorMessage, setErrorMessage] = useState("");
  const [focusMode, setFocusMode] = useState(false);
  const [cameraSettingsOpen, setCameraSettingsOpen] = useState(false);
  const [sessionSetupOpen, setSessionSetupOpen] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const landmarkerRef = useRef<PoseLandmarker | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const connectionsRef = useRef<Connection[]>([]);
  const animationRef = useRef<number | null>(null);
  const runningRef = useRef(false);
  const recordingRef = useRef(false);
  const workerInitializedRef = useRef(false);
  const workerFrameBusyRef = useRef(false);
  const lastVideoTimeRef = useRef(-1);
  const trackerRef = useRef(createMultiPoseTrackerState());
  const trackedPosesRef = useRef<TrackedPose[]>([]);
  const selectedTrackIdRef = useRef<number | null>(null);
  const targetStatusRef = useRef<TargetStatus>("waiting");
  const targetRecoveryProgressRef = useRef(0);
  const lockReacquisitionRef = useRef(createLockReacquisitionState());
  const visibleAthletesSignatureRef = useRef("");
  const appearanceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const selectedAppearanceRef = useRef<PoseAppearance | undefined>(undefined);
  const lockedTargetMemoryRef = useRef<LockedTargetMemory | null>(null);
  const pendingTrackIdRef = useRef<number | null>(null);
  const lastFrameTimestampRef = useRef(0);
  const targetConfirmDialogRef = useRef<HTMLDivElement>(null);
  const athletePositionsRef = useRef(new Map<number, HorizontalPosition>());
  const athleteColorsRef = useRef(new Map<number, AthleteColorMemory>());
  const memoryRef = useRef<PoseFrameMemory | null>(null);
  const lastContactRef = useRef(-10_000);
  const samplesRef = useRef<PoseLiteSample[]>([]);
  const candidateRef = useRef<SwingCandidate | null>(null);
  const movementsRef = useRef<AnalysisMovement[]>([]);
  const nextIndexRef = useRef(1);
  const modeRef = useRef<TechniqueMode>(mode);
  const trainingModuleRef = useRef<TrainingModule>(trainingModule);
  const footworkModeRef = useRef<FootworkMode>(footworkMode);
  const preferredHandRef = useRef<PreferredHand>(preferredHand);
  const processFrameRef = useRef<(poses: VisionWorkerPose[], timestamp: number) => void>(() => undefined);
  const analysisResolversRef = useRef(new Map<string, (result: MotionAssessment) => void>());
  const workerInitResolverRef = useRef<{ resolve: () => void; reject: (error: Error) => void } | null>(null);
  const lastUiUpdateRef = useRef(0);

  const latest = movements.at(-1) ?? null;
  const selectedAthleteOption = visibleAthletes.find((athlete) => athlete.trackId === selectedTrackId) ?? null;
  const pendingTargetLive = pendingTarget === null
    ? null
    : visibleAthletes.find((athlete) => athlete.trackId === pendingTarget.trackId) ?? null;
  const pendingTargetDisplay = pendingTargetLive ?? pendingTarget;
  const pendingTargetVisible = pendingTargetLive !== null;
  const pendingTargetReady = pendingTargetLive?.lockReady ?? false;
  const activeSummary = useMemo(
    () => summary ?? (movements.length ? createSummary(movements, language) : null),
    [language, movements, summary],
  );
  const averageCapture = useMemo(() => movements.length
    ? Math.round(movements.reduce((sum, movement) => sum + movement.captureQuality, 0) / movements.length)
    : 0, [movements]);

  useEffect(() => { recordingRef.current = recording; }, [recording]);
  useEffect(() => { modeRef.current = mode; }, [mode]);
  useEffect(() => { trainingModuleRef.current = trainingModule; }, [trainingModule]);
  useEffect(() => { footworkModeRef.current = footworkMode; }, [footworkMode]);
  useEffect(() => {
    if (!movementsRef.current.length) return;
    const localized = movementsRef.current.map((movement) => localizeAnalysisMovement(movement, language));
    movementsRef.current = localized;
    setMovements(localized);
    setSummary(createSummary(localized, language));
  }, [language]);
  useEffect(() => {
    preferredHandRef.current = preferredHand;
    memoryRef.current = null;
  }, [preferredHand]);

  useEffect(() => {
    if (!focusMode) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previousOverflow; };
  }, [focusMode]);

  useEffect(() => {
    if (!sessionSetupOpen) return;
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSessionSetupOpen(false);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [sessionSetupOpen]);

  useEffect(() => {
    const worker = typeof Worker === "undefined"
      ? null
      : new Worker(new URL("../workers/vision-worker.ts", import.meta.url));
    if (!worker) {
      const timer = window.setTimeout(() => setWorkerStatus("fallback"), 0);
      return () => window.clearTimeout(timer);
    }
    workerRef.current = worker;
    const resolvers = analysisResolversRef.current;
    worker.onmessage = (event: MessageEvent<VisionWorkerOutgoing>) => {
      if (event.data.type === "ready") {
        setWorkerStatus("ready");
      } else if (event.data.type === "initialized") {
        connectionsRef.current = event.data.connections;
        workerInitializedRef.current = true;
        workerInitResolverRef.current?.resolve();
        workerInitResolverRef.current = null;
        setWorkerStatus("ready");
      } else if (event.data.type === "frame") {
        workerFrameBusyRef.current = false;
        processFrameRef.current(event.data.poses, event.data.timestamp);
      } else if (event.data.type === "motionResult" || event.data.type === "footworkResult") {
        const resolve = resolvers.get(event.data.requestId);
        if (resolve) {
          resolvers.delete(event.data.requestId);
          resolve(event.data.result);
        }
      } else if (event.data.type === "error") {
        workerFrameBusyRef.current = false;
        if (event.data.stage === "initialize") {
          workerInitializedRef.current = false;
          workerInitResolverRef.current?.reject(new Error(event.data.message));
          workerInitResolverRef.current = null;
          setWorkerStatus("fallback");
        }
      }
    };
    worker.onerror = () => {
      workerFrameBusyRef.current = false;
      workerInitializedRef.current = false;
      workerInitResolverRef.current?.reject(new Error("Motion worker failed"));
      workerInitResolverRef.current = null;
      setWorkerStatus("fallback");
    };
    worker.postMessage({ type: "ping" });
    return () => {
      worker.terminate();
      workerRef.current = null;
      resolvers.clear();
    };
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const sessions = await readRecentMotionSessions<MotionSession>(12);
        setHistory(sessions.filter(isMotionSession));
        setStorageStatus("indexeddb");
      } catch {
        try {
          const stored = JSON.parse(window.localStorage.getItem(HISTORY_FALLBACK_KEY) ?? "[]") as unknown[];
          setHistory(stored.filter(isMotionSession).slice(0, 12));
        } catch {
          setHistory([]);
        }
        setStorageStatus("localstorage");
      }
    })();
  }, []);

  useEffect(() => {
    publishAnalysisSnapshot({
      source,
      capturedAt: new Date().toISOString(),
      trainingModule,
      drillMode: trainingModule === "stroke" ? mode : footworkMode,
      preferredHand,
      movements,
      summary: activeSummary,
    });
  }, [activeSummary, footworkMode, mode, movements, preferredHand, source, trainingModule]);

  useEffect(() => () => {
    runningRef.current = false;
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    landmarkerRef.current?.close();
  }, []);

  const classifyMotion = useCallback((samples: PoseLiteSample[], dominantSide: "left" | "right") => {
    const worker = workerRef.current;
    if (!worker || !workerInitializedRef.current) {
      return Promise.resolve(trainingModuleRef.current === "footwork"
        ? assessFootworkWindow(samples, footworkModeRef.current, dominantSide, language)
        : assessMotionWindow(samples, modeRef.current, dominantSide, language));
    }
    return new Promise<MotionAssessment>((resolve) => {
      const requestId = crypto.randomUUID();
      analysisResolversRef.current.set(requestId, resolve);
      worker.postMessage(trainingModuleRef.current === "footwork" ? {
        type: "analyzeFootwork",
        requestId,
        samples,
        mode: footworkModeRef.current,
        dominantSide,
        language,
      } : {
        type: "analyzeMotion",
        requestId,
        samples,
        mode: modeRef.current,
        dominantSide,
        language,
      });
    });
  }, [language]);

  const registerMovement = useCallback((samples: PoseLiteSample[], dominantSide: "left" | "right") => {
    const index = nextIndexRef.current++;
    setCurrentMessage(language === "vi" ? `Đang chấm lần lặp ${index}…` : language === "de" ? `Wiederholung ${index} wird bewertet…` : `Scoring repetition ${index}…`);
    void classifyMotion(samples, dominantSide).then((assessment) => {
      const event: AnalysisMovement = {
        ...assessment,
        index,
        recordedAt: new Date().toISOString(),
      };
      const next = [...movementsRef.current, event].sort((left, right) => left.index - right.index);
      movementsRef.current = next;
      setMovements(next);
      setCurrentMessage(`${assessment.label} · ${assessment.overallScore}/100`);
    });
  }, [classifyMotion, language]);

  const resetTargetMotion = useCallback(() => {
    memoryRef.current = null;
    samplesRef.current = [];
    candidateRef.current = null;
    lastContactRef.current = -10_000;
  }, []);

  const resetLockRecovery = useCallback(() => {
    lockReacquisitionRef.current = createLockReacquisitionState();
    if (targetRecoveryProgressRef.current !== 0) {
      targetRecoveryProgressRef.current = 0;
      setTargetRecoveryProgress(0);
    }
  }, []);

  const selectAthlete = useCallback((trackId: number) => {
    if (recordingRef.current) return;
    const target = trackedPosesRef.current.find((pose) => pose.trackId === trackId);
    if (!target) {
      setCurrentMessage(copy.targetUnavailable);
      return;
    }
    if (!isTrackedPoseLockReady(target)) {
      setCurrentMessage(copy.targetVerifying);
      return;
    }
    const appearance = target.appearance ?? target.observedAppearance;
    selectedTrackIdRef.current = trackId;
    pendingTrackIdRef.current = null;
    setPendingTarget(null);
    setFocusReticle(null);
    selectedAppearanceRef.current = appearance;
    lockedTargetMemoryRef.current = createLockedTargetMemory(
      target,
      lastFrameTimestampRef.current,
    );
    targetStatusRef.current = "locked";
    setSelectedTrackId(trackId);
    setTargetStatus("locked");
    setAthleteDetected(true);
    setTargetPickerExpanded(false);
    resetLockRecovery();
    resetTargetMotion();
    setCurrentMessage(copy.notRecording);
  }, [copy.notRecording, copy.targetUnavailable, copy.targetVerifying, resetLockRecovery, resetTargetMotion]);

  const requestAthleteSelection = useCallback((trackId: number) => {
    if (recordingRef.current || selectedTrackIdRef.current !== null) return;
    const pose = trackedPosesRef.current.find((entry) => entry.trackId === trackId);
    if (!pose) {
      setCurrentMessage(copy.targetUnavailable);
      return;
    }
    const option = visibleAthletes.find((athlete) => athlete.trackId === trackId) ?? {
      trackId,
      shirtColor: pose.appearance?.shirtColor ?? "unknown",
      position: horizontalPosition(pose.bounds.centerX),
      lockConfidence: Math.round(pose.lockConfidence * 100),
      lockReady: isTrackedPoseLockReady(pose),
    };
    pendingTrackIdRef.current = trackId;
    setPendingTarget(option);
  }, [copy.targetUnavailable, visibleAthletes]);

  const cancelAthleteSelection = useCallback(() => {
    pendingTrackIdRef.current = null;
    setPendingTarget(null);
    setFocusReticle(null);
  }, []);

  const beginTargetChange = useCallback(() => {
    if (recordingRef.current) return;
    selectedTrackIdRef.current = null;
    selectedAppearanceRef.current = undefined;
    lockedTargetMemoryRef.current = null;
    pendingTrackIdRef.current = null;
    setPendingTarget(null);
    setFocusReticle(null);
    setSelectedTrackId(null);
    setAthleteDetected(false);
    resetLockRecovery();
    const nextStatus: TargetStatus = trackedPosesRef.current.length > 0 ? "selecting" : "waiting";
    targetStatusRef.current = nextStatus;
    setTargetStatus(nextStatus);
    setTargetPickerExpanded(true);
    resetTargetMotion();
    setCurrentMessage(copy.targetRequired);
  }, [copy.targetRequired, resetLockRecovery, resetTargetMotion]);

  const confirmAthleteSelection = useCallback(() => {
    if (!pendingTarget) return;
    const target = trackedPosesRef.current.find((pose) => pose.trackId === pendingTarget.trackId);
    if (!target) {
      cancelAthleteSelection();
      setCurrentMessage(copy.targetUnavailable);
      return;
    }
    if (!isTrackedPoseLockReady(target)) {
      setCurrentMessage(copy.targetVerifying);
      return;
    }
    selectAthlete(pendingTarget.trackId);
  }, [cancelAthleteSelection, copy.targetUnavailable, copy.targetVerifying, pendingTarget, selectAthlete]);

  useEffect(() => {
    if (!pendingTarget) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTimer = window.setTimeout(() => {
      const buttons = targetConfirmDialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)");
      buttons?.[buttons.length - 1]?.focus();
    }, 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        cancelAthleteSelection();
        return;
      }
      if (event.key !== "Tab" || !targetConfirmDialogRef.current) return;
      const focusable = [...targetConfirmDialogRef.current.querySelectorAll<HTMLElement>(
        "button:not(:disabled), [href], [tabindex]:not([tabindex='-1'])",
      )];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!focusable.includes(document.activeElement as HTMLElement)) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus();
    };
  }, [cancelAthleteSelection, pendingTarget]);

  const processPoses = useCallback((poses: VisionWorkerPose[], now: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    lastFrameTimestampRef.current = now;
    let observations: PoseObservation[] = poses;
    const video = videoRef.current;
    if (video && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA
      && poses.some((pose) => !pose.appearance)) {
      appearanceCanvasRef.current ??= document.createElement("canvas");
      observations = addPoseAppearances(video, appearanceCanvasRef.current, poses);
    }
    const tracked = updateMultiPoseTracker(trackerRef.current, observations, now);
    trackerRef.current = tracked.state;
    trackedPosesRef.current = tracked.poses;
    const visibleTrackIds = new Set(tracked.poses.map((pose) => pose.trackId));
    athletePositionsRef.current.forEach((_, trackId) => {
      if (!visibleTrackIds.has(trackId)) athletePositionsRef.current.delete(trackId);
    });
    athleteColorsRef.current.forEach((_, trackId) => {
      if (!visibleTrackIds.has(trackId)) athleteColorsRef.current.delete(trackId);
    });
    const athleteOptions = tracked.poses.map((pose): AthleteOption => {
      const position = horizontalPosition(
        pose.bounds.centerX,
        athletePositionsRef.current.get(pose.trackId),
      );
      athletePositionsRef.current.set(pose.trackId, position);
      const detectedColor = pose.appearance && pose.appearance.confidence >= 0.34
        ? pose.appearance.shirtColor
        : "unknown";
      return {
        trackId: pose.trackId,
        shirtColor: stableShirtColor(athleteColorsRef.current, pose.trackId, detectedColor),
        position,
        lockConfidence: Math.round(pose.lockConfidence * 100),
        lockReady: isTrackedPoseLockReady(pose),
      };
    });
    const signature = athleteOptions
      .map((option) => `${option.trackId}:${option.shirtColor}:${option.position}:${option.lockConfidence}:${option.lockReady}`)
      .join(",");
    if (signature !== visibleAthletesSignatureRef.current) {
      visibleAthletesSignatureRef.current = signature;
      setVisibleAthletes(athleteOptions);
    }

    let targetId = selectedTrackIdRef.current;
    let pose = targetId === null
      ? null
      : tracked.poses.find((entry) => entry.trackId === targetId) ?? null;
    const retainedTarget = targetId !== null
      && tracked.state.tracks.some((track) => track.id === targetId);
    if (!pose && targetId !== null && !retainedTarget && lockedTargetMemoryRef.current) {
      const recovery = advanceLockedPoseReacquisition(
        tracked.poses,
        lockedTargetMemoryRef.current,
        now,
        lockReacquisitionRef.current,
      );
      lockReacquisitionRef.current = recovery.state;
      const nextProgress = Math.round(recovery.progress * 100);
      if (nextProgress !== targetRecoveryProgressRef.current) {
        targetRecoveryProgressRef.current = nextProgress;
        setTargetRecoveryProgress(nextProgress);
      }
      if (recovery.pose) {
        targetId = recovery.pose.trackId;
        pose = recovery.pose;
        selectedTrackIdRef.current = recovery.pose.trackId;
        setSelectedTrackId(recovery.pose.trackId);
        resetLockRecovery();
      }
    } else if (pose || targetId === null) {
      resetLockRecovery();
    }
    const selectedAppearance = selectedAppearanceRef.current;
    const currentAppearance = pose?.observedAppearance ?? pose?.appearance;
    if (pose && selectedAppearance && currentAppearance) {
      const alternatives = tracked.poses
        .filter((entry) => entry.trackId !== pose?.trackId)
        .map((entry) => entry.observedAppearance ?? entry.appearance)
        .filter((appearance): appearance is PoseAppearance => Boolean(appearance));
      if (appearanceIdentityConflict(selectedAppearance, currentAppearance, alternatives)) pose = null;
    } else if (pose && !selectedAppearance && currentAppearance) {
      selectedAppearanceRef.current = currentAppearance;
    }
    if (pose && selectedAppearanceRef.current) {
      lockedTargetMemoryRef.current = lockedTargetMemoryRef.current
        ? updateLockedTargetMemory(lockedTargetMemoryRef.current, pose, now)
        : createLockedTargetMemory(pose, now);
    }
    const visiblePoses = targetId === null ? tracked.poses : pose ? [pose] : [];
    drawTrackedPoses(
      canvas,
      visiblePoses,
      connectionsRef.current,
      pendingTrackIdRef.current ?? (pose ? targetId : null),
      language,
    );

    if (targetId === null) {
      const nextStatus: TargetStatus = tracked.poses.length > 0 ? "selecting" : "waiting";
      if (targetStatusRef.current !== nextStatus) {
        targetStatusRef.current = nextStatus;
        setTargetStatus(nextStatus);
        if (nextStatus === "selecting") setTargetPickerExpanded(true);
      }
      setAthleteDetected(false);
      resetTargetMotion();
      return;
    }
    if (!pose) {
      if (targetStatusRef.current !== "lost") {
        targetStatusRef.current = "lost";
        setTargetStatus("lost");
        setTargetPickerExpanded(false);
        setCurrentMessage(copy.targetLost);
      }
      setAthleteDetected(false);
      resetTargetMotion();
      return;
    }
    if (targetStatusRef.current !== "locked") {
      targetStatusRef.current = "locked";
      setTargetStatus("locked");
      setTargetPickerExpanded(false);
      setCurrentMessage(recordingRef.current
        ? trainingModuleRef.current === "footwork" ? copy.footworkWaiting : copy.liveWaiting
        : copy.notRecording);
    }
    setAthleteDetected(true);
    const analysis = analyzePose(
      pose.landmarks,
      now,
      memoryRef.current,
      lastContactRef.current,
      { preferredHand: preferredHandRef.current, worldLandmarks: pose.worldLandmarks },
    );
    memoryRef.current = analysis.memory;
    if (now - lastUiUpdateRef.current > 90) {
      lastUiUpdateRef.current = now;
      setMetrics(analysis.metrics);
    }
    const sample: PoseLiteSample = {
      timestamp: now,
      wristSpeed: analysis.metrics.wristSpeed,
      armAngularSpeed: analysis.metrics.armAngularSpeed,
      elbowAngle: analysis.metrics.elbowAngle,
      shoulderAngle: analysis.metrics.shoulderAngle,
      contactHeight: analysis.metrics.contactHeight,
      bodyExtension: analysis.metrics.bodyExtension,
      wristAboveShoulder: analysis.metrics.wristAboveShoulder,
      visibility: analysis.metrics.confidence,
      trunkRotation: analysis.metrics.trunkRotation,
      kneeFlexion: analysis.metrics.kneeFlexion,
      handLocked: analysis.metrics.handLocked,
      balanceScore: analysis.metrics.balanceScore,
      stanceWidth: analysis.metrics.stanceWidth,
      trunkAngularSpeed: analysis.metrics.trunkAngularSpeed,
      elbowExtensionSpeed: analysis.metrics.elbowExtensionSpeed,
      worldTracking: analysis.metrics.worldTracking,
      wristAcrossBody: analysis.metrics.wristAcrossBody,
      lateralReach: analysis.metrics.lateralReach,
      leftKneeFlexion: analysis.metrics.leftKneeFlexion,
      rightKneeFlexion: analysis.metrics.rightKneeFlexion,
      leftAnkleSpeed: analysis.metrics.leftAnkleSpeed,
      rightAnkleSpeed: analysis.metrics.rightAnkleSpeed,
      footSpeed: analysis.metrics.footSpeed,
      centerSpeed: analysis.metrics.centerSpeed,
      verticalBounce: analysis.metrics.verticalBounce,
      landingSymmetry: analysis.metrics.landingSymmetry,
      ankleHeightDifference: analysis.metrics.ankleHeightDifference,
      centerX: analysis.metrics.centerX,
      centerY: analysis.metrics.centerY,
      leftAnkleX: analysis.metrics.leftAnkleX,
      leftAnkleY: analysis.metrics.leftAnkleY,
      rightAnkleX: analysis.metrics.rightAnkleX,
      rightAnkleY: analysis.metrics.rightAnkleY,
      bodyScale: analysis.metrics.bodyScale,
    };
    samplesRef.current = [...samplesRef.current, sample].slice(-48);
    if (!recordingRef.current) return;

    const isFootwork = trainingModuleRef.current === "footwork";
    const handReady = preferredHandRef.current !== "auto" || analysis.metrics.handLocked;
    const energy = isFootwork
      ? analysis.metrics.footSpeed * 0.48 + analysis.metrics.centerSpeed * 0.7
        + Math.min(analysis.metrics.verticalBounce * 0.35, 0.7)
      : analysis.metrics.wristSpeed + Math.min(analysis.metrics.armAngularSpeed / 480, 1.3);
    const canCollect = analysis.metrics.confidence > (isFootwork ? 60 : 52)
      && now - lastContactRef.current > (isFootwork ? 980 : 720)
      && (isFootwork
        ? analysis.metrics.footSpeed > 0.32 || analysis.metrics.centerSpeed > 0.24
        : handReady && analysis.metrics.wristSpeed > 0.3 && analysis.metrics.armAngularSpeed > 28);
    const candidate = candidateRef.current;
    if (canCollect && !candidate) {
      candidateRef.current = { startedAt: now, peakAt: now, peakEnergy: energy };
    } else if (canCollect && candidate && energy > candidate.peakEnergy) {
      candidateRef.current = { ...candidate, peakAt: now, peakEnergy: energy };
    }
    const active = candidateRef.current;
    if (!active) return;
    const age = now - active.startedAt;
    const speedDropped = now - active.peakAt > (isFootwork ? 180 : 100)
      && (isFootwork
        ? analysis.metrics.footSpeed < 0.3 && analysis.metrics.centerSpeed < 0.2
        : analysis.metrics.wristSpeed < 0.36);
    const maxAge = isFootwork ? 1_500 : 620;
    if (age > (isFootwork ? 260 : 140) && (speedDropped || age > maxAge)) {
      candidateRef.current = null;
      const windowSamples = samplesRef.current
        .filter((entry) => entry.timestamp >= active.startedAt - (isFootwork ? 520 : 360))
        .slice(isFootwork ? -48 : -38);
      const energyThreshold = isFootwork ? 0.46 : 0.66;
      if (active.peakEnergy > energyThreshold && windowSamples.length >= (isFootwork ? 9 : 6)
        && now - lastContactRef.current > (isFootwork ? 1_050 : 820)) {
        lastContactRef.current = now;
        registerMovement(windowSamples, analysis.metrics.dominantSide);
      }
    }
  }, [copy.footworkWaiting, copy.liveWaiting, copy.notRecording, copy.targetLost, language, registerMovement, resetLockRecovery, resetTargetMotion]);

  useEffect(() => { processFrameRef.current = processPoses; }, [processPoses]);

  const selectAthleteFromCamera = useCallback((event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (status !== "live" || recordingRef.current || selectedTrackIdRef.current !== null) return;
    const canvas = canvasRef.current;
    if (!canvas || canvas.width <= 0 || canvas.height <= 0) return;
    const rect = canvas.getBoundingClientRect();
    const scale = Math.max(rect.width / canvas.width, rect.height / canvas.height);
    const renderedWidth = canvas.width * scale;
    const renderedHeight = canvas.height * scale;
    const offsetX = (rect.width - renderedWidth) / 2;
    const offsetY = (rect.height - renderedHeight) / 2;
    const x = (event.clientX - rect.left - offsetX) / renderedWidth;
    const y = (event.clientY - rect.top - offsetY) / renderedHeight;
    const target = hitTestTrackedPose(trackedPosesRef.current, x, y);
    if (target) {
      setFocusReticle({
        x: ((event.clientX - rect.left) / rect.width) * 100,
        y: ((event.clientY - rect.top) / rect.height) * 100,
        token: Date.now(),
      });
      requestAthleteSelection(target.trackId);
    }
  }, [requestAthleteSelection, status]);

  const startLoop = useCallback(() => {
    const detect = () => {
      const video = videoRef.current;
      if (!runningRef.current || !video) return;
      if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && video.currentTime !== lastVideoTimeRef.current) {
        const now = video.currentTime > 0 ? video.currentTime * 1_000 : performance.now();
        if (workerRef.current && workerInitializedRef.current && !workerFrameBusyRef.current) {
          lastVideoTimeRef.current = video.currentTime;
          workerFrameBusyRef.current = true;
          const requestId = crypto.randomUUID();
          void createImageBitmap(video).then((frame) => {
            if (!runningRef.current || !workerRef.current) {
              frame.close();
              workerFrameBusyRef.current = false;
              return;
            }
            workerRef.current.postMessage({ type: "detect", requestId, frame, timestamp: now }, [frame]);
          }).catch(() => { workerFrameBusyRef.current = false; });
        } else if (!workerInitializedRef.current && landmarkerRef.current) {
          lastVideoTimeRef.current = video.currentTime;
          const result = landmarkerRef.current.detectForVideo(video, now);
          processFrameRef.current(result.landmarks.map((landmarks, index) => ({
            landmarks,
            worldLandmarks: result.worldLandmarks[index],
          })), now);
        }
      }
      animationRef.current = requestAnimationFrame(detect);
    };
    detect();
  }, []);

  const initializeWorker = useCallback(() => {
    if (workerInitializedRef.current) return Promise.resolve();
    const worker = workerRef.current;
    if (!worker) return Promise.reject(new Error("Web Worker unavailable"));
    return new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        workerInitResolverRef.current = null;
        reject(new Error("Motion engine timed out"));
      }, 15_000);
      workerInitResolverRef.current = {
        resolve: () => { window.clearTimeout(timeout); resolve(); },
        reject: (error) => { window.clearTimeout(timeout); reject(error); },
      };
      worker.postMessage({ type: "initialize", wasmUrl: WASM_URL, modelUrl: MODEL_URL });
    });
  }, []);

  const startCamera = useCallback(async () => {
    setStatus("loading");
    setErrorMessage("");
    setCameraSettingsOpen(false);
    setSessionSetupOpen(false);
    trackerRef.current = createMultiPoseTrackerState();
    trackedPosesRef.current = [];
    selectedTrackIdRef.current = null;
    pendingTrackIdRef.current = null;
    setPendingTarget(null);
    setFocusReticle(null);
    selectedAppearanceRef.current = undefined;
    lockedTargetMemoryRef.current = null;
    athletePositionsRef.current.clear();
    athleteColorsRef.current.clear();
    targetStatusRef.current = "waiting";
    visibleAthletesSignatureRef.current = "";
    setVisibleAthletes([]);
    setSelectedTrackId(null);
    setTargetStatus("waiting");
    setTargetPickerExpanded(true);
    setAthleteDetected(false);
    resetLockRecovery();
    resetTargetMotion();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
        audio: false,
      });
      streamRef.current = stream;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas) throw new Error(systemCopy.cameraUnavailable);
      video.srcObject = stream;
      await video.play();
      canvas.width = video.videoWidth || 1280;
      canvas.height = video.videoHeight || 720;
      try {
        await initializeWorker();
      } catch {
        const { FilesetResolver, PoseLandmarker } = await import("@mediapipe/tasks-vision");
        const vision = await FilesetResolver.forVisionTasks(WASM_URL);
        landmarkerRef.current = await PoseLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: "CPU" },
          runningMode: "VIDEO",
          numPoses: 4,
          minPoseDetectionConfidence: 0.48,
          minPosePresenceConfidence: 0.48,
          minTrackingConfidence: 0.5,
        });
        connectionsRef.current = PoseLandmarker.POSE_CONNECTIONS;
        setWorkerStatus("fallback");
      }
      runningRef.current = true;
      lastVideoTimeRef.current = -1;
      setStatus("live");
      setCurrentMessage(copy.notRecording);
      startLoop();
    } catch (error) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      setStatus("error");
      setErrorMessage(error instanceof Error && error.message === systemCopy.cameraUnavailable
        ? error.message
        : systemCopy.cameraUnavailable);
    }
  }, [copy.notRecording, initializeWorker, resetLockRecovery, resetTargetMotion, startLoop, systemCopy.cameraUnavailable]);

  const stopCamera = useCallback(() => {
    runningRef.current = false;
    recordingRef.current = false;
    setRecording(false);
    setCameraSettingsOpen(false);
    if (animationRef.current !== null) cancelAnimationFrame(animationRef.current);
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    landmarkerRef.current?.close();
    landmarkerRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    canvasRef.current?.getContext("2d")?.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    trackerRef.current = createMultiPoseTrackerState();
    trackedPosesRef.current = [];
    selectedTrackIdRef.current = null;
    pendingTrackIdRef.current = null;
    setPendingTarget(null);
    setFocusReticle(null);
    selectedAppearanceRef.current = undefined;
    lockedTargetMemoryRef.current = null;
    athletePositionsRef.current.clear();
    athleteColorsRef.current.clear();
    targetStatusRef.current = "waiting";
    visibleAthletesSignatureRef.current = "";
    setVisibleAthletes([]);
    setSelectedTrackId(null);
    setTargetStatus("waiting");
    setTargetPickerExpanded(true);
    setAthleteDetected(false);
    setStatus("idle");
    resetLockRecovery();
    resetTargetMotion();
  }, [resetLockRecovery, resetTargetMotion]);

  const resetSet = useCallback((nextSource: AnalysisSource = "none") => {
    movementsRef.current = [];
    samplesRef.current = [];
    candidateRef.current = null;
    memoryRef.current = null;
    lastContactRef.current = -10_000;
    nextIndexRef.current = 1;
    setMovements([]);
    setSummary(null);
    setSource(nextSource);
    setCurrentMessage(recordingRef.current
      ? trainingModuleRef.current === "footwork" ? copy.footworkWaiting : copy.liveWaiting
      : copy.notRecording);
  }, [copy.footworkWaiting, copy.liveWaiting, copy.notRecording]);

  const switchTrainingModule = useCallback((nextModule: TrainingModule) => {
    if (recordingRef.current || nextModule === trainingModuleRef.current) return;
    resetSet();
    setTrainingModule(nextModule);
    trainingModuleRef.current = nextModule;
    setCurrentMessage(copy.notRecording);
  }, [copy.notRecording, resetSet]);

  const saveCurrentSession = useCallback((sessionSummary: AnalysisSummary) => {
    if (!movementsRef.current.length) return;
    const session: MotionSession = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      trainingModule: trainingModuleRef.current,
      drillMode: trainingModuleRef.current === "stroke" ? modeRef.current : footworkModeRef.current,
      preferredHand: preferredHandRef.current,
      movements: [...movementsRef.current],
      summary: sessionSummary,
    };
    const optimistic = [session, ...history].slice(0, 12);
    setHistory(optimistic);
    void saveMotionSession(session, 12).then((saved) => {
      setHistory(saved.filter(isMotionSession));
      setStorageStatus("indexeddb");
    }).catch(() => {
      window.localStorage.setItem(HISTORY_FALLBACK_KEY, JSON.stringify(optimistic));
      setStorageStatus("localstorage");
    });
  }, [history]);

  const toggleRecording = useCallback(() => {
    if (status !== "live") return;
    if (!recordingRef.current) {
      if (targetStatusRef.current !== "locked" || selectedTrackIdRef.current === null) {
        setCurrentMessage(copy.targetRequired);
        return;
      }
      resetSet("live");
      setCameraSettingsOpen(false);
      recordingRef.current = true;
      setRecording(true);
      setCurrentMessage(trainingModuleRef.current === "footwork" ? copy.footworkWaiting : copy.liveWaiting);
      return;
    }
    recordingRef.current = false;
    setRecording(false);
    const nextSummary = createSummary(movementsRef.current, language);
    setSummary(nextSummary);
    saveCurrentSession(nextSummary);
    onNavigate("sessions");
  }, [copy.footworkWaiting, copy.liveWaiting, copy.targetRequired, language, onNavigate, resetSet, saveCurrentSession, status]);

  const loadDemo = useCallback(() => {
    setSessionSetupOpen(false);
    const demo = createDemoMovements(trainingModule, mode, footworkMode, language);
    movementsRef.current = demo;
    nextIndexRef.current = demo.length + 1;
    setMovements(demo);
    setPreferredHand("right");
    setSource("demo");
    setSummary(createSummary(demo, language));
    onNavigate("sessions");
  }, [footworkMode, language, mode, onNavigate, trainingModule]);

  useEffect(() => {
    const handleDemo = () => loadDemo();
    window.addEventListener("smashlab:demo", handleDemo);
    return () => window.removeEventListener("smashlab:demo", handleDemo);
  }, [loadDemo]);

  const loadHistory = useCallback((session: MotionSession) => {
    const localized = session.movements.map((movement) => localizeAnalysisMovement(movement, language));
    movementsRef.current = localized;
    nextIndexRef.current = localized.length + 1;
    setMovements(localized);
    setSummary(createSummary(localized, language));
    const sessionModule = session.trainingModule ?? session.movements[0]?.module ?? "stroke";
    setTrainingModule(sessionModule);
    if (sessionModule === "footwork") setFootworkMode(session.drillMode as FootworkMode);
    else setMode(session.drillMode as TechniqueMode);
    setPreferredHand(session.preferredHand);
    setSource("history");
  }, [language]);

  const profileMovement = latest ?? movements[0] ?? null;
  const dateFormatter = useMemo(() => new Intl.DateTimeFormat(language === "vi" ? "vi-VN" : language === "de" ? "de-DE" : "en-US", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }), [language]);
  const localizedHistory = useMemo(() => history.map((session) => {
    const localized = session.movements.map((movement) => localizeAnalysisMovement(movement, language));
    return { ...session, movements: localized, summary: createSummary(localized, language) };
  }), [history, language]);

  return (
    <section id="live-studio" className={styles.module} aria-label={copy.title}>
      <header className={styles.moduleHeader} hidden={view !== "live"}>
        <div>
          <span>{copy.module}</span>
          <h2>{trainingModule === "footwork" ? copy.footworkTitle : copy.title}</h2>
          <p>{trainingModule === "footwork" ? copy.footworkDescription : copy.description}</p>
        </div>
      </header>

      <section className={styles.sessionSetupLauncher} hidden={view !== "live" || status === "live"}>
        <button
          type="button"
          onClick={() => setSessionSetupOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={sessionSetupOpen}
        >
          <span className={styles.sessionSetupIcon}><SlidersHorizontal /></span>
          <span className={styles.sessionSetupSummary}>
            <small>{copy.sessionSetup}</small>
            <strong>{trainingModule === "stroke"
              ? `${copy.strokeModule} · ${techniqueLabel(mode, language)}`
              : `${copy.footworkModule} · ${catalogLabel(footworkMode, language)}`}</strong>
            <em>{copy.sessionSummary}</em>
          </span>
          <span className={styles.sessionSetupPrivacy}><ShieldCheck />{copy.privacy}</span>
          <ChevronRight aria-hidden="true" />
        </button>
      </section>

      {view === "live" && sessionSetupOpen ? createPortal(<div
        className={styles.sessionSetupBackdrop}
        onPointerDown={(event) => {
          if (event.target === event.currentTarget) setSessionSetupOpen(false);
        }}
      >
        <section
          className={styles.sessionSetupModal}
          role="dialog"
          aria-modal="true"
          aria-labelledby="session-setup-title"
        >
          <header className={styles.sessionSetupModalHeader}>
            <div><span>{copy.module}</span><h3 id="session-setup-title">{copy.sessionSetup}</h3><p>{copy.sessionSetupCopy}</p></div>
            <button type="button" onClick={() => setSessionSetupOpen(false)} aria-label={copy.closeSessionSetup}><X /></button>
          </header>

          <div className={styles.sessionSetupPrivacyBanner}><ShieldCheck /><span>{copy.privacy}</span></div>

          <div className={styles.sessionSetupForm}>
            <div className={styles.modulePicker}>
              <span>{copy.moduleLabel}</span>
              <div className={styles.moduleSwitch}>
                <button type="button" className={trainingModule === "stroke" ? styles.moduleActive : ""} disabled={recording} onClick={() => switchTrainingModule("stroke")}><Target />{copy.strokeModule}</button>
                <button type="button" className={trainingModule === "footwork" ? styles.moduleActive : ""} disabled={recording} onClick={() => switchTrainingModule("footwork")}><Footprints />{copy.footworkModule}</button>
              </div>
            </div>
            <div className={styles.sessionSetupField}><span>{trainingModule === "stroke" ? copy.technique : copy.footwork}</span>
              {trainingModule === "stroke" ? <SessionDropdown<TechniqueMode>
                value={mode}
                disabled={recording}
                ariaLabel={copy.technique}
                onChange={setMode}
                options={TECHNIQUES.map((item) => ({ value: item.value, label: techniqueLabel(item.value, language) ?? item.value }))}
              /> : <SessionDropdown<FootworkMode>
                value={footworkMode}
                disabled={recording}
                ariaLabel={copy.footwork}
                onChange={setFootworkMode}
                options={(["foundation", "court_pattern", "advanced"] as const).flatMap((group) => FOOTWORK_CATALOG.filter((item) => item.group === group).map((item) => ({ value: item.value, label: catalogLabel(item.value, language) ?? item.value, group: FOOTWORK_GROUP_LABELS[group][language] })))}
              />}
            </div>
            <div className={styles.sessionSetupField}><span>{trainingModule === "footwork" ? copy.dominantSide : copy.hand}</span>
              <SessionDropdown<PreferredHand>
                value={preferredHand}
                disabled={recording}
                ariaLabel={trainingModule === "footwork" ? copy.dominantSide : copy.hand}
                onChange={setPreferredHand}
                options={[
                  { value: "auto", label: copy.autoHand },
                  { value: "right", label: copy.right },
                  { value: "left", label: copy.left },
                ]}
              />
            </div>
          </div>

          <section className={`${styles.readiness} ${styles.modalReadiness}`} aria-label={copy.engine}>
            <article className={status === "live" ? styles.ready : ""}><span>{status === "live" ? <Check /> : <Camera />}</span><div><small>{copy.camera}</small><strong>{status === "live" ? copy.cameraOn : copy.cameraOff}</strong></div></article>
            <article className={athleteDetected ? styles.ready : ""}><span>{athleteDetected ? <UserRoundCheck /> : <CircleDashed />}</span><div><small>{copy.athlete}</small><strong>{athleteDetected && selectedTrackId !== null ? `${copy.athleteReady} · #${selectedTrackId}` : targetStatus === "lost" ? copy.targetLost : copy.athleteMissing}</strong></div></article>
            <article className={workerStatus !== "checking" ? styles.ready : ""}><span>{workerStatus !== "checking" ? <Check /> : <CircleDashed />}</span><div><small>{copy.engine}</small><strong>{workerStatus !== "checking" ? copy.engineReady : "…"}</strong></div></article>
            <article className={storageStatus !== "checking" ? styles.ready : ""}><span><History /></span><div><small>{copy.storage}</small><strong>{storageStatus === "indexeddb" ? "IndexedDB" : storageStatus === "localstorage" ? "Local" : "…"}</strong></div></article>
          </section>

          <div className={styles.sessionSetupActions}>
            <button type="button" className={styles.secondaryButton} disabled={status === "loading"} onClick={() => void startCamera()}><Camera />{status === "loading" ? copy.opening : copy.openCamera}</button>
            <button type="button" className={styles.ghostButton} onClick={loadDemo}><Sparkles />{copy.demo}</button>
          </div>
        </section>
      </div>, document.body) : null}

      <div className={styles.liveWorkspace} hidden={view !== "live"}>
        <div className={`${styles.cameraStage} ${focusMode ? styles.focusMode : ""}`}>
          <video ref={videoRef} playsInline muted />
          <canvas
            ref={canvasRef}
            className={selectedTrackId === null ? styles.targetSelectionCanvas : styles.targetLockedCanvas}
            onPointerDown={selectAthleteFromCamera}
          />
          {focusReticle && pendingTarget ? <span
            key={focusReticle.token}
            className={styles.focusReticle}
            style={{ left: `${focusReticle.x}%`, top: `${focusReticle.y}%` }}
            aria-hidden="true"
          ><i /></span> : null}
          <div className={styles.cameraBadges}>
            <span className={status === "live" ? styles.liveBadge : ""}><i />{status === "live" ? systemCopy.live : systemCopy.off}</span>
            <span>{trainingModule === "stroke" ? TECHNIQUES.find((item) => item.value === mode)?.short : FOOTWORK_CATALOG.find((item) => item.value === footworkMode)?.short}</span>
            <span>{preferredHand === "left" ? copy.left.toUpperCase() : preferredHand === "right" ? copy.right.toUpperCase() : systemCopy.autoHandShort}</span>
            {status === "live" ? <button
              type="button"
              className={`${styles.cameraOptionsButton} ${cameraSettingsOpen ? styles.cameraBadgeActive : ""}`}
              disabled={recording}
              onClick={() => setCameraSettingsOpen((current) => !current)}
              aria-label={copy.cameraSettings}
              aria-expanded={cameraSettingsOpen}
            ><SlidersHorizontal /><span>{copy.options}</span></button> : null}
            <button type="button" onClick={() => setFocusMode((current) => !current)} aria-label={focusMode ? copy.exitFocus : copy.focus}>{focusMode ? <Minimize2 /> : <Maximize2 />}</button>
          </div>
          {status === "live" && cameraSettingsOpen ? <div className={styles.cameraQuickSettings}>
            <header>
              <div><span>{copy.setup}</span><strong>{copy.cameraSettings}</strong></div>
              <button type="button" onClick={() => setCameraSettingsOpen(false)} aria-label={copy.closeSettings}><X /></button>
            </header>
            <div className={styles.cameraModuleSwitch}>
              <button type="button" className={trainingModule === "stroke" ? styles.cameraModuleActive : ""} onClick={() => switchTrainingModule("stroke")}><Target />{copy.strokeModule}</button>
              <button type="button" className={trainingModule === "footwork" ? styles.cameraModuleActive : ""} onClick={() => switchTrainingModule("footwork")}><Footprints />{copy.footworkModule}</button>
            </div>
            <label><span>{trainingModule === "stroke" ? copy.technique : copy.footwork}</span>
              {trainingModule === "stroke" ? <select value={mode} onChange={(event) => setMode(event.target.value as TechniqueMode)}>{TECHNIQUES.map((item) => <option key={item.value} value={item.value}>{techniqueLabel(item.value, language)}</option>)}</select> : <select value={footworkMode} onChange={(event) => setFootworkMode(event.target.value as FootworkMode)}>{(["foundation", "court_pattern", "advanced"] as const).map((group) => <optgroup key={group} label={FOOTWORK_GROUP_LABELS[group][language]}>{FOOTWORK_CATALOG.filter((item) => item.group === group).map((item) => <option key={item.value} value={item.value}>{catalogLabel(item.value, language)}</option>)}</optgroup>)}</select>}
            </label>
            <label><span>{trainingModule === "footwork" ? copy.dominantSide : copy.hand}</span><select value={preferredHand} onChange={(event) => setPreferredHand(event.target.value as PreferredHand)}><option value="auto">{copy.autoHand}</option><option value="right">{copy.right}</option><option value="left">{copy.left}</option></select></label>
          </div> : null}
          {status === "live" ? <div className={`${styles.targetPicker} ${!targetPickerExpanded ? styles.targetPickerCompact : ""}`} aria-live="polite">
            <div className={styles.targetSummary}>
              <span>{copy.targetLabel}</span>
              <strong>{targetStatus === "locked" && selectedTrackId !== null
                ? <><ShieldCheck aria-hidden="true" />{`${copy.targetLocked} #${selectedTrackId}${selectedAthleteOption ? ` · ${shirtColorLabel(selectedAthleteOption.shirtColor, language)}` : ""}`}</>
                : targetStatus === "lost"
                  ? targetRecoveryProgress > 0 ? `${copy.targetRecovering} · ${targetRecoveryProgress}%` : copy.targetLost
                  : copy.targetSelect}</strong>
              <small>{selectedTrackId === null && targetPickerExpanded
                ? `${visibleAthletes.length} ${copy.detectedPeople} · ${copy.targetGuide}`
                : selectedAthleteOption
                  ? `${positionLabel(selectedAthleteOption.position, language)} · ${copy.lockConfidence} ${selectedAthleteOption.lockConfidence}%`
                  : `${visibleAthletes.length} ${copy.detectedPeople}`}</small>
              {(targetStatus === "locked" || targetStatus === "lost") && !recording ? <button
                type="button"
                className={styles.targetChange}
                onClick={beginTargetChange}
              >{copy.changeTarget}</button> : null}
            </div>
            {selectedTrackId === null && targetPickerExpanded && visibleAthletes.length ? <div className={styles.targetButtons} aria-label={copy.targetLabel}>
              {visibleAthletes.map((athlete) => <button
                type="button"
                key={athlete.trackId}
                className={pendingTarget?.trackId === athlete.trackId ? styles.targetActive : ""}
                disabled={recording}
                onClick={() => requestAthleteSelection(athlete.trackId)}
                aria-label={`${language === "vi" ? "Khóa VĐV" : language === "de" ? "Athleten fixieren" : "Lock athlete"} ${athlete.trackId}, ${shirtColorLabel(athlete.shirtColor, language)}, ${positionLabel(athlete.position, language)}`}
                aria-pressed={pendingTarget?.trackId === athlete.trackId}
              >
                <i
                  className={styles.shirtSwatch}
                  style={{ "--shirt-color": shirtColorCss(athlete.shirtColor) } as CSSProperties}
                  aria-hidden="true"
                />
                <span className={styles.targetOptionCopy}>
                  <strong>{language === "vi" ? "VĐV" : language === "de" ? "Athlet" : "Athlete"} {athlete.trackId}</strong>
                  <small>{shirtColorLabel(athlete.shirtColor, language)} · {positionLabel(athlete.position, language)}</small>
                  <em className={athlete.lockReady ? styles.targetOptionReady : ""}>
                    {athlete.lockReady ? copy.targetReady : `${copy.targetVerifying} · ${athlete.lockConfidence}%`}
                  </em>
                </span>
                {pendingTarget?.trackId === athlete.trackId ? <Check aria-hidden="true" /> : null}
              </button>)}
            </div> : null}
          </div> : null}
          {pendingTarget ? <div
            className={styles.targetConfirmBackdrop}
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) cancelAthleteSelection();
            }}
          >
            <div
              ref={targetConfirmDialogRef}
              className={styles.targetConfirmDialog}
              role="dialog"
              aria-modal="true"
              aria-labelledby="target-confirm-title"
              aria-describedby="target-confirm-copy"
            >
              <span>{copy.targetLabel}</span>
              <h3 id="target-confirm-title">{copy.confirmTargetTitle}</h3>
              <p id="target-confirm-copy">{pendingTargetVisible ? copy.confirmTargetCopy : copy.targetUnavailable}</p>
              <div className={styles.targetConfirmAthlete}>
                <i
                  className={styles.shirtSwatch}
                  style={{ "--shirt-color": shirtColorCss(pendingTargetDisplay?.shirtColor ?? pendingTarget.shirtColor) } as CSSProperties}
                  aria-hidden="true"
                />
                <div>
                  <strong>{language === "vi" ? "VĐV" : language === "de" ? "Athlet" : "Athlete"} {pendingTarget.trackId}</strong>
                  <small>{shirtColorLabel(pendingTargetDisplay?.shirtColor ?? pendingTarget.shirtColor, language)} · {positionLabel(pendingTargetDisplay?.position ?? pendingTarget.position, language)}</small>
                </div>
                <ShieldCheck aria-hidden="true" />
              </div>
              <div className={styles.targetConfidence}>
                <div><span>{copy.lockConfidence}</span><strong>{pendingTargetDisplay?.lockConfidence ?? 0}%</strong></div>
                <span aria-hidden="true"><i style={{ width: `${pendingTargetDisplay?.lockConfidence ?? 0}%` }} /></span>
                <small>{pendingTargetReady ? copy.targetReady : copy.targetVerifying}</small>
              </div>
              <div className={styles.targetLockDetails}>
                <span><CircleDashed aria-hidden="true" />{copy.lockSignals}</span>
                <span><ShieldCheck aria-hidden="true" />{copy.lockSafety}</span>
              </div>
              <div className={styles.targetConfirmActions}>
                <button type="button" onClick={cancelAthleteSelection}>{copy.chooseAgain}</button>
                <button type="button" disabled={!pendingTargetVisible || !pendingTargetReady} onClick={confirmAthleteSelection}><UserRoundCheck />{copy.confirmTarget}</button>
              </div>
            </div>
          </div> : null}
          {status !== "live" ? <div className={styles.cameraEmpty}><span>{trainingModule === "footwork" ? <Footprints /> : <Activity />}</span><h3>{copy.cameraTitle}</h3><p>{trainingModule === "footwork" ? copy.footworkCameraCopy : copy.cameraCopy}</p><button type="button" onClick={() => void startCamera()} disabled={status === "loading"}><Camera />{status === "loading" ? copy.opening : copy.openCamera}</button></div> : null}
          {status === "live" ? <div className={styles.cameraControls}>
            <div className={styles.cameraControlGroup}>
              <button
                type="button"
                className={`${styles.recordControl} ${recording ? styles.recordControlActive : ""}`}
                disabled={!recording && targetStatus !== "locked"}
                onClick={toggleRecording}
                aria-label={recording ? copy.stopSet : copy.startSet}
              ><span aria-hidden="true" /></button>
              <small>{recording ? copy.stopSet : targetStatus === "locked" ? copy.startSet : copy.targetRequired}</small>
            </div>
            <div className={styles.cameraControlGroup}>
              <button
                type="button"
                className={styles.cameraOffControl}
                disabled={recording}
                onClick={stopCamera}
                aria-label={copy.stopCamera}
                title={recording ? copy.stopSet : copy.stopCamera}
              ><CameraOff aria-hidden="true" /></button>
              <small>{copy.stopCamera}</small>
            </div>
          </div> : null}
          <div className={styles.liveEvent}><span>{recording ? copy.recording : copy.phase}</span><strong>{recording ? currentMessage : status === "live" ? trainingModule === "footwork" ? liveFootworkPhaseLabel(metrics, language) : livePhaseLabel(metrics.phase, language) : trainingModule === "footwork" ? copy.footworkWaiting : copy.liveWaiting}</strong></div>
          {recording ? <div className={styles.recordingPulse} aria-hidden="true" /> : null}
        </div>

        <aside className={styles.livePanel}>
          <div className={styles.panelHeading}><div><span>{copy.liveMetrics}</span><strong>{trainingModule === "footwork" ? liveFootworkPhaseLabel(metrics, language) : livePhaseLabel(metrics.phase, language)}</strong></div>{trainingModule === "footwork" ? <Footprints /> : <Activity />}</div>
          <div className={styles.metricGrid}>
            {trainingModule === "footwork" ? <>
              <article><span>{copy.footSpeed}</span><strong>{metrics.footSpeed.toFixed(2)}<small>rel/s</small></strong><i style={{ "--metric": `${Math.min(100, metrics.footSpeed * 28)}%` } as CSSProperties} /></article>
              <article><span>{copy.centerSpeed}</span><strong>{metrics.centerSpeed.toFixed(2)}<small>rel/s</small></strong><i style={{ "--metric": `${Math.min(100, metrics.centerSpeed * 40)}%` } as CSSProperties} /></article>
              <article><span>{copy.stance}</span><strong>{metrics.stanceWidth.toFixed(2)}<small>{systemCopy.bodyScaleUnit}</small></strong><i style={{ "--metric": `${Math.min(100, metrics.stanceWidth * 75)}%` } as CSSProperties} /></article>
              <article><span>{copy.knee}</span><strong>{Math.round(metrics.kneeFlexion)}<small>°</small></strong><i style={{ "--metric": `${Math.min(100, metrics.kneeFlexion * 1.6)}%` } as CSSProperties} /></article>
              <article><span>{copy.landing}</span><strong>{Math.round(metrics.landingSymmetry)}<small>%</small></strong><i style={{ "--metric": `${metrics.landingSymmetry}%` } as CSSProperties} /></article>
              <article><span>{copy.balance}</span><strong>{Math.round(metrics.balanceScore)}<small>%</small></strong><i style={{ "--metric": `${metrics.balanceScore}%` } as CSSProperties} /></article>
            </> : <>
              <article><span>{copy.elbow}</span><strong>{Math.round(metrics.elbowAngle)}<small>°</small></strong><i style={{ "--metric": `${Math.min(100, metrics.elbowAngle / 1.8)}%` } as CSSProperties} /></article>
              <article><span>{copy.shoulder}</span><strong>{Math.round(metrics.shoulderAngle)}<small>°</small></strong><i style={{ "--metric": `${Math.min(100, metrics.shoulderAngle / 1.6)}%` } as CSSProperties} /></article>
              <article><span>{copy.rotation}</span><strong>{Math.round(metrics.trunkRotation)}<small>°</small></strong><i style={{ "--metric": `${Math.min(100, metrics.trunkRotation * 1.8)}%` } as CSSProperties} /></article>
              <article><span>{copy.knee}</span><strong>{Math.round(metrics.kneeFlexion)}<small>°</small></strong><i style={{ "--metric": `${Math.min(100, metrics.kneeFlexion * 1.6)}%` } as CSSProperties} /></article>
              <article><span>{copy.extension}</span><strong>{Math.round(metrics.bodyExtension)}<small>%</small></strong><i style={{ "--metric": `${metrics.bodyExtension}%` } as CSSProperties} /></article>
              <article><span>{copy.balance}</span><strong>{Math.round(metrics.balanceScore)}<small>%</small></strong><i style={{ "--metric": `${metrics.balanceScore}%` } as CSSProperties} /></article>
            </>}
          </div>
          <div className={styles.liveReps}>
            <div><span>{copy.reps}</span><strong>{movements.length}</strong></div>
            <div><span>{copy.score}</span><strong>{activeSummary?.averageScore ?? 0}</strong></div>
            <div><span>{copy.capture}</span><strong>{averageCapture}%</strong></div>
          </div>
          <div className={styles.latestCard}>
            <span>{copy.latest}</span>
            {latest ? <><strong>{latest.label} · {latest.overallScore}/100</strong><p>{latest.summary}</p><button type="button" onClick={() => onAskCoach(`${language === "vi" ? "Phân tích lần lặp" : language === "de" ? "Wiederholung analysieren" : "Analyze repetition"} ${latest.index}: ${latest.summary}`)}><MessageCircleMore />{copy.askCoach}</button></> : <p>{trainingModule === "footwork" ? copy.noFootworkReps : copy.noReps}</p>}
          </div>
          <p className={styles.privacyLine}><ShieldCheck />{copy.privacy}</p>
        </aside>
      </div>

      {errorMessage && view === "live" ? <p className={styles.errorMessage}>{errorMessage}</p> : null}

      <div className={styles.reportWorkspace} hidden={view !== "sessions"}>
        <section className={styles.reportHero}>
          <div><span>{source === "demo" ? copy.demoNotice : copy.reportTitle}</span><h2>{activeSummary?.headline ?? copy.reportEmpty}</h2><p>{activeSummary?.insight ?? copy.reportEmptyCopy}</p></div>
          <div className={styles.reportActions}><button type="button" className={styles.secondaryButton} onClick={() => { resetSet(); onNavigate("live"); }}><Camera />{copy.backLive}</button><button type="button" className={styles.primaryButton} disabled={!movements.length} onClick={() => onAskCoach(language === "vi" ? "Hãy phân tích toàn bộ set Motion Capture này và cho tôi 3 ưu tiên kỹ thuật cụ thể." : language === "de" ? "Analysiere diese Motion-Capture-Einheit und nenne mir drei konkrete Technikprioritäten." : "Analyze this Motion Capture session and give me three concrete technique priorities.")}><MessageCircleMore />{copy.askCoach}</button></div>
        </section>

        <section className={styles.scoreOverview}>
          <ScoreRing value={activeSummary?.averageScore ?? 0} label={copy.score} />
          <article><span>{copy.reps}</span><strong>{movements.length}</strong><small>{trainingModule === "stroke" ? techniqueLabel(mode, language) : footworkLabel(footworkMode, language)}</small></article>
          <article><span>{copy.consistency}</span><strong>{activeSummary?.consistency ?? 0}<small>%</small></strong><small>{language === "vi" ? "so sánh giữa các lần lặp" : language === "de" ? "über alle Wiederholungen hinweg" : "across repetitions"}</small></article>
          <article><span>{copy.capture}</span><strong>{averageCapture}<small>%</small></strong><small>{language === "vi" ? "độ rõ và toàn thân" : language === "de" ? "Sichtbarkeit und Ganzkörper" : "visibility and full body"}</small></article>
        </section>

        {profileMovement ? <div className={styles.reportGrid}>
          <section className={styles.profilePanel}>
            <div className={styles.panelHeading}><div><span>{trainingModule === "footwork" ? language === "vi" ? "Hồ sơ bộ pháp" : language === "de" ? "Beinarbeitsprofil" : "Footwork profile" : copy.profile}</span><strong>{profileMovement.label}</strong></div>{trainingModule === "footwork" ? <Footprints /> : <Target />}</div>
            <div className={styles.profileBody}><TechniqueRadar movement={profileMovement} ariaLabel={systemCopy.techniqueChart} /><div className={styles.profileLegend}><span><i />{language === "vi" ? "Tư thế" : language === "de" ? "Haltung" : "Posture"}<strong>{profileMovement.postureScore}</strong></span><span><i />{language === "vi" ? "Nhịp" : language === "de" ? "Rhythmus" : "Rhythm"}<strong>{profileMovement.rhythmScore}</strong></span><span><i />{language === "vi" ? "Hồi vị" : language === "de" ? "Rückkehr" : "Recovery"}<strong>{profileMovement.recoveryScore}</strong></span><span><i />{copy.balance}<strong>{profileMovement.metrics.balance}</strong></span>{trainingModule === "stroke" && profileMovement.biomechanicsScore !== undefined ? <span><i />{language === "vi" ? "Cơ sinh học" : language === "de" ? "Biomechanik" : "Biomechanics"}<strong>{profileMovement.biomechanicsScore}</strong></span> : null}<span><i />{copy.capture}<strong>{profileMovement.captureQuality}</strong></span></div></div>
          </section>

          <section className={styles.phasePanel}>
            <div className={styles.panelHeading}><div><span>{trainingModule === "footwork" ? language === "vi" ? "Chất lượng 4 pha" : language === "de" ? "Qualität der vier Phasen" : "Four-phase quality" : copy.phaseQuality}</span><strong>{trainingModule === "footwork" ? language === "vi" ? "Chu kỳ bộ pháp BWF" : language === "de" ? "BWF-Bewegungszyklus" : "BWF movement cycle" : language === "vi" ? "Chuỗi kỹ thuật hoàn chỉnh" : language === "de" ? "Vollständiger Bewegungsablauf" : "Complete motion sequence"}</strong></div><TrendingUp /></div>
            <div className={styles.phaseList}>{profileMovement.phases.map((phase, index) => <article key={phase.phase} className={styles[phase.status]}><span>{String(index + 1).padStart(2, "0")}</span><div><strong>{phaseLabel(phase.phase, language)}</strong><i><b style={{ width: `${phase.score}%` }} /></i></div><em>{phase.score}</em></article>)}</div>
          </section>

          {trainingModule === "footwork" ? <section className={styles.footworkMetricsPanel}>
            <div className={styles.panelHeading}><div><span>{language === "vi" ? "Dấu hiệu chân" : language === "de" ? "Unterkörpersignale" : "Lower-body signals"}</span><strong>{language === "vi" ? "Đỉnh trong chu kỳ" : language === "de" ? "Spitzen im Zyklus" : "Cycle peaks"}</strong></div><Gauge /></div>
            <div>
              <article><span>{copy.footSpeed}</span><strong>{profileMovement.metrics.footSpeed?.toFixed(2) ?? "0.00"}<small> rel/s</small></strong></article>
              <article><span>{copy.centerSpeed}</span><strong>{profileMovement.metrics.centerSpeed?.toFixed(2) ?? "0.00"}<small> rel/s</small></strong></article>
              <article><span>{copy.stance}</span><strong>{profileMovement.metrics.stanceWidth?.toFixed(2) ?? "0.00"}<small> ×</small></strong></article>
              <article><span>{copy.landing}</span><strong>{profileMovement.metrics.landingSymmetry ?? 0}<small>%</small></strong></article>
              <article><span>{language === "vi" ? "Biên độ dịch chuyển" : language === "de" ? "Relativer Bewegungsumfang" : "Relative travel"}</span><strong>{profileMovement.metrics.travel?.toFixed(2) ?? "0.00"}<small> rel</small></strong></article>
              <article><span>{language === "vi" ? "Luân phiên chân" : language === "de" ? "Fußwechsel" : "Foot alternation"}</span><strong>{profileMovement.metrics.alternation ?? 0}<small>%</small></strong></article>
            </div>
          </section> : null}

          <section className={styles.coachingPanel}>
            <div><span className={styles.coachingIcon}><Check /></span><div><small>{copy.strengths}</small>{profileMovement.strengths.map((item) => <p key={item}>{item}</p>)}</div></div>
            <div><span className={styles.priorityIcon}><Zap /></span><div><small>{copy.corrections}</small>{profileMovement.corrections.map((item) => <p key={item}>{item}</p>)}</div></div>
          </section>

          <section className={styles.repetitionPanel}>
            <div className={styles.panelHeading}><div><span>{copy.repetitions}</span><strong>{movements.length} {language === "de" ? copy.reps : copy.reps.toLowerCase()}</strong></div><Dumbbell /></div>
            <div className={styles.repetitionList}>{movements.slice().reverse().map((movement) => <article key={movement.index}><span>{String(movement.index).padStart(2, "0")}</span><div><strong>{movement.label}</strong><small>{movement.corrections[0] ?? movement.summary}</small></div><div><strong>{movement.overallScore}</strong><small>{movement.captureQuality}% {language === "vi" ? "khung hình" : language === "de" ? "Erfassung" : "capture"}</small></div><button type="button" onClick={() => onAskCoach(`${language === "vi" ? "Giải thích lần lặp" : language === "de" ? "Wiederholung erklären" : "Explain repetition"} ${movement.index}: ${movement.summary}`)} aria-label={copy.askCoach}><MessageCircleMore /></button></article>)}</div>
          </section>

          <section className={styles.historyPanel}>
            <div className={styles.panelHeading}><div><span>{copy.recent}</span><strong>{history.length}/12</strong></div><History /></div>
            <div className={styles.historyList}>{localizedHistory.length ? localizedHistory.map((session) => <button type="button" key={session.id} onClick={() => loadHistory(session)}><span><strong>{session.summary.headline}</strong><small>{dateFormatter.format(new Date(session.createdAt))}</small></span><ChevronRight /></button>) : <p>{copy.noHistory}</p>}</div>
          </section>
        </div> : null}

        <p className={styles.limitation}><ShieldCheck />{trainingModule === "footwork" ? copy.footworkLimitation : copy.limitation}</p>
      </div>

      <section className={styles.diagnostics} hidden={view !== "settings"}>
        <div><span>{copy.diagnostics}</span><h2>{copy.diagnostics}</h2><p>{copy.diagnosticsCopy}</p></div>
        <div className={styles.diagnosticGrid}>
          <article><Activity /><span><small>{systemCopy.poseModel}</small><strong>{systemCopy.poseModelDetail}</strong><em>{workerStatus === "ready" ? systemCopy.workerReady : systemCopy.workerFallback}</em></span></article>
          <article><Armchair /><span><small>{systemCopy.motionFeatures}</small><strong>{systemCopy.motionFeaturesDetail}</strong><em>{systemCopy.sixPhaseAssessment}</em></span></article>
          <article><Footprints /><span><small>{systemCopy.footworkEngine}</small><strong>{systemCopy.footworkEngineDetail}</strong><em>{systemCopy.fourPhaseCycle}</em></span></article>
          <article><Hand /><span><small>{systemCopy.racketHand}</small><strong>{preferredHand === "auto" ? copy.autoHand : preferredHand === "right" ? copy.right : copy.left}</strong><em>{systemCopy.lockedPerSession}</em></span></article>
          <article><ShieldCheck /><span><small>{systemCopy.privacy}</small><strong>{systemCopy.onDeviceVideo}</strong><em>{systemCopy.reducedMetricsOnly}</em></span></article>
        </div>
        <button type="button" className={styles.secondaryButton} onClick={() => { resetSet(); setMetrics(initialMetrics); }}><RotateCcw />{language === "vi" ? "Xóa set đang hiển thị" : language === "de" ? "Aktuelles Set löschen" : "Clear current set"}</button>
      </section>
    </section>
  );
}
