import type { GeometryEntity, GeometryPoint, PieceGeometry } from "../types";
import { normalizePolylineEntity, simplifyPolyline } from "./contours";
import {
  normalizeArcSweep,
  sampleArcPoints,
  sampleEllipseArcPoints,
  sampleEllipsePoints,
  samplePathPoints
} from "./sampling";

function round(n: number) {
  return Math.round(n * 1000) / 1000;
}

function shiftPoint(point: GeometryPoint, offsetX: number, offsetY: number): GeometryPoint {
  return {
    x: round(point.x - offsetX),
    y: round(point.y - offsetY)
  };
}

export function getElementBounds(element: SVGGraphicsElement) {
  const box = element.getBBox();
  return {
    minX: round(box.x),
    minY: round(box.y),
    maxX: round(box.x + box.width),
    maxY: round(box.y + box.height),
    width: round(box.width),
    height: round(box.height)
  };
}

function boundsFromPoints(points: GeometryPoint[]) {
  return {
    minX: round(Math.min(...points.map((point) => point.x))),
    minY: round(Math.min(...points.map((point) => point.y))),
    maxX: round(Math.max(...points.map((point) => point.x))),
    maxY: round(Math.max(...points.map((point) => point.y)))
  };
}

function getEntityBounds(entity: GeometryEntity) {
  switch (entity.kind) {
    case "polyline":
      return boundsFromPoints(entity.points);
    case "circle":
      return {
        minX: round(entity.cx - entity.r),
        minY: round(entity.cy - entity.r),
        maxX: round(entity.cx + entity.r),
        maxY: round(entity.cy + entity.r)
      };
    case "ellipse":
      return boundsFromPoints(sampleEllipsePoints(entity.cx, entity.cy, entity.rx, entity.ry, entity.rotation, 48));
    case "ellipseArc":
      return boundsFromPoints(sampleEllipseArcPoints(entity, 48));
    case "arc":
      return boundsFromPoints(sampleArcPoints(entity, 48));
    case "path":
      return boundsFromPoints(
        samplePathPoints(entity.d, {
          offsetX: 0,
          offsetY: 0,
          closed: entity.closed,
          minSegments: entity.closed ? 48 : 24,
          maxSegments: 720,
          segmentLength: 2.5
        })
      );
    default:
      return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
}

function getBoundsFromEntities(entities: GeometryEntity[]) {
  const entityBounds = entities.map(getEntityBounds);
  return {
    minX: round(Math.min(...entityBounds.map((bounds) => bounds.minX))),
    minY: round(Math.min(...entityBounds.map((bounds) => bounds.minY))),
    maxX: round(Math.max(...entityBounds.map((bounds) => bounds.maxX))),
    maxY: round(Math.max(...entityBounds.map((bounds) => bounds.maxY)))
  };
}

export function isClosedShape(element: Element) {
  const tag = element.tagName.toLowerCase();
  if (["rect", "circle", "ellipse", "polygon"].includes(tag)) {
    return true;
  }

  if (tag === "path") {
    const d = element.getAttribute("d") ?? "";
    return /z\s*$/i.test(d.trim());
  }

  return false;
}

function parsePointsAttribute(pointsText: string) {
  return pointsText
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(",").map(Number))
    .filter((pair) => pair.length === 2 && pair.every((value) => Number.isFinite(value)))
    .map(([x, y]) => ({ x, y }));
}

function pointToken(point: GeometryPoint) {
  return `${round(point.x).toFixed(3)},${round(point.y).toFixed(3)}`;
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
    if (isPointOnSegment(polygon[j], polygon[i])) {
      return true;
    }

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

function sampleEntitySignaturePoints(entity: GeometryEntity, bounds: PieceGeometry["sourceBounds"]) {
  switch (entity.kind) {
    case "polyline":
      return simplifyPolyline(entity.points, 0.2, entity.closed);
    case "circle":
      return sampleEllipsePoints(entity.cx, entity.cy, entity.r, entity.r, 0, 24);
    case "ellipse":
      return sampleEllipsePoints(entity.cx, entity.cy, entity.rx, entity.ry, entity.rotation, 24);
    case "ellipseArc":
      return sampleEllipseArcPoints(entity, 24);
    case "arc":
      return sampleArcPoints(entity, 24);
    case "path":
      return samplePathPoints(entity.d, { offsetX: bounds.minX, offsetY: bounds.minY, closed: entity.closed, minSegments: 36, maxSegments: 900, segmentLength: 2.5 });
    default:
      return [];
  }
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

type SampledClosedLoop = {
  points: GeometryPoint[];
  area: number;
  isHole: boolean;
};

function contourRepresentativePoint(points: GeometryPoint[]) {
  const sum = points.reduce(
    (acc, point) => ({
      x: acc.x + point.x,
      y: acc.y + point.y
    }),
    { x: 0, y: 0 }
  );

  return {
    x: sum.x / Math.max(points.length, 1),
    y: sum.y / Math.max(points.length, 1)
  };
}

function sampleClosedLoopsFromEntity(entity: GeometryEntity, bounds: PieceGeometry["sourceBounds"]) {
  if (entity.kind === "polyline" && entity.closed && entity.points.length >= 3) {
    return [entity.points];
  }

  if (entity.kind === "circle") {
    return [sampleEllipsePoints(entity.cx, entity.cy, entity.r, entity.r, 0, 48)];
  }

  if (entity.kind === "ellipse") {
    return [sampleEllipsePoints(entity.cx, entity.cy, entity.rx, entity.ry, entity.rotation, 48)];
  }

  if (entity.kind === "path") {
    const subpaths = entity.d.match(/[Mm][^Mm]*/g) ?? [];
    return subpaths
      .filter((subpath) => /z/i.test(subpath))
      .map((subpath) => samplePathPoints(subpath, { offsetX: bounds.minX, offsetY: bounds.minY, closed: true, minSegments: 36, maxSegments: 900, segmentLength: 2.5 }))
      .filter((points) => points.length >= 3);
  }

  return [];
}

function classifyClosedLoops(entities: GeometryEntity[], bounds: PieceGeometry["sourceBounds"]) {
  const loops = entities
    .flatMap((entity) => sampleClosedLoopsFromEntity(entity, bounds))
    .filter((points) => points.length >= 3)
    .map((points) => ({ points, area: polygonArea(points), isHole: false satisfies boolean }));

  return loops.map((loop) => {
    const representative = contourRepresentativePoint(loop.points);
    const depth = loops.reduce((count, candidate) => {
      if (candidate === loop || candidate.area <= loop.area) {
        return count;
      }

      return pointInPolygon(representative, candidate.points) ? count + 1 : count;
    }, 0);

    return {
      ...loop,
      isHole: depth % 2 === 1
    } satisfies SampledClosedLoop;
  });
}

function approximateEntityArea(entity: GeometryEntity, bounds: PieceGeometry["sourceBounds"]) {
  switch (entity.kind) {
    case "polyline":
      return entity.closed && entity.points.length >= 3 ? polygonArea(entity.points) : 0;
    case "circle":
      return Math.PI * entity.r * entity.r;
    case "ellipse":
      return Math.PI * entity.rx * entity.ry;
    case "ellipseArc":
      return 0;
    case "arc":
      return 0;
    case "path": {
      const subpaths = entity.d.match(/[Mm][^Mm]*/g) ?? [];
      return subpaths.reduce((sum, subpath) => {
        if (!/z/i.test(subpath)) {
          return sum;
        }

        const points = samplePathPoints(subpath, { offsetX: bounds.minX, offsetY: bounds.minY, closed: true, minSegments: 36, maxSegments: 900, segmentLength: 2.5 });
        return points.length >= 3 ? sum + polygonArea(points) : sum;
      }, 0);
    }
    default:
      return 0;
  }
}

export function entitiesFromSvgElement(element: Element): GeometryEntity[] {
  const tag = element.tagName.toLowerCase();

  if (tag === "rect") {
    const x = Number(element.getAttribute("x") ?? 0);
    const y = Number(element.getAttribute("y") ?? 0);
    const width = Number(element.getAttribute("width") ?? 0);
    const height = Number(element.getAttribute("height") ?? 0);
    return [
      {
        kind: "polyline",
        closed: true,
        points: [
          { x, y },
          { x: x + width, y },
          { x: x + width, y: y + height },
          { x, y: y + height }
        ]
      }
    ];
  }

  if (tag === "circle") {
    return [
      {
        kind: "circle",
        cx: Number(element.getAttribute("cx") ?? 0),
        cy: Number(element.getAttribute("cy") ?? 0),
        r: Number(element.getAttribute("r") ?? 0)
      }
    ];
  }

  if (tag === "ellipse") {
    return [
      {
        kind: "ellipse",
        cx: Number(element.getAttribute("cx") ?? 0),
        cy: Number(element.getAttribute("cy") ?? 0),
        rx: Number(element.getAttribute("rx") ?? 0),
        ry: Number(element.getAttribute("ry") ?? 0),
        rotation: 0
      }
    ];
  }

  if (tag === "polygon" || tag === "polyline") {
    return [
      {
        kind: "polyline",
        closed: tag === "polygon",
        points: parsePointsAttribute(element.getAttribute("points") ?? "")
      }
    ];
  }

  if (tag === "line") {
    return [
      {
        kind: "polyline",
        closed: false,
        points: [
          {
            x: Number(element.getAttribute("x1") ?? 0),
            y: Number(element.getAttribute("y1") ?? 0)
          },
          {
            x: Number(element.getAttribute("x2") ?? 0),
            y: Number(element.getAttribute("y2") ?? 0)
          }
        ]
      }
    ];
  }

  if (tag === "path") {
    const d = element.getAttribute("d") ?? "";
    return [{ kind: "path", d, closed: /z/i.test(d) }];
  }

  return [];
}

function normalizeEntity(entity: GeometryEntity, offsetX: number, offsetY: number): GeometryEntity {
  switch (entity.kind) {
    case "polyline":
      return normalizePolylineEntity({
        ...entity,
        points: entity.points.map((point) => shiftPoint(point, offsetX, offsetY))
      });
    case "circle":
      return {
        ...entity,
        cx: round(entity.cx - offsetX),
        cy: round(entity.cy - offsetY)
      };
    case "ellipse":
      return {
        ...entity,
        cx: round(entity.cx - offsetX),
        cy: round(entity.cy - offsetY)
      };
    case "ellipseArc":
      return {
        ...entity,
        cx: round(entity.cx - offsetX),
        cy: round(entity.cy - offsetY)
      };
    case "arc":
      return {
        ...entity,
        cx: round(entity.cx - offsetX),
        cy: round(entity.cy - offsetY)
      };
    case "path":
      return entity;
    default:
      return entity;
  }
}

export function normalizeSvgMarkup(markup: string, bounds: PieceGeometry["sourceBounds"]) {
  return `<g transform="translate(${-bounds.minX} ${-bounds.minY})">${markup}</g>`;
}

export function getGeometrySignature(geometry: PieceGeometry) {
  const entitySignatures = geometry.entities.map((entity) => {
    if (entity.kind === "circle") {
      return `circle:${round(entity.cx).toFixed(3)}:${round(entity.cy).toFixed(3)}:${round(entity.r).toFixed(3)}`;
    }

    if (entity.kind === "ellipse") {
      return `ellipse:${round(entity.cx).toFixed(3)}:${round(entity.cy).toFixed(3)}:${round(entity.rx).toFixed(3)}:${round(entity.ry).toFixed(3)}:${round(entity.rotation).toFixed(6)}`;
    }

    if (entity.kind === "ellipseArc") {
      return `ellipseArc:${round(entity.cx).toFixed(3)}:${round(entity.cy).toFixed(3)}:${round(entity.rx).toFixed(3)}:${round(entity.ry).toFixed(3)}:${round(entity.rotation).toFixed(6)}:${round(entity.startAngle).toFixed(6)}:${round(entity.endAngle).toFixed(6)}`;
    }

    if (entity.kind === "arc") {
      return `arc:${round(entity.cx).toFixed(3)}:${round(entity.cy).toFixed(3)}:${round(entity.r).toFixed(3)}:${round(entity.startAngle).toFixed(6)}:${round(entity.endAngle).toFixed(6)}`;
    }

    const sampledPoints = sampleEntitySignaturePoints(entity, geometry.sourceBounds);
    return `${entity.kind}:${entity.kind === "path" ? (entity.closed ? "closed" : "open") : entity.kind === "polyline" ? (entity.closed ? "closed" : "open") : ""}:${sampledPoints
      .map(pointToken)
      .join("|")}`;
  });

  return [
    geometry.width.toFixed(3),
    geometry.height.toFixed(3),
    geometry.closed ? "closed" : "open",
    entitySignatures.join("||")
  ].join("::");
}

export function buildPieceGeometry(
  element: SVGGraphicsElement,
  sourceEntities?: GeometryEntity[]
): PieceGeometry {
  const tag = element.tagName.toLowerCase();
  const rawEntities = sourceEntities?.length ? sourceEntities : entitiesFromSvgElement(element);
  const sourceBounds = rawEntities.length
    ? getBoundsFromEntities(rawEntities)
    : getElementBounds(element);
  const bounds = {
    ...sourceBounds,
    width: round(sourceBounds.maxX - sourceBounds.minX),
    height: round(sourceBounds.maxY - sourceBounds.minY)
  };
  const markup = new XMLSerializer().serializeToString(element);
  const closed =
    rawEntities.length > 0
      ? rawEntities.every((entity) =>
          entity.kind === "path"
            ? entity.closed
            : entity.kind === "polyline"
              ? entity.closed
              : entity.kind !== "arc" && entity.kind !== "ellipseArc"
        )
      : isClosedShape(element);
  const hasCurves =
    rawEntities.length > 0
      ? rawEntities.some(
          (entity) =>
            entity.kind === "circle" ||
            entity.kind === "ellipse" ||
            entity.kind === "ellipseArc" ||
            entity.kind === "arc" ||
            entity.kind === "path"
        )
      : tag === "circle" ||
        tag === "ellipse" ||
        (tag === "path" && /[CQASTcqast]/.test(element.getAttribute("d") ?? ""));
  const classifiedLoops = classifyClosedLoops(rawEntities, bounds);
  const approxAreaFromLoops = classifiedLoops.reduce(
    (sum, loop) => sum + loop.area * (loop.isHole ? -1 : 1),
    0
  );
  const approxArea =
    approxAreaFromLoops ||
    rawEntities.reduce((sum, entity) => sum + approximateEntityArea(entity, bounds), 0);

  return {
    svgMarkup: markup,
    width: bounds.width,
    height: bounds.height,
    area: round(approxArea || bounds.width * bounds.height),
    sourceBounds: {
      minX: bounds.minX,
      minY: bounds.minY,
      maxX: bounds.maxX,
      maxY: bounds.maxY
    },
    closed,
    hasCurves,
    hasHoles: classifiedLoops.some((loop) => loop.isHole),
    entities: rawEntities.map((entity) => normalizeEntity(entity, bounds.minX, bounds.minY))
  };
}
