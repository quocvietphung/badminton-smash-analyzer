// View model of the broadcast dashboard. Every number is copied from the backend match document (its dashboard block,
// timeline rows and sanitized track); nothing is recomputed here, so the studio cannot disagree with the backend.
import type { DashboardBlock, MatchDocument, MatchShot } from "./types";

export const SIX_CLASSES = ["smash", "clear", "drop", "drive", "net_shot", "lift"] as const;
export type SixClass = (typeof SIX_CLASSES)[number];

export function isSixClass(value: unknown): value is SixClass {
  return typeof value === "string" && (SIX_CLASSES as readonly string[]).includes(value);
}

/** The label a timeline row shows: a person's six-class label, else the trajectory estimate. Never "unknown". */
export function shotLabel(shot: MatchShot): SixClass | null {
  if (shot.type_source === "manual" && isSixClass(shot.type)) return shot.type;
  const estimate = shot.trajectory?.best_guess_label;
  return isSixClass(estimate) ? estimate : isSixClass(shot.type) ? shot.type : null;
}

export type PlayerRow = {
  id: string;
  contacts: number;
  confirmed: number;
  /** Image-space speed (px/s) from confirmed contacts only; null when the player has none. */
  officialMax: number | null;
  officialMean: number | null;
  distance: number | null;
  distanceUnit: "m" | "px" | null;
  /** The most frequent trajectory estimate (unverified), never a person's statistic. */
  mostFrequent: { label: SixClass; count: number; of: number } | null;
};

export function playerRows(doc: MatchDocument, playerIds: string[]): PlayerRow[] {
  const block = doc.dashboard?.players ?? {};
  return playerIds.map((id) => {
    const row = block[id];
    const estimate = row?.most_frequent_estimate ?? null;
    return {
      id,
      contacts: row?.contacts ?? 0,
      confirmed: row?.confirmed_contacts ?? 0,
      officialMax: row?.official_max_px_per_s ?? null,
      officialMean: row?.official_mean_px_per_s ?? null,
      distance: row?.distance?.value ?? null,
      distanceUnit: row?.distance?.unit ?? null,
      mostFrequent: estimate && isSixClass(estimate.label) ? { label: estimate.label, count: estimate.count, of: estimate.of } : null,
    };
  });
}

export function speedPanel(doc: MatchDocument): DashboardBlock["speed_panel"] | null {
  return doc.dashboard?.speed_panel ?? null;
}

export type DistanceView = { unit: "m" | "px"; series: Array<{ id: string; points: Array<{ t: number; d: number }>; total: number }> };

/** The cumulative distance of each player, as computed on the backend (the same values as the summary distance). */
export function distanceView(doc: MatchDocument, playerIds: string[]): DistanceView | null {
  const chart = doc.dashboard?.distance_chart;
  if (!chart) return null;
  const series = playerIds
    .map((id) => {
      const points = (chart.series[id] ?? []).map(([t, d]) => ({ t, d }));
      return { id, points, total: points.length ? points[points.length - 1].d : 0 };
    })
    .filter((item) => item.points.length > 1);
  return { unit: chart.unit, series };
}

export type ContactDot = { shotId: string; timelineId: string; frame: number; player: string | null; left: number; top: number };

/**
 * Contact positions in the space the backend chose: the hitting player's foot in floor-plane metres when the court is
 * calibrated, or the shuttle's image position when it is not. Never shuttle positions labelled as metres.
 */
export function contactDots(doc: MatchDocument): { space: "court_m" | "image_normalized"; label: string; dots: ContactDot[] } | null {
  const block = doc.dashboard?.contact_positions;
  if (!block) return null;
  const length = doc.court.dimensions_m.length_m || 13.4;
  const width = doc.court.dimensions_m.doubles_width_m || 6.1;
  const dots = block.items
    .filter((item) => item.x !== null && item.y !== null)
    .map((item) => ({
      shotId: item.shot_id,
      timelineId: item.timeline_id,
      frame: item.frame,
      player: item.player,
      left: block.space === "court_m" ? (item.x as number) / width : (item.x as number),
      top: block.space === "court_m" ? (item.y as number) / length : (item.y as number),
    }));
  return { space: block.space, label: block.label, dots };
}

/** px/s rounded for display; null stays null ("–"). */
export function pxPerSecond(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : null;
}
