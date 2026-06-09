import DxfParser from "dxf-parser";
import { buildPieceGeometry } from "./geometry";
import { slugId } from "./utils";
import type { GeometryWarning, PieceItem } from "../types";

function createProbeSvg() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
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

function pieceFromSvgElement(el: SVGGraphicsElement, sourceFile: string, idx: number): PieceItem {
  const geometry = buildPieceGeometry(el);
  const warnings: GeometryWarning[] = [];

  if (!geometry.closed) {
    warnings.push("open-path");
  }

  if (geometry.width <= 0 || geometry.height <= 0) {
    warnings.push("invalid-shape");
  }

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

function importSvgText(text: string, sourceFile: string): PieceItem[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, "image/svg+xml");
  const svgRoot = doc.documentElement;
  const allowed = ["path", "rect", "circle", "ellipse", "polygon"];
  const probe = createProbeSvg();
  const pieces: PieceItem[] = [];

  Array.from(svgRoot.querySelectorAll(allowed.join(","))).forEach((node, idx) => {
    const imported = document.importNode(node, true) as SVGGraphicsElement;
    probe.appendChild(imported);
    try {
      pieces.push(pieceFromSvgElement(imported, sourceFile, idx));
    } catch {
      pieces.push({
        id: slugId("pieza"),
        name: `Pieza ${String(idx + 1).padStart(2, "0")}`,
        quantity: 1,
        enabled: true,
        sourceFile,
        warnings: ["invalid-shape"],
        geometry: {
          svgMarkup: new XMLSerializer().serializeToString(imported),
          width: 0,
          height: 0,
          area: 0,
          sourceBounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
          closed: false,
          hasCurves: false,
          hasHoles: false
        }
      });
    } finally {
      imported.remove();
    }
  });

  probe.remove();
  return pieces;
}

function entityToSvg(entity: Record<string, unknown>) {
  const type = String(entity.type ?? "");

  if (type === "LINE") {
    const vertices = entity.vertices as Array<{ x: number; y: number }>;
    return `<polyline fill="none" stroke="#111" stroke-width="1" points="${vertices
      .map((vertex) => `${vertex.x},${-vertex.y}`)
      .join(" ")}" />`;
  }

  if (type === "LWPOLYLINE" || type === "POLYLINE") {
    const vertices = (entity.vertices as Array<{ x: number; y: number }>) ?? [];
    const closed = Boolean(entity.shape || entity.closed);
    const tag = closed ? "polygon" : "polyline";
    return `<${tag} fill="none" stroke="#111" stroke-width="1" points="${vertices
      .map((vertex) => `${vertex.x},${-vertex.y}`)
      .join(" ")}" />`;
  }

  if (type === "CIRCLE") {
    const center = entity.center as { x: number; y: number } | undefined;
    return `<circle cx="${center?.x ?? 0}" cy="${-Number(center?.y ?? 0)}" r="${entity.radius}" fill="none" stroke="#111" stroke-width="1" />`;
  }

  if (type === "ARC") {
    const center = entity.center as { x: number; y: number } | undefined;
    const centerX = Number(center?.x ?? 0);
    const centerY = -Number(center?.y ?? 0);
    const radius = Number(entity.radius ?? 0);
    const startAngle = Number(entity.startAngle ?? 0);
    const endAngle = Number(entity.endAngle ?? 0);
    const x1 = centerX + radius * Math.cos(startAngle);
    const y1 = centerY - radius * Math.sin(startAngle);
    const x2 = centerX + radius * Math.cos(endAngle);
    const y2 = centerY - radius * Math.sin(endAngle);
    const largeArc = Math.abs(endAngle - startAngle) > Math.PI ? 1 : 0;
    return `<path d="M ${x1} ${y1} A ${radius} ${radius} 0 ${largeArc} 0 ${x2} ${y2}" fill="none" stroke="#111" stroke-width="1" />`;
  }

  return null;
}

function importDxfText(text: string, sourceFile: string): PieceItem[] {
  const parser = new DxfParser();
  const parsed = parser.parseSync(text);
  const fragments = ((parsed?.entities ?? []) as unknown as Array<Record<string, unknown>>)
    .map((entity) => entityToSvg(entity))
    .filter(Boolean) as string[];

  if (!fragments.length) {
    return [];
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg">${fragments.join("")}</svg>`;
  return importSvgText(svg, sourceFile).map((piece) => ({
    ...piece,
    warnings: piece.warnings.includes("invalid-shape")
      ? piece.warnings
      : [...piece.warnings, "partial-support"]
  }));
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
      messages.push(parsed.length ? "Archivo cargado correctamente." : "El archivo no contiene geometrías válidas.");
      continue;
    }

    if (ext === "dwg") {
      messages.push(
        "DWG no se abre directo en esta versión porque es un formato binario propietario. Convierte el archivo a DXF para importarlo aquí."
      );
      continue;
    }

    messages.push("Formato no compatible.");
  }

  return { pieces, messages };
}
