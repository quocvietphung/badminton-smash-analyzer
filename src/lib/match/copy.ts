// User-visible copy for the match dashboard and Live Analysis, in English, Vietnamese and German.
import type { StudioLanguage } from "@/lib/studio-types";
import type { ShotType } from "./analytics";

export type MatchCopy = {
  title: string;
  intro: string;
  badgeDerived: string;
  badgeUnvalidated: string;
  loading: string;
  failed: string;
  cardSpeed: string;
  speedUnavailable: string;
  speedUncalibrated: string;
  speedEstimated: string;
  speedReasonUncalibrated: string;
  speedReasonHeight: string;
  speedReasonNoConfirmed: string;
  speedCandidatesOnly: string;
  speedShots: string;
  evidenceSpeed: string;
  physicalAvailable: string;
  physicalUnavailable: string;
  physicalFirstObserved: string;
  physicalAtNet: string;
  physicalAtContact: string;
  physicalUncertainty: string;
  physicalMethod: string;
  physicalCalibration: string;
  physicalReasons: string;
  imageSpaceSpeed: string;
  estimated3dTitle: string;
  estimated3dRange: string;
  estimated3dQuality: string;
  estimated3dReprojection: string;
  estimated3dSpread: string;
  estimated3dAssumptions: string;
  estimated3dGates: string;
  measured3dTitle: string;
  measured3dNotRun: string;
  personNote: string;
  statsEstimates: string;
  cardContacts: string;
  cardContactsNote: string;
  cardRallies: string;
  overlayContacts: string;
  cardRalliesNote: string;
  cardPlayers: string;
  cardPlayersNote: string;
  videoTitle: string;
  rallyTime: string;
  rally: string;
  rallyOf: string;
  noRally: string;
  shot: string;
  noShot: string;
  candidate: string;
  confirmed: string;
  rejected: string;
  hits: string;
  maxSpeed: string;
  tracked: string;
  uncertain: string;
  lost: string;
  mapTitle: string;
  mapUnavailable: string;
  mapCalibration: string;
  mapApproximation: string;
  mapShuttle: string;
  mapTrail: string;
  timelineTitle: string;
  timelineIntro: string;
  timelineEmpty: string;
  flagSamePlayer: string;
  evidenceTitle: string;
  evidenceTurn: string;
  evidenceDistance: string;
  evidenceConfidence: string;
  evidenceInterpolated: string;
  evidenceSource: string;
  evidenceModel: string;
  evidenceNoModel: string;
  evidenceValidation: string;
  labelTitle: string;
  labelSave: string;
  confirmContact: string;
  rejectContact: string;
  saving: string;
  saved: string;
  saveFailed: string;
  ralliesTitle: string;
  winnerUnsupported: string;
  heuristic: string;
  manualEdit: string;
  statsTitle: string;
  statsRallies: string;
  statsShots: string;
  statsPlayers: string;
  statsAi: string;
  statCount: string;
  statMeanDuration: string;
  statLongest: string;
  statContactsPerRally: string;
  statContactsCounted: string;
  statRejected: string;
  statTurnsWithoutPlayer: string;
  statSamePlayer: string;
  statUnknown: string;
  statLabelled: string;
  statDistance: string;
  statCoverage: string;
  statConfidence: string;
  statHits: string;
  statUnavailable: string;
  statModels: string;
  statFps: string;
  statWall: string;
  statFrames: string;
  statShuttle: string;
  statIdentity: string;
  statCourt: string;
  statDevice: string;
  statNote: string;
  shotTypes: Record<ShotType, string>;
  validation: Record<"unclassified" | "manual" | "trajectory_unverified", string>;
  speedAutomatic: string;
  speedConfirmed: string;
  modelTag: string;
  labelPlayer: string;
  labelPlayerKeep: string;
  exportGroundTruth: string;
  exportHint: string;
  setHitFrame: string;
  evidenceHitFrame: string;
  hitFrameNone: string;
  rallyStatusCandidate: string;
  rallyStatusUncertain: string;
  rallyStatusConfirmed: string;
  rallyCountLabel: string;
  rallyHint: string;
  unmatchedTitle: string;
  unmatchedHint: string;
  transferredNote: string;
  participationLabel: string;
  rallyShots: string;
  evidenceTypeReason: string;
  statRejectedAuto: string;
};

const EN: MatchCopy = {
  title: "Match intelligence",
  intro: "Derived from this analysis: rally candidates, contact candidates, court positions and player tracking. Nothing here is a validated statistic.",
  badgeDerived: "Derived from this analysis",
  badgeUnvalidated: "Candidates · not validated",
  loading: "Loading match analytics…",
  failed: "Match analytics are not available for this analysis.",
  cardSpeed: "Image-space speed",
  speedUnavailable: "Unavailable — no confirmed contact",
  speedUncalibrated: "Physical trajectory unavailable",
  speedEstimated: "image-space speed (px/s)",
  speedReasonNoConfirmed: "Confirm a contact to include its image-space speed in the official statistics.",
  speedCandidatesOnly: "Automatic candidates have image-space speeds on the timeline, but none is confirmed, so there is no official value.",
  speedShots: "confirmed contacts",
  evidenceSpeed: "Image-space speed",
  physicalAvailable: "Estimated 3D — monocular experimental",
  physicalUnavailable: "Physical trajectory unavailable",
  physicalFirstObserved: "Candidate speed",
  physicalAtNet: "Speed at net plane",
  physicalAtContact: "Contact speed (extrapolated)",
  physicalUncertainty: "Speed range (sensitivity)",
  physicalMethod: "Method",
  physicalCalibration: "3D calibration",
  physicalReasons: "Why rejected",
  statsEstimates: "Trajectory estimates · unverified",
  personNote: "Person's note",
  measured3dNotRun: "NOT RUN — stereo input unavailable",
  measured3dTitle: "Measured 3D — stereo",
  estimated3dGates: "Gates",
  estimated3dAssumptions: "Assumptions",
  estimated3dSpread: "Spread under the sensitivity runs",
  estimated3dReprojection: "Reprojection error (RMS / P95)",
  estimated3dQuality: "Quality",
  estimated3dRange: "Speed range",
  estimated3dTitle: "Estimated 3D — monocular experimental",
  imageSpaceSpeed: "Image-space speed",
  speedReasonUncalibrated: "Physical km/h is not derived from one camera.",
  speedReasonHeight: "Pixels per second on the image only — not a physical speed and never km/h.",
  cardContacts: "Contact candidates",
  cardContactsNote: "Shuttle turns near a player. Not confirmed contacts.",
  cardRallies: "Rallies",
  overlayContacts: "Contacts so far",
  cardRalliesNote: "From contact sequences. Not validated.",
  cardPlayers: "Players tracked",
  cardPlayersNote: "Logical identities in this analysis.",
  videoTitle: "Annotated video with match overlay",
  rallyTime: "Rally time",
  rally: "Rally",
  rallyOf: "of",
  noRally: "Between rallies",
  shot: "Shot",
  noShot: "No contact candidate now",
  candidate: "Candidate",
  confirmed: "Confirmed",
  rejected: "Rejected",
  hits: "Hits",
  maxSpeed: "Max image-space speed (confirmed)",
  tracked: "Tracked",
  uncertain: "Uncertain",
  lost: "Not tracked",
  mapTitle: "Court map",
  mapUnavailable: "Court map unavailable: the court is not calibrated, so player positions cannot be placed on the court.",
  mapCalibration: "Calibration",
  mapApproximation: "Positions are foot points on a flat floor (approximate).",
  mapShuttle: "The shuttle is not drawn: its height is unknown, so it has no floor position.",
  mapTrail: "Trails show the last 3 s.",
  timelineTitle: "Shot timeline",
  timelineIntro: "One entry per contact candidate. Select an entry to jump to it and see its evidence.",
  timelineEmpty: "No contact candidates were found.",
  flagSamePlayer: "Same player twice in a row: likely a false candidate",
  evidenceTitle: "Evidence",
  evidenceTurn: "Shuttle turn",
  evidenceDistance: "Distance to player box",
  evidenceConfidence: "Shuttle detector confidence",
  evidenceInterpolated: "Interpolated neighbour frames",
  evidenceSource: "Source",
  evidenceModel: "Shot model",
  evidenceNoModel: "None (no trajectory dataset row)",
  evidenceValidation: "Validation",
  labelTitle: "Manual review",
  labelSave: "Save shot label",
  confirmContact: "Confirm contact",
  rejectContact: "Reject contact",
  saving: "Saving…",
  saved: "Saved. The analysis was updated from the stored corrections.",
  saveFailed: "The correction was not saved.",
  ralliesTitle: "Rallies",
  winnerUnsupported: "Winner: not detected",
  heuristic: "heuristic",
  manualEdit: "manual",
  statsTitle: "Match statistics",
  statsRallies: "Rallies",
  statsShots: "Person labels",
  statsPlayers: "Players",
  statsAi: "AI processing",
  statCount: "Count",
  statMeanDuration: "Mean duration",
  statLongest: "Longest",
  statContactsPerRally: "Contacts per rally",
  statContactsCounted: "Contacts counted",
  statRejected: "Rejected",
  statTurnsWithoutPlayer: "Turns without a player nearby",
  statSamePlayer: "Same player twice",
  statUnknown: "Unknown type",
  statLabelled: "Labelled by hand",
  statDistance: "Distance (approx.)",
  statCoverage: "Identity coverage",
  statConfidence: "Identity confidence",
  statHits: "Contact candidates",
  statUnavailable: "Unavailable",
  statModels: "Models executed",
  statFps: "Processing speed",
  statWall: "Processing time",
  statFrames: "Frames analysed",
  statShuttle: "Shuttle detection coverage",
  statIdentity: "Identity coverage",
  statCourt: "Court calibration",
  statDevice: "Device",
  statNote: "Coverage shows how often something was detected. It is not accuracy.",
  shotTypes: {
    smash: "Smash",
    drop: "Drop",
    clear: "Clear",
    drive: "Drive",
    net_shot: "Net shot",
    lift: "Lift",
    unknown: "Unknown",
  },
  validation: { unclassified: "Not classified", manual: "Labelled by hand", trajectory_unverified: "Trajectory estimate · unverified" },
  speedAutomatic: "image-space speed of an automatic candidate (not official)",
  speedConfirmed: "official: confirmed contacts only",
  modelTag: "model",
  labelPlayer: "Player",
  labelPlayerKeep: "Keep player",
  exportGroundTruth: "Export ground truth (JSON)",
  exportHint: "Exports human decisions only: confirmed or rejected contacts, labelled shot types and players. Candidates stay unlabelled.",
  setHitFrame: "Set hit frame to current video frame",
  evidenceHitFrame: "Hit frame (person)",
  hitFrameNone: "Not recorded",
  rallyStatusCandidate: "Candidate · not validated",
  rallyStatusUncertain: "Uncertain · one contact only",
  rallyStatusConfirmed: "Confirmed by a person",
  rallyCountLabel: "Candidates / confirmed",
  rallyHint: "Rally candidates come from contact sequences and are not validated. Only boundaries set by a person are confirmed.",
  unmatchedTitle: "Annotations to review",
  unmatchedHint: "Earlier annotations of this video that do not match a candidate in this analysis. They are kept and not applied.",
  transferredNote: "earlier annotations applied to this analysis",
  participationLabel: "Rallies with a shot by",
  rallyShots: "hits",
  evidenceTypeReason: "Why this type",
  statRejectedAuto: "Turns rejected automatically"
};

const VI: MatchCopy = {
  title: "Phân tích trận đấu",
  intro: "Suy ra từ phân tích này: ứng viên rally, ứng viên chạm cầu, vị trí trên sân và theo dõi người chơi. Không có số liệu nào ở đây đã được kiểm chứng.",
  badgeDerived: "Suy ra từ phân tích này",
  badgeUnvalidated: "Ứng viên · chưa kiểm chứng",
  loading: "Đang tải phân tích trận đấu…",
  failed: "Phân tích trận đấu không có sẵn cho lần phân tích này.",
  cardSpeed: "Tốc độ trên ảnh",
  speedUnavailable: "Không có — chưa có lần chạm xác nhận",
  speedUncalibrated: "Không có quỹ đạo vật lý",
  speedEstimated: "tốc độ trên ảnh (px/s)",
  speedReasonNoConfirmed: "Xác nhận một lần chạm để đưa tốc độ trên ảnh của nó vào thống kê chính thức.",
  speedCandidatesOnly: "Ứng viên tự động có tốc độ trên ảnh ở dòng thời gian nhưng chưa lần nào được xác nhận, nên chưa có giá trị chính thức.",
  speedShots: "lần chạm đã xác nhận",
  evidenceSpeed: "Tốc độ trên ảnh",
  physicalAvailable: "3D ước lượng — một camera, thử nghiệm",
  physicalUnavailable: "Không có quỹ đạo vật lý",
  physicalFirstObserved: "Tốc độ ứng viên",
  physicalAtNet: "Tốc độ tại mặt phẳng lưới",
  physicalAtContact: "Tốc độ lúc chạm cầu (ngoại suy)",
  physicalUncertainty: "Khoảng tốc độ (độ nhạy)",
  physicalMethod: "Phương pháp",
  physicalCalibration: "Hiệu chuẩn 3D",
  physicalReasons: "Lý do bị loại",
  statsEstimates: "Ước lượng từ quỹ đạo · chưa kiểm chứng",
  personNote: "Ghi chú của người",
  measured3dNotRun: "CHƯA CHẠY — không có dữ liệu stereo",
  measured3dTitle: "3D đo bằng stereo",
  estimated3dGates: "Cổng kiểm tra",
  estimated3dAssumptions: "Giả định",
  estimated3dSpread: "Độ lệch giữa các lần chạy độ nhạy",
  estimated3dReprojection: "Sai số chiếu lại (RMS / P95)",
  estimated3dQuality: "Chất lượng",
  estimated3dRange: "Khoảng tốc độ",
  estimated3dTitle: "3D ước lượng — một camera, thử nghiệm",
  imageSpaceSpeed: "Tốc độ trên ảnh",
  speedReasonUncalibrated: "Không suy ra km/h vật lý từ một camera.",
  speedReasonHeight: "Chỉ là pixel mỗi giây trên ảnh — không phải tốc độ vật lý, không bao giờ là km/h.",
  cardContacts: "Ứng viên chạm cầu",
  cardContactsNote: "Quả cầu đổi hướng gần người chơi. Chưa phải lần chạm đã xác nhận.",
  cardRallies: "Số rally",
  overlayContacts: "Lần chạm đến nay",
  cardRalliesNote: "Suy ra từ chuỗi lần chạm. Chưa kiểm chứng.",
  cardPlayers: "Người chơi được theo dõi",
  cardPlayersNote: "Định danh logic trong phân tích này.",
  videoTitle: "Video chú thích với lớp phủ trận đấu",
  rallyTime: "Thời gian rally",
  rally: "Rally",
  rallyOf: "/",
  noRally: "Giữa các rally",
  shot: "Cú đánh",
  noShot: "Hiện không có ứng viên chạm cầu",
  candidate: "Ứng viên",
  confirmed: "Đã xác nhận",
  rejected: "Đã loại",
  hits: "Lần chạm",
  maxSpeed: "Tốc độ trên ảnh cao nhất (đã xác nhận)",
  tracked: "Đang theo dõi",
  uncertain: "Không chắc chắn",
  lost: "Mất dấu",
  mapTitle: "Bản đồ sân",
  mapUnavailable: "Không có bản đồ sân: sân chưa được hiệu chỉnh nên không thể đặt vị trí người chơi lên sân.",
  mapCalibration: "Hiệu chỉnh",
  mapApproximation: "Vị trí là điểm chân trên mặt sàn phẳng (gần đúng).",
  mapShuttle: "Không vẽ quả cầu: không biết độ cao nên không có vị trí trên mặt sàn.",
  mapTrail: "Vệt di chuyển là 3 giây gần nhất.",
  timelineTitle: "Dòng thời gian cú đánh",
  timelineIntro: "Mỗi mục là một ứng viên chạm cầu. Chọn một mục để nhảy tới thời điểm đó và xem bằng chứng.",
  timelineEmpty: "Không tìm thấy ứng viên chạm cầu nào.",
  flagSamePlayer: "Cùng một người chơi hai lần liên tiếp: có thể là ứng viên sai",
  evidenceTitle: "Bằng chứng",
  evidenceTurn: "Góc đổi hướng của cầu",
  evidenceDistance: "Khoảng cách tới khung người chơi",
  evidenceConfidence: "Độ tin cậy của bộ phát hiện cầu",
  evidenceInterpolated: "Khung lân cận được nội suy",
  evidenceSource: "Nguồn",
  evidenceModel: "Mô hình cú đánh",
  evidenceNoModel: "Không có (chưa có dòng dữ liệu quỹ đạo)",
  evidenceValidation: "Kiểm chứng",
  labelTitle: "Duyệt thủ công",
  labelSave: "Lưu nhãn cú đánh",
  confirmContact: "Xác nhận lần chạm",
  rejectContact: "Loại lần chạm",
  saving: "Đang lưu…",
  saved: "Đã lưu. Phân tích được cập nhật từ các hiệu chỉnh đã lưu.",
  saveFailed: "Hiệu chỉnh chưa được lưu.",
  ralliesTitle: "Các rally",
  winnerUnsupported: "Người thắng: không phát hiện",
  heuristic: "heuristic",
  manualEdit: "thủ công",
  statsTitle: "Thống kê trận đấu",
  statsRallies: "Rally",
  statsShots: "Nhãn của người",
  statsPlayers: "Người chơi",
  statsAi: "Xử lý AI",
  statCount: "Số lượng",
  statMeanDuration: "Thời lượng trung bình",
  statLongest: "Dài nhất",
  statContactsPerRally: "Lần chạm mỗi rally",
  statContactsCounted: "Lần chạm được đếm",
  statRejected: "Đã loại",
  statTurnsWithoutPlayer: "Đổi hướng không có người chơi gần",
  statSamePlayer: "Cùng người chơi hai lần",
  statUnknown: "Chưa rõ loại",
  statLabelled: "Gán nhãn thủ công",
  statDistance: "Quãng đường (gần đúng)",
  statCoverage: "Độ phủ định danh",
  statConfidence: "Độ tin cậy định danh",
  statHits: "Ứng viên chạm cầu",
  statUnavailable: "Không có",
  statModels: "Mô hình đã chạy",
  statFps: "Tốc độ xử lý",
  statWall: "Thời gian xử lý",
  statFrames: "Số khung đã phân tích",
  statShuttle: "Độ phủ phát hiện cầu",
  statIdentity: "Độ phủ định danh",
  statCourt: "Hiệu chỉnh sân",
  statDevice: "Thiết bị",
  statNote: "Độ phủ cho biết tần suất phát hiện được. Đó không phải độ chính xác.",
  shotTypes: {
    smash: "Đập cầu",
    drop: "Bỏ nhỏ",
    clear: "Phông cầu",
    drive: "Tạt cầu",
    net_shot: "Cầu lưới",
    lift: "Nâng cầu",
    unknown: "Chưa rõ",
  },
  validation: { unclassified: "Chưa phân loại", manual: "Gán nhãn thủ công", trajectory_unverified: "Ước lượng từ quỹ đạo · chưa kiểm chứng" },
  speedAutomatic: "tốc độ trên ảnh của ứng viên tự động (không chính thức)",
  speedConfirmed: "chính thức: chỉ lần chạm đã xác nhận",
  modelTag: "mô hình",
  labelPlayer: "Người chơi",
  labelPlayerKeep: "Giữ người chơi",
  exportGroundTruth: "Xuất nhãn chuẩn (JSON)",
  exportHint: "Chỉ xuất quyết định của con người: lần chạm đã xác nhận hoặc bị bác bỏ, loại cú và người chơi đã gán. Ứng viên chưa gán nhãn sẽ giữ nguyên.",
  setHitFrame: "Đặt khung chạm vợt là khung video hiện tại",
  evidenceHitFrame: "Khung chạm vợt (người xác nhận)",
  hitFrameNone: "Chưa ghi nhận",
  rallyStatusCandidate: "Ứng viên · chưa kiểm chứng",
  rallyStatusUncertain: "Chưa chắc · chỉ một lần chạm",
  rallyStatusConfirmed: "Đã xác nhận bởi người",
  rallyCountLabel: "Ứng viên / đã xác nhận",
  rallyHint: "Ứng viên rally được suy ra từ chuỗi lần chạm và chưa kiểm chứng. Chỉ các mốc do người xác định mới được xác nhận.",
  unmatchedTitle: "Chú thích cần xem lại",
  unmatchedHint: "Chú thích từ các lần phân tích trước của video này chưa khớp ứng viên nào trong phân tích này. Chúng được giữ lại và chưa áp dụng.",
  transferredNote: "chú thích từ lần phân tích trước đã áp dụng",
  participationLabel: "Số rally có cú của",
  rallyShots: "lần chạm",
  evidenceTypeReason: "Lý do loại này",
  statRejectedAuto: "Lượt đổi hướng bị loại tự động"
};

const DE: MatchCopy = {
  title: "Spielanalyse",
  intro: "Aus dieser Analyse abgeleitet: Ballwechsel-Kandidaten, Kontakt-Kandidaten, Feldpositionen und Spieler-Tracking. Nichts davon ist eine validierte Statistik.",
  badgeDerived: "Aus dieser Analyse abgeleitet",
  badgeUnvalidated: "Kandidaten · nicht validiert",
  loading: "Spielanalyse wird geladen…",
  failed: "Für diese Analyse ist keine Spielanalyse verfügbar.",
  cardSpeed: "Bildgeschwindigkeit",
  speedUnavailable: "Nicht verfügbar — kein bestätigter Kontakt",
  speedUncalibrated: "Physikalische Flugbahn nicht verfügbar",
  speedEstimated: "Bildgeschwindigkeit (px/s)",
  speedReasonNoConfirmed: "Bestätigen Sie einen Kontakt, damit seine Bildgeschwindigkeit in die offizielle Statistik eingeht.",
  speedCandidatesOnly: "Automatische Kandidaten haben Bildgeschwindigkeiten auf der Zeitleiste, aber keiner ist bestätigt, daher gibt es keinen offiziellen Wert.",
  speedShots: "bestätigte Kontakte",
  evidenceSpeed: "Bildgeschwindigkeit",
  physicalAvailable: "Geschätzt 3D — monokular, experimentell",
  physicalUnavailable: "Physikalische Flugbahn nicht verfügbar",
  physicalFirstObserved: "Kandidatengeschwindigkeit",
  physicalAtNet: "Geschwindigkeit an der Netzebene",
  physicalAtContact: "Kontaktgeschwindigkeit (extrapoliert)",
  physicalUncertainty: "Geschwindigkeitsbereich (Sensitivität)",
  physicalMethod: "Methode",
  physicalCalibration: "3D-Kalibrierung",
  physicalReasons: "Warum abgelehnt",
  statsEstimates: "Flugbahn-Schätzungen · nicht verifiziert",
  personNote: "Notiz einer Person",
  measured3dNotRun: "NICHT AUSGEFÜHRT — kein Stereo-Eingang",
  measured3dTitle: "Gemessen 3D — Stereo",
  estimated3dGates: "Prüfungen",
  estimated3dAssumptions: "Annahmen",
  estimated3dSpread: "Streuung über die Sensitivitätsläufe",
  estimated3dReprojection: "Reprojektionsfehler (RMS / P95)",
  estimated3dQuality: "Qualität",
  estimated3dRange: "Geschwindigkeitsbereich",
  estimated3dTitle: "Geschätzt 3D — monokular, experimentell",
  imageSpaceSpeed: "Bildgeschwindigkeit",
  speedReasonUncalibrated: "Physische km/h werden nicht aus einer einzelnen Kamera abgeleitet.",
  speedReasonHeight: "Nur Pixel pro Sekunde im Bild — keine physikalische Geschwindigkeit, nie km/h.",
  cardContacts: "Kontakt-Kandidaten",
  cardContactsNote: "Richtungswechsel des Federballs nahe einem Spieler. Keine bestätigten Kontakte.",
  cardRallies: "Ballwechsel",
  overlayContacts: "Kontakte bisher",
  cardRalliesNote: "Aus Kontaktfolgen. Nicht validiert.",
  cardPlayers: "Erfasste Spieler",
  cardPlayersNote: "Logische Identitäten in dieser Analyse.",
  videoTitle: "Annotiertes Video mit Spiel-Overlay",
  rallyTime: "Ballwechselzeit",
  rally: "Ballwechsel",
  rallyOf: "von",
  noRally: "Zwischen den Ballwechseln",
  shot: "Schlag",
  noShot: "Gerade kein Kontakt-Kandidat",
  candidate: "Kandidat",
  confirmed: "Bestätigt",
  rejected: "Verworfen",
  hits: "Kontakte",
  maxSpeed: "Max. Bildgeschwindigkeit (bestätigt)",
  tracked: "Erfasst",
  uncertain: "Unsicher",
  lost: "Nicht erfasst",
  mapTitle: "Feldkarte",
  mapUnavailable: "Feldkarte nicht verfügbar: Das Feld ist nicht kalibriert, daher lassen sich Spielerpositionen nicht auf dem Feld darstellen.",
  mapCalibration: "Kalibrierung",
  mapApproximation: "Positionen sind Fußpunkte auf einem ebenen Boden (Näherung).",
  mapShuttle: "Der Federball wird nicht gezeichnet: Seine Höhe ist unbekannt, daher hat er keine Bodenposition.",
  mapTrail: "Spuren zeigen die letzten 3 s.",
  timelineTitle: "Schlag-Zeitleiste",
  timelineIntro: "Ein Eintrag pro Kontakt-Kandidat. Wähle einen Eintrag, um dorthin zu springen und seine Belege zu sehen.",
  timelineEmpty: "Es wurden keine Kontakt-Kandidaten gefunden.",
  flagSamePlayer: "Derselbe Spieler zweimal hintereinander: wahrscheinlich ein falscher Kandidat",
  evidenceTitle: "Belege",
  evidenceTurn: "Richtungswechsel des Federballs",
  evidenceDistance: "Abstand zur Spielerbox",
  evidenceConfidence: "Konfidenz des Federball-Detektors",
  evidenceInterpolated: "Interpolierte Nachbarbilder",
  evidenceSource: "Quelle",
  evidenceModel: "Schlagmodell",
  evidenceNoModel: "Keine (keine Zeile im Flugbahn-Datensatz)",
  evidenceValidation: "Validierung",
  labelTitle: "Manuelle Prüfung",
  labelSave: "Schlagtyp speichern",
  confirmContact: "Kontakt bestätigen",
  rejectContact: "Kontakt verwerfen",
  saving: "Wird gespeichert…",
  saved: "Gespeichert. Die Analyse wurde aus den gespeicherten Korrekturen aktualisiert.",
  saveFailed: "Die Korrektur wurde nicht gespeichert.",
  ralliesTitle: "Ballwechsel",
  winnerUnsupported: "Sieger: nicht erkannt",
  heuristic: "heuristisch",
  manualEdit: "manuell",
  statsTitle: "Spielstatistik",
  statsRallies: "Ballwechsel",
  statsShots: "Personen-Labels",
  statsPlayers: "Spieler",
  statsAi: "KI-Verarbeitung",
  statCount: "Anzahl",
  statMeanDuration: "Mittlere Dauer",
  statLongest: "Längster",
  statContactsPerRally: "Kontakte pro Ballwechsel",
  statContactsCounted: "Gezählte Kontakte",
  statRejected: "Verworfen",
  statTurnsWithoutPlayer: "Richtungswechsel ohne Spieler in der Nähe",
  statSamePlayer: "Derselbe Spieler zweimal",
  statUnknown: "Unbekannter Typ",
  statLabelled: "Manuell beschriftet",
  statDistance: "Laufweg (Näherung)",
  statCoverage: "Identitätsabdeckung",
  statConfidence: "Identitätskonfidenz",
  statHits: "Kontakt-Kandidaten",
  statUnavailable: "Nicht verfügbar",
  statModels: "Ausgeführte Modelle",
  statFps: "Verarbeitungsgeschwindigkeit",
  statWall: "Verarbeitungszeit",
  statFrames: "Analysierte Bilder",
  statShuttle: "Federball-Erkennungsabdeckung",
  statIdentity: "Identitätsabdeckung",
  statCourt: "Feldkalibrierung",
  statDevice: "Gerät",
  statNote: "Abdeckung zeigt, wie oft etwas erkannt wurde. Sie ist keine Genauigkeit.",
  shotTypes: {
    smash: "Smash",
    drop: "Drop",
    clear: "Clear",
    drive: "Drive",
    net_shot: "Netzball",
    lift: "Lift",
    unknown: "Unbekannt",
  },
  validation: { unclassified: "Nicht klassifiziert", manual: "Manuell beschriftet", trajectory_unverified: "Flugbahn-Schätzung · nicht verifiziert" },
  speedAutomatic: "Bildgeschwindigkeit eines automatischen Kandidaten (nicht offiziell)",
  speedConfirmed: "offiziell: nur bestätigte Kontakte",
  modelTag: "Modell",
  labelPlayer: "Spieler",
  labelPlayerKeep: "Spieler beibehalten",
  exportGroundTruth: "Referenzdaten exportieren (JSON)",
  exportHint: "Exportiert nur menschliche Entscheidungen: bestätigte oder abgelehnte Kontakte, gesetzte Schlagarten und Spieler. Kandidaten bleiben ohne Label.",
  setHitFrame: "Trefferframe auf aktuellen Videoframe setzen",
  evidenceHitFrame: "Trefferframe (Person)",
  hitFrameNone: "Nicht erfasst",
  rallyStatusCandidate: "Kandidat · nicht validiert",
  rallyStatusUncertain: "Unsicher · nur ein Kontakt",
  rallyStatusConfirmed: "Von einer Person bestätigt",
  rallyCountLabel: "Kandidaten / bestätigt",
  rallyHint: "Ballwechsel-Kandidaten stammen aus Kontaktfolgen und sind nicht validiert. Nur von einer Person festgelegte Grenzen gelten als bestätigt.",
  unmatchedTitle: "Anmerkungen zur Prüfung",
  unmatchedHint: "Frühere Anmerkungen zu diesem Video, die keinem Kandidaten dieser Analyse entsprechen. Sie bleiben erhalten und werden nicht angewendet.",
  transferredNote: "frühere Anmerkungen auf diese Analyse angewendet",
  participationLabel: "Ballwechsel mit Schlag von",
  rallyShots: "Kontakte",
  evidenceTypeReason: "Warum dieser Typ",
  statRejectedAuto: "Automatisch verworfene Richtungswechsel"
};

export const MATCH_COPY: Record<StudioLanguage, MatchCopy> = { en: EN, vi: VI, de: DE };
