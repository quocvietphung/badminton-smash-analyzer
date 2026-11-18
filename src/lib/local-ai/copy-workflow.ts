// User-visible copy for the run workflow, uploads, the AI model panel, statistics, exports and site sign-in.
// Every string exists in English, Vietnamese and German.
import type { StudioLanguage } from "@/lib/studio-types";

export type WorkflowCopy = {
  signInTitle: string;
  signInBody: string;
  signInPassword: string;
  signInButton: string;
  signInFailed: string;
  signOut: string;
  accessChecking: string;
  accessMisconfigured: string;
  offlineTitle: string;
  offlineBody: string;
  sampleTitle: string;
  sampleIntro: string;
  sampleFile: string;
  sampleDuration: string;
  sampleResolution: string;
  sampleFps: string;
  sampleFrames: string;
  sampleLicence: string;
  sampleMissing: string;
  selectedSample: string;
  runAnalysis: string;
  runNotice: string;
  openCached: string;
  cachedLabel: string;
  cachedNotice: string;
  mode: string;
  modeAuto: string;
  modeSingles: string;
  modeDoubles: string;
  estimateLabel: string;
  estimateNote: string;
  elapsedLabel: string;
  stageLabel: string;
  uploadTitle: string;
  uploadIntro: string;
  uploadButton: string;
  uploadProgress: string;
  uploadTypeError: string;
  uploadSizeError: string;
  uploadFailed: string;
  modelsTitle: string;
  modelsIntro: string;
  modelRan: string;
  modelNotRun: string;
  modelUnknown: string;
  modelNotRecorded: string;
  modelFile: string;
  modelDigest: string;
  modelCheckpoint: string;
  modelProviders: string;
  modelLicence: string;
  modelFrames: string;
  modelWindows: string;
  modelReason: string;
  modelDevice: string;
  modelThreads: string;
  modelRuntime: string;
  modelTiming: string;
  modelAnalyseSeconds: string;
  modelProcessingFps: string;
  modelWallSeconds: string;
  modelPeakMemory: string;
  modelNotImplemented: string;
  statsTitle: string;
  statsIntro: string;
  statFrames: string;
  statShuttle: string;
  statShuttleNote: string;
  statIdentity: string;
  statEvents: string;
  statCorrections: string;
  statRally: string;
  statRallyNote: string;
  statShots: string;
  statShotsUnsupported: string;
  statShotsNotEvaluated: string;
  statShotsEstimate: string;
  statDuration: string;
  statModel: string;
  statNotEvaluated: string;
  statAccuracyNote: string;
  exportsTitle: string;
  exportsIntro: string;
  exportDownload: string;
  exportMissing: string;
};

const EN: WorkflowCopy = {
  signInTitle: "Sign in to SmashLab",
  signInBody: "This studio is protected. Enter the site password to use the local analysis.",
  signInPassword: "Password",
  signInButton: "Sign in",
  signInFailed: "The password is not correct.",
  signOut: "Sign out",
  accessChecking: "Checking access…",
  accessMisconfigured: "The site sign-in is not configured on the server.",
  offlineTitle: "Local AI backend offline",
  offlineBody: "Start Docker on the Mac. Analyses run on the Mac, so they cannot start while it is offline.",
  sampleTitle: "Sample library",
  sampleIntro: "Choose a clip, play the original, then run a new AI analysis on the Mac. Samples are referenced by server-side IDs.",
  sampleFile: "File",
  sampleDuration: "Duration",
  sampleResolution: "Resolution",
  sampleFps: "Frame rate",
  sampleFrames: "Frames",
  sampleLicence: "Licence",
  sampleMissing: "File not on disk",
  selectedSample: "Selected sample",
  runAnalysis: "Run AI Analysis",
  runNotice: "Each run starts a new inference job on the Mac. Earlier results are never shown as new runs.",
  openCached: "Open saved result (cached)",
  cachedLabel: "Cached",
  cachedNotice: "This is a saved result from an earlier run. No new inference was started.",
  mode: "Players",
  modeAuto: "Automatic",
  modeSingles: "Singles",
  modeDoubles: "Doubles",
  estimateLabel: "Estimated remaining",
  estimateNote: "Estimated from this run's measured progress so far.",
  elapsedLabel: "Elapsed",
  stageLabel: "Current stage",
  uploadTitle: "Upload video & analyze",
  uploadIntro: "Send your own MP4 or MOV (up to 200 MB, 120 s). The file goes straight to the local backend.",
  uploadButton: "Upload video & analyze",
  uploadProgress: "Uploading",
  uploadTypeError: "Only MP4 or MOV files can be analysed.",
  uploadSizeError: "The file is larger than 200 MB.",
  uploadFailed: "The upload did not finish. Nothing was analysed.",
  modelsTitle: "AI model testing",
  modelsIntro: "What the backend recorded for this analysis. A model counts as run only when its record confirms it.",
  modelRan: "Ran",
  modelNotRun: "Not run",
  modelUnknown: "No record",
  modelNotRecorded: "No model record exists for this analysis (it was created before this build). Nothing is assumed.",
  modelFile: "File",
  modelDigest: "SHA-256",
  modelCheckpoint: "Checkpoint",
  modelProviders: "Execution providers",
  modelLicence: "Licence",
  modelFrames: "Frames processed",
  modelWindows: "Windows processed",
  modelReason: "Reason",
  modelDevice: "Device",
  modelThreads: "Threads",
  modelRuntime: "Runtime",
  modelTiming: "Measured timing",
  modelAnalyseSeconds: "Inference time (s)",
  modelProcessingFps: "Processing speed (frames/s)",
  modelWallSeconds: "Total wall time (s)",
  modelPeakMemory: "Peak memory (MB)",
  modelNotImplemented: "Not implemented in this build",
  statsTitle: "Measured statistics",
  statsIntro: "Measured values from this analysis. Detection coverage shows how often something was detected; it is not accuracy.",
  statFrames: "Analysed frames",
  statShuttle: "Shuttle detection coverage",
  statShuttleNote: "Share of frames with a shuttle position (detections and interpolated frames).",
  statIdentity: "Identity coverage per player",
  statEvents: "Identity events",
  statCorrections: "Manual corrections",
  statRally: "Rally candidates",
  statRallyNote: "Heuristic gaps in shuttle detections. Not validated.",
  statShots: "Shot counts",
  statShotsUnsupported: "Not supported in this build (no validated shot classifier)",
  statShotsNotEvaluated: "Not evaluated (no ground truth)",
  statShotsEstimate: "Contact candidates on the Shot timeline. Each has a trajectory estimate, unverified.",
  statDuration: "Processing duration",
  statModel: "Model execution",
  statNotEvaluated: "Accuracy: not evaluated (no ground truth)",
  statAccuracyNote: "Coverage and event counts are not accuracy scores.",
  exportsTitle: "Exports",
  exportsIntro: "The annotated video with the AI analysis overlay. The analysis data (JSON) goes to the AI Coach automatically.",
  exportDownload: "Download annotated video (MP4)",
  exportMissing: "Not produced for this analysis",
};

const VI: WorkflowCopy = {
  signInTitle: "Đăng nhập SmashLab",
  signInBody: "Studio này được bảo vệ. Nhập mật khẩu của trang để dùng phân tích cục bộ.",
  signInPassword: "Mật khẩu",
  signInButton: "Đăng nhập",
  signInFailed: "Mật khẩu chưa đúng.",
  signOut: "Đăng xuất",
  accessChecking: "Đang kiểm tra quyền truy cập…",
  accessMisconfigured: "Đăng nhập của trang chưa được cấu hình trên máy chủ.",
  offlineTitle: "Backend AI cục bộ đang ngoại tuyến",
  offlineBody: "Hãy khởi động Docker trên máy Mac. Việc phân tích chạy trên máy Mac nên không thể bắt đầu khi máy ngoại tuyến.",
  sampleTitle: "Thư viện video mẫu",
  sampleIntro: "Chọn một clip, xem video gốc, rồi chạy phân tích AI mới trên máy Mac. Mẫu được tham chiếu bằng ID phía máy chủ.",
  sampleFile: "Tệp",
  sampleDuration: "Thời lượng",
  sampleResolution: "Độ phân giải",
  sampleFps: "Tốc độ khung hình",
  sampleFrames: "Số khung",
  sampleLicence: "Giấy phép",
  sampleMissing: "Chưa có tệp trên máy",
  selectedSample: "Mẫu đã chọn",
  runAnalysis: "Chạy phân tích AI",
  runNotice: "Mỗi lần chạy tạo một job suy luận mới trên máy Mac. Kết quả cũ không bao giờ được hiển thị như lần chạy mới.",
  openCached: "Mở kết quả đã lưu (cache)",
  cachedLabel: "Cache",
  cachedNotice: "Đây là kết quả đã lưu từ lần chạy trước. Không có suy luận mới nào được khởi động.",
  mode: "Số người chơi",
  modeAuto: "Tự động",
  modeSingles: "Đơn",
  modeDoubles: "Đôi",
  estimateLabel: "Ước tính còn lại",
  estimateNote: "Ước tính từ tiến độ đo được của lần chạy này cho đến nay.",
  elapsedLabel: "Đã chạy",
  stageLabel: "Giai đoạn hiện tại",
  uploadTitle: "Tải video lên & phân tích",
  uploadIntro: "Gửi tệp MP4 hoặc MOV của bạn (tối đa 200 MB, 120 giây). Tệp được gửi thẳng tới backend cục bộ.",
  uploadButton: "Tải video lên & phân tích",
  uploadProgress: "Đang tải lên",
  uploadTypeError: "Chỉ phân tích được tệp MP4 hoặc MOV.",
  uploadSizeError: "Tệp lớn hơn 200 MB.",
  uploadFailed: "Tải lên chưa hoàn tất. Không có gì được phân tích.",
  modelsTitle: "Kiểm thử mô hình AI",
  modelsIntro: "Những gì backend đã ghi cho phân tích này. Một mô hình chỉ được coi là đã chạy khi bản ghi của nó xác nhận.",
  modelRan: "Đã chạy",
  modelNotRun: "Chưa chạy",
  modelUnknown: "Không có bản ghi",
  modelNotRecorded: "Phân tích này chưa có bản ghi mô hình (được tạo trước bản build này). Không có gì được giả định.",
  modelFile: "Tệp",
  modelDigest: "SHA-256",
  modelCheckpoint: "Checkpoint",
  modelProviders: "Nhà cung cấp thực thi",
  modelLicence: "Giấy phép",
  modelFrames: "Khung đã xử lý",
  modelWindows: "Cửa sổ đã xử lý",
  modelReason: "Lý do",
  modelDevice: "Thiết bị",
  modelThreads: "Luồng",
  modelRuntime: "Môi trường chạy",
  modelTiming: "Thời gian đo được",
  modelAnalyseSeconds: "Thời gian suy luận (s)",
  modelProcessingFps: "Tốc độ xử lý (khung/s)",
  modelWallSeconds: "Tổng thời gian chạy (s)",
  modelPeakMemory: "Bộ nhớ cao nhất (MB)",
  modelNotImplemented: "Chưa được triển khai trong bản này",
  statsTitle: "Thống kê đo được",
  statsIntro: "Số đo từ phân tích này. Độ phủ phát hiện cho biết tần suất phát hiện được; đó không phải độ chính xác.",
  statFrames: "Khung đã phân tích",
  statShuttle: "Độ phủ phát hiện quả cầu",
  statShuttleNote: "Tỷ lệ khung có vị trí quả cầu (gồm phát hiện và khung nội suy).",
  statIdentity: "Độ phủ định danh theo người chơi",
  statEvents: "Sự kiện định danh",
  statCorrections: "Hiệu chỉnh thủ công",
  statRally: "Ứng viên rally",
  statRallyNote: "Khoảng trống theo heuristic trong phát hiện cầu. Chưa được kiểm chứng.",
  statShots: "Số cú đánh",
  statShotsUnsupported: "Chưa hỗ trợ trong bản này (chưa có bộ phân loại cú đánh đã kiểm chứng)",
  statShotsNotEvaluated: "Chưa đánh giá (không có ground truth)",
  statShotsEstimate: "Ứng viên cú đánh trên timeline. Mỗi cú có một ước lượng quỹ đạo, chưa xác thực.",
  statDuration: "Thời gian xử lý",
  statModel: "Thực thi mô hình",
  statNotEvaluated: "Độ chính xác: chưa đánh giá (không có ground truth)",
  statAccuracyNote: "Độ phủ và số sự kiện không phải điểm độ chính xác.",
  exportsTitle: "Tệp xuất",
  exportsIntro: "Video chú thích có lớp phủ phân tích AI. Dữ liệu phân tích (JSON) được chuyển cho AI Coach tự động.",
  exportDownload: "Tải video chú thích (MP4)",
  exportMissing: "Không được tạo cho phân tích này",
};

const DE: WorkflowCopy = {
  signInTitle: "Bei SmashLab anmelden",
  signInBody: "Dieses Studio ist geschützt. Gib das Passwort der Seite ein, um die lokale Analyse zu nutzen.",
  signInPassword: "Passwort",
  signInButton: "Anmelden",
  signInFailed: "Das Passwort ist nicht korrekt.",
  signOut: "Abmelden",
  accessChecking: "Zugriff wird geprüft…",
  accessMisconfigured: "Die Anmeldung der Seite ist auf dem Server nicht konfiguriert.",
  offlineTitle: "Lokales KI-Backend offline",
  offlineBody: "Starte Docker auf dem Mac. Analysen laufen auf dem Mac und können daher nicht starten, solange er offline ist.",
  sampleTitle: "Beispielbibliothek",
  sampleIntro: "Wähle einen Clip, spiele das Original ab und starte dann eine neue KI-Analyse auf dem Mac. Beispiele werden über serverseitige IDs angesprochen.",
  sampleFile: "Datei",
  sampleDuration: "Dauer",
  sampleResolution: "Auflösung",
  sampleFps: "Bildrate",
  sampleFrames: "Bilder",
  sampleLicence: "Lizenz",
  sampleMissing: "Datei fehlt auf dem Rechner",
  selectedSample: "Gewähltes Beispiel",
  runAnalysis: "KI-Analyse starten",
  runNotice: "Jeder Lauf startet einen neuen Inferenzauftrag auf dem Mac. Frühere Ergebnisse werden nie als neuer Lauf angezeigt.",
  openCached: "Gespeichertes Ergebnis öffnen (Cache)",
  cachedLabel: "Cache",
  cachedNotice: "Dies ist ein gespeichertes Ergebnis eines früheren Laufs. Es wurde keine neue Inferenz gestartet.",
  mode: "Spieler",
  modeAuto: "Automatisch",
  modeSingles: "Einzel",
  modeDoubles: "Doppel",
  estimateLabel: "Geschätzte Restzeit",
  estimateNote: "Geschätzt aus dem bisher gemessenen Fortschritt dieses Laufs.",
  elapsedLabel: "Verstrichen",
  stageLabel: "Aktuelle Phase",
  uploadTitle: "Video hochladen & analysieren",
  uploadIntro: "Sende deine eigene MP4- oder MOV-Datei (bis 200 MB, 120 s). Die Datei geht direkt an das lokale Backend.",
  uploadButton: "Video hochladen & analysieren",
  uploadProgress: "Wird hochgeladen",
  uploadTypeError: "Nur MP4- oder MOV-Dateien können analysiert werden.",
  uploadSizeError: "Die Datei ist größer als 200 MB.",
  uploadFailed: "Der Upload wurde nicht abgeschlossen. Nichts wurde analysiert.",
  modelsTitle: "KI-Modelltest",
  modelsIntro: "Was das Backend für diese Analyse aufgezeichnet hat. Ein Modell gilt nur dann als gelaufen, wenn sein Eintrag das bestätigt.",
  modelRan: "Gelaufen",
  modelNotRun: "Nicht gelaufen",
  modelUnknown: "Kein Eintrag",
  modelNotRecorded: "Für diese Analyse gibt es keinen Modelleintrag (sie wurde vor diesem Build erstellt). Es wird nichts angenommen.",
  modelFile: "Datei",
  modelDigest: "SHA-256",
  modelCheckpoint: "Checkpoint",
  modelProviders: "Ausführungsanbieter",
  modelLicence: "Lizenz",
  modelFrames: "Verarbeitete Bilder",
  modelWindows: "Verarbeitete Fenster",
  modelReason: "Grund",
  modelDevice: "Gerät",
  modelThreads: "Threads",
  modelRuntime: "Laufzeit",
  modelTiming: "Gemessene Zeiten",
  modelAnalyseSeconds: "Inferenzzeit (s)",
  modelProcessingFps: "Verarbeitungsgeschwindigkeit (Bilder/s)",
  modelWallSeconds: "Gesamtlaufzeit (s)",
  modelPeakMemory: "Speicherspitze (MB)",
  modelNotImplemented: "In diesem Build nicht implementiert",
  statsTitle: "Gemessene Statistik",
  statsIntro: "Gemessene Werte dieser Analyse. Die Erkennungsabdeckung zeigt, wie oft etwas erkannt wurde; sie ist keine Genauigkeit.",
  statFrames: "Analysierte Bilder",
  statShuttle: "Federball-Erkennungsabdeckung",
  statShuttleNote: "Anteil der Bilder mit einer Federballposition (Erkennungen und interpolierte Bilder).",
  statIdentity: "Identitätsabdeckung je Spieler",
  statEvents: "Identitätsereignisse",
  statCorrections: "Manuelle Korrekturen",
  statRally: "Rally-Kandidaten",
  statRallyNote: "Heuristische Lücken in den Federball-Erkennungen. Nicht validiert.",
  statShots: "Schlagzahlen",
  statShotsUnsupported: "In diesem Build nicht unterstützt (kein validierter Schlagklassifikator)",
  statShotsNotEvaluated: "Nicht bewertet (keine Ground Truth)",
  statShotsEstimate: "Kontaktkandidaten auf der Schlagzeitleiste. Jeder hat eine Flugbahn-Schätzung, nicht verifiziert.",
  statDuration: "Verarbeitungsdauer",
  statModel: "Modellausführung",
  statNotEvaluated: "Genauigkeit: nicht bewertet (keine Ground Truth)",
  statAccuracyNote: "Abdeckung und Ereigniszahlen sind keine Genauigkeitswerte.",
  exportsTitle: "Exporte",
  exportsIntro: "Das annotierte Video mit AI-Analyse-Overlay. Die Analysedaten (JSON) gehen automatisch an den AI Coach.",
  exportDownload: "Annotiertes Video herunterladen (MP4)",
  exportMissing: "Für diese Analyse nicht erzeugt",
};

export const WORKFLOW_COPY: Record<StudioLanguage, WorkflowCopy> = { en: EN, vi: VI, de: DE };
