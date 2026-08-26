export type NormalizedPoint = { x: number; y: number };

export type CourtDetection = {
  corners: [NormalizedPoint, NormalizedPoint, NormalizedPoint, NormalizedPoint];
  confidence: number;
  diagnostics: string;
};

export type CourtGeometryAssessment = {
  valid: boolean;
  quality: "good" | "review" | "invalid";
  score: number;
  warnings: string[];
};

type EdgePoint = { x: number; y: number; weight: number };
type HoughLine = { theta: number; rho: number; votes: number };

const clamp = (value: number, min = 0, max = 1) =>
  Math.min(max, Math.max(min, value));

const mean = (values: number[]) => values.length
  ? values.reduce((total, value) => total + value, 0) / values.length
  : 0;

function luminanceBuffer(data: Uint8ClampedArray, width: number, height: number) {
  const luminance = new Uint8Array(width * height);
  for (let index = 0; index < width * height; index += 1) {
    const offset = index * 4;
    luminance[index] = Math.round(
      data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114,
    );
  }
  return luminance;
}

function collectEdges(data: Uint8ClampedArray, width: number, height: number) {
  const luminance = luminanceBuffer(data, width, height);
  const edges: EdgePoint[] = [];
  const step = width >= 300 ? 2 : 1;

  for (let y = 2; y < height - 2; y += step) {
    for (let x = 2; x < width - 2; x += step) {
      const horizontal = Math.abs(luminance[y * width + x + 1] - luminance[y * width + x - 1]);
      const vertical = Math.abs(luminance[(y + 1) * width + x] - luminance[(y - 1) * width + x]);
      const diagonal = Math.abs(luminance[(y + 1) * width + x + 1] - luminance[(y - 1) * width + x - 1]);
      const strength = horizontal + vertical + diagonal * 0.35;
      const brightness = luminance[y * width + x];

      if (strength >= 38 || (brightness >= 168 && strength >= 24)) {
        edges.push({ x, y, weight: clamp(strength / 95, 0.45, 2.2) });
      }
    }
  }

  if (edges.length <= 8_000) return edges;
  return edges.sort((left, right) => right.weight - left.weight).slice(0, 8_000);
}

function findHoughLines(
  points: EdgePoint[],
  width: number,
  height: number,
  angles: number[],
) {
  const diagonal = Math.hypot(width, height);
  const rhoResolution = 2;
  const rhoBins = Math.ceil((diagonal * 2) / rhoResolution) + 1;
  const lines: HoughLine[] = [];

  angles.forEach((degrees) => {
    const theta = (degrees * Math.PI) / 180;
    const cosine = Math.cos(theta);
    const sine = Math.sin(theta);
    const accumulator = new Float32Array(rhoBins);

    points.forEach((point) => {
      const rho = point.x * cosine + point.y * sine;
      const bin = Math.round((rho + diagonal) / rhoResolution);
      if (bin >= 0 && bin < rhoBins) accumulator[bin] += point.weight;
    });

    for (let bin = 1; bin < rhoBins - 1; bin += 1) {
      const votes = accumulator[bin];
      if (votes < 12 || votes < accumulator[bin - 1] || votes < accumulator[bin + 1]) continue;
      lines.push({
        theta,
        rho: bin * rhoResolution - diagonal,
        votes,
      });
    }
  });

  const selected: HoughLine[] = [];
  lines.sort((left, right) => right.votes - left.votes).forEach((line) => {
    const duplicate = selected.some((other) =>
      Math.abs(other.theta - line.theta) < (5 * Math.PI) / 180
      && Math.abs(other.rho - line.rho) < 12,
    );
    if (!duplicate && selected.length < 14) selected.push(line);
  });
  return selected;
}

function intersection(first: HoughLine, second: HoughLine) {
  const firstCosine = Math.cos(first.theta);
  const firstSine = Math.sin(first.theta);
  const secondCosine = Math.cos(second.theta);
  const secondSine = Math.sin(second.theta);
  const determinant = firstCosine * secondSine - firstSine * secondCosine;
  if (Math.abs(determinant) < 0.08) return null;

  return {
    x: (first.rho * secondSine - firstSine * second.rho) / determinant,
    y: (firstCosine * second.rho - first.rho * secondCosine) / determinant,
  };
}

function yAtX(line: HoughLine, x: number) {
  const sine = Math.sin(line.theta);
  if (Math.abs(sine) < 0.08) return Number.NaN;
  return (line.rho - x * Math.cos(line.theta)) / sine;
}

function xAtY(line: HoughLine, y: number) {
  const cosine = Math.cos(line.theta);
  if (Math.abs(cosine) < 0.08) return Number.NaN;
  return (line.rho - y * Math.sin(line.theta)) / cosine;
}

function distance(first: NormalizedPoint, second: NormalizedPoint) {
  return Math.hypot(first.x - second.x, first.y - second.y);
}

export function normalizeCourtCorners(points: NormalizedPoint[]) {
  if (points.length !== 4) return points;
  const byHeight = [...points].sort((left, right) => left.y - right.y);
  const far = byHeight.slice(0, 2).sort((left, right) => left.x - right.x);
  const near = byHeight.slice(2).sort((left, right) => left.x - right.x);
  return [far[0], far[1], near[1], near[0]];
}

export function validateCourtCorners(points: NormalizedPoint[]) {
  if (points.length !== 4) return false;
  const [farLeft, farRight, nearRight, nearLeft] = points;
  const farWidth = distance(farLeft, farRight);
  const nearWidth = distance(nearLeft, nearRight);
  const leftHeight = distance(farLeft, nearLeft);
  const rightHeight = distance(farRight, nearRight);
  const area = Math.abs(
    points.reduce((sum, point, index) => {
      const next = points[(index + 1) % points.length];
      return sum + point.x * next.y - next.x * point.y;
    }, 0) / 2,
  );

  return points.every((point) => point.x >= 0 && point.x <= 1 && point.y >= 0 && point.y <= 1)
    && farLeft.x < farRight.x
    && nearLeft.x < nearRight.x
    && (farLeft.y + farRight.y) / 2 < (nearLeft.y + nearRight.y) / 2
    && farWidth > 0.12
    && nearWidth > 0.2
    && leftHeight > 0.18
    && rightHeight > 0.18
    && area > 0.06;
}

export function averageCornerDistance(
  first: NormalizedPoint[],
  second: NormalizedPoint[],
) {
  if (first.length !== 4 || second.length !== 4) return 1;
  return mean(first.map((point, index) => distance(point, second[index])));
}

export function assessCourtCorners(points: NormalizedPoint[]): CourtGeometryAssessment {
  if (points.length !== 4) {
    return {
      valid: false,
      quality: "invalid",
      score: 0,
      warnings: [`Còn thiếu ${4 - points.length} góc sân.`],
    };
  }

  const valid = validateCourtCorners(points);
  if (!valid) {
    return {
      valid: false,
      quality: "invalid",
      score: 0,
      warnings: ["Thứ tự hoặc khoảng cách bốn góc chưa tạo thành một mặt sân hợp lệ."],
    };
  }

  const [farLeft, farRight, nearRight, nearLeft] = points;
  const farWidth = distance(farLeft, farRight);
  const nearWidth = distance(nearLeft, nearRight);
  const leftHeight = distance(farLeft, nearLeft);
  const rightHeight = distance(farRight, nearRight);
  const widthRatio = farWidth / nearWidth;
  const sideDifference = Math.abs(leftHeight - rightHeight) / Math.max(leftHeight, rightHeight);
  const centerX = mean(points.map((point) => point.x));
  const area = Math.abs(
    points.reduce((sum, point, index) => {
      const next = points[(index + 1) % points.length];
      return sum + point.x * next.y - next.x * point.y;
    }, 0) / 2,
  );
  const minimumEdgeMargin = Math.min(
    ...points.flatMap((point) => [point.x, point.y, 1 - point.x, 1 - point.y]),
  );
  const perspectiveScore = 1 - clamp(Math.abs(widthRatio - 0.62) / 0.58);
  const coverageScore = clamp((area - 0.06) / 0.3);
  const symmetryScore = 1 - clamp(sideDifference / 0.55);
  const centerScore = 1 - clamp(Math.abs(centerX - 0.5) / 0.42);
  const score = Math.round(clamp(
    perspectiveScore * 0.36
      + coverageScore * 0.32
      + symmetryScore * 0.2
      + centerScore * 0.12,
  ) * 100);

  const warnings: string[] = [];
  if (area < 0.13) warnings.push("Sân đang chiếm quá ít khung hình; số mét di chuyển sẽ nhạy với sai số.");
  if (widthRatio < 0.3 || widthRatio > 1.08) warnings.push("Tỷ lệ cạnh xa/gần bất thường; có thể đang bắt nhầm mép màn hình hoặc bảng quảng cáo.");
  if (sideDifference > 0.38) warnings.push("Hai cạnh dọc lệch nhau nhiều; hãy kiểm tra lại bốn giao điểm vạch sân.");
  if (Math.abs(centerX - 0.5) > 0.3) warnings.push("Khung sân lệch mạnh sang một bên camera.");
  if (minimumEdgeMargin < 0.008) warnings.push("Có góc nằm sát mép ảnh và có thể đã bị cắt mất.");

  return {
    valid: true,
    quality: score >= 72 && warnings.length === 0 ? "good" : "review",
    score,
    warnings,
  };
}

export function detectCourtCornersFromPixels(
  data: Uint8ClampedArray,
  width: number,
  height: number,
): CourtDetection | null {
  if (width < 80 || height < 60 || data.length < width * height * 4) return null;
  const points = collectEdges(data, width, height);
  if (points.length < 120) return null;

  const horizontalAngles = Array.from({ length: 23 }, (_, index) => 68 + index * 2);
  const sideAngles = [
    ...Array.from({ length: 19 }, (_, index) => index * 2),
    ...Array.from({ length: 18 }, (_, index) => 145 + index * 2),
  ];
  const horizontalLines = findHoughLines(points, width, height, horizontalAngles);
  const sideLines = findHoughLines(points, width, height, sideAngles);
  if (horizontalLines.length < 2 || sideLines.length < 2) return null;

  const maximumVotes = Math.max(
    ...horizontalLines.map((line) => line.votes),
    ...sideLines.map((line) => line.votes),
  );
  let best: { corners: CourtDetection["corners"]; score: number; confidence: number } | null = null;

  for (let firstHorizontal = 0; firstHorizontal < horizontalLines.length; firstHorizontal += 1) {
    for (let secondHorizontal = firstHorizontal + 1; secondHorizontal < horizontalLines.length; secondHorizontal += 1) {
      const firstY = yAtX(horizontalLines[firstHorizontal], width / 2);
      const secondY = yAtX(horizontalLines[secondHorizontal], width / 2);
      if (!Number.isFinite(firstY) || !Number.isFinite(secondY)) continue;
      const farLine = firstY < secondY ? horizontalLines[firstHorizontal] : horizontalLines[secondHorizontal];
      const nearLine = firstY < secondY ? horizontalLines[secondHorizontal] : horizontalLines[firstHorizontal];
      const farY = Math.min(firstY, secondY);
      const nearY = Math.max(firstY, secondY);
      const courtHeight = nearY - farY;
      if (courtHeight < height * 0.28 || farY < -height * 0.05 || nearY > height * 1.05) continue;

      for (let firstSide = 0; firstSide < sideLines.length; firstSide += 1) {
        for (let secondSide = firstSide + 1; secondSide < sideLines.length; secondSide += 1) {
          const middleY = (farY + nearY) / 2;
          const firstX = xAtY(sideLines[firstSide], middleY);
          const secondX = xAtY(sideLines[secondSide], middleY);
          if (!Number.isFinite(firstX) || !Number.isFinite(secondX) || Math.abs(firstX - secondX) < width * 0.2) continue;
          const leftLine = firstX < secondX ? sideLines[firstSide] : sideLines[secondSide];
          const rightLine = firstX < secondX ? sideLines[secondSide] : sideLines[firstSide];
          const farLeftPixel = intersection(leftLine, farLine);
          const farRightPixel = intersection(rightLine, farLine);
          const nearRightPixel = intersection(rightLine, nearLine);
          const nearLeftPixel = intersection(leftLine, nearLine);
          if (!farLeftPixel || !farRightPixel || !nearRightPixel || !nearLeftPixel) continue;

          const corners: CourtDetection["corners"] = [
            { x: farLeftPixel.x / width, y: farLeftPixel.y / height },
            { x: farRightPixel.x / width, y: farRightPixel.y / height },
            { x: nearRightPixel.x / width, y: nearRightPixel.y / height },
            { x: nearLeftPixel.x / width, y: nearLeftPixel.y / height },
          ];
          if (!validateCourtCorners(corners)) continue;

          const farWidth = distance(corners[0], corners[1]);
          const nearWidth = distance(corners[3], corners[2]);
          const widthRatio = farWidth / nearWidth;
          if (widthRatio < 0.25 || widthRatio > 1.25) continue;
          const center = (corners[0].x + corners[1].x + corners[2].x + corners[3].x) / 4;
          const centerScore = 1 - clamp(Math.abs(center - 0.5) / 0.38);
          const coverageScore = clamp(courtHeight / (height * 0.72)) * 0.75
            + clamp(nearWidth / 0.78) * 0.25;
          const farReachScore = 1 - clamp(farY / (height * 0.58));
          const perspectiveScore = 1 - clamp(Math.abs(widthRatio - 0.62) / 0.72);
          const supportScore = (
            farLine.votes + nearLine.votes + leftLine.votes + rightLine.votes
          ) / (maximumVotes * 4);
          const score = supportScore * 0.34 + coverageScore * 0.38
            + perspectiveScore * 0.12 + centerScore * 0.06 + farReachScore * 0.1;
          const confidence = clamp(0.22 + score * 0.72, 0, 0.9);

          if (!best || score > best.score) best = { corners, score, confidence };
        }
      }
    }
  }

  if (!best || best.confidence < 0.46) return null;
  return {
    corners: best.corners,
    confidence: best.confidence,
    diagnostics: `Phát hiện ${horizontalLines.length} vạch ngang và ${sideLines.length} vạch dọc`,
  };
}

export function stagePointToSource(
  point: NormalizedPoint,
  sourceWidth: number,
  sourceHeight: number,
  stageWidth: number,
  stageHeight: number,
) {
  const scale = Math.max(stageWidth / sourceWidth, stageHeight / sourceHeight);
  const renderedWidth = sourceWidth * scale;
  const renderedHeight = sourceHeight * scale;
  const offsetX = (stageWidth - renderedWidth) / 2;
  const offsetY = (stageHeight - renderedHeight) / 2;
  return {
    x: clamp((point.x * stageWidth - offsetX) / renderedWidth),
    y: clamp((point.y * stageHeight - offsetY) / renderedHeight),
  };
}

export function sourcePointToStage(
  point: NormalizedPoint,
  sourceWidth: number,
  sourceHeight: number,
  stageWidth: number,
  stageHeight: number,
) {
  const scale = Math.max(stageWidth / sourceWidth, stageHeight / sourceHeight);
  const renderedWidth = sourceWidth * scale;
  const renderedHeight = sourceHeight * scale;
  const offsetX = (stageWidth - renderedWidth) / 2;
  const offsetY = (stageHeight - renderedHeight) / 2;
  return {
    x: (point.x * renderedWidth + offsetX) / stageWidth,
    y: (point.y * renderedHeight + offsetY) / stageHeight,
  };
}

export function detectCourtCornersFromVideo(video: HTMLVideoElement) {
  if (!video.videoWidth || !video.videoHeight) return null;
  const width = Math.min(360, video.videoWidth);
  const height = Math.max(80, Math.round(width * video.videoHeight / video.videoWidth));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;
  context.drawImage(video, 0, 0, width, height);
  return detectCourtCornersFromPixels(context.getImageData(0, 0, width, height).data, width, height);
}
