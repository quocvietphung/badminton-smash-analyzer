"use client";

import {
  Film,
  History,
  Languages,
  MessageCircleMore,
  Moon,
  Settings2,
  ShieldCheck,
  Sun,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import AnalysisChatbot from "@/components/analysis-chatbot";
import LocalAiLab from "@/components/local-ai-lab";
import { SiteGate } from "@/components/site-gate";
import SessionLibrary from "@/components/session-library";
import { writeStoredJobId } from "@/lib/local-ai/client";
import type {
  StudioLanguage,
  StudioTheme,
  StudioView,
} from "@/lib/studio-types";
import styles from "./studio-shell.module.css";

const VIEW_VALUES = new Set<StudioView>(["analysis", "sessions", "coach", "settings"]);
const PREFERENCE_KEY = "smashlab-studio-preferences-v2";

const COPY = {
  vi: {
    nav: { analysis: "Phân tích video", sessions: "Phiên đã lưu", coach: "AI Coach", settings: "Cài đặt" },
    privacy: "Video chỉ ở trên máy này",
    sessionsEyebrow: "Phiên phân tích",
    sessionsTitle: "Phiên đã lưu",
    sessionsCopy: "Các video đã phân tích xong trên backend Docker của bạn. Mở lại kết quả hoặc hỏi Coach về từng phiên.",
    coachEyebrow: "SmashLab intelligence",
    coachTitle: "Coach hiểu đúng phân tích của bạn",
    coachCopy: "Đặt câu hỏi dựa trên kết quả phân tích video đang chọn và kho kiến thức huấn luyện có nguồn.",
    settingsEyebrow: "Thiết bị & trải nghiệm",
    settingsTitle: "Cài đặt Studio",
    settingsCopy: "Tùy chỉnh giao diện và ngôn ngữ.",
    appearance: "Giao diện",
    appearanceCopy: "Chọn chế độ phù hợp với phòng tập sáng hoặc tối.",
    dark: "Tối Studio",
    light: "Sáng phòng tập",
    language: "Ngôn ngữ",
    languageCopy: "Thay đổi ngôn ngữ điều khiển mà không ảnh hưởng dữ liệu phân tích.",
    footer: "Phân tích chạy trên backend Docker của máy này · AI Coach chỉ nhận số liệu đã rút gọn, không bao giờ nhận video",
  },
  en: {
    nav: { analysis: "Video analysis", sessions: "Saved sessions", coach: "AI Coach", settings: "Settings" },
    privacy: "Video stays on this machine",
    sessionsEyebrow: "Analysis sessions",
    sessionsTitle: "Saved sessions",
    sessionsCopy: "Videos that finished analysis on your local Docker backend. Reopen a result or ask the Coach about any session.",
    coachEyebrow: "SmashLab intelligence",
    coachTitle: "A Coach grounded in your analysis",
    coachCopy: "Ask questions about the selected video analysis and a cited coaching knowledge base.",
    settingsEyebrow: "Device & experience",
    settingsTitle: "Studio settings",
    settingsCopy: "Tune the interface and language.",
    appearance: "Appearance",
    appearanceCopy: "Choose a mode for bright or dark training rooms.",
    dark: "Studio dark",
    light: "Training light",
    language: "Language",
    languageCopy: "Change interface language without altering analysis data.",
    footer: "Analysis runs on the local Docker backend · the AI Coach receives reduced metrics only, never video",
  },
  de: {
    nav: { analysis: "Videoanalyse", sessions: "Gespeicherte Sitzungen", coach: "AI Coach", settings: "Einstellungen" },
    privacy: "Video bleibt auf diesem Rechner",
    sessionsEyebrow: "Analysesitzungen",
    sessionsTitle: "Gespeicherte Sitzungen",
    sessionsCopy: "Videos, deren Analyse auf deinem lokalen Docker-Backend abgeschlossen ist. Öffne ein Ergebnis erneut oder frage den Coach zu jeder Sitzung.",
    coachEyebrow: "SmashLab Intelligence",
    coachTitle: "Ein Coach, der deine Analyse versteht",
    coachCopy: "Stelle Fragen zur gewählten Videoanalyse und nutze eine belegte Wissensbasis für das Training.",
    settingsEyebrow: "Gerät & Erlebnis",
    settingsTitle: "Studio-Einstellungen",
    settingsCopy: "Passe die Oberfläche und die Sprache an.",
    appearance: "Darstellung",
    appearanceCopy: "Wähle den passenden Modus für helle oder dunkle Trainingsräume.",
    dark: "Studio dunkel",
    light: "Training hell",
    language: "Sprache",
    languageCopy: "Ändere die Sprache der Oberfläche, ohne Analysedaten zu verändern.",
    footer: "Die Analyse läuft auf dem lokalen Docker-Backend · der KI-Coach erhält nur reduzierte Kennzahlen, nie Video",
  },
} as const;

const NAV_ITEMS: Array<{ view: StudioView; icon: typeof Film }> = [
  { view: "analysis", icon: Film },
  { view: "sessions", icon: History },
  { view: "coach", icon: MessageCircleMore },
  { view: "settings", icon: Settings2 },
];

export default function StudioShell() {
  const [view, setView] = useState<StudioView>("analysis");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [theme, setTheme] = useState<StudioTheme>("dark");
  const [language, setLanguage] = useState<StudioLanguage>("en");
  const [preferencesReady, setPreferencesReady] = useState(false);
  const copy = COPY[language];

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const params = new URLSearchParams(window.location.search);
      const requestedView = params.get("view") as StudioView | null;
      if (requestedView && VIEW_VALUES.has(requestedView)) setView(requestedView);

      try {
        const stored = JSON.parse(window.localStorage.getItem(PREFERENCE_KEY) ?? "{}") as {
          theme?: StudioTheme;
          language?: StudioLanguage;
        };
        if (stored.theme === "dark" || stored.theme === "light") setTheme(stored.theme);
        if (stored.language === "vi" || stored.language === "en" || stored.language === "de") setLanguage(stored.language);
      } catch {
        // Preferences are optional; the studio works with the defaults.
      }
      setPreferencesReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!preferencesReady) return;
    document.documentElement.classList.toggle("dark", theme === "dark");
    document.documentElement.dataset.theme = theme;
    document.documentElement.lang = language;
    window.localStorage.setItem(PREFERENCE_KEY, JSON.stringify({ theme, language }));
  }, [language, preferencesReady, theme]);

  const navigate = useCallback((nextView: StudioView) => {
    setView(nextView);
    const nextUrl = nextView === "analysis" ? window.location.pathname : `${window.location.pathname}?view=${nextView}`;
    window.history.pushState({ view: nextView }, "", nextUrl);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      const requestedView = new URLSearchParams(window.location.search).get("view") as StudioView | null;
      setView(requestedView && VIEW_VALUES.has(requestedView) ? requestedView : "analysis");
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const openJob = useCallback((jobId: string) => {
    writeStoredJobId(typeof window !== "undefined" ? window.localStorage : null, jobId);
    setSelectedJobId(jobId);
    navigate("analysis");
  }, [navigate]);

  const openCoach = useCallback(() => navigate("coach"), [navigate]);
  const openSessions = useCallback(() => navigate("sessions"), [navigate]);

  return (
    <SiteGate language={language}>
      <div className={styles.page}>
        <header className={styles.header}>
          <button type="button" className={styles.brand} onClick={() => navigate("analysis")} aria-label="SmashLab">
            <span className={styles.brandMark} aria-hidden="true">S</span>
            <span className={styles.brandText}><strong>SmashLab</strong><span>MOTION SCIENCE STUDIO</span></span>
          </button>

          <nav className={styles.desktopNav} aria-label={language === "vi" ? "Điều hướng chính" : language === "de" ? "Hauptnavigation" : "Main navigation"}>
            {NAV_ITEMS.map(({ view: itemView, icon: Icon }) => (
              <button
                type="button"
                key={itemView}
                className={view === itemView ? styles.activeNav : ""}
                aria-current={view === itemView ? "page" : undefined}
                onClick={() => navigate(itemView)}
              >
                <Icon />
                <span>{copy.nav[itemView]}</span>
              </button>
            ))}
          </nav>

          <div className={styles.headerActions}>
            <span className={styles.privacy}><ShieldCheck />{copy.privacy}</span>
            <button
              type="button"
              className={styles.iconButton}
              onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}
              aria-label={theme === "dark" ? copy.light : copy.dark}
            >
              {theme === "dark" ? <Sun /> : <Moon />}
            </button>
          </div>
        </header>

        <main className={styles.main}>
          {view === "analysis" ? null : (
            <section className={styles.viewHeader}>
              <p>{view === "sessions" ? copy.sessionsEyebrow : view === "coach" ? copy.coachEyebrow : copy.settingsEyebrow}</p>
              <h1>{view === "sessions" ? copy.sessionsTitle : view === "coach" ? copy.coachTitle : copy.settingsTitle}</h1>
              <span>{view === "sessions" ? copy.sessionsCopy : view === "coach" ? copy.coachCopy : copy.settingsCopy}</span>
            </section>
          )}

          {view === "settings" ? (
            <section className={styles.preferenceGrid} aria-label={copy.settingsTitle}>
              <article className={styles.preferenceCard}>
                <span className={styles.preferenceIcon}>{theme === "dark" ? <Moon /> : <Sun />}</span>
                <div><strong>{copy.appearance}</strong><p>{copy.appearanceCopy}</p></div>
                <div className={styles.segmented}>
                  <button type="button" className={theme === "dark" ? styles.segmentActive : ""} onClick={() => setTheme("dark")}><Moon />{copy.dark}</button>
                  <button type="button" className={theme === "light" ? styles.segmentActive : ""} onClick={() => setTheme("light")}><Sun />{copy.light}</button>
                </div>
              </article>
              <article className={styles.preferenceCard}>
                <span className={styles.preferenceIcon}><Languages /></span>
                <div><strong>{copy.language}</strong><p>{copy.languageCopy}</p></div>
                <div className={styles.segmented}>
                  <button type="button" className={language === "en" ? styles.segmentActive : ""} onClick={() => setLanguage("en")}>EN</button>
                  <button type="button" className={language === "de" ? styles.segmentActive : ""} onClick={() => setLanguage("de")}>DE</button>
                  <button type="button" className={language === "vi" ? styles.segmentActive : ""} onClick={() => setLanguage("vi")}>VI</button>
                </div>
              </article>
            </section>
          ) : null}

          {view === "analysis" ? (
            <LocalAiLab
              key={selectedJobId ?? "new"}
              language={language}
              initialJobId={selectedJobId}
              onOpenCoach={openCoach}
              onOpenSessions={openSessions}
            />
          ) : null}

          {view === "sessions" ? (
            <SessionLibrary language={language} onOpenJob={openJob} onOpenCoach={openCoach} />
          ) : null}

          {/* On the analysis page the floating Coach stays away: the results header has "Ask the coach", and the card would cover the trajectory and the shot list. */}
          {view === "analysis" ? null : (
            <div className={view === "coach" ? styles.coachWorkspace : styles.floatingCoach}>
              <AnalysisChatbot
                variant={view === "coach" ? "workspace" : "floating"}
                language={language}
                onOpenWorkspace={() => navigate("coach")}
              />
            </div>
          )}

          <footer className={styles.footer}><ShieldCheck /><span>{copy.footer}</span></footer>
        </main>

        <nav className={styles.mobileNav} aria-label={language === "vi" ? "Điều hướng ứng dụng" : language === "de" ? "App-Navigation" : "App navigation"}>
          {NAV_ITEMS.map(({ view: itemView, icon: Icon }) => (
            <button
              type="button"
              key={itemView}
              className={view === itemView ? styles.activeMobileNav : ""}
              aria-current={view === itemView ? "page" : undefined}
              onClick={() => navigate(itemView)}
            >
              <Icon /><span>{copy.nav[itemView]}</span>
            </button>
          ))}
        </nav>
      </div>
    </SiteGate>
  );
}
