import DxfParser from "dxf-parser";
import { normalizePolylineEntity } from "./contours";
import { buildPieceGeometry, entitiesFromSvgElement } from "./geometry";
import { convertDwgToSvg } from "./dwg";
import { sampleArcPoints, sampleEllipseArcPoints, sampleEllipsePoints, samplePathPoints } from "./sampling";
import { slugId } from "./utils";
import type { GeometryEntity, GeometryWarning, PieceGeometry, PieceItem } from "../types";

const SVG_NS = "http://www.w3.org/2000/svg";
const GROUP_TOLERANCE = 0.5;

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

function readFileAsText(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}

function fallbackGeometry(): PieceGeometry {
  return {
    svgMarkup: "",
    width: 0,
    height: 0,
    area: 0,
    sourceBounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    closed: false,
    hasCurves: false,
    hasHoles: false,
    entities: []
  };
}

function createPiece(
  sourceFile: string,
  idx: number,
  warnings: GeometryWarning[],
  geometry: PieceGeometry = fallbackGeometry()
): PieceItem {
  return {
    id: slugId("pieza"),
    name: `Pieza ${String(idx + 1).padStart(2, "0")}`,
    quantity: 1,
    enabled: true,
    sourceFile,
    warnings,
    geometry
  };
}

function pieceFromSvgElement(
  el: SVGGraphicsElement,
  sourceFile: string,
  idx: number,
  sourceEntities?: GeometryEntity[],
  extraWarnings: GeometryWarning[] = []
): PieceItem {
  const geometry = buildPieceGeometry(el, sourceEntities);
  const warnings: GeometryWarning[] = [...extraWarnings];

  if (!geometry.closed) {
    warnings.push("open-path");
  }

  if (geometry.width <= 0 || geometry.height <= 0) {
    warnings.push("invalid-shape");
  }

  return createPiece(sourceFile, idx, [...new Set(warnings)], geometry);
}

function entityFormsClosedPiece(entity: GeometryEntity) {
  if (entity.kind === "polyline" || entity.kind === "path") {
    return entity.closed;
  }

  return entity.kind !== "arc" && entity.kind !== "ellipseArc";
}

export function splitCompoundPathData(pathData: string) {
  return (pathData.match(/[Mm][^Mm]*/g) ?? []).map((subpath) => subpath.trim()).filter(Boolean);
}

function appendSvgElementFromDxfEntity(entity: GeometryEntity) {
  switch (entity.kind) {
    case "polyline": {
      const el = document.createElementNS(SVG_NS, entity.closed ? "polygon" : "polyline");
      el.setAttribute(
        "points",
        entity.points.map((point) => `${point.x},${point.y}`).join(" ")
      );
      el.setAttribute("fill", "none");
      el.setAttribute("stroke", "#111");
      el.setAttribute("stroke-width", "1");
      return el;
    }
    case "circle": {
      const el = document.createElementNS(SVG_NS, "circle");
      el.setAttribute("cx", String(entity.cx));
      el.setAttribute("cy", String(entity.cy));
      el.setAttribute("r", String(entity.r));
      el.setAttribute("fill", "none");
      el.setAttribute("stroke", "#111");
      el.setAttribute("stroke-width", "1");
      return el;
    }
    case "ellipse": {
      const el = document.createElementNS(SVG_NS, "ellipse");
      el.setAttribute("cx", String(entity.cx));
      el.setAttribute("cy", String(entity.cy));
      el.setAttribute("rx", String(entity.rx));
      el.setAttribute("ry", String(entity.ry));
      if (Math.abs(entity.rotation) > 0.000001) {
        el.setAttribute(
          "transform",
          `rotate(${(entity.rotation * 180) / Math.PI} ${entity.cx} ${entity.cy})`
        );
      }
      el.setAttribute("fill", "none");
      el.setAttribute("stroke", "#111");
      el.setAttribute("stroke-width", "1");
      return el;
    }
    case "ellipseArc": {
      const points = sampleEllipseArcPoints(entity, 96);
      const start = points[0];
      const end = points[points.length - 1];
      if (!start || !end) {
        return null;
      }
      let sweep = entity.endAngle - entity.startAngle;
      while (sweep <= 0) {
        sweep += Math.PI * 2;
      }
      const el = document.createElementNS(SVG_NS, "path");
      el.setAttribute(
        "d",
        `M ${start.x} ${start.y} A ${entity.rx} ${entity.ry} ${(entity.rotation * 180) / Math.PI} ${sweep > Math.PI ? 1 : 0} 1 ${end.x} ${end.y}`
      );
      el.setAttribute("fill", "none");
      el.setAttribute("stroke", "#111");
      el.setAttribute("stroke-width", "1");
      return el;
    }
    case "arc": {
      const x1 = entity.cx + entity.r * Math.cos(entity.startAngle);
      const y1 = entity.cy - entity.r * Math.sin(entity.startAngle);
      const x2 = entity.cx + entity.r * Math.cos(entity.endAngle);
      const y2 = entity.cy - entity.r * Math.sin(entity.endAngle);
      const angleDelta = ((entity.endAngle - entity.startAngle) * 180) / Math.PI;
      const normalizedDelta = ((angleDelta % 360) + 360) % 360;
      const largeArc = normalizedDelta > 180 ? 1 : 0;
      const el = document.createElementNS(SVG_NS, "path");
      el.setAttribute("d", `M ${x1} ${y1} A ${entity.r} ${entity.r} 0 ${largeArc} 0 ${x2} ${y2}`);
      el.setAttribute("fill", "none");
      el.setAttribute("stroke", "#111");
      el.setAttribute("stroke-width", "1");
      return el;
    }
    case "path": {
      const el = document.createElementNS(SVG_NS, "path");
      el.setAttribute("d", entity.d);
      el.setAttribute("fill", "none");
      el.setAttribute("stroke", "#111");
      el.setAttribute("stroke-width", "1");
      return el;
    }
    default:
      return null;
  }
}

type EntityBounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

type DxfGeometryItem = {
  geometry: GeometryEntity;
  partial: boolean;
  bounds: EntityBounds;
  endpoints: { start: { x: number; y: number } | null; end: { x: number; y: number } | null };
};

type ParsedDxfEntity = Record<string, unknown>;

type SvgMatrix = {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
};

function identityMatrix(): SvgMatrix {
  return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
}

function multiplySvgMatrices(left: SvgMatrix, right: SvgMatrix): SvgMatrix {
  return {
    a: left.a * right.a + left.c * right.b,
    b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d,
    d: left.b * right.c + left.d * right.d,
    e: left.a * right.e + left.c * right.f + left.e,
    f: left.b * right.e + left.d * right.f + left.f
  };
}

function applySvgMatrix(matrix: SvgMatrix, point: { x: number; y: number }) {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f
  };
}

function translateSvgMatrix(tx: number, ty: number): SvgMatrix {
  return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
}

function scaleSvgMatrix(sx: number, sy: number): SvgMatrix {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
}

function rotateSvgMatrix(angleDeg: number, cx = 0, cy = 0): SvgMatrix {
  const angle = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return multiplySvgMatrices(
    multiplySvgMatrices(translateSvgMatrix(cx, cy), { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 }),
    translateSvgMatrix(-cx, -cy)
  );
}

function skewXSvgMatrix(angleDeg: number): SvgMatrix {
  return { a: 1, b: 0, c: Math.tan((angleDeg * Math.PI) / 180), d: 1, e: 0, f: 0 };
}

function skewYSvgMatrix(angleDeg: number): SvgMatrix {
  return { a: 1, b: Math.tan((angleDeg * Math.PI) / 180), c: 0, d: 1, e: 0, f: 0 };
}

function parseSvgTransform(transform: string | null | undefined) {
  if (!transform?.trim()) {
    return identityMatrix();
  }

  const commandRegex = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/gi;
  let result = identityMatrix();

  for (const match of transform.matchAll(commandRegex)) {
    const command = match[1];
    const values = match[2]
      .trim()
      .split(/[\s,]+/)
      .map(Number)
      .filter((value) => Number.isFinite(value));

    let next = identityMatrix();
    switch (command) {
      case "matrix":
        if (values.length === 6) {
          next = { a: values[0], b: values[1], c: values[2], d: values[3], e: values[4], f: values[5] };
        }
        break;
      case "translate":
        next = translateSvgMatrix(values[0] ?? 0, values[1] ?? 0);
        break;
      case "scale":
        next = scaleSvgMatrix(values[0] ?? 1, values[1] ?? values[0] ?? 1);
        break;
      case "rotate":
        next = rotateSvgMatrix(values[0] ?? 0, values[1] ?? 0, values[2] ?? 0);
        break;
      case "skewX":
        next = skewXSvgMatrix(values[0] ?? 0);
        break;
      case "skewY":
        next = skewYSvgMatrix(values[0] ?? 0);
        break;
      default:
        next = identityMatrix();
        break;
    }

    result = multiplySvgMatrices(result, next);
  }

  return result;
}

function collectSvgNodeTransform(node: SVGElement, root: SVGElement) {
  const chain: SVGElement[] = [];
  let current: SVGElement | null = node;

  while (current) {
    chain.push(current);
    if (current === root) {
      break;
    }
    current = current.parentElement instanceof SVGElement ? current.parentElement : null;
  }

  return chain
    .reverse()
    .reduce((matrix, element) => multiplySvgMatrices(matrix, parseSvgTransform(element.getAttribute("transform"))), identityMatrix());
}

function createEntityBounds(points: Array<{ x: number; y: number }>): EntityBounds {
  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y))
  };
}

function boundsFromGeometry(geometry: GeometryEntity): EntityBounds {
  switch (geometry.kind) {
    case "polyline":
      return createEntityBounds(geometry.points);
    case "circle":
      return {
        minX: geometry.cx - geometry.r,
        minY: geometry.cy - geometry.r,
        maxX: geometry.cx + geometry.r,
        maxY: geometry.cy + geometry.r
      };
    case "ellipse":
      return createEntityBounds(
        sampleEllipsePoints(
          geometry.cx,
          geometry.cy,
          geometry.rx,
          geometry.ry,
          geometry.rotation,
          48
        )
      );
    case "ellipseArc":
      return createEntityBounds(
        sampleEllipseArcPoints(geometry, 48)
      );
    case "arc":
      return createEntityBounds(sampleArcPoints(geometry));
    case "path": {
      const temp = appendSvgElementFromDxfEntity(geometry);
      if (!temp) {
        return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
      }

      const probe = createProbeSvg();
      probe.appendChild(temp);
      const bounds = temp.getBBox();
      temp.remove();
      probe.remove();
      return {
        minX: bounds.x,
        minY: bounds.y,
        maxX: bounds.x + bounds.width,
        maxY: bounds.y + bounds.height
      };
    }
    default:
      return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  }
}

function createGeometryItem(geometry: GeometryEntity, partial = false): DxfGeometryItem {
  return {
    geometry,
    partial,
    bounds: boundsFromGeometry(geometry),
    endpoints: endpointsFromGeometry(geometry)
  };
}

function geometrySignature(geometry: GeometryEntity) {
  switch (geometry.kind) {
    case "polyline":
      return [
        "polyline",
        geometry.closed ? "closed" : "open",
        geometry.points.map((point) => `${point.x.toFixed(3)},${point.y.toFixed(3)}`).join("|")
      ].join("::");
    case "circle":
      return `circle::${geometry.cx.toFixed(3)}::${geometry.cy.toFixed(3)}::${geometry.r.toFixed(3)}`;
    case "ellipse":
      return `ellipse::${geometry.cx.toFixed(3)}::${geometry.cy.toFixed(3)}::${geometry.rx.toFixed(3)}::${geometry.ry.toFixed(3)}::${geometry.rotation.toFixed(6)}`;
    case "ellipseArc":
      return `ellipseArc::${geometry.cx.toFixed(3)}::${geometry.cy.toFixed(3)}::${geometry.rx.toFixed(3)}::${geometry.ry.toFixed(3)}::${geometry.rotation.toFixed(6)}::${geometry.startAngle.toFixed(6)}::${geometry.endAngle.toFixed(6)}`;
    case "arc":
      return `arc::${geometry.cx.toFixed(3)}::${geometry.cy.toFixed(3)}::${geometry.r.toFixed(3)}::${geometry.startAngle.toFixed(6)}::${geometry.endAngle.toFixed(6)}`;
    case "path":
      return `path::${geometry.closed ? "closed" : "open"}::${geometry.d}`;
    default:
      return JSON.stringify(geometry);
  }
}

function isDegenerateGeometry(geometry: GeometryEntity) {
  if (geometry.kind === "polyline") {
    if (geometry.points.length < (geometry.closed ? 3 : 2)) {
      return true;
    }

    const bounds = boundsFromGeometry(geometry);
    if (Math.abs(bounds.maxX - bounds.minX) < 0.001 && Math.abs(bounds.maxY - bounds.minY) < 0.001) {
      return true;
    }

    if (geometry.closed) {
      let area = 0;
      for (let index = 0; index < geometry.points.length; index += 1) {
        const current = geometry.points[index];
        const next = geometry.points[(index + 1) % geometry.points.length];
        area += current.x * next.y - next.x * current.y;
      }
      return Math.abs(area / 2) < 0.05;
    }

    let length = 0;
    for (let index = 0; index < geometry.points.length - 1; index += 1) {
      const start = geometry.points[index];
      const end = geometry.points[index + 1];
      length += Math.hypot(end.x - start.x, end.y - start.y);
    }
    return length < 0.25;
  }

  if (geometry.kind === "circle") {
    return geometry.r <= 0.1;
  }

  if (geometry.kind === "ellipse" || geometry.kind === "ellipseArc") {
    return geometry.rx <= 0.1 || geometry.ry <= 0.1;
  }

  if (geometry.kind === "arc") {
    return geometry.r <= 0.1;
  }

  return false;
}

function pointsNearEqual(
  left: Array<{ x: number; y: number }>,
  right: Array<{ x: number; y: number }>,
  tolerance = 0.12
) {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((point, index) => {
    const candidate = right[index];
    return Math.abs(point.x - candidate.x) <= tolerance && Math.abs(point.y - candidate.y) <= tolerance;
  });
}

function reversePoints<T>(points: T[]) {
  return points.slice().reverse();
}

function areGeometriesNearEqual(left: GeometryEntity, right: GeometryEntity, tolerance = 0.12) {
  if (left.kind !== right.kind) {
    return false;
  }

  if (left.kind === "polyline" && right.kind === "polyline") {
    if (left.closed !== right.closed) {
      return false;
    }

    return (
      pointsNearEqual(left.points, right.points, tolerance) ||
      pointsNearEqual(left.points, reversePoints(right.points), tolerance)
    );
  }

  if (left.kind === "circle" && right.kind === "circle") {
    return (
      Math.abs(left.cx - right.cx) <= tolerance &&
      Math.abs(left.cy - right.cy) <= tolerance &&
      Math.abs(left.r - right.r) <= tolerance
    );
  }

  if (left.kind === "ellipse" && right.kind === "ellipse") {
    return (
      Math.abs(left.cx - right.cx) <= tolerance &&
      Math.abs(left.cy - right.cy) <= tolerance &&
      Math.abs(left.rx - right.rx) <= tolerance &&
      Math.abs(left.ry - right.ry) <= tolerance &&
      Math.abs(left.rotation - right.rotation) <= 0.01
    );
  }

  if (left.kind === "ellipseArc" && right.kind === "ellipseArc") {
    return (
      Math.abs(left.cx - right.cx) <= tolerance &&
      Math.abs(left.cy - right.cy) <= tolerance &&
      Math.abs(left.rx - right.rx) <= tolerance &&
      Math.abs(left.ry - right.ry) <= tolerance &&
      Math.abs(left.rotation - right.rotation) <= 0.01 &&
      Math.abs(left.startAngle - right.startAngle) <= 0.01 &&
      Math.abs(left.endAngle - right.endAngle) <= 0.01
    );
  }

  if (left.kind === "arc" && right.kind === "arc") {
    return (
      Math.abs(left.cx - right.cx) <= tolerance &&
      Math.abs(left.cy - right.cy) <= tolerance &&
      Math.abs(left.r - right.r) <= tolerance &&
      Math.abs(left.startAngle - right.startAngle) <= 0.01 &&
      Math.abs(left.endAngle - right.endAngle) <= 0.01
    );
  }

  if (left.kind === "path" && right.kind === "path") {
    return left.closed === right.closed && left.d === right.d;
  }

  return false;
}

function dedupeGeometryEntities(entities: GeometryEntity[]) {
  const seen = new Set<string>();
  const deduped: GeometryEntity[] = [];

  entities.forEach((entity) => {
    if (isDegenerateGeometry(entity)) {
      return;
    }

    const signature = geometrySignature(entity);
    if (seen.has(signature)) {
      return;
    }

    if (deduped.some((candidate) => areGeometriesNearEqual(candidate, entity))) {
      return;
    }

    seen.add(signature);
    deduped.push(entity);
  });

  return deduped;
}

function transformSvgImportEntity(entity: GeometryEntity, matrix: SvgMatrix) {
  switch (entity.kind) {
    case "polyline":
      return {
        kind: "polyline" as const,
        closed: entity.closed,
        points: entity.points.map((point) => applySvgMatrix(matrix, point))
      };
    case "circle":
      return {
        kind: "polyline" as const,
        closed: true,
        points: sampleEllipsePoints(entity.cx, entity.cy, entity.r, entity.r, 0, 64).map((point) => applySvgMatrix(matrix, point))
      };
    case "ellipse":
      return {
        kind: "polyline" as const,
        closed: true,
        points: sampleEllipsePoints(entity.cx, entity.cy, entity.rx, entity.ry, entity.rotation, 64).map((point) =>
          applySvgMatrix(matrix, point)
        )
      };
    case "ellipseArc":
      return {
        kind: "polyline" as const,
        closed: false,
        points: sampleEllipseArcPoints(entity, 64).map((point) => applySvgMatrix(matrix, point))
      };
    case "arc":
      return {
        kind: "polyline" as const,
        closed: false,
        points: sampleArcPoints(entity, 48).map((point) => applySvgMatrix(matrix, point))
      };
    case "path":
      return {
        kind: "polyline" as const,
        closed: entity.closed,
        points: samplePathPoints(entity.d, {
          closed: entity.closed,
          minSegments: entity.closed ? 48 : 24,
          maxSegments: 960,
          segmentLength: 2.5
        }).map((point) => applySvgMatrix(matrix, point))
      };
    default:
      return entity;
  }
}

function svgNodeToGeometryItems(node: SVGGraphicsElement) {
  const svgRoot = node.ownerSVGElement ?? node;
  const transform = collectSvgNodeTransform(node, svgRoot);
  const entities = entitiesFromSvgElement(node);
  return entities.flatMap((entity) => {
    const sourceEntities =
      entity.kind === "path"
        ? splitCompoundPathData(entity.d).map((subpath) => ({
            kind: "path" as const,
            d: subpath,
            closed: /z/i.test(subpath)
          }))
        : [entity];

    return sourceEntities.map((sourceEntity) => {
      const transformed = transformSvgImportEntity(sourceEntity, transform);
      return createGeometryItem(
        transformed.kind === "polyline" ? normalizePolylineEntity(transformed) : transformed
      );
    });
  });
}

function endpointsFromGeometry(
  geometry: GeometryEntity
): { start: { x: number; y: number } | null; end: { x: number; y: number } | null } {
  if (geometry.kind === "polyline") {
    const start = geometry.points[0] ?? null;
    const end = geometry.points[geometry.points.length - 1] ?? null;
    return { start, end };
  }

  if (geometry.kind === "arc") {
    const points = sampleArcPoints(geometry, 2);
    return {
      start: points[0] ?? null,
      end: points[points.length - 1] ?? null
    };
  }

  if (geometry.kind === "ellipseArc") {
    const points = sampleEllipseArcPoints(geometry, 2);
    return {
      start: points[0] ?? null,
      end: points[points.length - 1] ?? null
    };
  }

  return { start: null, end: null };
}

function distance(a: { x: number; y: number } | null, b: { x: number; y: number } | null) {
  if (!a || !b) {
    return Number.POSITIVE_INFINITY;
  }

  return Math.hypot(a.x - b.x, a.y - b.y);
}

function samePoint(a: { x: number; y: number } | null, b: { x: number; y: number } | null, tolerance = GROUP_TOLERANCE) {
  return distance(a, b) <= tolerance;
}

function boundsOverlap(a: EntityBounds, b: EntityBounds, tolerance = GROUP_TOLERANCE) {
  return !(
    a.maxX + tolerance < b.minX ||
    a.minX - tolerance > b.maxX ||
    a.maxY + tolerance < b.minY ||
    a.minY - tolerance > b.maxY
  );
}

function boundsContain(container: EntityBounds, target: EntityBounds, tolerance = GROUP_TOLERANCE) {
  return (
    container.minX - tolerance <= target.minX &&
    container.minY - tolerance <= target.minY &&
    container.maxX + tolerance >= target.maxX &&
    container.maxY + tolerance >= target.maxY
  );
}

function boundsStrictOverlap(a: EntityBounds, b: EntityBounds, tolerance = 0.001) {
  return !(
    a.maxX <= b.minX + tolerance ||
    a.minX >= b.maxX - tolerance ||
    a.maxY <= b.minY + tolerance ||
    a.minY >= b.maxY - tolerance
  );
}

function geometryHasLooseEndpoints(geometry: GeometryEntity) {
  if (geometry.kind === "polyline") {
    return !geometry.closed;
  }

  if (geometry.kind === "path") {
    return !geometry.closed;
  }

  return geometry.kind === "arc" || geometry.kind === "ellipseArc";
}

function areItemsConnected(a: DxfGeometryItem, b: DxfGeometryItem) {
  if (boundsContain(a.bounds, b.bounds, 0.05) || boundsContain(b.bounds, a.bounds, 0.05)) {
    return true;
  }

  const endpointDistances = [
    distance(a.endpoints.start, b.endpoints.start),
    distance(a.endpoints.start, b.endpoints.end),
    distance(a.endpoints.end, b.endpoints.start),
    distance(a.endpoints.end, b.endpoints.end)
  ];

  if (
    (geometryHasLooseEndpoints(a.geometry) || geometryHasLooseEndpoints(b.geometry)) &&
    endpointDistances.some((value) => value <= GROUP_TOLERANCE)
  ) {
    return true;
  }

  return boundsStrictOverlap(a.bounds, b.bounds);
}

function reversePolyline(entity: Extract<GeometryEntity, { kind: "polyline" }>) {
  return {
    ...entity,
    points: entity.points.slice().reverse()
  };
}

export function mergeConnectedPolylines(entities: GeometryEntity[]) {
  const polylines = entities
    .filter((entity): entity is Extract<GeometryEntity, { kind: "polyline" }> => entity.kind === "polyline")
    .map((entity) => normalizePolylineEntity(entity));
  const closed = polylines.filter((entity) => entity.closed);
  const open = polylines.filter((entity) => !entity.closed && entity.points.length >= 2);
  const others = entities.filter((entity) => entity.kind !== "polyline");
  const merged: Extract<GeometryEntity, { kind: "polyline" }>[] = [];
  const consumed = new Set<number>();

  for (let index = 0; index < open.length; index += 1) {
    if (consumed.has(index)) {
      continue;
    }

    let current = open[index];
    consumed.add(index);
    let expanded = true;

    while (expanded) {
      expanded = false;

      for (let candidateIndex = 0; candidateIndex < open.length; candidateIndex += 1) {
        if (consumed.has(candidateIndex)) {
          continue;
        }

        const candidate = open[candidateIndex];
        const currentStart = current.points[0] ?? null;
        const currentEnd = current.points[current.points.length - 1] ?? null;
        const candidateStart = candidate.points[0] ?? null;
        const candidateEnd = candidate.points[candidate.points.length - 1] ?? null;

        if (samePoint(currentEnd, candidateStart)) {
          current = normalizePolylineEntity({
            kind: "polyline",
            closed: false,
            points: current.points.concat(candidate.points.slice(1))
          });
        } else if (samePoint(currentEnd, candidateEnd)) {
          const reversed = reversePolyline(candidate);
          current = normalizePolylineEntity({
            kind: "polyline",
            closed: false,
            points: current.points.concat(reversed.points.slice(1))
          });
        } else if (samePoint(currentStart, candidateEnd)) {
          current = normalizePolylineEntity({
            kind: "polyline",
            closed: false,
            points: candidate.points.concat(current.points.slice(1))
          });
        } else if (samePoint(currentStart, candidateStart)) {
          const reversed = reversePolyline(candidate);
          current = normalizePolylineEntity({
            kind: "polyline",
            closed: false,
            points: reversed.points.concat(current.points.slice(1))
          });
        } else {
          continue;
        }

        consumed.add(candidateIndex);
        expanded = true;
        break;
      }
    }

    const start = current.points[0] ?? null;
    const end = current.points[current.points.length - 1] ?? null;
    if (samePoint(start, end)) {
      current = normalizePolylineEntity({
        kind: "polyline",
        closed: true,
        points: current.points
      });
    }

    merged.push(current);
  }

  return [...closed, ...merged, ...others];
}

function rotatePoint(point: { x: number; y: number }, angleDeg: number) {
  const angle = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    x: point.x * cos - point.y * sin,
    y: point.x * sin + point.y * cos
  };
}

function ellipsePoint(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rotation: number,
  param: number
) {
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const localX = rx * Math.cos(param);
  const localY = ry * Math.sin(param);
  return {
    x: cx + localX * cos - localY * sin,
    y: cy + localX * sin + localY * cos
  };
}

function transformPoint(
  point: { x: number; y: number },
  position: { x: number; y: number },
  scaleX: number,
  scaleY: number,
  rotation: number
) {
  const scaled = {
    x: point.x * scaleX,
    y: point.y * scaleY
  };
  const rotated = rotatePoint(scaled, rotation);
  return {
    x: rotated.x + position.x,
    y: rotated.y + position.y
  };
}

function scalePoint(point: { x: number; y: number }, factor: number) {
  return {
    x: point.x * factor,
    y: point.y * factor
  };
}

export function transformGeometryEntity(
  geometry: GeometryEntity,
  position: { x: number; y: number },
  scaleX: number,
  scaleY: number,
  rotation: number
): GeometryEntity {
  if (geometry.kind === "polyline") {
    return {
      ...geometry,
      points: geometry.points.map((point) => transformPoint(point, position, scaleX, scaleY, rotation))
    };
  }

  if (geometry.kind === "circle") {
    const center = transformPoint({ x: geometry.cx, y: geometry.cy }, position, scaleX, scaleY, rotation);
    const uniformScale = (Math.abs(scaleX) + Math.abs(scaleY)) / 2;
    if (Math.abs(Math.abs(scaleX) - Math.abs(scaleY)) < 0.0001 && Math.abs(rotation) < 0.0001) {
      return {
        kind: "circle",
        cx: center.x,
        cy: center.y,
        r: geometry.r * uniformScale
      };
    }

    const sampled = sampleArcPoints(
      {
        kind: "arc",
        cx: geometry.cx,
        cy: geometry.cy,
        r: geometry.r,
        startAngle: 0,
        endAngle: Math.PI * 2
      },
      96
    ).map((point) => transformPoint(point, position, scaleX, scaleY, rotation));
    return {
      kind: "polyline",
      points: sampled,
      closed: true
    };
  }

  if (geometry.kind === "ellipse") {
    if (Math.abs(Math.abs(scaleX) - Math.abs(scaleY)) < 0.0001) {
      const center = transformPoint({ x: geometry.cx, y: geometry.cy }, position, scaleX, scaleY, rotation);
      return {
        kind: "ellipse",
        cx: center.x,
        cy: center.y,
        rx: geometry.rx * Math.abs(scaleX),
        ry: geometry.ry * Math.abs(scaleY),
        rotation: geometry.rotation + (rotation * Math.PI) / 180
      };
    }

    const sampled = sampleEllipsePoints(geometry.cx, geometry.cy, geometry.rx, geometry.ry, geometry.rotation, 96).map(
      (point) => transformPoint(point, position, scaleX, scaleY, rotation)
    );

    return {
      kind: "polyline",
      points: sampled,
      closed: true
    };
  }

  if (geometry.kind === "ellipseArc") {
    if (Math.abs(Math.abs(scaleX) - Math.abs(scaleY)) < 0.0001) {
      const center = transformPoint({ x: geometry.cx, y: geometry.cy }, position, scaleX, scaleY, rotation);
      return {
        kind: "ellipseArc",
        cx: center.x,
        cy: center.y,
        rx: geometry.rx * Math.abs(scaleX),
        ry: geometry.ry * Math.abs(scaleY),
        rotation: geometry.rotation + (rotation * Math.PI) / 180,
        startAngle: geometry.startAngle,
        endAngle: geometry.endAngle
      };
    }

    const sampled = sampleEllipseArcPoints(geometry, 96).map((point) =>
      transformPoint(point, position, scaleX, scaleY, rotation)
    );

    return {
      kind: "polyline",
      points: sampled,
      closed: false
    };
  }

  if (geometry.kind === "arc") {
    const center = transformPoint({ x: geometry.cx, y: geometry.cy }, position, scaleX, scaleY, rotation);
    const uniformScale = (Math.abs(scaleX) + Math.abs(scaleY)) / 2;
    if (Math.abs(Math.abs(scaleX) - Math.abs(scaleY)) < 0.0001) {
      const angleOffset = (rotation * Math.PI) / 180;
      return {
        kind: "arc",
        cx: center.x,
        cy: center.y,
        r: geometry.r * uniformScale,
        startAngle: geometry.startAngle + angleOffset,
        endAngle: geometry.endAngle + angleOffset
      };
    }

    const sampled = sampleArcPoints(geometry, 48).map((point) =>
      transformPoint(point, position, scaleX, scaleY, rotation)
    );
    return {
      kind: "polyline",
      points: sampled,
      closed: false
    };
  }

  if (geometry.kind === "path") {
    const sampled = samplePathPoints(geometry.d, {
      closed: geometry.closed,
      minSegments: geometry.closed ? 96 : 72,
      maxSegments: 960,
      segmentLength: 2.5
    }).map((point) => transformPoint(point, position, scaleX, scaleY, rotation));
    return {
      kind: "polyline",
      points: sampled,
      closed: geometry.closed
    };
  }

  return geometry;
}

export function scaleGeometryEntity(geometry: GeometryEntity, factor: number): GeometryEntity {
  if (Math.abs(factor - 1) < 0.000001) {
    return geometry;
  }

  if (geometry.kind === "polyline") {
    return {
      ...geometry,
      points: geometry.points.map((point) => scalePoint(point, factor))
    };
  }

  if (geometry.kind === "circle") {
    return {
      ...geometry,
      cx: geometry.cx * factor,
      cy: geometry.cy * factor,
      r: geometry.r * factor
    };
  }

  if (geometry.kind === "ellipse") {
    return {
      ...geometry,
      cx: geometry.cx * factor,
      cy: geometry.cy * factor,
      rx: geometry.rx * factor,
      ry: geometry.ry * factor,
      rotation: geometry.rotation
    };
  }

  if (geometry.kind === "ellipseArc") {
    return {
      ...geometry,
      cx: geometry.cx * factor,
      cy: geometry.cy * factor,
      rx: geometry.rx * factor,
      ry: geometry.ry * factor
    };
  }

  if (geometry.kind === "arc") {
    return {
      ...geometry,
      cx: geometry.cx * factor,
      cy: geometry.cy * factor,
      r: geometry.r * factor
    };
  }

  if (geometry.kind === "path") {
    return {
      kind: "polyline",
      points: samplePathPoints(geometry.d, {
        closed: geometry.closed,
        minSegments: geometry.closed ? 96 : 72,
        maxSegments: 960,
        segmentLength: 2.5
      }).map((point) => scalePoint(point, factor)),
      closed: geometry.closed
    };
  }

  return geometry;
}

export function getDxfUnitScaleFactor(insUnits: unknown) {
  const unitCode = Number(insUnits);
  switch (unitCode) {
    case 1:
      return 25.4;
    case 2:
      return 304.8;
    case 4:
      return 1;
    case 5:
      return 10;
    case 6:
      return 1000;
    case 14:
      return 100;
    case 15:
      return 10000;
    case 16:
      return 100000;
    case 17:
      return 1e6;
    case 18:
      return 149597870700000;
    case 19:
      return 9460730472580800;
    case 20:
      return 0.000001;
    case 21:
      return 0.001;
    case 22:
      return 1000000;
    case 0:
    default:
      return 1;
  }
}

function splineToGeometry(entity: ParsedDxfEntity): GeometryEntity | null {
  const fitPoints = (entity.fitPoints as Array<{ x: number; y: number }> | undefined)?.map((point) => ({
    x: point.x,
    y: -point.y
  }));
  const controlPoints = (entity.controlPoints as Array<{ x: number; y: number }> | undefined)?.map((point) => ({
    x: point.x,
    y: -point.y
  }));
  const points = fitPoints?.length ? fitPoints : controlPoints;

  if (!points?.length) {
    return null;
  }

  return {
    kind: "polyline",
    points,
    closed: Boolean(entity.closed)
  };
}

function bulgedPolylineToPath(
  vertices: Array<{ x: number; y: number; bulge?: number }>,
  closed: boolean
): GeometryEntity | null {
  if (!vertices.length) {
    return null;
  }

  const commands = [`M ${vertices[0].x} ${-vertices[0].y}`];
  const segmentCount = closed ? vertices.length : Math.max(vertices.length - 1, 0);

  for (let index = 0; index < segmentCount; index += 1) {
    const current = vertices[index];
    const next = vertices[(index + 1) % vertices.length];
    const bulge = Number(current.bulge ?? 0);

    if (!Number.isFinite(bulge) || Math.abs(bulge) < 0.000001) {
      commands.push(`L ${next.x} ${-next.y}`);
      continue;
    }

    const chord = Math.hypot(next.x - current.x, next.y - current.y);
    if (chord < 0.000001) {
      continue;
    }

    const theta = 4 * Math.atan(bulge);
    const radius = (chord * (1 + bulge * bulge)) / (4 * Math.abs(bulge));
    const largeArc = Math.abs(theta) > Math.PI ? 1 : 0;
    const sweep = bulge < 0 ? 1 : 0;
    commands.push(`A ${radius} ${radius} 0 ${largeArc} ${sweep} ${next.x} ${-next.y}`);
  }

  if (closed) {
    commands.push("Z");
  }

  return {
    kind: "path",
    d: commands.join(" "),
    closed
  };
}

function groupDxfGeometryItems(items: DxfGeometryItem[]) {
  const groups: DxfGeometryItem[][] = [];
  const visited = new Set<number>();

  for (let index = 0; index < items.length; index += 1) {
    if (visited.has(index)) {
      continue;
    }

    const group: DxfGeometryItem[] = [];
    const queue = [index];
    visited.add(index);

    while (queue.length) {
      const currentIndex = queue.shift()!;
      const current = items[currentIndex];
      group.push(current);

      for (let candidateIndex = 0; candidateIndex < items.length; candidateIndex += 1) {
        if (visited.has(candidateIndex)) {
          continue;
        }

        if (areItemsConnected(current, items[candidateIndex])) {
          visited.add(candidateIndex);
          queue.push(candidateIndex);
        }
      }
    }

    groups.push(group);
  }

  return groups;
}

function buildPiecesFromGeometryGroups(
  groups: DxfGeometryItem[][],
  sourceFile: string,
  probe: SVGSVGElement,
  partialWarnings = false
) {
  const pieces: PieceItem[] = [];
  const groupEntries = groups.map((group) => ({
    group,
    entities: dedupeGeometryEntities(mergeConnectedPolylines(group.map((item) => item.geometry)))
  }));
  const hasAnyClosedGroup = groupEntries.some((entry) => entry.entities.some(entityFormsClosedPiece));

  groupEntries.forEach(({ group, entities: groupEntities }, idx) => {
    const groupElement = document.createElementNS(SVG_NS, "g");
    const warnings: GeometryWarning[] = [];

    if (hasAnyClosedGroup && !groupEntities.some(entityFormsClosedPiece)) {
      return;
    }

    groupEntities.forEach((geometry) => {
      const element = appendSvgElementFromDxfEntity(geometry);
      if (element) {
        groupElement.appendChild(element);
      }
    });

    if (partialWarnings && group.some((item) => item.partial)) {
      warnings.push("partial-support");
    }

    if (!groupEntities.length || !groupElement.childNodes.length) {
      return;
    }

    probe.appendChild(groupElement);
    try {
      pieces.push(pieceFromSvgElement(groupElement, sourceFile, idx, groupEntities, warnings));
    } catch {
      pieces.push(createPiece(sourceFile, idx, ["invalid-shape"]));
    } finally {
      groupElement.remove();
    }
  });

  return pieces;
}

export function importSvgText(text: string, sourceFile: string): PieceItem[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, "image/svg+xml");
  const svgRoot = doc.documentElement;
  const allowed = ["path", "rect", "circle", "ellipse", "polygon", "polyline", "line"];
  const probe = createProbeSvg();
  const items: DxfGeometryItem[] = [];
  const importedRoot = document.importNode(svgRoot, true) as unknown as SVGSVGElement;
  probe.appendChild(importedRoot);

  try {
    Array.from(importedRoot.querySelectorAll(allowed.join(","))).forEach((node) => {
      items.push(...svgNodeToGeometryItems(node as SVGGraphicsElement));
    });
  } finally {
    importedRoot.remove();
  }

  const pieces = buildPiecesFromGeometryGroups(groupDxfGeometryItems(items), sourceFile, probe);
  probe.remove();
  return pieces;
}

export function dxfEntityToGeometry(entity: Record<string, unknown>): { geometry: GeometryEntity | null; partial: boolean } {
  const type = String(entity.type ?? "");

  if (type === "LINE") {
    const vertices = (entity.vertices as Array<{ x: number; y: number }>) ?? [];
    if (vertices.length >= 2) {
      return {
        geometry: {
          kind: "polyline",
          closed: false,
          points: vertices.slice(0, 2).map((vertex) => ({ x: vertex.x, y: -vertex.y }))
        },
        partial: false
      };
    }
  }

  if (type === "LWPOLYLINE" || type === "POLYLINE") {
    const vertices = (entity.vertices as Array<{ x: number; y: number; bulge?: number }>) ?? [];
    const closed = Boolean(entity.shape || entity.closed);
    const hasBulge = vertices.some((vertex) => Math.abs(Number(vertex.bulge ?? 0)) > 0.000001);
    if (hasBulge) {
      return {
        geometry: bulgedPolylineToPath(vertices, closed),
        partial: false
      };
    }

    return {
      geometry: {
        kind: "polyline",
        closed,
        points: vertices.map((vertex) => ({ x: vertex.x, y: -vertex.y }))
      },
      partial: false
    };
  }

  if (type === "CIRCLE") {
    const center = entity.center as { x: number; y: number } | undefined;
    return {
      geometry: {
        kind: "circle",
        cx: Number(center?.x ?? 0),
        cy: -Number(center?.y ?? 0),
        r: Number(entity.radius ?? 0)
      },
      partial: false
    };
  }

  if (type === "ARC") {
    const center = entity.center as { x: number; y: number } | undefined;
    return {
      geometry: {
        kind: "arc",
        cx: Number(center?.x ?? 0),
        cy: -Number(center?.y ?? 0),
        r: Number(entity.radius ?? 0),
        startAngle: Number(entity.startAngle ?? 0),
        endAngle: Number(entity.endAngle ?? 0)
      },
      partial: false
    };
  }

  if (type === "ELLIPSE") {
    const center = entity.center as { x: number; y: number } | undefined;
    const majorAxisEndPoint = entity.majorAxisEndPoint as { x: number; y: number } | undefined;
    const axisRatio = Number(entity.axisRatio ?? 1);
    const majorX = Number(majorAxisEndPoint?.x ?? 0);
    const majorY = -Number(majorAxisEndPoint?.y ?? 0);
    const rx = Math.hypot(majorX, majorY);
    const rotation = Math.atan2(majorY, majorX);
    const startAngle = Number(entity.startAngle ?? 0);
    const endAngle = Number(entity.endAngle ?? Math.PI * 2);
    const normalizedEnd = endAngle <= startAngle ? endAngle + Math.PI * 2 : endAngle;
    const isFullEllipse = Math.abs(normalizedEnd - startAngle - Math.PI * 2) < 0.0001 || Math.abs(normalizedEnd - startAngle) < 0.0001;

    if (!isFullEllipse) {
      return {
        geometry: {
          kind: "ellipseArc",
          cx: Number(center?.x ?? 0),
          cy: -Number(center?.y ?? 0),
          rx,
          ry: rx * axisRatio,
          rotation,
          startAngle,
          endAngle: normalizedEnd
        },
        partial: false
      };
    }

    return {
      geometry: {
        kind: "ellipse",
        cx: Number(center?.x ?? 0),
        cy: -Number(center?.y ?? 0),
        rx,
        ry: rx * axisRatio,
        rotation
      },
      partial: false
    };
  }

  if (type === "SPLINE") {
    return {
      geometry: splineToGeometry(entity),
      partial: true
    };
  }

  return { geometry: null, partial: true };
}

export function flattenDxfEntities(
  entities: ParsedDxfEntity[],
  blocks: Record<string, { entities?: ParsedDxfEntity[] }> = {},
  inheritedPartial = false
): Array<{ geometry: GeometryEntity; partial: boolean }> {
  const flattened: Array<{ geometry: GeometryEntity; partial: boolean }> = [];

  entities.forEach((entity) => {
    const type = String(entity.type ?? "");
    if (type === "INSERT") {
      const blockName = String(entity.name ?? "");
      const block = blocks[blockName];
      if (!block?.entities?.length) {
        return;
      }

      const position = entity.position as { x: number; y: number } | undefined;
      const insertion = {
        x: Number(position?.x ?? 0),
        y: -Number(position?.y ?? 0)
      };
      const scaleX = Number(entity.xScale ?? 1);
      const scaleY = Number(entity.yScale ?? 1);
      const rotation = Number(entity.rotation ?? 0);
      const nested = flattenDxfEntities(block.entities, blocks, true);

      nested.forEach((item) => {
        flattened.push({
          geometry: transformGeometryEntity(item.geometry, insertion, scaleX, scaleY, rotation),
          partial: true
        });
      });
      return;
    }

    const converted = dxfEntityToGeometry(entity);
    if (converted.geometry) {
      flattened.push({
        geometry: converted.geometry,
        partial: inheritedPartial || converted.partial
      });
    }
  });

  return flattened;
}

export function importDxfText(text: string, sourceFile: string): PieceItem[] {
  const parser = new DxfParser();
  const parsed = parser.parseSync(text);
  const dxfUnitScale = getDxfUnitScaleFactor((parsed?.header as Record<string, unknown> | undefined)?.$INSUNITS);
  const probe = createProbeSvg();
  const pieces: PieceItem[] = [];
  const items = flattenDxfEntities(
    ((parsed?.entities ?? []) as unknown as ParsedDxfEntity[]),
    (parsed?.blocks ?? {}) as unknown as Record<string, { entities?: ParsedDxfEntity[] }>
  ).map((item) => {
      const geometry = scaleGeometryEntity(item.geometry, dxfUnitScale);
      return {
        geometry,
        partial: item.partial,
        bounds: boundsFromGeometry(geometry),
        endpoints: endpointsFromGeometry(geometry)
      };
    });

  const groups = groupDxfGeometryItems(items);
  const groupEntries = groups.map((group) => ({
    group,
    entities: dedupeGeometryEntities(mergeConnectedPolylines(group.map((item) => item.geometry)))
  }));
  const hasAnyClosedGroup = groupEntries.some((entry) => entry.entities.some(entityFormsClosedPiece));

  groupEntries.forEach(({ group, entities: groupEntities }, idx) => {
    const groupElement = document.createElementNS(SVG_NS, "g");
    const warnings: GeometryWarning[] = [];

    if (hasAnyClosedGroup && !groupEntities.some(entityFormsClosedPiece)) {
      return;
    }

    groupEntities.forEach((geometry) => {
      const element = appendSvgElementFromDxfEntity(geometry);
      if (!element) {
        return;
      }

      groupElement.appendChild(element);
    });

    if (group.some((item) => item.partial)) {
      warnings.push("partial-support");
    }

    if (!groupEntities.length) {
      return;
    }

    probe.appendChild(groupElement);
    try {
      pieces.push(
        pieceFromSvgElement(
          groupElement,
          sourceFile,
          idx,
          groupEntities,
          warnings
        )
      );
    } catch {
      pieces.push(createPiece(sourceFile, idx, ["invalid-shape"]));
    } finally {
      groupElement.remove();
    }
  });

  probe.remove();
  return pieces;
}

export async function importFiles(files: File[]) {
  const pieces: PieceItem[] = [];
  const messages: string[] = [];

  for (const file of files) {
    const ext = file.name.split(".").pop()?.toLowerCase();

    if (ext === "svg") {
      const text = await readFileAsText(file);
      const parsed = importSvgText(text, file.name);
      pieces.push(...parsed);
      messages.push(parsed.length ? "Archivo cargado correctamente." : "No se detectaron piezas cerradas.");
      continue;
    }

    if (ext === "dxf") {
      const text = await readFileAsText(file);
      const parsed = importDxfText(text, file.name);
      pieces.push(...parsed);
      messages.push(parsed.length ? "Archivo cargado correctamente." : "El archivo no contiene geometrias validas.");
      continue;
    }

    if (ext === "dwg") {
      try {
        const svg = await convertDwgToSvg(await file.arrayBuffer());
        const parsed = importSvgText(svg, file.name);
        pieces.push(...parsed);
        messages.push(
          parsed.length
            ? "Archivo DWG cargado correctamente."
            : "El DWG se abrio, pero no se detectaron piezas utilizables."
        );
      } catch {
        messages.push(
          "No fue posible abrir este DWG. Intenta guardarlo como DXF si el archivo usa objetos no compatibles."
        );
      }
      continue;
    }

    messages.push("Formato no compatible.");
  }

  return { pieces, messages };
}
