"use client";

import type { MatchCopy } from "@/lib/match/copy";
import { courtLines, courtToView } from "@/lib/match/analytics";
import { TRAJECTORY_COPY } from "@/lib/match/trajectory-copy";
import type { MatchShot, TrajectoryEstimate, TrajectoryPoint } from "@/lib/match/types";
import type { StudioLanguage } from "@/lib/studio-types";
import styles from "./match-dashboard.module.css";

export const SIX_CLASSES = ["smash", "clear", "drop", "drive", "net_shot", "lift"] as const;

/** A person's stroke label when they chose one of the six classes; otherwise the trajectory estimate. */
function personStroke(shot: MatchShot): string | null {
  const manual = shot.validation === "manual" || shot.type_source === "manual";
  return manual && (SIX_CLASSES as readonly string[]).includes(shot.type) ? shot.type : null;
}

export function estimateLabel(shot: MatchShot, estimate: TrajectoryEstimate | undefined): string | null {
  const stroke = personStroke(shot);
  if (stroke) return stroke;
  return estimate ? estimate.best_guess_label : null;
}

/** A line of the timeline: the label, the badge tone and the text of the badge. Never "Unknown" for a contact. */
export function estimateBadge(shot: MatchShot, estimate: TrajectoryEstimate | undefined, language: StudioLanguage) {
  const copy = TRAJECTORY_COPY[language];
  if (personStroke(shot)) return { tone: "manual", text: copy.manual };
  if (!estimate) return { tone: "pending", text: copy.notBuilt };
  return { tone: "estimate", text: copy.badgeShort };
}

function tierText(tier: TrajectoryEstimate["evidence_tier"], language: StudioLanguage): string {
  const copy = TRAJECTORY_COPY[language];
  return tier === "full_trajectory" ? copy.tierFull : tier === "partial_trajectory" ? copy.tierPartial : copy.tierFallback;
}

export function qualityText(quality: TrajectoryEstimate["evidence_quality"], language: StudioLanguage): string {
  const copy = TRAJECTORY_COPY[language];
  return quality === "high" ? copy.qualityHigh : quality === "medium" ? copy.qualityMedium : copy.qualityLow;
}

function directionText(value: unknown, language: StudioLanguage): string {
  const copy = TRAJECTORY_COPY[language];
  if (typeof value !== "string" || value === "none") return copy.unavailable;
  const words = value.split("-").map((part) => (part === "up" ? copy.dirUp : part === "down" ? copy.dirDown : part === "left" ? copy.dirLeft : part === "right" ? copy.dirRight : part === "level" ? copy.dirLevel : part));
  return words.join(" · ");
}

export function num(value: unknown, digits = 0): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "–";
}

/** The shuttle path around the contact, in image pixels. Interpolated points are hollow; the contact is marked. */
export function TrajectoryMiniChart({ estimate, language }: { estimate: TrajectoryEstimate; language: StudioLanguage }) {
  const copy = TRAJECTORY_COPY[language];
  const [width, height] = estimate.frame_size;
  const all = [...estimate.trajectory_before, ...estimate.trajectory_after];
  const contact = estimate.contact_image;
  if (all.length === 0 || contact.x_px === null || contact.y_px === null) {
    return <p className={styles.muted}>{copy.unavailable}</p>;
  }
  const xs = all.map((p) => p.x_px).concat(contact.x_px);
  const ys = all.map((p) => p.y_px).concat(contact.y_px);
  const pad = 30;
  const minX = Math.max(0, Math.min(...xs) - pad);
  const maxX = Math.min(width, Math.max(...xs) + pad);
  const minY = Math.max(0, Math.min(...ys) - pad);
  const maxY = Math.min(height, Math.max(...ys) + pad);
  const before = estimate.trajectory_before;
  const after = estimate.trajectory_after;
  const line = (points: TrajectoryPoint[]) => points.map((p) => `${p.x_px},${p.y_px}`).join(" ");
  return (
    <figure className={styles.miniChart}>
      <figcaption className={styles.muted}>{copy.miniChart}</figcaption>
      <svg viewBox={`${minX} ${minY} ${Math.max(1, maxX - minX)} ${Math.max(1, maxY - minY)}`} role="img" aria-label={copy.miniChart}>
        <polyline points={line(before)} fill="none" stroke="#8aa7a0" strokeWidth={Math.max(2, (maxX - minX) / 160)} strokeDasharray="6 4" />
        <polyline points={line(after)} fill="none" stroke="#6ee9c3" strokeWidth={Math.max(2.5, (maxX - minX) / 140)} strokeLinecap="round" />
        {all.filter((p) => p.interpolated).map((p) => (
          <circle key={`i-${p.frame}`} cx={p.x_px} cy={p.y_px} r={Math.max(3, (maxX - minX) / 120)} fill="none" stroke="#e6b450" strokeWidth={1.5} />
        ))}
        <circle cx={contact.x_px} cy={contact.y_px} r={Math.max(6, (maxX - minX) / 60)} fill="#ffffff" stroke="#6ee9c3" strokeWidth={3} />
      </svg>
      <p className={styles.muted}>
        <span className={styles.legendDashed} /> {copy.before} · <span className={styles.legendSolid} /> {copy.after} · ◯ {copy.contact}
      </p>
    </figure>
  );
}

/** Court map at the contact frame: the floor lines and the player's foot. The shuttle is not drawn on the floor. */
export function CourtContextMap({ estimate, view, language }: { estimate: TrajectoryEstimate; view: { width: number; height: number; padding: number }; language: StudioLanguage }) {
  const copy = TRAJECTORY_COPY[language];
  const ctx = estimate.player_court_context;
  if (!ctx.court_calibrated || ctx.player_foot_x_m === null || ctx.player_foot_y_m === null) {
    return <p className={styles.muted}>{copy.unavailable}</p>;
  }
  const foot = courtToView(ctx.player_foot_x_m, ctx.player_foot_y_m, view);
  return (
    <figure className={styles.courtContext}>
      <figcaption className={styles.muted}>{copy.courtMap}</figcaption>
      <svg viewBox={`0 0 ${view.width} ${view.height}`} role="img" aria-label={copy.courtMap}>
        {courtLines().map((line, index) => {
          const a = courtToView(line.x1, line.y1, view);
          const b = courtToView(line.x2, line.y2, view);
          return <line key={index} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#4c6b64" strokeWidth={1.5} />;
        })}
        <circle cx={foot.x} cy={foot.y} r={7} fill="#6ee9c3" stroke="#0b1c1e" strokeWidth={2} />
      </svg>
      <p className={styles.muted}>
        {copy.playerFoot}: {ctx.player_side === "near" ? copy.sideNear : ctx.player_side === "far" ? copy.sideFar : copy.unavailable}
        {ctx.relative_to_net ? ` · ${ctx.relative_to_net === "front_court" ? copy.relFront : ctx.relative_to_net === "mid_court" ? copy.relMid : copy.relBack}` : ""}
      </p>
    </figure>
  );
}

/** Floor-plane view used for the court context map (proportions follow the 13.40 m x 6.10 m doubles court). */
export const COURT_VIEW = { width: 240, height: 520, padding: 12 };

/** The drawer for one contact. Nothing here changes the timeline or the statistics. */
export function ShotEstimateDrawer({
  shot,
  estimate,
  jobId,
  language,
  busy,
  onAccept,
}: {
  shot: MatchShot;
  estimate: TrajectoryEstimate | undefined;
  jobId: string;
  language: StudioLanguage;
  busy: boolean;
  onAccept: (label: string) => void;
}) {
  const copy = TRAJECTORY_COPY[language];
  if (!estimate) return <p className={styles.muted}>{copy.noRecord}</p>;
  const f = estimate.features;
  const rows = [...estimate.top3];
  const scores = Object.entries(estimate.scores).sort((a, b) => b[1] - a[1]);
  const manual = shot.validation === "manual" || shot.type_source === "manual";
  return (
    <section className={styles.estimateBox} aria-label={copy.badge}>
      <p className={styles.notice}>{copy.disclaimer}</p>
      <div className={styles.estimateHead}>
        <span className={styles.labelChip} data-label={estimate.best_guess_label}>{estimate.best_guess_label}</span>
        <span className={styles.badge} data-tone="estimate">{copy.badge}</span>
        <span className={styles.badge} data-tone={estimate.review_status === "accepted_by_gate" ? "estimate" : "review"}>
          {estimate.review_status === "accepted_by_gate" ? copy.passedGates : copy.needsReview}
        </span>
      </div>
      <div className={styles.twoUp}>
        <TrajectoryMiniChart estimate={estimate} language={language} />
        <CourtContextMap estimate={estimate} view={COURT_VIEW} language={language} />
      </div>
      <dl className={styles.facts}>
        <dt>{copy.top3}</dt>
        <dd>{rows.map(([label, value]) => `${label} ${value.toFixed(2)}`).join(" · ")}</dd>
        <dt>{copy.scores}</dt>
        <dd>{scores.map(([label, value]) => `${label} ${value.toFixed(2)}`).join(" · ")}</dd>
        <dt>{copy.speedBefore}</dt>
        <dd>{`${num(f.speed_before_median_px_s)} / ${num(f.speed_before_max_px_s)} ${copy.pxs}`}</dd>
        <dt>{copy.speedAfter}</dt>
        <dd>{`${num(f.speed_after_median_px_s)} / ${num(f.speed_after_max_px_s)} ${copy.pxs}`}</dd>
        <dt>{copy.change}</dt>
        <dd>{num(f.speed_change_ratio, 2)}</dd>
        <dt>{copy.direction}</dt>
        <dd>{directionText(f.initial_direction, language)}</dd>
        <dt>{copy.curvature}</dt>
        <dd>{num(f.trajectory_curvature, 3)}</dd>
        <dt>{copy.apex}</dt>
        <dd>{f.apex_time_s === null || f.apex_time_s === undefined ? copy.unavailable : `${copy.apexAt} ${num(f.apex_time_s, 2)} ${copy.seconds}`}</dd>
        <dt>{copy.flight}</dt>
        <dd>{`${num(f.observed_flight_s, 2)} ${copy.seconds}${f.flight_truncated_by_window ? " (≥)" : ""}`}</dd>
        <dt>{copy.length}</dt>
        <dd>{num(f.length_norm, 3)}</dd>
        <dt>{copy.tier}</dt>
        <dd>{tierText(estimate.evidence_tier, language)}</dd>
        <dt>{copy.quality}</dt>
        <dd>{qualityText(estimate.evidence_quality, language)}</dd>
        <dt>{copy.missing}</dt>
        <dd>{estimate.missing_features.length > 0 ? estimate.missing_features.join(", ") : copy.noMissing}</dd>
        <dt>{copy.whyBest}</dt>
        <dd>{`${estimate.best_guess_label} ${estimate.top3[0][1].toFixed(2)} · ${estimate.top3.slice(1).map(([l]) => l).join(", ")}`}</dd>
        {estimate.review_reasons.length > 0 ? (
          <>
            <dt>{copy.whyReview}</dt>
            <dd>{estimate.review_reasons.join("; ")}</dd>
          </>
        ) : null}
        {estimate.quality_warnings.length > 0 ? (
          <>
            <dt>{copy.warnings}</dt>
            <dd>{estimate.quality_warnings.join("; ")}</dd>
          </>
        ) : null}
        <dt>{copy.job}</dt>
        <dd>{jobId}</dd>
        <dt>{copy.run}</dt>
        <dd>{estimate.run_id}</dd>
        <dt>{copy.rule}</dt>
        <dd>{estimate.rule_version}</dd>
      </dl>
      {manual ? <p className={styles.muted}>{copy.manual}: {shot.type}</p> : null}
      <div className={styles.actions}>
        <button type="button" className={styles.primaryButton} disabled={busy} onClick={() => onAccept(estimate.best_guess_label)}>
          {copy.accept}
        </button>
      </div>
      <p className={styles.muted}>{copy.acceptNote}</p>
    </section>
  );
}

export function DatasetExport({ href, language }: { href: string; language: StudioLanguage }) {
  const copy = TRAJECTORY_COPY[language];
  return (
    <p className={styles.exportRow}>
      <a className={styles.ghostButton} href={href} download>{copy.exportLabel}</a>
      <span className={styles.muted}>{copy.exportNote}</span>
    </p>
  );
}

export function labelCopy(label: string, copy: MatchCopy): string {
  return (SIX_CLASSES as readonly string[]).includes(label) ? copy.shotTypes[label as keyof MatchCopy["shotTypes"]] : copy.shotTypes.unknown;
}
