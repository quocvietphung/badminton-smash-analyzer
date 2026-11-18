"use client";

import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { apiUrl, fetchJson, type LocalAiEvaluation } from "@/lib/local-ai/client";
import { EVIDENCE_COPY } from "@/lib/local-ai/copy";
import type { StudioLanguage } from "@/lib/studio-types";
import styles from "./evaluation-dashboard.module.css";

type Props = { apiBase: string; language: StudioLanguage; revision: number };

function show(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "–" : value.toFixed(digits);
}

function percent(value: number | null | undefined): string {
  return value === null || value === undefined || !Number.isFinite(value) ? "–" : `${Math.round(value * 100)} %`;
}

export function EvaluationDashboard({ apiBase, language, revision }: Props) {
  const copy = EVIDENCE_COPY[language].evaluation;
  const [data, setData] = useState<LocalAiEvaluation | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    let cancelled = false;
    fetchJson<LocalAiEvaluation>(apiUrl(apiBase, "/api/v1/evaluation")).then(
      (body) => {
        if (cancelled) return;
        setData(body);
        setState("ready");
      },
      () => {
        if (!cancelled) setState("error");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [apiBase, revision]);

  if (state === "loading") {
    return (
      <p className={styles.muted}>
        <Loader2 size={14} className={styles.spin} aria-hidden /> {copy.loading}
      </p>
    );
  }
  if (state === "error" || data === null) return <p className={styles.noticeError}>{copy.error}</p>;

  const kinds = Object.entries(data.identities.counts_by_kind);
  return (
    <section className={styles.dashboard} aria-labelledby="evaluation-title">
      <header className={styles.header}>
        <h3 id="evaluation-title">{copy.title}</h3>
        <p className={styles.muted}>{copy.intro}</p>
        <p className={styles.flow}>{copy.flow}</p>
      </header>
      {data.analyses.total === 0 ? <p className={styles.muted}>{copy.empty}</p> : null}

      <div className={styles.grid}>
        <article className={styles.card}>
          <h4>{copy.analyses}</h4>
          <p className={styles.big}>{data.analyses.completed}</p>
          <p className={styles.muted}>
            {copy.completed} · {data.analyses.failed} {copy.failed} · {data.analyses.in_progress} {copy.inProgress}
          </p>
          <p className={styles.muted}>
            {data.analyses.frames_analysed} {copy.frames} · {show(data.analyses.video_seconds_analysed, 1)} {copy.videoSeconds}
          </p>
        </article>

        <article className={styles.card}>
          <h4>{copy.processing}</h4>
          <dl className={styles.facts}>
            <dt>{copy.wallSeconds}</dt>
            <dd>{show(data.processing.wall_seconds_mean, 1)}</dd>
            <dt>{copy.fps}</dt>
            <dd>{show(data.processing.frames_per_second_mean, 2)}</dd>
            <dt>{copy.cpu}</dt>
            <dd>{show(data.processing.cpu_utilisation_mean, 2)}</dd>
            <dt>{copy.peakRss}</dt>
            <dd>{show(data.processing.peak_rss_mb_max, 0)}</dd>
            <dt>{copy.detectorMs}</dt>
            <dd>{show(data.processing.detector_ms_per_frame_mean, 1)}</dd>
            <dt>{copy.deriveSeconds}</dt>
            <dd>{show(data.processing.derive_seconds_mean, 2)}</dd>
          </dl>
          <p className={styles.note}>{data.processing.note}</p>
        </article>

        <article className={styles.card}>
          <h4>{copy.shuttle}</h4>
          <dl className={styles.facts}>
            <dt>{copy.visibleRatio}</dt>
            <dd>{percent(data.shuttle_coverage.visible_ratio_mean)}</dd>
            <dt>{copy.detectedRatio}</dt>
            <dd>{percent(data.shuttle_coverage.detected_ratio_mean)}</dd>
            <dt>{copy.interpolated}</dt>
            <dd>{data.shuttle_coverage.interpolated_frames_total}</dd>
          </dl>
          <p className={styles.note}>{data.shuttle_coverage.note}</p>
        </article>

        <article className={styles.card}>
          <h4>{copy.tracking}</h4>
          <dl className={styles.facts}>
            <dt>{copy.tracksPerAnalysis}</dt>
            <dd>{show(data.tracking.tracks_per_analysis_mean, 1)}</dd>
            <dt>{copy.tracksPerIdentity}</dt>
            <dd>{show(data.tracking.tracks_per_identity_mean, 2)}</dd>
          </dl>
          <p className={styles.note}>{data.tracking.note}</p>
        </article>

        <article className={styles.card}>
          <h4>{copy.identities}</h4>
          <dl className={styles.facts}>
            <dt>{copy.identityEvents}</dt>
            <dd>{data.identities.events_total}</dd>
            <dt>{copy.switchesSuspected}</dt>
            <dd>{data.identities.switches_suspected}</dd>
          </dl>
          <div className={styles.chips}>
            {kinds.map(([kind, count]) => (
              <span key={kind} className={styles.chip}>
                {EVIDENCE_COPY[language].kindLabels[kind] ?? kind}: {count}
              </span>
            ))}
          </div>
          <p className={styles.note}>{data.identities.note}</p>
        </article>

        <article className={styles.card}>
          <h4>{copy.corrections}</h4>
          <dl className={styles.facts}>
            <dt>{copy.analysesWithCorrections}</dt>
            <dd>{data.corrections.analyses_with_corrections}</dd>
            <dt>{copy.correctionEntries}</dt>
            <dd>{Object.values(data.corrections.entries_by_type).reduce((sum, value) => sum + value, 0)}</dd>
          </dl>
          <p className={styles.note}>{data.corrections.note}</p>
        </article>

        <article className={styles.card}>
          <h4>{copy.shots}</h4>
          <p className={styles.bad}>{copy.shotsStatus}</p>
          <p className={styles.note}>{data.shots.evaluation}</p>
        </article>

        <article className={styles.card}>
          <h4>{copy.groundTruth}</h4>
          <p className={styles.bad}>{data.ground_truth.status}</p>
          <dl className={styles.facts}>
            <dt>{copy.labelledSamples}</dt>
            <dd>{data.ground_truth.labelled_samples}</dd>
          </dl>
          <p className={styles.note}>{data.ground_truth.note}</p>
        </article>
      </div>
    </section>
  );
}
