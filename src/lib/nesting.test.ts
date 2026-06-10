import { describe, expect, it } from "vitest";
import { runNesting } from "./nesting";
import type { PieceItem } from "../types";

describe("contour-based nesting", () => {
  it("does not stack identical rectangles on top of each other", async () => {
    const rectangle = {
      svgMarkup: "",
      width: 40,
      height: 30,
      area: 1200,
      sourceBounds: { minX: 0, minY: 0, maxX: 40, maxY: 30 },
      closed: true,
      hasCurves: false,
      hasHoles: false,
      entities: [
        {
          kind: "polyline" as const,
          closed: true,
          points: [
            { x: 0, y: 0 },
            { x: 40, y: 0 },
            { x: 40, y: 30 },
            { x: 0, y: 30 }
          ]
        }
      ]
    };

    const pieces: PieceItem[] = [
      {
        id: "rect-a",
        name: "Rect A",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.svg",
        warnings: [],
        geometry: rectangle
      },
      {
        id: "rect-b",
        name: "Rect B",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.svg",
        warnings: [],
        geometry: rectangle
      }
    ];

    const result = await runNesting(
      pieces,
      { width: 120, height: 80, sheetCount: 1 },
      {
        pieceGap: 2,
        edgeGap: 2,
        kerf: 0,
        rotations: "orthogonal",
        quality: "fast",
        maxTimeMs: 10000,
        keepOrientation: false,
        prioritizeLarge: true
      }
    );

    expect(result.unplaced).toHaveLength(0);
    expect(result.placements).toHaveLength(2);
    expect(result.placements[0].x === result.placements[1].x && result.placements[0].y === result.placements[1].y).toBe(
      false
    );
  });

  it("places polyline contour pieces without falling back to invalid overlap", async () => {
    const pieces: PieceItem[] = [
      {
        id: "tri-1",
        name: "Triangulo A",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.svg",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 40,
          height: 40,
          area: 800,
          sourceBounds: { minX: 0, minY: 0, maxX: 40, maxY: 40 },
          closed: true,
          hasCurves: false,
          hasHoles: false,
          entities: [
            {
              kind: "polyline",
              closed: true,
              points: [
                { x: 0, y: 40 },
                { x: 20, y: 0 },
                { x: 40, y: 40 }
              ]
            }
          ]
        }
      },
      {
        id: "tri-2",
        name: "Triangulo B",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.svg",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 40,
          height: 40,
          area: 800,
          sourceBounds: { minX: 0, minY: 0, maxX: 40, maxY: 40 },
          closed: true,
          hasCurves: false,
          hasHoles: false,
          entities: [
            {
              kind: "polyline",
              closed: true,
              points: [
                { x: 0, y: 0 },
                { x: 20, y: 40 },
                { x: 40, y: 0 }
              ]
            }
          ]
        }
      }
    ];

    const result = await runNesting(
      pieces,
      { width: 120, height: 60, sheetCount: 1 },
      {
        pieceGap: 2,
        edgeGap: 2,
        kerf: 0,
        rotations: "orthogonal",
        quality: "fast",
        maxTimeMs: 10000,
        keepOrientation: false,
        prioritizeLarge: true
      }
    );

    expect(result.unplaced).toHaveLength(0);
    expect(result.placements).toHaveLength(2);
    expect(result.usedSheets).toBe(1);
    expect(result.utilization).toBeGreaterThan(0);
  });
});
