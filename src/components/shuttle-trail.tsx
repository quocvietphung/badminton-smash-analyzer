"use client";

import { useEffect, useMemo, useState } from "react";
import { artifactUrl, fetchJson } from "@/lib/local-ai/client";
import { TRAJECTORY_COPY } from "@/lib/match/trajectory-copy";
import type { StudioLanguage } from "@/lib/studio-types";
import styles from "./match-dashboard.module.css";

type TrajectoryFrame = { frame: number; x: number | null; y: number | null; visible: boolean; refined: boolean; confidence?: number | null };
type TrajectoryFile = { source_width: number; source_height: number; fps: number; frames: TrajectoryFrame[] };

const TRAIL_SECONDS = 1.2;

/**
 * A fading glowing trail of the shuttle's image positions, drawn over the video. It shows TrackNet detections only:
 * interpolated frames and low-confidence points are left out, and the trail is not a flight measurement.
 */
export function ShuttleTrail({
  apiBase,
  jobId,
  frame,
  language,
}: {
  apiBase: string;
  jobId: string;
  frame: number;
  language: StudioLanguage;
}) {
  const copy = TRAJECTORY_COPY[language];
  const [file, setFile] = useState<TrajectoryFile | null>(null);
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    let active = true;
    fetchJson(artifactUrl(apiBase, jobId, "shuttle_trajectory.json"))
      .then((value) => {
        if (active) setFile(value as TrajectoryFile);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [apiBase, jobId]);

  const trail = useMemo(() => {
    if (!file) return null;
    const span = Math.round(TRAIL_SECONDS * file.fps);
    const points: { x: number; y: number; age: number }[] = [];
    for (let f = frame - span; f <= frame; f += 1) {
      const item = file.frames[f];
      if (!item || !item.visible || item.refined || item.x === null || item.y === null) continue;
      if ((item.confidence ?? 0) < 0.5) continue;
      points.push({ x: item.x, y: item.y, age: (frame - f) / span });
    }
    return points;
  }, [file, frame]);

  if (!file || !trail) return null;

  const width = file.source_width;
  const height = file.source_height;
  const head = trail.at(-1);
  const segments = trail.slice(1).map((point, index) => ({ from: trail[index], to: point, opacity: 1 - point.age }));

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

