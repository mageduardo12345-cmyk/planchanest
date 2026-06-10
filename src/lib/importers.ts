import DxfParser from "dxf-parser";
import { buildPieceGeometry } from "./geometry";
import { convertDwgToSvg } from "./dwg";
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

function importSvgText(text: string, sourceFile: string): PieceItem[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, "image/svg+xml");
  const svgRoot = doc.documentElement;
  const allowed = ["path", "rect", "circle", "ellipse", "polygon", "polyline"];
  const probe = createProbeSvg();
  const pieces: PieceItem[] = [];

  Array.from(svgRoot.querySelectorAll(allowed.join(","))).forEach((node, idx) => {
    const imported = document.importNode(node, true) as SVGGraphicsElement;
    probe.appendChild(imported);
    try {
      pieces.push(pieceFromSvgElement(imported, sourceFile, idx));
    } catch {
      pieces.push(createPiece(sourceFile, idx, ["invalid-shape"]));
    } finally {
      imported.remove();
    }
  });

  probe.remove();
  return pieces;
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
      const points = sampleEllipseArcGeometryPoints(
        entity.cx,
        entity.cy,
        entity.rx,
        entity.ry,
        entity.rotation,
        entity.startAngle,
        entity.endAngle,
        96
      );
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

function createEntityBounds(points: Array<{ x: number; y: number }>): EntityBounds {
  return {
    minX: Math.min(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxX: Math.max(...points.map((point) => point.x)),
    maxY: Math.max(...points.map((point) => point.y))
  };
}

function sampleArcPoints(entity: Extract<GeometryEntity, { kind: "arc" }>, segments = 24) {
  const points: Array<{ x: number; y: number }> = [];
  let sweep = entity.endAngle - entity.startAngle;
  while (sweep <= 0) {
    sweep += Math.PI * 2;
  }

  for (let index = 0; index <= segments; index += 1) {
    const angle = entity.startAngle + sweep * (index / segments);
    points.push({
      x: entity.cx + entity.r * Math.cos(angle),
      y: entity.cy - entity.r * Math.sin(angle)
    });
  }

  return points;
}

function sampleEllipseArcGeometryPoints(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rotation: number,
  startAngle: number,
  endAngle: number,
  segments = 72
) {
  let sweep = endAngle - startAngle;
  while (sweep <= 0) {
    sweep += Math.PI * 2;
  }

  const points: Array<{ x: number; y: number }> = [];
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  for (let index = 0; index <= segments; index += 1) {
    const angle = startAngle + sweep * (index / segments);
    const localX = rx * Math.cos(angle);
    const localY = ry * Math.sin(angle);
    points.push({
      x: cx + localX * cos - localY * sin,
      y: cy + localX * sin + localY * cos
    });
  }
  return points;
}

function sampleEllipseGeometryPoints(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rotation = 0,
  segments = 96
) {
  const points: Array<{ x: number; y: number }> = [];
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

function samplePathGeometryPoints(pathData: string, segments = 72) {
  const probe = createProbeSvg();
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", pathData);
  probe.appendChild(path);

  const length = path.getTotalLength();
  const stepCount = Math.max(segments, Math.min(960, Math.ceil(length / 2.5)));
  const points: Array<{ x: number; y: number }> = [];

  for (let index = 0; index <= stepCount; index += 1) {
    const point = path.getPointAtLength((length * index) / stepCount);
    points.push({ x: point.x, y: point.y });
  }

  probe.remove();
  return points;
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
        sampleEllipseGeometryPoints(
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
        sampleEllipseArcGeometryPoints(
          geometry.cx,
          geometry.cy,
          geometry.rx,
          geometry.ry,
          geometry.rotation,
          geometry.startAngle,
          geometry.endAngle,
          48
        )
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
    const points = sampleEllipseArcGeometryPoints(
      geometry.cx,
      geometry.cy,
      geometry.rx,
      geometry.ry,
      geometry.rotation,
      geometry.startAngle,
      geometry.endAngle,
      2
    );
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

function areItemsConnected(a: DxfGeometryItem, b: DxfGeometryItem) {
  if (boundsContain(a.bounds, b.bounds) || boundsContain(b.bounds, a.bounds)) {
    return true;
  }

  if (boundsOverlap(a.bounds, b.bounds)) {
    return true;
  }

  const endpointDistances = [
    distance(a.endpoints.start, b.endpoints.start),
    distance(a.endpoints.start, b.endpoints.end),
    distance(a.endpoints.end, b.endpoints.start),
    distance(a.endpoints.end, b.endpoints.end)
  ];

  return endpointDistances.some((value) => value <= GROUP_TOLERANCE);
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

    const sampled = sampleEllipseGeometryPoints(
      geometry.cx,
      geometry.cy,
      geometry.rx,
      geometry.ry,
      geometry.rotation,
      96
    ).map((point) => transformPoint(point, position, scaleX, scaleY, rotation));

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

    const sampled = sampleEllipseArcGeometryPoints(
      geometry.cx,
      geometry.cy,
      geometry.rx,
      geometry.ry,
      geometry.rotation,
      geometry.startAngle,
      geometry.endAngle,
      96
    ).map((point) => transformPoint(point, position, scaleX, scaleY, rotation));

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
    const sampled = samplePathGeometryPoints(geometry.d, geometry.closed ? 96 : 72).map((point) =>
      transformPoint(point, position, scaleX, scaleY, rotation)
    );
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
      points: samplePathGeometryPoints(geometry.d, geometry.closed ? 96 : 72).map((point) =>
        scalePoint(point, factor)
      ),
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

  groupDxfGeometryItems(items).forEach((group, idx) => {
    const groupElement = document.createElementNS(SVG_NS, "g");
    const groupEntities: GeometryEntity[] = [];
    const warnings: GeometryWarning[] = [];

    group.forEach((item) => {
      const element = appendSvgElementFromDxfEntity(item.geometry);
      if (!element) {
        return;
      }

      if (item.partial) {
        warnings.push("partial-support");
      }

      groupElement.appendChild(element);
      groupEntities.push(item.geometry);
    });

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
