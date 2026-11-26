"use client";

import { useMemo, useState } from "react";
import { TRAJECTORY_COPY } from "@/lib/match/trajectory-copy";
import type { Observed2DBlock } from "@/lib/match/types";
import type { StudioLanguage } from "@/lib/studio-types";
import styles from "./match-dashboard.module.css";

const TRAIL_SECONDS = 1.2;

/**
 * A fading glowing trail of the shuttle's image positions, drawn over the video. It shows the TrackNet detections the
 * backend's observed-2d check kept: InpaintNet fills and removed tracker jumps are left out, the line breaks where the
 * backend's run breaks, and the trail is not a flight measurement.
 */
export function ShuttleTrail({
  observed,
  frame,
  language,
}: {
  observed: Observed2DBlock | null;
  frame: number;
  language: StudioLanguage;
}) {
  const copy = TRAJECTORY_COPY[language];
  const [enabled, setEnabled] = useState(true);
  const byFrame = useMemo(() => new Map((observed?.points ?? []).map((point) => [point[0], point])), [observed]);

  const trail = useMemo(() => {
    if (!observed) return null;
    const span = Math.round(TRAIL_SECONDS * (observed.fps || 30));
    const points: { x: number; y: number; age: number; segment: number }[] = [];
    for (let f = frame - span; f <= frame; f += 1) {
      const item = byFrame.get(f);
      if (!item || item[3] !== "d") continue;
      points.push({ x: item[1], y: item[2], age: (frame - f) / span, segment: item[4] });
    }
    return points;
  }, [observed, byFrame, frame]);

  if (!observed || !trail) return null;

  const [width, height] = observed.frame_size;
  const head = trail.at(-1);
  const segments = trail
    .slice(1)
    .map((point, index) => ({ from: trail[index], to: point, opacity: 1 - point.age }))
    .filter((segment) => segment.from.segment === segment.to.segment);

  return (
    <>
      <button type="button" className={styles.trailToggle} onClick={() => setEnabled((value) => !value)} aria-pressed={enabled}>
        {enabled ? copy.trailOff : copy.trailTitle}
      </button>
      {enabled && trail.length > 1 ? (
        <svg
          className={styles.trailSvg}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="xMidYMid meet"
          aria-label={copy.trailTitle}
          role="img"
        >
          <title>{`${copy.trailTitle}: ${copy.trailNote}`}</title>
          <defs>
            <filter id="trail-glow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur stdDeviation="4" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>
          <g filter="url(#trail-glow)" fill="none" strokeLinecap="round">
            {segments.map((segment, index) => (
              <line
                key={index}
                x1={segment.from.x}
                y1={segment.from.y}
                x2={segment.to.x}
                y2={segment.to.y}
                stroke="#6ee9c3"
                strokeOpacity={Math.max(0.05, segment.opacity)}
                strokeWidth={2 + 10 * segment.opacity}
              />
            ))}
          </g>
          {head ? (
            <circle cx={head.x} cy={head.y} r={Math.max(6, width / 240)} fill="#e9fff8" stroke="#6ee9c3" strokeWidth={3} />
          ) : null}
        </svg>
      ) : null}
    </>
  );
}
