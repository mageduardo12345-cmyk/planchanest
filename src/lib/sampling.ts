import type { GeometryEntity, GeometryPoint } from "../types";

const SVG_NS = "http://www.w3.org/2000/svg";
const PATH_SAMPLE_CACHE_LIMIT = 400;

let probeSvg: SVGSVGElement | null = null;
const pathSampleCache = new Map<string, GeometryPoint[]>();

function round(n: number) {
  return Math.round(n * 1000) / 1000;
}

function createProbeSvg() {
  if (probeSvg?.isConnected) {
    return probeSvg;
  }

  probeSvg = document.createElementNS(SVG_NS, "svg");
  probeSvg.setAttribute("width", "0");
  probeSvg.setAttribute("height", "0");
  probeSvg.style.position = "absolute";
  probeSvg.style.left = "-9999px";
  probeSvg.style.top = "-9999px";
  document.body.appendChild(probeSvg);
  return probeSvg;
}

function clonePoints(points: GeometryPoint[]) {
  return points.map((point) => ({ x: point.x, y: point.y }));
}

function buildSampleCacheKey(
  pathData: string,
  offsetX: number,
  offsetY: number,
  closed: boolean,
  minSegments: number,
  maxSegments: number,
  segmentLength: number
) {
  return [
    pathData,
    offsetX.toFixed(4),
    offsetY.toFixed(4),
    closed ? "1" : "0",
    minSegments,
    maxSegments,
    segmentLength.toFixed(4)
  ].join("::");
}

function setCachedPathSample(key: string, points: GeometryPoint[]) {
  if (pathSampleCache.size >= PATH_SAMPLE_CACHE_LIMIT) {
    const oldestKey = pathSampleCache.keys().next().value;
    if (oldestKey) {
      pathSampleCache.delete(oldestKey);
    }
  }

  pathSampleCache.set(key, points);
}

export function dedupeClosingPoint(points: GeometryPoint[]) {
  if (points.length < 2) {
    return points;
  }

  const first = points[0];
  const last = points[points.length - 1];
  if (Math.abs(first.x - last.x) < 0.001 && Math.abs(first.y - last.y) < 0.001) {
    return points.slice(0, -1);
  }

  return points;
}

export function normalizeArcSweep(startAngle: number, endAngle: number) {
  let sweep = endAngle - startAngle;
  while (sweep <= 0) {
    sweep += Math.PI * 2;
  }
  return sweep;
}

export function sampleEllipsePoints(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rotation = 0,
  segments = 96
) {
  const points: GeometryPoint[] = [];
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  for (let index = 0; index < segments; index += 1) {
    const angle = (Math.PI * 2 * index) / segments;
    const localX = rx * Math.cos(angle);
    const localY = ry * Math.sin(angle);
    points.push({
      x: round(cx + localX * cos - localY * sin),
      y: round(cy + localX * sin + localY * cos)
    });
  }
  return points;
}

export function sampleArcPoints(entity: Extract<GeometryEntity, { kind: "arc" }>, segments = 72) {
  const sweep = normalizeArcSweep(entity.startAngle, entity.endAngle);
  const points: GeometryPoint[] = [];

  for (let index = 0; index <= segments; index += 1) {
    const angle = entity.startAngle + sweep * (index / segments);
    points.push({
      x: round(entity.cx + entity.r * Math.cos(angle)),
      y: round(entity.cy - entity.r * Math.sin(angle))
    });
  }

  return points;
}

export function sampleEllipseArcPoints(entity: Extract<GeometryEntity, { kind: "ellipseArc" }>, segments = 96) {
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
      x: round(entity.cx + localX * cos - localY * sin),
      y: round(entity.cy + localX * sin + localY * cos)
    });
  }
  return points;
}

export function samplePathPoints(
  pathData: string,
  options: {
    offsetX?: number;
    offsetY?: number;
    closed?: boolean;
    minSegments?: number;
    maxSegments?: number;
    segmentLength?: number;
  } = {}
) {
  const {
    offsetX = 0,
    offsetY = 0,
    closed = false,
    minSegments = 36,
    maxSegments = 900,
    segmentLength = 2.5
  } = options;
  const cacheKey = buildSampleCacheKey(pathData, offsetX, offsetY, closed, minSegments, maxSegments, segmentLength);
  const cached = pathSampleCache.get(cacheKey);
  if (cached) {
    return clonePoints(cached);
  }

  const probe = createProbeSvg();
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", pathData);
  path.setAttribute("transform", `translate(${-offsetX} ${-offsetY})`);
  probe.appendChild(path);

  const length = path.getTotalLength();
  const segments = Math.max(minSegments, Math.min(maxSegments, Math.ceil(length / segmentLength)));
  const points: GeometryPoint[] = [];

  for (let index = 0; index <= segments; index += 1) {
    const point = path.getPointAtLength((length * index) / segments);
    points.push({ x: round(point.x), y: round(point.y) });
  }

  path.remove();
  const normalized = closed ? dedupeClosingPoint(points) : points;
  setCachedPathSample(cacheKey, clonePoints(normalized));
  return normalized;
}
