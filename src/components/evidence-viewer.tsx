"use client";

import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { artifactUrl, formatSeconds, sourceVideoUrl } from "@/lib/local-ai/client";
import { EVIDENCE_COPY } from "@/lib/local-ai/copy";
import {
  courtOutline,
  formatFrameTime,
  frameAtTime,
  hitTestBox,
  identityColour,
  identityCoverage,
  identitySpans,
  indexBoxesByFrame,
  markerEvents,
  statusColour,
  timeAtFrame,
  type IdentityEvent,
  type TrackBox,
} from "@/lib/local-ai/evidence";
import { loadEvidenceBundle, type EvidenceBundle } from "@/lib/local-ai/evidence-data";
import { annotatedTrail, orderedPoints, type ObservedPoint } from "@/lib/match/observed-path";
import type { Observed2DBlock } from "@/lib/match/types";
import { drawOverlay } from "@/lib/local-ai/overlay-draw";
import type { StudioLanguage } from "@/lib/studio-types";
import { CorrectionPanel } from "./correction-panel";
import styles from "./evidence-viewer.module.css";

export type EvidenceMeta = {
  sourceName: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
  mode: string;
  logicalIdentities: number;
  courtStatus: string;
};

type Props = {
  apiBase: string;
  jobId: string;
  language: StudioLanguage;
  meta: EvidenceMeta;
  revision: number;
  onChanged: () => void;
  /** The backend's shared observed-2D track (match document); the trail draws only its points. */
  observed: Observed2DBlock | null;
};

const NO_POINTS: ObservedPoint[] = [];

const NO_BOXES: TrackBox[] = [];

export function EvidenceViewer({ apiBase, jobId, language, meta, revision, onChanged, observed }: Props) {
  const copy = EVIDENCE_COPY[language];
  const [bundle, setBundle] = useState<EvidenceBundle | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [displayWidth, setDisplayWidth] = useState(0);
  const [showOverlay, setShowOverlay] = useState(true);
  const [showOutline, setShowOutline] = useState(true);
  const [showTrail, setShowTrail] = useState(true);
  const [selectedTrackId, setSelectedTrackId] = useState<number | null>(null);
  const [calibrating, setCalibrating] = useState(false);
  const [pendingCorners, setPendingCorners] = useState<Array<[number, number]>>([]);
  const sourceRef = useRef<HTMLVideoElement | null>(null);
  const annotatedRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const timelineRef = useRef<HTMLDivElement | null>(null);

  const fps = meta.fps > 0 ? meta.fps : 30;
  const totalFrames = Math.max(1, meta.frames);
  const identityKeys = Array.from({ length: Math.max(1, meta.logicalIdentities) }, (_, index) => `P${index + 1}`);
  const sourceUrl = sourceVideoUrl(apiBase, jobId);
  const annotatedUrl = artifactUrl(apiBase, jobId, "annotated.mp4");

  useEffect(() => {
    let cancelled = false;
    loadEvidenceBundle(apiBase, jobId).then(
      (loaded) => {
        if (cancelled) return;
        setBundle(loaded);
        setLoadFailed(false);
      },
      () => {
        if (!cancelled) setLoadFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [apiBase, jobId, revision]);

  useEffect(() => {
    const video = sourceRef.current;
    if (!video) return;
    const update = () => setDisplayWidth(video.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(video);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!playing) return;
    let handle = 0;
    const tick = () => {
      const video = sourceRef.current;
      if (video) setCurrentFrame(frameAtTime(video.currentTime, fps, totalFrames));
      handle = window.requestAnimationFrame(tick);
    };
    handle = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(handle);
  }, [playing, fps, totalFrames]);

  const boxIndex = useMemo(
    () => (bundle?.tracks ? indexBoxesByFrame(bundle.tracks.tracks) : new Map<number, TrackBox[]>()),
    [bundle],
  );
  const boxesNow = useMemo(() => boxIndex.get(currentFrame) ?? NO_BOXES, [boxIndex, currentFrame]);
  const outline = useMemo(() => courtOutline(bundle?.court?.homography_image_from_court ?? null), [bundle]);
  const observedPoints = useMemo(() => (observed ? orderedPoints(observed) : NO_POINTS), [observed]);
  const shuttle = useMemo(() => annotatedTrail(observedPoints, currentFrame, 8), [observedPoints, currentFrame]);
  const copyStatus = copy.statusLabels;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || displayWidth <= 0 || meta.width <= 0) return;
    const scale = displayWidth / meta.width;
    const height = Math.round(meta.height * scale);
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(displayWidth * ratio);
    canvas.height = Math.round(height * ratio);
    canvas.style.width = `${displayWidth}px`;
    canvas.style.height = `${height}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    if (!showOverlay) {
      ctx.clearRect(0, 0, displayWidth, height);
      return;
    }
    drawOverlay(ctx, {
      scale,
      boxes: boxesNow,
      selectedTrackId,
      trail: shuttle.trail,
      shuttle: shuttle.current,
      outline,
      pendingCorners: calibrating ? pendingCorners : [],
      showOutline,
      showTrail,
      labelFor: (box) => `${box.identity ?? `ID ${box.trackId}`} · ${box.status ? copyStatus[box.status] ?? box.status : ""}`.trim(),
    });
  }, [displayWidth, meta.width, meta.height, boxesNow, selectedTrackId, shuttle, outline, pendingCorners, calibrating, showOverlay, showOutline, showTrail, copyStatus]);

  function pauseBoth() {
    sourceRef.current?.pause();
    annotatedRef.current?.pause();
  }

  function togglePlay() {
    const source = sourceRef.current;
    const annotated = annotatedRef.current;
    if (!source) return;
    if (source.paused) {
      if (annotated) annotated.currentTime = source.currentTime;
      void source.play().catch(() => undefined);
      void annotated?.play().catch(() => undefined);
    } else {
      pauseBoth();
    }
  }

  function seekToFrame(frame: number) {
    const clamped = Math.min(totalFrames - 1, Math.max(0, frame));
    const seconds = timeAtFrame(clamped, fps);
    for (const video of [sourceRef.current, annotatedRef.current]) {
      if (video) video.currentTime = seconds;
    }
    setCurrentFrame(clamped);
  }

  function stepFrames(delta: number) {
    pauseBoth();
    seekToFrame(currentFrame + delta);
  }

  function onSourceTimeUpdate() {
    const source = sourceRef.current;
    const annotated = annotatedRef.current;
    if (!source) return;
    setCurrentFrame(frameAtTime(source.currentTime, fps, totalFrames));
    if (annotated && Math.abs(annotated.currentTime - source.currentTime) > 0.15) {
      annotated.currentTime = source.currentTime;
    }
  }

  function onTimelineClick(event: ReactMouseEvent<HTMLDivElement>) {
    const bar = timelineRef.current;
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    pauseBoth();
    seekToFrame(Math.round(fraction * (totalFrames - 1)));
  }

  function onCanvasClick(event: ReactMouseEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas || meta.width <= 0) return;
    pauseBoth();
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * meta.width;
    const y = ((event.clientY - rect.top) / rect.height) * meta.height;
    if (calibrating) {
      setPendingCorners((current) => (current.length < 4 ? [...current, [x, y]] : current));
      return;
    }
    const hit = hitTestBox(boxesNow, x, y);
    setSelectedTrackId(hit ? hit.trackId : null);
  }

  function seekToEvent(event: IdentityEvent) {
    pauseBoth();
    seekToFrame(event.frame);
  }

  const events = useMemo(
    () => [...(bundle?.events?.events ?? [])].sort((a, b) => a.frame - b.frame),
    [bundle],
  );
  const markers = markerEvents(events);
  const selectedBox = boxesNow.find((box) => box.trackId === selectedTrackId) ?? null;
  const calibrated = bundle?.court?.status === "calibrated";
  const trackCount = bundle?.tracks?.tracks.length ?? null;

  function pct(value: number | null): string {
    return value === null ? copy.unavailable : `${Math.round(value * 100)} %`;
  }

  return (
    <section className={styles.evidence} aria-labelledby="evidence-title">
      <header className={styles.header}>
        <h3 id="evidence-title">{copy.evidenceTitle}</h3>
        <p className={styles.muted}>{copy.evidenceIntro}</p>
      </header>
      {bundle === null ? <p className={styles.muted}>{loadFailed ? copy.evidenceError : copy.loadingEvidence}</p> : null}
      {bundle && bundle.missing.length > 0 ? <p className={styles.noticeError}>{copy.evidenceError}</p> : null}

      <div className={styles.videos}>
        <figure className={styles.videoCard}>
          <figcaption className={styles.caption}>
            {copy.originalVideo} · {meta.sourceName}
          </figcaption>
          <div className={styles.stage}>
            <video
              ref={sourceRef}
              src={sourceUrl}
              className={styles.video}
              muted
              playsInline
              preload="metadata"
              onPlay={() => setPlaying(true)}
              onPause={() => setPlaying(false)}
              onTimeUpdate={onSourceTimeUpdate}
              onSeeked={onSourceTimeUpdate}
            />
            <canvas
              ref={canvasRef}
              className={styles.overlay}
              onClick={onCanvasClick}
              style={{ pointerEvents: showOverlay || calibrating ? "auto" : "none" }}
              aria-label={copy.originalVideo}
            />
          </div>
        </figure>
        <figure className={styles.videoCard}>
          <figcaption className={styles.caption}>{copy.annotatedVideo}</figcaption>
          <div className={styles.stage}>
            <video ref={annotatedRef} src={annotatedUrl} className={styles.video} playsInline preload="metadata" />
          </div>
        </figure>
      </div>

      <div className={styles.transport}>
        <button type="button" className={styles.iconButton} onClick={() => stepFrames(-1)} aria-label="-1 frame">
          <SkipBack size={16} aria-hidden />
        </button>
        <button type="button" className={styles.primaryButton} onClick={togglePlay}>
          {playing ? <Pause size={16} aria-hidden /> : <Play size={16} aria-hidden />}
        </button>
        <button type="button" className={styles.iconButton} onClick={() => stepFrames(1)} aria-label="+1 frame">
          <SkipForward size={16} aria-hidden />
        </button>
        <span className={styles.readout}>{formatFrameTime(currentFrame, fps)}</span>
        <span className={styles.muted}>{copy.syncNote}</span>
      </div>

      <div className={styles.toggles}>
        <label className={styles.check}>
          <input type="checkbox" checked={showOverlay} onChange={(event) => setShowOverlay(event.target.checked)} />
          {copy.overlayToggle}
        </label>
        <label className={styles.check}>
          <input type="checkbox" checked={showOutline} onChange={(event) => setShowOutline(event.target.checked)} />
          {copy.courtOutline}
        </label>
        <label className={styles.check}>
          <input type="checkbox" checked={showTrail} onChange={(event) => setShowTrail(event.target.checked)} />
          {copy.shuttleTrail}
        </label>
      </div>
      {!calibrated ? <p className={styles.notice}>{copy.noCourt}</p> : null}

      <h4 className={styles.subTitle}>{copy.timelineTitle}</h4>
      <div className={styles.timelineWrap}>
        <div ref={timelineRef} className={styles.timeline} onClick={onTimelineClick} role="presentation">
          {identityKeys.map((key, laneIndex) => {
            const spans = identitySpans(bundle?.events?.segments[key] ?? [], totalFrames);
            return (
              <div key={key} className={styles.lane} style={{ top: `${6 + laneIndex * 14}px` }}>
                {spans.map((span, spanIndex) => (
                  <span
                    key={`${key}-${spanIndex}`}
                    className={styles.laneSpan}
                    style={{
                      left: `${span.startFraction * 100}%`,
                      width: `${Math.max(0.2, (span.endFraction - span.startFraction) * 100)}%`,
                      background: statusColour(span.status),
                    }}
                    title={`${key} · ${copyStatus[span.status] ?? span.status}`}
                  />
                ))}
              </div>
            );
          })}
          {markers.map((event, index) => (
            <button
              key={`marker-${index}-${event.frame}-${event.kind}`}
              type="button"
              className={styles.marker}
              style={{ left: `${(event.frame / totalFrames) * 100}%`, background: identityColour(event.identity) }}
              title={copy.kindLabels[event.kind] ?? event.kind}
              onClick={(clickEvent) => {
                clickEvent.stopPropagation();
                seekToEvent(event);
              }}
              aria-label={copy.kindLabels[event.kind] ?? event.kind}
            />
          ))}
          <span className={styles.playhead} style={{ left: `${(currentFrame / totalFrames) * 100}%` }} />
        </div>
        <div className={styles.laneLabels}>
          {identityKeys.map((key) => (
            <span key={key} className={styles.laneLabel} style={{ color: identityColour(key) }}>
              {key}
            </span>
          ))}
        </div>
      </div>
      <p className={styles.muted}>{copy.timelineHint}</p>

      <div className={styles.statGrid}>
        {identityKeys.map((key) => (
          <div key={key} className={styles.stat}>
            <span className={styles.statLabel} style={{ color: identityColour(key) }}>
              {key} · {copy.coverage}
            </span>
            <strong>{pct(identityCoverage(bundle?.events?.segments[key] ?? [], totalFrames))}</strong>
          </div>
        ))}
        <div className={styles.stat}>
          <span className={styles.statLabel}>{copy.trackerIds}</span>
          <strong>{trackCount ?? copy.unavailable}</strong>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>{copy.logicalPlayers}</span>
          <strong>{meta.logicalIdentities}</strong>
        </div>
      </div>

      <h4 className={styles.subTitle}>{copy.eventsTitle}</h4>
      {events.length === 0 ? (
        <p className={styles.muted}>{copy.eventsEmpty}</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <tbody>
              {events.map((event, index) => (
                <tr key={`event-${index}-${event.frame}`}>
                  <td>{formatSeconds(event.time_s)}</td>
                  <td>{copy.kindLabels[event.kind] ?? event.kind}</td>
                  <td style={{ color: identityColour(event.identity) }}>{event.identity}</td>
                  <td>{event.track_id ?? "–"}</td>
                  <td>
                    <button type="button" className={styles.ghostButton} onClick={() => seekToEvent(event)}>
                      {copy.seekEvent} {formatSeconds(event.time_s)}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h4 className={styles.subTitle}>{copy.shotTitle}</h4>
      <p className={styles.noticeNeutral}>{copy.shotNotice}</p>

      {bundle ? (
        <CorrectionPanel
          apiBase={apiBase}
          jobId={jobId}
          language={language}
          players={Math.max(1, meta.logicalIdentities)}
          mode={meta.mode}
          totalFrames={totalFrames}
          fps={fps}
          currentFrame={currentFrame}
          selectedBox={selectedBox}
          calibrating={calibrating}
          pendingCorners={pendingCorners}
          corrections={bundle.corrections}
          onStartCalibration={() => setCalibrating(true)}
          onStopCalibration={() => setCalibrating(false)}
          onClearCorners={() => setPendingCorners([])}
          onSaved={() => {
            setSelectedTrackId(null);
            onChanged();
          }}
        />
      ) : null}
    </section>
  );
}
