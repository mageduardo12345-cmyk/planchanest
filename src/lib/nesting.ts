import type { GeometryEntity, GeometryPoint, NestingConfig, NestingResult, PieceItem, Placement } from "../types";
import { cleanPaths, differencePaths, hasClipperLib, intersectionPaths, offsetPaths, pathBounds, polygonArea as clipperPolygonArea, rectanglePath, unionPaths } from "./clipper-utils";
import { wait } from "./utils";
import { simplifyPolyline } from "./contours";
import {
  dedupeClosingPoint,
  sampleArcPoints,
  sampleEllipseArcPoints,
  sampleEllipsePoints,
  samplePathPoints
} from "./sampling";

export interface SampledContour {
  points: GeometryPoint[];
  closed: boolean;
  isHole?: boolean;
}

interface PieceVariant {
  rotation: number;
  width: number;
  height: number;
  contours: SampledContour[];
  anchors: GeometryPoint[];
  signature: string;
}

export interface PreparedPiece {
  pieceId: string;
  area: number;
  variants: PieceVariant[];
  viableVariantCount?: number;
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
  anchors: GeometryPoint[];
  area: number;
}

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

function round(n: number) {
  return Math.round(n * 1000) / 1000;
}

function dedupeTrailingPoint(points: GeometryPoint[]) {
  return dedupeClosingPoint(points);
}

function samplePath(pathData: string, offsetX: number, offsetY: number, closed: boolean) {
  return {
    points: simplifyPolyline(
      samplePathPoints(pathData, {
        offsetX,
        offsetY,
        closed,
        minSegments: 18,
        maxSegments: 240,
        segmentLength: 6
      }),
      0.25,
      closed
    ),
    closed
  };
}

function sampleEntityContours(piece: PieceItem, entity: GeometryEntity): SampledContour[] {
  const offsetX = piece.geometry.sourceBounds.minX;
  const offsetY = piece.geometry.sourceBounds.minY;

  switch (entity.kind) {
    case "polyline":
      return [{ points: simplifyPolyline(dedupeTrailingPoint(entity.points), 0.15, entity.closed), closed: entity.closed }];
    case "circle":
      return [{ points: simplifyPolyline(sampleEllipsePoints(entity.cx, entity.cy, entity.r, entity.r, 0, 32), 0.15, true), closed: true }];
    case "ellipse":
      return [
        {
          points: simplifyPolyline(sampleEllipsePoints(entity.cx, entity.cy, entity.rx, entity.ry, entity.rotation, 32), 0.15, true),
          closed: true
        }
      ];
    case "ellipseArc":
      return [{ points: simplifyPolyline(sampleEllipseArcPoints(entity, 32), 0.2, false), closed: false }];
    case "arc":
      return [{ points: simplifyPolyline(sampleArcPoints(entity, 24), 0.2, false), closed: false }];
    case "path": {
      const subpaths = entity.d.match(/[Mm][^Mm]*/g) ?? [];
      return subpaths.map((subpath) => samplePath(subpath, offsetX, offsetY, /z/i.test(subpath)));
    }
    default:
      return [];
  }
}

function signedPolygonArea(points: GeometryPoint[]) {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    area += current.x * next.y - next.x * current.y;
  }
  return area / 2;
}

function contourRepresentativePoint(points: GeometryPoint[]) {
  if (points.length < 3) {
    return points[0] ?? { x: 0, y: 0 };
  }

  const centroid = points.reduce(
    (acc, point) => ({
      x: acc.x + point.x,
      y: acc.y + point.y
    }),
    { x: 0, y: 0 }
  );

  return {
    x: centroid.x / points.length,
    y: centroid.y / points.length
  };
}

function contourInteriorPoint(points: GeometryPoint[]) {
  if (points.length < 3) {
    return points[0] ?? { x: 0, y: 0 };
  }

  const centroid = contourRepresentativePoint(points);
  for (const vertex of points) {
    const candidate = {
      x: round(vertex.x + (centroid.x - vertex.x) * 0.08),
      y: round(vertex.y + (centroid.y - vertex.y) * 0.08)
    };

    if (pointInPolygon(candidate, points)) {
      return candidate;
    }
  }

  return centroid;
}

function classifyClosedContours(closedContours: SampledContour[]) {
  return closedContours
    .map((contour) => {
      const representative = contourRepresentativePoint(contour.points);
      const depth = closedContours.reduce((count, candidate) => {
        if (candidate === contour || candidate.points.length < 3) {
          return count;
        }

        const candidateArea = Math.abs(signedPolygonArea(candidate.points));
        const contourArea = Math.abs(signedPolygonArea(contour.points));
        if (candidateArea <= contourArea) {
          return count;
        }

        return pointInPolygon(representative, candidate.points) ? count + 1 : count;
      }, 0);

      return {
        ...contour,
        isHole: depth % 2 === 1
      };
    })
    .sort((left, right) => Math.abs(signedPolygonArea(right.points)) - Math.abs(signedPolygonArea(left.points)));
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

function dedupeAnchorPoints(points: GeometryPoint[]) {
  const seen = new Set<string>();
  return points.filter((point) => {
    const key = `${round(point.x)}:${round(point.y)}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function contourSamplePoints(points: GeometryPoint[], limit = 20) {
  if (points.length <= limit) {
    return points;
  }

  const step = Math.max(1, Math.floor(points.length / limit));
  return points.filter((_, index) => index % step === 0).slice(0, limit);
}

function polygonEdgeSamplePoints(points: GeometryPoint[], limit = 24) {
  if (points.length < 2) {
    return points;
  }

  const sampled: GeometryPoint[] = [];
  const pushPoint = (point: GeometryPoint) => {
    sampled.push({
      x: round(point.x),
      y: round(point.y)
    });
  };

  for (let index = 0; index < points.length; index += 1) {
    const start = points[index];
    const end = points[(index + 1) % points.length];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.hypot(dx, dy);

    pushPoint(start);
    pushPoint({ x: round((start.x + end.x) / 2), y: round((start.y + end.y) / 2) });

    if (length >= 18) {
      pushPoint({ x: round(start.x + dx / 3), y: round(start.y + dy / 3) });
      pushPoint({ x: round(start.x + (dx * 2) / 3), y: round(start.y + (dy * 2) / 3) });
    }
  }

  return contourSamplePoints(dedupeAnchorPoints(sampled), limit);
}

function contourAnchorPoints(contour: SampledContour) {
  if (!contour.points.length) {
    return [];
  }

  const bounds = contourBounds(contour);
  const sampled = contourSamplePoints(contour.points, contour.closed ? 20 : 12);
  const extremes = [
    contour.points.reduce((best, point) => (point.x < best.x ? point : best), contour.points[0]),
    contour.points.reduce((best, point) => (point.x > best.x ? point : best), contour.points[0]),
    contour.points.reduce((best, point) => (point.y < best.y ? point : best), contour.points[0]),
    contour.points.reduce((best, point) => (point.y > best.y ? point : best), contour.points[0])
  ];
  const interior = contour.closed ? [contourInteriorPoint(contour.points)] : [];

  return dedupeAnchorPoints([
    ...sampled,
    ...extremes,
    ...interior,
    { x: bounds.minX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.minY },
    { x: bounds.maxX, y: bounds.maxY },
    { x: bounds.minX, y: bounds.maxY },
    { x: round((bounds.minX + bounds.maxX) / 2), y: bounds.minY },
    { x: round((bounds.minX + bounds.maxX) / 2), y: bounds.maxY },
    { x: bounds.minX, y: round((bounds.minY + bounds.maxY) / 2) },
    { x: bounds.maxX, y: round((bounds.minY + bounds.maxY) / 2) }
  ]);
}

function extractContourAnchors(contours: SampledContour[]) {
  return dedupeAnchorPoints(contours.flatMap((contour) => contourAnchorPoints(contour)));
}

function polygonArea(points: GeometryPoint[]) {
  return Math.abs(signedPolygonArea(points));
}

function canonicalClosedPointSequence(points: GeometryPoint[]) {
  const tokens = points.map((point) => `${round(point.x)}:${round(point.y)}`);
  if (tokens.length <= 1) {
    return tokens;
  }

  const rotations: string[] = [];
  for (let start = 0; start < tokens.length; start += 1) {
    rotations.push(tokens.slice(start).concat(tokens.slice(0, start)).join(";"));
  }

  const reversed = tokens.slice().reverse();
  for (let start = 0; start < reversed.length; start += 1) {
    rotations.push(reversed.slice(start).concat(reversed.slice(0, start)).join(";"));
  }

  rotations.sort((left, right) => left.localeCompare(right));
  return rotations[0]?.split(";") ?? tokens;
}

function contourSignature(contour: SampledContour) {
  const orderedPoints = (
    contour.closed ? canonicalClosedPointSequence(contour.points) : contour.points.map((point) => `${round(point.x)}:${round(point.y)}`)
  ).join(";");
  return `${contour.closed ? "c" : "o"}:${contour.isHole ? "h" : "s"}:${orderedPoints}`;
}

function variantSignature(variant: PieceVariant) {
  return [
    round(variant.width),
    round(variant.height),
    ...variant.contours
      .map((contour) => contourSignature(contour))
      .sort((left, right) => left.localeCompare(right))
  ].join("|");
}

function placementsSignature(placements: PreparedPlacement[]) {
  return placements
    .map((placement) =>
      [
        placement.pieceId,
        round(placement.x),
        round(placement.y),
        round(placement.width),
        round(placement.height),
        placement.rotation
      ].join(":")
    )
    .sort((left, right) => left.localeCompare(right))
    .join("|");
}

function getPlacementsSignature(placements: PreparedPlacement[], cache?: PlacementSearchCache) {
  return placementsSignature(placements);
}

function collisionSignature(
  x: number,
  y: number,
  variant: PieceVariant,
  placements: PreparedPlacement[],
  config: NestingConfig,
  cache?: PlacementSearchCache
) {
  return [
    variant.signature,
    round(x),
    round(y),
    getPlacementsSignature(placements, cache),
    round(config.pieceGap),
    round(config.kerf)
  ].join("::");
}

function scoreSignature(
  x: number,
  y: number,
  variant: PieceVariant,
  placements: PreparedPlacement[],
  material: { width: number; height: number },
  cache?: PlacementSearchCache
) {
  return [
    variant.signature,
    round(x),
    round(y),
    getPlacementsSignature(placements, cache),
    round(material.width),
    round(material.height)
  ].join("::");
}

function preparePiece(piece: PieceItem, config: NestingConfig): PreparedPiece | null {
  const sampledContours = piece.geometry.entities.flatMap((entity) => sampleEntityContours(piece, entity));
  const closedContours = classifyClosedContours(
    sampledContours.filter((contour) => contour.closed && contour.points.length >= 3)
  );
  const openContours = sampledContours.filter((contour) => !contour.closed && contour.points.length >= 2);
  const baseContours = [...closedContours, ...openContours];

  if (!baseContours.length) {
    return null;
  }

  const area = closedContours.length
    ? closedContours.reduce(
        (sum, contour) => sum + polygonArea(contour.points) * (contour.isHole ? -1 : 1),
        0
      )
    : piece.geometry.width * piece.geometry.height;
  const angles = config.keepOrientation ? [0] : rotationAngles(config);
  const uniqueAngles = [...new Set(angles)];

  return {
    pieceId: piece.id,
    area,
    variants: (() => {
      const variants: PieceVariant[] = [];
      const seen = new Set<string>();

      uniqueAngles.forEach((rotation) => {
        const rotated = baseContours.map((contour) => ({
          ...contour,
          points: contour.points.map((point) => rotatePoint(point, rotation))
        }));
        const normalized = normalizeContours(rotated);
        const variant: PieceVariant = {
          rotation,
          width: normalized.width,
          height: normalized.height,
          contours: normalized.contours,
          anchors: extractContourAnchors(normalized.contours),
          signature: ""
        };
        const signature = variantSignature(variant);
        if (seen.has(signature)) {
          return;
        }

        variant.signature = signature;
        seen.add(signature);
        variants.push(variant);
      });

      return variants;
    })()
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

interface AttemptGene {
  order: number[];
  variantOffsets: number[];
}

interface EvaluatedGene {
  gene: AttemptGene;
  result: NestingResult;
}

interface PlacementSearchCache {
  candidateCoordinates: Map<string, CandidateCoordinates>;
  collisionChecks: Map<string, boolean>;
  freeRegionPolygons: Map<string, GeometryPoint[][]>;
  scoreChecks: Map<string, number>;
  settledPlacements: Map<string, { x: number; y: number }>;
  translatedContours: Map<string, SampledContour[]>;
}

interface RectRegion {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

interface PlacementOption {
  x: number;
  y: number;
  variant: PieceVariant;
  score: number;
  sheetIndex: number;
}

interface PartialStateScore {
  usedSheets: number;
  totalWidth: number;
  totalHeight: number;
  totalFootprintArea: number;
  placements: number;
}

interface BranchEvaluation {
  option: PlacementOption;
  currentState: PartialStateScore;
  finalState: PartialStateScore;
  placeableCount: number;
}

interface CandidateCoordinates {
  x: number[];
  y: number[];
  direct: Array<{ x: number; y: number }>;
}

function createSeededRandom(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function shuffleArray<T>(items: T[], random: () => number) {
  const copy = items.slice();
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    const current = copy[index];
    copy[index] = copy[swapIndex];
    copy[swapIndex] = current;
  }
  return copy;
}

function rotateArray<T>(items: T[], offset: number) {
  if (!items.length) {
    return items;
  }

  const normalizedOffset = ((offset % items.length) + items.length) % items.length;
  if (normalizedOffset === 0) {
    return items.slice();
  }

  return items.slice(normalizedOffset).concat(items.slice(0, normalizedOffset));
}

function buildAttemptPiecesFromGene(expanded: PreparedPiece[], gene: AttemptGene) {
  return gene.order.map((pieceIndex) => {
    const prepared = expanded[pieceIndex];
    const preferredVariantCount = Math.max(prepared.viableVariantCount || 0, 0);
    const variantCount = Math.max(preferredVariantCount || prepared.variants.length, 1);
    const variantOffset = gene.variantOffsets[pieceIndex] % variantCount;
    return {
      ...prepared,
      variants: rotateArray(prepared.variants, variantOffset)
    };
  });
}

function createBaseGene(expanded: PreparedPiece[]) {
  return {
    order: expanded.map((_, index) => index),
    variantOffsets: expanded.map(() => 0)
  };
}

function geneSignature(gene: AttemptGene) {
  return `${gene.order.join(",")}|${gene.variantOffsets.join(",")}`;
}

function createHeuristicGenes(expanded: PreparedPiece[]) {
  const indexes = expanded.map((_, index) => index);
  const byPrimaryWidth = indexes
    .slice()
    .sort((left, right) => expanded[right].variants[0].width - expanded[left].variants[0].width);
  const byPrimaryHeight = indexes
    .slice()
    .sort((left, right) => expanded[right].variants[0].height - expanded[left].variants[0].height);
  const byPrimaryPerimeter = indexes
    .slice()
    .sort(
      (left, right) =>
        expanded[right].variants[0].width +
          expanded[right].variants[0].height -
          (expanded[left].variants[0].width + expanded[left].variants[0].height)
    );

  const zigzag: number[] = [];
  let start = 0;
  let end = indexes.length - 1;
  while (start <= end) {
    zigzag.push(indexes[start]);
    if (start !== end) {
      zigzag.push(indexes[end]);
    }
    start += 1;
    end -= 1;
  }

  const orders = [
    indexes,
    indexes.slice().reverse(),
    zigzag,
    byPrimaryWidth,
    byPrimaryHeight,
    byPrimaryPerimeter
  ];

  return orders.map((order, heuristicIndex) => ({
    order,
    variantOffsets: expanded.map((piece, pieceIndex) => {
      const variantCount = Math.max(piece.viableVariantCount || piece.variants.length, 1);
      return variantCount <= 1 ? 0 : (pieceIndex + heuristicIndex) % variantCount;
    })
  }));
}

function mutateGene(expanded: PreparedPiece[], source: AttemptGene, random: () => number, intensity: number) {
  const gene: AttemptGene = {
    order: source.order.slice(),
    variantOffsets: source.variantOffsets.slice()
  };

  for (let index = 0; index < gene.order.length; index += 1) {
    if (random() < intensity && index + 1 < gene.order.length) {
      const swapIndex = Math.min(
        gene.order.length - 1,
        index + 1 + Math.floor(random() * Math.min(4, gene.order.length - index - 1))
      );
      const current = gene.order[index];
      gene.order[index] = gene.order[swapIndex];
      gene.order[swapIndex] = current;
    }
  }

  for (let index = 0; index < gene.variantOffsets.length; index += 1) {
    const variantCount = Math.max(expanded[index].viableVariantCount || expanded[index].variants.length, 1);
    if (variantCount <= 1) {
      gene.variantOffsets[index] = 0;
      continue;
    }

    if (random() < intensity) {
      gene.variantOffsets[index] = Math.floor(random() * variantCount);
    }
  }

  return gene;
}

function mateGenes(male: AttemptGene, female: AttemptGene, random: () => number) {
  if (male.order.length <= 2) {
    return [male, female];
  }

  const cutPoint = Math.max(1, Math.min(male.order.length - 1, Math.floor(random() * (male.order.length - 1)) + 1));
  const buildChildOrder = (head: number[], tail: number[]) => {
    const used = new Set(head);
    return head.concat(tail.filter((item) => !used.has(item)));
  };

  const childAOrder = buildChildOrder(male.order.slice(0, cutPoint), female.order);
  const childBOrder = buildChildOrder(female.order.slice(0, cutPoint), male.order);
  const childAVariants = male.variantOffsets.map((offset, index) => (random() < 0.5 ? offset : female.variantOffsets[index]));
  const childBVariants = female.variantOffsets.map((offset, index) => (random() < 0.5 ? offset : male.variantOffsets[index]));

  return [
    { order: childAOrder, variantOffsets: childAVariants },
    { order: childBOrder, variantOffsets: childBVariants }
  ];
}

function randomWeightedGene(population: EvaluatedGene[], random: () => number, excludeIndex?: number) {
  const pool = population.filter((_, index) => index !== excludeIndex);
  const totalWeight = pool.reduce((sum, _, index) => sum + (pool.length - index), 0);
  let cursor = random() * totalWeight;

  for (let index = 0; index < pool.length; index += 1) {
    cursor -= pool.length - index;
    if (cursor <= 0) {
      return pool[index];
    }
  }

  return pool[0];
}

function qualityPopulationSize(config: NestingConfig) {
  switch (config.quality) {
    case "quality":
      return 22;
    case "fast":
      return 8;
    default:
      return 12;
  }
}

function qualityMutationRate(config: NestingConfig) {
  switch (config.quality) {
    case "quality":
      return 0.18;
    case "fast":
      return 0.08;
    default:
      return 0.12;
  }
}

function createInitialPopulation(expanded: PreparedPiece[], config: NestingConfig) {
  const random = createSeededRandom(0x9e3779b9 ^ expanded.length);
  const baseGene = createBaseGene(expanded);
  const population: AttemptGene[] = [];
  const seen = new Set<string>();
  const targetSize = qualityPopulationSize(config);
  const mutationRate = qualityMutationRate(config);

  const pushGene = (gene: AttemptGene) => {
    const signature = geneSignature(gene);
    if (seen.has(signature)) {
      return;
    }
    seen.add(signature);
    population.push(gene);
  };

  pushGene(baseGene);
  createHeuristicGenes(expanded).forEach((gene) => {
    if (population.length < targetSize) {
      pushGene(gene);
    }
  });

  let uniqueAttempts = 0;
  while (population.length < targetSize && uniqueAttempts < targetSize * 24) {
    uniqueAttempts += 1;
    pushGene(mutateGene(expanded, baseGene, random, mutationRate * 1.5));
  }

  while (population.length < targetSize) {
    population.push(mutateGene(expanded, baseGene, random, mutationRate * 1.5));
  }

  return population;
}

function nextGeneration(expanded: PreparedPiece[], population: EvaluatedGene[], config: NestingConfig, generationIndex: number) {
  const random = createSeededRandom(0x85ebca6b ^ (generationIndex + 1) * 2246822519);
  const mutationRate = qualityMutationRate(config);
  const sorted = population.slice().sort((left, right) => {
    if (isBetterResult(left.result, right.result)) {
      return -1;
    }
    if (isBetterResult(right.result, left.result)) {
      return 1;
    }
    return 0;
  });

  const next: AttemptGene[] = [];
  const seen = new Set<string>();
  const pushGene = (gene: AttemptGene) => {
    const signature = geneSignature(gene);
    if (seen.has(signature)) {
      return;
    }
    seen.add(signature);
    next.push(gene);
  };

  pushGene(sorted[0].gene);
  if (sorted.length > 1) {
    pushGene(sorted[1].gene);
  }

  let uniqueAttempts = 0;
  while (next.length < sorted.length && uniqueAttempts < sorted.length * 24) {
    uniqueAttempts += 1;
    const male = randomWeightedGene(sorted, random);
    const female = randomWeightedGene(sorted, random, sorted.indexOf(male));
    const [childA, childB] = mateGenes(male.gene, female.gene, random);
    pushGene(mutateGene(expanded, childA, random, mutationRate));
    if (next.length < sorted.length) {
      pushGene(mutateGene(expanded, childB, random, mutationRate));
    }
    if (next.length < sorted.length) {
      for (let attempts = 0; attempts < 3 && next.length < sorted.length; attempts += 1) {
        pushGene(mutateGene(expanded, sorted[0].gene, random, mutationRate * 1.25));
      }
    }
  }

  while (next.length < sorted.length) {
    next.push(mutateGene(expanded, sorted[0].gene, random, mutationRate * 1.25));
  }

  return next.slice(0, sorted.length);
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

function translatedContoursSignature(variant: PieceVariant, x: number, y: number) {
  return `${variant.signature}::${round(x)}::${round(y)}`;
}

function getTranslatedContours(
  variant: PieceVariant,
  x: number,
  y: number,
  cache?: PlacementSearchCache
) {
  const cacheKey = translatedContoursSignature(variant, x, y);
  const cached = cache?.translatedContours.get(cacheKey);
  if (cached) {
    return cached.map((contour) => ({
      ...contour,
      points: contour.points.map((point) => ({ x: point.x, y: point.y }))
    }));
  }

  const translated = translateContours(variant.contours, x, y);
  cache?.translatedContours.set(
    cacheKey,
    translated.map((contour) => ({
      ...contour,
      points: contour.points.map((point) => ({ x: point.x, y: point.y }))
    }))
  );
  return translated;
}

function contourBounds(contour: SampledContour) {
  return {
    minX: Math.min(...contour.points.map((point) => point.x)),
    minY: Math.min(...contour.points.map((point) => point.y)),
    maxX: Math.max(...contour.points.map((point) => point.x)),
    maxY: Math.max(...contour.points.map((point) => point.y))
  };
}

function boundsCanFitInside(outer: ReturnType<typeof contourBounds>, width: number, height: number, gap: number) {
  return outer.maxX - outer.minX >= width + gap * 2 && outer.maxY - outer.minY >= height + gap * 2;
}

function segmentsIntersect(a1: GeometryPoint, a2: GeometryPoint, b1: GeometryPoint, b2: GeometryPoint) {
  const epsilon = 0.000001;
  const cross = (
    p1: GeometryPoint,
    p2: GeometryPoint,
    p3: GeometryPoint
  ) => (p2.x - p1.x) * (p3.y - p1.y) - (p2.y - p1.y) * (p3.x - p1.x);
  const onSegment = (start: GeometryPoint, point: GeometryPoint, end: GeometryPoint) =>
    point.x >= Math.min(start.x, end.x) - epsilon &&
    point.x <= Math.max(start.x, end.x) + epsilon &&
    point.y >= Math.min(start.y, end.y) - epsilon &&
    point.y <= Math.max(start.y, end.y) + epsilon;

  const denominator = (a2.x - a1.x) * (b2.y - b1.y) - (a2.y - a1.y) * (b2.x - b1.x);
  if (Math.abs(denominator) < epsilon) {
    const crossA = cross(a1, a2, b1);
    const crossB = cross(a1, a2, b2);
    if (Math.abs(crossA) > epsilon || Math.abs(crossB) > epsilon) {
      return false;
    }

    // Collinear touch is allowed here; filled-overlap is handled separately by point-in-polygon tests.
    return false;
  }

  const ua = ((b2.x - b1.x) * (a1.y - b1.y) - (b2.y - b1.y) * (a1.x - b1.x)) / denominator;
  const ub = ((a2.x - a1.x) * (a1.y - b1.y) - (a2.y - a1.y) * (a1.x - b1.x)) / denominator;
  return ua > epsilon && ua < 1 - epsilon && ub > epsilon && ub < 1 - epsilon;
}

function pointToSegmentDistance(point: GeometryPoint, start: GeometryPoint, end: GeometryPoint) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 0.000001) {
    return Math.hypot(point.x - start.x, point.y - start.y);
  }

  const projection = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSquared;
  const clamped = Math.max(0, Math.min(1, projection));
  const closestX = start.x + dx * clamped;
  const closestY = start.y + dy * clamped;
  return Math.hypot(point.x - closestX, point.y - closestY);
}

function pointInPolygon(point: GeometryPoint, polygon: GeometryPoint[]) {
  const epsilon = 0.000001;
  const isPointOnSegment = (start: GeometryPoint, end: GeometryPoint) => {
    const cross = (end.x - start.x) * (point.y - start.y) - (end.y - start.y) * (point.x - start.x);
    if (Math.abs(cross) > epsilon) {
      return false;
    }

    return (
      point.x >= Math.min(start.x, end.x) - epsilon &&
      point.x <= Math.max(start.x, end.x) + epsilon &&
      point.y >= Math.min(start.y, end.y) - epsilon &&
      point.y <= Math.max(start.y, end.y) + epsilon
    );
  };

  let inside = false;

  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i].x;
    const yi = polygon[i].y;
    const xj = polygon[j].x;
    const yj = polygon[j].y;

    if (isPointOnSegment(polygon[j], polygon[i])) {
      return true;
    }

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

  return false;
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

function pointInFilledContours(point: GeometryPoint, contours: SampledContour[]) {
  let depth = 0;

  contours.forEach((contour) => {
    if (contour.closed && contour.points.length >= 3 && pointInPolygon(point, contour.points)) {
      depth += 1;
    }
  });

  return depth % 2 === 1;
}

function candidateUsesHoleSpace(candidateContours: SampledContour[], placements: PreparedPlacement[]) {
  const candidateSolid = candidateContours.filter((contour) => contour.closed && !contour.isHole && contour.points.length >= 3);
  if (!candidateSolid.length) {
    return false;
  }

  const candidateBounds = candidateSolid.map(contourBounds);
  const representativePoints = candidateSolid.map((contour) => contourRepresentativePoint(contour.points));

  return placements.some((placement) =>
    placement.contours
      .filter((contour) => contour.closed && contour.isHole && contour.points.length >= 3)
      .some((holeContour) => {
        const holeBounds = contourBounds(holeContour);
        return representativePoints.some((point, index) => {
          const bounds = candidateBounds[index];
          return (
            pointInPolygon(point, holeContour.points) &&
            bounds.minX >= holeBounds.minX - 0.001 &&
            bounds.maxX <= holeBounds.maxX + 0.001 &&
            bounds.minY >= holeBounds.minY - 0.001 &&
            bounds.maxY <= holeBounds.maxY + 0.001
          );
        });
      })
  );
}

function contoursCollide(candidate: SampledContour[], placed: SampledContour[]) {
  const candidateClosed = candidate.filter((contour) => contour.closed && contour.points.length >= 3);
  const candidateOpen = candidate.filter((contour) => !contour.closed && contour.points.length >= 2);
  const placedClosed = placed.filter((contour) => contour.closed && contour.points.length >= 3);
  const placedOpen = placed.filter((contour) => !contour.closed && contour.points.length >= 2);
  const candidateSolid = candidateClosed.filter((contour) => !contour.isHole);
  const placedSolid = placedClosed.filter((contour) => !contour.isHole);

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

  for (const contour of candidateSolid) {
    if (pointInFilledContours(contourInteriorPoint(contour.points), placedClosed)) {
      return true;
    }
  }

  for (const contour of placedSolid) {
    if (pointInFilledContours(contourInteriorPoint(contour.points), candidateClosed)) {
      return true;
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

function variantCanPossiblyFit(
  variant: PieceVariant,
  material: { width: number; height: number },
  config: NestingConfig
) {
  return (
    variant.width <= material.width - config.edgeGap * 2 + 0.001 &&
    variant.height <= material.height - config.edgeGap * 2 + 0.001
  );
}

function qualityPlacementOptionLimit(config: NestingConfig) {
  switch (config.quality) {
    case "quality":
      return 3;
    case "balanced":
      return 2;
    default:
      return 1;
  }
}

function qualityLookaheadDepth(config: NestingConfig) {
  switch (config.quality) {
    case "quality":
      return 2;
    case "balanced":
      return 1;
    default:
      return 0;
  }
}

function prioritizeVariantsForMaterial(
  expanded: PreparedPiece[],
  material: { width: number; height: number },
  config: NestingConfig
) {
  return expanded.map((piece) => {
    const indexed = piece.variants.map((variant, index) => ({ variant, index }));
    const sorted = indexed.slice().sort((left, right) => {
      const leftFits = variantCanPossiblyFit(left.variant, material, config);
      const rightFits = variantCanPossiblyFit(right.variant, material, config);

      if (leftFits !== rightFits) {
        return leftFits ? -1 : 1;
      }

      const leftFootprint = left.variant.width + left.variant.height;
      const rightFootprint = right.variant.width + right.variant.height;
      if (Math.abs(leftFootprint - rightFootprint) > 0.0001) {
        return leftFootprint - rightFootprint;
      }

      return left.index - right.index;
    });

    return {
      ...piece,
      variants: sorted.map((entry) => entry.variant),
      viableVariantCount: sorted.filter((entry) => variantCanPossiblyFit(entry.variant, material, config)).length
    };
  });
}

function sortPiecesForMaterial(
  expanded: PreparedPiece[],
  material: { width: number; height: number },
  config: NestingConfig
) {
  return expanded.slice().sort((left, right) => {
    const leftViable = Math.max(left.viableVariantCount || 0, 0);
    const rightViable = Math.max(right.viableVariantCount || 0, 0);

    const leftHasViable = leftViable > 0;
    const rightHasViable = rightViable > 0;
    if (leftHasViable !== rightHasViable) {
      return leftHasViable ? -1 : 1;
    }

    if (leftViable !== rightViable) {
      return leftViable - rightViable;
    }

    if (config.prioritizeLarge && Math.abs(left.area - right.area) > 0.0001) {
      return right.area - left.area;
    }

    const leftPrimary = left.variants[0];
    const rightPrimary = right.variants[0];
    const leftSpan = Math.max(leftPrimary?.width ?? 0, leftPrimary?.height ?? 0);
    const rightSpan = Math.max(rightPrimary?.width ?? 0, rightPrimary?.height ?? 0);
    if (Math.abs(leftSpan - rightSpan) > 0.0001) {
      return rightSpan - leftSpan;
    }

    const leftPerimeter = (leftPrimary?.width ?? 0) + (leftPrimary?.height ?? 0);
    const rightPerimeter = (rightPrimary?.width ?? 0) + (rightPrimary?.height ?? 0);
    return rightPerimeter - leftPerimeter;
  });
}

function placementCollides(
  x: number,
  y: number,
  variant: PieceVariant,
  placements: PreparedPlacement[],
  config: NestingConfig,
  cache?: PlacementSearchCache
) {
  const cacheKey = collisionSignature(x, y, variant, placements, config, cache);
  const cached = cache?.collisionChecks.get(cacheKey);
  if (typeof cached === "boolean") {
    return cached;
  }

  const inflate = (config.pieceGap + config.kerf) / 2;
  const candidate = getTranslatedContours(variant, x, y, cache);

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
      cache?.collisionChecks.set(cacheKey, true);
      return true;
    }
  }

  cache?.collisionChecks.set(cacheKey, false);
  return false;
}

export function limitCandidateAxis(values: number[], maxCount: number, preferred: number[] = []) {
  if (values.length <= maxCount) {
    return values.slice();
  }

  const unique = [...new Set(values)].sort((a, b) => a - b);
  if (unique.length <= maxCount) {
    return unique;
  }

  const selected = new Set<number>();
  const pushValue = (value: number) => {
    if (selected.size >= maxCount) {
      return;
    }
    if (unique.includes(value)) {
      selected.add(value);
    }
  };

  for (const value of preferred) {
    pushValue(value);
  }

  pushValue(unique[0]);
  pushValue(unique[unique.length - 1]);

  const interiorTarget = Math.max(maxCount - selected.size, 0);
  if (interiorTarget > 0) {
    const step = (unique.length - 1) / Math.max(interiorTarget - 1, 1);
    for (let index = 0; index < interiorTarget; index += 1) {
      pushValue(unique[Math.round(index * step)]);
    }
  }

  if (selected.size < maxCount) {
    const center = (unique[0] + unique[unique.length - 1]) / 2;
    unique
      .slice()
      .sort((left, right) => Math.abs(left - center) - Math.abs(right - center))
      .forEach((value) => pushValue(value));
  }

  return [...selected].sort((a, b) => a - b);
}

function normalizeRect(rect: RectRegion): RectRegion | null {
  const minX = round(Math.min(rect.minX, rect.maxX));
  const minY = round(Math.min(rect.minY, rect.maxY));
  const maxX = round(Math.max(rect.minX, rect.maxX));
  const maxY = round(Math.max(rect.minY, rect.maxY));

  if (maxX - minX <= 0.001 || maxY - minY <= 0.001) {
    return null;
  }

  return { minX, minY, maxX, maxY };
}

function rectsOverlap(a: RectRegion, b: RectRegion) {
  return !(a.maxX <= b.minX + 0.001 || a.minX >= b.maxX - 0.001 || a.maxY <= b.minY + 0.001 || a.minY >= b.maxY - 0.001);
}

function subtractRectRegion(source: RectRegion, blocker: RectRegion) {
  if (!rectsOverlap(source, blocker)) {
    return [source];
  }

  const intersection = normalizeRect({
    minX: Math.max(source.minX, blocker.minX),
    minY: Math.max(source.minY, blocker.minY),
    maxX: Math.min(source.maxX, blocker.maxX),
    maxY: Math.min(source.maxY, blocker.maxY)
  });

  if (!intersection) {
    return [source];
  }

  const fragments = [
    normalizeRect({
      minX: source.minX,
      minY: source.minY,
      maxX: intersection.minX,
      maxY: source.maxY
    }),
    normalizeRect({
      minX: intersection.maxX,
      minY: source.minY,
      maxX: source.maxX,
      maxY: source.maxY
    }),
    normalizeRect({
      minX: intersection.minX,
      minY: source.minY,
      maxX: intersection.maxX,
      maxY: intersection.minY
    }),
    normalizeRect({
      minX: intersection.minX,
      minY: intersection.maxY,
      maxX: intersection.maxX,
      maxY: source.maxY
    })
  ].filter((fragment): fragment is RectRegion => Boolean(fragment));

  return fragments.filter(
    (fragment, index, all) =>
      !all.some(
        (other, otherIndex) =>
          otherIndex !== index &&
          fragment.minX >= other.minX - 0.001 &&
          fragment.maxX <= other.maxX + 0.001 &&
          fragment.minY >= other.minY - 0.001 &&
          fragment.maxY <= other.maxY + 0.001
      )
  );
}

function freeRectanglesFromPlacements(
  placements: PreparedPlacement[],
  material: { width: number; height: number },
  config: NestingConfig
) {
  const materialRect = normalizeRect({
    minX: config.edgeGap,
    minY: config.edgeGap,
    maxX: material.width - config.edgeGap,
    maxY: material.height - config.edgeGap
  });

  if (!materialRect) {
    return [];
  }

  const inflate = config.pieceGap + config.kerf;
  let regions = [materialRect];

  placements.forEach((placement) => {
    const blocker = normalizeRect({
      minX: placement.x - inflate,
      minY: placement.y - inflate,
      maxX: placement.x + placement.width + inflate,
      maxY: placement.y + placement.height + inflate
    });

    if (!blocker) {
      return;
    }

    regions = regions.flatMap((region) => subtractRectRegion(region, blocker));
  });

  return regions.filter((region, index, all) => {
    const width = region.maxX - region.minX;
    const height = region.maxY - region.minY;
    if (width <= 0.001 || height <= 0.001) {
      return false;
    }

    return !all.some(
      (other, otherIndex) =>
        otherIndex !== index &&
        region.minX >= other.minX - 0.001 &&
        region.maxX <= other.maxX + 0.001 &&
        region.minY >= other.minY - 0.001 &&
        region.maxY <= other.maxY + 0.001
    );
  });
}

function freeRegionPolygonsFromPlacements(
  placements: PreparedPlacement[],
  material: { width: number; height: number },
  config: NestingConfig,
  cache?: PlacementSearchCache
) {
  if (!hasClipperLib()) {
    return [];
  }

  const cacheKey = `${getPlacementsSignature(placements, cache)}::${material.width}x${material.height}::${config.edgeGap}:${config.pieceGap}:${config.kerf}`;
  const cached = cache?.freeRegionPolygons.get(cacheKey);
  if (cached) {
    return cached.map((path: GeometryPoint[]) => path.map((point: GeometryPoint) => ({ x: point.x, y: point.y })));
  }

  const materialRect = normalizeRect({
    minX: config.edgeGap,
    minY: config.edgeGap,
    maxX: material.width - config.edgeGap,
    maxY: material.height - config.edgeGap
  });

  if (!materialRect) {
    return [];
  }

  const inflate = config.pieceGap + config.kerf;
  const solidContourPaths = placements.flatMap((placement) =>
    placement.contours
      .filter((contour) => contour.closed && !contour.isHole && contour.points.length >= 3)
      .map((contour) => contour.points)
  );
  const inflatedSolidPolygons = offsetPaths(solidContourPaths, inflate / 2);
  const blockerRects = placements
    .map((placement) =>
      normalizeRect({
        minX: placement.x - inflate,
        minY: placement.y - inflate,
        maxX: placement.x + placement.width + inflate,
        maxY: placement.y + placement.height + inflate
      })
    )
    .filter((rect): rect is RectRegion => Boolean(rect))
    .map((rect) => rectanglePath(rect.minX, rect.minY, rect.maxX, rect.maxY));

  const blockerUnion = unionPaths([...inflatedSolidPolygons, ...blockerRects]);
  const freePolygons = differencePaths(
    [rectanglePath(materialRect.minX, materialRect.minY, materialRect.maxX, materialRect.maxY)],
    blockerUnion
  );
  const cleanedPolygons = cleanPaths(freePolygons, 0.001);
  const minimumArea = Math.max(0.05, (config.pieceGap + config.kerf + 0.5) * (config.pieceGap + config.kerf + 0.5) * 0.1);
  const usablePolygons = cleanedPolygons.filter(
    (path: GeometryPoint[]) => path.length >= 3 && clipperPolygonArea(path) >= minimumArea
  );

  cache?.freeRegionPolygons.set(
    cacheKey,
    usablePolygons.map((path: GeometryPoint[]) => path.map((point: GeometryPoint) => ({ x: point.x, y: point.y })))
  );

  return usablePolygons;
}

function candidateCoordinates(
  variant: PieceVariant,
  placements: PreparedPlacement[],
  material: { width: number; height: number },
  config: NestingConfig,
  cache?: PlacementSearchCache
): CandidateCoordinates {
  const cacheKey = `${variant.signature}::${getPlacementsSignature(placements, cache)}::${material.width}x${material.height}::${config.edgeGap}:${config.pieceGap}:${config.kerf}`;
  const cached = cache?.candidateCoordinates.get(cacheKey);
  if (cached) {
    return {
      x: cached.x.slice(),
      y: cached.y.slice(),
      direct: cached.direct.map((candidate) => ({ x: candidate.x, y: candidate.y }))
    };
  }

  const xCandidates = new Set<number>([config.edgeGap, round(material.width - config.edgeGap - variant.width)]);
  const yCandidates = new Set<number>([config.edgeGap, round(material.height - config.edgeGap - variant.height)]);
  const directCandidates = new Map<string, { x: number; y: number }>();
  const variantPoints = variant.anchors.length ? variant.anchors : extractContourAnchors(variant.contours);
  const pushDirectCandidate = (x: number, y: number) => {
    const normalizedX = round(x);
    const normalizedY = round(y);
    const key = `${normalizedX}:${normalizedY}`;
    if (!directCandidates.has(key)) {
      directCandidates.set(key, { x: normalizedX, y: normalizedY });
    }
  };

  if (placements.length === 0) {
    const materialBoundaryPoints = polygonEdgeSamplePoints(
      rectanglePath(
        config.edgeGap,
        config.edgeGap,
        material.width - config.edgeGap,
        material.height - config.edgeGap
      ),
      20
    );

    materialBoundaryPoints.forEach((boundaryPoint) => {
      variantPoints.forEach((variantPoint) => {
        pushDirectCandidate(boundaryPoint.x - variantPoint.x, boundaryPoint.y - variantPoint.y);
      });
    });

    pushDirectCandidate(config.edgeGap, config.edgeGap);
    pushDirectCandidate(round(material.width - config.edgeGap - variant.width), config.edgeGap);
    pushDirectCandidate(config.edgeGap, round(material.height - config.edgeGap - variant.height));
  }

  placements.forEach((placement) => {
    xCandidates.add(round(placement.x + placement.width + config.pieceGap));
    yCandidates.add(round(placement.y + placement.height + config.pieceGap));
    xCandidates.add(round(placement.x));
    yCandidates.add(round(placement.y));
    xCandidates.add(round(placement.x - variant.width - config.pieceGap));
    yCandidates.add(round(placement.y - variant.height - config.pieceGap));

    const placedPoints = placement.anchors.length ? placement.anchors : extractContourAnchors(placement.contours);
    const placedBoundaryPoints = dedupeAnchorPoints(
      placement.contours
        .filter((contour) => contour.points.length >= 2)
        .flatMap((contour) => polygonEdgeSamplePoints(contour.points, contour.closed ? 20 : 10))
    );
    const allPlacedPoints = dedupeAnchorPoints([...placedPoints, ...placedBoundaryPoints]);

    allPlacedPoints.forEach((placedPoint) => {
      variantPoints.forEach((variantPoint) => {
        xCandidates.add(round(placedPoint.x - variantPoint.x));
        yCandidates.add(round(placedPoint.y - variantPoint.y));
        xCandidates.add(round(placedPoint.x - variantPoint.x - config.pieceGap));
        yCandidates.add(round(placedPoint.y - variantPoint.y - config.pieceGap));
        xCandidates.add(round(placedPoint.x - variantPoint.x + config.pieceGap));
        yCandidates.add(round(placedPoint.y - variantPoint.y + config.pieceGap));
        pushDirectCandidate(placedPoint.x - variantPoint.x, placedPoint.y - variantPoint.y);
      });
    });

    placement.contours
      .filter((contour) => contour.closed && contour.isHole && contour.points.length >= 3)
      .forEach((holeContour) => {
        const holeBounds = contourBounds(holeContour);
        if (!boundsCanFitInside(holeBounds, variant.width, variant.height, config.pieceGap + config.kerf)) {
          return;
        }

        xCandidates.add(round(holeBounds.minX + config.pieceGap + config.kerf));
        yCandidates.add(round(holeBounds.minY + config.pieceGap + config.kerf));
        xCandidates.add(round(holeBounds.maxX - variant.width - config.pieceGap - config.kerf));
        yCandidates.add(round(holeBounds.maxY - variant.height - config.pieceGap - config.kerf));
        xCandidates.add(round(holeBounds.minX + (holeBounds.maxX - holeBounds.minX - variant.width) / 2));
        yCandidates.add(round(holeBounds.minY + (holeBounds.maxY - holeBounds.minY - variant.height) / 2));

        const holePoints = holeContour.points.filter(
          (_, index, points) => points.length <= 16 || index % Math.max(1, Math.floor(points.length / 16)) === 0
        );
        holePoints.forEach((holePoint) => {
          variantPoints.forEach((variantPoint) => {
            xCandidates.add(round(holePoint.x - variantPoint.x));
            yCandidates.add(round(holePoint.y - variantPoint.y));
            pushDirectCandidate(holePoint.x - variantPoint.x, holePoint.y - variantPoint.y);
          });
        });
      });
  });

  const freeRectangles = freeRectanglesFromPlacements(placements, material, config);
  freeRectangles.forEach((region) => {
    const availableWidth = region.maxX - region.minX;
    const availableHeight = region.maxY - region.minY;
    if (availableWidth + 0.001 < variant.width || availableHeight + 0.001 < variant.height) {
      return;
    }

    xCandidates.add(round(region.minX));
    yCandidates.add(round(region.minY));
    xCandidates.add(round(region.maxX - variant.width));
    yCandidates.add(round(region.maxY - variant.height));
    xCandidates.add(round(region.minX + (availableWidth - variant.width) / 2));
    yCandidates.add(round(region.minY + (availableHeight - variant.height) / 2));
    pushDirectCandidate(region.minX, region.minY);
    pushDirectCandidate(region.maxX - variant.width, region.maxY - variant.height);
    pushDirectCandidate(region.minX + (availableWidth - variant.width) / 2, region.minY + (availableHeight - variant.height) / 2);
  });

  const freePolygons = freeRegionPolygonsFromPlacements(placements, material, config, cache);
  freePolygons.forEach((polygon: GeometryPoint[]) => {
    const bounds = pathBounds(polygon);
    const availableWidth = bounds.maxX - bounds.minX;
    const availableHeight = bounds.maxY - bounds.minY;
    if (availableWidth + 0.001 < variant.width || availableHeight + 0.001 < variant.height) {
      return;
    }

    xCandidates.add(round(bounds.minX));
    yCandidates.add(round(bounds.minY));
    xCandidates.add(round(bounds.maxX - variant.width));
    yCandidates.add(round(bounds.maxY - variant.height));
    xCandidates.add(round(bounds.minX + (availableWidth - variant.width) / 2));
    yCandidates.add(round(bounds.minY + (availableHeight - variant.height) / 2));
    pushDirectCandidate(bounds.minX, bounds.minY);
    pushDirectCandidate(bounds.maxX - variant.width, bounds.maxY - variant.height);
    pushDirectCandidate(bounds.minX + (availableWidth - variant.width) / 2, bounds.minY + (availableHeight - variant.height) / 2);

    const boundarySamples = polygonEdgeSamplePoints(polygon, 28);
    boundarySamples.forEach((point: GeometryPoint) => {
      variantPoints.forEach((variantPoint) => {
        xCandidates.add(round(point.x - variantPoint.x));
        yCandidates.add(round(point.y - variantPoint.y));
        pushDirectCandidate(point.x - variantPoint.x, point.y - variantPoint.y);
      });
    });
  });

  const gridStep = Math.max(20, Math.round(config.pieceGap + config.kerf + 12));
  for (let x = config.edgeGap; x <= material.width - config.edgeGap; x += gridStep) {
    xCandidates.add(round(x));
  }
  for (let y = config.edgeGap; y <= material.height - config.edgeGap; y += gridStep) {
    yCandidates.add(round(y));
  }

  const filteredX = [...xCandidates]
    .filter((value) => value >= config.edgeGap && value <= material.width - config.edgeGap)
    .sort((a, b) => a - b);
  const filteredY = [...yCandidates]
    .filter((value) => value >= config.edgeGap && value <= material.height - config.edgeGap)
    .sort((a, b) => a - b);

  const orderedX = limitCandidateAxis(filteredX, 120, [
    config.edgeGap,
    round(material.width - config.edgeGap - variant.width),
    round(config.edgeGap + (material.width - config.edgeGap * 2 - variant.width) / 2)
  ]);
  const orderedY = limitCandidateAxis(filteredY, 120, [
    config.edgeGap,
    round(material.height - config.edgeGap - variant.height),
    round(config.edgeGap + (material.height - config.edgeGap * 2 - variant.height) / 2)
  ]);

  const result = {
    x: orderedX,
    y: orderedY,
    direct: rankDirectCandidates(
      [...directCandidates.values()].filter(
        (candidate) =>
          candidate.x >= config.edgeGap - 0.001 &&
          candidate.y >= config.edgeGap - 0.001 &&
          candidate.x <= material.width - config.edgeGap + 0.001 &&
          candidate.y <= material.height - config.edgeGap + 0.001
      ),
      variant,
      placements,
      material,
      config,
      cache
    )
      .slice(0, 160)
  };

  cache?.candidateCoordinates.set(cacheKey, {
    x: orderedX.slice(),
    y: orderedY.slice(),
    direct: result.direct.map((candidate) => ({ x: candidate.x, y: candidate.y }))
  });

  return result;
}

function combinedPlacementBounds(candidateContours: SampledContour[], placements: PreparedPlacement[]) {
  const allPoints = [
    ...candidateContours.flatMap((contour) => contour.points),
    ...placements.flatMap((placement) => placement.contours.flatMap((contour) => contour.points))
  ];

  return {
    minX: Math.min(...allPoints.map((point) => point.x)),
    minY: Math.min(...allPoints.map((point) => point.y)),
    maxX: Math.max(...allPoints.map((point) => point.x)),
    maxY: Math.max(...allPoints.map((point) => point.y))
  };
}

function directCandidateFootprintScore(
  x: number,
  y: number,
  variant: PieceVariant,
  placements: PreparedPlacement[],
  cache?: PlacementSearchCache
) {
  const candidateContours = getTranslatedContours(variant, x, y, cache);
  const bounds = combinedPlacementBounds(candidateContours, placements);
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  return width * 2 + height;
}

function rankDirectCandidates(
  candidates: Array<{ x: number; y: number }>,
  variant: PieceVariant,
  placements: PreparedPlacement[],
  material: { width: number; height: number },
  config: NestingConfig,
  cache?: PlacementSearchCache
) {
  return candidates
    .map((candidate) => {
      const candidateContours = getTranslatedContours(variant, candidate.x, candidate.y, cache);
      return {
        ...candidate,
        footprintScore: directCandidateFootprintScore(candidate.x, candidate.y, variant, placements, cache),
        contactBoost: contactScore(candidateContours, placements, material, config)
      };
    })
    .sort((left, right) => {
      if (Math.abs(left.footprintScore - right.footprintScore) > 0.0001) {
        return left.footprintScore - right.footprintScore;
      }
      if (Math.abs(left.contactBoost - right.contactBoost) > 0.0001) {
        return right.contactBoost - left.contactBoost;
      }
      if (left.y !== right.y) {
        return left.y - right.y;
      }
      return left.x - right.x;
    })
    .map(({ x, y }) => ({ x, y }));
}

function solidClosedContours(contours: SampledContour[]) {
  return contours.filter((contour) => contour.closed && !contour.isHole && contour.points.length >= 3);
}

function contoursArea(contours: SampledContour[]) {
  return contours.reduce((sum, contour) => sum + Math.abs(signedPolygonArea(contour.points)), 0);
}

function polygonContainsCandidateContours(
  polygon: GeometryPoint[],
  candidateContours: SampledContour[],
  candidateBounds: ReturnType<typeof combinedPlacementBounds>,
  candidateArea: number
) {
  const polygonBounds = pathBounds(polygon);
  if (
    candidateBounds.minX < polygonBounds.minX - 0.001 ||
    candidateBounds.maxX > polygonBounds.maxX + 0.001 ||
    candidateBounds.minY < polygonBounds.minY - 0.001 ||
    candidateBounds.maxY > polygonBounds.maxY + 0.001
  ) {
    return false;
  }

  const representativePoints = candidateContours.map((contour) => contourInteriorPoint(contour.points));
  if (!representativePoints.every((point) => pointInPolygon(point, polygon))) {
    return false;
  }

  const intersections = intersectionPaths(
    [polygon],
    candidateContours.map((contour) => contour.points)
  );
  if (!intersections.length) {
    return false;
  }

  const coveredArea = intersections.reduce((sum: number, path: GeometryPoint[]) => sum + clipperPolygonArea(path), 0);
  return coveredArea + 0.05 >= candidateArea;
}

function feasibleRegionSlackScore(
  candidateContours: SampledContour[],
  placements: PreparedPlacement[],
  material: { width: number; height: number },
  config: NestingConfig,
  cache?: PlacementSearchCache
) {
  const freePolygons = freeRegionPolygonsFromPlacements(placements, material, config, cache);
  if (!freePolygons.length) {
    return 0;
  }

  const candidateSolidContours = solidClosedContours(candidateContours);
  if (!candidateSolidContours.length) {
    return 0;
  }

  const candidateBounds = combinedPlacementBounds(candidateContours, []);
  const candidateWidth = candidateBounds.maxX - candidateBounds.minX;
  const candidateHeight = candidateBounds.maxY - candidateBounds.minY;
  const candidateArea = contoursArea(candidateSolidContours);

  let bestSlack: number | null = null;
  for (const polygon of freePolygons) {
    const bounds = pathBounds(polygon);
    if (!polygonContainsCandidateContours(polygon, candidateSolidContours, candidateBounds, candidateArea)) {
      continue;
    }

    const areaSlack = Math.max(0, clipperPolygonArea(polygon) - candidateArea);
    const widthSlack = Math.max(0, bounds.maxX - bounds.minX - candidateWidth);
    const heightSlack = Math.max(0, bounds.maxY - bounds.minY - candidateHeight);
    const slack = Math.sqrt(areaSlack) + widthSlack + heightSlack;
    if (bestSlack === null || slack < bestSlack) {
      bestSlack = slack;
    }
  }

  return bestSlack ?? 0;
}

function contactScore(
  candidateContours: SampledContour[],
  placements: PreparedPlacement[],
  material: { width: number; height: number },
  config: NestingConfig
) {
  const candidateSolidContours = solidClosedContours(candidateContours);
  if (!candidateSolidContours.length) {
    return 0;
  }

  const samplePoints = dedupeAnchorPoints(
    candidateSolidContours.flatMap((contour) => polygonEdgeSamplePoints(contour.points, 16))
  );
  if (!samplePoints.length) {
    return 0;
  }

  const tolerance = Math.max(0.75, config.pieceGap + config.kerf + 0.5);
  const placedSolidContours = placements.flatMap((placement) => solidClosedContours(placement.contours));
  let totalContact = 0;

  for (const point of samplePoints) {
    const nearestBoundaryDistance = Math.min(
      Math.abs(point.x - config.edgeGap),
      Math.abs(point.y - config.edgeGap),
      Math.abs(material.width - config.edgeGap - point.x),
      Math.abs(material.height - config.edgeGap - point.y)
    );
    let nearestPlacedDistance = Number.POSITIVE_INFINITY;

    for (const contour of placedSolidContours) {
      const bounds = contourBounds(contour);
      if (
        point.x < bounds.minX - tolerance ||
        point.x > bounds.maxX + tolerance ||
        point.y < bounds.minY - tolerance ||
        point.y > bounds.maxY + tolerance
      ) {
        continue;
      }

      for (let index = 0; index < contour.points.length; index += 1) {
        const start = contour.points[index];
        const end = contour.points[(index + 1) % contour.points.length];
        const distance = pointToSegmentDistance(point, start, end);
        if (distance < nearestPlacedDistance) {
          nearestPlacedDistance = distance;
        }
        if (nearestPlacedDistance <= 0.0001) {
          break;
        }
      }
    }

    const placedContact =
      nearestPlacedDistance <= tolerance ? 1 - nearestPlacedDistance / tolerance : 0;
    const boundaryContact =
      nearestBoundaryDistance <= tolerance ? 1 - nearestBoundaryDistance / tolerance : 0;

    if (placedSolidContours.length > 0) {
      totalContact += placedContact * 1.2 + boundaryContact * 0.2;
    } else {
      totalContact += boundaryContact;
    }
  }

  return totalContact / samplePoints.length;
}

function scorePlacement(
  x: number,
  y: number,
  variant: PieceVariant,
  placements: PreparedPlacement[],
  material: { width: number; height: number },
  config: NestingConfig,
  cache?: PlacementSearchCache
) {
  const cacheKey = scoreSignature(x, y, variant, placements, material, cache);
  const cached = cache?.scoreChecks.get(cacheKey);
  if (typeof cached === "number") {
    return cached;
  }

  const candidateContours = getTranslatedContours(variant, x, y, cache);
  const bounds = combinedPlacementBounds(candidateContours, placements);
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  const rightSlack = material.width - bounds.maxX;
  const bottomSlack = material.height - bounds.maxY;
  const occupiesHoleSpace = candidateUsesHoleSpace(candidateContours, placements);
  const feasibleSlack = feasibleRegionSlackScore(candidateContours, placements, material, config, cache);
  const boundaryContact = contactScore(candidateContours, placements, material, config);

  const score =
    width * 2 +
    height +
    (occupiesHoleSpace ? -14 : 0) +
    boundaryContact * -8 +
    feasibleSlack * 0.015 +
    Math.max(0, rightSlack) * 0.005 +
    Math.max(0, bottomSlack) * 0.002 +
    y * 0.01 +
    x * 0.001;

  cache?.scoreChecks.set(cacheKey, score);
  return score;
}

function settleSignature(
  x: number,
  y: number,
  variant: PieceVariant,
  placements: PreparedPlacement[],
  material: { width: number; height: number },
  config: NestingConfig,
  cache?: PlacementSearchCache
) {
  return [
    round(x),
    round(y),
    variant.signature,
    material.width,
    material.height,
    round(config.edgeGap),
    round(config.pieceGap),
    round(config.kerf),
    getPlacementsSignature(placements, cache)
  ].join("|");
}

function settlePlacement(
  x: number,
  y: number,
  variant: PieceVariant,
  placements: PreparedPlacement[],
  material: { width: number; height: number },
  config: NestingConfig,
  cache?: PlacementSearchCache
) {
  const cacheKey = settleSignature(x, y, variant, placements, material, config, cache);
  const cached = cache?.settledPlacements.get(cacheKey);
  if (cached) {
    return cached;
  }

  let settledX = x;
  let settledY = y;
  const variantSnapPoints = dedupeAnchorPoints([
    ...(variant.anchors.length ? variant.anchors : extractContourAnchors(variant.contours)),
    ...variant.contours
      .filter((contour) => contour.points.length >= 2)
      .flatMap((contour) => polygonEdgeSamplePoints(contour.points, contour.closed ? 16 : 8))
  ]);
  const materialBoundaryPoints = polygonEdgeSamplePoints(
    rectanglePath(
      config.edgeGap,
      config.edgeGap,
      material.width - config.edgeGap,
      material.height - config.edgeGap
    ),
    16
  );

  for (let iteration = 0; iteration < 4; iteration += 1) {
    let moved = false;
    const xTargets = new Set<number>([config.edgeGap, settledX]);
    const yTargets = new Set<number>([config.edgeGap, settledY]);

    materialBoundaryPoints.forEach((boundaryPoint) => {
      variantSnapPoints.forEach((variantPoint) => {
        xTargets.add(round(boundaryPoint.x - variantPoint.x));
        yTargets.add(round(boundaryPoint.y - variantPoint.y));
      });
    });

    placements.forEach((placement) => {
      xTargets.add(round(placement.x));
      xTargets.add(round(placement.x + placement.width + config.pieceGap));
      yTargets.add(round(placement.y));
      yTargets.add(round(placement.y + placement.height + config.pieceGap));

      const placementSnapPoints = dedupeAnchorPoints([
        ...(placement.anchors.length ? placement.anchors : extractContourAnchors(placement.contours)),
        ...placement.contours
          .filter((contour) => contour.points.length >= 2)
          .flatMap((contour) => polygonEdgeSamplePoints(contour.points, contour.closed ? 16 : 8))
      ]);

      placementSnapPoints.forEach((placedPoint) => {
        variantSnapPoints.forEach((variantPoint) => {
          xTargets.add(round(placedPoint.x - variantPoint.x));
          yTargets.add(round(placedPoint.y - variantPoint.y));
        });
      });

      placement.contours
        .filter((contour) => contour.closed && contour.isHole && contour.points.length >= 3)
        .forEach((holeContour) => {
          const holeBounds = contourBounds(holeContour);
          xTargets.add(round(holeBounds.minX + config.pieceGap + config.kerf));
          xTargets.add(round(holeBounds.maxX - variant.width - config.pieceGap - config.kerf));
          yTargets.add(round(holeBounds.minY + config.pieceGap + config.kerf));
          yTargets.add(round(holeBounds.maxY - variant.height - config.pieceGap - config.kerf));
        });
    });

    const leftmostX = [...xTargets]
      .filter((candidateX) => candidateX <= settledX + 0.0001)
      .sort((left, right) => left - right)
      .find((candidateX) => {
        if (!fitsMaterial(candidateX, settledY, variant, material, config)) {
          return false;
        }

        return !placementCollides(candidateX, settledY, variant, placements, config, cache);
      });

    if (typeof leftmostX === "number" && leftmostX < settledX - 0.0001) {
      settledX = leftmostX;
      moved = true;
    }

    const topmostY = [...yTargets]
      .filter((candidateY) => candidateY <= settledY + 0.0001)
      .sort((left, right) => left - right)
      .find((candidateY) => {
        if (!fitsMaterial(settledX, candidateY, variant, material, config)) {
          return false;
        }

        return !placementCollides(settledX, candidateY, variant, placements, config, cache);
      });

    if (typeof topmostY === "number" && topmostY < settledY - 0.0001) {
      settledY = topmostY;
      moved = true;
    }

    if (!moved) {
      break;
    }
  }

  const settled = {
    x: settledX,
    y: settledY
  };

  cache?.settledPlacements.set(cacheKey, settled);
  return settled;
}

function placementToVariant(placement: PreparedPlacement): PieceVariant {
  const variant: PieceVariant = {
    rotation: placement.rotation,
    width: placement.width,
    height: placement.height,
    contours: translateContours(placement.contours, -placement.x, -placement.y),
    anchors: placement.anchors.map((point) => ({
      x: round(point.x - placement.x),
      y: round(point.y - placement.y)
    })),
    signature: ""
  };
  variant.signature = variantSignature(variant);
  return variant;
}

function buildPreparedPlacement(prepared: PreparedPiece, option: PlacementOption): PreparedPlacement {
  return {
    pieceId: prepared.pieceId,
    sheetIndex: option.sheetIndex,
    x: option.x,
    y: option.y,
    width: option.variant.width,
    height: option.variant.height,
    rotation: option.variant.rotation,
    contours: translateContours(option.variant.contours, option.x, option.y),
    anchors: option.variant.anchors.map((point) => ({
      x: round(point.x + option.x),
      y: round(point.y + option.y)
    })),
    area: prepared.area
  };
}

function cloneSheetPlacements(sheetPlacements: PreparedPlacement[][]) {
  return sheetPlacements.map((sheet) =>
    sheet.map((placement) => ({
      ...placement,
      contours: placement.contours.map((contour) => ({
        ...contour,
        points: contour.points.map((point) => ({ ...point }))
      })),
      anchors: placement.anchors.map((point) => ({ ...point }))
    }))
  );
}

function scorePartialSheetPlacements(sheetPlacements: PreparedPlacement[][]): PartialStateScore {
  const nonEmptySheets = sheetPlacements.filter((sheet) => sheet.length > 0);
  const footprintBySheet = nonEmptySheets.map((sheet) => ({
    minX: Math.min(...sheet.map((placement) => placement.x)),
    minY: Math.min(...sheet.map((placement) => placement.y)),
    maxX: Math.max(...sheet.map((placement) => placement.x + placement.width)),
    maxY: Math.max(...sheet.map((placement) => placement.y + placement.height))
  }));

  return {
    usedSheets: nonEmptySheets.length,
    totalWidth: footprintBySheet.reduce((sum, footprint) => sum + (footprint.maxX - footprint.minX), 0),
    totalHeight: footprintBySheet.reduce((sum, footprint) => sum + (footprint.maxY - footprint.minY), 0),
    totalFootprintArea: footprintBySheet.reduce(
      (sum, footprint) => sum + (footprint.maxX - footprint.minX) * (footprint.maxY - footprint.minY),
      0
    ),
    placements: nonEmptySheets.reduce((sum, sheet) => sum + sheet.length, 0)
  };
}

function comparePartialStateScore(left: PartialStateScore, right: PartialStateScore) {
  if (left.usedSheets !== right.usedSheets) {
    return left.usedSheets - right.usedSheets;
  }
  if (Math.abs(left.totalWidth - right.totalWidth) > 0.0001) {
    return left.totalWidth - right.totalWidth;
  }
  if (Math.abs(left.totalHeight - right.totalHeight) > 0.0001) {
    return left.totalHeight - right.totalHeight;
  }
  if (Math.abs(left.totalFootprintArea - right.totalFootprintArea) > 0.0001) {
    return left.totalFootprintArea - right.totalFootprintArea;
  }
  return right.placements - left.placements;
}

function compactSheetPlacements(
  placements: PreparedPlacement[],
  material: { width: number; height: number },
  config: NestingConfig,
  cache?: PlacementSearchCache
) {
  if (placements.length < 2) {
    return;
  }

  let changed = false;

  for (let iteration = 0; iteration < 3; iteration += 1) {
    let iterationChanged = false;

    for (let index = 0; index < placements.length; index += 1) {
      const placement = placements[index];
      const variant = placementToVariant(placement);
      const others = placements.filter((_, placementIndex) => placementIndex !== index);
      const currentScore = scorePlacement(placement.x, placement.y, variant, others, material, config, cache);
      let best:
        | {
            x: number;
            y: number;
            score: number;
          }
        | undefined;

      const candidates = candidateCoordinates(variant, others, material, config, cache);
      for (const candidate of candidates.direct) {
        const x = candidate.x;
        const y = candidate.y;
        if (!fitsMaterial(x, y, variant, material, config)) {
          continue;
        }

        if (placementCollides(x, y, variant, others, config, cache)) {
          continue;
        }

        const settled = settlePlacement(x, y, variant, others, material, config, cache);
        const score = scorePlacement(settled.x, settled.y, variant, others, material, config, cache);
        if (
          !best ||
          score < best.score - 0.0001 ||
          (Math.abs(score - best.score) <= 0.0001 &&
            (settled.y < best.y || (settled.y === best.y && settled.x < best.x)))
        ) {
          best = { x: settled.x, y: settled.y, score };
        }
      }

      for (const y of candidates.y) {
        for (const x of candidates.x) {
          if (!fitsMaterial(x, y, variant, material, config)) {
            continue;
          }

          if (placementCollides(x, y, variant, others, config, cache)) {
            continue;
          }

          const settled = settlePlacement(x, y, variant, others, material, config, cache);
          const score = scorePlacement(settled.x, settled.y, variant, others, material, config, cache);
          if (
            !best ||
            score < best.score - 0.0001 ||
            (Math.abs(score - best.score) <= 0.0001 &&
              (settled.y < best.y || (settled.y === best.y && settled.x < best.x)))
          ) {
            best = { x: settled.x, y: settled.y, score };
          }
        }
      }

      if (
        best &&
        (best.score < currentScore - 0.0001 ||
          (Math.abs(best.score - currentScore) <= 0.0001 && (best.y < placement.y || (best.y === placement.y && best.x < placement.x))))
      ) {
        placement.x = best.x;
        placement.y = best.y;
        placement.contours = translateContours(variant.contours, best.x, best.y);
        placement.anchors = variant.anchors.map((point) => ({
          x: round(point.x + best.x),
          y: round(point.y + best.y)
        }));
        iterationChanged = true;
        changed = true;
      }
    }

    if (!iterationChanged) {
      break;
    }
  }

  if (changed) {
    placements.sort((left, right) => {
      if (left.sheetIndex !== right.sheetIndex) {
        return left.sheetIndex - right.sheetIndex;
      }
      if (left.y !== right.y) {
        return left.y - right.y;
      }
      return left.x - right.x;
    });
  }
}

function findPlacementCandidates(
  prepared: PreparedPiece,
  sheetPlacements: PreparedPlacement[],
  material: { width: number; height: number },
  config: NestingConfig,
  sheetIndex: number,
  limit: number,
  cache?: PlacementSearchCache
) {
  const best: PlacementOption[] = [];

  const viableVariants = prepared.variants.filter((variant) => variantCanPossiblyFit(variant, material, config));
  const variants = viableVariants.length ? viableVariants : prepared.variants;

  for (const variant of variants) {
    const candidates = candidateCoordinates(variant, sheetPlacements, material, config, cache);
    for (const directCandidate of candidates.direct) {
      const x = directCandidate.x;
      const y = directCandidate.y;
      if (!fitsMaterial(x, y, variant, material, config)) {
        continue;
      }

      if (placementCollides(x, y, variant, sheetPlacements, config, cache)) {
        continue;
      }

      const settled = settlePlacement(x, y, variant, sheetPlacements, material, config, cache);
      const score = scorePlacement(settled.x, settled.y, variant, sheetPlacements, material, config, cache);
      const candidate: PlacementOption = {
        x: settled.x,
        y: settled.y,
        variant,
        score,
        sheetIndex
      };

      const duplicateIndex = best.findIndex(
        (entry) =>
          entry.sheetIndex === candidate.sheetIndex &&
          entry.variant.signature === candidate.variant.signature &&
          Math.abs(entry.x - candidate.x) <= 0.0001 &&
          Math.abs(entry.y - candidate.y) <= 0.0001
      );
      if (duplicateIndex >= 0) {
        continue;
      }

      best.push(candidate);
      best.sort((left, right) => {
        if (Math.abs(left.score - right.score) > 0.0001) {
          return left.score - right.score;
        }
        if (left.y !== right.y) {
          return left.y - right.y;
        }
        return left.x - right.x;
      });
      if (best.length > limit) {
        best.length = limit;
      }
    }

    for (const y of candidates.y) {
      for (const x of candidates.x) {
        if (!fitsMaterial(x, y, variant, material, config)) {
          continue;
        }

        if (placementCollides(x, y, variant, sheetPlacements, config, cache)) {
          continue;
        }

        const settled = settlePlacement(x, y, variant, sheetPlacements, material, config, cache);
        const score = scorePlacement(settled.x, settled.y, variant, sheetPlacements, material, config, cache);
        const candidate: PlacementOption = {
          x: settled.x,
          y: settled.y,
          variant,
          score,
          sheetIndex
        };

        const duplicateIndex = best.findIndex(
          (entry) =>
            entry.sheetIndex === candidate.sheetIndex &&
            entry.variant.signature === candidate.variant.signature &&
            Math.abs(entry.x - candidate.x) <= 0.0001 &&
            Math.abs(entry.y - candidate.y) <= 0.0001
        );
        if (duplicateIndex >= 0) {
          continue;
        }

        best.push(candidate);
        best.sort((left, right) => {
          if (Math.abs(left.score - right.score) > 0.0001) {
            return left.score - right.score;
          }
          if (left.y !== right.y) {
            return left.y - right.y;
          }
          return left.x - right.x;
        });
        if (best.length > limit) {
          best.length = limit;
        }
      }
    }
  }

  return best;
}

function findBestPlacement(
  prepared: PreparedPiece,
  sheetPlacements: PreparedPlacement[],
  material: { width: number; height: number },
  config: NestingConfig,
  sheetIndex: number,
  cache?: PlacementSearchCache
) {
  return findPlacementCandidates(prepared, sheetPlacements, material, config, sheetIndex, 1, cache)[0];
}

function findGlobalPlacementCandidates(
  prepared: PreparedPiece,
  sheetPlacements: PreparedPlacement[][],
  material: { width: number; height: number; sheetCount: number },
  config: NestingConfig,
  limit: number,
  cache: PlacementSearchCache
) {
  const candidates: PlacementOption[] = [];

  for (let sheetIndex = 0; sheetIndex < material.sheetCount; sheetIndex += 1) {
    candidates.push(
      ...findPlacementCandidates(prepared, sheetPlacements[sheetIndex], material, config, sheetIndex, limit, cache)
    );
  }

  candidates.sort((left, right) => {
    if (Math.abs(left.score - right.score) > 0.0001) {
      return left.score - right.score;
    }
    if (left.sheetIndex !== right.sheetIndex) {
      return left.sheetIndex - right.sheetIndex;
    }
    if (left.y !== right.y) {
      return left.y - right.y;
    }
    return left.x - right.x;
  });

  return candidates.slice(0, limit);
}

function chooseMostConstrainedPrepared(
  remainingPrepared: PreparedPiece[],
  sheetPlacements: PreparedPlacement[][],
  material: { width: number; height: number; sheetCount: number },
  config: NestingConfig,
  branchLimit: number,
  cache: PlacementSearchCache
) {
  if (!remainingPrepared.length) {
    return null;
  }

  const ranked = remainingPrepared.map((prepared, index) => {
    const candidates = findGlobalPlacementCandidates(prepared, sheetPlacements, material, config, branchLimit + 1, cache);
    const candidateCount = candidates.length;
    const primary = prepared.variants[0];
    const maxSpan = Math.max(primary?.width ?? 0, primary?.height ?? 0);
    const viableCount = Math.max(prepared.viableVariantCount ?? prepared.variants.length, 0);

    return {
      prepared,
      index,
      candidateCount,
      viableCount,
      maxSpan,
      area: prepared.area
    };
  });

  ranked.sort((left, right) => {
    if (left.candidateCount !== right.candidateCount) {
      return left.candidateCount - right.candidateCount;
    }
    if (left.viableCount !== right.viableCount) {
      return left.viableCount - right.viableCount;
    }
    if (Math.abs(left.maxSpan - right.maxSpan) > 0.0001) {
      return right.maxSpan - left.maxSpan;
    }
    if (Math.abs(left.area - right.area) > 0.0001) {
      return right.area - left.area;
    }
    return left.index - right.index;
  });

  const selected = ranked[0];
  if (!selected) {
    return null;
  }

  return {
    prepared: selected.prepared,
    remaining: remainingPrepared.filter((_, index) => index !== selected.index)
  };
}

function applyPlacementOption(
  prepared: PreparedPiece,
  option: PlacementOption,
  sheetPlacements: PreparedPlacement[][],
  material: { width: number; height: number; sheetCount: number },
  config: NestingConfig,
  cache: PlacementSearchCache
) {
  const candidateSheets = cloneSheetPlacements(sheetPlacements);
  candidateSheets[option.sheetIndex].push(buildPreparedPlacement(prepared, option));
  compactSheetPlacements(candidateSheets[option.sheetIndex], material, config, cache);
  return candidateSheets;
}

function compareBranchEvaluation(left: BranchEvaluation, right: BranchEvaluation) {
  if (left.placeableCount !== right.placeableCount) {
    return right.placeableCount - left.placeableCount;
  }

  const finalComparison = comparePartialStateScore(left.finalState, right.finalState);
  if (finalComparison !== 0) {
    return finalComparison;
  }

  const currentComparison = comparePartialStateScore(left.currentState, right.currentState);
  if (currentComparison !== 0) {
    return currentComparison;
  }

  if (Math.abs(left.option.score - right.option.score) > 0.0001) {
    return left.option.score - right.option.score;
  }

  if (left.option.sheetIndex !== right.option.sheetIndex) {
    return left.option.sheetIndex - right.option.sheetIndex;
  }

  if (left.option.y !== right.option.y) {
    return left.option.y - right.option.y;
  }

  return left.option.x - right.option.x;
}

function evaluatePlacementBranch(
  prepared: PreparedPiece,
  option: PlacementOption,
  sheetPlacements: PreparedPlacement[][],
  material: { width: number; height: number; sheetCount: number },
  config: NestingConfig,
  cache: PlacementSearchCache,
  remainingPrepared: PreparedPiece[],
  branchLimit: number
): BranchEvaluation {
  const candidateSheets = applyPlacementOption(prepared, option, sheetPlacements, material, config, cache);
  const currentState = scorePartialSheetPlacements(candidateSheets);

  if (!remainingPrepared.length) {
    return {
      option,
      currentState,
      finalState: currentState,
      placeableCount: 1
    };
  }

  const chosenNext = chooseMostConstrainedPrepared(remainingPrepared, candidateSheets, material, config, branchLimit, cache);
  if (!chosenNext) {
    return {
      option,
      currentState,
      finalState: currentState,
      placeableCount: 1
    };
  }

  const nextPrepared = chosenNext.prepared;
  const nextCandidates = findGlobalPlacementCandidates(nextPrepared, candidateSheets, material, config, branchLimit, cache);
  if (!nextCandidates.length) {
    return {
      option,
      currentState,
      finalState: currentState,
      placeableCount: 1
    };
  }

  let bestContinuation: BranchEvaluation | null = null;
  for (const nextOption of nextCandidates) {
    const evaluated = evaluatePlacementBranch(
      nextPrepared,
      nextOption,
      candidateSheets,
      material,
      config,
      cache,
      chosenNext.remaining,
      branchLimit
    );

    if (!bestContinuation || compareBranchEvaluation(evaluated, bestContinuation) < 0) {
      bestContinuation = evaluated;
    }
  }

  return {
    option,
    currentState,
    finalState: bestContinuation?.finalState ?? currentState,
    placeableCount: 1 + (bestContinuation?.placeableCount ?? 0)
  };
}

function scoreResult(result: NestingResult) {
  const footprintBySheet = new Map<number, { minX: number; minY: number; maxX: number; maxY: number }>();

  result.placements.forEach((placement) => {
    const current = footprintBySheet.get(placement.sheetIndex);
    const next = {
      minX: placement.x,
      minY: placement.y,
      maxX: placement.x + placement.width,
      maxY: placement.y + placement.height
    };

    if (!current) {
      footprintBySheet.set(placement.sheetIndex, next);
      return;
    }

    footprintBySheet.set(placement.sheetIndex, {
      minX: Math.min(current.minX, next.minX),
      minY: Math.min(current.minY, next.minY),
      maxX: Math.max(current.maxX, next.maxX),
      maxY: Math.max(current.maxY, next.maxY)
    });
  });

  const totalWidth = [...footprintBySheet.values()].reduce((sum, footprint) => sum + (footprint.maxX - footprint.minX), 0);
  const totalHeight = [...footprintBySheet.values()].reduce((sum, footprint) => sum + (footprint.maxY - footprint.minY), 0);
  const totalFootprintArea = [...footprintBySheet.values()].reduce(
    (sum, footprint) => sum + (footprint.maxX - footprint.minX) * (footprint.maxY - footprint.minY),
    0
  );

  return {
    sheets: result.usedSheets || Number.MAX_SAFE_INTEGER,
    unplaced: result.unplaced.length,
    totalWidth,
    totalHeight,
    totalFootprintArea,
    utilization: result.utilization,
    wasteArea: result.wasteArea,
    placements: result.placements.length
  };
}

function isBetterResult(candidate: NestingResult, best: NestingResult | null) {
  if (!best) {
    return true;
  }

  const candidateScore = scoreResult(candidate);
  const bestScore = scoreResult(best);

  if (candidateScore.unplaced !== bestScore.unplaced) {
    return candidateScore.unplaced < bestScore.unplaced;
  }

  if (candidateScore.sheets !== bestScore.sheets) {
    return candidateScore.sheets < bestScore.sheets;
  }

  if (Math.abs(candidateScore.totalWidth - bestScore.totalWidth) > 0.0001) {
    return candidateScore.totalWidth < bestScore.totalWidth;
  }

  if (Math.abs(candidateScore.totalHeight - bestScore.totalHeight) > 0.0001) {
    return candidateScore.totalHeight < bestScore.totalHeight;
  }

  if (Math.abs(candidateScore.totalFootprintArea - bestScore.totalFootprintArea) > 0.0001) {
    return candidateScore.totalFootprintArea < bestScore.totalFootprintArea;
  }

  if (Math.abs(candidateScore.utilization - bestScore.utilization) > 0.0001) {
    return candidateScore.utilization > bestScore.utilization;
  }

  if (Math.abs(candidateScore.wasteArea - bestScore.wasteArea) > 0.0001) {
    return candidateScore.wasteArea < bestScore.wasteArea;
  }

  return candidateScore.placements > bestScore.placements;
}

function runSingleAttempt(
  expanded: PreparedPiece[],
  material: { width: number; height: number; sheetCount: number },
  config: NestingConfig
) {
  const searchCache: PlacementSearchCache = {
    candidateCoordinates: new Map(),
    collisionChecks: new Map(),
    freeRegionPolygons: new Map(),
    scoreChecks: new Map(),
    settledPlacements: new Map(),
    translatedContours: new Map()
  };
  const sheetPlacements = Array.from({ length: material.sheetCount }).map(() => [] as PreparedPlacement[]);
  const unplaced: string[] = [];
  const optionLimit = qualityPlacementOptionLimit(config);
  const lookaheadDepth = qualityLookaheadDepth(config);

  for (let index = 0; index < expanded.length; index += 1) {
    const prepared = expanded[index];
    const remainingPrepared = lookaheadDepth > 0 ? expanded.slice(index + 1, index + 1 + lookaheadDepth) : [];
    let bestOption: BranchEvaluation | null = null;

    const foundOptions = findGlobalPlacementCandidates(prepared, sheetPlacements, material, config, optionLimit, searchCache);
    for (const option of foundOptions) {
      const evaluated = evaluatePlacementBranch(
        prepared,
        option,
        sheetPlacements,
        material,
        config,
        searchCache,
        remainingPrepared,
        optionLimit
      );
      if (!bestOption || compareBranchEvaluation(evaluated, bestOption) < 0) {
        bestOption = evaluated;
      }
    }

    if (!bestOption) {
      unplaced.push(prepared.pieceId);
      continue;
    }

    sheetPlacements[bestOption.option.sheetIndex].push(buildPreparedPlacement(prepared, bestOption.option));
    compactSheetPlacements(sheetPlacements[bestOption.option.sheetIndex], material, config, searchCache);
  }

  const placements: Placement[] = sheetPlacements
    .flatMap((sheet) => sheet)
    .sort((left, right) => {
      if (left.sheetIndex !== right.sheetIndex) {
        return left.sheetIndex - right.sheetIndex;
      }
      if (left.y !== right.y) {
        return left.y - right.y;
      }
      return left.x - right.x;
    })
    .map((placement) => ({
      pieceId: placement.pieceId,
      sheetIndex: placement.sheetIndex,
      x: placement.x,
      y: placement.y,
      width: placement.width,
      height: placement.height,
      rotation: placement.rotation
    }));

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
    elapsedMs: 0
  };

  return result;
}

function cloneNestingResult(result: NestingResult): NestingResult {
  return {
    placements: result.placements.map((placement) => ({ ...placement })),
    unplaced: result.unplaced.slice(),
    usedSheets: result.usedSheets,
    usedArea: result.usedArea,
    wasteArea: result.wasteArea,
    utilization: result.utilization,
    elapsedMs: result.elapsedMs
  };
}

async function computeNesting(
  expanded: PreparedPiece[],
  material: { width: number; height: number; sheetCount: number },
  config: NestingConfig,
  onProgress?: (message: string, value: number) => void
) {
  const materialAwareExpanded = sortPiecesForMaterial(prioritizeVariantsForMaterial(expanded, material, config), material, config);
  const startedAt = performance.now();
  const deadline = startedAt + Math.max(config.maxTimeMs || 1000, 1000);
  const progressValue = () =>
    Math.min(0.22 + (1 - Math.max((deadline - performance.now()) / Math.max(config.maxTimeMs, 1), 0)) * 0.7, 0.96);
  let bestResult: NestingResult | null = null;
  let attemptIndex = 0;
  let generationIndex = 0;
  let lastYieldAt = startedAt;
  let lastHeartbeatAt = startedAt;
  let population = createInitialPopulation(materialAwareExpanded, config);
  let stagnantGenerations = 0;
  const geneResultCache = new Map<string, NestingResult>();

  onProgress?.("Analizando contornos.", 0.08);
  await wait(config.quality === "quality" ? 140 : 70);
  onProgress?.("Preparando rotaciones reales.", 0.16);
  await wait(config.quality === "quality" ? 140 : 70);

  do {
    const evaluatedPopulation: EvaluatedGene[] = [];
    let generationImproved = false;

    for (const gene of population) {
      const geneStartedAt = performance.now();
      const signature = geneSignature(gene);
      const cachedResult = geneResultCache.get(signature);
      if (!cachedResult && geneStartedAt - lastHeartbeatAt > 250) {
        onProgress?.(
          `Evaluando acomodo, generacion ${generationIndex + 1}, intento ${attemptIndex + 1}.`,
          progressValue()
        );
        lastHeartbeatAt = geneStartedAt;
        await wait(0);
      }
      const attemptResult = cachedResult
        ? cloneNestingResult(cachedResult)
        : (() => {
            const attemptPieces = buildAttemptPiecesFromGene(materialAwareExpanded, gene);
            const freshResult = runSingleAttempt(attemptPieces, material, config);
            geneResultCache.set(signature, cloneNestingResult(freshResult));
            return freshResult;
          })();

      attemptResult.elapsedMs = performance.now() - startedAt;
      evaluatedPopulation.push({ gene, result: attemptResult });

      if (isBetterResult(attemptResult, bestResult)) {
        bestResult = attemptResult;
        generationImproved = true;
        onProgress?.(`Mejorando acomodo, generacion ${generationIndex + 1}, intento ${attemptIndex + 1}.`, progressValue());
        lastHeartbeatAt = performance.now();
      }

      attemptIndex += 1;

      const now = performance.now();
      if (now - lastHeartbeatAt > 400) {
        onProgress?.(
          `Probando acomodos, generacion ${generationIndex + 1}, intento ${attemptIndex}.`,
          progressValue()
        );
        lastHeartbeatAt = now;
      }
      if (now - lastYieldAt > 30) {
        lastYieldAt = now;
        await wait(0);
      }

      if (performance.now() >= deadline || attemptIndex >= 240) {
        break;
      }
    }

    if (performance.now() >= deadline || attemptIndex >= 240) {
      break;
    }

    if (!bestResult && evaluatedPopulation.length) {
      bestResult = evaluatedPopulation[0].result;
    }

    stagnantGenerations = generationImproved ? 0 : stagnantGenerations + 1;
    if (
      bestResult &&
      bestResult.unplaced.length === 0 &&
      stagnantGenerations >= (config.quality === "quality" ? 2 : 1)
    ) {
      break;
    }

    onProgress?.(`Explorando variantes, generacion ${generationIndex + 1}.`, progressValue());
    lastHeartbeatAt = performance.now();

    population = nextGeneration(materialAwareExpanded, evaluatedPopulation, config, generationIndex);
    generationIndex += 1;
  } while (performance.now() < deadline && attemptIndex < 240);

  const finalResult = bestResult ?? runSingleAttempt(materialAwareExpanded, material, config);
  finalResult.elapsedMs = performance.now() - startedAt;
  onProgress?.("Resultado listo.", 1);
  return finalResult;
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
