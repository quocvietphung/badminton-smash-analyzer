"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { StudioLanguage } from "@/lib/studio-types";
import type { MatchDocument, MatchShot, TrajectoryEstimate } from "@/lib/match/types";
import { apiUrl, artifactUrl, fetchJson } from "@/lib/local-ai/client";
import { useSelectedShotId } from "@/lib/match/shot-selection";
import ShotTrajectory from "./shot-trajectory";
import { findRecordForShot, shuttleMapFrom, type ShuttleObservation } from "@/lib/match/shot-trajectory";
import { contactDots, distanceView, playerRows, pxPerSecond, shotLabel, speedPanel, type DistanceView, type SixClass } from "@/lib/match/dashboard-view";
import styles from "./broadcast-dashboard.module.css";

type ShotClass = SixClass;

const CLASS_COLOUR: Record<ShotClass, string> = {
  smash: "#ff6b6b",
  clear: "#4dabf7",
  drop: "#ffd43b",
  drive: "#69db7c",
  net_shot: "#b197fc",
  lift: "#ffa94d",
};

// Player colours follow the dashboard palette: blue for the first player, gold for the second.
const PLAYER_COLOUR = ["var(--bd-p1)", "var(--bd-p2)", "var(--bd-p3)", "var(--bd-p4)"];

// Every number on this board comes from the backend match document (its dashboard block and timeline rows): the same
// sanitized observed-2d track and the same formulas as the dataset. Nothing is recomputed in the browser.

type Copy = {
  videoTitle: string;
  done: string;
  candidates: (count: number) => string;
  annotated: string;
  original: string;
  playersTitle: string;
  wholeClip: string;
  mHits: string;
  mConfirmed: string;
  mMax: string;
  mAvg: string;
  mDistM: string;
  mDistPx: string;
  mTop: string;
  estimateBadge: string;
  none: string;
  positionsTitle: string;
  heatTitle: string;
  heatNote: string;
  heatEmpty: string;
  contactsTitle: string;
  contactsCourt: string;
  contactsImage: string;
  heatCourt: string;
  heatImage: string;
  imageSpace: string;
  courtSpace: string;
  selectedLegend: string;
  statSpeeds: string;
  statRally: string;
  statAvgSpeed: string;
  statInterval: string;
  candidateNote: (count: number) => string;
  cumTitle: string;
  cumUnitM: string;
  cumUnitPx: string;
  cumEmpty: string;
  speedTitle: string;
  colTime: string;
  colShot: string;
  colType: string;
  colStatus: string;
  statusConfirmed: string;
  statusCandidate: string;
  colFrame: string;
  speedNote: string;
  loading: string;
  classes: Record<ShotClass, string>;
};

const COPY: Record<StudioLanguage, Copy> = {
  en: {
    videoTitle: "AI annotated video",
    done: "Completed",
    candidates: (count) => `${count} contact candidates`,
    annotated: "Annotated",
    original: "Original",
    playersTitle: "Players at a glance",
    wholeClip: "Whole clip · candidates",
    mHits: "Contacts (all candidates)",
    mConfirmed: "Confirmed contacts",
    mMax: "Top image-space speed (px/s · confirmed)",
    mAvg: "Avg image-space speed (px/s · confirmed)",
    mDistM: "Distance (m, floor)",
    mDistPx: "Distance (px, image)",
    mTop: "Most frequent shot",
    estimateBadge: "Trajectory estimate · unverified",
    none: "–",
    positionsTitle: "Positions and contacts",
    heatTitle: "Occupancy",
    heatNote: "Brighter means more time spent there.",
    heatEmpty: "No occupancy data for this analysis.",
    contactsTitle: "Contact positions",
    contactsCourt: "Player position at the contact · floor metres",
    contactsImage: "Shuttle at the contact · image position",
    heatCourt: "Feet · floor metres",
    heatImage: "Feet · image position",
    imageSpace: "image position",
    courtSpace: "floor metres (players' feet)",
    selectedLegend: "selected contact",
    statSpeeds: "Official speed records (confirmed)",
    statRally: "Avg rally length (candidate)",
    statAvgSpeed: "Avg image-space speed (px/s · confirmed)",
    statInterval: "Avg shot interval (within rallies)",
    candidateNote: (count) => `${count} candidate speeds are listed below; they are not part of the official statistics.`,
    cumTitle: "Distance covered",
    cumUnitM: "m, court",
    cumUnitPx: "px, image",
    cumEmpty: "Not enough tracked points yet.",
    speedTitle: "Shot speed monitor",
    colTime: "Time",
    colShot: "Image-space speed (px/s)",
    colType: "Type · trajectory estimate",
    colStatus: "Contact",
    statusConfirmed: "confirmed",
    statusCandidate: "candidate",
    colFrame: "Frame",
    speedNote: "Image-space speeds in px/s from valid TrackNet steps only, never km/h. Official statistics use confirmed contacts only. Types are trajectory estimates · unverified. – means unavailable.",
    loading: "Loading…",
    classes: { smash: "Smash", clear: "Clear", drop: "Drop", drive: "Drive", net_shot: "Net shot", lift: "Lift" },
  },
  vi: {
    videoTitle: "Video đã chú thích bằng AI",
    done: "Hoàn tất",
    candidates: (count) => `${count} ứng viên chạm cầu`,
    annotated: "Chú thích",
    original: "Gốc",
    playersTitle: "Người chơi nhìn nhanh",
    wholeClip: "Toàn bộ clip · ứng viên",
    mHits: "Số lần chạm (mọi ứng viên)",
    mConfirmed: "Lần chạm đã xác nhận",
    mMax: "Tốc độ trên ảnh cao nhất (px/s · đã xác nhận)",
    mAvg: "Tốc độ trên ảnh TB (px/s · đã xác nhận)",
    mDistM: "Quãng đường (m, mặt sân)",
    mDistPx: "Quãng đường (px, trên ảnh)",
    mTop: "Cú thường gặp nhất",
    estimateBadge: "Ước lượng từ quỹ đạo · chưa kiểm chứng",
    none: "–",
    positionsTitle: "Vị trí và điểm chạm",
    heatTitle: "Vùng hoạt động",
    heatNote: "Càng sáng nghĩa là người chơi ở đó càng lâu.",
    heatEmpty: "Phân tích này không có dữ liệu vùng hoạt động.",
    contactsTitle: "Vị trí chạm cầu",
    contactsCourt: "Vị trí người đánh lúc chạm · mét trên mặt sân",
    contactsImage: "Quả cầu lúc chạm · vị trí trên ảnh",
    heatCourt: "Chân người chơi · mét trên mặt sân",
    heatImage: "Chân người chơi · vị trí trên ảnh",
    imageSpace: "vị trí trên ảnh",
    courtSpace: "mét trên mặt sân (chân người chơi)",
    selectedLegend: "lần chạm đang chọn",
    statSpeeds: "Số ghi nhận tốc độ chính thức (đã xác nhận)",
    statRally: "Pha bóng TB (ứng viên)",
    statAvgSpeed: "Tốc độ trên ảnh TB (px/s · đã xác nhận)",
    statInterval: "Khoảng cách TB giữa các cú (trong pha bóng)",
    candidateNote: (count) => `${count} tốc độ của ứng viên được liệt kê bên dưới; chúng không thuộc thống kê chính thức.`,
    cumTitle: "Quãng đường tích lũy",
    cumUnitM: "m, trên sân",
    cumUnitPx: "px, trên ảnh",
    cumEmpty: "Chưa đủ điểm theo dõi.",
    speedTitle: "Theo dõi tốc độ cầu",
    colTime: "Thời gian",
    colShot: "Tốc độ trên ảnh (px/s)",
    colType: "Loại · ước lượng từ quỹ đạo",
    colStatus: "Chạm",
    statusConfirmed: "đã xác nhận",
    statusCandidate: "ứng viên",
    colFrame: "Khung",
    speedNote: "Tốc độ trên ảnh tính bằng px/s, chỉ từ các bước TrackNet hợp lệ, không bao giờ là km/h. Thống kê chính thức chỉ dùng lần chạm đã xác nhận. Loại cú là ước lượng từ quỹ đạo · chưa kiểm chứng. – nghĩa là không có.",
    loading: "Đang tải…",
    classes: { smash: "Đập cầu", clear: "Cầu cao sâu", drop: "Cầu thả", drive: "Cầu đẩy", net_shot: "Cầu lưới", lift: "Cầu nâng" },
  },
  de: {
    videoTitle: "KI-annotiertes Video",
    done: "Abgeschlossen",
    candidates: (count) => `${count} Schlagkandidaten`,
    annotated: "Annotiert",
    original: "Original",
    playersTitle: "Spieler im Überblick",
    wholeClip: "Gesamter Clip · Kandidaten",
    mHits: "Schläge (alle Kandidaten)",
    mConfirmed: "Bestätigte Schläge",
    mMax: "Höchste Bildgeschwindigkeit (px/s · bestätigt)",
    mAvg: "Ø Bildgeschwindigkeit (px/s · bestätigt)",
    mDistM: "Strecke (m, Boden)",
    mDistPx: "Strecke (px, Bild)",
    mTop: "Häufigster Schlag",
    estimateBadge: "Flugbahn-Schätzung · nicht verifiziert",
    none: "–",
    positionsTitle: "Positionen und Schläge",
    heatTitle: "Aufenthalt",
    heatNote: "Heller heißt: länger dort gewesen.",
    heatEmpty: "Keine Aufenthaltsdaten in dieser Analyse.",
    contactsTitle: "Schlagpositionen",
    contactsCourt: "Spielerposition beim Schlag · Bodenmeter",
    contactsImage: "Federball beim Schlag · Bildposition",
    heatCourt: "Füße · Bodenmeter",
    heatImage: "Füße · Bildposition",
    imageSpace: "Bildposition",
    courtSpace: "Bodenmeter (Füße der Spieler)",
    selectedLegend: "gewählter Schlag",
    statSpeeds: "Offizielle Tempo-Werte (bestätigt)",
    statRally: "Ø Ballwechsel (Kandidat)",
    statAvgSpeed: "Ø Bildgeschwindigkeit (px/s · bestätigt)",
    statInterval: "Ø Schlagabstand (innerhalb der Ballwechsel)",
    candidateNote: (count) => `${count} Kandidaten-Geschwindigkeiten stehen unten; sie zählen nicht zur offiziellen Statistik.`,
    cumTitle: "Zurückgelegte Strecke",
    cumUnitM: "m, Feld",
    cumUnitPx: "px, Bild",
    cumEmpty: "Noch nicht genug verfolgte Punkte.",
    speedTitle: "Schlag-Tempo-Monitor",
    colTime: "Zeit",
    colShot: "Bildgeschwindigkeit (px/s)",
    colType: "Typ · Flugbahn-Schätzung",
    colStatus: "Kontakt",
    statusConfirmed: "bestätigt",
    statusCandidate: "Kandidat",
    colFrame: "Bild",
    speedNote: "Bildgeschwindigkeit in px/s nur aus gültigen TrackNet-Schritten, nie km/h. Offizielle Statistik nur aus bestätigten Kontakten. Typen sind Flugbahn-Schätzungen · nicht verifiziert. – heißt: nicht verfügbar.",
    loading: "Lade …",
    classes: { smash: "Smash", clear: "Clear", drop: "Drop", drive: "Drive", net_shot: "Netzschlag", lift: "Lift" },
  },
};

function clock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
}

function HeatCells({ cells, label }: { cells: number[][]; label: string }) {
  const rows = cells.length;
  const cols = cells[0]?.length ?? 0;
  if (rows === 0 || cols === 0) return null;
  return (
    <svg viewBox={`0 0 ${cols} ${rows}`} preserveAspectRatio="none" role="img" aria-label={label} className={styles.heat}>
      <defs>
        <filter id="bd-heat-blur" x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="0.55" />
        </filter>
      </defs>
      <g filter="url(#bd-heat-blur)">
        {cells.flatMap((row, y) =>
          row.map((value, x) =>
            value > 0.01 ? (
              <rect key={`${x}-${y}`} x={x + 0.1} y={y + 0.1} width={0.8} height={0.8} style={{ fill: "#3b8bff" }} fillOpacity={Math.min(1, value)} />
            ) : null,
          ),
        )}
      </g>
    </svg>
  );
}

function Track({ value, max, colour }: { value: number; max: number; colour: string }) {
  const width = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className={styles.track} aria-hidden="true">
      <div className={styles.fill} style={{ width: `${width}%`, background: colour }} />
    </div>
  );
}

function CumulativeChart({
  walks,
  unit,
  copy,
}: {
  walks: Array<{ id: string; colour: string; points: DistanceView["series"][number]["points"]; total: number }>;
  unit: string;
  copy: Copy;
}) {
  const width = 360;
  const height = 250;
  const pad = { left: 34, right: 8, top: 10, bottom: 18 };
  const maxT = Math.max(1, ...walks.flatMap((item) => item.points.map((point) => point.t)));
  const maxD = Math.max(1, ...walks.map((item) => item.total));
  const x = (t: number) => pad.left + (t / maxT) * (width - pad.left - pad.right);
  const y = (d: number) => height - pad.bottom - (d / maxD) * (height - pad.top - pad.bottom);
  const ticks = [0, 0.5, 1].map((fraction) => maxD * fraction);
  if (walks.length === 0) return <p className={styles.muted}>{copy.cumEmpty}</p>;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={copy.cumTitle} className={styles.chart}>
      {ticks.map((tick) => (
        <g key={tick}>
          <line x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} className={styles.chartGrid} />
          <text x={pad.left - 6} y={y(tick) + 3} textAnchor="end" className={styles.chartAxis}>
            {Math.round(tick)}
          </text>
        </g>
      ))}
      <text x={pad.left} y={height - 4} className={styles.chartAxis}>0:00.0</text>
      <text x={width - pad.right} y={height - 4} textAnchor="end" className={styles.chartAxis}>{clock(maxT)}</text>
      {walks.map((item) => (
        <g key={item.id}>
          <polyline
            fill="none"
            stroke={item.colour}
            strokeWidth={2}
            points={item.points.map((point) => `${x(point.t)},${y(point.d)}`).join(" ")}
          />
          <text x={width - pad.right} y={y(item.total) - 5} textAnchor="end" className={styles.chartAxis} style={{ fill: item.colour }}>
            {item.total.toFixed(unit === "m" ? 1 : 0)} {unit}
          </text>
        </g>
      ))}
    </svg>
  );
}

export default function BroadcastDashboard({
  apiBase,
  jobId,
  language,
  revision,
  courtCalibrated,
  heatmap,
  courtHeatmap,
  sourceName,
  durationS,
  width,
  height,
  fps,
}: {
  apiBase: string;
  jobId: string;
  language: StudioLanguage;
  revision: number;
  courtCalibrated: boolean;
  heatmap: number[][] | null;
  courtHeatmap: number[][] | null;
  sourceName: string;
  durationS: number | null;
  width: number;
  height: number;
  fps: number;
}) {
  const copy = COPY[language];
  const [match, setMatch] = useState<MatchDocument | null>(null);
  const [records, setRecords] = useState<TrajectoryEstimate[] | null>(null);
  // The raw shuttle file is read only to check the record against it (file check); it is never used for a number.
  const [shuttle, setShuttle] = useState<Map<number, ShuttleObservation> | null>(null);
  const [view, setView] = useState<"annotated" | "original">("annotated");
  const [selectedId, setSelectedId] = useSelectedShotId(jobId);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    let active = true;
    const base = `/api/v1/analyses/${encodeURIComponent(jobId)}`;
    fetchJson<MatchDocument>(apiUrl(apiBase, `${base}/match`))
      .then((doc) => {
        if (active) setMatch(doc);
      })
      .catch(() => {
        if (active) setMatch(null);
      });
    fetchJson<{ records: TrajectoryEstimate[] }>(apiUrl(apiBase, `${base}/shot-trajectory/records`))
      .then((body) => {
        if (active) setRecords(body.records ?? []);
      })
      .catch(() => {
        if (active) setRecords([]);
      });
    fetchJson<{ frames: Array<{ frame: number; x: number | null; y: number | null; visible: boolean; refined: boolean }> }>(artifactUrl(apiBase, jobId, "shuttle_trajectory.json"))
      .then((body) => {
        if (active) setShuttle(shuttleMapFrom(body.frames ?? []));
      })
      .catch(() => {
        if (active) setShuttle(null);
      });
    return () => {
      active = false;
    };
  }, [apiBase, jobId, revision]);

  const annotatedUrl = artifactUrl(apiBase, jobId, "annotated.mp4");
  const originalUrl = apiUrl(apiBase, `/api/v1/analyses/${encodeURIComponent(jobId)}/source`);

  const playerIds = useMemo(() => {
    if (!match) return [] as string[];
    const ids = match.players?.length ? match.players : Object.keys(match.summary.players ?? {});
    return [...ids].sort();
  }, [match]);

  const colourOf = (player: string | null): string => {
    const index = player ? playerIds.indexOf(player) : -1;
    return index >= 0 ? PLAYER_COLOUR[index % PLAYER_COLOUR.length] : "var(--bd-faint)";
  };

  const shots = useMemo(() => (match ? [...match.shots.items].sort((a, b) => a.time_s - b.time_s) : []), [match]);
  const recordByFrame = useMemo(() => new Map((records ?? []).map((record) => [record.frame, record])), [records]);

  // Players at a glance, the speed panel, the distance chart and the contact positions: backend values only.
  const perPlayer = useMemo(
    () => (match ? playerRows(match, playerIds).map((row) => ({ ...row, colour: colourOf(row.id) })) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [match, playerIds],
  );
  const distance = useMemo(() => (match ? distanceView(match, playerIds) : null), [match, playerIds]);
  const walks = (distance?.series ?? []).map((item, index) => ({ ...item, colour: PLAYER_COLOUR[playerIds.indexOf(item.id) >= 0 ? playerIds.indexOf(item.id) : index] }));
  const unitIsMetres = distance?.unit === "m";
  const panel = match ? speedPanel(match) : null;
  const positionsView = match ? contactDots(match) : null;

  const rows: Array<{ key: string; label: string; values: Array<number | null>; text?: Array<string | null> }> = [
    { key: "contacts", label: copy.mHits, values: perPlayer.map((item) => item.contacts) },
    { key: "confirmed", label: copy.mConfirmed, values: perPlayer.map((item) => item.confirmed) },
    { key: "max", label: copy.mMax, values: perPlayer.map((item) => item.officialMax) },
    { key: "avg", label: copy.mAvg, values: perPlayer.map((item) => item.officialMean) },
    {
      key: "distance",
      label: unitIsMetres ? copy.mDistM : copy.mDistPx,
      values: perPlayer.map((item) => item.distance),
    },
    {
      key: "top",
      label: `${copy.mTop} · ${copy.estimateBadge}`,
      values: perPlayer.map(() => null),
      text: perPlayer.map((item) => (item.mostFrequent ? `${copy.classes[item.mostFrequent.label]} (${item.mostFrequent.count}/${item.mostFrequent.of})` : null)),
    },
  ];
  const maxOf = (values: Array<number | null>) => Math.max(0, ...values.map((value) => value ?? 0));

  // The selected contact: the first one with a recorded path, unless the person picks another.
  const current = useMemo(() => {
    if (shots.length === 0) return null;
    const hasPath = (shot: MatchShot) => {
      const record = recordByFrame.get(shot.frame);
      return record !== undefined && record.trajectory_before.length + record.trajectory_after.length > 1;
    };
    const chosen = shots.find((shot) => shot.id === selectedId) ?? shots.find(hasPath) ?? shots[0];
    return chosen;
  }, [shots, selectedId, recordByFrame]);
  // The record of this analysis at this shot's frame. The key is the analysis and the frame.
  const currentRecord = current && records ? findRecordForShot(records, current, jobId) : null;

  function pickShot(shot: MatchShot) {
    setSelectedId(shot.id);
    const video = videoRef.current;
    if (video) {
      try {
        video.currentTime = shot.time_s;
      } catch {
        // The video may not have its metadata yet; the row still selects the contact.
      }
    }
  }


  return (
    <div className={styles.board} aria-label={copy.videoTitle}>
      {/* ----- video ----- */}
      <section className={`${styles.panel} ${styles.video}`} aria-labelledby="bd-video-title">
        <div className={styles.head}>
          <h4 id="bd-video-title" className={styles.title}>{copy.videoTitle}</h4>
          <span className={styles.status}>{copy.done}</span>
          <span className={styles.muted}>{copy.candidates(shots.length)}</span>
          <div className={styles.seg} role="group" aria-label={copy.videoTitle}>
            <button type="button" aria-pressed={view === "annotated"} onClick={() => setView("annotated")}>{copy.annotated}</button>
            <button type="button" aria-pressed={view === "original"} onClick={() => setView("original")}>{copy.original}</button>
          </div>
        </div>
        <div className={styles.stage}>
          <video
            ref={videoRef}
            key={view}
            className={styles.player}
            src={view === "annotated" ? annotatedUrl : originalUrl}
            controls
            playsInline
            preload="metadata"
            width={width}
            height={height}
            aria-label={`${copy.videoTitle} · ${sourceName}`}
          />
        </div>
        <div className={styles.videoFoot}>
          <span>{sourceName}</span>
          <span>
            {width}×{height} · {Math.round(fps)} fps · {durationS === null ? "–" : `${durationS.toFixed(1)} s`}
          </span>
        </div>
      </section>

      <div className={styles.right}>
        {/* ----- players at a glance ----- */}
        <section className={styles.panel} aria-labelledby="bd-players-title">
          <div className={styles.head}>
            <h4 id="bd-players-title" className={styles.title}>{copy.playersTitle}</h4>
            <span className={styles.muted}>{copy.wholeClip}</span>
          </div>
          {!match ? (
            <p className={styles.muted}>{copy.loading}</p>
          ) : playerIds.length === 2 ? (
            <div className={styles.cmpTwo}>
              <div className={styles.cmpHead}>
                <span className={styles.chipP} style={{ color: PLAYER_COLOUR[0] }}><i className={styles.swatch} style={{ background: PLAYER_COLOUR[0] }} />{playerIds[0]}</span>
                <span />
                <span className={`${styles.chipP} ${styles.cmpHeadRight}`} style={{ color: PLAYER_COLOUR[1] }}>{playerIds[1]}<i className={styles.swatch} style={{ background: PLAYER_COLOUR[1] }} /></span>
              </div>
              {rows.map((row) => {
                const [left, right] = perPlayer;
                const max = maxOf(row.values);
                const leftValue = row.values[0];
                const rightValue = row.values[1];
                const leftText = row.text ? row.text[0] : leftValue === null ? copy.none : row.key === "distance" ? leftValue.toFixed(unitIsMetres ? 1 : 0) : Math.round(leftValue).toString();
                const rightText = row.text ? row.text[1] : rightValue === null ? copy.none : row.key === "distance" ? rightValue.toFixed(unitIsMetres ? 1 : 0) : Math.round(rightValue).toString();
                return (
                  <div className={styles.cmpRow} key={row.key}>
                    <span className={row.text ? styles.textCell : styles.cmpLeft} style={row.text ? undefined : { color: left.colour }}>{leftText}</span>
                    {row.text ? <span /> : <Track value={leftValue ?? 0} max={max} colour={left.colour} />}
                    <span className={styles.cmpMid}>{row.label}</span>
                    {row.text ? <span /> : <Track value={rightValue ?? 0} max={max} colour={right.colour} />}
                    <span className={`${row.text ? styles.textCell : styles.cmpRight}`} style={row.text ? { textAlign: "right" } : { color: right.colour }}>{rightText}</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className={styles.cmpGrid} style={{ gridTemplateColumns: `minmax(0, 1.2fr) repeat(${Math.max(1, perPlayer.length)}, minmax(0, 1fr))` }}>
              <span />
              {perPlayer.map((item) => (
                <span key={item.id} className={styles.chipP} style={{ color: item.colour }}>
                  <i className={styles.swatch} style={{ background: item.colour }} />
                  {item.id}
                </span>
              ))}
              {rows.map((row) => (
                <Fragment key={row.key}>
                  <span className={styles.cmpLabel}>{row.label}</span>
                  {perPlayer.map((item, index) => {
                    const value = row.values[index];
                    const text = row.text ? row.text[index] : value === null ? copy.none : row.key === "distance" ? value.toFixed(unitIsMetres ? 1 : 0) : Math.round(value).toString();
                    return (
                      <span key={item.id} className={styles.cmpCell}>
                        <strong className={row.text ? styles.textCell : undefined}>{text}</strong>
                        {!row.text && value !== null ? <Track value={value} max={maxOf(row.values)} colour={item.colour} /> : null}
                      </span>
                    );
                  })}
                </Fragment>
              ))}
            </div>
          )}
        </section>

        {/* ----- positions ----- */}
        <section className={styles.panel} aria-labelledby="bd-positions-title">
          <div className={styles.head}>
            <h4 id="bd-positions-title" className={styles.title}>{copy.positionsTitle}</h4>
            <span className={styles.muted}>{courtCalibrated && courtHeatmap ? copy.courtSpace : copy.imageSpace}</span>
          </div>
          <div className={styles.posGrid}>
            <div style={{ display: "grid", gap: 6 }}>
              <span className={styles.muted}>{copy.heatTitle} · {courtHeatmap ? copy.heatCourt : copy.heatImage}</span>
              <div className={courtHeatmap ? styles.court : styles.imageBox}>
                {courtHeatmap ? <div className={styles.netLine} /> : null}
                {(courtHeatmap ?? heatmap) ? (
                  <HeatCells cells={(courtHeatmap ?? heatmap) as number[][]} label={copy.heatTitle} />
                ) : (
                  <span className={styles.caption}>{copy.heatEmpty}</span>
                )}
              </div>
            </div>
            <div style={{ display: "grid", gap: 6 }}>
              <span className={styles.muted}>{positionsView?.space === "court_m" ? copy.contactsCourt : copy.contactsImage}</span>
              <div className={positionsView?.space === "court_m" ? styles.court : styles.imageBox}>
                {positionsView?.space === "court_m" ? <div className={styles.netLine} /> : null}
                {(positionsView?.dots ?? []).map((dot) => {
                  const selected = current !== null && dot.timelineId === current.id;
                  return (
                    <span
                      key={dot.shotId}
                      className={selected ? `${styles.dot} ${styles.dotSelected}` : styles.dot}
                      style={{ left: `${dot.left * 100}%`, top: `${dot.top * 100}%`, background: selected ? undefined : colourOf(dot.player) }}
                      title={`f ${dot.frame} · ${dot.player ?? "–"}`}
                    />
                  );
                })}
              </div>
            </div>
          </div>
          <div className={styles.legend}>
            {playerIds.map((id, index) => (
              <span key={id}><i className={styles.swatch} style={{ background: PLAYER_COLOUR[index % PLAYER_COLOUR.length] }} />{id}</span>
            ))}
            <span><i className={styles.swatchRing} />{copy.selectedLegend}</span>
            <span>{copy.heatNote}</span>
          </div>
        </section>
      </div>

      {/* ----- shot path, cumulative distance ----- */}
      <div className={styles.bottom}>
        <div className={styles.trajectoryCell}>
          <ShotTrajectory
            language={language}
            record={currentRecord}
            loading={records === null}
            playerColour={colourOf}
            shuttle={shuttle}
            fps={fps}
            sourceUrl={apiUrl(apiBase, `/api/v1/analyses/${encodeURIComponent(jobId)}/source`)}
            estimated3d={current?.estimated_3d ?? null}
            measured3d={current?.measured_3d ?? match?.measured_3d ?? null}
          />
        </div>

        <section className={styles.panel} aria-labelledby="bd-distance-title">
          <div className={styles.head}>
            <h4 id="bd-distance-title" className={styles.title}>{copy.cumTitle}</h4>
            <span className={styles.legend}>
              {walks.map((item) => (
                <span key={item.id}><i className={styles.swatch} style={{ background: item.colour }} />{item.id}</span>
              ))}
              <span className={styles.muted}>{unitIsMetres ? copy.cumUnitM : copy.cumUnitPx}</span>
            </span>
          </div>
          {walks.length === 0 ? <p className={styles.muted}>{copy.cumEmpty}</p> : (
            <CumulativeChart walks={walks} unit={unitIsMetres ? "m" : "px"} copy={copy} />
          )}
        </section>
      </div>

      {/* ----- speed monitor ----- */}
      <section className={`${styles.panel} ${styles.speed}`} aria-labelledby="bd-speed-title">
        <div className={styles.head}>
          <h4 id="bd-speed-title" className={styles.title}>{copy.speedTitle}</h4>
        </div>
        <dl className={styles.statRow}>
          <div className={styles.statItem}>
            <dt>{copy.statSpeeds}</dt>
            <dd>{panel ? panel.official_count : copy.none}</dd>
          </div>
          <div className={styles.statItem}>
            <dt>{copy.statRally}</dt>
            <dd>{panel?.rally_mean_duration_s == null ? copy.none : `${panel.rally_mean_duration_s.toFixed(1)} s`}</dd>
          </div>
          <div className={styles.statItem}>
            <dt>{copy.statAvgSpeed}</dt>
            <dd>{panel?.official_mean_px_per_s == null ? copy.none : `${Math.round(panel.official_mean_px_per_s)} px/s`}</dd>
          </div>
          <div className={styles.statItem}>
            <dt>{copy.statInterval}</dt>
            <dd>{panel?.shot_interval_mean_s == null ? copy.none : `${panel.shot_interval_mean_s.toFixed(1)} s`}</dd>
          </div>
        </dl>
        {panel && panel.candidate_count > 0 ? <p className={styles.footnote}>{copy.candidateNote(panel.candidate_count)}</p> : null}
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th scope="col">{copy.colTime}</th>
                <th scope="col">{copy.colShot}</th>
                <th scope="col">{copy.colType}</th>
                <th scope="col">{copy.colStatus}</th>
                <th scope="col">{copy.colFrame}</th>
              </tr>
            </thead>
            <tbody>
              {shots.map((shot) => {
                const label = shotLabel(shot);
                const speed = pxPerSecond(shot.speed?.px_per_s);
                const selected = current !== null && shot.id === current.id;
                return (
                  <tr key={shot.id} data-selected={selected ? "true" : "false"}>
                    <td>
                      <button type="button" className={styles.rowButton} onClick={() => pickShot(shot)} aria-pressed={selected}>
                        {clock(shot.time_s)}
                      </button>
                    </td>
                    <td>
                      <span style={{ color: colourOf(shot.player), fontWeight: 700 }}>{shot.player ?? "–"}</span>{" "}
                      <span className={styles.speedValue}>{speed === null ? copy.none : speed}</span>
                    </td>
                    <td>{label ? <span className={styles.tag} style={{ borderColor: CLASS_COLOUR[label], color: CLASS_COLOUR[label] }}>{copy.classes[label]}</span> : copy.none}</td>
                    <td className={shot.contact_status === "confirmed" ? styles.statusConfirmed : styles.statusCandidate}>
                      {shot.contact_status === "confirmed" ? copy.statusConfirmed : copy.statusCandidate}
                    </td>
                    <td>{shot.frame}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className={styles.footnote}>{copy.speedNote}</p>
      </section>
    </div>
  );
}
