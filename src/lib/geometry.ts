import type { GeometryEntity, GeometryPoint, PieceGeometry } from "../types";

const SVG_NS = "http://www.w3.org/2000/svg";

function round(n: number) {
  return Math.round(n * 1000) / 1000;
}

function shiftPoint(point: GeometryPoint, offsetX: number, offsetY: number): GeometryPoint {
  return {
    x: round(point.x - offsetX),
    y: round(point.y - offsetY)
  };
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

function sampleEllipse(cx: number, cy: number, rx: number, ry: number, segments: number) {
  const points: GeometryPoint[] = [];
  for (let index = 0; index < segments; index += 1) {
    const angle = (Math.PI * 2 * index) / segments;
    points.push({
      x: cx + rx * Math.cos(angle),
      y: cy + ry * Math.sin(angle)
    });
  }
  return points;
}

function sampleRotatedEllipse(
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  rotation: number,
  segments: number
) {
  const points: GeometryPoint[] = [];
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  for (let index = 0; index < segments; index += 1) {
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

function sampleArc(entity: Extract<GeometryEntity, { kind: "arc" }>, segments = 72) {
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

function sampleEllipseArc(entity: Extract<GeometryEntity, { kind: "ellipseArc" }>, segments = 72) {
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

function samplePath(pathData: string, offsetX: number, offsetY: number, closed: boolean) {
  const probe = createProbeSvg();
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", pathData);
  path.setAttribute("transform", `translate(${-offsetX} ${-offsetY})`);
  probe.appendChild(path);

  const length = path.getTotalLength();
  const segments = Math.max(36, Math.min(900, Math.ceil(length / 2.5)));
  const points: GeometryPoint[] = [];

  for (let index = 0; index <= segments; index += 1) {
    const point = path.getPointAtLength((length * index) / segments);
    points.push({ x: point.x, y: point.y });
  }

  probe.remove();
  return closed ? points.slice(0, -1) : points;
}

function pointToken(point: GeometryPoint) {
  return `${round(point.x).toFixed(3)},${round(point.y).toFixed(3)}`;
}

function sampleEntitySignaturePoints(entity: GeometryEntity, bounds: PieceGeometry["sourceBounds"]) {
  switch (entity.kind) {
    case "polyline":
      return entity.points;
    case "circle":
      return sampleEllipse(entity.cx, entity.cy, entity.r, entity.r, 24);
    case "ellipse":
      return sampleRotatedEllipse(entity.cx, entity.cy, entity.rx, entity.ry, entity.rotation, 24);
    case "ellipseArc":
      return sampleEllipseArc(entity, 24);
    case "arc":
      return sampleArc(entity, 24);
    case "path":
      return samplePath(entity.d, bounds.minX, bounds.minY, entity.closed);
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

        const points = samplePath(subpath, bounds.minX, bounds.minY, true);
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

  if (tag === "path") {
    const d = element.getAttribute("d") ?? "";
    return [{ kind: "path", d, closed: /z/i.test(d) }];
  }

  return [];
}

function normalizeEntity(entity: GeometryEntity, offsetX: number, offsetY: number): GeometryEntity {
  switch (entity.kind) {
    case "polyline":
      return {
        ...entity,
        points: entity.points.map((point) => shiftPoint(point, offsetX, offsetY))
      };
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
  const bounds = getElementBounds(element);
  const markup = new XMLSerializer().serializeToString(element);
  const tag = element.tagName.toLowerCase();
  const rawEntities = sourceEntities?.length ? sourceEntities : entitiesFromSvgElement(element);
  const closed =
    rawEntities.length > 0
      ? rawEntities.every((entity) =>
          entity.kind === "path" ? entity.closed : entity.kind !== "arc" && entity.kind !== "ellipseArc"
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
  const approxArea = rawEntities.reduce(
    (sum, entity) => sum + approximateEntityArea(entity, bounds),
    0
  );

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
    hasHoles:
      rawEntities.filter((entity) => entity.kind === "circle" || entity.kind === "ellipse").length > 1 ||
      rawEntities.filter((entity) => entity.kind === "polyline" && entity.closed).length > 1 ||
      (tag === "path" && ((element.getAttribute("d") ?? "").match(/z/gi)?.length ?? 0) > 1),
    entities: rawEntities.map((entity) => normalizeEntity(entity, bounds.minX, bounds.minY))
  };
}
