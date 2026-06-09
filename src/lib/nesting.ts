import type { NestingConfig, NestingResult, PieceItem, Placement } from "../types";
import { wait } from "./utils";

interface ExpandedPiece {
  pieceId: string;
  width: number;
  height: number;
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

function rotateBox(width: number, height: number, degrees: number) {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.abs(Math.cos(radians));
  const sin = Math.abs(Math.sin(radians));
  return {
    width: width * cos + height * sin,
    height: width * sin + height * cos
  };
}

function expandPieces(pieces: PieceItem[], config: NestingConfig) {
  const expanded: ExpandedPiece[] = [];
  const spacing = config.pieceGap + config.kerf;

  pieces
    .filter((piece) => piece.enabled)
    .forEach((piece) => {
      for (let idx = 0; idx < piece.quantity; idx += 1) {
        expanded.push({
          pieceId: piece.id,
          width: piece.geometry.width + spacing,
          height: piece.geometry.height + spacing
        });
      }
    });

  return expanded.sort((a, b) =>
    config.prioritizeLarge ? b.width * b.height - a.width * a.height : 0
  );
}

export async function runNesting(
  pieces: PieceItem[],
  material: { width: number; height: number; sheetCount: number },
  config: NestingConfig,
  onProgress?: (message: string, value: number) => void
) {
  const startedAt = performance.now();
  const expanded = expandPieces(pieces, config);
  const placements: Placement[] = [];
  const unplaced: string[] = [];
  const sheetStates = Array.from({ length: material.sheetCount }).map(() => ({
    cursorX: config.edgeGap,
    cursorY: config.edgeGap,
    rowHeight: 0
  }));
  const angles = config.keepOrientation ? [0] : rotationAngles(config);

  const statusMessages = [
    "Analizando piezas.",
    "Calculando rotaciones.",
    "Optimizando acomodo.",
    "Verificando márgenes.",
    "Generando archivo final."
  ];

  for (let i = 0; i < statusMessages.length; i += 1) {
    onProgress?.(statusMessages[i], (i + 1) / (statusMessages.length + 1));
    await wait(config.quality === "quality" ? 180 : 90);
  }

  expandedLoop: for (let index = 0; index < expanded.length; index += 1) {
    const item = expanded[index];

    for (let sheetIndex = 0; sheetIndex < sheetStates.length; sheetIndex += 1) {
      const sheet = sheetStates[sheetIndex];

      for (const angle of angles) {
        const box = rotateBox(item.width, item.height, angle);

        if (sheet.cursorX + box.width > material.width - config.edgeGap) {
          sheet.cursorX = config.edgeGap;
          sheet.cursorY += sheet.rowHeight;
          sheet.rowHeight = 0;
        }

        if (sheet.cursorY + box.height > material.height - config.edgeGap) {
          continue;
        }

        placements.push({
          pieceId: item.pieceId,
          sheetIndex,
          x: sheet.cursorX,
          y: sheet.cursorY,
          width: box.width,
          height: box.height,
          rotation: angle
        });
        sheet.cursorX += box.width;
        sheet.rowHeight = Math.max(sheet.rowHeight, box.height);
        continue expandedLoop;
      }
    }

    unplaced.push(item.pieceId);
  }

  const elapsedMs = performance.now() - startedAt;
  const usedSheets = placements.length ? Math.max(...placements.map((item) => item.sheetIndex)) + 1 : 0;
  const usedArea = placements.reduce((total, item) => total + item.width * item.height, 0);
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
    elapsedMs
  };

  onProgress?.("Resultado listo.", 1);
  return result;
}
