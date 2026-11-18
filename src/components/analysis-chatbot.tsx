"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import {
  BookOpenCheck,
  BotMessageSquare,
  Copy,
  DatabaseZap,
  MessageCircleMore,
  RotateCcw,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageAction,
  MessageActions,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { publishAnalysisSnapshot, useAnalysisSnapshot } from "@/lib/analysis-session-store";
import { apiUrl, LOCAL_AI_PROXY_BASE, readStoredJobId } from "@/lib/local-ai/client";
import { buildVideoAnalysisSnapshot, type VideoAnalysisResults } from "@/lib/video-analysis";
import type { MatchDocument } from "@/lib/match/types";
import type { StudioLanguage } from "@/lib/studio-types";
import styles from "./analysis-chatbot.module.css";

// The parts of a job record the Coach needs to label a stored analysis.
type StoredJob = {
  status: string;
  created_at: number;
  source: { kind: string; name: string };
};

const CHAT_COPY = {
  vi: {
    sources: { none: "Chưa chọn video", "video-analysis": "Phân tích video" },
    suggestions: ["Tóm tắt phân tích video này", "Quỹ đạo người nào di chuyển nhiều nhất?", "Phân tích này không đo được những gì?"],
    grounded: "RAG có nguồn",
    detections: "khung phát hiện cầu",
    tracks: "quỹ đạo người",
    court: "Sân",
    calibrated: "Đã hiệu chỉnh",
    notCalibrated: "Chưa hiệu chỉnh",
    welcomeWithData: (name: string, tracks: number, detections: number) => `Mình đã nhận phân tích của **${name}**: ${tracks} quỹ đạo người và ${detections} khung phát hiện cầu. Loại cú đánh chỉ đến từ mô hình đã huấn luyện đã chạy trên phân tích này, và chưa kiểm chứng. Tốc độ và ứng viên lần chạm không nằm trong dữ liệu này.`,
    welcomeEmpty: "Bạn có thể hỏi kiến thức kỹ thuật ngay bây giờ. Để nhận nhận định về một video, hãy tải lên và phân tích video ở mục Phân tích video.",
    readAnalysis: "Dữ liệu phân tích hiện tại",
    readAnalysisDetail: "Phát hiện cầu, quỹ đạo người, hiệu chỉnh sân, di chuyển P1/P2 và timeline cú đánh (JSON)",
    verifiedRag: "RAG có kiểm chứng",
    verifiedRagDetail: "Chỉ lấy đoạn liên quan",
    references: "Kho tham chiếu",
    thinking: "Đang đọc dữ liệu phân tích…",
    error: "Không thể kết nối AI Coach. Vui lòng thử lại.",
    retry: "Thử lại",
    timeout: "AI Coach trả lời quá lâu và đã được dừng.",
    placeholderWithData: "Hỏi về phân tích video này…",
    placeholderEmpty: "Hỏi Coach về kỹ thuật cầu lông…",
    privacy: "Có nguồn · video ở trên máy này",
    disclaimer: "AI có thể sai. Phân tích chỉ phát hiện cầu và người trong tọa độ ảnh. Lần chạm, loại cú đánh và tốc độ trong Phân tích trận đấu là ứng viên chưa kiểm chứng, không phải phép đo.",
    copy: "Sao chép",
    clear: "Xóa cuộc trò chuyện",
    open: "Mở SmashLab Coach",
    close: "Đóng chatbot",
  },
  en: {
    sources: { none: "No video selected", "video-analysis": "Video analysis" },
    suggestions: ["Summarize this video analysis", "Which player track moves the most?", "What can this analysis not measure?"],
    grounded: "Grounded RAG",
    detections: "shuttle detection frames",
    tracks: "player tracks",
    court: "Court",
    calibrated: "Calibrated",
    notCalibrated: "Not calibrated",
    welcomeWithData: (name: string, tracks: number, detections: number) => `I received the analysis of **${name}**: ${tracks} player tracks and ${detections} shuttle detection frames. Shot types come only from the trajectory estimate of this analysis (trajectory-rules/v1), and they are unvalidated. Speeds and contact candidates are not part of this coaching data.`,
    welcomeEmpty: "Ask a technique question now. For feedback on a video, upload and analyse it in Video analysis first.",
    readAnalysis: "Current analysis data",
    readAnalysisDetail: "Shuttle detections, player tracks, court calibration, P1/P2 movement and shot timeline (JSON)",
    verifiedRag: "Grounded retrieval",
    verifiedRagDetail: "Only relevant references",
    references: "Reference shelf",
    thinking: "Reading analysis data…",
    error: "The AI Coach is unavailable. Please try again.",
    retry: "Try again",
    timeout: "The AI Coach took too long and was stopped.",
    placeholderWithData: "Ask about this video analysis…",
    placeholderEmpty: "Ask Coach about badminton technique…",
    privacy: "Cited · video stays on this machine",
    disclaimer: "AI can be wrong. The analysis detects the shuttle and people in image coordinates. Contact, shot-type and speed values in Match intelligence are unvalidated candidates, not measurements.",
    copy: "Copy",
    clear: "Clear conversation",
    open: "Open SmashLab Coach",
    close: "Close chatbot",
  },
  de: {
    sources: { none: "Kein Video gewählt", "video-analysis": "Videoanalyse" },
    suggestions: ["Fasse diese Videoanalyse zusammen", "Welcher Spieler-Track bewegt sich am meisten?", "Was kann diese Analyse nicht messen?"],
    grounded: "Quellenbasiertes RAG",
    detections: "Federball-Erkennungsbilder",
    tracks: "Spieler-Tracks",
    court: "Feld",
    calibrated: "Kalibriert",
    notCalibrated: "Nicht kalibriert",
    welcomeWithData: (name: string, tracks: number, detections: number) => `Ich habe die Analyse von **${name}** erhalten: ${tracks} Spieler-Tracks und ${detections} Federball-Erkennungsbilder. Schlagarten stammen nur von einem vortrainierten Modell, das auf dieser Analyse gelaufen ist, und sind nicht validiert. Geschwindigkeit und Kontaktkandidaten gehören nicht zu diesen Coaching-Daten.`,
    welcomeEmpty: "Stelle jetzt eine Technikfrage. Für Feedback zu einem Video lade es zuerst unter Videoanalyse hoch und analysiere es.",
    readAnalysis: "Aktuelle Analysedaten",
    readAnalysisDetail: "Federball-Erkennungen, Spieler-Tracks, Feldkalibrierung, Bewegung von P1/P2 und Schlagzeitleiste (JSON)",
    verifiedRag: "Quellenbasierte Recherche",
    verifiedRagDetail: "Nur relevante Quellen",
    references: "Quellen",
    thinking: "Analysedaten werden gelesen…",
    error: "Der AI Coach ist nicht verfügbar. Bitte versuche es erneut.",
    retry: "Erneut versuchen",
    timeout: "Der AI Coach hat zu lange gebraucht und wurde gestoppt.",
    placeholderWithData: "Frage zu dieser Videoanalyse…",
    placeholderEmpty: "Frage den Coach zur Badminton-Technik…",
    privacy: "Mit Quellen · Video bleibt auf diesem Rechner",
    disclaimer: "KI kann Fehler machen. Die Analyse erkennt Federball und Personen nur in Bildkoordinaten. Kontakte, Schlagarten und Geschwindigkeiten in der Spielanalyse sind nicht validierte Kandidaten, keine Messungen.",
    copy: "Kopieren",
    clear: "Unterhaltung löschen",
    open: "SmashLab Coach öffnen",
    close: "Chatbot schließen",
  },
} as const;

const KNOWLEDGE_SOURCES = [
  { label: "BWF Coach Education", href: "https://bwf.worldacademysport.com/?academy=9" },
  { label: "MediaPipe Pose", href: "https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker" },
];

function textFromPart(part: { type: string; text?: string }) {
  return part.type === "text" ? part.text ?? "" : "";
}

/** A local answer takes minutes on a CPU; this only stops a request that never starts streaming. */
const COACH_TIMEOUT_MS = 240_000;

type AnalysisChatbotProps = {
  variant?: "floating" | "workspace";
  language: StudioLanguage;
  onOpenWorkspace?: () => void;
};

export default function AnalysisChatbot({
  variant = "floating",
  language,
  onOpenWorkspace,
}: AnalysisChatbotProps) {
  const analysis = useAnalysisSnapshot();
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const copy = CHAT_COPY[language];
  const visible = variant === "workspace" || open;
  const transport = useMemo(
    () => new DefaultChatTransport({
      api: "/api/ai/chat",
      headers: { "X-SmashLab-Language": language },
    }),
    [language],
  );
  const {
    messages,
    sendMessage,
    status,
    stop,
    error,
    setMessages,
  } = useChat({ transport, throttle: 40 });

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
  // Only the dataset of the analysis that is open is ever sent.
  const coachDataset = loadedDataset && loadedDataset.jobId === analysisJobId ? loadedDataset.data : null;

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
  const trackCount = analysis.players.tracksConfirmed;
  const detectionCount = analysis.shuttle.framesDetected;

  useEffect(() => {
    if (!visible || variant === "workspace") return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [variant, visible]);

  function submitMessage(text: string) {
    const normalized = text.trim();
    if (!normalized || isGenerating) return;
    setTimedOut(false);
    void sendMessage(
      { text: normalized },
      { body: { analysis, language, coachDataset } },
    );
    setInput("");
  }

  function retryLast() {
    const lastUser = [...messages].reverse().find((message) => message.role === "user");
    const text = lastUser ? lastUser.parts.flatMap((part) => (part.type === "text" ? [part.text] : [])).join(" ") : "";
    if (text) submitMessage(text);
  }

  return (
    <div className={`${styles.chatbot} ${variant === "workspace" ? styles.workspace : ""} ${visible ? styles.isOpen : ""}`}>
      {variant === "floating" ? <button
        type="button"
        className={styles.launcher}
        aria-label={open ? copy.close : copy.open}
        aria-expanded={open}
        onClick={() => onOpenWorkspace ? onOpenWorkspace() : setOpen((current) => !current)}
      >
        <span className={styles.launcherIcon}><MessageCircleMore /></span>
        <span className={styles.launcherText}>
          <strong>SmashLab Coach</strong>
          <small>{providerLabel}</small>
        </span>
        {hasAnalysis ? <span className={styles.eventCount}>{trackCount}</span> : null}
      </button> : null}

      {open && variant === "floating" ? <button type="button" className={styles.backdrop} aria-label={copy.close} onClick={() => setOpen(false)} /> : null}

      <section
        className={styles.panel}
        role="dialog"
        aria-modal={variant === "floating"}
        aria-label="SmashLab Coach"
        aria-hidden={!visible}
        inert={!visible}
      >
        <header className={styles.header}>
          <div className={styles.identity}>
            <span className={styles.botMark}><Sparkles /></span>
            <div>
              <strong>SmashLab Coach</strong>
              <span><i /> {providerLabel} · {copy.grounded}</span>
            </div>
          </div>
          <div className={styles.headerActions}>
            {messages.length ? (
              <button type="button" aria-label={copy.clear} onClick={() => setMessages([])}>
                <RotateCcw />
              </button>
            ) : null}
            {variant === "floating" ? <button type="button" aria-label={copy.close} onClick={() => setOpen(false)}><X /></button> : null}
          </div>
        </header>

        <div className={styles.contextBar}>
          <div>
            <span>{copy.sources[analysis.source]}</span>
            <strong>{detectionCount} {copy.detections}</strong>
          </div>
          <div>
            <span>{copy.tracks}</span>
            <strong>{trackCount}</strong>
          </div>
          <div>
            <span>{copy.court}</span>
            <strong>{analysis.court.status === "calibrated" ? copy.calibrated : copy.notCalibrated}</strong>
          </div>
        </div>

        <Conversation className={styles.conversation}>
          <ConversationContent className={styles.conversationContent}>
            {!messages.length ? (
              <Message from="assistant" className={styles.message}>
                <MessageContent className={styles.assistantContent}>
                  <div className={styles.welcomeIcon}><BotMessageSquare /></div>
                  <MessageResponse>
                    {hasAnalysis ? copy.welcomeWithData(analysis.sourceName, trackCount, detectionCount) : copy.welcomeEmpty}
                  </MessageResponse>
                  <div className={styles.capabilityGrid}>
                    <div>
                      <ScanSearch />
                      <span><strong>{copy.readAnalysis}</strong>{copy.readAnalysisDetail}</span>
                    </div>
                    <div>
                      <DatabaseZap />
                      <span><strong>{copy.verifiedRag}</strong>{copy.verifiedRagDetail}</span>
                    </div>
                  </div>
                  <div className={styles.sourceShelf}>
                    <span><BookOpenCheck /> {copy.references}</span>
                    <div>
                      {KNOWLEDGE_SOURCES.map((source) => (
                        <a key={source.label} href={source.href} target="_blank" rel="noreferrer">{source.label}</a>
                      ))}
                    </div>
                  </div>
                </MessageContent>
              </Message>
            ) : null}

            {messages.map((message, messageIndex) => (
              <Message key={message.id} from={message.role} className={styles.message}>
                {message.parts.map((part, partIndex) => {
                  if (part.type !== "text") return null;
                  const isLatestAssistant = message.role === "assistant" && messageIndex === messages.length - 1;
                  return (
                    <div key={`${message.id}-${partIndex}`}>
                      <MessageContent className={message.role === "assistant" ? styles.assistantContent : styles.userContent}>
                        <MessageResponse isAnimating={isLatestAssistant && status === "streaming"}>
                          {part.text}
                        </MessageResponse>
                      </MessageContent>
                      {message.role === "assistant" ? (
                        <MessageActions className={styles.messageActions}>
                          <MessageAction
                            tooltip={copy.copy}
                            aria-label={copy.copy}
                            onClick={() => void navigator.clipboard.writeText(textFromPart(part))}
                          >
                            <Copy />
                          </MessageAction>
                        </MessageActions>
                      ) : null}
                    </div>
                  );
                })}
              </Message>
            ))}

            {status === "submitted" ? (
              <div className={styles.thinking}><i /><span>{copy.thinking}</span></div>
            ) : null}
            {timedOut ? <p className={styles.error}>{copy.timeout}</p> : null}
            {error || timedOut ? (
              <>
                {error ? <p className={styles.error}>{copy.error}</p> : null}
                <button type="button" className={styles.retry} onClick={retryLast}>{copy.retry}</button>
              </>
            ) : null}
          </ConversationContent>
          <ConversationScrollButton className={styles.scrollButton} />
        </Conversation>

        <div className={styles.composerArea}>
          <div className={styles.suggestions} aria-label={language === "vi" ? "Câu hỏi gợi ý" : language === "de" ? "Vorgeschlagene Fragen" : "Suggested questions"}>
            {copy.suggestions.map((suggestion) => (
              <button
                type="button"
                key={suggestion}
                disabled={isGenerating || !hasAnalysis}
                onClick={() => submitMessage(suggestion)}
              >
                {suggestion}
              </button>
            ))}
          </div>

          <PromptInput
            className={styles.prompt}
            onSubmit={({ text }) => submitMessage(text)}
          >
            <PromptInputTextarea
              value={input}
              onChange={(event) => setInput(event.currentTarget.value)}
              disabled={isGenerating}
              placeholder={hasAnalysis ? copy.placeholderWithData : copy.placeholderEmpty}
              aria-label={language === "vi" ? "Câu hỏi cho SmashLab Coach" : language === "de" ? "Frage an SmashLab Coach" : "Question for SmashLab Coach"}
              className={styles.promptTextarea}
            />
            <PromptInputFooter className={styles.promptFooter}>
              <PromptInputTools>
                <span className={styles.privacyNote}><ShieldCheck /> {copy.privacy}</span>
              </PromptInputTools>
              <PromptInputSubmit
                status={status}
                onStop={() => void stop()}
                disabled={!isGenerating && !input.trim()}
                className={styles.submitButton}
              />
            </PromptInputFooter>
          </PromptInput>
          <p className={styles.disclaimer}>{copy.disclaimer}</p>
        </div>
      </section>
    </div>
  );
}
