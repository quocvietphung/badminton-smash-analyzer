// User-visible copy for the evidence viewer, corrections, sample library and evaluation dashboard.
// Every string exists in English, Vietnamese and German. Numbers come from the backend, never from this file.
import type { StudioLanguage } from "@/lib/studio-types";

export type EvidenceCopy = {
  evidenceTitle: string;
  evidenceIntro: string;
  originalVideo: string;
  annotatedVideo: string;
  syncNote: string;
  overlayToggle: string;
  courtOutline: string;
  shuttleTrail: string;
  noCourt: string;
  positionLabel: string;
  timelineTitle: string;
  timelineHint: string;
  lanesTitle: string;
  eventsTitle: string;
  eventsEmpty: string;
  seekEvent: string;
  coverage: string;
  trackerIds: string;
  logicalPlayers: string;
  rallyTitle: string;
  rallyNotice: string;
  rallyEmpty: string;
  rallyCount: string;
  shotTitle: string;
  shotNotice: string;
  notEvaluated: string;
  unavailable: string;
  loadingEvidence: string;
  evidenceError: string;
  kindLabels: Record<string, string>;
  statusLabels: Record<string, string>;
  correction: {
    title: string;
    intro: string;
    pausePrompt: string;
    selectedBox: string;
    noBox: string;
    identity: string;
    startFrame: string;
    endFrame: string;
    useCurrent: string;
    note: string;
    save: string;
    saving: string;
    saved: string;
    history: string;
    historyEmpty: string;
    typeLabels: Record<string, string>;
    players: string;
    singles: string;
    doubles: string;
    setMode: string;
    calibrateTitle: string;
    calibrateHelp: string;
    calibrateClicks: string;
    calibrateSave: string;
    calibrateReset: string;
    errors: Record<string, string>;
  };
  samples: {
    title: string;
    intro: string;
    analyse: string;
    viewResults: string;
    missing: string;
    licence: string;
    duration: string;
    resolution: string;
    frames: string;
    fps: string;
    source: string;
    trimmed: string;
    modeLabel: string;
    modeAuto: string;
    modeSingles: string;
    modeDoubles: string;
    noThumbnail: string;
  };
  evaluation: {
    title: string;
    intro: string;
    flow: string;
    analyses: string;
    processing: string;
    shuttle: string;
    tracking: string;
    identities: string;
    corrections: string;
    rallies: string;
    evaluationStatus: string;
    shots: string;
    groundTruth: string;
    completed: string;
    failed: string;
    inProgress: string;
    frames: string;
    videoSeconds: string;
    wallSeconds: string;
    fps: string;
    cpu: string;
    peakRss: string;
    detectorMs: string;
    deriveSeconds: string;
    visibleRatio: string;
    detectedRatio: string;
    interpolated: string;
    tracksPerAnalysis: string;
    tracksPerIdentity: string;
    identityEvents: string;
    switchesSuspected: string;
    analysesWithCorrections: string;
    correctionEntries: string;
    rallyCandidates: string;
    shotsStatus: string;
    labelledSamples: string;
    loading: string;
    error: string;
    empty: string;
  };
};

const EN: EvidenceCopy = {
  evidenceTitle: "Evidence",
  evidenceIntro:
    "Each number below points to a video time and frame index. Overlays show what the pipeline measured; corrections are stored separately from the raw output.",
  originalVideo: "Original",
  annotatedVideo: "Annotated",
  syncNote: "Both videos stay in sync while you seek.",
  overlayToggle: "Show overlay on the original",
  courtOutline: "Court outline",
  shuttleTrail: "Shuttle trail",
  noCourt: "No calibrated court, so no outline and no court metres.",
  positionLabel: "Position",
  timelineTitle: "Timeline",
  timelineHint: "Click the timeline to seek. Markers show identity events.",
  lanesTitle: "Identity status over time",
  eventsTitle: "Identity events",
  eventsEmpty: "No identity events were logged for this analysis.",
  seekEvent: "Go to",
  coverage: "Identity coverage",
  trackerIds: "Tracker IDs",
  logicalPlayers: "Logical players",
  rallyTitle: "Rallies",
  rallyNotice:
    "Heuristic candidates from gaps in shuttle detections. Not validated. Evaluation: not evaluated (no ground truth).",
  rallyEmpty: "No rally candidate was found in this clip.",
  rallyCount: "candidates",
  shotTitle: "Shot analysis",
  shotNotice:
    "Unsupported in the pipeline result: no validated shot classifier exists, so shot counts and contact times are not reported here. Contact and shot candidates are in Match intelligence and are unvalidated.",
  notEvaluated: "not evaluated (no ground truth)",
  unavailable: "Unavailable",
  loadingEvidence: "Loading the evidence files…",
  evidenceError: "Some evidence files could not be loaded. The available parts are shown.",
  kindLabels: {
    identity_initialised: "Identity started",
    identity_lost: "Identity lost",
    identity_recovered: "Identity recovered",
    identity_uncertain: "Uncertain",
    identity_switch_suspected: "Possible swap (not applied)",
    side_change: "Side change",
  },
  statusLabels: {
    matched: "matched",
    recovered: "recovered",
    lost: "lost",
    uncertain: "uncertain",
    manual: "manual",
    not_initialised: "not started",
  },
  correction: {
    title: "Manual correction",
    intro:
      "Corrections are stored apart from the raw AI output and applied as derived results. The analysis is recomputed after each save.",
    pausePrompt: "Pause the video, then click a player box on the original video.",
    selectedBox: "Selected box: tracker ID {id}",
    noBox: "No box is selected.",
    identity: "Identity",
    startFrame: "From frame",
    endFrame: "To frame",
    useCurrent: "Use current frame",
    note: "Note (optional)",
    save: "Save correction",
    saving: "Saving and recomputing…",
    saved: "Saved. The analysis was recomputed.",
    history: "Correction history",
    historyEmpty: "No corrections yet.",
    typeLabels: { identity: "Identity", court_calibration: "Court", mode: "Players" },
    players: "Players in this video",
    singles: "Singles (P1–P2)",
    doubles: "Doubles (P1–P4)",
    setMode: "Set players",
    calibrateTitle: "Court calibration",
    calibrateHelp:
      "Click the four court corners on the original video, in this order: near-left, near-right, far-right, far-left.",
    calibrateClicks: "Corners placed: {count} of 4",
    calibrateSave: "Save calibration",
    calibrateReset: "Clear corners",
    errors: {
      track: "Click a player box first.",
      identity: "Choose an identity that exists for this analysis.",
      interval: "The frame range must lie inside the video, with the start before the end.",
      notCompleted: "Corrections are available after the analysis is complete.",
      notRecomputable: "This analysis was made before raw outputs were kept, so it cannot take corrections.",
      failed: "The correction could not be saved. Nothing was changed.",
    },
  },
  samples: {
    title: "Sample library",
    intro:
      "Local test clips with their licences. The app refers to them by server-side ID; a browser never sends a file path.",
    analyse: "Analyse",
    viewResults: "View results",
    missing: "File not on disk. Run scripts/download-test-data.sh.",
    licence: "Licence",
    duration: "Duration",
    resolution: "Resolution",
    frames: "Frames",
    fps: "Frame rate",
    source: "Source",
    trimmed: "Trimmed to {seconds} s",
    modeLabel: "Players",
    modeAuto: "Automatic",
    modeSingles: "Singles",
    modeDoubles: "Doubles",
    noThumbnail: "No preview",
  },
  evaluation: {
    title: "Evaluation (measured)",
    intro:
      "Only values measured on this machine from saved analyses. Ground truth is not available, so accuracy is not reported.",
    flow: "Raw prediction → ground truth → evaluation → manual correction. Tracking confidence is not accuracy.",
    analyses: "Analyses",
    processing: "Processing",
    shuttle: "Shuttle coverage",
    tracking: "Tracking continuity",
    identities: "Identity events",
    corrections: "Manual corrections",
    rallies: "Rally candidates",
    evaluationStatus: "Evaluation",
    shots: "Shots",
    groundTruth: "Ground truth",
    completed: "completed",
    failed: "failed",
    inProgress: "in progress",
    frames: "frames analysed",
    videoSeconds: "seconds of video",
    wallSeconds: "mean wall time (s)",
    fps: "mean frames per second",
    cpu: "mean CPU use (cores)",
    peakRss: "peak memory (MB)",
    detectorMs: "mean detector time per frame (ms)",
    deriveSeconds: "mean derivation time (s)",
    visibleRatio: "mean share of frames with a shuttle",
    detectedRatio: "mean share of frames with a detected shuttle",
    interpolated: "interpolated frames",
    tracksPerAnalysis: "mean tracker IDs per analysis",
    tracksPerIdentity: "tracker IDs per identity (1.0 is ideal)",
    identityEvents: "identity events logged",
    switchesSuspected: "possible swaps (never applied)",
    analysesWithCorrections: "analyses with corrections",
    correctionEntries: "correction entries",
    rallyCandidates: "candidates (not validated)",
    shotsStatus: "Trajectory estimates · unverified",
    labelledSamples: "labelled samples",
    loading: "Loading the measured summary…",
    error: "The summary could not be loaded from the local backend.",
    empty: "No analysis has been saved yet.",
  },
};

const VI: EvidenceCopy = {
  evidenceTitle: "Bằng chứng",
  evidenceIntro:
    "Mỗi số liệu bên dưới trỏ tới một thời điểm và chỉ số khung hình trong video. Lớp phủ thể hiện đúng những gì hệ thống đo được; hiệu chỉnh được lưu tách khỏi kết quả AI gốc.",
  originalVideo: "Gốc",
  annotatedVideo: "Đã chú thích",
  syncNote: "Hai video luôn đồng bộ khi bạn tua.",
  overlayToggle: "Hiện lớp phủ trên video gốc",
  courtOutline: "Đường biên sân",
  shuttleTrail: "Quỹ đạo cầu",
  noCourt: "Chưa hiệu chuẩn sân, nên không có đường biên và không có số mét trên sân.",
  positionLabel: "Vị trí",
  timelineTitle: "Dòng thời gian",
  timelineHint: "Bấm lên dòng thời gian để tua. Các vạch đánh dấu sự kiện định danh.",
  lanesTitle: "Trạng thái định danh theo thời gian",
  eventsTitle: "Sự kiện định danh",
  eventsEmpty: "Không có sự kiện định danh nào được ghi cho lần phân tích này.",
  seekEvent: "Đến",
  coverage: "Độ phủ định danh",
  trackerIds: "ID theo dõi",
  logicalPlayers: "Người chơi logic",
  rallyTitle: "Các rally",
  rallyNotice:
    "Ứng viên theo heuristic từ các khoảng trống trong phát hiện cầu. Chưa được kiểm chứng. Đánh giá: chưa đánh giá (không có ground truth).",
  rallyEmpty: "Không tìm thấy ứng viên rally nào trong đoạn video này.",
  rallyCount: "ứng viên",
  shotTitle: "Phân tích cú đánh",
  shotNotice:
    "Chưa hỗ trợ trong kết quả pipeline: chưa có bộ phân loại cú đánh đã kiểm chứng, nên không báo số cú đánh hay thời điểm chạm vợt ở đây. Ứng viên lần chạm và cú đánh nằm trong Phân tích trận đấu và chưa kiểm chứng.",
  notEvaluated: "chưa đánh giá (không có ground truth)",
  unavailable: "Không có",
  loadingEvidence: "Đang tải các tệp bằng chứng…",
  evidenceError: "Một số tệp bằng chứng không tải được. Phần còn lại vẫn được hiển thị.",
  kindLabels: {
    identity_initialised: "Bắt đầu định danh",
    identity_lost: "Mất định danh",
    identity_recovered: "Khôi phục định danh",
    identity_uncertain: "Chưa chắc chắn",
    identity_switch_suspected: "Nghi hoán đổi (chưa áp dụng)",
    side_change: "Đổi phía sân",
  },
  statusLabels: {
    matched: "khớp",
    recovered: "khôi phục",
    lost: "mất",
    uncertain: "chưa chắc",
    manual: "thủ công",
    not_initialised: "chưa bắt đầu",
  },
  correction: {
    title: "Hiệu chỉnh thủ công",
    intro:
      "Hiệu chỉnh được lưu tách khỏi kết quả AI gốc và áp dụng như kết quả suy ra. Phân tích được tính lại sau mỗi lần lưu.",
    pausePrompt: "Tạm dừng video, rồi bấm vào một hộp người chơi trên video gốc.",
    selectedBox: "Hộp đã chọn: ID theo dõi {id}",
    noBox: "Chưa chọn hộp nào.",
    identity: "Định danh",
    startFrame: "Từ khung",
    endFrame: "Đến khung",
    useCurrent: "Dùng khung hiện tại",
    note: "Ghi chú (không bắt buộc)",
    save: "Lưu hiệu chỉnh",
    saving: "Đang lưu và tính lại…",
    saved: "Đã lưu. Phân tích đã được tính lại.",
    history: "Lịch sử hiệu chỉnh",
    historyEmpty: "Chưa có hiệu chỉnh nào.",
    typeLabels: { identity: "Định danh", court_calibration: "Sân", mode: "Số người" },
    players: "Số người chơi trong video",
    singles: "Đơn (P1–P2)",
    doubles: "Đôi (P1–P4)",
    setMode: "Đặt số người chơi",
    calibrateTitle: "Hiệu chỉnh sân",
    calibrateHelp:
      "Bấm bốn góc sân trên video gốc theo thứ tự: trái gần, phải gần, phải xa, trái xa.",
    calibrateClicks: "Đã đặt {count} / 4 góc",
    calibrateSave: "Lưu hiệu chỉnh sân",
    calibrateReset: "Xóa các góc",
    errors: {
      track: "Hãy bấm vào một hộp người chơi trước.",
      identity: "Chọn một định danh có trong phân tích này.",
      interval: "Khoảng khung phải nằm trong video, và khung bắt đầu phải trước khung kết thúc.",
      notCompleted: "Chỉ hiệu chỉnh được sau khi phân tích hoàn tất.",
      notRecomputable: "Phân tích này được tạo trước khi giữ kết quả thô, nên không thể hiệu chỉnh.",
      failed: "Không lưu được hiệu chỉnh. Không có gì thay đổi.",
    },
  },
  samples: {
    title: "Thư viện video mẫu",
    intro:
      "Các clip thử nghiệm trên máy kèm giấy phép. Ứng dụng tham chiếu bằng ID phía máy chủ; trình duyệt không bao giờ gửi đường dẫn tệp.",
    analyse: "Phân tích",
    viewResults: "Xem kết quả",
    missing: "Chưa có tệp trên máy. Hãy chạy scripts/download-test-data.sh.",
    licence: "Giấy phép",
    duration: "Thời lượng",
    resolution: "Độ phân giải",
    frames: "Số khung",
    fps: "Tốc độ khung hình",
    source: "Nguồn",
    trimmed: "Cắt còn {seconds} giây",
    modeLabel: "Số người chơi",
    modeAuto: "Tự động",
    modeSingles: "Đơn",
    modeDoubles: "Đôi",
    noThumbnail: "Không có ảnh xem trước",
  },
  evaluation: {
    title: "Đánh giá (số đo thực tế)",
    intro:
      "Chỉ hiển thị số đo thực tế trên máy này từ các phân tích đã lưu. Không có ground truth nên không báo độ chính xác.",
    flow: "Dự đoán thô → ground truth → đánh giá → hiệu chỉnh thủ công. Độ tin cậy theo dõi không phải là độ chính xác.",
    analyses: "Phân tích",
    processing: "Xử lý",
    shuttle: "Độ phủ quả cầu",
    tracking: "Tính liên tục theo dõi",
    identities: "Sự kiện định danh",
    corrections: "Hiệu chỉnh thủ công",
    rallies: "Ứng viên rally",
    evaluationStatus: "Đánh giá",
    shots: "Cú đánh",
    groundTruth: "Ground truth",
    completed: "hoàn tất",
    failed: "lỗi",
    inProgress: "đang chạy",
    frames: "khung đã phân tích",
    videoSeconds: "giây video",
    wallSeconds: "thời gian chạy trung bình (s)",
    fps: "khung hình/giây trung bình",
    cpu: "CPU trung bình (nhân)",
    peakRss: "bộ nhớ cao nhất (MB)",
    detectorMs: "thời gian detector trung bình mỗi khung (ms)",
    deriveSeconds: "thời gian suy ra trung bình (s)",
    visibleRatio: "tỷ lệ khung có vị trí cầu (trung bình)",
    detectedRatio: "tỷ lệ khung cầu được phát hiện (trung bình)",
    interpolated: "khung nội suy",
    tracksPerAnalysis: "ID theo dõi trung bình mỗi phân tích",
    tracksPerIdentity: "ID theo dõi trên mỗi định danh (1,0 là lý tưởng)",
    identityEvents: "sự kiện định danh đã ghi",
    switchesSuspected: "nghi hoán đổi (không bao giờ áp dụng)",
    analysesWithCorrections: "phân tích có hiệu chỉnh",
    correctionEntries: "mục hiệu chỉnh",
    rallyCandidates: "ứng viên (chưa kiểm chứng)",
    shotsStatus: "Ước lượng quỹ đạo · chưa kiểm chứng",
    labelledSamples: "mẫu có nhãn",
    loading: "Đang tải tóm tắt số đo…",
    error: "Không tải được tóm tắt từ backend cục bộ.",
    empty: "Chưa có phân tích nào được lưu.",
  },
};

const DE: EvidenceCopy = {
  evidenceTitle: "Belege",
  evidenceIntro:
    "Jede Zahl unten verweist auf einen Videozeitpunkt und einen Bildindex. Die Überlagerungen zeigen, was die Pipeline gemessen hat; Korrekturen werden getrennt von der Rohausgabe gespeichert.",
  originalVideo: "Original",
  annotatedVideo: "Annotiert",
  syncNote: "Beide Videos bleiben beim Spulen synchron.",
  overlayToggle: "Überlagerung auf dem Original anzeigen",
  courtOutline: "Feldlinien",
  shuttleTrail: "Federbahn",
  noCourt: "Kein kalibriertes Feld, daher keine Feldlinien und keine Meterangaben.",
  positionLabel: "Position",
  timelineTitle: "Zeitleiste",
  timelineHint: "Auf die Zeitleiste klicken, um zu springen. Markierungen zeigen Identitätsereignisse.",
  lanesTitle: "Identitätsstatus über die Zeit",
  eventsTitle: "Identitätsereignisse",
  eventsEmpty: "Für diese Analyse wurden keine Identitätsereignisse protokolliert.",
  seekEvent: "Zu",
  coverage: "Identitätsabdeckung",
  trackerIds: "Tracker-IDs",
  logicalPlayers: "Logische Spieler",
  rallyTitle: "Ballwechsel",
  rallyNotice:
    "Heuristische Kandidaten aus Lücken in den Federball-Erkennungen. Nicht validiert. Bewertung: nicht bewertet (keine Ground Truth).",
  rallyEmpty: "In diesem Clip wurde kein Rally-Kandidat gefunden.",
  rallyCount: "Kandidaten",
  shotTitle: "Schlaganalyse",
  shotNotice:
    "Im Pipeline-Ergebnis nicht unterstützt: Es gibt keinen validierten Schlagklassifikator, daher werden hier keine Schlagzahlen oder Kontaktzeitpunkte angegeben. Kontakt- und Schlagkandidaten stehen in der Spielanalyse und sind nicht validiert.",
  notEvaluated: "nicht bewertet (keine Ground Truth)",
  unavailable: "Nicht verfügbar",
  loadingEvidence: "Belegdateien werden geladen…",
  evidenceError: "Einige Belegdateien konnten nicht geladen werden. Die übrigen Teile werden angezeigt.",
  kindLabels: {
    identity_initialised: "Identität gestartet",
    identity_lost: "Identität verloren",
    identity_recovered: "Identität wiedergefunden",
    identity_uncertain: "Unsicher",
    identity_switch_suspected: "Mögliche Vertauschung (nicht angewendet)",
    side_change: "Seitenwechsel",
  },
  statusLabels: {
    matched: "zugeordnet",
    recovered: "wiedergefunden",
    lost: "verloren",
    uncertain: "unsicher",
    manual: "manuell",
    not_initialised: "noch nicht gestartet",
  },
  correction: {
    title: "Manuelle Korrektur",
    intro:
      "Korrekturen werden getrennt von der rohen KI-Ausgabe gespeichert und als abgeleitete Ergebnisse angewendet. Die Analyse wird nach jedem Speichern neu berechnet.",
    pausePrompt: "Video anhalten und dann eine Spielerbox im Originalvideo anklicken.",
    selectedBox: "Gewählte Box: Tracker-ID {id}",
    noBox: "Keine Box gewählt.",
    identity: "Identität",
    startFrame: "Ab Bild",
    endFrame: "Bis Bild",
    useCurrent: "Aktuelles Bild verwenden",
    note: "Notiz (optional)",
    save: "Korrektur speichern",
    saving: "Wird gespeichert und neu berechnet…",
    saved: "Gespeichert. Die Analyse wurde neu berechnet.",
    history: "Korrekturverlauf",
    historyEmpty: "Noch keine Korrekturen.",
    typeLabels: { identity: "Identität", court_calibration: "Feld", mode: "Spieleranzahl" },
    players: "Spieler in diesem Video",
    singles: "Einzel (P1–P2)",
    doubles: "Doppel (P1–P4)",
    setMode: "Spieler festlegen",
    calibrateTitle: "Feldkalibrierung",
    calibrateHelp:
      "Die vier Feldecken im Originalvideo in dieser Reihenfolge anklicken: nah links, nah rechts, fern rechts, fern links.",
    calibrateClicks: "{count} von 4 Ecken gesetzt",
    calibrateSave: "Kalibrierung speichern",
    calibrateReset: "Ecken löschen",
    errors: {
      track: "Zuerst eine Spielerbox anklicken.",
      identity: "Eine Identität wählen, die in dieser Analyse vorhanden ist.",
      interval: "Der Bildbereich muss im Video liegen, und der Anfang muss vor dem Ende liegen.",
      notCompleted: "Korrekturen sind erst nach Abschluss der Analyse möglich.",
      notRecomputable:
        "Diese Analyse wurde erstellt, bevor die Rohausgaben gespeichert wurden, daher sind keine Korrekturen möglich.",
      failed: "Die Korrektur konnte nicht gespeichert werden. Es wurde nichts geändert.",
    },
  },
  samples: {
    title: "Beispielbibliothek",
    intro:
      "Lokale Testclips mit ihren Lizenzen. Die App verweist über serverseitige IDs auf sie; der Browser sendet nie einen Dateipfad.",
    analyse: "Analysieren",
    viewResults: "Ergebnisse ansehen",
    missing: "Datei fehlt auf dem Rechner. Führe scripts/download-test-data.sh aus.",
    licence: "Lizenz",
    duration: "Dauer",
    resolution: "Auflösung",
    frames: "Bilder",
    fps: "Bildrate",
    source: "Quelle",
    trimmed: "Auf {seconds} s gekürzt",
    modeLabel: "Spieler",
    modeAuto: "Automatisch",
    modeSingles: "Einzel",
    modeDoubles: "Doppel",
    noThumbnail: "Keine Vorschau",
  },
  evaluation: {
    title: "Auswertung (gemessen)",
    intro:
      "Nur auf diesem Rechner gemessene Werte aus gespeicherten Analysen. Ground Truth liegt nicht vor, daher wird keine Genauigkeit angegeben.",
    flow: "Rohvorhersage → Ground Truth → Bewertung → manuelle Korrektur. Tracking-Konfidenz ist keine Genauigkeit.",
    analyses: "Analysen",
    processing: "Verarbeitung",
    shuttle: "Federball-Abdeckung",
    tracking: "Tracking-Kontinuität",
    identities: "Identitätsereignisse",
    corrections: "Manuelle Korrekturen",
    rallies: "Rally-Kandidaten",
    evaluationStatus: "Bewertung",
    shots: "Schläge",
    groundTruth: "Ground Truth",
    completed: "abgeschlossen",
    failed: "fehlgeschlagen",
    inProgress: "läuft",
    frames: "analysierte Bilder",
    videoSeconds: "Sekunden Video",
    wallSeconds: "mittlere Laufzeit (s)",
    fps: "mittlere Bilder pro Sekunde",
    cpu: "mittlere CPU-Nutzung (Kerne)",
    peakRss: "Speicherspitze (MB)",
    detectorMs: "mittlere Detektorzeit pro Bild (ms)",
    deriveSeconds: "mittlere Ableitungszeit (s)",
    visibleRatio: "mittlerer Anteil der Bilder mit Federball",
    detectedRatio: "mittlerer Anteil der Bilder mit erkanntem Federball",
    interpolated: "interpolierte Bilder",
    tracksPerAnalysis: "mittlere Tracker-IDs pro Analyse",
    tracksPerIdentity: "Tracker-IDs je Identität (1,0 ist ideal)",
    identityEvents: "protokollierte Identitätsereignisse",
    switchesSuspected: "mögliche Vertauschungen (nie angewendet)",
    analysesWithCorrections: "Analysen mit Korrekturen",
    correctionEntries: "Korrektureinträge",
    rallyCandidates: "Kandidaten (nicht validiert)",
    shotsStatus: "Flugbahn-Schätzungen · unverifiziert",
    labelledSamples: "beschriftete Beispiele",
    loading: "Gemessene Zusammenfassung wird geladen…",
    error: "Die Zusammenfassung konnte nicht vom lokalen Backend geladen werden.",
    empty: "Noch keine Analyse gespeichert.",
  },
};

export const EVIDENCE_COPY: Record<StudioLanguage, EvidenceCopy> = { en: EN, vi: VI, de: DE };

/** Fill {placeholders} in a copy string. Unknown placeholders are left as they are. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? String(values[key]) : match));
}
