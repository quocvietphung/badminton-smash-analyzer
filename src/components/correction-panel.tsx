"use client";

import { Crosshair, Loader2, RotateCcw, Save } from "lucide-react";
import { useState } from "react";
import { correctionsUrl, fetchJson, LocalAiApiError, formatSeconds } from "@/lib/local-ai/client";
import { EVIDENCE_COPY, fill } from "@/lib/local-ai/copy";
import {
  identityColour,
  intervalAround,
  timeAtFrame,
  validateIdentityDraft,
  type CorrectionEntry,
  type DraftError,
  type TrackBox,
} from "@/lib/local-ai/evidence";
import type { StudioLanguage } from "@/lib/studio-types";
import styles from "./evidence-viewer.module.css";

const LOCALES: Record<StudioLanguage, string> = { en: "en-GB", de: "de-DE", vi: "vi-VN" };

export type CorrectionPanelProps = {
  apiBase: string;
  jobId: string;
  language: StudioLanguage;
  players: number;
  mode: string;
  totalFrames: number;
  fps: number;
  currentFrame: number;
  selectedBox: TrackBox | null;
  calibrating: boolean;
  pendingCorners: Array<[number, number]>;
  corrections: CorrectionEntry[];
  onStartCalibration: () => void;
  onStopCalibration: () => void;
  onClearCorners: () => void;
  onSaved: () => void;
};

type Notice = { tone: "ok" | "error"; text: string } | null;

export function CorrectionPanel(props: CorrectionPanelProps) {
  const copy = EVIDENCE_COPY[props.language].correction;
  const locale = LOCALES[props.language];
  const identities = Array.from({ length: props.players }, (_, index) => `P${index + 1}`);
  const [identity, setIdentity] = useState("P1");
  const [startFrame, setStartFrame] = useState<number | "">("");
  const [endFrame, setEndFrame] = useState<number | "">("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const [draftError, setDraftError] = useState<DraftError | null>(null);

  const errorText = (code: DraftError | string): string => {
    if (code === "track" || code === "identity" || code === "interval") return copy.errors[code];
    if (code === "not_ready") return copy.errors.notCompleted;
    if (code === "not_recomputable") return copy.errors.notRecomputable;
    return copy.errors.failed;
  };

  async function post(payload: Record<string, unknown>): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      await fetchJson<unknown>(correctionsUrl(props.apiBase, props.jobId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      setNotice({ tone: "ok", text: copy.saved });
      props.onSaved();
    } catch (error) {
      const code = error instanceof LocalAiApiError ? error.code : "failed";
      setNotice({ tone: "error", text: errorText(code) });
    } finally {
      setBusy(false);
    }
  }

  function saveIdentity() {
    const draft = {
      trackId: props.selectedBox ? props.selectedBox.trackId : null,
      identity,
      startFrame: startFrame === "" ? -1 : Number(startFrame),
      endFrame: endFrame === "" ? -1 : Number(endFrame),
    };
    const problem = validateIdentityDraft(draft, props.players, props.totalFrames);
    setDraftError(problem);
    if (problem) {
      setNotice({ tone: "error", text: errorText(problem) });
      return;
    }
    void post({
      type: "identity",
      track_id: draft.trackId,
      identity,
      start_frame: draft.startFrame,
      end_frame: draft.endFrame,
      note: note.trim() || undefined,
    }).then(() => setNote(""));
  }

  function saveMode(mode: "singles" | "doubles") {
    void post({ type: "mode", mode, note: undefined });
  }

  function saveCalibration() {
    if (props.pendingCorners.length !== 4) {
      setNotice({ tone: "error", text: fill(copy.calibrateClicks, { count: props.pendingCorners.length }) });
      return;
    }
    void post({ type: "court_calibration", corners_px: props.pendingCorners.map(([x, y]) => [x, y]) }).then(() => {
      props.onStopCalibration();
      props.onClearCorners();
    });
  }

  function useInterval() {
    const interval = intervalAround(props.currentFrame, Math.max(1, Math.round(props.fps / 2)), props.totalFrames);
    setStartFrame(interval.start);
    setEndFrame(interval.end);
    setDraftError(null);
  }

  function describe(entry: CorrectionEntry): string {
    if (entry.type === "identity") {
      const from = entry.start_frame ?? 0;
      const to = entry.end_frame ?? from;
      const seconds = `${formatSeconds(timeAtFrame(from, props.fps))}–${formatSeconds(timeAtFrame(to, props.fps))}`;
      return `${entry.identity ?? "?"} · ID ${entry.track_id ?? "?"} · ${from}–${to} (${seconds})`;
    }
    if (entry.type === "mode") return `${copy.players}: ${entry.mode ?? "?"}`;
    if (entry.type === "court_calibration") return `${(entry.corners_px ?? []).length} corners`;
    return entry.type;
  }

  const sortedHistory = [...props.corrections].sort((a, b) => b.created_at - a.created_at);

  return (
    <section className={styles.correction} aria-labelledby="correction-title">
      <h4 id="correction-title" className={styles.subTitle}>{copy.title}</h4>
      <p className={styles.muted}>{copy.intro}</p>

      <div className={styles.correctionBlock}>
        <p className={styles.muted}>{copy.pausePrompt}</p>
        <p className={styles.selection}>
          {props.selectedBox ? (
            <>
              <span className={styles.swatch} style={{ background: identityColour(props.selectedBox.identity) }} aria-hidden />
              {fill(copy.selectedBox, { id: props.selectedBox.trackId })}
            </>
          ) : (
            copy.noBox
          )}
        </p>
        <div className={styles.formGrid}>
          <label className={styles.field}>
            <span>{copy.identity}</span>
            <select value={identity} onChange={(event) => setIdentity(event.target.value)} disabled={busy}>
              {identities.map((key) => (
                <option key={key} value={key}>{key}</option>
              ))}
            </select>
          </label>
          <label className={styles.field}>
            <span>{copy.startFrame}</span>
            <input
              type="number"
              min={0}
              max={props.totalFrames - 1}
              value={startFrame}
              onChange={(event) => setStartFrame(event.target.value === "" ? "" : Number(event.target.value))}
              disabled={busy}
              aria-invalid={draftError === "interval"}
            />
          </label>
          <label className={styles.field}>
            <span>{copy.endFrame}</span>
            <input
              type="number"
              min={0}
              max={props.totalFrames - 1}
              value={endFrame}
              onChange={(event) => setEndFrame(event.target.value === "" ? "" : Number(event.target.value))}
              disabled={busy}
              aria-invalid={draftError === "interval"}
            />
          </label>
        </div>
        <div className={styles.actionRow}>
          <button type="button" className={styles.ghostButton} onClick={useInterval} disabled={busy}>
            <Crosshair size={14} aria-hidden /> {copy.useCurrent}
          </button>
        </div>
        <label className={styles.field}>
          <span>{copy.note}</span>
          <input type="text" maxLength={280} value={note} onChange={(event) => setNote(event.target.value)} disabled={busy} />
        </label>
        <div className={styles.actionRow}>
          <button type="button" className={styles.primaryButton} onClick={saveIdentity} disabled={busy}>
            {busy ? <Loader2 size={14} className={styles.spin} aria-hidden /> : <Save size={14} aria-hidden />}
            {busy ? copy.saving : copy.save}
          </button>
        </div>
      </div>

      <div className={styles.correctionBlock}>
        <p className={styles.muted}>{copy.players}</p>
        <div className={styles.actionRow}>
          <button type="button" className={props.mode === "singles" ? styles.primaryButton : styles.ghostButton} onClick={() => saveMode("singles")} disabled={busy}>
            {copy.singles}
          </button>
          <button type="button" className={props.mode === "doubles" ? styles.primaryButton : styles.ghostButton} onClick={() => saveMode("doubles")} disabled={busy}>
            {copy.doubles}
          </button>
        </div>
      </div>

      <div className={styles.correctionBlock}>
        <h5 className={styles.subTitle}>{copy.calibrateTitle}</h5>
        <p className={styles.muted}>{copy.calibrateHelp}</p>
        <p className={styles.muted}>{fill(copy.calibrateClicks, { count: props.pendingCorners.length })}</p>
        <div className={styles.actionRow}>
          <button type="button" className={props.calibrating ? styles.primaryButton : styles.ghostButton} onClick={props.calibrating ? props.onStopCalibration : props.onStartCalibration} disabled={busy}>
            <Crosshair size={14} aria-hidden /> {copy.calibrateTitle}
          </button>
          <button type="button" className={styles.ghostButton} onClick={props.onClearCorners} disabled={busy || props.pendingCorners.length === 0}>
            <RotateCcw size={14} aria-hidden /> {copy.calibrateReset}
          </button>
          <button type="button" className={styles.primaryButton} onClick={saveCalibration} disabled={busy || props.pendingCorners.length !== 4}>
            <Save size={14} aria-hidden /> {copy.calibrateSave}
          </button>
        </div>
      </div>

      {notice ? (
        <p className={notice.tone === "ok" ? styles.noticeOk : styles.noticeError} role="status">{notice.text}</p>
      ) : null}

      <h5 className={styles.subTitle}>{copy.history}</h5>
      {sortedHistory.length === 0 ? (
        <p className={styles.muted}>{copy.historyEmpty}</p>
      ) : (
        <ol className={styles.history}>
          {sortedHistory.map((entry) => (
            <li key={entry.id}>
              <strong>{copy.typeLabels[entry.type] ?? entry.type}</strong> · {describe(entry)}
              <span className={styles.muted}> · {new Date(entry.created_at * 1000).toLocaleString(locale)}</span>
              {entry.note ? <span className={styles.muted}> · {entry.note}</span> : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
