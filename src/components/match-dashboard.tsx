"use client";

import { Activity, Gauge, Users } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { apiUrl, artifactUrl, correctionsUrl, fetchJson, LocalAiApiError } from "@/lib/local-ai/client";
import { IDENTITY_COLOURS } from "@/lib/local-ai/evidence";
import {
  courtLines,
  courtToView,
  formatClock,
  frameAt,
  contactsSoFar,
  hitsSoFar,
  isShotType,
  buildGroundTruth,
  confirmedMotionByPlayer,
  confirmedMotionHeadline,
  parseMatchDocument,
  pointAt,
  rallyAt,
  rallyClock,
  seekTimeFor,
  shotAt,
  SHOT_TYPES,
  motionValue,
  trackingState,
  trail,
  type CourtView,
  type ShotType,
  type TrackingState,
} from "@/lib/match/analytics";
import { MATCH_COPY, type MatchCopy } from "@/lib/match/copy";
import type { MatchDocument, MatchShot, TrajectoryEstimate } from "@/lib/match/types";
import type { StudioLanguage } from "@/lib/studio-types";
import styles from "./match-dashboard.module.css";
import { ShuttleTrail } from "./shuttle-trail";
import { ShotEstimateDrawer, estimateBadge, estimateLabel, num, qualityText } from "./shot-estimate";
import { TRAJECTORY_COPY } from "@/lib/match/trajectory-copy";

type Props = { apiBase: string; jobId: string; language: StudioLanguage; revision: number };
type Load = { phase: "loading" } | { phase: "failed"; message: string } | { phase: "ready"; doc: MatchDocument };
type Save = { phase: "idle" } | { phase: "saving" } | { phase: "saved" } | { phase: "failed"; message: string };

const TRAIL_SECONDS = 3;
const MINI_VIEW: CourtView = { width: 90, height: 176, padding: 6 };
const MAP_VIEW: CourtView = { width: 230, height: 450, padding: 14 };

function colour(player: string | null | undefined): string {
  return (player && IDENTITY_COLOURS[player]) || "#9aa4b2";
}

function motionText(doc: MatchDocument, copy: MatchCopy): { main: string; note: string } {
  if (doc.summary.speed.max_kmh !== null) {
    return { main: `${doc.summary.speed.max_kmh.toFixed(1)} km/h`, note: copy.physicalAvailable };
  }
  const confirmed = confirmedMotionHeadline(doc.shots.items);
  if (confirmed.pxPerSecond !== null) {
    return { main: `${confirmed.pxPerSecond} px/s`, note: `${copy.physicalUnavailable}. ${confirmed.count} ${copy.speedShots}. ${copy.speedConfirmed}. ${copy.speedReasonHeight}` };
  }
  if (motionValue(doc.summary.speed.candidate_max_px_per_s) !== null) {
    return { main: copy.speedUnavailable, note: copy.speedCandidatesOnly };
  }
  return { main: copy.speedUnavailable, note: copy.speedReasonNoConfirmed };
}

function stateText(state: TrackingState, copy: MatchCopy): string {
  return state === "tracked" ? copy.tracked : state === "uncertain" ? copy.uncertain : copy.lost;
}

function shotTypeText(type: string, copy: MatchCopy): string {
  return isShotType(type) ? copy.shotTypes[type] : copy.shotTypes.unknown;
}

function percent(value: number | null | undefined): string {
  return value === null || value === undefined ? "–" : `${Math.round(value * 100)} %`;
}

function CourtSvg({ doc, frame, view, labels, label }: { doc: MatchDocument; frame: number; view: CourtView; labels: boolean; label: string }) {
  const corner = courtToView(0, 0, view);
  const far = courtToView(doc.court.dimensions_m.doubles_width_m, doc.court.dimensions_m.length_m, view);
  const step = doc.positions.step_frames;
  return (
    <svg viewBox={`0 0 ${view.width} ${view.height}`} className={styles.courtSvg} role="img" aria-label={label}>
      <rect x={corner.x} y={corner.y} width={far.x - corner.x} height={far.y - corner.y} className={styles.courtFloor} />
      {courtLines().map((line, index) => {
        const a = courtToView(line.x1, line.y1, view);
        const b = courtToView(line.x2, line.y2, view);
        return <line key={index} x1={a.x} y1={a.y} x2={b.x} y2={b.y} className={styles[`line_${line.kind}`]} />;
      })}
      {doc.players.map((player) => {
        const series = doc.positions.series[player] ?? [];
        const path = trail(series, frame, TRAIL_SECONDS, doc.fps).map((point) => courtToView(point.x, point.y, view));
        const current = pointAt(series, frame, Math.max(1, step) * 2);
        const here = current && current[1] !== null && current[2] !== null ? courtToView(current[1], current[2], view) : null;
        return (
          <g key={player}>
            {path.length > 1 ? (
              <polyline
                points={path.map((point) => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ")}
                fill="none"
                stroke={colour(player)}
                strokeWidth={labels ? 2.4 : 1.6}
                strokeLinecap="round"
                strokeLinejoin="round"
                opacity={0.85}
              />
            ) : null}
            {here ? (
              <>
                <circle cx={here.x} cy={here.y} r={labels ? 7 : 4} fill={colour(player)} stroke="#fff" strokeWidth={labels ? 2 : 1.2} />
                {labels ? (
                  <text x={here.x + 10} y={here.y + 4} className={styles.courtLabel}>
                    {player}
                  </text>
                ) : null}
              </>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

export function MatchDashboard({ apiBase, jobId, language, revision }: Props) {
  const copy = MATCH_COPY[language];
  const [load, setLoad] = useState<Load>({ phase: "loading" });
  const [reload, setReload] = useState(0);
  const [estimates, setEstimates] = useState<Record<number, TrajectoryEstimate> | null>(null);
  const [building, setBuilding] = useState(false);
  const [estimateReload, setEstimateReload] = useState(0);

  useEffect(() => {
    // One record per Shot timeline row of this analysis, read from this job's dataset only.
    let active = true;
    fetchJson(apiUrl(apiBase, `/api/v1/analyses/${encodeURIComponent(jobId)}/shot-trajectory/records`))
      .then((value) => {
        if (!active) return;
        const body = value as { records: TrajectoryEstimate[] };
        setEstimates(Object.fromEntries(body.records.map((record) => [record.frame, record])));
      })
      .catch(() => {
        if (active) setEstimates(null);
      });
    return () => {
      active = false;
    };
  }, [apiBase, jobId, estimateReload]);

  async function buildEstimates() {
    setBuilding(true);
    try {
      await fetchJson(apiUrl(apiBase, `/api/v1/analyses/${encodeURIComponent(jobId)}/shot-trajectory/build`), { method: "POST" });
      setEstimateReload((value) => value + 1);
    } catch {
      setEstimates(null);
    } finally {
      setBuilding(false);
    }
  }

  const estimateAt = (frame: number): TrajectoryEstimate | undefined => (estimates ? estimates[frame] : undefined);
  const [time, setTime] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [labelType, setLabelType] = useState<ShotType>("unknown");
  const [labelPlayer, setLabelPlayer] = useState<string>("");
  const [save, setSave] = useState<Save>({ phase: "idle" });
  const videoRef = useRef<HTMLVideoElement>(null);
  const ready = load.phase === "ready";

  // The match document is computed on the backend from saved outputs. State is written only after the response.
  useEffect(() => {
    let active = true;
    fetchJson<unknown>(apiUrl(apiBase, `/api/v1/analyses/${encodeURIComponent(jobId)}/match`)).then(
      (raw) => {
        if (!active) return;
        const doc = parseMatchDocument(raw);
        setLoad(doc ? { phase: "ready", doc } : { phase: "failed", message: copy.failed });
      },
      (error: unknown) => {
        if (active) setLoad({ phase: "failed", message: error instanceof LocalAiApiError ? `${copy.failed} (${error.code})` : copy.failed });
      },
    );
    return () => {
      active = false;
    };
  }, [apiBase, jobId, revision, reload, copy.failed]);

  // The overlay follows the video: every animation frame while playing, and on every seek.
  useEffect(() => {
    const video = videoRef.current;
    if (!ready || !video) return;
    let handle = 0;
    const tick = () => {
      setTime(video.currentTime);
      if (!video.paused && !video.ended) handle = window.requestAnimationFrame(tick);
    };
    const start = () => {
      window.cancelAnimationFrame(handle);
      handle = window.requestAnimationFrame(tick);
    };
    const sync = () => setTime(video.currentTime);
    video.addEventListener("play", start);
    video.addEventListener("seeked", sync);
    video.addEventListener("timeupdate", sync);
    return () => {
      window.cancelAnimationFrame(handle);
      video.removeEventListener("play", start);
      video.removeEventListener("seeked", sync);
      video.removeEventListener("timeupdate", sync);
    };
  }, [ready]);

  const seekTo = useCallback((frame: number, fps: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.pause();
    video.currentTime = seekTimeFor(frame, fps);
    setTime(video.currentTime);
  }, []);

  const view = useMemo(() => {
    if (load.phase !== "ready") return null;
    const doc = load.doc;
    const frame = frameAt(time, doc.fps, doc.frames);
    const rally = rallyAt(doc.rallies.items, frame);
    const shots = doc.shots.items;
    return {
      doc,
      frame,
      rally,
      shot: shotAt(shots, frame, doc.fps),
      hits: hitsSoFar(shots, doc.players, frame, null),
      contacts: contactsSoFar(shots, frame, null),
      states: Object.fromEntries(
        doc.players.map((player) => [player, trackingState(doc.positions.series[player] ?? [], frame, doc.positions.step_frames)]),
      ) as Record<string, TrackingState>,
    };
  }, [load, time]);

  async function saveCorrection(payload: Record<string, unknown>) {
    setSave({ phase: "saving" });
    try {
      await fetchJson(correctionsUrl(apiBase, jobId), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      setSave({ phase: "saved" });
      setReload((value) => value + 1);
    } catch (error) {
      setSave({ phase: "failed", message: error instanceof LocalAiApiError ? `${copy.saveFailed} ${error.message}` : copy.saveFailed });
    }
  }

  function exportGroundTruth() {
    const payload = buildGroundTruth(doc, jobId, new Date().toISOString());
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `smashlab-ground-truth-${jobId}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }


  function selectShot(shot: MatchShot, fps: number) {
    setSelected(shot.id);
    setLabelType(isShotType(shot.type) ? shot.type : "unknown");
    setSave({ phase: "idle" });
    seekTo(shot.frame, fps);
  }

  if (load.phase === "loading") return <p className={styles.muted}>{copy.loading}</p>;
  if (load.phase === "failed" || !view) {
    return (
      <section className={styles.panel}>
        <h3 className={styles.title}>{copy.title}</h3>
        <p className={styles.notice}>{load.phase === "failed" ? load.message : copy.failed}</p>
      </section>
    );
  }

  const { doc, frame, rally, shot, hits, contacts, states } = view;
  const motion = motionText(doc, copy);
  const summary = doc.summary;
  const playerMotion = confirmedMotionByPlayer(doc.shots.items, doc.players);
  const currentMotion = motionValue(shot?.speed?.px_per_s);
  const currentPhysical = shot?.physical_speed.status === "available" ? shot.physical_speed : null;
  const selectedShot = doc.shots.items.find((item) => item.id === selected) ?? null;
  const selectedEstimate = selectedShot && estimates ? estimates[selectedShot.frame] : undefined;
  const selectedContact = selectedShot ? doc.contacts.items.find((item) => item.id === selectedShot.contact_id) ?? null : null;
  const executedModels = doc.ai.models
    ? Object.values(doc.ai.models).filter((model) => model.executed === true && model.name).map((model) => model.name as string)
    : [];

  return (
    <section className={styles.panel} aria-labelledby="match-title">
      <header className={styles.header}>
        <div>
          <h3 id="match-title" className={styles.title}>{copy.title}</h3>
          <p className={styles.muted}>{copy.intro}</p>
        </div>
        <div className={styles.badges}>
          <span className={styles.badge}>{copy.badgeDerived}</span>
          <span className={styles.badgeWarn}>{copy.badgeUnvalidated}</span>
        </div>
      </header>

      <div className={styles.cards}>
        <article className={styles.card}>
          <span className={styles.cardLabel}><Gauge size={14} aria-hidden /> {copy.cardSpeed}</span>
          <strong className={styles.cardValueSmall}>{motion.main}</strong>
          <span className={styles.muted}>{motion.note}</span>
        </article>
        <article className={styles.card}>
          <span className={styles.cardLabel}><Activity size={14} aria-hidden /> {copy.cardContacts}</span>
          <strong className={styles.cardValue}>{summary.contacts.counted}</strong>
          <span className={styles.muted}>{copy.cardContactsNote}</span>
        </article>
        <article className={styles.card}>
          <span className={styles.cardLabel}><Users size={14} aria-hidden /> {copy.cardPlayers}</span>
          <strong className={styles.cardValue}>{doc.players.length}</strong>
          <span className={styles.muted}>{doc.players.join(" · ")} · {copy.cardPlayersNote}</span>
        </article>
      </div>

      <figure className={styles.stage} aria-label={copy.videoTitle}>
        <video
          ref={videoRef}
          className={styles.video}
          src={artifactUrl(apiBase, jobId, "annotated.mp4")}
          controls
          playsInline
          preload="metadata"
        />
        <ShuttleTrail apiBase={apiBase} jobId={jobId} frame={frame} language={language} />
        <div className={styles.hudStrip}>
          <div className={styles.hudMetric}>
            <span className={styles.overlayLabel}>{copy.rallyTime}</span>
            <strong className={styles.overlayClock}>{rally ? formatClock(rallyClock(rally, frame, doc.fps)) : "–"}</strong>
            <span className={styles.overlayMeta}>{formatClock(frame / doc.fps)} · f {frame}</span>
          </div>
          <div className={styles.hudMetric}>
            <span className={styles.overlayLabel}>{copy.overlayContacts}</span>
            <strong className={styles.overlayClock}>{contacts}</strong>
            <span className={styles.overlayMeta}>{copy.cardContactsNote}</span>
          </div>
          <div className={styles.hudMetric}>
            <span className={styles.overlayLabel}>{copy.cardSpeed}</span>
            <strong className={styles.overlayClock}>
              {currentPhysical?.speed_first_observed_kmh !== null && currentPhysical?.speed_first_observed_kmh !== undefined
                ? `${currentPhysical.speed_first_observed_kmh.toFixed(1)}`
                : currentMotion !== null ? `${currentMotion}` : "–"}
              <small>{currentPhysical ? " km/h" : " px/s"}</small>
            </strong>
            <span className={styles.overlayMeta}>
              {currentPhysical
                ? copy.physicalAvailable
                : shot
                ? `${shotTypeText(shot.type, copy)} · ${shot.player ?? "?"} · ${shot.contact_status === "confirmed" ? copy.confirmed : copy.candidate}`
                : copy.noShot}
            </span>
          </div>
        </div>
        <div className={`${styles.overlay} ${styles.topRight}`}>
          {doc.players.map((player) => (
            <div key={player} className={styles.playerRow}>
              <span className={styles.dot} style={{ background: colour(player) }} aria-hidden />
              <strong>{player}</strong>
              <span>{copy.hits} {hits[player] ?? 0}</span>
              <span className={styles.overlayMeta}>{copy.maxSpeed} {playerMotion[player] !== null ? `${playerMotion[player]} px/s` : "–"}</span>
              <span className={states[player] === "tracked" ? styles.stateOk : styles.stateWarn}>{stateText(states[player], copy)}</span>
            </div>
          ))}
        </div>
        <div className={`${styles.overlay} ${styles.miniMap}`}>
          {doc.court.map_available ? (
            <CourtSvg doc={doc} frame={frame} view={MINI_VIEW} labels={false} label={copy.mapTitle} />
          ) : (
            <span className={styles.overlayMeta}>{copy.speedUncalibrated}</span>
          )}
        </div>
      </figure>

      <div className={styles.columns}>
        <article className={styles.subPanel}>
          <h4 className={styles.subTitle}>{copy.mapTitle}</h4>
          {doc.court.map_available ? (
            <>
              <CourtSvg doc={doc} frame={frame} view={MAP_VIEW} labels label={copy.mapTitle} />
              <p className={styles.muted}>
                {copy.mapCalibration}: {doc.court.template} · score {doc.court.score?.toFixed(2) ?? "–"} · {copy.mapTrail}
              </p>
              <p className={styles.muted}>{copy.mapApproximation} {copy.mapShuttle}</p>
            </>
          ) : (
            <p className={styles.notice}>{copy.mapUnavailable}</p>
          )}
          <ul className={styles.legend}>
            {doc.players.map((player) => (
              <li key={player}>
                <span className={styles.dot} style={{ background: colour(player) }} aria-hidden /> {player} · {stateText(states[player], copy)}
              </li>
            ))}
          </ul>
        </article>

        <article className={styles.subPanel}>
          <h4 className={styles.subTitle}>{copy.timelineTitle}</h4>
          {estimates === null ? (
            <p className={styles.notice}>
              {TRAJECTORY_COPY[language].notBuilt}{" "}
              <button type="button" className={styles.primaryButton} disabled={building} onClick={() => void buildEstimates()}>
                {TRAJECTORY_COPY[language].build}
              </button>
            </p>
          ) : null}
          <p className={styles.muted}>{copy.timelineIntro}</p>
          {doc.shots.items.length === 0 ? <p className={styles.notice}>{copy.timelineEmpty}</p> : null}
          <ol className={styles.timeline}>
            {doc.shots.items.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={item.id === selected ? styles.eventActive : styles.event}
                  onClick={() => selectShot(item, doc.fps)}
                  aria-pressed={item.id === selected}
                >
                  <span className={styles.eventTime}>{formatClock(item.time_s)}</span>
                  <span className={styles.dot} style={{ background: colour(item.player) }} aria-hidden />
                  <strong>{item.player ?? "?"}</strong>
                  {(() => {
                    const est = estimateAt(item.frame);
                    const label = estimateLabel(item, est);
                    const badge = estimateBadge(item, est, language);
                    const tc = TRAJECTORY_COPY[language];
                    return (
                      <>
                        <span className={styles.labelChip} data-label={label ?? ""}>{label ? shotTypeText(label, copy) : tc.notBuilt}</span>
                        <span className={styles.badge} data-tone={badge.tone}>{badge.text}</span>
                        {est ? (
                          <span className={styles.overlayMeta}>{`${num(est.features.speed_after_median_px_s)} ${tc.pxs} · ${tc.quality}: ${qualityText(est.evidence_quality, language)}`}</span>
                        ) : motionValue(item.speed?.px_per_s) !== null ? (
                          <span className={styles.overlayMeta}>{motionValue(item.speed?.px_per_s)} {tc.pxs}</span>
                        ) : null}
                        {est && est.review_status === "needs_review" ? <span className={styles.warnFlag} title={tc.needsReview}>⚠ {tc.needsReview}</span> : null}
                      </>
                    );
                  })()}
                  <span className={item.contact_status === "confirmed" ? styles.stateOk : styles.stateWarn}>
                    {item.contact_status === "confirmed" ? copy.confirmed : copy.candidate}
                  </span>
                  {item.flags.includes("same_player_twice") ? <span className={styles.flag} title={copy.flagSamePlayer}>!</span> : null}
                </button>
              </li>
            ))}
          </ol>

          {selectedShot ? (
            <div className={styles.evidence}>
              <h5 className={styles.subTitle}>{copy.evidenceTitle} · {formatClock(selectedShot.time_s)} · f {selectedShot.frame}</h5>
              <dl className={styles.facts}>
                {selectedContact?.evidence ? (
                  <>
                    <dt>{copy.evidenceTurn}</dt>
                    <dd>{selectedContact.evidence.turn_deg}°</dd>
                    <dt>{copy.evidenceDistance}</dt>
                    <dd>{selectedContact.evidence.distance_to_player_px} px</dd>
                    <dt>{copy.evidenceConfidence}</dt>
                    <dd>{selectedContact.evidence.shuttle_confidence}</dd>
                    <dt>{copy.evidenceInterpolated}</dt>
                    <dd>{selectedContact.evidence.interpolated_neighbours}</dd>
                  </>
                ) : null}
                <dt>{copy.evidenceSpeed}</dt>
                <dd>
                  {motionValue(selectedShot.speed?.px_per_s) !== null
                    ? `${motionValue(selectedShot.speed?.px_per_s)} px/s · ${copy.speedEstimated}. ${copy.speedReasonHeight}`
                    : selectedShot.speed?.reason ?? copy.speedReasonNoConfirmed}
                </dd>
                <dt>{selectedShot.physical_speed.status === "available" ? copy.physicalAvailable : copy.physicalUnavailable}</dt>
                <dd>
                  {selectedShot.physical_speed.status === "available"
                    ? `${copy.physicalFirstObserved}: ${selectedShot.physical_speed.speed_first_observed_kmh?.toFixed(1)} km/h`
                    : `${copy.physicalReasons}: ${selectedShot.physical_speed.reason_codes.join(", ") || "–"}`}
                </dd>
                {selectedShot.physical_speed.status === "available" ? (
                  <>
                    <dt>{copy.physicalAtNet}</dt>
                    <dd>{selectedShot.physical_speed.speed_at_net_kmh !== null ? `${selectedShot.physical_speed.speed_at_net_kmh.toFixed(1)} km/h` : "–"}</dd>
                    <dt>{copy.physicalAtContact}</dt>
                    <dd>{selectedShot.physical_speed.speed_at_contact_extrapolated_kmh !== null ? `${selectedShot.physical_speed.speed_at_contact_extrapolated_kmh.toFixed(1)} km/h` : "–"}</dd>
                    <dt>{copy.physicalUncertainty}</dt>
                    <dd>{selectedShot.physical_speed.uncertainty_kmh ? `${selectedShot.physical_speed.uncertainty_kmh[0].toFixed(1)}–${selectedShot.physical_speed.uncertainty_kmh[1].toFixed(1)} km/h` : "–"}</dd>
                    <dt>{copy.physicalMethod}</dt>
                    <dd>{selectedShot.physical_speed.method}</dd>
                    <dt>{copy.physicalCalibration}</dt>
                    <dd>{selectedShot.physical_speed.calibration.source ?? "–"}</dd>
                  </>
                ) : null}
                <dt>{copy.evidenceTypeReason}</dt>
                <dd>{selectedShot.type_reason ?? "–"}</dd>
                <dt>{copy.evidenceSource}</dt>
                <dd>{selectedShot.evidence_source}</dd>
                <dt>{copy.evidenceModel}</dt>
                <dd>{selectedShot.model_version ?? copy.evidenceNoModel}</dd>
                <dt>{copy.evidenceValidation}</dt>
                <dd>{copy.validation[selectedShot.validation]}</dd>
              </dl>
              <ShotEstimateDrawer
                shot={selectedShot}
                estimate={selectedEstimate}
                jobId={jobId}
                language={language}
                busy={save.phase === "saving"}
                onAccept={(label) => void saveCorrection({ type: "shot_label", frame: selectedShot.frame, shot_type: label })}
              />
              {selectedShot.flags.includes("same_player_twice") ? <p className={styles.notice}>{copy.flagSamePlayer}</p> : null}
              <dl className={styles.facts}>
                <dt>{copy.evidenceHitFrame}</dt>
                <dd>{selectedShot.hit_frame != null ? `${selectedShot.hit_frame} (${formatClock(selectedShot.hit_frame / doc.fps)})` : copy.hitFrameNone}</dd>
              </dl>
              <h5 className={styles.subTitle}>{copy.labelTitle}</h5>
              <div className={styles.actions}>
                <select
                  value={labelType}
                  onChange={(event) => setLabelType(event.target.value as ShotType)}
                  aria-label={copy.labelSave}
                  disabled={save.phase === "saving"}
                >
                  {SHOT_TYPES.map((type) => (
                    <option key={type} value={type}>{copy.shotTypes[type]}</option>
                  ))}
                </select>
                <select
                  value={labelPlayer}
                  onChange={(event) => setLabelPlayer(event.target.value)}
                  aria-label={copy.labelPlayer}
                  disabled={save.phase === "saving"}
                >
                  <option value="">{copy.labelPlayerKeep}</option>
                  {doc.players.map((player) => (
                    <option key={player} value={player}>{player}</option>
                  ))}
                </select>
                <button
                  type="button"
                  className={styles.primaryButton}
                  disabled={save.phase === "saving"}
                  onClick={() => void saveCorrection({ type: "shot_label", frame: selectedShot.frame, shot_type: labelType, ...(labelPlayer ? { player: labelPlayer } : {}) })}
                >
                  {copy.labelSave}
                </button>
                <button
                  type="button"
                  className={styles.ghostButton}
                  disabled={save.phase === "saving"}
                  onClick={() => void saveCorrection({ type: "contact_review", frame: selectedShot.frame, decision: "confirmed" })}
                >
                  {copy.confirmContact}
                </button>
                <button
                  type="button"
                  className={styles.ghostButton}
                  disabled={save.phase === "saving"}
                  onClick={() => void saveCorrection({ type: "contact_review", frame: selectedShot.frame, decision: "rejected" })}
                >
                  {copy.rejectContact}
                </button>
              </div>
              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.ghostButton}
                  disabled={save.phase === "saving"}
                  onClick={() => void saveCorrection({ type: "hit_frame", frame: selectedShot.frame, hit_frame: Math.round(time * doc.fps) })}
                >
                  {copy.setHitFrame}
                </button>
                <button type="button" className={styles.ghostButton} onClick={exportGroundTruth}>
                  {copy.exportGroundTruth}
                </button>
              </div>
              <p className={styles.muted}>{copy.exportHint}</p>
              {save.phase === "saving" ? <p className={styles.muted}>{copy.saving}</p> : null}
              {save.phase === "saved" ? <p className={styles.muted} role="status">{copy.saved}</p> : null}
              {save.phase === "failed" ? <p className={styles.notice} role="alert">{save.message}</p> : null}
            </div>
          ) : null}
        </article>
      </div>


      {doc.annotations.unmatched.length > 0 ? (
        <details className={styles.subPanel}>
          <summary className={styles.subTitle}>{copy.unmatchedTitle} ({doc.annotations.unmatched.length})</summary>
          <p className={styles.muted}>{copy.unmatchedHint}</p>
          <ul className={styles.rallies}>
            {doc.annotations.unmatched.map((item) => (
              <li key={`${item.source_job_id}-${item.correction_id}`}>
                <span>{item.type} · {item.frame !== null ? `${item.frame}` : "–"}{item.player ? ` · ${item.player}` : ""}</span>
                <span className={styles.overlayMeta}>{item.reason}</span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {doc.annotations.transferred.length > 0 ? (
        <p className={styles.muted}>{doc.annotations.transferred.length} {copy.transferredNote}</p>
      ) : null}

      <details className={styles.subPanel}>
        <summary className={styles.subTitle}>{copy.statsTitle}</summary>
        <div className={styles.statGroups}>
          <dl className={styles.facts}>
            <dt className={styles.groupTitle}>{copy.cardContacts}</dt>
            <dd />
            <dt>{copy.statContactsCounted}</dt>
            <dd>{summary.contacts.counted}</dd>
            <dt>{copy.statRejected}</dt>
            <dd>{summary.contacts.rejected}</dd>
            <dt>{copy.statRejectedAuto}</dt>
            <dd>{summary.contacts.rejected_automatic}</dd>
            <dt>{copy.statTurnsWithoutPlayer}</dt>
            <dd>{summary.contacts.turns_without_player}</dd>
            <dt>{copy.statSamePlayer}</dt>
            <dd>{summary.contacts.same_player_twice}</dd>
          </dl>
          <dl className={styles.facts}>
            <dt className={styles.groupTitle}>{copy.statsShots}</dt>
            <dd />
            {SHOT_TYPES.map((type) => (
              <FactRow key={type} label={copy.shotTypes[type]} value={summary.shots.by_type[type] ?? 0} />
            ))}
            <dt>{copy.statLabelled}</dt>
            <dd>{summary.shots.labelled}</dd>
          </dl>
          <dl className={styles.facts}>
            <dt className={styles.groupTitle}>{copy.statsPlayers}</dt>
            <dd />
            {doc.players.map((player) => {
              const item = summary.players[player];
              return (
                <FactRow
                  key={player}
                  label={player}
                  value={`${copy.statHits} ${item?.hits ?? 0} · ${copy.statDistance} ${item?.distance_m !== null && item?.distance_m !== undefined ? `${item.distance_m} m` : copy.statUnavailable} · ${copy.statCoverage} ${percent(item?.coverage)} · ${copy.statConfidence} ${item?.mean_identity_confidence ?? "–"}`}
                />
              );
            })}
          </dl>
          <dl className={styles.facts}>
            <dt className={styles.groupTitle}>{copy.statsAi}</dt>
            <dd />
            <dt>{copy.statModels}</dt>
            <dd>{executedModels.length > 0 ? executedModels.join(", ") : copy.statUnavailable}</dd>
            <dt>{copy.statFps}</dt>
            <dd>{doc.ai.frames_per_second !== null ? `${doc.ai.frames_per_second} fps` : "–"}</dd>
            <dt>{copy.statWall}</dt>
            <dd>{doc.ai.wall_seconds !== null ? `${doc.ai.wall_seconds.toFixed(1)} s` : "–"}</dd>
            <dt>{copy.statFrames}</dt>
            <dd>{doc.ai.frames ?? "–"}</dd>
            <dt>{copy.statShuttle}</dt>
            <dd>{percent(doc.ai.shuttle_detected_ratio)}</dd>
            <dt>{copy.statIdentity}</dt>
            <dd>{doc.ai.identity_coverage ? Object.entries(doc.ai.identity_coverage).map(([key, value]) => `${key} ${percent(value)}`).join(" · ") : "–"}</dd>
            <dt>{copy.statCourt}</dt>
            <dd>{doc.ai.court_status ?? "–"}</dd>
            <dt>{copy.statDevice}</dt>
            <dd>{doc.ai.device ?? "–"}</dd>
          </dl>
        </div>
        <p className={styles.notice}>{TRAJECTORY_COPY[language].disclaimer}</p>
      </details>
    </section>
  );
}

function FactRow({ label, value }: { label: string; value: string | number }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </>
  );
}
