import { describe, expect, it } from "vitest";
import { limitCandidateAxis, preparePiecesForNesting, runNesting, runPreparedNesting } from "./nesting";
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

  it("ignores stray open contours outside the closed silhouette during nesting", async () => {
    const noisySquare = {
      svgMarkup: "",
      width: 32,
      height: 28,
      area: 400,
      sourceBounds: { minX: -12, minY: 0, maxX: 20, maxY: 28 },
      closed: true,
      hasCurves: false,
      hasHoles: false,
      entities: [
        {
          kind: "polyline" as const,
          closed: true,
          points: [
            { x: 0, y: 0 },
            { x: 20, y: 0 },
            { x: 20, y: 20 },
            { x: 0, y: 20 }
          ]
        },
        {
          kind: "polyline" as const,
          closed: false,
          points: [
            { x: -12, y: 8 },
            { x: -2, y: 8 }
          ]
        },
        {
          kind: "polyline" as const,
          closed: false,
          points: [
            { x: -7, y: 3 },
            { x: -7, y: 13 }
          ]
        }
      ]
    };

    const pieces: PieceItem[] = [
      {
        id: "noisy-a",
        name: "Noisy A",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.dxf",
        warnings: [],
        geometry: noisySquare
      },
      {
        id: "noisy-b",
        name: "Noisy B",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.dxf",
        warnings: [],
        geometry: noisySquare
      }
    ];

    const result = await runNesting(
      pieces,
      { width: 44, height: 20, sheetCount: 1 },
      {
        pieceGap: 2,
        edgeGap: 0,
        kerf: 0,
        rotations: "orthogonal",
        quality: "fast",
        maxTimeMs: 4000,
        keepOrientation: false,
        prioritizeLarge: true
      }
    );

    expect(result.unplaced).toHaveLength(0);
    expect(result.placements).toHaveLength(2);
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

  it("allows placing a small part inside a larger contour hole", async () => {
    const pieces: PieceItem[] = [
      {
        id: "frame",
        name: "Marco",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.svg",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 80,
          height: 80,
          area: 4800,
          sourceBounds: { minX: 0, minY: 0, maxX: 80, maxY: 80 },
          closed: true,
          hasCurves: false,
          hasHoles: true,
          entities: [
            {
              kind: "polyline",
              closed: true,
              points: [
                { x: 0, y: 0 },
                { x: 80, y: 0 },
                { x: 80, y: 80 },
                { x: 0, y: 80 }
              ]
            },
            {
              kind: "polyline",
              closed: true,
              points: [
                { x: 20, y: 20 },
                { x: 60, y: 20 },
                { x: 60, y: 60 },
                { x: 20, y: 60 }
              ]
            }
          ]
        }
      },
      {
        id: "inner-square",
        name: "Cuadro interior",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.svg",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 20,
          height: 20,
          area: 400,
          sourceBounds: { minX: 0, minY: 0, maxX: 20, maxY: 20 },
          closed: true,
          hasCurves: false,
          hasHoles: false,
          entities: [
            {
              kind: "polyline",
              closed: true,
              points: [
                { x: 0, y: 0 },
                { x: 20, y: 0 },
                { x: 20, y: 20 },
                { x: 0, y: 20 }
              ]
            }
          ]
        }
      }
    ];

    const result = await runNesting(
      pieces,
      { width: 120, height: 120, sheetCount: 1 },
      {
        pieceGap: 0,
        edgeGap: 0,
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

    const frame = result.placements.find((placement) => placement.pieceId === "frame");
    const innerSquare = result.placements.find((placement) => placement.pieceId === "inner-square");
    expect(frame).toBeDefined();
    expect(innerSquare).toBeDefined();
    expect(innerSquare?.x).toBeGreaterThanOrEqual((frame?.x ?? 0) + 20);
    expect(innerSquare?.y).toBeGreaterThanOrEqual((frame?.y ?? 0) + 20);
    expect((innerSquare?.x ?? 0) + (innerSquare?.width ?? 0)).toBeLessThanOrEqual((frame?.x ?? 0) + 60);
    expect((innerSquare?.y ?? 0) + (innerSquare?.height ?? 0)).toBeLessThanOrEqual((frame?.y ?? 0) + 60);
  });

  it("uses a viable rotated variant when the default orientation cannot fit the sheet", async () => {
    const pieces: PieceItem[] = [
      {
        id: "tall-rect",
        name: "Rectangulo rotado",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.svg",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 80,
          height: 40,
          area: 3200,
          sourceBounds: { minX: 0, minY: 0, maxX: 80, maxY: 40 },
          closed: true,
          hasCurves: false,
          hasHoles: false,
          entities: [
            {
              kind: "polyline",
              closed: true,
              points: [
                { x: 0, y: 0 },
                { x: 80, y: 0 },
                { x: 80, y: 40 },
                { x: 0, y: 40 }
              ]
            }
          ]
        }
      }
    ];

    const result = await runNesting(
      pieces,
      { width: 50, height: 100, sheetCount: 1 },
      {
        pieceGap: 0,
        edgeGap: 0,
        kerf: 0,
        rotations: "orthogonal",
        quality: "fast",
        maxTimeMs: 10000,
        keepOrientation: false,
        prioritizeLarge: true
      }
    );

    expect(result.unplaced).toHaveLength(0);
    expect(result.placements).toHaveLength(1);
    expect(result.placements[0]?.rotation % 180).toBe(90);
    expect(result.placements[0]?.width).toBeLessThanOrEqual(50);
    expect(result.placements[0]?.height).toBeLessThanOrEqual(100);
  });

  it("deduplicates equivalent rotated variants for symmetric pieces", () => {
    const pieces: PieceItem[] = [
      {
        id: "square-piece",
        name: "Cuadrado",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.svg",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 40,
          height: 40,
          area: 1600,
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
                { x: 40, y: 0 },
                { x: 40, y: 40 },
                { x: 0, y: 40 }
              ]
            }
          ]
        }
      }
    ];

    const prepared = preparePiecesForNesting(pieces, {
      pieceGap: 0,
      edgeGap: 0,
      kerf: 0,
      rotations: "orthogonal",
      quality: "fast",
      maxTimeMs: 1000,
      keepOrientation: false,
      prioritizeLarge: true
    });

    expect(prepared).toHaveLength(1);
    expect(prepared[0]?.variants).toHaveLength(1);
  });

  it("keeps distributed candidate positions across the whole axis", () => {
    const values = Array.from({ length: 240 }, (_, index) => index * 5);
    const limited = limitCandidateAxis(values, 12, [0, 595]);

    expect(limited).toHaveLength(12);
    expect(limited[0]).toBe(0);
    expect(limited[limited.length - 1]).toBe(1195);
    expect(limited.some((value) => value >= 500 && value <= 700)).toBe(true);
    expect(limited.some((value) => value >= 900)).toBe(true);
  });

  it("starts the first placement against the material boundary on an empty sheet", async () => {
    const pieces: PieceItem[] = [
      {
        id: "single-rect",
        name: "Rectangulo unico",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.svg",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 30,
          height: 20,
          area: 600,
          sourceBounds: { minX: 0, minY: 0, maxX: 30, maxY: 20 },
          closed: true,
          hasCurves: false,
          hasHoles: false,
          entities: [
            {
              kind: "polyline",
              closed: true,
              points: [
                { x: 0, y: 0 },
                { x: 30, y: 0 },
                { x: 30, y: 20 },
                { x: 0, y: 20 }
              ]
            }
          ]
        }
      }
    ];

    const result = await runNesting(
      pieces,
      { width: 100, height: 80, sheetCount: 1 },
      {
        pieceGap: 0,
        edgeGap: 0,
        kerf: 0,
        rotations: "orthogonal",
        quality: "fast",
        maxTimeMs: 2000,
        keepOrientation: false,
        prioritizeLarge: true
      }
    );

    expect(result.unplaced).toHaveLength(0);
    expect(result.placements).toHaveLength(1);
    expect(result.placements[0]?.x).toBeCloseTo(0, 4);
    expect(result.placements[0]?.y).toBeCloseTo(0, 4);
  });

  it("keeps the second rectangle in a narrow attached footprint on an open sheet", async () => {
    const rectangle = {
      svgMarkup: "",
      width: 30,
      height: 20,
      area: 600,
      sourceBounds: { minX: 0, minY: 0, maxX: 30, maxY: 20 },
      closed: true,
      hasCurves: false,
      hasHoles: false,
      entities: [
        {
          kind: "polyline" as const,
          closed: true,
          points: [
            { x: 0, y: 0 },
            { x: 30, y: 0 },
            { x: 30, y: 20 },
            { x: 0, y: 20 }
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
      { width: 200, height: 120, sheetCount: 1 },
      {
        pieceGap: 0,
        edgeGap: 0,
        kerf: 0,
        rotations: "orthogonal",
        quality: "fast",
        maxTimeMs: 2000,
        keepOrientation: false,
        prioritizeLarge: true
      }
    );

    expect(result.unplaced).toHaveLength(0);
    expect(result.placements).toHaveLength(2);

    const footprint = {
      minX: Math.min(...result.placements.map((placement) => placement.x)),
      minY: Math.min(...result.placements.map((placement) => placement.y)),
      maxX: Math.max(...result.placements.map((placement) => placement.x + placement.width)),
      maxY: Math.max(...result.placements.map((placement) => placement.y + placement.height))
    };

    expect(footprint.maxX - footprint.minX).toBeLessThanOrEqual(30.001);
    expect(footprint.maxY - footprint.minY).toBeLessThanOrEqual(60.001);
  });

  it("uses an open concave L-shape to keep a complementary square in a compact footprint", async () => {
    const pieces: PieceItem[] = [
      {
        id: "l-shape",
        name: "Pieza L",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.svg",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 60,
          height: 60,
          area: 2000,
          sourceBounds: { minX: 0, minY: 0, maxX: 60, maxY: 60 },
          closed: true,
          hasCurves: false,
          hasHoles: false,
          entities: [
            {
              kind: "polyline",
              closed: true,
              points: [
                { x: 0, y: 0 },
                { x: 60, y: 0 },
                { x: 60, y: 20 },
                { x: 20, y: 20 },
                { x: 20, y: 60 },
                { x: 0, y: 60 }
              ]
            }
          ]
        }
      },
      {
        id: "square",
        name: "Cuadro complementario",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.svg",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 20,
          height: 20,
          area: 400,
          sourceBounds: { minX: 0, minY: 0, maxX: 20, maxY: 20 },
          closed: true,
          hasCurves: false,
          hasHoles: false,
          entities: [
            {
              kind: "polyline",
              closed: true,
              points: [
                { x: 0, y: 0 },
                { x: 20, y: 0 },
                { x: 20, y: 20 },
                { x: 0, y: 20 }
              ]
            }
          ]
        }
      }
    ];

    const result = await runNesting(
      pieces,
      { width: 120, height: 100, sheetCount: 1 },
      {
        pieceGap: 0,
        edgeGap: 0,
        kerf: 0,
        rotations: "orthogonal",
        quality: "balanced",
        maxTimeMs: 4000,
        keepOrientation: false,
        prioritizeLarge: true
      }
    );

    expect(result.unplaced).toHaveLength(0);
    expect(result.placements).toHaveLength(2);

    const footprint = {
      minX: Math.min(...result.placements.map((placement) => placement.x)),
      minY: Math.min(...result.placements.map((placement) => placement.y)),
      maxX: Math.max(...result.placements.map((placement) => placement.x + placement.width)),
      maxY: Math.max(...result.placements.map((placement) => placement.y + placement.height))
    };

    expect(footprint.maxX - footprint.minX).toBeLessThanOrEqual(60.001);
    expect(footprint.maxY - footprint.minY).toBeLessThanOrEqual(60.001);
  }, 15000);

  it("reserves a valuable hole for the next larger piece when lookahead is enabled", async () => {
    const pieces: PieceItem[] = [
      {
        id: "frame",
        name: "Marco",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.svg",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 80,
          height: 80,
          area: 4800,
          sourceBounds: { minX: 0, minY: 0, maxX: 80, maxY: 80 },
          closed: true,
          hasCurves: false,
          hasHoles: true,
          entities: [
            {
              kind: "polyline",
              closed: true,
              points: [
                { x: 0, y: 0 },
                { x: 80, y: 0 },
                { x: 80, y: 80 },
                { x: 0, y: 80 }
              ]
            },
            {
              kind: "polyline",
              closed: true,
              points: [
                { x: 20, y: 20 },
                { x: 60, y: 20 },
                { x: 60, y: 60 },
                { x: 20, y: 60 }
              ]
            }
          ]
        }
      },
      {
        id: "small",
        name: "Pieza pequena",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.svg",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 15,
          height: 15,
          area: 225,
          sourceBounds: { minX: 0, minY: 0, maxX: 15, maxY: 15 },
          closed: true,
          hasCurves: false,
          hasHoles: false,
          entities: [
            {
              kind: "polyline",
              closed: true,
              points: [
                { x: 0, y: 0 },
                { x: 15, y: 0 },
                { x: 15, y: 15 },
                { x: 0, y: 15 }
              ]
            }
          ]
        }
      },
      {
        id: "medium",
        name: "Pieza mediana",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.svg",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 35,
          height: 35,
          area: 1225,
          sourceBounds: { minX: 0, minY: 0, maxX: 35, maxY: 35 },
          closed: true,
          hasCurves: false,
          hasHoles: false,
          entities: [
            {
              kind: "polyline",
              closed: true,
              points: [
                { x: 0, y: 0 },
                { x: 35, y: 0 },
                { x: 35, y: 35 },
                { x: 0, y: 35 }
              ]
            }
          ]
        }
      }
    ];

    const result = await runNesting(
      pieces,
      { width: 100, height: 80, sheetCount: 1 },
      {
        pieceGap: 0,
        edgeGap: 0,
        kerf: 0,
        rotations: "orthogonal",
        quality: "balanced",
        maxTimeMs: 10000,
        keepOrientation: false,
        prioritizeLarge: false
      }
    );

    expect(result.unplaced).toHaveLength(0);
    expect(result.placements).toHaveLength(3);

    const frame = result.placements.find((placement) => placement.pieceId === "frame");
    const small = result.placements.find((placement) => placement.pieceId === "small");
    const medium = result.placements.find((placement) => placement.pieceId === "medium");

    expect(frame).toBeDefined();
    expect(small).toBeDefined();
    expect(medium).toBeDefined();

    const holeMinX = (frame?.x ?? 0) + 20;
    const holeMinY = (frame?.y ?? 0) + 20;
    const holeMaxX = (frame?.x ?? 0) + 60;
    const holeMaxY = (frame?.y ?? 0) + 60;

    expect(medium?.x).toBeGreaterThanOrEqual(holeMinX);
    expect(medium?.y).toBeGreaterThanOrEqual(holeMinY);
    expect((medium?.x ?? 0) + (medium?.width ?? 0)).toBeLessThanOrEqual(holeMaxX);
    expect((medium?.y ?? 0) + (medium?.height ?? 0)).toBeLessThanOrEqual(holeMaxY);

    const smallInsideHole =
      (small?.x ?? 0) >= holeMinX &&
      (small?.y ?? 0) >= holeMinY &&
      (small?.x ?? 0) + (small?.width ?? 0) <= holeMaxX &&
      (small?.y ?? 0) + (small?.height ?? 0) <= holeMaxY;

    expect(smallInsideHole).toBe(false);
  });

  it("prioritizes the most constrained future piece even if it is not the next one in the list", async () => {
    const pieces: PieceItem[] = [
      {
        id: "frame",
        name: "Marco",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.svg",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 80,
          height: 80,
          area: 4800,
          sourceBounds: { minX: 0, minY: 0, maxX: 80, maxY: 80 },
          closed: true,
          hasCurves: false,
          hasHoles: true,
          entities: [
            {
              kind: "polyline",
              closed: true,
              points: [
                { x: 0, y: 0 },
                { x: 80, y: 0 },
                { x: 80, y: 80 },
                { x: 0, y: 80 }
              ]
            },
            {
              kind: "polyline",
              closed: true,
              points: [
                { x: 20, y: 20 },
                { x: 60, y: 20 },
                { x: 60, y: 60 },
                { x: 20, y: 60 }
              ]
            }
          ]
        }
      },
      {
        id: "small-a",
        name: "Pieza pequena A",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.svg",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 10,
          height: 10,
          area: 100,
          sourceBounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
          closed: true,
          hasCurves: false,
          hasHoles: false,
          entities: [
            {
              kind: "polyline",
              closed: true,
              points: [
                { x: 0, y: 0 },
                { x: 10, y: 0 },
                { x: 10, y: 10 },
                { x: 0, y: 10 }
              ]
            }
          ]
        }
      },
      {
        id: "small-b",
        name: "Pieza pequena B",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.svg",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 10,
          height: 10,
          area: 100,
          sourceBounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
          closed: true,
          hasCurves: false,
          hasHoles: false,
          entities: [
            {
              kind: "polyline",
              closed: true,
              points: [
                { x: 0, y: 0 },
                { x: 10, y: 0 },
                { x: 10, y: 10 },
                { x: 0, y: 10 }
              ]
            }
          ]
        }
      },
      {
        id: "medium",
        name: "Pieza mediana",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.svg",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 35,
          height: 35,
          area: 1225,
          sourceBounds: { minX: 0, minY: 0, maxX: 35, maxY: 35 },
          closed: true,
          hasCurves: false,
          hasHoles: false,
          entities: [
            {
              kind: "polyline",
              closed: true,
              points: [
                { x: 0, y: 0 },
                { x: 35, y: 0 },
                { x: 35, y: 35 },
                { x: 0, y: 35 }
              ]
            }
          ]
        }
      }
    ];

    const result = await runNesting(
      pieces,
      { width: 100, height: 80, sheetCount: 1 },
      {
        pieceGap: 0,
        edgeGap: 0,
        kerf: 0,
        rotations: "orthogonal",
        quality: "quality",
        maxTimeMs: 10000,
        keepOrientation: false,
        prioritizeLarge: false
      }
    );

    expect(result.unplaced).toHaveLength(0);

    const frame = result.placements.find((placement) => placement.pieceId === "frame");
    const medium = result.placements.find((placement) => placement.pieceId === "medium");
    const smallA = result.placements.find((placement) => placement.pieceId === "small-a");
    const smallB = result.placements.find((placement) => placement.pieceId === "small-b");

    expect(frame).toBeDefined();
    expect(medium).toBeDefined();
    expect(smallA).toBeDefined();
    expect(smallB).toBeDefined();

    const holeMinX = (frame?.x ?? 0) + 20;
    const holeMinY = (frame?.y ?? 0) + 20;
    const holeMaxX = (frame?.x ?? 0) + 60;
    const holeMaxY = (frame?.y ?? 0) + 60;

    expect(medium?.x).toBeGreaterThanOrEqual(holeMinX);
    expect(medium?.y).toBeGreaterThanOrEqual(holeMinY);
    expect((medium?.x ?? 0) + (medium?.width ?? 0)).toBeLessThanOrEqual(holeMaxX);
    expect((medium?.y ?? 0) + (medium?.height ?? 0)).toBeLessThanOrEqual(holeMaxY);

    const smallAInsideHole =
      (smallA?.x ?? 0) >= holeMinX &&
      (smallA?.y ?? 0) >= holeMinY &&
      (smallA?.x ?? 0) + (smallA?.width ?? 0) <= holeMaxX &&
      (smallA?.y ?? 0) + (smallA?.height ?? 0) <= holeMaxY;
    const smallBInsideHole =
      (smallB?.x ?? 0) >= holeMinX &&
      (smallB?.y ?? 0) >= holeMinY &&
      (smallB?.x ?? 0) + (smallB?.width ?? 0) <= holeMaxX &&
      (smallB?.y ?? 0) + (smallB?.height ?? 0) <= holeMaxY;

    expect(smallAInsideHole).toBe(false);
    expect(smallBInsideHole).toBe(false);
  }, 15000);

  it("keeps a mixed rectangular batch in a narrow compact footprint when width compression is clearly optimal", async () => {
    const pieces: PieceItem[] = [
      {
        id: "big",
        name: "Pieza grande",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.svg",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 40,
          height: 40,
          area: 1600,
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
                { x: 40, y: 0 },
                { x: 40, y: 40 },
                { x: 0, y: 40 }
              ]
            }
          ]
        }
      },
      {
        id: "mid-a",
        name: "Mediana A",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.svg",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 20,
          height: 20,
          area: 400,
          sourceBounds: { minX: 0, minY: 0, maxX: 20, maxY: 20 },
          closed: true,
          hasCurves: false,
          hasHoles: false,
          entities: [
            {
              kind: "polyline",
              closed: true,
              points: [
                { x: 0, y: 0 },
                { x: 20, y: 0 },
                { x: 20, y: 20 },
                { x: 0, y: 20 }
              ]
            }
          ]
        }
      },
      {
        id: "mid-b",
        name: "Mediana B",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.svg",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 20,
          height: 20,
          area: 400,
          sourceBounds: { minX: 0, minY: 0, maxX: 20, maxY: 20 },
          closed: true,
          hasCurves: false,
          hasHoles: false,
          entities: [
            {
              kind: "polyline",
              closed: true,
              points: [
                { x: 0, y: 0 },
                { x: 20, y: 0 },
                { x: 20, y: 20 },
                { x: 0, y: 20 }
              ]
            }
          ]
        }
      },
      {
        id: "mid-c",
        name: "Mediana C",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.svg",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 20,
          height: 20,
          area: 400,
          sourceBounds: { minX: 0, minY: 0, maxX: 20, maxY: 20 },
          closed: true,
          hasCurves: false,
          hasHoles: false,
          entities: [
            {
              kind: "polyline",
              closed: true,
              points: [
                { x: 0, y: 0 },
                { x: 20, y: 0 },
                { x: 20, y: 20 },
                { x: 0, y: 20 }
              ]
            }
          ]
        }
      },
      {
        id: "mid-d",
        name: "Mediana D",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.svg",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 20,
          height: 20,
          area: 400,
          sourceBounds: { minX: 0, minY: 0, maxX: 20, maxY: 20 },
          closed: true,
          hasCurves: false,
          hasHoles: false,
          entities: [
            {
              kind: "polyline",
              closed: true,
              points: [
                { x: 0, y: 0 },
                { x: 20, y: 0 },
                { x: 20, y: 20 },
                { x: 0, y: 20 }
              ]
            }
          ]
        }
      },
      {
        id: "mid-e",
        name: "Mediana E",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.svg",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 20,
          height: 20,
          area: 400,
          sourceBounds: { minX: 0, minY: 0, maxX: 20, maxY: 20 },
          closed: true,
          hasCurves: false,
          hasHoles: false,
          entities: [
            {
              kind: "polyline",
              closed: true,
              points: [
                { x: 0, y: 0 },
                { x: 20, y: 0 },
                { x: 20, y: 20 },
                { x: 0, y: 20 }
              ]
            }
          ]
        }
      }
    ];

    const result = await runNesting(
      pieces,
      { width: 140, height: 80, sheetCount: 1 },
      {
        pieceGap: 0,
        edgeGap: 0,
        kerf: 0,
        rotations: "orthogonal",
        quality: "fast",
        maxTimeMs: 4000,
        keepOrientation: false,
        prioritizeLarge: true
      }
    );

    expect(result.unplaced).toHaveLength(0);
    expect(result.placements).toHaveLength(6);

    const footprint = {
      minX: Math.min(...result.placements.map((placement) => placement.x)),
      minY: Math.min(...result.placements.map((placement) => placement.y)),
      maxX: Math.max(...result.placements.map((placement) => placement.x + placement.width)),
      maxY: Math.max(...result.placements.map((placement) => placement.y + placement.height))
    };

    expect(footprint.maxX - footprint.minX).toBeLessThanOrEqual(100.001);
    expect(footprint.maxY - footprint.minY).toBeLessThanOrEqual(80.001);
  }, 15000);

  it("emits intermediate progress updates during longer nesting runs", async () => {
    const rectangleGeometry = (width: number, height: number, id: string): PieceItem => ({
      id,
      name: id,
      quantity: 1,
      enabled: true,
      sourceFile: "demo.svg",
      warnings: [],
      geometry: {
        svgMarkup: "",
        width,
        height,
        area: width * height,
        sourceBounds: { minX: 0, minY: 0, maxX: width, maxY: height },
        closed: true,
        hasCurves: false,
        hasHoles: false,
        entities: [
          {
            kind: "polyline",
            closed: true,
            points: [
              { x: 0, y: 0 },
              { x: width, y: 0 },
              { x: width, y: height },
              { x: 0, y: height }
            ]
          }
        ]
      }
    });

    const pieces: PieceItem[] = [
      rectangleGeometry(120, 80, "p1"),
      rectangleGeometry(90, 60, "p2"),
      rectangleGeometry(84, 84, "p3"),
      rectangleGeometry(90, 50, "p4")
    ];

    const config = {
      pieceGap: 5,
      edgeGap: 5,
      kerf: 0.15,
      rotations: "free45" as const,
      quality: "fast" as const,
      maxTimeMs: 1200,
      keepOrientation: false,
      prioritizeLarge: true
    };

    const prepared = preparePiecesForNesting(pieces, config);
    const progressMessages: string[] = [];

    const result = await runPreparedNesting(
      prepared,
      { width: 900, height: 600, sheetCount: 1 },
      config,
      (message) => {
        progressMessages.push(message);
      }
    );

    expect(result.placements.length).toBeGreaterThan(0);
    expect(progressMessages).toContain("Analizando contornos.");
    expect(progressMessages).toContain("Preparando rotaciones reales.");
    expect(
      progressMessages.some(
        (message) =>
          message.includes("Evaluando acomodo") ||
          message.includes("Probando acomodos") ||
          message.includes("Explorando variantes") ||
          message.includes("Mejorando acomodo")
      )
    ).toBe(true);
    expect(progressMessages[progressMessages.length - 1]).toBe("Resultado listo.");
  }, 150000);
});
