import type { PoseLandmark } from "@/lib/pose-metrics";

export type CourtPoint = { x: number; y: number };

export const DEFAULT_COURT_CORNERS: CourtPoint[] = [
  { x: 0.34, y: 0.16 },
  { x: 0.66, y: 0.16 },
  { x: 0.92, y: 0.94 },
  { x: 0.08, y: 0.94 },
];

const COURT_TARGETS: CourtPoint[] = [
  { x: 0, y: 0 },
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
];

const clamp = (value: number, min = 0, max = 1) =>
  Math.min(max, Math.max(min, value));

function solveLinearSystem(matrix: number[][], values: number[]) {
  const size = values.length;
  const augmented = matrix.map((row, index) => [...row, values[index]]);

  for (let column = 0; column < size; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row][column]) > Math.abs(augmented[pivot][column])) {
        pivot = row;
      }
    }
    [augmented[column], augmented[pivot]] = [augmented[pivot], augmented[column]];
    const divisor = augmented[column][column];
    if (Math.abs(divisor) < 1e-9) return null;
    for (let cell = column; cell <= size; cell += 1) {
      augmented[column][cell] /= divisor;
    }
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row][column];
      for (let cell = column; cell <= size; cell += 1) {
        augmented[row][cell] -= factor * augmented[column][cell];
      }
    }
  }

  return augmented.map((row) => row[size]);
}

export function createCourtMapper(corners: CourtPoint[]) {
  if (corners.length !== 4) return (point: CourtPoint) => point;
  const matrix: number[][] = [];
  const values: number[] = [];

  corners.forEach((source, index) => {
    const target = COURT_TARGETS[index];
    matrix.push([
      source.x, source.y, 1, 0, 0, 0,
      -target.x * source.x, -target.x * source.y,
    ]);
    values.push(target.x);
    matrix.push([
      0, 0, 0, source.x, source.y, 1,
      -target.y * source.x, -target.y * source.y,
    ]);
    values.push(target.y);
  });

  const coefficients = solveLinearSystem(matrix, values);
  if (!coefficients) return (point: CourtPoint) => point;

  return (point: CourtPoint): CourtPoint => {
    const [a, b, c, d, e, f, g, h] = coefficients;
    const scale = g * point.x + h * point.y + 1;
    return {
      x: clamp((a * point.x + b * point.y + c) / scale),
      y: clamp((d * point.x + e * point.y + f) / scale),
    };
  };
}

export function poseFootPoint(landmarks: PoseLandmark[]): CourtPoint {
  const left = landmarks[27];
  const right = landmarks[28];
  return {
    x: (left.x + right.x) / 2,
    y: (left.y + right.y) / 2,
  };
}

export function courtDistance(a: CourtPoint, b: CourtPoint) {
  return Math.hypot((b.x - a.x) * 6.1, (b.y - a.y) * 13.4);
}
