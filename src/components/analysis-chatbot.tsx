"use client";

// SmashLab Coach, laid out like a compact document assistant: a launcher pill, a panel with a brand
// header, two tabs (chat and a data report written without a language model) and a composer dock. The video never
// leaves this computer: the Coach receives the derived analysis snapshot and the coach dataset only. Every number in
// an answer is checked against that data in the browser, and the data report names the frame and time of each value.
import { Chat, useChat } from "@ai-sdk/react";
import { DefaultChatTransport, type UIMessage } from "ai";
import {
  ArrowDown,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  ClipboardList,
  Copy,
  Maximize2,
  MessageSquareText,
  Minimize2,
  Minus,
  PanelsTopLeft,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { MessageResponse } from "@/components/ai-elements/message";
import { BADMINTON_KNOWLEDGE } from "@/lib/ai/badminton-knowledge";
import { buildCoachReport, evidenceLabel, isCoachDataset, type ReportTone } from "@/lib/ai/coach-report";
import { checkAnswerNumbers, collectKnownNumbers, type KnownNumbers, type NumberCheckResult } from "@/lib/ai/number-check";
import { publishAnalysisSnapshot, useAnalysisSnapshot } from "@/lib/analysis-session-store";
import { apiUrl, LOCAL_AI_PROXY_BASE, readStoredJobId } from "@/lib/local-ai/client";
import type { MatchDocument } from "@/lib/match/types";
import type { StudioLanguage } from "@/lib/studio-types";
import { buildVideoAnalysisSnapshot, type VideoAnalysisResults } from "@/lib/video-analysis";
import styles from "./analysis-chatbot.module.css";

// The parts of a job record the Coach needs to label a stored analysis.
type StoredJob = {
  status: string;
  created_at: number;
  source: { kind: string; name: string };
};

type Tab = "chat" | "report";

const CHAT_COPY = {
  en: {
    subtitleData: (provider: string) => `Answers from this analysis · ${provider}`,
    subtitleEmpty: (provider: string) => `Badminton knowledge with sources · ${provider}`,
    launcher: "Coach",
    launcherBadge: "AI",
    tabs: { chat: "Ask Coach", report: "Data report" },
    tabsLabel: "Coach views",
    sources: { none: "No analysis selected", "video-analysis": "Video analysis" },
    contextLabel: "What the Coach reads",
    detections: "Frames with a shuttle detection",
    tracks: "Player tracks",
    contacts: "Contacts",
    court: "Court",
    calibrated: "Calibrated",
    notCalibrated: "Not calibrated",
    contextHint: "Only these derived values and the coach dataset of this analysis are sent. The video stays on this computer.",
    trustTitle: "How the Coach handles your data",
    trust: [
      "The video stays on this computer. The Coach receives derived numbers only, never frames.",
      "Answers come from this analysis and a cited knowledge base. Every number in an answer is checked against the data.",
      "Shot labels are trajectory estimates and unverified. Shuttle values are image-space px/s, never km/h.",
      "The data report is written from the analysis without a language model.",
    ],
    welcomeWithData: (name: string, tracks: number, detections: number, contacts: number) =>
      `I have the analysis of **${name}**: ${tracks} player tracks, ${detections} frames with a shuttle detection and ${contacts} contacts. Shot types are trajectory estimates (trajectory-rules) and unverified. Shuttle values are image-space px/s, not physical speeds.`,
    welcomeEmpty: "Ask a technique question now. For feedback on a video, analyse it in Video analysis first; the Coach then reads that analysis.",
    capabilities: [
      { title: "Reads this analysis", detail: "Movement, contacts, trajectory estimates and image-space speeds of the open analysis" },
      { title: "Checks every number", detail: "Each value in an answer is looked up in the analysis data" },
      { title: "Cites its sources", detail: "General advice comes from a small cited knowledge base" },
    ],
    suggestionsLabel: "Try asking",
    suggestionsHint: "Pick a question to send it.",
    suggestionsWithData: ["Summarize this analysis", "Which player moved more, and by how much?", "Which contacts need review first?", "What can this analysis not measure?"],
    suggestionsEmpty: ["How do I prepare a smash?", "What is a good split step?", "How does the Coach use my analysis?"],
    placeholderWithData: "Ask about this analysis…",
    placeholderEmpty: "Ask Coach about badminton technique…",
    inputLabel: "Question for SmashLab Coach",
    send: "Send",
    stop: "Stop",
    keyboardHint: "Enter to send · Shift+Enter for a new line",
    thinking: "Reading the analysis data…",
    error: "The AI Coach is unavailable. Please try again.",
    retry: "Try again",
    timeout: "The AI Coach took too long and was stopped.",
    latest: "Latest messages",
    copy: "Copy",
    copied: "Copied",
    copyFailed: "Copy failed",
    clear: "Clear conversation",
    open: "Open SmashLab Coach",
    minimize: "Minimise",
    expand: "Expand",
    restore: "Restore size",
    openPage: "Open the Coach page",
    conversation: "Conversation with SmashLab Coach",
    disclosureTitle: "About these answers",
    disclaimer: "AI can be wrong. The analysis detects the shuttle and people in image coordinates. Contacts, shot types and speeds are unvalidated estimates, not measurements, and nothing is evaluated against ground truth.",
    checkOk: (matched: number, checked: number) => `${matched} of ${checked} numbers found in the data`,
    checkWarn: (count: number) => `${count} ${count === 1 ? "number" : "numbers"} not found in the data`,
    checkPhysical: "Physical speed is not measured in this build",
    checkSources: (analysis: number, question: number, knowledge: number) => `analysis ${analysis} · question ${question} · knowledge ${knowledge}`,
    checkDetail: "Check these values in the data report before you rely on them.",
    reportNoAnalysis: "Open a completed analysis to see its data report.",
    reportLoading: "Loading the analysis data…",
    reportUnavailable: "The coach dataset of this analysis could not be loaded.",
    copyReport: "Copy report",
    askReport: "Ask Coach about this report",
    askReportPrompt: "Explain the data report of this analysis in plain words. Name the frame and time of each value you use.",
    evidenceNote: "Each value names its frame and time, or the analysed range.",
  },
  vi: {
    subtitleData: (provider: string) => `Trả lời từ phân tích này · ${provider}`,
    subtitleEmpty: (provider: string) => `Kiến thức cầu lông có nguồn · ${provider}`,
    launcher: "Coach",
    launcherBadge: "AI",
    tabs: { chat: "Hỏi Coach", report: "Báo cáo từ dữ liệu" },
    tabsLabel: "Chế độ xem của Coach",
    sources: { none: "Chưa chọn phân tích", "video-analysis": "Phân tích video" },
    contextLabel: "Dữ liệu Coach đọc",
    detections: "Khung có phát hiện cầu",
    tracks: "Quỹ đạo người",
    contacts: "Lần tiếp xúc",
    court: "Sân",
    calibrated: "Đã hiệu chỉnh",
    notCalibrated: "Chưa hiệu chỉnh",
    contextHint: "Chỉ gửi các giá trị đã tính và bộ dữ liệu Coach của phân tích này. Video ở lại trên máy này.",
    trustTitle: "Coach xử lý dữ liệu của bạn thế nào",
    trust: [
      "Video ở lại trên máy này. Coach chỉ nhận các con số đã tính, không bao giờ nhận khung hình.",
      "Câu trả lời lấy từ phân tích này và kho kiến thức có nguồn. Mọi con số trong câu trả lời đều được đối chiếu với dữ liệu.",
      "Nhãn cú đánh là ước lượng từ quỹ đạo và chưa kiểm chứng. Giá trị của cầu là px/s trong ảnh, không bao giờ là km/h.",
      "Báo cáo từ dữ liệu được viết từ phân tích, không dùng mô hình ngôn ngữ.",
    ],
    welcomeWithData: (name: string, tracks: number, detections: number, contacts: number) =>
      `Mình đã nhận phân tích của **${name}**: ${tracks} quỹ đạo người, ${detections} khung có phát hiện cầu và ${contacts} lần tiếp xúc. Loại cú đánh là ước lượng từ quỹ đạo (trajectory-rules) và chưa kiểm chứng. Giá trị của cầu là px/s trong ảnh, không phải tốc độ vật lý.`,
    welcomeEmpty: "Bạn có thể hỏi kiến thức kỹ thuật ngay bây giờ. Để nhận nhận định về một video, hãy phân tích video ở mục Phân tích video; Coach sẽ đọc phân tích đó.",
    capabilities: [
      { title: "Đọc phân tích này", detail: "Di chuyển, lần tiếp xúc, ước lượng quỹ đạo và tốc độ trong ảnh của phân tích đang mở" },
      { title: "Kiểm tra mọi con số", detail: "Mỗi giá trị trong câu trả lời được tra lại trong dữ liệu phân tích" },
      { title: "Có trích nguồn", detail: "Lời khuyên chung lấy từ một kho kiến thức nhỏ có nguồn" },
    ],
    suggestionsLabel: "Thử hỏi",
    suggestionsHint: "Chọn một câu để gửi.",
    suggestionsWithData: ["Tóm tắt phân tích này", "Người nào di chuyển nhiều hơn, nhiều hơn bao nhiêu?", "Lần tiếp xúc nào nên xem lại trước?", "Phân tích này không đo được những gì?"],
    suggestionsEmpty: ["Chuẩn bị cú đập cầu thế nào?", "Bước chân chia (split step) đúng là gì?", "Coach dùng phân tích của tôi thế nào?"],
    placeholderWithData: "Hỏi về phân tích này…",
    placeholderEmpty: "Hỏi Coach về kỹ thuật cầu lông…",
    inputLabel: "Câu hỏi cho SmashLab Coach",
    send: "Gửi",
    stop: "Dừng",
    keyboardHint: "Enter để gửi · Shift+Enter để xuống dòng",
    thinking: "Đang đọc dữ liệu phân tích…",
    error: "Không thể kết nối AI Coach. Vui lòng thử lại.",
    retry: "Thử lại",
    timeout: "AI Coach trả lời quá lâu và đã được dừng.",
    latest: "Tin nhắn mới nhất",
    copy: "Sao chép",
    copied: "Đã sao chép",
    copyFailed: "Không sao chép được",
    clear: "Xóa cuộc trò chuyện",
    open: "Mở SmashLab Coach",
    minimize: "Thu nhỏ",
    expand: "Mở rộng",
    restore: "Về kích thước cũ",
    openPage: "Mở trang Coach",
    conversation: "Cuộc trò chuyện với SmashLab Coach",
    disclosureTitle: "Về câu trả lời",
    disclaimer: "AI có thể sai. Phân tích chỉ phát hiện cầu và người trong tọa độ ảnh. Lần tiếp xúc, loại cú đánh và tốc độ là ước lượng chưa kiểm chứng, không phải phép đo, và không có gì được đánh giá với dữ liệu chuẩn.",
    checkOk: (matched: number, checked: number) => `${matched}/${checked} con số khớp dữ liệu`,
    checkWarn: (count: number) => `${count} con số không có trong dữ liệu`,
    checkPhysical: "Bản này không đo tốc độ vật lý",
    checkSources: (analysis: number, question: number, knowledge: number) => `phân tích ${analysis} · câu hỏi ${question} · kiến thức ${knowledge}`,
    checkDetail: "Hãy đối chiếu các giá trị này trong báo cáo từ dữ liệu trước khi dùng.",
    reportNoAnalysis: "Mở một phân tích đã hoàn tất để xem báo cáo từ dữ liệu.",
    reportLoading: "Đang tải dữ liệu phân tích…",
    reportUnavailable: "Không tải được bộ dữ liệu Coach của phân tích này.",
    copyReport: "Sao chép báo cáo",
    askReport: "Hỏi Coach về báo cáo này",
    askReportPrompt: "Giải thích báo cáo từ dữ liệu của phân tích này bằng lời dễ hiểu. Nêu khung hình và thời điểm của mỗi giá trị bạn dùng.",
    evidenceNote: "Mỗi giá trị ghi rõ khung hình và thời điểm, hoặc đoạn đã phân tích.",
  },
  de: {
    subtitleData: (provider: string) => `Antworten aus dieser Analyse · ${provider}`,
    subtitleEmpty: (provider: string) => `Badminton-Wissen mit Quellen · ${provider}`,
    launcher: "Coach",
    launcherBadge: "KI",
    tabs: { chat: "Coach fragen", report: "Datenbericht" },
    tabsLabel: "Coach-Ansichten",
    sources: { none: "Keine Analyse gewählt", "video-analysis": "Videoanalyse" },
    contextLabel: "Was der Coach liest",
    detections: "Frames mit Federball-Erkennung",
    tracks: "Spieler-Tracks",
    contacts: "Kontakte",
    court: "Feld",
    calibrated: "Kalibriert",
    notCalibrated: "Nicht kalibriert",
    contextHint: "Gesendet werden nur diese abgeleiteten Werte und der Coach-Datensatz dieser Analyse. Das Video bleibt auf diesem Rechner.",
    trustTitle: "Wie der Coach mit deinen Daten umgeht",
    trust: [
      "Das Video bleibt auf diesem Rechner. Der Coach erhält nur abgeleitete Zahlen, nie Bilder.",
      "Antworten stammen aus dieser Analyse und einer Wissensbasis mit Quellen. Jede Zahl einer Antwort wird mit den Daten abgeglichen.",
      "Schlagarten sind Flugbahn-Schätzungen und unverifiziert. Federballwerte sind px/s im Bild, nie km/h.",
      "Der Datenbericht wird ohne Sprachmodell aus der Analyse geschrieben.",
    ],
    welcomeWithData: (name: string, tracks: number, detections: number, contacts: number) =>
      `Ich habe die Analyse von **${name}**: ${tracks} Spieler-Tracks, ${detections} Frames mit Federball-Erkennung und ${contacts} Kontakte. Schlagarten sind Flugbahn-Schätzungen (trajectory-rules) und unverifiziert. Federballwerte sind px/s im Bild, keine physikalischen Geschwindigkeiten.`,
    welcomeEmpty: "Stelle jetzt eine Technikfrage. Für Feedback zu einem Video analysiere es zuerst unter Videoanalyse; der Coach liest dann diese Analyse.",
    capabilities: [
      { title: "Liest diese Analyse", detail: "Bewegung, Kontakte, Flugbahn-Schätzungen und Bildraum-Geschwindigkeiten der geöffneten Analyse" },
      { title: "Prüft jede Zahl", detail: "Jeder Wert einer Antwort wird in den Analysedaten nachgeschlagen" },
      { title: "Nennt Quellen", detail: "Allgemeine Hinweise stammen aus einer kleinen Wissensbasis mit Quellen" },
    ],
    suggestionsLabel: "Frag zum Beispiel",
    suggestionsHint: "Wähle eine Frage, um sie zu senden.",
    suggestionsWithData: ["Fasse diese Analyse zusammen", "Wer hat sich mehr bewegt, und um wie viel?", "Welche Kontakte sollte ich zuerst prüfen?", "Was kann diese Analyse nicht messen?"],
    suggestionsEmpty: ["Wie bereite ich einen Smash vor?", "Was ist ein guter Split-Step?", "Wie nutzt der Coach meine Analyse?"],
    placeholderWithData: "Frage zu dieser Analyse…",
    placeholderEmpty: "Frage den Coach zur Badminton-Technik…",
    inputLabel: "Frage an SmashLab Coach",
    send: "Senden",
    stop: "Stopp",
    keyboardHint: "Enter zum Senden · Umschalt+Enter für eine neue Zeile",
    thinking: "Analysedaten werden gelesen…",
    error: "Der AI Coach ist nicht verfügbar. Bitte versuche es erneut.",
    retry: "Erneut versuchen",
    timeout: "Der AI Coach hat zu lange gebraucht und wurde gestoppt.",
    latest: "Neueste Nachrichten",
    copy: "Kopieren",
    copied: "Kopiert",
    copyFailed: "Kopieren fehlgeschlagen",
    clear: "Unterhaltung löschen",
    open: "SmashLab Coach öffnen",
    minimize: "Minimieren",
    expand: "Vergrößern",
    restore: "Ursprüngliche Größe",
    openPage: "Coach-Seite öffnen",
    conversation: "Unterhaltung mit SmashLab Coach",
    disclosureTitle: "Zu diesen Antworten",
    disclaimer: "KI kann Fehler machen. Die Analyse erkennt Federball und Personen nur in Bildkoordinaten. Kontakte, Schlagarten und Geschwindigkeiten sind nicht validierte Schätzungen, keine Messungen, und nichts wird gegen Ground Truth bewertet.",
    checkOk: (matched: number, checked: number) => `${matched} von ${checked} Zahlen in den Daten gefunden`,
    checkWarn: (count: number) => `${count} ${count === 1 ? "Zahl" : "Zahlen"} nicht in den Daten`,
    checkPhysical: "Physikalische Geschwindigkeit wird in diesem Build nicht gemessen",
    checkSources: (analysis: number, question: number, knowledge: number) => `Analyse ${analysis} · Frage ${question} · Wissen ${knowledge}`,
    checkDetail: "Prüfe diese Werte im Datenbericht, bevor du dich auf sie verlässt.",
    reportNoAnalysis: "Öffne eine abgeschlossene Analyse, um ihren Datenbericht zu sehen.",
    reportLoading: "Analysedaten werden geladen…",
    reportUnavailable: "Der Coach-Datensatz dieser Analyse konnte nicht geladen werden.",
    copyReport: "Bericht kopieren",
    askReport: "Coach zu diesem Bericht fragen",
    askReportPrompt: "Erkläre den Datenbericht dieser Analyse in einfachen Worten. Nenne Frame und Zeit jedes verwendeten Werts.",
    evidenceNote: "Jeder Wert nennt seinen Frame und seine Zeit oder den analysierten Bereich.",
  },
} as const;

/** The knowledge base the server retrieves from; its numbers count as known in the number check. */
const KNOWLEDGE_TEXT = BADMINTON_KNOWLEDGE.map((chunk) => `${chunk.title}. ${chunk.content}`);

/** A local answer takes minutes on a CPU; this only stops a request that never starts streaming. */
const COACH_TIMEOUT_MS = 240_000;

// One conversation for the whole studio: the floating panel and the Coach page show the same messages.
let sharedChat: Chat<UIMessage> | null = null;
function coachChat(): Chat<UIMessage> {
  sharedChat ??= new Chat<UIMessage>({ transport: new DefaultChatTransport({ api: "/api/ai/chat" }) });
  return sharedChat;
}

function messageText(message: UIMessage): string {
  return message.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n");
}

type AnalysisChatbotProps = {
  variant?: "floating" | "workspace";
  language: StudioLanguage;
  onOpenWorkspace?: () => void;
};

export default function AnalysisChatbot({ variant = "floating", language, onOpenWorkspace }: AnalysisChatbotProps) {
  const analysis = useAnalysisSnapshot();
  const copy = CHAT_COPY[language];
  const floating = variant === "floating";
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<Tab>("chat");
  const [trustOpen, setTrustOpen] = useState(false);
  const [input, setInput] = useState("");
  const [suggestionsOpen, setSuggestionsOpen] = useState(true);
  const visible = !floating || open;
  const chat = useMemo(() => coachChat(), []);
  const { messages, sendMessage, status, stop, error, setMessages } = useChat({ chat, throttle: 40 });
  const launcher = useRef<HTMLButtonElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const suggestionsRef = useRef<HTMLDetailsElement>(null);

  const hasAnalysis = analysis.source !== "none";
  const isGenerating = status === "submitted" || status === "streaming";
  const [providerLabel, setProviderLabel] = useState("…");
  const [loadedDataset, setLoadedDataset] = useState<{ jobId: string; data: Record<string, unknown> | null } | null>(null);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    let active = true;
    fetch("/api/ai/status", { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { model?: string } | null) => {
        if (active && body?.model) setProviderLabel(body.model);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, []);

  const analysisJobId = analysis.jobId;
  useEffect(() => {
    // The coach dataset of the open analysis only: this job's movement and shot timeline, read from the backend.
    if (!analysisJobId) return;
    let active = true;
    fetch(apiUrl(LOCAL_AI_PROXY_BASE, `/api/v1/analyses/${encodeURIComponent(analysisJobId)}/coach-dataset`), { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: Record<string, unknown> | null) => {
        if (active) setLoadedDataset({ jobId: analysisJobId, data: body });
      })
      .catch(() => {
        if (active) setLoadedDataset({ jobId: analysisJobId, data: null });
      });
    return () => {
      active = false;
    };
  }, [analysisJobId]);
  // Only the dataset of the analysis that is open is ever sent or reported.
  const coachDataset = loadedDataset && loadedDataset.jobId === analysisJobId ? loadedDataset.data : null;
  const datasetLoading = Boolean(analysisJobId) && (!loadedDataset || loadedDataset.jobId !== analysisJobId);

  useEffect(() => {
    // Opened on its own (for example from Saved sessions), the Coach has no snapshot yet. It then loads the analysis the
    // studio stored last: the job's results and match document, built the same way as on the analysis page.
    if (analysis.source !== "none") return;
    const storedJobId = readStoredJobId(typeof window !== "undefined" ? window.localStorage : null);
    if (!storedJobId) return;
    let active = true;
    const load = async <T,>(path: string): Promise<T | null> => {
      const response = await fetch(apiUrl(LOCAL_AI_PROXY_BASE, path), { cache: "no-store" });
      return response.ok ? ((await response.json()) as T) : null;
    };
    (async () => {
      const base = `/api/v1/analyses/${encodeURIComponent(storedJobId)}`;
      const [job, results, match] = await Promise.all([
        load<StoredJob>(base),
        load<VideoAnalysisResults>(`${base}/results`),
        load<MatchDocument>(`${base}/match`),
      ]);
      if (!active || !job || job.status !== "completed" || !results) return;
      publishAnalysisSnapshot(buildVideoAnalysisSnapshot(results, {
        jobId: storedJobId,
        sourceKind: job.source.kind === "upload" ? "upload" : "sample",
        sourceName: job.source.name,
        capturedAt: new Date(job.created_at * 1000).toISOString(),
      }, match));
    })().catch(() => undefined);
    return () => {
      active = false;
    };
  }, [analysis.source]);

  useEffect(() => {
    // A request that never starts streaming is stopped, so the panel cannot wait forever.
    if (status !== "submitted") return;
    const timer = window.setTimeout(() => {
      setTimedOut(true);
      void stop();
    }, COACH_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [status, stop]);

  useEffect(() => {
    if (visible && tab === "chat") textarea.current?.focus({ preventScroll: true });
  }, [visible, tab]);

  useEffect(() => {
    // On a phone or a short window the questions start folded, so the answers keep their space. Closing the element
    // fires its toggle event, which updates the state.
    if (suggestionsRef.current && window.matchMedia("(max-width: 620px), (max-height: 760px)").matches) {
      suggestionsRef.current.open = false;
    }
  }, []);

  const trackCount = analysis.players.tracksConfirmed;
  const detectionCount = analysis.shuttle.framesDetected;
  const datasetDoc = isCoachDataset(coachDataset) ? coachDataset : null;
  const contactCount = datasetDoc?.shot_counts?.rows ?? analysis.shotTimeline.length;

  const report = useMemo(() => buildCoachReport(datasetDoc, language, {
    sourceName: analysis.sourceName,
    framesAnalysed: analysis.video.framesAnalysed,
    durationS: analysis.video.durationS,
    fps: analysis.video.fps,
  }), [datasetDoc, language, analysis.sourceName, analysis.video.framesAnalysed, analysis.video.durationS, analysis.video.fps]);

  const userTexts = useMemo(() => messages.filter((message) => message.role === "user").map(messageText), [messages]);
  const known = useMemo(
    () => collectKnownNumbers({ analysis: [coachDataset, hasAnalysis ? analysis : null], question: userTexts, knowledge: KNOWLEDGE_TEXT }),
    [coachDataset, analysis, hasAnalysis, userTexts],
  );

  function minimize() {
    setOpen(false);
    requestAnimationFrame(() => launcher.current?.focus());
  }

  function submitMessage(text: string) {
    const normalized = text.trim();
    if (!normalized || isGenerating) return;
    setTimedOut(false);
    setSuggestionsOpen(false);
    setTab("chat");
    void sendMessage(
      { text: normalized },
      { headers: { "X-SmashLab-Language": language }, body: { analysis, language, coachDataset } },
    );
    setInput("");
  }

  function retryLast() {
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    const text = lastUser ? messageText(lastUser) : "";
    if (text) submitMessage(text);
  }

  const suggestions = hasAnalysis ? copy.suggestionsWithData : copy.suggestionsEmpty;
  const panelId = `smashlab-coach-${variant}`;

  return (
    <div className={`${styles.chatbot} ${floating ? styles.floating : styles.workspace} ${visible ? styles.isOpen : ""}`}>
      <section
        id={panelId}
        className={`${styles.panel} ${expanded && floating ? styles.expanded : ""}`}
        role={floating ? "dialog" : "region"}
        aria-modal={floating ? false : undefined}
        aria-labelledby={`${panelId}-title`}
        hidden={!visible}
        onKeyDown={(event) => {
          if (floating && event.key === "Escape") {
            event.stopPropagation();
            minimize();
          }
        }}
      >
        <header className={styles.header}>
          <span className={styles.avatar} aria-hidden="true"><CoachMark /></span>
          <div className={styles.headerText}>
            <h2 id={`${panelId}-title`}>SmashLab Coach</h2>
            <p>{hasAnalysis ? copy.subtitleData(providerLabel) : copy.subtitleEmpty(providerLabel)}</p>
          </div>
          <button type="button" className={styles.trustButton} onClick={() => { setTab("chat"); setTrustOpen((value) => !value); }}
            aria-label={copy.trustTitle} title={copy.trustTitle} aria-pressed={trustOpen}>
            <ShieldCheck size={17} />
          </button>
          {floating ? (
            <button type="button" onClick={() => setExpanded((value) => !value)} aria-label={expanded ? copy.restore : copy.expand}
              title={expanded ? copy.restore : copy.expand} aria-pressed={expanded} className={styles.sizeButton}>
              {expanded ? <Minimize2 size={17} /> : <Maximize2 size={17} />}
            </button>
          ) : null}
          {floating && onOpenWorkspace ? (
            <button type="button" onClick={onOpenWorkspace} aria-label={copy.openPage} title={copy.openPage}>
              <PanelsTopLeft size={17} />
            </button>
          ) : null}
          {floating ? (
            <button type="button" onClick={minimize} aria-label={copy.minimize} title={copy.minimize}><Minus size={19} /></button>
          ) : null}
        </header>

        <div className={styles.tabs} role="tablist" aria-label={copy.tabsLabel}>
          {(["chat", "report"] as const).map((name) => (
            <button key={name} type="button" role="tab" id={`${panelId}-tab-${name}`} aria-selected={tab === name}
              aria-controls={`${panelId}-pane-${name}`} className={tab === name ? styles.tabActive : ""} onClick={() => setTab(name)}>
              {name === "chat" ? <MessageSquareText size={15} /> : <ClipboardList size={15} />}
              {copy.tabs[name]}
            </button>
          ))}
        </div>

        <div className={styles.content}>
          {tab === "chat" ? (
            <div className={styles.chatPane} role="tabpanel" id={`${panelId}-pane-chat`} aria-labelledby={`${panelId}-tab-chat`}>
              <CoachConversation messages={messages} label={copy.conversation} latest={copy.latest} active={visible}>
                <details className={styles.context}>
                  <summary>
                    <Sparkles size={13} aria-hidden="true" />
                    <span>{hasAnalysis ? analysis.sourceName : copy.sources.none} · {providerLabel}</span>
                    <ChevronDown size={14} aria-hidden="true" />
                    <span className={styles.srOnly}>{copy.contextLabel}</span>
                  </summary>
                  <dl>
                    <div><dt>{copy.sources[analysis.source]}</dt><dd>{hasAnalysis ? analysis.sourceName : "—"}</dd></div>
                    <div><dt>{copy.detections}</dt><dd>{detectionCount}</dd></div>
                    <div><dt>{copy.tracks}</dt><dd>{trackCount}</dd></div>
                    <div><dt>{copy.contacts}</dt><dd>{contactCount}</dd></div>
                    <div><dt>{copy.court}</dt><dd>{analysis.court.status === "calibrated" ? copy.calibrated : copy.notCalibrated}</dd></div>
                  </dl>
                  <p>{copy.contextHint}</p>
                </details>

                {trustOpen ? (
                  <div className={styles.trustCard} role="note">
                    <strong><ShieldCheck size={15} aria-hidden="true" />{copy.trustTitle}</strong>
                    <ul>{copy.trust.map((item) => <li key={item}>{item}</li>)}</ul>
                  </div>
                ) : null}

                {!messages.length ? (
                  <article className={`${styles.bubble} ${styles.assistant}`}>
                    <MessageResponse>
                      {hasAnalysis ? copy.welcomeWithData(analysis.sourceName, trackCount, detectionCount, contactCount) : copy.welcomeEmpty}
                    </MessageResponse>
                    <ul className={styles.capabilities}>
                      {copy.capabilities.map((item, index) => (
                        <li key={item.title}>
                          {index === 0 ? <Sparkles size={15} aria-hidden="true" /> : index === 1 ? <CircleCheck size={15} aria-hidden="true" /> : <ClipboardList size={15} aria-hidden="true" />}
                          <span><strong>{item.title}</strong>{item.detail}</span>
                        </li>
                      ))}
                    </ul>
                  </article>
                ) : null}

                {messages.map((message, index) => {
                  const text = messageText(message);
                  if (message.role === "user") {
                    return <article key={message.id} className={`${styles.bubble} ${styles.user}`}><p>{text}</p></article>;
                  }
                  const streaming = index === messages.length - 1 && status === "streaming";
                  return (
                    <article key={message.id} className={`${styles.bubble} ${styles.assistant}`}>
                      <MessageResponse isAnimating={streaming}>{text}</MessageResponse>
                      {!streaming && text.trim() ? (
                        <div className={styles.answerActions}>
                          <CopyButton text={text} labels={copy} />
                          <NumberCheck text={text} known={known} labels={copy} />
                        </div>
                      ) : null}
                    </article>
                  );
                })}

                {status === "submitted" ? <div className={styles.thinking}><i /><span>{copy.thinking}</span></div> : null}
                {timedOut ? <p className={styles.error}>{copy.timeout}</p> : null}
                {error || timedOut ? (
                  <div className={styles.errorRow}>
                    {error ? <p className={styles.error}>{copy.error}</p> : null}
                    <button type="button" className={styles.secondaryButton} onClick={retryLast}>{copy.retry}</button>
                  </div>
                ) : null}
              </CoachConversation>

              <div className={styles.dock}>
                <details ref={suggestionsRef} className={styles.suggestions} open={suggestionsOpen}
                  onToggle={(event) => setSuggestionsOpen(event.currentTarget.open)}>
                  <summary>{copy.suggestionsLabel}</summary>
                  <p>{copy.suggestionsHint}</p>
                  <div>
                    {suggestions.map((question) => (
                      <button type="button" key={question} disabled={isGenerating} onClick={() => submitMessage(question)}>{question}</button>
                    ))}
                  </div>
                </details>
                <CoachComposer
                  id={`${panelId}-input`}
                  inputRef={textarea}
                  value={input}
                  onChange={setInput}
                  onSubmit={(event) => {
                    event.preventDefault();
                    submitMessage(input);
                  }}
                  onStop={() => void stop()}
                  generating={isGenerating}
                  labels={copy}
                  placeholder={hasAnalysis ? copy.placeholderWithData : copy.placeholderEmpty}
                  controls={messages.length ? (
                    <button type="button" className={styles.iconButton} onClick={() => { void stop(); setMessages([]); setSuggestionsOpen(true); }}
                      aria-label={copy.clear} title={copy.clear}>
                      <Trash2 size={15} />
                    </button>
                  ) : null}
                />
                <details className={styles.disclosure}>
                  <summary><CircleAlert size={13} aria-hidden="true" />{copy.disclosureTitle}</summary>
                  <p>{copy.disclaimer}</p>
                </details>
              </div>
            </div>
          ) : (
            <div className={styles.reportPane} role="tabpanel" id={`${panelId}-pane-report`} aria-labelledby={`${panelId}-tab-report`}>
              {!hasAnalysis ? (
                <p className={styles.reportEmpty}>{copy.reportNoAnalysis}</p>
              ) : datasetLoading ? (
                <p className={styles.reportEmpty}>{copy.reportLoading}</p>
              ) : !report ? (
                <p className={styles.reportEmpty}>{copy.reportUnavailable}</p>
              ) : (
                <div className={styles.report}>
                  <header className={styles.reportHeader}>
                    <div>
                      <h3>{report.title}</h3>
                      <p>{report.subtitle}</p>
                    </div>
                    <div className={styles.reportActions}>
                      <CopyButton text={report.markdown} labels={{ ...copy, copy: copy.copyReport }} />
                      <button type="button" className={styles.secondaryButton} disabled={isGenerating}
                        onClick={() => submitMessage(copy.askReportPrompt)}>
                        <MessageSquareText size={14} />{copy.askReport}
                      </button>
                    </div>
                  </header>
                  <p className={styles.evidenceNote}>{copy.evidenceNote}</p>
                  {report.sections.map((section) => (
                    <section key={section.id} className={styles.reportSection} aria-labelledby={`${panelId}-${section.id}`}>
                      <h4 id={`${panelId}-${section.id}`}>{section.title}</h4>
                      <ul>
                        {section.lines.map((item, index) => (
                          <li key={`${section.id}-${index}`} className={TONE_CLASS[item.tone]}>
                            <span className={styles.toneDot} aria-hidden="true" />
                            <span className={styles.reportText}>{item.text}</span>
                            {item.evidence ? <span className={styles.evidence}>{evidenceLabel(item.evidence, language)}</span> : null}
                          </li>
                        ))}
                      </ul>
                    </section>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      {floating && !open ? (
        <button ref={launcher} type="button" className={styles.launcher} onClick={() => setOpen(true)}
          aria-expanded={open} aria-controls={panelId} aria-label={copy.open}>
          <span className={styles.launcherAvatar} aria-hidden="true"><CoachMark /></span>
          <span className={styles.launcherText}>{copy.launcher}<small>{copy.launcherBadge}</small></span>
          {hasAnalysis ? <span className={styles.launcherDot} aria-hidden="true" /> : null}
        </button>
      ) : null}
    </div>
  );
}

const TONE_CLASS: Record<ReportTone, string> = {
  fact: styles.toneFact,
  estimate: styles.toneEstimate,
  unavailable: styles.toneUnavailable,
  note: styles.toneNote,
};

/** The Coach's mark: a shuttle drawn as an icon. No portrait, so nobody mistakes the assistant for a person. */
function CoachMark() {
  return (
    <svg viewBox="0 0 32 32" width="100%" height="100%" role="img" aria-hidden="true" focusable="false">
      <circle cx="16" cy="23" r="5" fill="currentColor" opacity=".95" />
      <path d="M11.4 21.2 7 6.5m9 13.5V5m4.6 16.2L25 6.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none" />
      <path d="M7.6 11.5h16.8M8.9 16h14.2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity=".7" fill="none" />
    </svg>
  );
}

function CoachConversation({ messages, label, latest, active, children }: {
  messages: readonly unknown[];
  label: string;
  latest: string;
  active: boolean;
  children: ReactNode;
}) {
  const log = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const count = useRef(0);
  const [away, setAway] = useState(false);
  useEffect(() => {
    const element = log.current;
    if (!active || !element) return;
    if (!messages.length) {
      element.scrollTop = 0; // before the first question the context and the welcome are read from the top
    } else if (following.current || count.current === 0) {
      following.current = true;
      element.scrollTop = element.scrollHeight;
    }
    count.current = messages.length;
  }, [messages, active]);
  useEffect(() => {
    const element = log.current;
    if (!active || !element) return;
    const observer = new ResizeObserver(() => {
      if (following.current && count.current > 0) element.scrollTop = element.scrollHeight;
    });
    observer.observe(element.firstElementChild ?? element);
    return () => observer.disconnect();
  }, [active]);
  return (
    <div className={styles.conversation}>
      <div ref={log} className={styles.history} role="log" aria-label={label} aria-live="polite" tabIndex={0}
        onScroll={(event) => {
          const element = event.currentTarget;
          following.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
          setAway(!following.current);
        }}>
        <div className={styles.messages}>{children}</div>
      </div>
      {away ? (
        <button type="button" className={styles.latest} onClick={() => {
          following.current = true;
          setAway(false);
          if (log.current) log.current.scrollTop = log.current.scrollHeight;
        }}>
          <ArrowDown size={14} />{latest}
        </button>
      ) : null}
    </div>
  );
}

function CoachComposer({ id, inputRef, value, onChange, onSubmit, onStop, generating, labels, placeholder, controls }: {
  id: string;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onStop: () => void;
  generating: boolean;
  labels: { inputLabel: string; send: string; stop: string; keyboardHint: string };
  placeholder: string;
  controls?: ReactNode;
}) {
  const composing = useRef(false);
  const enabled = !generating && Boolean(value.trim());
  useEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(104, Math.max(46, element.scrollHeight))}px`;
  }, [value, inputRef]);
  return (
    <>
      <form className={styles.composer} onSubmit={onSubmit}>
        <label className={styles.srOnly} htmlFor={id}>{labels.inputLabel}</label>
        <textarea
          ref={inputRef}
          id={id}
          rows={2}
          maxLength={2000}
          value={value}
          placeholder={placeholder}
          aria-describedby={`${id}-hint`}
          onChange={(event) => onChange(event.target.value)}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey || composing.current || event.nativeEvent.isComposing) return;
            event.preventDefault();
            if (enabled) event.currentTarget.form?.requestSubmit();
          }}
        />
        {generating ? (
          <button type="button" className={styles.sendButton} onClick={onStop}><Square size={14} />{labels.stop}</button>
        ) : (
          <button type="submit" className={styles.sendButton} disabled={!enabled}><Send size={16} />{labels.send}</button>
        )}
      </form>
      <div className={styles.composerFooter}>
        <p id={`${id}-hint`}>{labels.keyboardHint}</p>
        {controls ? <div className={styles.controls}>{controls}</div> : null}
      </div>
    </>
  );
}

function CopyButton({ text, labels }: { text: string; labels: { copy: string; copied: string; copyFailed: string } }) {
  const [result, setResult] = useState<"copied" | "failed">();
  useEffect(() => {
    if (!result) return;
    const timer = window.setTimeout(() => setResult(undefined), 2500);
    return () => window.clearTimeout(timer);
  }, [result]);
  async function copyText() {
    try {
      await navigator.clipboard.writeText(text);
      setResult("copied");
    } catch {
      setResult("failed");
    }
  }
  return (
    <span className={styles.copyWrap}>
      <button type="button" className={styles.actionButton} disabled={!text.trim()} onClick={() => void copyText()}>
        {result === "copied" ? <Check size={14} /> : <Copy size={14} />}{labels.copy}
      </button>
      {result ? <span role="status" className={styles.copyStatus}>{result === "copied" ? labels.copied : labels.copyFailed}</span> : null}
    </span>
  );
}

function NumberCheck({ text, known, labels }: {
  text: string;
  known: KnownNumbers;
  labels: {
    checkOk: (matched: number, checked: number) => string;
    checkWarn: (count: number) => string;
    checkPhysical: string;
    checkSources: (analysis: number, question: number, knowledge: number) => string;
    checkDetail: string;
  };
}) {
  const result: NumberCheckResult = useMemo(() => checkAnswerNumbers(text, known), [text, known]);
  if (result.status === "empty") return null;
  if (result.status === "ok") {
    return (
      <span className={styles.checkOk} title={labels.checkSources(result.matchedBy.analysis, result.matchedBy.question, result.matchedBy.knowledge)}>
        <CircleCheck size={14} aria-hidden="true" />{labels.checkOk(result.matched, result.checked)}
      </span>
    );
  }
  return (
    <details className={styles.checkWarn}>
      <summary>
        <TriangleAlert size={14} aria-hidden="true" />
        {[result.unmatched.length ? labels.checkWarn(result.unmatched.length) : null, result.physicalSpeeds.length ? labels.checkPhysical : null]
          .filter(Boolean).join(" · ")}
      </summary>
      <p>{labels.checkDetail}</p>
      <ul>
        {result.physicalSpeeds.map((item, index) => <li key={`p-${index}`}><strong>{item.text}</strong> · {labels.checkPhysical}</li>)}
        {result.unmatched.map((item, index) => <li key={`u-${index}`}><strong>{item.text}</strong> · {item.context}</li>)}
      </ul>
      <small>{labels.checkSources(result.matchedBy.analysis, result.matchedBy.question, result.matchedBy.knowledge)}</small>
    </details>
  );
}
