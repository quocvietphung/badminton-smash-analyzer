"use client";

import { AlertTriangle, Film, Loader2, MessageCircleMore, RefreshCw, RotateCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { publishAnalysisSnapshot } from "@/lib/analysis-session-store";
import { apiUrl, fetchJson, LOCAL_AI_PROXY_BASE, LocalAiApiError, writeStoredJobId } from "@/lib/local-ai/client";
import type { StudioLanguage } from "@/lib/studio-types";
import { buildVideoAnalysisSnapshot, type VideoAnalysisResults } from "@/lib/video-analysis";
import { EvaluationDashboard } from "./evaluation-dashboard";
import styles from "./session-library.module.css";

type JobSummary = {
  job_id: string;
  status: "queued" | "running" | "completed" | "failed";
  stage: string | null;
  progress: number;
  created_at: number;
  finished_at: number | null;
  source: { kind: string; name: string; sample_id: string | null };
  error: { code: string | null; message: string | null } | null;
};

type SessionCounts = {
  shots: number;
  labelled_by_person: number;
  rally_candidates: number;
  rally_confirmed: number;
  transferred_annotations: number;
  unmatched_annotations: number;
} | null;

// One entry per video. The active analysis is the newest successful run; a running or failed rerun is shown beside it.
type SessionItem = {
  session_id: string;
  source: { kind: string; name: string; sample_id: string | null };
  analyses_total: number;
  failed_since_success: number;
  running: JobSummary | null;
  active: (JobSummary & { counts: SessionCounts }) | null;
};

const COPY = {
  en: {
    title: "Saved sessions",
    refresh: "Refresh",
    loading: "Loading saved sessions…",
    empty: "No analysed videos yet. Upload a clip or pick a test sample in Video analysis.",
    offline: "The local backend is not reachable. Start it with docker compose up -d --build.",
    open: "Open result",
    askCoach: "Ask the coach",
    reanalyse: "Reanalyse",
    sample: "Test sample",
    upload: "Uploaded video",
    status: { queued: "Queued", running: "Running", completed: "Completed", failed: "Failed" },
    noSuccess: "No successful analysis yet",
    lastSuccess: "Last successful analysis",
    progress: "Progress",
    rallyCandidates: "Rally candidates: {n} · not validated",
    rallyConfirmed: "Confirmed rallies: {n} · set by a person",
    shots: "Shots: {n}",
    labelled: "Labelled by a person: {n}",
    review: "Annotations to review: {n}",
    lastRerunFailed: "The last rerun failed. The previous result is kept.",
    alreadyRunning: "An analysis of this video is already running.",
    rallyHint: "Rally candidates come from contact sequences and are not validated. Only boundaries set by a person are confirmed.",
    noRallyStats: "No rally statistics yet",
  },
  vi: {
    title: "Phiên đã lưu",
    refresh: "Làm mới",
    loading: "Đang tải phiên đã lưu…",
    empty: "Chưa có video nào được phân tích. Hãy tải lên một clip hoặc chọn video mẫu ở mục Phân tích video.",
    offline: "Không kết nối được backend trên máy. Hãy chạy docker compose up -d --build.",
    open: "Mở kết quả",
    askCoach: "Hỏi Coach",
    reanalyse: "Phân tích lại",
    sample: "Video mẫu",
    upload: "Video đã tải lên",
    status: { queued: "Đang chờ", running: "Đang chạy", completed: "Hoàn tất", failed: "Thất bại" },
    noSuccess: "Chưa có phân tích thành công",
    lastSuccess: "Phân tích thành công gần nhất",
    progress: "Tiến độ",
    rallyCandidates: "{n} ứng viên rally (chưa kiểm chứng)",
    rallyConfirmed: "{n} rally đã xác nhận (do người xác định)",
    shots: "{n} cú đánh",
    labelled: "{n} cú do người gán nhãn",
    review: "{n} chú thích cần xem lại",
    lastRerunFailed: "Lần phân tích lại gần nhất thất bại. Kết quả trước đó vẫn được giữ.",
    alreadyRunning: "Video này đang được phân tích.",
    rallyHint: "Ứng viên rally được suy ra từ chuỗi lần chạm và chưa kiểm chứng. Chỉ các mốc do người xác định mới được xác nhận.",
    noRallyStats: "Chưa có thống kê rally",
  },
  de: {
    title: "Gespeicherte Sitzungen",
    refresh: "Aktualisieren",
    loading: "Gespeicherte Sitzungen werden geladen…",
    empty: "Noch keine analysierten Videos. Lade unter Videoanalyse einen Clip hoch oder wähle ein Testbeispiel.",
    offline: "Das lokale Backend ist nicht erreichbar. Starte es mit docker compose up -d --build.",
    open: "Ergebnis öffnen",
    askCoach: "Coach fragen",
    reanalyse: "Erneut analysieren",
    sample: "Testbeispiel",
    upload: "Hochgeladenes Video",
    status: { queued: "In Warteschlange", running: "Läuft", completed: "Fertig", failed: "Fehlgeschlagen" },
    noSuccess: "Noch keine erfolgreiche Analyse",
    lastSuccess: "Letzte erfolgreiche Analyse",
    progress: "Fortschritt",
    rallyCandidates: "Ballwechsel-Kandidaten: {n} · nicht validiert",
    rallyConfirmed: "Bestätigte Ballwechsel: {n} · von einer Person festgelegt",
    shots: "Schläge: {n}",
    labelled: "Von einer Person beschriftet: {n}",
    review: "Anmerkungen zur Prüfung: {n}",
    lastRerunFailed: "Die letzte erneute Analyse ist fehlgeschlagen. Das vorherige Ergebnis bleibt erhalten.",
    alreadyRunning: "Eine Analyse dieses Videos läuft bereits.",
    rallyHint: "Ballwechsel-Kandidaten stammen aus Kontaktfolgen und sind nicht validiert. Nur von einer Person festgelegte Grenzen gelten als bestätigt.",
    noRallyStats: "Noch keine Ballwechsel-Statistik",
  },
} as const;

const LOCALE: Record<StudioLanguage, string> = { en: "en-GB", de: "de-DE", vi: "vi-VN" };

function fill(template: string, n: number): string {
  return template.replace("{n}", String(n));
}

type SessionLibraryProps = {
  language: StudioLanguage;
  onOpenJob: (jobId: string) => void;
  onOpenCoach: () => void;
};

export default function SessionLibrary({ language, onOpenJob, onOpenCoach }: SessionLibraryProps) {
  const copy = COPY[language];
  // Requests go through the studio's own server, which holds the backend address and the API token.
  const apiBase = LOCAL_AI_PROXY_BASE;
  const [items, setItems] = useState<SessionItem[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyJob, setBusyJob] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  // Sessions are listed from the local backend. State is written only after the awaited response.
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const body = await fetchJson<{ sessions: SessionItem[] }>(apiUrl(apiBase, "/api/v1/sessions"));
        if (!active) return;
        setItems(body.sessions);
        setOffline(false);
      } catch {
        if (!active) return;
        setItems([]);
        setOffline(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [apiBase, reload]);

  // While an analysis of any session runs, refresh the cards so that the progress and the new result show up.
  const anyRunning = (items ?? []).some((item) => item.running !== null);
  useEffect(() => {
    if (!anyRunning) return undefined;
    const timer = setInterval(() => setReload((value) => value + 1), 4000);
    return () => clearInterval(timer);
  }, [anyRunning]);

  async function askCoach(item: JobSummary) {
    setBusyJob(item.job_id);
    setActionError(null);
    try {
      const results = await fetchJson<VideoAnalysisResults>(apiUrl(apiBase, `/api/v1/analyses/${item.job_id}/results`));
      publishAnalysisSnapshot(buildVideoAnalysisSnapshot(results, {
        jobId: item.job_id,
        sourceKind: item.source.kind === "upload" ? "upload" : "sample",
        sourceName: item.source.name,
        capturedAt: new Date(item.created_at * 1000).toISOString(),
      }));
      // Remember the session, so the Coach still has its analysis after a page reload.
      writeStoredJobId(typeof window !== "undefined" ? window.localStorage : null, item.job_id);
      onOpenCoach();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : copy.offline);
    } finally {
      setBusyJob(null);
    }
  }

  // Reanalysing a sample starts a new run for the same session. The server refuses a second run while one is queued.
  const reanalyse = useCallback(async (sampleId: string) => {
    setActionError(null);
    try {
      await fetchJson(apiUrl(apiBase, "/api/v1/analyses"), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ sample_id: sampleId, mode: "auto" }).toString(),
      });
    } catch (caught) {
      setActionError(caught instanceof LocalAiApiError && caught.code === "analysis_running" ? copy.alreadyRunning : copy.offline);
    }
    setReload((value) => value + 1);
  }, [apiBase, copy.alreadyRunning, copy.offline]);

  return (
    <section className={styles.library} aria-labelledby="session-library-title">
      <header className={styles.toolbar}>
        <h2 id="session-library-title">{copy.title}</h2>
        <button type="button" className={styles.ghostButton} onClick={() => setReload((value) => value + 1)}>
          <RefreshCw aria-hidden="true" />
          {copy.refresh}
        </button>
      </header>

      <EvaluationDashboard apiBase={apiBase} language={language} revision={reload} />

      {offline ? (
        <p role="alert" className={styles.bad}>
          <AlertTriangle aria-hidden="true" />
          {copy.offline}
        </p>
      ) : null}
      {actionError ? (
        <p role="alert" className={styles.bad}>
          <AlertTriangle aria-hidden="true" />
          {actionError}
        </p>
      ) : null}
      {items === null ? (
        <p className={styles.muted}>
          <Loader2 aria-hidden="true" className={styles.spin} />
          {copy.loading}
        </p>
      ) : null}
      {items !== null && items.length === 0 && !offline ? <p className={styles.muted}>{copy.empty}</p> : null}

      <ul className={styles.list}>
        {(items ?? []).map((item) => {
          const shownStatus = item.running ? item.running.status : item.active ? "completed" : "failed";
          const counts = item.active?.counts ?? null;
          return (
            <li key={item.session_id} className={styles.card}>
              <div className={styles.cardTop}>
                <Film aria-hidden="true" />
                <strong>{item.source.name}</strong>
                <span className={`${styles.badge} ${styles[`badge_${shownStatus}`]}`}>{copy.status[shownStatus]}</span>
              </div>
              <p className={styles.muted}>
                {item.source.kind === "upload" ? copy.upload : copy.sample}
                {" · "}
                {item.active?.finished_at
                  ? `${copy.lastSuccess}: ${new Date(item.active.finished_at * 1000).toLocaleString(LOCALE[language])}`
                  : copy.noSuccess}
              </p>
              {item.running ? (
                <p className={styles.muted} role="status">
                  {copy.progress}: {item.running.stage ?? copy.status[item.running.status]} · {Math.round(item.running.progress * 100)}%
                </p>
              ) : null}
              {item.failed_since_success > 0 && item.active ? (
                <p className={styles.bad}>
                  <AlertTriangle aria-hidden="true" />
                  {copy.lastRerunFailed}
                </p>
              ) : null}
              {counts ? (
                <ul className={styles.muted}>
                  <li>{fill(copy.shots, counts.shots)} · {fill(copy.labelled, counts.labelled_by_person)}</li>
                  {counts.unmatched_annotations > 0 ? <li>{fill(copy.review, counts.unmatched_annotations)}</li> : null}
                </ul>
              ) : (
                <p className={styles.muted}>{copy.noRallyStats}</p>
              )}
              <div className={styles.actions}>
                {item.active ? (
                  <button type="button" className={styles.ghostButton} onClick={() => onOpenJob(item.active!.job_id)}>
                    <Film aria-hidden="true" />
                    {copy.open}
                  </button>
                ) : null}
                {item.source.kind === "sample" && item.source.sample_id ? (
                  <button
                    type="button"
                    className={styles.ghostButton}
                    disabled={item.running !== null}
                    onClick={() => void reanalyse(item.source.sample_id as string)}
                  >
                    <RotateCw aria-hidden="true" />
                    {copy.reanalyse}
                  </button>
                ) : null}
                {item.active ? (
                  <button
                    type="button"
                    className={styles.primaryButton}
                    onClick={() => void askCoach(item.active!)}
                    disabled={busyJob !== null}
                  >
                    {busyJob === item.active.job_id ? <Loader2 aria-hidden="true" className={styles.spin} /> : <MessageCircleMore aria-hidden="true" />}
                    {copy.askCoach}
                  </button>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
