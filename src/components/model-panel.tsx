"use client";

import { useEffect, useState } from "react";
import { apiUrl, artifactUrl, fetchJson, LocalAiApiError } from "@/lib/local-ai/client";
import { WORKFLOW_COPY } from "@/lib/local-ai/copy-workflow";
import {
  runState,
  shortDigest,
  type ModelExecutionFile,
  type ModelRecord,
  type RunState,
} from "@/lib/local-ai/model-execution";
import type { StudioLanguage } from "@/lib/studio-types";
import styles from "./workflow-panels.module.css";

const MODEL_LABELS: Record<string, Record<StudioLanguage, string>> = {
  player_detector: { en: "Player detector", vi: "Bộ phát hiện người chơi", de: "Personendetektor" },
  player_tracker: { en: "Player tracker", vi: "Bộ theo dõi người chơi", de: "Personen-Tracker" },
  identity_matcher: { en: "Identity matcher", vi: "Bộ ghép định danh", de: "Identitätszuordnung" },
  shuttle_detector: { en: "Shuttle detector", vi: "Bộ phát hiện quả cầu", de: "Federball-Detektor" },
  shuttle_refiner: { en: "Shuttle refiner", vi: "Bộ làm mượt quỹ đạo", de: "Federball-Glättung" },
  court_calibration: { en: "Court calibration", vi: "Hiệu chỉnh sân", de: "Feldkalibrierung" },
  shot_classifier: { en: "Shot classifier (trajectory rules)", vi: "Bộ phân loại cú đánh (luật quỹ đạo)", de: "Schlagklassifikator (Flugbahn-Regeln)" },
};

const ORDER = [
  "player_detector",
  "player_tracker",
  "identity_matcher",
  "shuttle_detector",
  "shuttle_refiner",
  "court_calibration",
  "shot_classifier",
];

type Props = { apiBase: string; jobId: string; language: StudioLanguage; revision: number };
type LoadState =
  | { phase: "loading" }
  | { phase: "missing" }
  | { phase: "error" }
  | { phase: "ready"; data: ModelExecutionFile };

function badgeText(state: RunState, copy: (typeof WORKFLOW_COPY)["en"]): string {
  if (state === "ran") return copy.modelRan;
  if (state === "not-run") return copy.modelNotRun;
  return copy.modelUnknown;
}

function ModelRow({ id, model, language }: { id: string; model: ModelRecord | undefined; language: StudioLanguage }) {
  const copy = WORKFLOW_COPY[language];
  const state = runState(model);
  const label = MODEL_LABELS[id]?.[language] ?? id;
  return (
    <article className={styles.modelCard}>
      <header className={styles.modelHeader}>
        <strong>{label}</strong>
        <span className={state === "ran" ? styles.badgeRan : styles.badgeIdle}>{badgeText(state, copy)}</span>
      </header>
      {model?.name ? <p className={styles.muted}>{model.name}</p> : null}
      <dl className={styles.facts}>
        {model?.file ? (<><dt>{copy.modelFile}</dt><dd>{model.file}</dd></>) : null}
        {model?.onnx_sha256 ? (<><dt>{copy.modelDigest}</dt><dd title={model.onnx_sha256}>{shortDigest(model.onnx_sha256)}</dd></>) : null}
        {model?.checkpoint ? (<><dt>{copy.modelCheckpoint}</dt><dd>{model.checkpoint} · {shortDigest(model.checkpoint_sha256)}</dd></>) : null}
        {model?.providers ? (<><dt>{copy.modelProviders}</dt><dd>{model.providers.join(", ") || "–"}</dd></>) : null}
        {model?.licence ? (<><dt>{copy.modelLicence}</dt><dd>{model.licence}</dd></>) : null}
        {model?.frames_processed !== undefined ? (<><dt>{copy.modelFrames}</dt><dd>{model.frames_processed}</dd></>) : null}
        {model?.windows_processed !== undefined ? (<><dt>{copy.modelWindows}</dt><dd>{model.windows_processed}</dd></>) : null}
        {model?.not_applied_reason ? (<><dt>{copy.modelReason}</dt><dd>{model.not_applied_reason}</dd></>) : null}
        {model?.status ? (<><dt>{copy.modelReason}</dt><dd>{model.status}</dd></>) : null}
      </dl>
    </article>
  );
}

export function ModelPanel({ apiBase, jobId, language, revision }: Props) {
  const copy = WORKFLOW_COPY[language];
  const [load, setLoad] = useState<LoadState>({ phase: "loading" });

  useEffect(() => {
    let active = true;
    // model_execution.json is the raw record written when the analysis ran; it is never edited. The trajectory rules run
    // afterwards from this job's own outputs, so their run is shown from the shot-trajectory summary when it exists.
    const trajectory = fetchJson<{ records?: number; rule_version?: string; run_id?: string }>(
      apiUrl(apiBase, `/api/v1/analyses/${encodeURIComponent(jobId)}/shot-trajectory`),
    ).catch(() => null);
    Promise.all([fetchJson<ModelExecutionFile>(artifactUrl(apiBase, jobId, "model_execution.json")), trajectory]).then(
      ([raw, summary]) => {
        if (!active) return;
        const data: ModelExecutionFile = summary && summary.rule_version
          ? {
              ...raw,
              models: {
                ...raw.models,
                shot_classifier: {
                  executed: true,
                  name: `${summary.rule_version} · rule-based trajectory estimate, not validated`,
                  status: `completed · ${summary.records ?? 0} shot rows`,
                  file: "derived/shot_trajectory_dataset.jsonl",
                  source: summary.run_id,
                },
              },
            }
          : raw;
        setLoad({ phase: "ready", data });
      },
      (error: unknown) => {
        if (!active) return;
        setLoad(error instanceof LocalAiApiError && error.status === 404 ? { phase: "missing" } : { phase: "error" });
      },
    );
    return () => {
      active = false;
    };
  }, [apiBase, jobId, revision]);

  return (
    <section className={styles.panel} aria-labelledby="model-panel-title">
      <h4 id="model-panel-title" className={styles.title}>{copy.modelsTitle}</h4>
      <p className={styles.muted}>{copy.modelsIntro}</p>
      {load.phase === "missing" ? <p className={styles.notice}>{copy.modelNotRecorded}</p> : null}
      {load.phase === "error" ? <p className={styles.notice}>{copy.uploadFailed}</p> : null}
      {load.phase === "ready" ? (
        <>
          <div className={styles.modelGrid}>
            {ORDER.map((id) => (
              <ModelRow key={id} id={id} model={load.data.models[id]} language={language} />
            ))}
          </div>
          <dl className={styles.facts}>
            <dt>{copy.modelDevice}</dt>
            <dd>{load.data.device} · {copy.modelThreads} {load.data.threads}</dd>
            <dt>{copy.modelRuntime}</dt>
            <dd>{Object.entries(load.data.runtime).map(([name, version]) => `${name} ${version ?? "–"}`).join(" · ")}</dd>
          </dl>
          <h5 className={styles.subTitle}>{copy.modelTiming}</h5>
          <dl className={styles.facts}>
            <dt>{copy.modelAnalyseSeconds}</dt>
            <dd>{load.data.timing.analyse_seconds ?? "–"}</dd>
            <dt>{copy.modelProcessingFps}</dt>
            <dd>{load.data.timing.processing_fps ?? "–"}</dd>
            <dt>{copy.modelWallSeconds}</dt>
            <dd>{load.data.timing.wall_seconds ?? "–"}</dd>
            <dt>{copy.modelPeakMemory}</dt>
            <dd>{load.data.timing.peak_rss_mb ?? "–"}</dd>
          </dl>
          {load.data.not_implemented.length > 0 ? (
            <>
              <h5 className={styles.subTitle}>{copy.modelNotImplemented}</h5>
              <ul className={styles.list}>
                {load.data.not_implemented.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
