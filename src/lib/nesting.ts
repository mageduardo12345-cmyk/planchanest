import type { GeometryEntity, GeometryPoint, NestingConfig, NestingResult, PieceItem, Placement } from "../types";
import { wait } from "./utils";

export interface SampledContour {
  points: GeometryPoint[];
  closed: boolean;
}

interface PieceVariant {
  rotation: number;
  width: number;
  height: number;
  contours: SampledContour[];
}

export interface PreparedPiece {
  pieceId: string;
  area: number;
  variants: PieceVariant[];
}

interface PreparedPlacement {
  pieceId: string;
  sheetIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  contours: SampledContour[];
  area: number;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function rotationAngles(config: NestingConfig) {
  switch (config.rotations) {
    case "none":
      return [0];
    case "free45":
      return [0, 45, 90, 135, 180, 225, 270, 315];
    case "free":
      return [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330];
    default:
      return [0, 90, 180, 270];
  }
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

function round(n: number) {
  return Math.round(n * 1000) / 1000;
}

function dedupeTrailingPoint(points: GeometryPoint[]) {
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

function samplePath(pathData: string, offsetX: number, offsetY: number, closed: boolean) {
  const probe = createProbeSvg();
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", pathData);
  path.setAttribute("transform", `translate(${-offsetX} ${-offsetY})`);
  probe.appendChild(path);

  const length = path.getTotalLength();
  const segments = Math.max(18, Math.min(240, Math.ceil(length / 6)));
  const points: GeometryPoint[] = [];

  for (let index = 0; index <= segments; index += 1) {
    const point = path.getPointAtLength((length * index) / segments);
    points.push({ x: round(point.x), y: round(point.y) });
  }

  probe.remove();

  return {
    points: closed ? dedupeTrailingPoint(points) : points,
    closed
  };
}

function sampleEllipse(cx: number, cy: number, rx: number, ry: number, rotation: number, segments: number) {
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

function normalizeArcSweep(startAngle: number, endAngle: number) {
  let sweep = endAngle - startAngle;
  while (sweep <= 0) {
    sweep += Math.PI * 2;
  }
  return sweep;
}

function sampleArc(entity: Extract<GeometryEntity, { kind: "arc" }>, segments = 24) {
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

function sampleEllipseArc(entity: Extract<GeometryEntity, { kind: "ellipseArc" }>, segments = 32) {
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

function sampleEntityContours(piece: PieceItem, entity: GeometryEntity): SampledContour[] {
  const offsetX = piece.geometry.sourceBounds.minX;
  const offsetY = piece.geometry.sourceBounds.minY;

  switch (entity.kind) {
    case "polyline":
      return [{ points: dedupeTrailingPoint(entity.points), closed: entity.closed }];
    case "circle":
      return [{ points: sampleEllipse(entity.cx, entity.cy, entity.r, entity.r, 0, 32), closed: true }];
    case "ellipse":
      return [
        {
          points: sampleEllipse(entity.cx, entity.cy, entity.rx, entity.ry, entity.rotation, 32),
          closed: true
        }
      ];
    case "ellipseArc":
      return [{ points: sampleEllipseArc(entity, 32), closed: false }];
    case "arc":
      return [{ points: sampleArc(entity, 24), closed: false }];
    case "path": {
      const subpaths = entity.d.match(/[Mm][^Mm]*/g) ?? [];
      return subpaths.map((subpath) => samplePath(subpath, offsetX, offsetY, /z/i.test(subpath)));
    }
    default:
      return [];
  }
}

function rotatePoint(point: GeometryPoint, angleDeg: number) {
  const angle = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: round(point.x * cos - point.y * sin),
    y: round(point.x * sin + point.y * cos)
  };
}

function normalizeContours(contours: SampledContour[]) {
  const allPoints = contours.flatMap((contour) => contour.points);
  const minX = Math.min(...allPoints.map((point) => point.x));
  const minY = Math.min(...allPoints.map((point) => point.y));
  const maxX = Math.max(...allPoints.map((point) => point.x));
  const maxY = Math.max(...allPoints.map((point) => point.y));

  return {
    width: round(maxX - minX),
    height: round(maxY - minY),
    contours: contours.map((contour) => ({
      ...contour,
      points: contour.points.map((point) => ({
        x: round(point.x - minX),
        y: round(point.y - minY)
      }))
    }))
  };
}

function polygonArea(points: GeometryPoint[]) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return Math.abs(area / 2);
}

function preparePiece(piece: PieceItem, config: NestingConfig): PreparedPiece | null {
  const sampledContours = piece.geometry.entities.flatMap((entity) => sampleEntityContours(piece, entity));
  const closedContours = sampledContours.filter((contour) => contour.closed && contour.points.length >= 3);
  const openContours = sampledContours.filter((contour) => !contour.closed && contour.points.length >= 2);
  const baseContours = [...closedContours, ...openContours];

  if (!baseContours.length) {
    return null;
  }

  const area = closedContours.length
    ? closedContours.reduce((sum, contour) => sum + polygonArea(contour.points), 0)
    : piece.geometry.width * piece.geometry.height;
  const angles = config.keepOrientation ? [0] : rotationAngles(config);
  const uniqueAngles = [...new Set(angles)];

  return {
    pieceId: piece.id,
    area,
    variants: uniqueAngles.map((rotation) => {
      const rotated = baseContours.map((contour) => ({
        ...contour,
        points: contour.points.map((point) => rotatePoint(point, rotation))
      }));
      const normalized = normalizeContours(rotated);
      return {
        rotation,
        width: normalized.width,
        height: normalized.height,
        contours: normalized.contours
      };
    })
  };
}

function expandPieces(pieces: PieceItem[], config: NestingConfig) {
  const expanded: PreparedPiece[] = [];

  pieces
    .filter((piece) => piece.enabled)
    .forEach((piece) => {
      const prepared = preparePiece(piece, config);
      if (!prepared) {
        return;
      }

      for (let idx = 0; idx < piece.quantity; idx += 1) {
        expanded.push(prepared);
      }
    });

  return expanded.sort((a, b) => (config.prioritizeLarge ? b.area - a.area : 0));
}

export function preparePiecesForNesting(pieces: PieceItem[], config: NestingConfig) {
  return expandPieces(pieces, config);
}

function translateContours(contours: SampledContour[], x: number, y: number) {
  return contours.map((contour) => ({
    ...contour,
    points: contour.points.map((point) => ({
      x: round(point.x + x),
      y: round(point.y + y)
    }))
  }));
}

function contourBounds(contour: SampledContour) {
  return {
    minX: Math.min(...contour.points.map((point) => point.x)),
    minY: Math.min(...contour.points.map((point) => point.y)),
    maxX: Math.max(...contour.points.map((point) => point.x)),
    maxY: Math.max(...contour.points.map((point) => point.y))
  };
}

function segmentsIntersect(a1: GeometryPoint, a2: GeometryPoint, b1: GeometryPoint, b2: GeometryPoint) {
  const denominator = (a2.x - a1.x) * (b2.y - b1.y) - (a2.y - a1.y) * (b2.x - b1.x);
  if (Math.abs(denominator) < 0.000001) {
    return false;
  }

  const ua = ((b2.x - b1.x) * (a1.y - b1.y) - (b2.y - b1.y) * (a1.x - b1.x)) / denominator;
  const ub = ((a2.x - a1.x) * (a1.y - b1.y) - (a2.y - a1.y) * (a1.x - b1.x)) / denominator;
  return ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1;
}

function pointInPolygon(point: GeometryPoint, polygon: GeometryPoint[]) {
  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;

    const intersects =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / ((yj - yi) || 0.000001) + xi;

    if (intersects) {
      inside = !inside;
    }
  }

  return inside;
}

function closedContoursIntersect(a: SampledContour, b: SampledContour) {
  const boundsA = contourBounds(a);
  const boundsB = contourBounds(b);

  if (
    boundsA.maxX < boundsB.minX ||
    boundsA.minX > boundsB.maxX ||
    boundsA.maxY < boundsB.minY ||
    boundsA.minY > boundsB.maxY
  ) {
    return false;
  }

  for (let indexA = 0; indexA < a.points.length; indexA += 1) {
    const a1 = a.points[indexA];
    const a2 = a.points[(indexA + 1) % a.points.length];

    for (let indexB = 0; indexB < b.points.length; indexB += 1) {
      const b1 = b.points[indexB];
      const b2 = b.points[(indexB + 1) % b.points.length];
      if (segmentsIntersect(a1, a2, b1, b2)) {
        return true;
      }
    }
  }

  return pointInPolygon(a.points[0], b.points) || pointInPolygon(b.points[0], a.points);
}

function contourIntersectsOpen(closedContour: SampledContour, openContour: SampledContour) {
  for (let indexA = 0; indexA < closedContour.points.length; indexA += 1) {
    const a1 = closedContour.points[indexA];
    const a2 = closedContour.points[(indexA + 1) % closedContour.points.length];

    for (let indexB = 0; indexB < openContour.points.length - 1; indexB += 1) {
      const b1 = openContour.points[indexB];
      const b2 = openContour.points[indexB + 1];
      if (segmentsIntersect(a1, a2, b1, b2)) {
        return true;
      }
    }
  }

  return pointInPolygon(openContour.points[0], closedContour.points);
}

function contoursCollide(candidate: SampledContour[], placed: SampledContour[]) {
  const candidateClosed = candidate.filter((contour) => contour.closed && contour.points.length >= 3);
  const candidateOpen = candidate.filter((contour) => !contour.closed && contour.points.length >= 2);
  const placedClosed = placed.filter((contour) => contour.closed && contour.points.length >= 3);
  const placedOpen = placed.filter((contour) => !contour.closed && contour.points.length >= 2);

  for (const a of candidateClosed) {
    for (const b of placedClosed) {
      if (closedContoursIntersect(a, b)) {
        return true;
      }
    }
  }

  for (const a of candidateClosed) {
    for (const b of placedOpen) {
      if (contourIntersectsOpen(a, b)) {
        return true;
      }
    }
  }

  for (const a of placedClosed) {
    for (const b of candidateOpen) {
      if (contourIntersectsOpen(a, b)) {
        return true;
      }
    }
  }

  return false;
}

function fitsMaterial(
  x: number,
  y: number,
  variant: PieceVariant,
  material: { width: number; height: number },
  config: NestingConfig
) {
  return (
    x >= config.edgeGap &&
    y >= config.edgeGap &&
    x + variant.width <= material.width - config.edgeGap &&
    y + variant.height <= material.height - config.edgeGap
  );
}

function placementCollides(
  x: number,
  y: number,
  variant: PieceVariant,
  placements: PreparedPlacement[],
  config: NestingConfig
) {
  const inflate = (config.pieceGap + config.kerf) / 2;
  const candidate = translateContours(variant.contours, x, y);

  for (const placement of placements) {
    if (
      x + variant.width + inflate < placement.x ||
      x > placement.x + placement.width + inflate ||
      y + variant.height + inflate < placement.y ||
      y > placement.y + placement.height + inflate
    ) {
      continue;
    }

    if (contoursCollide(candidate, placement.contours)) {
      return true;
    }
  }

  return false;
}

function candidateCoordinates(
  placements: PreparedPlacement[],
  material: { width: number; height: number },
  config: NestingConfig
) {
  const xCandidates = new Set<number>([config.edgeGap]);
  const yCandidates = new Set<number>([config.edgeGap]);

  placements.forEach((placement) => {
    xCandidates.add(round(placement.x + placement.width + config.pieceGap));
    yCandidates.add(round(placement.y + placement.height + config.pieceGap));
    xCandidates.add(round(placement.x));
    yCandidates.add(round(placement.y));
  });

  const gridStep = Math.max(20, Math.round(config.pieceGap + config.kerf + 12));
  for (let x = config.edgeGap; x <= material.width - config.edgeGap; x += gridStep) {
    xCandidates.add(round(x));
  }
  for (let y = config.edgeGap; y <= material.height - config.edgeGap; y += gridStep) {
    yCandidates.add(round(y));
  }

  const orderedX = [...xCandidates]
    .filter((value) => value >= config.edgeGap && value <= material.width - config.edgeGap)
    .sort((a, b) => a - b)
    .slice(0, 120);
  const orderedY = [...yCandidates]
    .filter((value) => value >= config.edgeGap && value <= material.height - config.edgeGap)
    .sort((a, b) => a - b)
    .slice(0, 120);

  return {
    x: orderedX,
    y: orderedY
  };
}

function findBestPlacement(
  prepared: PreparedPiece,
  sheetPlacements: PreparedPlacement[],
  material: { width: number; height: number },
  config: NestingConfig
) {
  const candidates = candidateCoordinates(sheetPlacements, material, config);
  let best:
    | {
        x: number;
        y: number;
        variant: PieceVariant;
        score: number;
      }
    | undefined;

  for (const variant of prepared.variants) {
    for (const y of candidates.y) {
      for (const x of candidates.x) {
        if (!fitsMaterial(x, y, variant, material, config)) {
          continue;
        }

        if (placementCollides(x, y, variant, sheetPlacements, config)) {
          continue;
        }

        const score = y * material.width + x + variant.height * 0.01 + variant.width * 0.001;
        if (!best || score < best.score) {
          best = { x, y, variant, score };
        }
      }
    }
  }

  return best;
}

async function computeNesting(
  expanded: PreparedPiece[],
  material: { width: number; height: number; sheetCount: number },
  config: NestingConfig,
  onProgress?: (message: string, value: number) => void
) {
  const startedAt = performance.now();
  const placements: Placement[] = [];
  const sheetPlacements = Array.from({ length: material.sheetCount }).map(() => [] as PreparedPlacement[]);
  const unplaced: string[] = [];

  const statusMessages = [
    "Analizando contornos.",
    "Preparando rotaciones reales.",
    "Buscando acomodo por pieza.",
    "Verificando choques.",
    "Generando resultado final."
  ];

  for (let i = 0; i < statusMessages.length; i += 1) {
    onProgress?.(statusMessages[i], (i + 1) / (statusMessages.length + 1));
    await wait(config.quality === "quality" ? 180 : 90);
  }

  for (let index = 0; index < expanded.length; index += 1) {
    const prepared = expanded[index];
    let placed = false;

    for (let sheetIndex = 0; sheetIndex < material.sheetCount; sheetIndex += 1) {
      const found = findBestPlacement(prepared, sheetPlacements[sheetIndex], material, config);
      if (!found) {
        continue;
      }

      const translatedContours = translateContours(found.variant.contours, found.x, found.y);
      sheetPlacements[sheetIndex].push({
        pieceId: prepared.pieceId,
        sheetIndex,
        x: found.x,
        y: found.y,
        width: found.variant.width,
        height: found.variant.height,
        rotation: found.variant.rotation,
        contours: translatedContours,
        area: prepared.area
      });
      placements.push({
        pieceId: prepared.pieceId,
        sheetIndex,
        x: found.x,
        y: found.y,
        width: found.variant.width,
        height: found.variant.height,
        rotation: found.variant.rotation
      });
      placed = true;
      onProgress?.(
        `Acomodando pieza ${Math.min(index + 1, expanded.length)} de ${expanded.length}.`,
        Math.min(0.25 + (index + 1) / Math.max(expanded.length, 1) * 0.7, 0.98)
      );
      break;
    }

    if (!placed) {
      unplaced.push(prepared.pieceId);
    }

    if (index % 3 === 2) {
      await wait(0);
    }
  }

  const elapsedMs = performance.now() - startedAt;
  const usedSheets = placements.length ? Math.max(...placements.map((item) => item.sheetIndex)) + 1 : 0;
  const usedArea = sheetPlacements
    .flatMap((sheet) => sheet)
    .reduce((total, placement) => total + placement.area, 0);
  const totalArea = Math.max(usedSheets, 1) * material.width * material.height;
  const wasteArea = Math.max(totalArea - usedArea, 0);
  const utilization = totalArea ? (usedArea / totalArea) * 100 : 0;

  const result: NestingResult = {
    placements,
    unplaced,
    usedSheets,
    usedArea,
    wasteArea,
    utilization,
    elapsedMs
  };

  onProgress?.("Resultado listo.", 1);
  return result;
}

export async function runPreparedNesting(
  preparedPieces: PreparedPiece[],
  material: { width: number; height: number; sheetCount: number },
  config: NestingConfig,
  onProgress?: (message: string, value: number) => void
) {
  return computeNesting(preparedPieces, material, config, onProgress);
}

export async function runNesting(
  pieces: PieceItem[],
  material: { width: number; height: number; sheetCount: number },
  config: NestingConfig,
  onProgress?: (message: string, value: number) => void
) {
  const prepared = preparePiecesForNesting(pieces, config);
  return computeNesting(prepared, material, config, onProgress);
}
