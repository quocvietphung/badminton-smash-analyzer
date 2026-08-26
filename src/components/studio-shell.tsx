"use client";

import {
  Activity,
  Camera,
  ChevronRight,
  History,
  Languages,
  MessageCircleMore,
  Moon,
  Play,
  ScanLine,
  Settings2,
  ShieldCheck,
  Sparkles,
  Sun,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import AnalysisChatbot from "@/components/analysis-chatbot";
import RallyAnalyzer from "@/components/rally-analyzer";
import type {
  CoachPromptRequest,
  StudioLanguage,
  StudioTheme,
  StudioView,
} from "@/lib/studio-types";
import styles from "./studio-shell.module.css";

const VIEW_VALUES = new Set<StudioView>(["live", "sessions", "coach", "settings"]);
const PREFERENCE_KEY = "smashlab-studio-preferences-v1";
const ONBOARDING_KEY = "smashlab-onboarding-v2";

const COPY = {
  vi: {
    nav: { live: "Live", sessions: "Phiên tập", coach: "AI Coach", settings: "Cài đặt" },
    privacy: "Video luôn ở trên thiết bị",
    eyebrow: "Huấn luyện cầu lông bằng AI trên thiết bị",
    title: "Nhìn rõ chuyển động.",
    titleAccent: "Tập luyện có mục tiêu.",
    intro: "Mở camera, căn sân và nhận phản hồi Pose Lite theo thời gian thực. Không tải khung hình lên máy chủ.",
    heroPrimary: "Bắt đầu phiên Live",
    heroSecondary: "Xem dữ liệu mẫu",
    sessionsEyebrow: "Performance studio",
    sessionsTitle: "Báo cáo phiên tập",
    sessionsCopy: "Xem lại từng động tác, xu hướng di chuyển và tiếp tục trao đổi với Coach.",
    coachEyebrow: "SmashLab intelligence",
    coachTitle: "Coach hiểu đúng phiên của bạn",
    coachCopy: "Đặt câu hỏi dựa trên số liệu Pose Lite đang hiển thị và kho kiến thức có nguồn.",
    settingsEyebrow: "Thiết bị & trải nghiệm",
    settingsTitle: "Cài đặt Studio",
    settingsCopy: "Tùy chỉnh giao diện và kiểm tra khả năng xử lý trực tiếp trên thiết bị.",
    appearance: "Giao diện",
    appearanceCopy: "Chọn chế độ phù hợp với phòng tập hoặc sân ngoài trời.",
    dark: "Tối Studio",
    light: "Sáng ngoài sân",
    language: "Ngôn ngữ",
    languageCopy: "Thay đổi ngôn ngữ điều khiển mà không ảnh hưởng dữ liệu phiên.",
    onboarding: "Hướng dẫn nhanh",
    onboardingCopy: "Xem lại ba bước để đặt điện thoại và bắt đầu phân tích.",
    replay: "Mở hướng dẫn",
    footer: "Pose Lite chạy trên thiết bị · Azure AI chỉ nhận dữ liệu đã rút gọn",
    steps: [
      { kicker: "01 · Đặt máy", title: "Nhìn trọn sân và hai vận động viên", body: "Đặt điện thoại cố định, quay ngang nếu có thể và tránh phản sáng từ màn hình hoặc đèn sân." },
      { kicker: "02 · Căn sân", title: "Tự tìm vạch, sau đó kiểm tra bốn góc", body: "SmashLab đề xuất khung sân. Bạn vẫn có thể giữ và kéo từng điểm để đặt đúng giao điểm vạch." },
      { kicker: "03 · Bắt đầu", title: "Giữ người chơi trong khung hình", body: "Kết thúc phiên để xem báo cáo, mở từng sự kiện và hỏi Coach bằng đúng dữ liệu vừa ghi." },
    ],
    skip: "Bỏ qua",
    back: "Quay lại",
    next: "Tiếp tục",
    start: "Vào Studio",
  },
  en: {
    nav: { live: "Live", sessions: "Sessions", coach: "AI Coach", settings: "Settings" },
    privacy: "Video stays on your device",
    eyebrow: "On-device AI badminton coaching",
    title: "See every movement.",
    titleAccent: "Train with purpose.",
    intro: "Open the camera, calibrate the court and receive real-time Pose Lite feedback. Frames never leave your device.",
    heroPrimary: "Start live session",
    heroSecondary: "View sample data",
    sessionsEyebrow: "Performance studio",
    sessionsTitle: "Session reports",
    sessionsCopy: "Review each movement, court coverage and continue the conversation with Coach.",
    coachEyebrow: "SmashLab intelligence",
    coachTitle: "A Coach grounded in your session",
    coachCopy: "Ask questions using the current Pose Lite data and a cited badminton knowledge base.",
    settingsEyebrow: "Device & experience",
    settingsTitle: "Studio settings",
    settingsCopy: "Tune the interface and inspect the on-device analysis capabilities.",
    appearance: "Appearance",
    appearanceCopy: "Choose a mode for indoor training or bright outdoor courts.",
    dark: "Studio dark",
    light: "Court light",
    language: "Language",
    languageCopy: "Change interface language without altering session data.",
    onboarding: "Quick guide",
    onboardingCopy: "Replay the three-step setup and analysis guide.",
    replay: "Open guide",
    footer: "Pose Lite runs on device · Azure AI receives reduced analysis data only",
    steps: [
      { kicker: "01 · Position", title: "Frame the full court and both players", body: "Keep the phone stable, use landscape when possible and avoid glare from screens or court lights." },
      { kicker: "02 · Calibrate", title: "Detect the court, then verify four corners", body: "SmashLab proposes a court frame. Hold and drag any point to align it with the real line intersection." },
      { kicker: "03 · Analyze", title: "Keep both players inside the frame", body: "Finish the session to review events and ask Coach using the data you just captured." },
    ],
    skip: "Skip",
    back: "Back",
    next: "Continue",
    start: "Enter Studio",
  },
} as const;

const NAV_ITEMS: Array<{ view: StudioView; icon: typeof Activity }> = [
  { view: "live", icon: Activity },
  { view: "sessions", icon: History },
  { view: "coach", icon: MessageCircleMore },
  { view: "settings", icon: Settings2 },
];

export default function StudioShell() {
  const [view, setView] = useState<StudioView>("live");
  const [theme, setTheme] = useState<StudioTheme>("dark");
  const [language, setLanguage] = useState<StudioLanguage>("vi");
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState(0);
  const [coachPrompt, setCoachPrompt] = useState<CoachPromptRequest | null>(null);
  const onboardingRef = useRef<HTMLElement>(null);
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
        if (stored.language === "vi" || stored.language === "en") setLanguage(stored.language);
        if (!window.localStorage.getItem(ONBOARDING_KEY)) setOnboardingOpen(true);
      } catch {
        setOnboardingOpen(true);
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
    const nextUrl = nextView === "live" ? window.location.pathname : `${window.location.pathname}?view=${nextView}`;
    window.history.pushState({ view: nextView }, "", nextUrl);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      const requestedView = new URLSearchParams(window.location.search).get("view") as StudioView | null;
      setView(requestedView && VIEW_VALUES.has(requestedView) ? requestedView : "live");
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const askCoach = useCallback((text: string) => {
    setCoachPrompt({ id: Date.now(), text });
    navigate("coach");
  }, [navigate]);

  const closeOnboarding = useCallback(() => {
    window.localStorage.setItem(ONBOARDING_KEY, "complete");
    setOnboardingOpen(false);
    setOnboardingStep(0);
  }, []);

  useEffect(() => {
    if (!onboardingOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => onboardingRef.current?.focus(), 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeOnboarding();
        return;
      }
      if (event.key !== "Tab" || !onboardingRef.current) return;
      const focusable = [...onboardingRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), [href], [tabindex]:not([tabindex='-1'])")];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
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
      document.body.style.overflow = previousOverflow;
      previousFocus?.focus();
    };
  }, [closeOnboarding, onboardingOpen]);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <button type="button" className={styles.brand} onClick={() => navigate("live")} aria-label="SmashLab Live">
          <span className={styles.brandMark} aria-hidden="true">S</span>
          <span className={styles.brandText}><strong>SmashLab</strong><span>COURT VISION STUDIO</span></span>
        </button>

        <nav className={styles.desktopNav} aria-label={language === "vi" ? "Điều hướng chính" : "Main navigation"}>
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
        {view === "live" ? (
          <section className={styles.hero}>
            <div>
              <p className={styles.eyebrow}><span />{copy.eyebrow}</p>
              <h1>{copy.title}<br /><em>{copy.titleAccent}</em></h1>
            </div>
            <div className={styles.heroAside}>
              <p>{copy.intro}</p>
              <div>
                <button type="button" className={styles.heroPrimary} onClick={() => document.getElementById("live-studio")?.scrollIntoView({ behavior: "smooth" })}>
                  <Play />{copy.heroPrimary}
                </button>
                <button type="button" className={styles.heroSecondary} onClick={() => window.dispatchEvent(new Event("smashlab:demo"))}>
                  <Sparkles />{copy.heroSecondary}
                </button>
              </div>
            </div>
          </section>
        ) : (
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
                <button type="button" className={language === "vi" ? styles.segmentActive : ""} onClick={() => setLanguage("vi")}>VI</button>
                <button type="button" className={language === "en" ? styles.segmentActive : ""} onClick={() => setLanguage("en")}>EN</button>
              </div>
            </article>
            <article className={styles.preferenceCard}>
              <span className={styles.preferenceIcon}><ScanLine /></span>
              <div><strong>{copy.onboarding}</strong><p>{copy.onboardingCopy}</p></div>
              <button type="button" className={styles.replayButton} onClick={() => setOnboardingOpen(true)}>{copy.replay}<ChevronRight /></button>
            </article>
          </section>
        ) : null}

        <RallyAnalyzer view={view} language={language} onNavigate={navigate} onAskCoach={askCoach} />

        <div className={view === "coach" ? styles.coachWorkspace : styles.floatingCoach}>
          <AnalysisChatbot
            variant={view === "coach" ? "workspace" : "floating"}
            language={language}
            promptRequest={coachPrompt}
            onOpenWorkspace={() => navigate("coach")}
          />
        </div>

        <footer className={styles.footer}><ShieldCheck /><span>{copy.footer}</span></footer>
      </main>

      <nav className={styles.mobileNav} aria-label={language === "vi" ? "Điều hướng ứng dụng" : "App navigation"}>
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

      {onboardingOpen ? (
        <div className={styles.onboardingBackdrop} role="presentation">
          <section ref={onboardingRef} tabIndex={-1} className={styles.onboarding} role="dialog" aria-modal="true" aria-label={copy.onboarding}>
            <button type="button" className={styles.onboardingClose} onClick={closeOnboarding} aria-label={copy.skip}><X /></button>
            <div className={styles.onboardingVisual} aria-hidden="true">
              <div className={styles.phoneFrame}><Camera /><span>{onboardingStep + 1}</span></div>
              <i /><i /><i />
            </div>
            <div className={styles.onboardingContent}>
              <span>{copy.steps[onboardingStep].kicker}</span>
              <h2>{copy.steps[onboardingStep].title}</h2>
              <p>{copy.steps[onboardingStep].body}</p>
              <div className={styles.progressDots} aria-label={`${onboardingStep + 1}/3`}>
                {copy.steps.map((step, index) => <i key={step.kicker} className={index === onboardingStep ? styles.currentDot : ""} />)}
              </div>
              <div className={styles.onboardingActions}>
                <button type="button" className={styles.textButton} onClick={onboardingStep === 0 ? closeOnboarding : () => setOnboardingStep((step) => step - 1)}>
                  {onboardingStep === 0 ? copy.skip : copy.back}
                </button>
                <button type="button" className={styles.nextButton} onClick={onboardingStep === 2 ? closeOnboarding : () => setOnboardingStep((step) => step + 1)}>
                  {onboardingStep === 2 ? copy.start : copy.next}<ChevronRight />
                </button>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
