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

export async function downloadPdf(
  pieces: PieceItem[],
  material: MaterialConfig,
  result: NestingResult
) {
  const doc = new jsPDF({
    orientation: material.width >= material.height ? "landscape" : "portrait",
    unit: "mm",
    format: [Math.max(material.width, 210), Math.max(material.height, 148)]
  });

  doc.setFontSize(16);
  doc.text("Resultado de nesting", 12, 16);
  doc.setFontSize(10);
  doc.text(`Material: ${material.name}`, 12, 24);
  doc.text(`Placas usadas: ${result.usedSheets}`, 12, 30);
  doc.text(`Aprovechamiento: ${result.utilization.toFixed(1)}%`, 12, 36);

  const pageWidth = doc.internal.pageSize.getWidth() - 24;
  const pageHeight = doc.internal.pageSize.getHeight() - 54;
  const scale = Math.min(pageWidth / material.width, pageHeight / material.height);

  result.placements
    .filter((placement) => placement.sheetIndex === 0)
    .forEach((placement) => {
      const piece = findPiece(pieces, placement.pieceId);
      if (!piece) {
        return;
      }

      const x = 12 + placement.x * scale;
      const y = 44 + placement.y * scale;
      doc.setDrawColor(47, 133, 90);
      doc.setFillColor(214, 237, 222);
      doc.roundedRect(x, y, piece.geometry.width * scale, piece.geometry.height * scale, 2, 2, "FD");
      doc.setTextColor(29, 42, 34);
      doc.text(piece.name, x + 2, y + 5);
    });

  doc.save("nesting-resultado.pdf");
}
