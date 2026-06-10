import type { jsPDF } from "jspdf";
import type {
  GeometryEntity,
  GeometryPoint,
  MaterialConfig,
  NestingResult,
  PieceItem
} from "../types";

type Matrix = {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
};

const SVG_NS = "http://www.w3.org/2000/svg";
let jsPdfModulePromise: Promise<typeof import("jspdf")> | null = null;
let svg2PdfModulePromise: Promise<{ svg2pdf: (element: Element, pdf: jsPDF, options?: Record<string, unknown>) => Promise<void> }> | null = null;

type DxfHandleState = {
  current: number;
};

type SimplePathSegment =
  | { kind: "move"; point: GeometryPoint }
  | { kind: "line"; point: GeometryPoint }
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

function createProbeSvg() {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", "0");
  svg.setAttribute("height", "0");
  svg.style.position = "absolute";
  svg.style.left = "-9999px";
  svg.style.top = "-9999px";
  document.body.appendChild(svg);
  return svg;
}

async function loadJsPdf() {
  if (!jsPdfModulePromise) {
    jsPdfModulePromise = import("jspdf");
  }

  return jsPdfModulePromise;
}

async function loadSvg2Pdf() {
  if (!svg2PdfModulePromise) {
    const baseUrl = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
    const moduleUrl = `${baseUrl.replace(/\/?$/, "/")}vendor/svg2pdf.es.js`;
    svg2PdfModulePromise = import(/* @vite-ignore */ moduleUrl) as Promise<{
      svg2pdf: (element: Element, pdf: jsPDF, options?: Record<string, unknown>) => Promise<void>;
    }>;
  }

  return svg2PdfModulePromise;
}

function samplePathPoints(pathData: string, offsetX = 0, offsetY = 0) {
  const probe = createProbeSvg();
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", pathData);
  path.setAttribute("transform", `translate(${-offsetX} ${-offsetY})`);
  probe.appendChild(path);

  const length = path.getTotalLength();
  const segments = Math.max(48, Math.min(960, Math.ceil(length / 2.5)));
  const points: GeometryPoint[] = [];

  for (let index = 0; index <= segments; index += 1) {
    const point = path.getPointAtLength((length * index) / segments);
    points.push({ x: point.x, y: point.y });
  }

  probe.remove();
  return points;
}

function sampleArcPoints(entity: Extract<GeometryEntity, { kind: "arc" }>, segments = 72) {
  const sweep = normalizeArcSweep(entity.startAngle, entity.endAngle);
  const points: GeometryPoint[] = [];

  for (let index = 0; index <= segments; index += 1) {
    const angle = entity.startAngle + sweep * (index / segments);
    points.push({
      x: entity.cx + entity.r * Math.cos(angle),
      y: entity.cy - entity.r * Math.sin(angle)
    });
  }

  return points;
}

function sampleEllipseArcPoints(entity: Extract<GeometryEntity, { kind: "ellipseArc" }>, segments = 96) {
  let sweep = entity.endAngle - entity.startAngle;
  while (sweep <= 0) {
    sweep += Math.PI * 2;
  }

  const points: GeometryPoint[] = [];
  const cos = Math.cos(entity.rotation);
  const sin = Math.sin(entity.rotation);
  for (let index = 0; index <= segments; index += 1) {
    const angle = entity.startAngle + sweep * (index / segments);
    const localX = entity.rx * Math.cos(angle);
    const localY = entity.ry * Math.sin(angle);
    points.push({
      x: entity.cx + localX * cos - localY * sin,
      y: entity.cy + localX * sin + localY * cos
    });
  }
  return points;
}

function sampleEllipsePoints(cx: number, cy: number, rx: number, ry: number, rotation = 0, segments = 96) {
  const points: GeometryPoint[] = [];
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  for (let index = 0; index <= segments; index += 1) {
    const angle = (Math.PI * 2 * index) / segments;
    const localX = rx * Math.cos(angle);
    const localY = ry * Math.sin(angle);
    points.push({
      x: cx + localX * cos - localY * sin,
      y: cy + localX * sin + localY * cos
    });
  }
  return points;
}

function normalizeArcSweep(startAngle: number, endAngle: number) {
  let sweep = endAngle - startAngle;
  while (sweep <= 0) {
    sweep += Math.PI * 2;
  }
  return sweep;
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
  const tokens = pathData.match(/[MLAZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi);
  if (!tokens?.length) {
    return null;
  }

  const segments: SimplePathSegment[] = [];
  let index = 0;

  while (index < tokens.length) {
    const command = tokens[index];
    index += 1;

    if (command === "M") {
      const x = Number(tokens[index]);
      const y = Number(tokens[index + 1]);
      index += 2;
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return null;
      }
      segments.push({
        kind: "move",
        point: { x: x - offsetX, y: y - offsetY }
      });
      continue;
    }

    if (command === "L") {
      const x = Number(tokens[index]);
      const y = Number(tokens[index + 1]);
      index += 2;
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return null;
      }
      segments.push({
        kind: "line",
        point: { x: x - offsetX, y: y - offsetY }
      });
      continue;
    }

    if (command === "A") {
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
      segments.push({
        kind: "arc",
        rx,
        ry,
        rotation,
        largeArc: Boolean(largeArc),
        sweep: Boolean(sweep),
        point: { x: x - offsetX, y: y - offsetY }
      });
      continue;
    }

    if (command === "Z" || command === "z") {
      segments.push({ kind: "close" });
      continue;
    }

    return null;
  }

  return segments;
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
      return transformPolylinePoints(samplePathPoints(entity.d, offsetX, offsetY), matrix);
    default:
      return [];
  }
}

function entityToSvg(entity: GeometryEntity, offsetX: number, offsetY: number) {
  switch (entity.kind) {
    case "polyline":
      return `<${entity.closed ? "polygon" : "polyline"} fill="none" stroke="#111" stroke-width="1" points="${entity.points
        .map((point) => `${point.x + offsetX},${point.y + offsetY}`)
        .join(" ")}" />`;
    case "circle":
      return `<circle cx="${entity.cx + offsetX}" cy="${entity.cy + offsetY}" r="${entity.r}" fill="none" stroke="#111" stroke-width="1" />`;
    case "ellipse":
      return `<ellipse cx="${entity.cx + offsetX}" cy="${entity.cy + offsetY}" rx="${entity.rx}" ry="${entity.ry}" fill="none" stroke="#111" stroke-width="1" ${Math.abs(entity.rotation) > 0.000001 ? `transform="rotate(${(entity.rotation * 180) / Math.PI} ${entity.cx + offsetX} ${entity.cy + offsetY})"` : ""} />`;
    case "ellipseArc": {
      const points = sampleEllipseArcPoints(entity, 96);
      const start = points[0];
      const end = points[points.length - 1];
      if (!start || !end) {
        return "";
      }
      let sweep = entity.endAngle - entity.startAngle;
      while (sweep <= 0) {
        sweep += Math.PI * 2;
      }
      return `<path d="M ${start.x + offsetX} ${start.y + offsetY} A ${entity.rx} ${entity.ry} ${(entity.rotation * 180) / Math.PI} ${sweep > Math.PI ? 1 : 0} 1 ${end.x + offsetX} ${end.y + offsetY}" fill="none" stroke="#111" stroke-width="1" />`;
    }
    case "arc": {
      const x1 = entity.cx + entity.r * Math.cos(entity.startAngle) + offsetX;
      const y1 = entity.cy - entity.r * Math.sin(entity.startAngle) + offsetY;
      const x2 = entity.cx + entity.r * Math.cos(entity.endAngle) + offsetX;
      const y2 = entity.cy - entity.r * Math.sin(entity.endAngle) + offsetY;
      const sweep = normalizeArcSweep(entity.startAngle, entity.endAngle);
      const largeArc = sweep > Math.PI ? 1 : 0;
      return `<path d="M ${x1} ${y1} A ${entity.r} ${entity.r} 0 ${largeArc} 0 ${x2} ${y2}" fill="none" stroke="#111" stroke-width="1" />`;
    }
    case "path":
      return `<path d="${entity.d}" fill="none" stroke="#111" stroke-width="1" transform="translate(${-offsetX} ${-offsetY})" />`;
    default:
      return "";
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

export function buildResultSvg(pieces: PieceItem[], material: MaterialConfig, result: NestingResult) {
  const { sceneWidth, sceneHeight } = getSceneMetrics(material, result);

  const markup = result.placements
    .map((placement) => {
      const piece = findPiece(pieces, placement.pieceId);
      if (!piece) {
        return "";
      }

      const offsetX = getSheetOffset(material, placement.sheetIndex) + placement.x;
      const offsetY = placement.y;
      const originalOffsetX = piece.geometry.sourceBounds.minX;
      const originalOffsetY = piece.geometry.sourceBounds.minY;

      return `
        <g transform="translate(${offsetX} ${offsetY}) rotate(${placement.rotation})">
          ${piece.geometry.entities
            .map((entity) => entityToSvg(entity, originalOffsetX, originalOffsetY))
            .join("")}
        </g>
      `;
    })
    .join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${sceneWidth} ${sceneHeight}">
    ${markup}
  </svg>`;
}

export function downloadSvg(pieces: PieceItem[], material: MaterialConfig, result: NestingResult) {
  createDownload("nesting-resultado.svg", buildResultSvg(pieces, material, result), "image/svg+xml;charset=utf-8");
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
  const { svg2pdf } = await loadSvg2Pdf();
  const doc = new jsPDF({
    orientation: sceneWidth >= sceneHeight ? "landscape" : "portrait",
    unit: "mm",
  format: [sceneWidth, sceneHeight]
  });

  const parser = new DOMParser();
  const svgText = buildResultSvg(pieces, material, result);
  const svgDocument = parser.parseFromString(svgText, "image/svg+xml");
  const svgElement = svgDocument.documentElement;

  await svg2pdf(svgElement, doc, {
    x: 0,
    y: 0,
    width: sceneWidth,
    height: sceneHeight
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
        entities.push(
          buildPolylineEntity(
            transformPolylinePoints(entity.points, matrix),
            entity.closed,
            sceneHeight,
            nextDxfHandle(handleState)
          )
        );
        return;
      }

      if (entity.kind === "path") {
        const pathEntities = buildPathDxfEntities(piece, entity, matrix, sceneHeight, handleState);
        if (pathEntities?.length) {
          entities.push(...pathEntities);
          return;
        }
      }

      entities.push(
        buildPolylineEntity(
          getRenderableEntityPoints(piece, entity, matrix),
          isClosedEntity(entity),
          sceneHeight,
          nextDxfHandle(handleState)
        )
      );
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

export function downloadDxf(pieces: PieceItem[], material: MaterialConfig, result: NestingResult) {
  createDownload("nesting-resultado.dxf", buildResultDxf(pieces, material, result), "application/dxf");
}
