"use client";

import { Eye, Play } from "lucide-react";
import { useState } from "react";
import { sampleVideoUrl, thumbnailUrl, type LocalAiSample } from "@/lib/local-ai/client";
import { EVIDENCE_COPY, fill } from "@/lib/local-ai/copy";
import { WORKFLOW_COPY } from "@/lib/local-ai/copy-workflow";
import type { StudioLanguage } from "@/lib/studio-types";
import styles from "./sample-library.module.css";

export type SampleMode = "auto" | "singles" | "doubles";

type Props = {
  apiBase: string;
  language: StudioLanguage;
  samples: LocalAiSample[];
  selectedId: string | null;
  onSelect: (sampleId: string) => void;
  completedJobBySample: Record<string, string>;
  busy: boolean;
  offline: boolean;
  onRun: (sampleId: string, mode: SampleMode) => void;
  onOpenSaved: (jobId: string) => void;
};

function fileName(path: string): string {
  return path.split("/").pop() ?? path;
}

export function SampleLibrary({
  apiBase,
  language,
  samples,
  selectedId,
  onSelect,
  completedJobBySample,
  busy,
  offline,
  onRun,
  onOpenSaved,
}: Props) {
  const copy = EVIDENCE_COPY[language].samples;
  const work = WORKFLOW_COPY[language];
  const [mode, setMode] = useState<SampleMode>("auto");
  const [noImage, setNoImage] = useState<Record<string, boolean>>({});
  const selected = samples.find((sample) => sample.id === selectedId) ?? null;
  const savedJob = selected ? completedJobBySample[selected.id] : undefined;
  const canRun = Boolean(selected?.available) && !busy && !offline;

  return (
    <section className={styles.library} aria-labelledby="sample-library-title">
      <h4 id="sample-library-title" className={styles.title}>{work.sampleTitle}</h4>
      <p className={styles.intro}>{work.sampleIntro}</p>

      <ul className={styles.grid}>
        {samples.map((sample) => {
          const isSelected = sample.id === selectedId;
          return (
            <li key={sample.id}>
              <button
                type="button"
                className={isSelected ? styles.cardSelected : styles.card}
                onClick={() => onSelect(sample.id)}
                aria-pressed={isSelected}
              >
                <span className={styles.thumb}>
                  {noImage[sample.id] || !sample.available ? (
                    <span className={styles.thumbFallback}>{copy.noThumbnail}</span>
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element -- served by the studio's own proxy, not optimised by Next
                    <img
                      src={thumbnailUrl(apiBase, sample.id)}
                      alt={sample.title}
                      width={320}
                      height={180}
                      onError={() => setNoImage((current) => ({ ...current, [sample.id]: true }))}
                    />
                  )}
                </span>
                <span className={styles.name}>{sample.title}</span>
                <span className={sample.available ? styles.badgeOk : styles.badgeMissing}>
                  {sample.available ? "✓" : "!"} {sample.available ? sample.file : work.sampleMissing}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      {selected ? (
        <div className={styles.preview}>
          <h5 className={styles.subTitle}>{work.selectedSample}: {selected.title}</h5>
          <video
            key={selected.id}
            className={styles.video}
            src={sampleVideoUrl(apiBase, selected.id)}
            controls
            playsInline
            preload="metadata"
            aria-label={selected.title}
          />
          <dl className={styles.facts}>
            <div><dt>{work.sampleFile}</dt><dd>{fileName(selected.file)}</dd></div>
            <div><dt>{work.sampleDuration}</dt><dd>{selected.duration_s !== null ? `${selected.duration_s.toFixed(1)} s` : "–"}</dd></div>
            <div><dt>{work.sampleResolution}</dt><dd>{selected.width && selected.height ? `${selected.width}×${selected.height}` : "–"}</dd></div>
            <div><dt>{work.sampleFps}</dt><dd>{selected.fps ?? "–"}</dd></div>
            <div><dt>{work.sampleFrames}</dt><dd>{selected.frames ?? "–"}</dd></div>
            <div><dt>{work.sampleLicence}</dt><dd>{selected.licence ?? "–"}</dd></div>
          </dl>
          {selected.attribution ? <p className={styles.attribution}>{selected.attribution}</p> : null}
          {selected.trim ? <p className={styles.muted}>{fill(copy.trimmed, { seconds: selected.trim.duration_s })}</p> : null}

          <div className={styles.runRow}>
            <label className={styles.modeLabel}>
              <span>{work.mode}</span>
              <select value={mode} onChange={(event) => setMode(event.target.value as SampleMode)} disabled={busy || offline}>
                <option value="auto">{work.modeAuto}</option>
                <option value="singles">{work.modeSingles}</option>
                <option value="doubles">{work.modeDoubles}</option>
              </select>
            </label>
            <button type="button" className={styles.primaryButton} onClick={() => onRun(selected.id, mode)} disabled={!canRun}>
              <Play size={16} aria-hidden /> {work.runAnalysis}
            </button>
            {savedJob ? (
              <button type="button" className={styles.ghostButton} onClick={() => onOpenSaved(savedJob)}>
                <Eye size={16} aria-hidden /> {work.openCached}
              </button>
            ) : null}
          </div>
          <p className={styles.muted}>{work.runNotice}</p>
          {offline ? <p className={styles.warning}>{work.offlineBody}</p> : null}
        </div>
      ) : null}
    </section>
  );
}
