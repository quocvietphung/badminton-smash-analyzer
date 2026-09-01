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
import { useAnalysisSnapshot } from "@/lib/analysis-session-store";
import type { CoachPromptRequest, StudioLanguage } from "@/lib/studio-types";
import styles from "./analysis-chatbot.module.css";

const CHAT_COPY = {
  vi: {
    sources: { none: "Chưa có phiên", demo: "Dữ liệu demo", live: "Phiên camera", history: "Phiên đã lưu" },
    suggestions: ["Tóm tắt set kỹ thuật này", "Pha nào của tôi cần cải thiện nhất?", "Tạo bài tập 20 phút từ báo cáo này"],
    footworkSuggestions: ["Tóm tắt set bộ pháp này", "Pha bộ pháp nào cần sửa trước?", "Tạo bài shadow footwork 20 phút"],
    grounded: "RAG có nguồn",
    events: "lần lặp",
    evidence: "Điểm chuyển động TB",
    court: "Bài tập",
    calibrated: "Đã chọn",
    notCalibrated: "Tự nhận",
    welcomeWithData: (count: number) => `Mình đã nhận **${count} lần lặp Motion Capture** của set đang hiển thị. Mình sẽ đối chiếu số liệu với kho kiến thức có nguồn trước khi góp ý.`,
    welcomeEmpty: "Bạn có thể hỏi kiến thức kỹ thuật ngay bây giờ. Để nhận góp ý cá nhân hóa, hãy mở một phiên camera hoặc xem demo.",
    readSession: "Đọc phiên hiện tại",
    readSessionDetail: "6 pha, góc khớp và nhịp vung",
    readFootworkDetail: "4 pha, nhịp chân và tiếp đất",
    verifiedRag: "RAG có kiểm chứng",
    verifiedRagDetail: "Chỉ lấy đoạn liên quan",
    references: "Kho tham chiếu",
    thinking: "Đang đọc dữ liệu phiên…",
    error: "Không thể kết nối Azure AI. Vui lòng thử lại.",
    placeholderWithData: "Hỏi về phiên phân tích này…",
    placeholderEmpty: "Hỏi Coach về kỹ thuật cầu lông…",
    privacy: "Có nguồn · không gửi video",
    disclaimer: "AI có thể sai. Motion Capture không nhìn thấy mặt vợt hoặc quả cầu và không thay thế huấn luyện viên.",
    copy: "Sao chép",
    clear: "Xóa cuộc trò chuyện",
    open: "Mở SmashLab Coach",
    close: "Đóng chatbot",
  },
  en: {
    sources: { none: "No session", demo: "Demo data", live: "Camera session", history: "Saved session" },
    suggestions: ["Summarize this technique set", "Which motion phase needs the most work?", "Create a 20-minute practice plan"],
    footworkSuggestions: ["Summarize this footwork set", "Which footwork phase needs work?", "Create a 20-minute shadow drill"],
    grounded: "Grounded RAG",
    events: "repetitions",
    evidence: "Average motion score",
    court: "Drill",
    calibrated: "Selected",
    notCalibrated: "Auto",
    welcomeWithData: (count: number) => `I received **${count} Motion Capture repetitions** from the current set. I will ground recommendations in the cited knowledge base.`,
    welcomeEmpty: "Ask a technique question now, or open a camera session to receive personalized feedback.",
    readSession: "Current session context",
    readSessionDetail: "Six phases, joint angles and rhythm",
    readFootworkDetail: "Four phases, foot rhythm and landing",
    verifiedRag: "Grounded retrieval",
    verifiedRagDetail: "Only relevant references",
    references: "Reference shelf",
    thinking: "Reading session data…",
    error: "Azure AI is unavailable. Please try again.",
    placeholderWithData: "Ask about this session…",
    placeholderEmpty: "Ask Coach about badminton technique…",
    privacy: "Cited · no video uploaded",
    disclaimer: "AI can be wrong. Motion Capture cannot see the racket face or shuttle and does not replace a coach.",
    copy: "Copy",
    clear: "Clear conversation",
    open: "Open SmashLab Coach",
    close: "Close chatbot",
  },
  de: {
    sources: { none: "Keine Einheit", demo: "Beispieldaten", live: "Live-Aufnahme", history: "Gespeicherte Einheit" },
    suggestions: ["Fasse dieses Techniktraining zusammen", "Welche Bewegungsphase braucht am meisten Arbeit?", "Erstelle einen 20-Minuten-Trainingsplan"],
    footworkSuggestions: ["Fasse diese Beinarbeitseinheit zusammen", "Welche Beinarbeitsphase sollte ich zuerst verbessern?", "Erstelle ein 20-minütiges Schattenlauftraining"],
    grounded: "Quellenbasiertes RAG",
    events: "Wiederholungen",
    evidence: "Durchschnittlicher Bewegungsscore",
    court: "Übung",
    calibrated: "Ausgewählt",
    notCalibrated: "Automatisch",
    welcomeWithData: (count: number) => `Ich habe **${count} Motion-Capture-Wiederholungen** aus der aktuellen Einheit erhalten. Empfehlungen werden mit der belegten Wissensbasis abgeglichen.`,
    welcomeEmpty: "Stelle jetzt eine Technikfrage oder starte eine Live-Aufnahme für persönliches Feedback.",
    readSession: "Analysiert diese Einheit",
    readSessionDetail: "Sechs Phasen, Gelenkwinkel und Rhythmus",
    readFootworkDetail: "Vier Phasen, Fußrhythmus und Landung",
    verifiedRag: "Quellenbasierte Recherche",
    verifiedRagDetail: "Nur relevante Quellen",
    references: "Quellen",
    thinking: "Einheitsdaten werden analysiert…",
    error: "Azure AI ist nicht verfügbar. Bitte versuche es erneut.",
    placeholderWithData: "Frage zu dieser Einheit…",
    placeholderEmpty: "Frage den Coach zur Badminton-Technik…",
    privacy: "Mit Quellen · kein Video-Upload",
    disclaimer: "KI kann Fehler machen. Motion Capture erkennt weder Schlägerfläche noch Federball und ersetzt keinen Trainer.",
    copy: "Kopieren",
    clear: "Unterhaltung löschen",
    open: "SmashLab Coach öffnen",
    close: "Chatbot schließen",
  },
} as const;

const KNOWLEDGE_SOURCES = [
  { label: "BWF Coach Education", href: "https://bwf.worldacademysport.com/?academy=9" },
  { label: "BST Stroke Recognition", href: "https://arxiv.org/abs/2502.21085" },
  { label: "MediaPipe Pose", href: "https://ai.google.dev/edge/mediapipe/solutions/vision/pose_landmarker" },
];

function textFromPart(part: { type: string; text?: string }) {
  return part.type === "text" ? part.text ?? "" : "";
}

type AnalysisChatbotProps = {
  variant?: "floating" | "workspace";
  language: StudioLanguage;
  promptRequest?: CoachPromptRequest | null;
  onOpenWorkspace?: () => void;
};

export default function AnalysisChatbot({
  variant = "floating",
  language,
  promptRequest,
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

  const hasAnalysis = analysis.movements.length > 0;
  const isGenerating = status === "submitted" || status === "streaming";
  const averageEvidence = hasAnalysis
    ? Math.round(analysis.movements.reduce((sum, movement) => sum + movement.overallScore, 0) / analysis.movements.length)
    : 0;

  useEffect(() => {
    if (!visible || variant === "workspace") return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [variant, visible]);

  useEffect(() => {
    if (!promptRequest) return;
    const timer = window.setTimeout(() => setInput(promptRequest.text), 0);
    return () => window.clearTimeout(timer);
  }, [promptRequest]);

  function submitMessage(text: string) {
    const normalized = text.trim();
    if (!normalized || isGenerating) return;
    void sendMessage(
      { text: normalized },
      { body: { analysis, language } },
    );
    setInput("");
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
          <small>Azure GPT‑4.1 mini</small>
        </span>
        {hasAnalysis ? <span className={styles.eventCount}>{analysis.movements.length}</span> : null}
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
              <span><i /> Azure GPT‑4.1 mini · {copy.grounded}</span>
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
            <strong>{analysis.movements.length} {copy.events}</strong>
          </div>
          <div>
            <span>{copy.evidence}</span>
            <strong>{averageEvidence}/100</strong>
          </div>
          <div>
            <span>{copy.court}</span>
            <strong>{analysis.drillMode === "open" || analysis.drillMode === "footwork_auto" ? copy.notCalibrated : copy.calibrated}</strong>
          </div>
        </div>

        <Conversation className={styles.conversation}>
          <ConversationContent className={styles.conversationContent}>
            {!messages.length ? (
              <Message from="assistant" className={styles.message}>
                <MessageContent className={styles.assistantContent}>
                  <div className={styles.welcomeIcon}><BotMessageSquare /></div>
                  <MessageResponse>
                    {hasAnalysis ? copy.welcomeWithData(analysis.movements.length) : copy.welcomeEmpty}
                  </MessageResponse>
                  <div className={styles.capabilityGrid}>
                    <div>
                      <ScanSearch />
                      <span><strong>{copy.readSession}</strong>{analysis.trainingModule === "footwork" ? copy.readFootworkDetail : copy.readSessionDetail}</span>
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
            {error ? <p className={styles.error}>{copy.error}</p> : null}
          </ConversationContent>
          <ConversationScrollButton className={styles.scrollButton} />
        </Conversation>

        <div className={styles.composerArea}>
          <div className={styles.suggestions} aria-label={language === "vi" ? "Câu hỏi gợi ý" : language === "de" ? "Vorgeschlagene Fragen" : "Suggested questions"}>
            {(analysis.trainingModule === "footwork" ? copy.footworkSuggestions : copy.suggestions).map((suggestion) => (
              <button
                type="button"
                key={suggestion}
                disabled={isGenerating}
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
