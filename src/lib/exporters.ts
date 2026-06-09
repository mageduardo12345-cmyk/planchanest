import { jsPDF } from "jspdf";
import type { MaterialConfig, NestingResult, PieceItem } from "../types";

type Matrix = {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
};

type Point = {
  x: number;
  y: number;
};

const SVG_NS = "http://www.w3.org/2000/svg";

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

function applyMatrix(matrix: Matrix, point: Point): Point {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f
  };
}

function parseTransform(transformText: string | null): Matrix {
  if (!transformText?.trim()) {
    return translateMatrix(0, 0);
  }

  const commands = transformText.match(/[a-zA-Z]+\([^)]+\)/g) ?? [];
  return commands.reduce((current, command) => {
    const openIndex = command.indexOf("(");
    const name = command.slice(0, openIndex).trim();
    const values = command
      .slice(openIndex + 1, -1)
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);

    if (name === "translate") {
      return multiplyMatrices(current, translateMatrix(values[0] ?? 0, values[1] ?? 0));
    }

    if (name === "rotate") {
      const angle = values[0] ?? 0;
      const cx = values[1] ?? 0;
      const cy = values[2] ?? 0;
      return multiplyMatrices(
        current,
        multiplyMatrices(
          translateMatrix(cx, cy),
          multiplyMatrices(rotateMatrix(angle), translateMatrix(-cx, -cy))
        )
      );
    }

    if (name === "scale") {
      const sx = values[0] ?? 1;
      const sy = values[1] ?? sx;
      return multiplyMatrices(current, { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 });
    }

    if (name === "matrix" && values.length === 6) {
      return multiplyMatrices(current, {
        a: values[0],
        b: values[1],
        c: values[2],
        d: values[3],
        e: values[4],
        f: values[5]
      });
    }

    return current;
  }, translateMatrix(0, 0));
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

export function buildResultSvg(pieces: PieceItem[], material: MaterialConfig, result: NestingResult) {
  const { sceneWidth, sceneHeight, usedSheets } = getSceneMetrics(material, result);

  const sheets = Array.from({ length: usedSheets }).map((_, sheetIndex) => {
    const placements = result.placements.filter((placement) => placement.sheetIndex === sheetIndex);
    const sheetOffsetX = getSheetOffset(material, sheetIndex);

    return placements
      .map((placement) => {
        const piece = findPiece(pieces, placement.pieceId);
        if (!piece) {
          return "";
        }

        return `
          <g transform="translate(${sheetOffsetX + placement.x} ${placement.y}) rotate(${placement.rotation})">
            <g transform="translate(${-piece.geometry.sourceBounds.minX} ${-piece.geometry.sourceBounds.minY})">
              ${piece.geometry.svgMarkup}
            </g>
          </g>
        `;
      })
      .join("");
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${sceneWidth} ${sceneHeight}">
    ${sheets.join("")}
  </svg>`;
}

export function downloadSvg(pieces: PieceItem[], material: MaterialConfig, result: NestingResult) {
  createDownload("nesting-resultado.svg", buildResultSvg(pieces, material, result), "image/svg+xml;charset=utf-8");
}

function loadSvgImage(svg: string) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };

    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("No fue posible renderizar el SVG para el PDF."));
    };

    image.src = url;
  });
}

export async function downloadPdf(pieces: PieceItem[], material: MaterialConfig, result: NestingResult) {
  const { sceneWidth, sceneHeight } = getSceneMetrics(material, result);
  const svg = buildResultSvg(pieces, material, result);
  const image = await loadSvgImage(svg);
  const canvas = document.createElement("canvas");
  const scaleFactor = 2;

  canvas.width = Math.max(Math.round(sceneWidth * scaleFactor), 1);
  canvas.height = Math.max(Math.round(sceneHeight * scaleFactor), 1);

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("No fue posible preparar el PDF.");
  }

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const doc = new jsPDF({
    orientation: sceneWidth >= sceneHeight ? "landscape" : "portrait",
    unit: "mm",
    format: [sceneWidth, sceneHeight]
  });

  doc.addImage(canvas.toDataURL("image/png"), "PNG", 0, 0, sceneWidth, sceneHeight);
  doc.save("nesting-resultado.pdf");
}

function dxfPair(code: number | string, value: number | string) {
  return `${code}\n${value}\n`;
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

function splitPathSubpaths(pathData: string) {
  return pathData.match(/[Mm][^Mm]*/g) ?? [];
}

function samplePathPoints(pathData: string) {
  const probe = createProbeSvg();
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", pathData);
  probe.appendChild(path);

  const length = path.getTotalLength();
  const segments = Math.max(24, Math.min(720, Math.ceil(length / 4)));
  const points: Point[] = [];

  for (let index = 0; index <= segments; index += 1) {
    const point = path.getPointAtLength((length * index) / segments);
    points.push({ x: point.x, y: point.y });
  }

  probe.remove();
  return points;
}

function toDxfY(sceneHeight: number, y: number) {
  return sceneHeight - y;
}

function buildPolylineEntity(points: Point[], closed: boolean, sceneHeight: number) {
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
    dxfPair(0, "LWPOLYLINE"),
    dxfPair(8, 0),
    dxfPair(90, uniquePoints.length),
    dxfPair(70, closed ? 1 : 0),
    uniquePoints
      .map((point) => `${dxfPair(10, point.x)}${dxfPair(20, toDxfY(sceneHeight, point.y))}`)
      .join("")
  ].join("");
}

function buildCircleEntity(center: Point, radius: number, sceneHeight: number) {
  return [
    dxfPair(0, "CIRCLE"),
    dxfPair(8, 0),
    dxfPair(10, center.x),
    dxfPair(20, toDxfY(sceneHeight, center.y)),
    dxfPair(30, 0),
    dxfPair(40, radius)
  ].join("");
}

function buildEllipseEntity(center: Point, majorAxisEnd: Point, ratio: number, sceneHeight: number) {
  return [
    dxfPair(0, "ELLIPSE"),
    dxfPair(8, 0),
    dxfPair(10, center.x),
    dxfPair(20, toDxfY(sceneHeight, center.y)),
    dxfPair(30, 0),
    dxfPair(11, majorAxisEnd.x - center.x),
    dxfPair(21, -(majorAxisEnd.y - center.y)),
    dxfPair(31, 0),
    dxfPair(40, ratio),
    dxfPair(41, 0),
    dxfPair(42, Math.PI * 2)
  ].join("");
}

function buildEntitiesFromElement(
  element: Element,
  currentMatrix: Matrix,
  sceneHeight: number,
  output: string[]
) {
  const nextMatrix = multiplyMatrices(currentMatrix, parseTransform(element.getAttribute("transform")));
  const tag = element.tagName.toLowerCase();

  if (tag === "g" || tag === "svg") {
    Array.from(element.children).forEach((child) => buildEntitiesFromElement(child, nextMatrix, sceneHeight, output));
    return;
  }

  if (tag === "rect") {
    const x = Number(element.getAttribute("x") ?? 0);
    const y = Number(element.getAttribute("y") ?? 0);
    const width = Number(element.getAttribute("width") ?? 0);
    const height = Number(element.getAttribute("height") ?? 0);
    const points = [
      applyMatrix(nextMatrix, { x, y }),
      applyMatrix(nextMatrix, { x: x + width, y }),
      applyMatrix(nextMatrix, { x: x + width, y: y + height }),
      applyMatrix(nextMatrix, { x, y: y + height })
    ];
    output.push(buildPolylineEntity(points, true, sceneHeight));
    return;
  }

  if (tag === "line") {
    const start = applyMatrix(nextMatrix, {
      x: Number(element.getAttribute("x1") ?? 0),
      y: Number(element.getAttribute("y1") ?? 0)
    });
    const end = applyMatrix(nextMatrix, {
      x: Number(element.getAttribute("x2") ?? 0),
      y: Number(element.getAttribute("y2") ?? 0)
    });
    output.push(
      [
        dxfPair(0, "LINE"),
        dxfPair(8, 0),
        dxfPair(10, start.x),
        dxfPair(20, toDxfY(sceneHeight, start.y)),
        dxfPair(30, 0),
        dxfPair(11, end.x),
        dxfPair(21, toDxfY(sceneHeight, end.y)),
        dxfPair(31, 0)
      ].join("")
    );
    return;
  }

  if (tag === "circle") {
    const center = applyMatrix(nextMatrix, {
      x: Number(element.getAttribute("cx") ?? 0),
      y: Number(element.getAttribute("cy") ?? 0)
    });
    const edge = applyMatrix(nextMatrix, {
      x: Number(element.getAttribute("cx") ?? 0) + Number(element.getAttribute("r") ?? 0),
      y: Number(element.getAttribute("cy") ?? 0)
    });
    const radius = Math.hypot(edge.x - center.x, edge.y - center.y);
    output.push(buildCircleEntity(center, radius, sceneHeight));
    return;
  }

  if (tag === "ellipse") {
    const cx = Number(element.getAttribute("cx") ?? 0);
    const cy = Number(element.getAttribute("cy") ?? 0);
    const rx = Number(element.getAttribute("rx") ?? 0);
    const ry = Number(element.getAttribute("ry") ?? 0);
    const center = applyMatrix(nextMatrix, { x: cx, y: cy });
    const majorAxisEnd = applyMatrix(nextMatrix, { x: cx + rx, y: cy });
    output.push(buildEllipseEntity(center, majorAxisEnd, rx === 0 ? 1 : ry / rx, sceneHeight));
    return;
  }

  if (tag === "polygon" || tag === "polyline") {
    const rawPoints = (element.getAttribute("points") ?? "")
      .trim()
      .split(/\s+/)
      .map((pair) => pair.split(",").map(Number))
      .filter((pair) => pair.length === 2 && pair.every((value) => Number.isFinite(value)))
      .map(([x, y]) => applyMatrix(nextMatrix, { x, y }));
    output.push(buildPolylineEntity(rawPoints, tag === "polygon", sceneHeight));
    return;
  }

  if (tag === "path") {
    const pathData = element.getAttribute("d") ?? "";
    splitPathSubpaths(pathData).forEach((subpath) => {
      const sampledPoints = samplePathPoints(subpath).map((point) => applyMatrix(nextMatrix, point));
      output.push(buildPolylineEntity(sampledPoints, /z/i.test(subpath), sceneHeight));
    });
  }
}

function buildResultDxf(pieces: PieceItem[], material: MaterialConfig, result: NestingResult) {
  const { sceneHeight } = getSceneMetrics(material, result);
  const entities: string[] = [];

  result.placements.forEach((placement) => {
    const piece = findPiece(pieces, placement.pieceId);
    if (!piece) {
      return;
    }

    const root = new DOMParser().parseFromString(
      `<svg xmlns="${SVG_NS}"><g transform="translate(${-piece.geometry.sourceBounds.minX} ${-piece.geometry.sourceBounds.minY})">${piece.geometry.svgMarkup}</g></svg>`,
      "image/svg+xml"
    );

    const placementMatrix = multiplyMatrices(
      translateMatrix(getSheetOffset(material, placement.sheetIndex) + placement.x, placement.y),
      rotateMatrix(placement.rotation)
    );

    Array.from(root.documentElement.children).forEach((child) =>
      buildEntitiesFromElement(child, placementMatrix, sceneHeight, entities)
    );
  });

  return [
    dxfPair(0, "SECTION"),
    dxfPair(2, "HEADER"),
    dxfPair(9, "$ACADVER"),
    dxfPair(1, "AC1015"),
    dxfPair(0, "ENDSEC"),
    dxfPair(0, "SECTION"),
    dxfPair(2, "ENTITIES"),
    entities.join(""),
    dxfPair(0, "ENDSEC"),
    dxfPair(0, "EOF")
  ].join("");
}

export function downloadDxf(pieces: PieceItem[], material: MaterialConfig, result: NestingResult) {
  createDownload("nesting-resultado.dxf", buildResultDxf(pieces, material, result), "application/dxf");
}
