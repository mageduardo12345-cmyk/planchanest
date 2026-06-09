import { jsPDF } from "jspdf";
import type { MaterialConfig, NestingResult, PieceItem } from "../types";
import { normalizeSvgMarkup } from "./geometry";

function findPiece(pieces: PieceItem[], pieceId: string) {
  return pieces.find((piece) => piece.id === pieceId);
}

export function buildResultSvg(
  pieces: PieceItem[],
  material: MaterialConfig,
  result: NestingResult
) {
  const sheets = Array.from({ length: result.usedSheets || 1 }).map((_, sheetIndex) => {
    const placements = result.placements.filter((placement) => placement.sheetIndex === sheetIndex);
    return `
      <g transform="translate(${sheetIndex * (material.width + 40)} 0)">
        <rect x="0" y="0" width="${material.width}" height="${material.height}" fill="#f7faf6" stroke="#7c8d81" stroke-width="2" rx="8" />
        ${placements
          .map((placement) => {
            const piece = findPiece(pieces, placement.pieceId);
            if (!piece) {
              return "";
            }

            const markup = normalizeSvgMarkup(piece.geometry.svgMarkup, piece.geometry.sourceBounds);
            return `
              <g transform="translate(${placement.x} ${placement.y}) rotate(${placement.rotation})">
                <rect x="0" y="0" width="${piece.geometry.width}" height="${piece.geometry.height}" fill="rgba(47,133,90,0.08)" stroke="rgba(47,133,90,0.24)" stroke-dasharray="4 4" />
                ${markup}
              </g>
            `;
          })
          .join("")}
      </g>
    `;
  });

  const width = (result.usedSheets || 1) * (material.width + 40);
  const height = material.height + 20;

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="#eef2ea" />
    <g transform="translate(10 10)">
      ${sheets.join("")}
    </g>
  </svg>`;
}

export function downloadSvg(
  pieces: PieceItem[],
  material: MaterialConfig,
  result: NestingResult
) {
  const svg = buildResultSvg(pieces, material, result);
  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "nesting-resultado.svg";
  link.click();
  URL.revokeObjectURL(url);
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

export async function downloadPdf(
  pieces: PieceItem[],
  material: MaterialConfig,
  result: NestingResult
) {
  const sceneWidth = (result.usedSheets || 1) * (material.width + 40);
  const sceneHeight = material.height + 20;
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

  context.fillStyle = "#eef2ea";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, 0, 0, canvas.width, canvas.height);

  const doc = new jsPDF({
    orientation: sceneWidth >= sceneHeight ? "landscape" : "portrait",
    unit: "mm",
    format: [sceneWidth, sceneHeight]
  });

  doc.addImage(canvas.toDataURL("image/png"), "PNG", 0, 0, sceneWidth, sceneHeight);
  doc.save("nesting-resultado.pdf");
}
