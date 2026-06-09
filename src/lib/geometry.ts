import type { PieceGeometry } from "../types";

function round(n: number) {
  return Math.round(n * 1000) / 1000;
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

export function buildPieceGeometry(element: SVGGraphicsElement): PieceGeometry {
  const bounds = getElementBounds(element);
  const markup = new XMLSerializer().serializeToString(element);
  const tag = element.tagName.toLowerCase();
  const closed = isClosedShape(element);
  const hasCurves =
    tag === "circle" ||
    tag === "ellipse" ||
    (tag === "path" && /[CQASTcqast]/.test(element.getAttribute("d") ?? ""));

  return {
    svgMarkup: markup,
    width: bounds.width,
    height: bounds.height,
    area: round(bounds.width * bounds.height),
    sourceBounds: {
      minX: bounds.minX,
      minY: bounds.minY,
      maxX: bounds.maxX,
      maxY: bounds.maxY
    },
    closed,
    hasCurves,
    hasHoles: tag === "path" && ((element.getAttribute("d") ?? "").match(/z/gi)?.length ?? 0) > 1
  };
}

export function normalizeSvgMarkup(markup: string, bounds: PieceGeometry["sourceBounds"]) {
  return `<g transform="translate(${-bounds.minX} ${-bounds.minY})">${markup}</g>`;
}
