import type { jsPDF } from "jspdf";
import type {
  GeometryEntity,
  GeometryPoint,
  MaterialConfig,
  NestingResult,
  PieceItem
} from "../types";
import { removeCollinearPoints } from "./contours";
import {
  dedupeClosingPoint as dedupeClosingPointShared,
  normalizeArcSweep,
  sampleArcPoints,
  sampleEllipseArcPoints,
  sampleEllipsePoints,
  samplePathPoints
} from "./sampling";

type Matrix = {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
};

let jsPdfModulePromise: Promise<typeof import("jspdf")> | null = null;

type DxfHandleState = {
  current: number;
};

type DxfExportContour = {
  points: GeometryPoint[];
  closed: boolean;
};

type LineSegment = {
  start: GeometryPoint;
  end: GeometryPoint;
};

const EXPORT_POINT_TOLERANCE = 0.001;

type SimplePathSegment =
  | { kind: "move"; point: GeometryPoint }
  | { kind: "line"; point: GeometryPoint }
  | { kind: "quadratic"; control: GeometryPoint; point: GeometryPoint }
  | { kind: "cubic"; control1: GeometryPoint; control2: GeometryPoint; point: GeometryPoint }
  | {
      kind: "arc";
      rx: number;
      ry: number;
      rotation: number;
      largeArc: boolean;
      sweep: boolean;
      point: GeometryPoint;
    }
  | { kind: "close" };

type SimplePathCommand =
  | "move"
  | "line"
  | "quadratic"
  | "cubic"
  | "arc"
  | "close";

function findPiece(pieces: PieceItem[], pieceId: string) {
  return pieces.find((piece) => piece.id === pieceId);
}

function getSceneMetrics(material: MaterialConfig, result: NestingResult) {
  const usedSheets = result.usedSheets || 1;
  return {
    sceneWidth: material.width + Math.max(usedSheets - 1, 0) * (material.width + 40),
    sceneHeight: material.height,
    usedSheets
  };
}

function getSheetOffset(material: MaterialConfig, sheetIndex: number) {
  return sheetIndex * (material.width + 40);
}

function translateMatrix(x: number, y: number): Matrix {
  return { a: 1, b: 0, c: 0, d: 1, e: x, f: y };
}

function rotateMatrix(angleDeg: number): Matrix {
  const angle = (angleDeg * Math.PI) / 180;
  return {
    a: Math.cos(angle),
    b: Math.sin(angle),
    c: -Math.sin(angle),
    d: Math.cos(angle),
    e: 0,
    f: 0
  };
}

function multiplyMatrices(left: Matrix, right: Matrix): Matrix {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f
  };
}

function applyMatrix(matrix: Matrix, point: GeometryPoint): GeometryPoint {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f
  };
}

function applyVector(matrix: Matrix, point: GeometryPoint): GeometryPoint {
  return {
    x: matrix.a * point.x + matrix.c * point.y,
    y: matrix.b * point.x + matrix.d * point.y
  };
}

function createDownload(name: string, contents: BlobPart, mimeType: string) {
  const blob = new Blob([contents], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function dedupeClosingPoint(points: GeometryPoint[]) {
  return dedupeClosingPointShared(points);
}

function pointKey(point: GeometryPoint) {
  return `${point.x.toFixed(3)},${point.y.toFixed(3)}`;
}

function segmentKey(start: GeometryPoint, end: GeometryPoint) {
  const a = pointKey(start);
  const b = pointKey(end);
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function contoursToSegments(contours: DxfExportContour[]) {
  const segments: LineSegment[] = [];

  contours.forEach((contour) => {
    for (let index = 0; index < contour.points.length - 1; index += 1) {
      const start = contour.points[index];
      const end = contour.points[index + 1];
      if (Math.abs(start.x - end.x) < 0.001 && Math.abs(start.y - end.y) < 0.001) {
        continue;
      }
      segments.push({ start, end });
    }

    if (contour.closed && contour.points.length > 2) {
      const start = contour.points[contour.points.length - 1];
      const end = contour.points[0];
      if (Math.abs(start.x - end.x) >= 0.001 || Math.abs(start.y - end.y) >= 0.001) {
        segments.push({ start, end });
      }
    }
  });

  return segments;
}

function buildAdjacency(segments: LineSegment[]) {
  const adjacency = new Map<string, LineSegment[]>();

  segments.forEach((segment) => {
    const startKey = pointKey(segment.start);
    const endKey = pointKey(segment.end);
    const startBucket = adjacency.get(startKey) ?? [];
    startBucket.push(segment);
    adjacency.set(startKey, startBucket);
    const endBucket = adjacency.get(endKey) ?? [];
    endBucket.push(segment);
    adjacency.set(endKey, endBucket);
  });

  return adjacency;
}

function rebuildContoursFromSegments(segments: LineSegment[]) {
  const remaining = new Set(segments);
  const adjacency = buildAdjacency(segments);
  const contours: DxfExportContour[] = [];

  while (remaining.size) {
    const seed = remaining.values().next().value as LineSegment;
    remaining.delete(seed);
    const chain: GeometryPoint[] = [seed.start, seed.end];
    let extended = true;

    while (extended) {
      extended = false;

      const head = chain[0];
      const tail = chain[chain.length - 1];
      const headCandidates = adjacency.get(pointKey(head)) ?? [];
      const tailCandidates = adjacency.get(pointKey(tail)) ?? [];

      for (const candidate of tailCandidates) {
        if (!remaining.has(candidate)) {
          continue;
        }

        const nextPoint =
          pointKey(candidate.start) === pointKey(tail) ? candidate.end : candidate.start;
        chain.push(nextPoint);
        remaining.delete(candidate);
        extended = true;
        break;
      }

      if (extended) {
        continue;
      }

      for (const candidate of headCandidates) {
        if (!remaining.has(candidate)) {
          continue;
        }

        const nextPoint =
          pointKey(candidate.start) === pointKey(head) ? candidate.end : candidate.start;
        chain.unshift(nextPoint);
        remaining.delete(candidate);
        extended = true;
        break;
      }
    }

    const closed = chain.length > 2 && pointKey(chain[0]) === pointKey(chain[chain.length - 1]);
    const normalizedPoints = removeCollinearPoints(
      closed ? dedupeClosingPoint(chain) : chain,
      0.001,
      closed
    );
    contours.push({
      points: normalizedPoints,
      closed
    });
  }

  return contours;
}

export function mergeCommonLineContours(contours: DxfExportContour[]) {
  const counts = new Map<string, number>();
  const segments = contoursToSegments(contours);

  segments.forEach((segment) => {
    const key = segmentKey(segment.start, segment.end);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  });

  const filtered = segments.filter((segment) => (counts.get(segmentKey(segment.start, segment.end)) ?? 0) === 1);
  if (!filtered.length) {
    return contours;
  }

  return rebuildContoursFromSegments(filtered);
}

function contourBounds(contour: DxfExportContour) {
  return {
    minX: Math.min(...contour.points.map((point) => point.x)),
    minY: Math.min(...contour.points.map((point) => point.y)),
    maxX: Math.max(...contour.points.map((point) => point.x)),
    maxY: Math.max(...contour.points.map((point) => point.y))
  };
}

function contourArea(points: GeometryPoint[]) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return Math.abs(area / 2);
}

function contourLength(points: GeometryPoint[]) {
  let length = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    length += Math.hypot(end.x - start.x, end.y - start.y);
  }
  return length;
}

function reversePoints<T>(points: T[]) {
  return points.slice().reverse();
}

function pointsNearEqual(left: GeometryPoint[], right: GeometryPoint[], tolerance = 0.12) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((point, index) => {
    const candidate = right[index];
    return Math.abs(point.x - candidate.x) <= tolerance && Math.abs(point.y - candidate.y) <= tolerance;
  });
}

function isDegenerateExportContour(contour: DxfExportContour) {
  if (contour.points.length < (contour.closed ? 3 : 2)) {
    return true;
  }

  const bounds = contourBounds(contour);
  if (
    Math.abs(bounds.maxX - bounds.minX) < EXPORT_POINT_TOLERANCE &&
    Math.abs(bounds.maxY - bounds.minY) < EXPORT_POINT_TOLERANCE
  ) {
    return true;
  }

  if (contour.closed) {
    return contourArea(contour.points) < 0.05;
  }

  return contourLength(contour.points) < 0.25;
}

function dedupeExportContours(contours: DxfExportContour[]) {
  const deduped: DxfExportContour[] = [];

  contours.forEach((contour) => {
    if (isDegenerateExportContour(contour)) {
      return;
    }

    const exists = deduped.some((candidate) => {
      if (candidate.closed !== contour.closed) {
        return false;
      }

      return (
        pointsNearEqual(candidate.points, contour.points) ||
        pointsNearEqual(candidate.points, reversePoints(contour.points))
      );
    });

    if (!exists) {
      deduped.push(contour);
    }
  });

  return deduped;
}

async function loadJsPdf() {
  if (!jsPdfModulePromise) {
    jsPdfModulePromise = import("jspdf");
  }

  return jsPdfModulePromise;
}

function normalizeDegrees(angle: number) {
  return ((angle % 360) + 360) % 360;
}

function normalizeRadians(angle: number) {
  return ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
}

function normalizeEllipseParams(startParam: number, endParam: number) {
  const normalizedStart = normalizeRadians(startParam);
  let normalizedEnd = normalizeRadians(endParam);

  while (normalizedEnd <= normalizedStart) {
    normalizedEnd += Math.PI * 2;
  }

  return {
    startParam: normalizedStart,
    endParam: normalizedEnd
  };
}

function parseSimpleSvgPath(pathData: string, offsetX: number, offsetY: number): SimplePathSegment[] | null {
  const tokens = pathData.match(/[MLHVCSQTAZmlhvcsqtaz]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi);
  if (!tokens?.length) {
    return null;
  }

  const segments: SimplePathSegment[] = [];
  let index = 0;
  let currentX = 0;
  let currentY = 0;
  let subpathStartX = 0;
  let subpathStartY = 0;
  let previousCommand: SimplePathCommand | null = null;
  let previousQuadraticControl: GeometryPoint | null = null;
  let previousCubicControl2: GeometryPoint | null = null;
  let activeCommand: string | null = null;

  const isPathCommand = (token: string | undefined) => token != null && /^[MLHVCSQTAZmlhvcsqtaz]$/.test(token);

  const readPoint = (relative: boolean) => {
    const x = Number(tokens[index]);
    const y = Number(tokens[index + 1]);
    index += 2;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }

    const point = {
      x: (relative ? currentX + x : x) - offsetX,
      y: (relative ? currentY + y : y) - offsetY
    };
    currentX = relative ? currentX + x : x;
    currentY = relative ? currentY + y : y;
    return point;
  };

  while (index < tokens.length) {
    const token = tokens[index];
    if (isPathCommand(token)) {
      activeCommand = token;
      index += 1;
    } else if (!activeCommand) {
      return null;
    }

    const command: string | null = activeCommand;
    if (!command) {
      return null;
    }

    if (command === "M" || command === "m") {
      const relative: boolean = command === "m";
      const point = readPoint(relative);
      if (!point) {
        return null;
      }
      subpathStartX = currentX;
      subpathStartY = currentY;
      segments.push({
        kind: "move",
        point
      });
      previousCommand = "move";
      previousQuadraticControl = null;
      previousCubicControl2 = null;
      activeCommand = relative ? "l" : "L";
      continue;
    }

    if (command === "L" || command === "l") {
      const point = readPoint(command === "l");
      if (!point) {
        return null;
      }
      segments.push({
        kind: "line",
        point
      });
      previousCommand = "line";
      previousQuadraticControl = null;
      previousCubicControl2 = null;
      continue;
    }

    if (command === "H" || command === "h") {
      const x = Number(tokens[index]);
      index += 1;
      if (!Number.isFinite(x)) {
        return null;
      }
      currentX = command === "h" ? currentX + x : x;
      segments.push({
        kind: "line",
        point: { x: currentX - offsetX, y: currentY - offsetY }
      });
      previousCommand = "line";
      previousQuadraticControl = null;
      previousCubicControl2 = null;
      continue;
    }

    if (command === "V" || command === "v") {
      const y = Number(tokens[index]);
      index += 1;
      if (!Number.isFinite(y)) {
        return null;
      }
      currentY = command === "v" ? currentY + y : y;
      segments.push({
        kind: "line",
        point: { x: currentX - offsetX, y: currentY - offsetY }
      });
      previousCommand = "line";
      previousQuadraticControl = null;
      previousCubicControl2 = null;
      continue;
    }

    if (command === "A" || command === "a") {
      const rx = Number(tokens[index]);
      const ry = Number(tokens[index + 1]);
      const rotation = Number(tokens[index + 2]);
      const largeArc = Number(tokens[index + 3]);
      const sweep = Number(tokens[index + 4]);
      const x = Number(tokens[index + 5]);
      const y = Number(tokens[index + 6]);
      index += 7;
      if (![rx, ry, rotation, largeArc, sweep, x, y].every(Number.isFinite)) {
        return null;
      }
      currentX = command === "a" ? currentX + x : x;
      currentY = command === "a" ? currentY + y : y;
      segments.push({
        kind: "arc",
        rx,
        ry,
        rotation,
        largeArc: Boolean(largeArc),
        sweep: Boolean(sweep),
        point: { x: currentX - offsetX, y: currentY - offsetY }
      });
      previousCommand = "arc";
      previousQuadraticControl = null;
      previousCubicControl2 = null;
      continue;
    }

    if (command === "Q" || command === "q") {
      const cx = Number(tokens[index]);
      const cy = Number(tokens[index + 1]);
      const x = Number(tokens[index + 2]);
      const y = Number(tokens[index + 3]);
      index += 4;
      if (![cx, cy, x, y].every(Number.isFinite)) {
        return null;
      }
      const control = {
        x: (command === "q" ? currentX + cx : cx) - offsetX,
        y: (command === "q" ? currentY + cy : cy) - offsetY
      };
      currentX = command === "q" ? currentX + x : x;
      currentY = command === "q" ? currentY + y : y;
      segments.push({
        kind: "quadratic",
        control,
        point: { x: currentX - offsetX, y: currentY - offsetY }
      });
      previousCommand = "quadratic";
      previousQuadraticControl = control;
      previousCubicControl2 = null;
      continue;
    }

    if (command === "T" || command === "t") {
      const x = Number(tokens[index]);
      const y = Number(tokens[index + 1]);
      index += 2;
      if (![x, y].every(Number.isFinite)) {
        return null;
      }

      const startPoint = { x: currentX - offsetX, y: currentY - offsetY };
      const control: GeometryPoint =
        previousCommand === "quadratic" && previousQuadraticControl
          ? {
              x: startPoint.x * 2 - previousQuadraticControl.x,
              y: startPoint.y * 2 - previousQuadraticControl.y
            }
          : startPoint;

      currentX = command === "t" ? currentX + x : x;
      currentY = command === "t" ? currentY + y : y;
      segments.push({
        kind: "quadratic",
        control,
        point: { x: currentX - offsetX, y: currentY - offsetY }
      });
      previousCommand = "quadratic";
      previousQuadraticControl = control;
      previousCubicControl2 = null;
      continue;
    }

    if (command === "C" || command === "c") {
      const c1x = Number(tokens[index]);
      const c1y = Number(tokens[index + 1]);
      const c2x = Number(tokens[index + 2]);
      const c2y = Number(tokens[index + 3]);
      const x = Number(tokens[index + 4]);
      const y = Number(tokens[index + 5]);
      index += 6;
      if (![c1x, c1y, c2x, c2y, x, y].every(Number.isFinite)) {
        return null;
      }
      const control1 = {
        x: (command === "c" ? currentX + c1x : c1x) - offsetX,
        y: (command === "c" ? currentY + c1y : c1y) - offsetY
      };
      const control2 = {
        x: (command === "c" ? currentX + c2x : c2x) - offsetX,
        y: (command === "c" ? currentY + c2y : c2y) - offsetY
      };
      currentX = command === "c" ? currentX + x : x;
      currentY = command === "c" ? currentY + y : y;
      segments.push({
        kind: "cubic",
        control1,
        control2,
        point: { x: currentX - offsetX, y: currentY - offsetY }
      });
      previousCommand = "cubic";
      previousQuadraticControl = null;
      previousCubicControl2 = control2;
      continue;
    }

    if (command === "S" || command === "s") {
      const c2x = Number(tokens[index]);
      const c2y = Number(tokens[index + 1]);
      const x = Number(tokens[index + 2]);
      const y = Number(tokens[index + 3]);
      index += 4;
      if (![c2x, c2y, x, y].every(Number.isFinite)) {
        return null;
      }

      const startPoint = { x: currentX - offsetX, y: currentY - offsetY };
      const control1: GeometryPoint =
        previousCommand === "cubic" && previousCubicControl2
          ? {
              x: startPoint.x * 2 - previousCubicControl2.x,
              y: startPoint.y * 2 - previousCubicControl2.y
            }
          : startPoint;
      const control2: GeometryPoint = {
        x: (command === "s" ? currentX + c2x : c2x) - offsetX,
        y: (command === "s" ? currentY + c2y : c2y) - offsetY
      };
      currentX = command === "s" ? currentX + x : x;
      currentY = command === "s" ? currentY + y : y;
      segments.push({
        kind: "cubic",
        control1,
        control2,
        point: { x: currentX - offsetX, y: currentY - offsetY }
      });
      previousCommand = "cubic";
      previousQuadraticControl = null;
      previousCubicControl2 = control2;
      continue;
    }

    if (command === "Z" || command === "z") {
      currentX = subpathStartX;
      currentY = subpathStartY;
      segments.push({ kind: "close" });
      previousCommand = "close";
      previousQuadraticControl = null;
      previousCubicControl2 = null;
      activeCommand = null;
      continue;
    }

    return null;
  }

  return segments;
}

function sampleQuadraticBezierPoints(
  start: GeometryPoint,
  control: GeometryPoint,
  end: GeometryPoint,
  segments = 24
) {
  const points: GeometryPoint[] = [];
  for (let index = 1; index <= segments; index += 1) {
    const t = index / segments;
    const mt = 1 - t;
    points.push({
      x: mt * mt * start.x + 2 * mt * t * control.x + t * t * end.x,
      y: mt * mt * start.y + 2 * mt * t * control.y + t * t * end.y
    });
  }
  return points;
}

function sampleCubicBezierPoints(
  start: GeometryPoint,
  control1: GeometryPoint,
  control2: GeometryPoint,
  end: GeometryPoint,
  segments = 32
) {
  const points: GeometryPoint[] = [];
  for (let index = 1; index <= segments; index += 1) {
    const t = index / segments;
    const mt = 1 - t;
    points.push({
      x:
        mt * mt * mt * start.x +
        3 * mt * mt * t * control1.x +
        3 * mt * t * t * control2.x +
        t * t * t * end.x,
      y:
        mt * mt * mt * start.y +
        3 * mt * mt * t * control1.y +
        3 * mt * t * t * control2.y +
        t * t * t * end.y
    });
  }
  return points;
}

function vectorAngle(ux: number, uy: number, vx: number, vy: number) {
  const dot = ux * vx + uy * vy;
  const lengths = Math.hypot(ux, uy) * Math.hypot(vx, vy);
  const safe = lengths ? Math.max(-1, Math.min(1, dot / lengths)) : 1;
  const angle = Math.acos(safe);
  return ux * vy - uy * vx < 0 ? -angle : angle;
}

function svgArcToCenter(
  start: GeometryPoint,
  end: GeometryPoint,
  rx: number,
  ry: number,
  rotationDeg: number,
  largeArc: boolean,
  sweep: boolean
) {
  const phi = (rotationDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (start.x - end.x) / 2;
  const dy = (start.y - end.y) / 2;
  const x1Prime = cosPhi * dx + sinPhi * dy;
  const y1Prime = -sinPhi * dx + cosPhi * dy;

  let adjustedRx = Math.abs(rx);
  let adjustedRy = Math.abs(ry);
  if (adjustedRx < 0.000001 || adjustedRy < 0.000001) {
    return null;
  }

  const lambda =
    (x1Prime * x1Prime) / (adjustedRx * adjustedRx) +
    (y1Prime * y1Prime) / (adjustedRy * adjustedRy);
  if (lambda > 1) {
    const scale = Math.sqrt(lambda);
    adjustedRx *= scale;
    adjustedRy *= scale;
  }

  const numerator =
    adjustedRx * adjustedRx * adjustedRy * adjustedRy -
    adjustedRx * adjustedRx * y1Prime * y1Prime -
    adjustedRy * adjustedRy * x1Prime * x1Prime;
  const denominator =
    adjustedRx * adjustedRx * y1Prime * y1Prime +
    adjustedRy * adjustedRy * x1Prime * x1Prime;
  const factorBase = denominator === 0 ? 0 : Math.max(0, numerator / denominator);
  const factor = (largeArc === sweep ? -1 : 1) * Math.sqrt(factorBase);
  const cxPrime = factor * ((adjustedRx * y1Prime) / adjustedRy);
  const cyPrime = factor * ((-adjustedRy * x1Prime) / adjustedRx);

  const cx = cosPhi * cxPrime - sinPhi * cyPrime + (start.x + end.x) / 2;
  const cy = sinPhi * cxPrime + cosPhi * cyPrime + (start.y + end.y) / 2;

  const theta1 = vectorAngle(1, 0, (x1Prime - cxPrime) / adjustedRx, (y1Prime - cyPrime) / adjustedRy);
  let deltaTheta = vectorAngle(
    (x1Prime - cxPrime) / adjustedRx,
    (y1Prime - cyPrime) / adjustedRy,
    (-x1Prime - cxPrime) / adjustedRx,
    (-y1Prime - cyPrime) / adjustedRy
  );

  if (!sweep && deltaTheta > 0) {
    deltaTheta -= Math.PI * 2;
  }
  if (sweep && deltaTheta < 0) {
    deltaTheta += Math.PI * 2;
  }

  return {
    cx,
    cy,
    rx: adjustedRx,
    ry: adjustedRy,
    theta1,
    deltaTheta
  };
}

function getPlacementMatrix(piece: PieceItem, material: MaterialConfig, placement: NestingResult["placements"][number]) {
  return multiplyMatrices(
    translateMatrix(getSheetOffset(material, placement.sheetIndex) + placement.x, placement.y),
    rotateMatrix(placement.rotation)
  );
}

function transformPolylinePoints(points: GeometryPoint[], matrix: Matrix) {
  return points.map((point) => applyMatrix(matrix, point));
}

function getRenderableEntityPoints(piece: PieceItem, entity: GeometryEntity, matrix: Matrix) {
  const offsetX = piece.geometry.sourceBounds.minX;
  const offsetY = piece.geometry.sourceBounds.minY;

  switch (entity.kind) {
    case "polyline":
      return transformPolylinePoints(entity.points, matrix);
    case "circle":
      return transformPolylinePoints(
        sampleEllipsePoints(entity.cx, entity.cy, entity.r, entity.r, 0, 96),
        matrix
      );
    case "ellipse":
      return transformPolylinePoints(
        sampleEllipsePoints(entity.cx, entity.cy, entity.rx, entity.ry, entity.rotation, 96),
        matrix
      );
    case "ellipseArc":
      return transformPolylinePoints(sampleEllipseArcPoints(entity, 96), matrix);
    case "arc":
      return transformPolylinePoints(sampleArcPoints(entity, 72), matrix);
    case "path":
      return transformPolylinePoints(
        samplePathPoints(entity.d, {
          offsetX,
          offsetY,
          closed: entity.closed,
          minSegments: 48,
          maxSegments: 960,
          segmentLength: 2.5
        }),
        matrix
      );
    default:
      return [];
  }
}

function buildPlacedEntities(piece: PieceItem, material: MaterialConfig, placement: NestingResult["placements"][number]) {
  const matrix = getPlacementMatrix(piece, material, placement);
  return piece.geometry.entities.map((entity) => ({ entity, matrix }));
}

function isClosedEntity(entity: GeometryEntity) {
  if (entity.kind === "polyline") {
    return entity.closed;
  }

  if (entity.kind === "path") {
    return entity.closed;
  }

  return entity.kind !== "arc" && entity.kind !== "ellipseArc";
}

function buildFallbackContoursForEntity(piece: PieceItem, entity: GeometryEntity, matrix: Matrix) {
  const points = getRenderableEntityPoints(piece, entity, matrix);
  if (points.length < 2) {
    return [] as DxfExportContour[];
  }

  return [
    {
      points,
      closed: isClosedEntity(entity)
    }
  ];
}

function buildPlacementContours(
  piece: PieceItem,
  material: MaterialConfig,
  placement: NestingResult["placements"][number]
) {
  const contours = buildPlacedEntities(piece, material, placement).flatMap(({ entity, matrix }) =>
    buildFallbackContoursForEntity(piece, entity, matrix)
  );

  return contours
    .map((contour) => ({
      closed: contour.closed,
      points: contour.closed
        ? dedupeClosingPoint(removeCollinearPoints(contour.points, 0.001, true))
        : removeCollinearPoints(contour.points, 0.001, false)
    }))
    .filter((contour) => contour.points.length >= (contour.closed ? 3 : 2));
}

function contourToSvgMarkup(contour: DxfExportContour) {
  const points = contour.points
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => `${point.x},${point.y}`)
    .join(" ");

  if (!points) {
    return "";
  }

  return `<${contour.closed ? "polygon" : "polyline"} fill="none" stroke="#111" stroke-width="1" points="${points}" />`;
}

export function buildResultSvg(pieces: PieceItem[], material: MaterialConfig, result: NestingResult) {
  const { sceneWidth, sceneHeight } = getSceneMetrics(material, result);
  const markup = buildDxfExportContours(pieces, material, result).map(contourToSvgMarkup).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${sceneWidth} ${sceneHeight}">
    ${markup}
  </svg>`;
}

export function downloadSvg(pieces: PieceItem[], material: MaterialConfig, result: NestingResult) {
  createDownload("nesting-resultado.svg", buildResultSvg(pieces, material, result), "image/svg+xml;charset=utf-8");
}

function buildDxfExportContours(pieces: PieceItem[], material: MaterialConfig, result: NestingResult) {
  const contours: DxfExportContour[] = [];

  result.placements.forEach((placement) => {
    const piece = findPiece(pieces, placement.pieceId);
    if (!piece) {
      return;
    }

    contours.push(...buildPlacementContours(piece, material, placement));
  });

  return dedupeExportContours(mergeCommonLineContours(contours));
}

async function downloadDxfFromApi(pieces: PieceItem[], material: MaterialConfig, result: NestingResult) {
  const baseUrl = (import.meta as ImportMeta & { env?: { VITE_API_BASE_URL?: string } }).env?.VITE_API_BASE_URL?.trim() ?? "";
  if (!baseUrl) {
    throw new Error("Falta configurar la exportacion DXF del servidor.");
  }

  const contours = buildDxfExportContours(pieces, material, result);
  if (!contours.length) {
    throw new Error("No hay contornos validos para exportar a DXF.");
  }

  const endpoint = `${baseUrl.replace(/\/$/, "")}/api/export/dxf`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      material,
      usedSheets: result.usedSheets || 1,
      contours
    })
  });

  if (!response.ok) {
    throw new Error("No fue posible generar el DXF en el servidor.");
  }

  const dxf = await response.text();
  if (!dxf.trim().startsWith("0")) {
    throw new Error("El servidor no devolvio un DXF valido.");
  }

  createDownload("nesting-resultado.dxf", dxf, "application/dxf");
}

function drawPolylinePdf(doc: jsPDF, points: GeometryPoint[], closed: boolean, sceneHeight: number) {
  if (points.length < 2) {
    return;
  }

  const [first, ...rest] = points;
  const lines = rest.map((point, index) => {
    const previous = index === 0 ? first : rest[index - 1];
    return [point.x - previous.x, -(point.y - previous.y)];
  });

  doc.lines(lines, first.x, sceneHeight - first.y, [1, 1], "S", closed);
}

export async function downloadPdf(pieces: PieceItem[], material: MaterialConfig, result: NestingResult) {
  const { sceneWidth, sceneHeight } = getSceneMetrics(material, result);
  const { jsPDF } = await loadJsPdf();
  const doc = new jsPDF({
    orientation: sceneWidth >= sceneHeight ? "landscape" : "portrait",
    unit: "mm",
    format: [sceneWidth, sceneHeight]
  });

  doc.setDrawColor(17, 17, 17);
  doc.setLineWidth(0.2);
  const contours = buildDxfExportContours(pieces, material, result);
  contours.forEach((contour) => {
    drawPolylinePdf(doc, contour.points, contour.closed, sceneHeight);
  });

  doc.save("nesting-resultado.pdf");
}

function dxfPair(code: number | string, value: number | string) {
  return `${code}\n${value}\n`;
}

function nextDxfHandle(state: DxfHandleState) {
  const handle = state.current.toString(16).toUpperCase();
  state.current += 1;
  return handle;
}

function toDxfY(sceneHeight: number, y: number) {
  return sceneHeight - y;
}

function buildEntityPrelude(type: string, handle: string, subclasses: string[]) {
  return [
    dxfPair(0, type),
    dxfPair(5, handle),
    dxfPair(100, "AcDbEntity"),
    dxfPair(8, 0),
    ...subclasses.map((subclass) => dxfPair(100, subclass))
  ].join("");
}

function buildNamedTableRecordPrelude(
  type: string,
  handle: string,
  ownerHandle: string,
  name: string,
  subclasses: string[]
) {
  return [
    dxfPair(0, type),
    dxfPair(5, handle),
    dxfPair(330, ownerHandle),
    dxfPair(100, "AcDbSymbolTableRecord"),
    dxfPair(100, "AcDbSymbolTable"),
    ...subclasses.map((subclass) => dxfPair(100, subclass)),
    dxfPair(2, name)
  ].join("");
}

function buildPolylineEntity(
  points: GeometryPoint[],
  closed: boolean,
  sceneHeight: number,
  handle: string
) {
  const uniquePoints = [...points];
  if (closed && uniquePoints.length > 1) {
    const first = uniquePoints[0];
    const last = uniquePoints[uniquePoints.length - 1];
    if (Math.abs(first.x - last.x) < 0.001 && Math.abs(first.y - last.y) < 0.001) {
      uniquePoints.pop();
    }
  }

  if (uniquePoints.length < 2) {
    return "";
  }

  return [
    buildEntityPrelude("LWPOLYLINE", handle, ["AcDbPolyline"]),
    dxfPair(90, uniquePoints.length),
    dxfPair(70, closed ? 1 : 0),
    dxfPair(43, 0),
    dxfPair(38, 0),
    dxfPair(39, 0),
    uniquePoints
      .map((point) => `${dxfPair(10, point.x.toFixed(4))}${dxfPair(20, toDxfY(sceneHeight, point.y).toFixed(4))}`)
      .join("")
  ].join("");
}

function buildCircleEntity(
  cx: number,
  cy: number,
  radius: number,
  sceneHeight: number,
  handle: string
) {
  return [
    buildEntityPrelude("CIRCLE", handle, ["AcDbCircle"]),
    dxfPair(10, cx.toFixed(4)),
    dxfPair(20, toDxfY(sceneHeight, cy).toFixed(4)),
    dxfPair(30, 0),
    dxfPair(40, radius.toFixed(4))
  ].join("");
}

function buildArcEntity(
  cx: number,
  cy: number,
  radius: number,
  startAngleDeg: number,
  endAngleDeg: number,
  sceneHeight: number,
  handle: string
) {
  return [
    buildEntityPrelude("ARC", handle, ["AcDbCircle", "AcDbArc"]),
    dxfPair(10, cx.toFixed(4)),
    dxfPair(20, toDxfY(sceneHeight, cy).toFixed(4)),
    dxfPair(30, 0),
    dxfPair(40, radius.toFixed(4)),
    dxfPair(50, startAngleDeg.toFixed(4)),
    dxfPair(51, endAngleDeg.toFixed(4))
  ].join("");
}

function buildEllipseEntity(
  cx: number,
  cy: number,
  majorAxisX: number,
  majorAxisY: number,
  axisRatio: number,
  sceneHeight: number,
  handle: string,
  startParam = 0,
  endParam = Math.PI * 2
) {
  const normalized = normalizeEllipseParams(startParam, endParam);
  return [
    buildEntityPrelude("ELLIPSE", handle, ["AcDbEllipse"]),
    dxfPair(10, cx.toFixed(4)),
    dxfPair(20, toDxfY(sceneHeight, cy).toFixed(4)),
    dxfPair(30, 0),
    dxfPair(11, majorAxisX.toFixed(4)),
    dxfPair(21, (-majorAxisY).toFixed(4)),
    dxfPair(31, 0),
    dxfPair(40, axisRatio.toFixed(6)),
    dxfPair(41, normalized.startParam.toFixed(6)),
    dxfPair(42, normalized.endParam.toFixed(6))
  ].join("");
}

function decomposeMatrix(matrix: Matrix) {
  const scaleX = Math.hypot(matrix.a, matrix.b);
  const scaleY = Math.hypot(matrix.c, matrix.d);
  const rotation = Math.atan2(matrix.b, matrix.a);
  return {
    scaleX,
    scaleY,
    rotation
  };
}

function pushPathPolyline(
  entities: string[],
  points: GeometryPoint[],
  closed: boolean,
  sceneHeight: number,
  handleState: DxfHandleState
) {
  if (points.length < 2) {
    return;
  }

  entities.push(buildPolylineEntity(points, closed, sceneHeight, nextDxfHandle(handleState)));
}

function buildPathDxfEntities(
  piece: PieceItem,
  entity: Extract<GeometryEntity, { kind: "path" }>,
  matrix: Matrix,
  sceneHeight: number,
  handleState: DxfHandleState
): string[] | null {
  const parsed = parseSimpleSvgPath(
    entity.d,
    piece.geometry.sourceBounds.minX,
    piece.geometry.sourceBounds.minY
  );

  if (!parsed?.length) {
    return null;
  }

  const { scaleX, scaleY } = decomposeMatrix(matrix);
  let currentPoint: GeometryPoint | null = null;
  let subpathStart: GeometryPoint | null = null;
  let polylinePoints: GeometryPoint[] = [];
  let failed = false;

  const flushPolyline = (closed = false) => {
    pushPathPolyline(handleEntities, polylinePoints, closed, sceneHeight, handleState);
    polylinePoints = [];
  };

  const handleEntities: string[] = [];

  parsed.forEach((segment) => {
    if (failed) {
      return;
    }

    if (segment.kind === "move") {
      flushPolyline(false);
      currentPoint = segment.point;
      subpathStart = segment.point;
      polylinePoints = [applyMatrix(matrix, segment.point)];
      return;
    }

    if (!currentPoint) {
      return;
    }

    if (segment.kind === "line") {
      currentPoint = segment.point;
      polylinePoints.push(applyMatrix(matrix, segment.point));
      return;
    }

    if (segment.kind === "quadratic") {
      const sampled = sampleQuadraticBezierPoints(currentPoint, segment.control, segment.point).map((point) =>
        applyMatrix(matrix, point)
      );
      polylinePoints.push(...sampled);
      currentPoint = segment.point;
      return;
    }

    if (segment.kind === "cubic") {
      const sampled = sampleCubicBezierPoints(
        currentPoint,
        segment.control1,
        segment.control2,
        segment.point
      ).map((point) => applyMatrix(matrix, point));
      polylinePoints.push(...sampled);
      currentPoint = segment.point;
      return;
    }

    if (segment.kind === "close") {
      if (subpathStart) {
        polylinePoints.push(applyMatrix(matrix, subpathStart));
      }
      flushPolyline(true);
      currentPoint = subpathStart;
      polylinePoints = currentPoint ? [applyMatrix(matrix, currentPoint)] : [];
      return;
    }

    flushPolyline(false);

    if (
      Math.abs(segment.rx - segment.ry) < 0.0001 &&
      Math.abs(segment.rotation) < 0.0001 &&
      Math.abs(scaleX - scaleY) < 0.0001
    ) {
      const arc = svgArcToCenter(
        currentPoint,
        segment.point,
        segment.rx,
        segment.ry,
        segment.rotation,
        segment.largeArc,
        segment.sweep
      );

      if (arc) {
        const transformedStart = applyMatrix(matrix, currentPoint);
        const transformedEnd = applyMatrix(matrix, segment.point);
        const transformedCenter = applyMatrix(matrix, { x: arc.cx, y: arc.cy });
        const startAngle = normalizeDegrees(
          (Math.atan2(-(transformedStart.y - transformedCenter.y), transformedStart.x - transformedCenter.x) * 180) /
            Math.PI
        );
        const endAngle = normalizeDegrees(
          (Math.atan2(-(transformedEnd.y - transformedCenter.y), transformedEnd.x - transformedCenter.x) * 180) /
            Math.PI
        );
        const radius = segment.rx * scaleX;
        const deltaDxf = -arc.deltaTheta;

        handleEntities.push(
          buildArcEntity(
            transformedCenter.x,
            transformedCenter.y,
            radius,
            deltaDxf >= 0 ? startAngle : endAngle,
            deltaDxf >= 0 ? endAngle : startAngle,
            sceneHeight,
            nextDxfHandle(handleState)
          )
        );
        currentPoint = segment.point;
        polylinePoints = [applyMatrix(matrix, segment.point)];
        return;
      }
    }

    failed = true;
  });

  flushPolyline(false);

  if (failed || !handleEntities.length) {
    return null;
  }

  return handleEntities;
}

function getDxfInsUnits(unit: MaterialConfig["unit"]) {
  if (unit === "cm") {
    return 5;
  }

  if (unit === "in") {
    return 1;
  }

  return 4;
}

function buildTable(name: string, handle: string, ownerHandle: string, entries: string[], count: number) {
  return [
    dxfPair(0, "TABLE"),
    dxfPair(5, handle),
    dxfPair(330, ownerHandle),
    dxfPair(100, "AcDbSymbolTable"),
    dxfPair(2, name),
    dxfPair(70, count),
    entries.join(""),
    dxfPair(0, "ENDTAB")
  ].join("");
}

function buildBlockRecord(name: string, handle: string, ownerHandle: string) {
  return [
    dxfPair(0, "BLOCK_RECORD"),
    dxfPair(5, handle),
    dxfPair(330, ownerHandle),
    dxfPair(100, "AcDbSymbolTableRecord"),
    dxfPair(100, "AcDbBlockTableRecord"),
    dxfPair(2, name)
  ].join("");
}

function buildBlock(name: string, handle: string, ownerHandle: string, endHandle: string) {
  return [
    dxfPair(0, "BLOCK"),
    dxfPair(5, handle),
    dxfPair(330, ownerHandle),
    dxfPair(100, "AcDbEntity"),
    dxfPair(8, 0),
    dxfPair(100, "AcDbBlockBegin"),
    dxfPair(2, name),
    dxfPair(70, 0),
    dxfPair(10, 0),
    dxfPair(20, 0),
    dxfPair(30, 0),
    dxfPair(3, name),
    dxfPair(1, ""),
    dxfPair(0, "ENDBLK"),
    dxfPair(5, endHandle),
    dxfPair(330, ownerHandle),
    dxfPair(100, "AcDbEntity"),
    dxfPair(8, 0),
    dxfPair(100, "AcDbBlockEnd")
  ].join("");
}

export function buildResultDxf(pieces: PieceItem[], material: MaterialConfig, result: NestingResult) {
  const { sceneWidth, sceneHeight } = getSceneMetrics(material, result);
  const entities: string[] = [];
  const handleState: DxfHandleState = { current: 0x100 };
  const rootDictionaryHandle = nextDxfHandle(handleState);
  const tablesHandle = nextDxfHandle(handleState);
  const ltypeTableHandle = nextDxfHandle(handleState);
  const layerTableHandle = nextDxfHandle(handleState);
  const styleTableHandle = nextDxfHandle(handleState);
  const appIdTableHandle = nextDxfHandle(handleState);
  const blockRecordTableHandle = nextDxfHandle(handleState);
  const viewportTableHandle = nextDxfHandle(handleState);
  const modelSpaceRecordHandle = nextDxfHandle(handleState);
  const paperSpaceRecordHandle = nextDxfHandle(handleState);
  const continuousLtypeHandle = nextDxfHandle(handleState);
  const layerZeroHandle = nextDxfHandle(handleState);
  const styleStandardHandle = nextDxfHandle(handleState);
  const appIdAcadHandle = nextDxfHandle(handleState);
  const viewportActiveHandle = nextDxfHandle(handleState);
  const modelSpaceBlockHandle = nextDxfHandle(handleState);
  const modelSpaceEndHandle = nextDxfHandle(handleState);
  const paperSpaceBlockHandle = nextDxfHandle(handleState);
  const paperSpaceEndHandle = nextDxfHandle(handleState);

  result.placements.forEach((placement) => {
    const piece = findPiece(pieces, placement.pieceId);
    if (!piece) {
      return;
    }

    const fallbackContours: DxfExportContour[] = [];

    buildPlacedEntities(piece, material, placement).forEach(({ entity, matrix }) => {
      if (entity.kind === "circle") {
        const center = applyMatrix(matrix, { x: entity.cx, y: entity.cy });
        const { scaleX, scaleY } = decomposeMatrix(matrix);
        if (Math.abs(scaleX - scaleY) < 0.0001) {
          entities.push(
            buildCircleEntity(
              center.x,
              center.y,
              entity.r * scaleX,
              sceneHeight,
              nextDxfHandle(handleState)
            )
          );
          return;
        }

        fallbackContours.push(...buildFallbackContoursForEntity(piece, entity, matrix));
        return;
      }

      if (entity.kind === "arc") {
        const center = applyMatrix(matrix, { x: entity.cx, y: entity.cy });
        const { scaleX, scaleY, rotation } = decomposeMatrix(matrix);
        if (Math.abs(scaleX - scaleY) < 0.0001) {
          const rotationDeg = (rotation * 180) / Math.PI;
          const startAngleDeg = ((entity.startAngle * 180) / Math.PI + rotationDeg + 360) % 360;
          const endAngleDeg = ((entity.endAngle * 180) / Math.PI + rotationDeg + 360) % 360;
          entities.push(
            buildArcEntity(
              center.x,
              center.y,
              entity.r * scaleX,
              startAngleDeg,
              endAngleDeg,
              sceneHeight,
              nextDxfHandle(handleState)
            )
          );
          return;
        }

        fallbackContours.push(...buildFallbackContoursForEntity(piece, entity, matrix));
        return;
      }

      if (entity.kind === "ellipse") {
        const center = applyMatrix(matrix, { x: entity.cx, y: entity.cy });
        const cos = Math.cos(entity.rotation);
        const sin = Math.sin(entity.rotation);
        const axisX = applyVector(matrix, { x: entity.rx * cos, y: entity.rx * sin });
        const axisY = applyVector(matrix, { x: -entity.ry * sin, y: entity.ry * cos });
        const axisXLength = Math.hypot(axisX.x, axisX.y);
        const axisYLength = Math.hypot(axisY.x, axisY.y);
        const majorAxis = axisXLength >= axisYLength ? axisX : axisY;
        const majorAxisLength = Math.max(axisXLength, axisYLength, 0.0001);
        const minorAxisLength = Math.min(axisXLength, axisYLength);

        entities.push(
          buildEllipseEntity(
            center.x,
            center.y,
            majorAxis.x,
            majorAxis.y,
            minorAxisLength / majorAxisLength,
            sceneHeight,
            nextDxfHandle(handleState)
          )
        );
        return;
      }

      if (entity.kind === "ellipseArc") {
        const center = applyMatrix(matrix, { x: entity.cx, y: entity.cy });
        const cos = Math.cos(entity.rotation);
        const sin = Math.sin(entity.rotation);
        const axisX = applyVector(matrix, { x: entity.rx * cos, y: entity.rx * sin });
        const axisY = applyVector(matrix, { x: -entity.ry * sin, y: entity.ry * cos });
        const axisXLength = Math.hypot(axisX.x, axisX.y);
        const axisYLength = Math.hypot(axisY.x, axisY.y);
        const usesOriginalMajorAxis = axisXLength >= axisYLength;
        const majorAxis = usesOriginalMajorAxis ? axisX : axisY;
        const majorAxisLength = Math.max(axisXLength, axisYLength, 0.0001);
        const minorAxisLength = Math.min(axisXLength, axisYLength);
        const params = usesOriginalMajorAxis
          ? normalizeEllipseParams(entity.startAngle, entity.endAngle)
          : normalizeEllipseParams(entity.startAngle - Math.PI / 2, entity.endAngle - Math.PI / 2);

        entities.push(
          buildEllipseEntity(
            center.x,
            center.y,
            majorAxis.x,
            majorAxis.y,
            minorAxisLength / majorAxisLength,
            sceneHeight,
            nextDxfHandle(handleState),
            params.startParam,
            params.endParam
          )
        );
        return;
      }

      if (entity.kind === "polyline") {
        fallbackContours.push(...buildFallbackContoursForEntity(piece, entity, matrix));
        return;
      }

      if (entity.kind === "path") {
        const pathEntities = buildPathDxfEntities(piece, entity, matrix, sceneHeight, handleState);
        if (pathEntities?.length) {
          entities.push(...pathEntities);
          return;
        }

        fallbackContours.push(...buildFallbackContoursForEntity(piece, entity, matrix));
        return;
      }
    });

    mergeCommonLineContours(fallbackContours).forEach((contour) => {
      entities.push(buildPolylineEntity(contour.points, contour.closed, sceneHeight, nextDxfHandle(handleState)));
    });
  });

  const handSeed = nextDxfHandle(handleState);
  const viewportEntry = [
    dxfPair(0, "VPORT"),
    dxfPair(5, viewportActiveHandle),
    dxfPair(330, viewportTableHandle),
    dxfPair(100, "AcDbSymbolTableRecord"),
    dxfPair(100, "AcDbViewportTableRecord"),
    dxfPair(2, "*ACTIVE"),
    dxfPair(70, 0),
    dxfPair(10, 0),
    dxfPair(20, 0),
    dxfPair(11, 1),
    dxfPair(21, 1),
    dxfPair(12, 0),
    dxfPair(22, 0),
    dxfPair(13, 0),
    dxfPair(23, 0),
    dxfPair(14, 10),
    dxfPair(24, 10),
    dxfPair(15, 10),
    dxfPair(25, 10),
    dxfPair(16, 0),
    dxfPair(26, 0),
    dxfPair(36, 1),
    dxfPair(17, 0),
    dxfPair(27, 0),
    dxfPair(37, 0),
    dxfPair(40, 50),
    dxfPair(41, 1.34),
    dxfPair(42, 50),
    dxfPair(43, 0),
    dxfPair(44, 0),
    dxfPair(50, 0),
    dxfPair(51, 0),
    dxfPair(71, 0),
    dxfPair(72, 100),
    dxfPair(73, 1),
    dxfPair(74, 3),
    dxfPair(75, 0),
    dxfPair(76, 0),
    dxfPair(77, 0),
    dxfPair(78, 0),
    dxfPair(281, 0),
    dxfPair(65, 1),
    dxfPair(110, 0),
    dxfPair(120, 0),
    dxfPair(130, 0),
    dxfPair(111, 1),
    dxfPair(121, 0),
    dxfPair(131, 0),
    dxfPair(112, 0),
    dxfPair(122, 1),
    dxfPair(132, 0),
    dxfPair(79, 0),
    dxfPair(146, 0)
  ].join("");
  const ltypeEntry = [
    dxfPair(0, "LTYPE"),
    dxfPair(5, continuousLtypeHandle),
    dxfPair(330, ltypeTableHandle),
    dxfPair(100, "AcDbSymbolTableRecord"),
    dxfPair(100, "AcDbLinetypeTableRecord"),
    dxfPair(2, "CONTINUOUS"),
    dxfPair(70, 0),
    dxfPair(3, "Solid line"),
    dxfPair(72, 65),
    dxfPair(73, 0),
    dxfPair(40, 0)
  ].join("");
  const layerEntry = [
    dxfPair(0, "LAYER"),
    dxfPair(5, layerZeroHandle),
    dxfPair(330, layerTableHandle),
    dxfPair(100, "AcDbSymbolTableRecord"),
    dxfPair(100, "AcDbLayerTableRecord"),
    dxfPair(2, "0"),
    dxfPair(70, 0),
    dxfPair(62, 7),
    dxfPair(6, "CONTINUOUS"),
    dxfPair(290, 1),
    dxfPair(370, -3),
    dxfPair(390, rootDictionaryHandle)
  ].join("");
  const styleEntry = [
    dxfPair(0, "STYLE"),
    dxfPair(5, styleStandardHandle),
    dxfPair(330, styleTableHandle),
    dxfPair(100, "AcDbSymbolTableRecord"),
    dxfPair(100, "AcDbTextStyleTableRecord"),
    dxfPair(2, "STANDARD"),
    dxfPair(70, 0),
    dxfPair(40, 0),
    dxfPair(41, 1),
    dxfPair(50, 0),
    dxfPair(71, 0),
    dxfPair(42, 2.5),
    dxfPair(3, "txt"),
    dxfPair(4, "")
  ].join("");
  const appIdEntry = [
    dxfPair(0, "APPID"),
    dxfPair(5, appIdAcadHandle),
    dxfPair(330, appIdTableHandle),
    dxfPair(100, "AcDbSymbolTableRecord"),
    dxfPair(100, "AcDbRegAppTableRecord"),
    dxfPair(2, "ACAD"),
    dxfPair(70, 0)
  ].join("");

  return [
    dxfPair(0, "SECTION"),
    dxfPair(2, "HEADER"),
    dxfPair(9, "$ACADVER"),
    dxfPair(1, "AC1015"),
    dxfPair(9, "$INSUNITS"),
    dxfPair(70, getDxfInsUnits(material.unit)),
    dxfPair(9, "$EXTMIN"),
    dxfPair(10, 0),
    dxfPair(20, 0),
    dxfPair(30, 0),
    dxfPair(9, "$EXTMAX"),
    dxfPair(10, sceneWidth.toFixed(4)),
    dxfPair(20, sceneHeight.toFixed(4)),
    dxfPair(30, 0),
    dxfPair(9, "$HANDSEED"),
    dxfPair(5, handSeed),
    dxfPair(0, "ENDSEC"),
    dxfPair(0, "SECTION"),
    dxfPair(2, "TABLES"),
    buildTable("VPORT", viewportTableHandle, tablesHandle, [viewportEntry], 1),
    buildTable("LTYPE", ltypeTableHandle, tablesHandle, [ltypeEntry], 1),
    buildTable("LAYER", layerTableHandle, tablesHandle, [layerEntry], 1),
    buildTable("STYLE", styleTableHandle, tablesHandle, [styleEntry], 1),
    buildTable("APPID", appIdTableHandle, tablesHandle, [appIdEntry], 1),
    buildTable(
      "BLOCK_RECORD",
      blockRecordTableHandle,
      tablesHandle,
      [
        buildBlockRecord("*Model_Space", modelSpaceRecordHandle, blockRecordTableHandle),
        buildBlockRecord("*Paper_Space", paperSpaceRecordHandle, blockRecordTableHandle)
      ],
      2
    ),
    dxfPair(0, "ENDSEC"),
    dxfPair(0, "SECTION"),
    dxfPair(2, "BLOCKS"),
    buildBlock("*Model_Space", modelSpaceBlockHandle, modelSpaceRecordHandle, modelSpaceEndHandle),
    buildBlock("*Paper_Space", paperSpaceBlockHandle, paperSpaceRecordHandle, paperSpaceEndHandle),
    dxfPair(0, "ENDSEC"),
    dxfPair(0, "SECTION"),
    dxfPair(2, "ENTITIES"),
    entities.join(""),
    dxfPair(0, "ENDSEC"),
    dxfPair(0, "SECTION"),
    dxfPair(2, "OBJECTS"),
    dxfPair(0, "DICTIONARY"),
    dxfPair(5, rootDictionaryHandle),
    dxfPair(100, "AcDbDictionary"),
    dxfPair(281, 1),
    dxfPair(330, 0),
    dxfPair(0, "ENDSEC"),
    dxfPair(0, "EOF")
  ].join("");
}

export async function downloadDxf(pieces: PieceItem[], material: MaterialConfig, result: NestingResult) {
  await downloadDxfFromApi(pieces, material, result);
}
