"use client";

import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { artifactUrl, correctionsUrl, fetchJson } from "@/lib/local-ai/client";
import { WORKFLOW_COPY } from "@/lib/local-ai/copy-workflow";
import type { StudioLanguage } from "@/lib/studio-types";
import styles from "./workflow-panels.module.css";

// The shape of the parts of results.json this panel shows. Older analyses may lack the identity block.
export type StatsResults = {
  video: { frames_analysed: number; duration_s: number | null };
  shuttle: { frames_total: number; frames_detected: number; frames_interpolated: number; visible_ratio: number };
  identity?: {
    coverage: Record<string, number | null>;
    event_counts: Record<string, number>;
    events_total: number;
    corrections_applied_frames: number;
  } | null;
  rally_segmentation: { status: string; count?: number; validated?: boolean };
  shot_classification: { status: string };
  artifacts: Record<string, string | null | undefined>;
};

export type StatsMetrics = { wall_seconds?: number; stage_seconds?: Record<string, number> };

type Props = {
  apiBase: string;
  jobId: string;
  language: StudioLanguage;
  results: StatsResults;
  metrics: StatsMetrics | null;
  revision: number;
  /** Contact candidates on the Shot timeline of this analysis. */
  shotCount?: number | null;
};



function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? "–" : `${Math.round(value * 100)} %`;
}

export function StatisticsPanel({ apiBase, jobId, language, results, metrics, revision, shotCount = null }: Props) {
  const copy = WORKFLOW_COPY[language];
  const [corrections, setCorrections] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    fetchJson<{ entries: unknown[] }>(correctionsUrl(apiBase, jobId)).then(
      (body) => {
        if (active) setCorrections(body.entries.length);
      },
      () => {
        if (active) setCorrections(null);
      },
    );
    return () => {
      active = false;
    };
  }, [apiBase, jobId, revision]);

  const identity = results.identity ?? null;
  const shuttleNote = `${results.shuttle.frames_detected} / ${results.shuttle.frames_total}`;
  const duration = metrics?.wall_seconds;

  return (
    <section className={styles.panel} aria-labelledby="stats-title">
      <h4 id="stats-title" className={styles.title}>{copy.statsTitle}</h4>
      <p className={styles.muted}>{copy.statsIntro}</p>
      <div className={styles.statGrid}>
        <div className={styles.stat}>
          <span className={styles.statLabel}>{copy.statFrames}</span>
          <strong>{results.video.frames_analysed}</strong>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>{copy.statShuttle}</span>
          <strong>{percent(results.shuttle.visible_ratio)}</strong>
          <span className={styles.muted}>{shuttleNote} · {copy.statShuttleNote}</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>{copy.statIdentity}</span>
          <strong>{identity ? Object.entries(identity.coverage).map(([key, value]) => `${key} ${percent(value)}`).join(" · ") : "–"}</strong>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>{copy.statEvents}</span>
          <strong>{identity ? identity.events_total : "–"}</strong>
          <span className={styles.muted}>{identity ? `${copy.statCorrections}: ${corrections ?? "–"} · ${identity.corrections_applied_frames} frames` : ""}</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>{copy.statShots}</span>
          <strong>{shotCount ?? "–"}</strong>
          <span className={styles.muted}>{copy.statShotsEstimate}</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>{copy.statDuration}</span>
          <strong>{duration !== undefined ? `${duration.toFixed(1)} s` : "–"}</strong>
        </div>
      </div>
      <p className={styles.notice}>{copy.statNotEvaluated}. {copy.statAccuracyNote}</p>

      <h4 className={styles.subTitle}>{copy.exportsTitle}</h4>
      <p className={styles.muted}>{copy.exportsIntro}</p>
      <p>
        <a className={styles.ghostButton} href={artifactUrl(apiBase, jobId, "annotated.mp4")} download={`smashlab-annotated-${jobId}.mp4`}>
          <Download size={14} aria-hidden /> {copy.exportDownload}
        </a>
      </p>
    </section>
  );
}
