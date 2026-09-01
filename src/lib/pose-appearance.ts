import type { PoseLandmark } from "./pose-metrics";

export type ShirtColor = "red" | "orange" | "yellow" | "green" | "blue" | "purple" | "pink" | "white" | "gray" | "black" | "unknown";
export type HorizontalPosition = "left" | "center" | "right";

export type PoseAppearance = {
  histogram: number[];
  shirtColor: ShirtColor;
  confidence: number;
  sampleCount: number;
};

const HUE_BINS = 18;
const BLACK_BIN = 18;
const GRAY_BIN = 19;
const WHITE_BIN = 20;
const HISTOGRAM_SIZE = 21;

function rgbToHsv(red: number, green: number, blue: number) {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const maximum = Math.max(r, g, b);
  const minimum = Math.min(r, g, b);
  const delta = maximum - minimum;
  let hue = 0;
  if (delta > 0) {
    if (maximum === r) hue = 60 * (((g - b) / delta) % 6);
    else if (maximum === g) hue = 60 * ((b - r) / delta + 2);
    else hue = 60 * ((r - g) / delta + 4);
  }
  if (hue < 0) hue += 360;
  return {
    hue,
    saturation: maximum === 0 ? 0 : delta / maximum,
    value: maximum,
  };
}

function colorForHistogramBin(bin: number): ShirtColor {
  if (bin === BLACK_BIN) return "black";
  if (bin === GRAY_BIN) return "gray";
  if (bin === WHITE_BIN) return "white";
  const hue = (bin + 0.5) * (360 / HUE_BINS);
  if (hue < 18 || hue >= 345) return "red";
  if (hue < 45) return "orange";
  if (hue < 72) return "yellow";
  if (hue < 170) return "green";
  if (hue < 258) return "blue";
  if (hue < 318) return "purple";
  return "pink";
}

function histogramBin(red: number, green: number, blue: number) {
  const hsv = rgbToHsv(red, green, blue);
  if (hsv.value < 0.2) return BLACK_BIN;
  if (hsv.saturation < 0.16 && hsv.value > 0.74) return WHITE_BIN;
  if (hsv.saturation < 0.22) return GRAY_BIN;
  return Math.min(HUE_BINS - 1, Math.floor(hsv.hue / (360 / HUE_BINS)));
}

function normalizeHistogram(histogram: number[], sampleCount: number) {
  if (!sampleCount) return histogram;
  return histogram.map((value) => value / sampleCount);
}

function appearanceFromHistogram(histogram: number[], sampleCount: number): PoseAppearance {
  const normalized = normalizeHistogram(histogram, sampleCount);
  let dominantBin = 0;
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index] > normalized[dominantBin]) dominantBin = index;
  }
  const dominantShare = normalized[dominantBin] ?? 0;
  return {
    histogram: normalized,
    shirtColor: sampleCount >= 18 && dominantShare >= 0.2 ? colorForHistogramBin(dominantBin) : "unknown",
    confidence: Math.round(Math.min(1, dominantShare * 1.55) * 100) / 100,
    sampleCount,
  };
}

function visible(point: PoseLandmark | undefined) {
  return Boolean(point && (point.visibility ?? 1) >= 0.35);
}

export function extractTorsoAppearance(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  landmarks: PoseLandmark[],
): PoseAppearance | undefined {
  const leftShoulder = landmarks[11];
  const rightShoulder = landmarks[12];
  const leftHip = landmarks[23];
  const rightHip = landmarks[24];
  if (![leftShoulder, rightShoulder, leftHip, rightHip].every(visible)) return undefined;

  const torsoWidth = (Math.hypot(leftShoulder.x - rightShoulder.x, leftShoulder.y - rightShoulder.y)
    + Math.hypot(leftHip.x - rightHip.x, leftHip.y - rightHip.y)) / 2;
  const torsoHeight = (Math.hypot(leftShoulder.x - leftHip.x, leftShoulder.y - leftHip.y)
    + Math.hypot(rightShoulder.x - rightHip.x, rightShoulder.y - rightHip.y)) / 2;
  if (torsoWidth < 0.018 || torsoHeight < 0.025) return undefined;

  const histogram = Array.from({ length: HISTOGRAM_SIZE }, () => 0);
  let sampleCount = 0;
  const lerp = (start: number, end: number, progress: number) => start + (end - start) * progress;
  for (let row = 2; row <= 14; row += 1) {
    const vertical = row / 17;
    const leftX = lerp(leftShoulder.x, leftHip.x, vertical);
    const leftY = lerp(leftShoulder.y, leftHip.y, vertical);
    const rightX = lerp(rightShoulder.x, rightHip.x, vertical);
    const rightY = lerp(rightShoulder.y, rightHip.y, vertical);
    for (let column = 3; column <= 15; column += 1) {
      const horizontal = column / 18;
      const x = Math.max(0, Math.min(width - 1, Math.round(lerp(leftX, rightX, horizontal) * width)));
      const y = Math.max(0, Math.min(height - 1, Math.round(lerp(leftY, rightY, horizontal) * height)));
      const offset = (y * width + x) * 4;
      if ((pixels[offset + 3] ?? 255) < 180) continue;
      histogram[histogramBin(pixels[offset], pixels[offset + 1], pixels[offset + 2])] += 1;
      sampleCount += 1;
    }
  }
  return appearanceFromHistogram(histogram, sampleCount);
}

export function appearanceDistance(left: PoseAppearance, right: PoseAppearance) {
  const overlap = left.histogram.reduce((sum, value, index) =>
    sum + Math.sqrt(Math.max(0, value) * Math.max(0, right.histogram[index] ?? 0)), 0);
  return Math.sqrt(Math.max(0, 1 - Math.min(1, overlap)));
}

export function appearanceIdentityConflict(
  selected: PoseAppearance,
  current: PoseAppearance,
  alternatives: PoseAppearance[],
) {
  const knownColorMismatch = selected.shirtColor !== "unknown"
    && current.shirtColor !== "unknown"
    && selected.shirtColor !== current.shirtColor
    && selected.confidence >= 0.4
    && current.confidence >= 0.4;
  if (!knownColorMismatch || alternatives.length === 0) return false;
  const currentDistance = appearanceDistance(selected, current);
  if (currentDistance <= 0.68) return false;
  return alternatives.some((candidate) =>
    appearanceDistance(selected, candidate) + 0.18 < currentDistance);
}

export function blendAppearance(
  previous: PoseAppearance | undefined,
  current: PoseAppearance | undefined,
  currentWeight = 0.32,
) {
  if (!current) return previous;
  if (!previous) return current;
  const histogram = previous.histogram.map((value, index) =>
    value * (1 - currentWeight) + (current.histogram[index] ?? 0) * currentWeight);
  return appearanceFromHistogram(histogram, Math.max(previous.sampleCount, current.sampleCount));
}

export function horizontalPosition(
  centerX: number,
  previous?: HorizontalPosition,
): HorizontalPosition {
  if (previous === "left" && centerX < 0.44) return "left";
  if (previous === "right" && centerX > 0.56) return "right";
  if (previous === "center" && centerX >= 0.32 && centerX <= 0.68) return "center";
  if (centerX < 0.37) return "left";
  if (centerX > 0.63) return "right";
  return "center";
}

export function shirtColorCss(color: ShirtColor) {
  const colors: Record<ShirtColor, string> = {
    red: "#ff5c68",
    orange: "#ff9f43",
    yellow: "#f5d84f",
    green: "#52d58a",
    blue: "#54a8ff",
    purple: "#a882ff",
    pink: "#ff83c6",
    white: "#eef5f2",
    gray: "#8f9d99",
    black: "#242b2a",
    unknown: "#71817c",
  };
  return colors[color];
}
