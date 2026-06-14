import { describe, expect, it } from "vitest";
import { buildResultDxf, buildResultSvg, mergeCommonLineContours } from "./exporters";
import type { MaterialConfig, NestingResult, PieceItem } from "../types";

describe("DXF export", () => {
  it("removes duplicated shared line segments from contour exports", () => {
    const merged = mergeCommonLineContours([
      {
        closed: true,
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 10 }
        ]
      },
      {
        closed: true,
        points: [
          { x: 10, y: 0 },
          { x: 20, y: 0 },
          { x: 20, y: 10 },
          { x: 10, y: 10 }
        ]
      }
    ]);

    const serialized = merged.map((contour) => contour.points.map((point) => `${point.x},${point.y}`).join(" -> "));
    expect(serialized.join(" | ")).not.toContain("10,0 -> 10,10");
    expect(serialized.join(" | ")).not.toContain("10,10 -> 10,0");
  });

  it("merges collinear contiguous segments into cleaner contours", () => {
    const merged = mergeCommonLineContours([
      {
        closed: false,
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 }
        ]
      },
      {
        closed: false,
        points: [
          { x: 10, y: 0 },
          { x: 20, y: 0 }
        ]
      }
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].points).toEqual([
      { x: 0, y: 0 },
      { x: 20, y: 0 }
    ]);
  });

  it("removes nearly duplicated export contours", () => {
    const merged = mergeCommonLineContours([
      {
        closed: true,
        points: [
          { x: 0, y: 0 },
          { x: 20, y: 0 },
          { x: 20, y: 20 },
          { x: 0, y: 20 }
        ]
      },
      {
        closed: true,
        points: [
          { x: 0.04, y: 0.02 },
          { x: 20.03, y: 0.01 },
          { x: 20.02, y: 20.04 },
          { x: 0.01, y: 20.03 }
        ]
      }
    ]);

    expect(merged.length).toBeGreaterThan(0);
  });

  it("writes ellipse entities when the geometry allows direct CAD export", () => {
    const pieces: PieceItem[] = [
      {
        id: "pieza-1",
        name: "Pieza 01",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.dxf",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 40,
          height: 20,
          area: 628.3,
          sourceBounds: {
            minX: 0,
            minY: 0,
            maxX: 40,
            maxY: 20
          },
          closed: true,
          hasCurves: true,
          hasHoles: false,
          entities: [
            {
              kind: "ellipse",
              cx: 20,
              cy: 10,
              rx: 20,
              ry: 10,
              rotation: 0
            }
          ]
        }
      }
    ];

    const material: MaterialConfig = {
      width: 900,
      height: 600,
      unit: "mm",
      sheetCount: 1,
      name: "Material"
    };

    const result: NestingResult = {
      placements: [
        {
          pieceId: "pieza-1",
          sheetIndex: 0,
          x: 0,
          y: 0,
          width: 40,
          height: 20,
          rotation: 0
        }
      ],
      unplaced: [],
      usedSheets: 1,
      usedArea: 628.3,
      wasteArea: 0,
      utilization: 100,
      elapsedMs: 1
    };

    const dxf = buildResultDxf(pieces, material, result);
    expect(dxf).toContain("ELLIPSE");
    expect(dxf).toContain("\n11\n20.0000\n");
    expect(dxf).toContain("\n40\n0.500000\n");
    expect(dxf).toContain("$INSUNITS");
    expect(dxf).toContain("AcDbEllipse");
  });

  it("builds SVG export from final contours instead of raw nested markup", () => {
    const pieces: PieceItem[] = [
      {
        id: "pieza-svg",
        name: "Pieza SVG",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.svg",
        warnings: [],
        geometry: {
          svgMarkup: "<rect x='10' y='10' width='20' height='10' />",
          width: 20,
          height: 10,
          area: 200,
          sourceBounds: {
            minX: 10,
            minY: 10,
            maxX: 30,
            maxY: 20
          },
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
                { x: 20, y: 10 },
                { x: 0, y: 10 }
              ]
            }
          ]
        }
      }
    ];

    const material: MaterialConfig = {
      width: 900,
      height: 600,
      unit: "mm",
      sheetCount: 1,
      name: "Material"
    };

    const result: NestingResult = {
      placements: [
        {
          pieceId: "pieza-svg",
          sheetIndex: 0,
          x: 0,
          y: 0,
          width: 20,
          height: 10,
          rotation: 0
        }
      ],
      unplaced: [],
      usedSheets: 1,
      usedArea: 200,
      wasteArea: 0,
      utilization: 100,
      elapsedMs: 1
    };

    const svg = buildResultSvg(pieces, material, result);
    expect(svg).toContain("<polygon");
    expect(svg).not.toContain("<rect");
  });

  it("preserves the exported contour count for mixed placed pieces", () => {
    const pieces: PieceItem[] = [
      {
        id: "rect-big",
        name: "Rect grande",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.svg",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 80,
          height: 80,
          area: 6400,
          sourceBounds: {
            minX: 0,
            minY: 0,
            maxX: 80,
            maxY: 80
          },
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
                { x: 80, y: 80 },
                { x: 0, y: 80 }
              ]
            }
          ]
        }
      },
      {
        id: "rect-small",
        name: "Rect chico",
        quantity: 4,
        enabled: true,
        sourceFile: "demo.svg",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 30,
          height: 30,
          area: 900,
          sourceBounds: {
            minX: 0,
            minY: 0,
            maxX: 30,
            maxY: 30
          },
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
                { x: 30, y: 30 },
                { x: 0, y: 30 }
              ]
            }
          ]
        }
      },
      {
        id: "circle-piece",
        name: "Circulo",
        quantity: 4,
        enabled: true,
        sourceFile: "demo.svg",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 20,
          height: 20,
          area: 314,
          sourceBounds: {
            minX: 0,
            minY: 0,
            maxX: 20,
            maxY: 20
          },
          closed: true,
          hasCurves: true,
          hasHoles: false,
          entities: [
            {
              kind: "circle",
              cx: 10,
              cy: 10,
              r: 10
            }
          ]
        }
      }
    ];

    const material: MaterialConfig = {
      width: 900,
      height: 600,
      unit: "mm",
      sheetCount: 1,
      name: "Material"
    };

    const result: NestingResult = {
      placements: [
        { pieceId: "rect-big", sheetIndex: 0, x: 0, y: 0, width: 80, height: 80, rotation: 0 },
        { pieceId: "rect-small", sheetIndex: 0, x: 100, y: 0, width: 30, height: 30, rotation: 0 },
        { pieceId: "rect-small", sheetIndex: 0, x: 135, y: 0, width: 30, height: 30, rotation: 0 },
        { pieceId: "rect-small", sheetIndex: 0, x: 170, y: 0, width: 30, height: 30, rotation: 0 },
        { pieceId: "rect-small", sheetIndex: 0, x: 205, y: 0, width: 30, height: 30, rotation: 0 },
        { pieceId: "circle-piece", sheetIndex: 0, x: 260, y: 0, width: 20, height: 20, rotation: 0 },
        { pieceId: "circle-piece", sheetIndex: 0, x: 285, y: 0, width: 20, height: 20, rotation: 0 },
        { pieceId: "circle-piece", sheetIndex: 0, x: 310, y: 0, width: 20, height: 20, rotation: 0 },
        { pieceId: "circle-piece", sheetIndex: 0, x: 335, y: 0, width: 20, height: 20, rotation: 0 }
      ],
      unplaced: [],
      usedSheets: 1,
      usedArea: 9120,
      wasteArea: 0,
      utilization: 100,
      elapsedMs: 1
    };

    const svg = buildResultSvg(pieces, material, result);
    const polygonCount = (svg.match(/<polygon /g) ?? []).length;
    const polylineCount = (svg.match(/<polyline /g) ?? []).length;
    expect(polygonCount + polylineCount).toBe(9);
    expect(polygonCount).toBeGreaterThanOrEqual(9);
  });

  it("does not export tiny degenerate contours into the final SVG", () => {
    const pieces: PieceItem[] = [
      {
        id: "tiny-noise-piece",
        name: "Tiny noise",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.svg",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 20,
          height: 20,
          area: 400,
          sourceBounds: {
            minX: 0,
            minY: 0,
            maxX: 20,
            maxY: 20
          },
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
            },
            {
              kind: "polyline",
              closed: true,
              points: [
                { x: 50, y: 50 },
                { x: 50.04, y: 50 },
                { x: 50.04, y: 50.04 },
                { x: 50, y: 50.04 }
              ]
            }
          ]
        }
      }
    ];

    const material: MaterialConfig = {
      width: 900,
      height: 600,
      unit: "mm",
      sheetCount: 1,
      name: "Material"
    };

    const result: NestingResult = {
      placements: [
        {
          pieceId: "tiny-noise-piece",
          sheetIndex: 0,
          x: 0,
          y: 0,
          width: 20,
          height: 20,
          rotation: 0
        }
      ],
      unplaced: [],
      usedSheets: 1,
      usedArea: 400,
      wasteArea: 0,
      utilization: 100,
      elapsedMs: 1
    };

    const svg = buildResultSvg(pieces, material, result);
    expect((svg.match(/<polygon /g) ?? []).length + (svg.match(/<polyline /g) ?? []).length).toBe(1);
  });

  it("keeps rotated ellipses as ellipse entities instead of flattening them", () => {
    const pieces: PieceItem[] = [
      {
        id: "pieza-2",
        name: "Pieza 02",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.dxf",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 40,
          height: 20,
          area: 628.3,
          sourceBounds: {
            minX: 0,
            minY: 0,
            maxX: 40,
            maxY: 20
          },
          closed: true,
          hasCurves: true,
          hasHoles: false,
          entities: [
            {
              kind: "ellipse",
              cx: 20,
              cy: 10,
              rx: 20,
              ry: 10,
              rotation: 0
            }
          ]
        }
      }
    ];

    const material: MaterialConfig = {
      width: 900,
      height: 600,
      unit: "mm",
      sheetCount: 1,
      name: "Material"
    };

    const result: NestingResult = {
      placements: [
        {
          pieceId: "pieza-2",
          sheetIndex: 0,
          x: 0,
          y: 0,
          width: 40,
          height: 20,
          rotation: 30
        }
      ],
      unplaced: [],
      usedSheets: 1,
      usedArea: 628.3,
      wasteArea: 0,
      utilization: 100,
      elapsedMs: 1
    };

    const dxf = buildResultDxf(pieces, material, result);
    expect(dxf).toContain("ELLIPSE");
    expect(dxf).not.toContain("LWPOLYLINE");
    expect(dxf).toContain("\n11\n17.3205\n");
    expect(dxf).toContain("\n21\n-10.0000\n");
  });

  it("preserves simple circular path arcs as DXF ARC entities", () => {
    const pieces: PieceItem[] = [
      {
        id: "pieza-3",
        name: "Pieza 03",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.dxf",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 10,
          height: 5,
          area: 25,
          sourceBounds: {
            minX: 0,
            minY: 0,
            maxX: 10,
            maxY: 5
          },
          closed: false,
          hasCurves: true,
          hasHoles: false,
          entities: [
            {
              kind: "path",
              d: "M 0 0 A 5 5 0 0 1 10 0",
              closed: false
            }
          ]
        }
      }
    ];

    const material: MaterialConfig = {
      width: 900,
      height: 600,
      unit: "mm",
      sheetCount: 1,
      name: "Material"
    };

    const result: NestingResult = {
      placements: [
        {
          pieceId: "pieza-3",
          sheetIndex: 0,
          x: 0,
          y: 0,
          width: 10,
          height: 5,
          rotation: 0
        }
      ],
      unplaced: [],
      usedSheets: 1,
      usedArea: 25,
      wasteArea: 0,
      utilization: 100,
      elapsedMs: 1
    };

    const dxf = buildResultDxf(pieces, material, result);
    expect(dxf).toContain("ARC");
    expect(dxf).not.toContain("LWPOLYLINE");
  });

  it("exports relative rectangular SVG paths as native DXF polylines", () => {
    const pieces: PieceItem[] = [
      {
        id: "pieza-rel-path",
        name: "Pieza relative path",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.svg",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 20,
          height: 10,
          area: 200,
          sourceBounds: {
            minX: 0,
            minY: 0,
            maxX: 20,
            maxY: 10
          },
          closed: true,
          hasCurves: false,
          hasHoles: false,
          entities: [
            {
              kind: "path",
              d: "m 0 0 h 20 v 10 h -20 z",
              closed: true
            }
          ]
        }
      }
    ];

    const material: MaterialConfig = {
      width: 900,
      height: 600,
      unit: "mm",
      sheetCount: 1,
      name: "Material"
    };

    const result: NestingResult = {
      placements: [
        {
          pieceId: "pieza-rel-path",
          sheetIndex: 0,
          x: 0,
          y: 0,
          width: 20,
          height: 10,
          rotation: 0
        }
      ],
      unplaced: [],
      usedSheets: 1,
      usedArea: 200,
      wasteArea: 0,
      utilization: 100,
      elapsedMs: 1
    };

    const dxf = buildResultDxf(pieces, material, result);
    expect(dxf).toContain("LWPOLYLINE");
  });

  it("exports relative path arcs as DXF ARC entities when possible", () => {
    const pieces: PieceItem[] = [
      {
        id: "pieza-rel-arc",
        name: "Pieza relative arc",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.svg",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 10,
          height: 5,
          area: 25,
          sourceBounds: {
            minX: 0,
            minY: 0,
            maxX: 10,
            maxY: 5
          },
          closed: false,
          hasCurves: true,
          hasHoles: false,
          entities: [
            {
              kind: "path",
              d: "m 0 0 a 5 5 0 0 1 10 0",
              closed: false
            }
          ]
        }
      }
    ];

    const material: MaterialConfig = {
      width: 900,
      height: 600,
      unit: "mm",
      sheetCount: 1,
      name: "Material"
    };

    const result: NestingResult = {
      placements: [
        {
          pieceId: "pieza-rel-arc",
          sheetIndex: 0,
          x: 0,
          y: 0,
          width: 10,
          height: 5,
          rotation: 0
        }
      ],
      unplaced: [],
      usedSheets: 1,
      usedArea: 25,
      wasteArea: 0,
      utilization: 100,
      elapsedMs: 1
    };

    const dxf = buildResultDxf(pieces, material, result);
    expect(dxf).toContain("ARC");
  });

  it("exports quadratic SVG paths as DXF polylines when native arcs are not possible", () => {
    const pieces: PieceItem[] = [
      {
        id: "pieza-quad-path",
        name: "Pieza quadratic path",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.svg",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 20,
          height: 10,
          area: 100,
          sourceBounds: {
            minX: 0,
            minY: 0,
            maxX: 20,
            maxY: 10
          },
          closed: false,
          hasCurves: true,
          hasHoles: false,
          entities: [
            {
              kind: "path",
              d: "M 0 0 Q 10 10 20 0",
              closed: false
            }
          ]
        }
      }
    ];

    const material: MaterialConfig = {
      width: 900,
      height: 600,
      unit: "mm",
      sheetCount: 1,
      name: "Material"
    };

    const result: NestingResult = {
      placements: [
        {
          pieceId: "pieza-quad-path",
          sheetIndex: 0,
          x: 0,
          y: 0,
          width: 20,
          height: 10,
          rotation: 0
        }
      ],
      unplaced: [],
      usedSheets: 1,
      usedArea: 100,
      wasteArea: 0,
      utilization: 100,
      elapsedMs: 1
    };

    const dxf = buildResultDxf(pieces, material, result);
    expect(dxf).toContain("LWPOLYLINE");
  });

  it("exports implicit repeated line SVG paths as DXF polylines", () => {
    const pieces: PieceItem[] = [
      {
        id: "pieza-implicit-line-path",
        name: "Pieza implicit line path",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.svg",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 20,
          height: 10,
          area: 200,
          sourceBounds: {
            minX: 0,
            minY: 0,
            maxX: 20,
            maxY: 10
          },
          closed: true,
          hasCurves: false,
          hasHoles: false,
          entities: [
            {
              kind: "path",
              d: "M 0 0 20 0 20 10 0 10 Z",
              closed: true
            }
          ]
        }
      }
    ];

    const material: MaterialConfig = {
      width: 900,
      height: 600,
      unit: "mm",
      sheetCount: 1,
      name: "Material"
    };

    const result: NestingResult = {
      placements: [
        {
          pieceId: "pieza-implicit-line-path",
          sheetIndex: 0,
          x: 0,
          y: 0,
          width: 20,
          height: 10,
          rotation: 0
        }
      ],
      unplaced: [],
      usedSheets: 1,
      usedArea: 200,
      wasteArea: 0,
      utilization: 100,
      elapsedMs: 1
    };

    const dxf = buildResultDxf(pieces, material, result);
    expect(dxf).toContain("LWPOLYLINE");
  });

  it("exports cubic SVG paths as DXF polylines when native arcs are not possible", () => {
    const pieces: PieceItem[] = [
      {
        id: "pieza-cubic-path",
        name: "Pieza cubic path",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.svg",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 20,
          height: 10,
          area: 100,
          sourceBounds: {
            minX: 0,
            minY: 0,
            maxX: 20,
            maxY: 10
          },
          closed: false,
          hasCurves: true,
          hasHoles: false,
          entities: [
            {
              kind: "path",
              d: "M 0 0 C 5 10 15 10 20 0",
              closed: false
            }
          ]
        }
      }
    ];

    const material: MaterialConfig = {
      width: 900,
      height: 600,
      unit: "mm",
      sheetCount: 1,
      name: "Material"
    };

    const result: NestingResult = {
      placements: [
        {
          pieceId: "pieza-cubic-path",
          sheetIndex: 0,
          x: 0,
          y: 0,
          width: 20,
          height: 10,
          rotation: 0
        }
      ],
      unplaced: [],
      usedSheets: 1,
      usedArea: 100,
      wasteArea: 0,
      utilization: 100,
      elapsedMs: 1
    };

    const dxf = buildResultDxf(pieces, material, result);
    expect(dxf).toContain("LWPOLYLINE");
  });

  it("exports implicit repeated cubic SVG paths as DXF polylines", () => {
    const pieces: PieceItem[] = [
      {
        id: "pieza-implicit-cubic-path",
        name: "Pieza implicit cubic path",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.svg",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 40,
          height: 10,
          area: 200,
          sourceBounds: {
            minX: 0,
            minY: 0,
            maxX: 40,
            maxY: 10
          },
          closed: false,
          hasCurves: true,
          hasHoles: false,
          entities: [
            {
              kind: "path",
              d: "M 0 0 C 5 10 15 10 20 0 25 -10 35 -10 40 0",
              closed: false
            }
          ]
        }
      }
    ];

    const material: MaterialConfig = {
      width: 900,
      height: 600,
      unit: "mm",
      sheetCount: 1,
      name: "Material"
    };

    const result: NestingResult = {
      placements: [
        {
          pieceId: "pieza-implicit-cubic-path",
          sheetIndex: 0,
          x: 0,
          y: 0,
          width: 40,
          height: 10,
          rotation: 0
        }
      ],
      unplaced: [],
      usedSheets: 1,
      usedArea: 200,
      wasteArea: 0,
      utilization: 100,
      elapsedMs: 1
    };

    const dxf = buildResultDxf(pieces, material, result);
    expect(dxf).toContain("LWPOLYLINE");
  });

  it("exports shorthand quadratic SVG paths as DXF polylines", () => {
    const pieces: PieceItem[] = [
      {
        id: "pieza-shorthand-quad",
        name: "Pieza shorthand quadratic",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.svg",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 30,
          height: 10,
          area: 120,
          sourceBounds: {
            minX: 0,
            minY: 0,
            maxX: 30,
            maxY: 10
          },
          closed: false,
          hasCurves: true,
          hasHoles: false,
          entities: [
            {
              kind: "path",
              d: "M 0 0 Q 10 10 20 0 T 30 0",
              closed: false
            }
          ]
        }
      }
    ];

    const material: MaterialConfig = {
      width: 900,
      height: 600,
      unit: "mm",
      sheetCount: 1,
      name: "Material"
    };

    const result: NestingResult = {
      placements: [
        {
          pieceId: "pieza-shorthand-quad",
          sheetIndex: 0,
          x: 0,
          y: 0,
          width: 30,
          height: 10,
          rotation: 0
        }
      ],
      unplaced: [],
      usedSheets: 1,
      usedArea: 120,
      wasteArea: 0,
      utilization: 100,
      elapsedMs: 1
    };

    const dxf = buildResultDxf(pieces, material, result);
    expect(dxf).toContain("LWPOLYLINE");
  });

  it("exports shorthand cubic SVG paths as DXF polylines", () => {
    const pieces: PieceItem[] = [
      {
        id: "pieza-shorthand-cubic",
        name: "Pieza shorthand cubic",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.svg",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 30,
          height: 10,
          area: 120,
          sourceBounds: {
            minX: 0,
            minY: 0,
            maxX: 30,
            maxY: 10
          },
          closed: false,
          hasCurves: true,
          hasHoles: false,
          entities: [
            {
              kind: "path",
              d: "M 0 0 C 5 10 10 10 15 0 S 25 -10 30 0",
              closed: false
            }
          ]
        }
      }
    ];

    const material: MaterialConfig = {
      width: 900,
      height: 600,
      unit: "mm",
      sheetCount: 1,
      name: "Material"
    };

    const result: NestingResult = {
      placements: [
        {
          pieceId: "pieza-shorthand-cubic",
          sheetIndex: 0,
          x: 0,
          y: 0,
          width: 30,
          height: 10,
          rotation: 0
        }
      ],
      unplaced: [],
      usedSheets: 1,
      usedArea: 120,
      wasteArea: 0,
      utilization: 100,
      elapsedMs: 1
    };

    const dxf = buildResultDxf(pieces, material, result);
    expect(dxf).toContain("LWPOLYLINE");
  });

  it("exports partial ellipses as DXF ELLIPSE entities with trim parameters", () => {
    const pieces: PieceItem[] = [
      {
        id: "pieza-4",
        name: "Pieza 04",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.dxf",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 10,
          height: 5,
          area: 25,
          sourceBounds: {
            minX: 0,
            minY: 0,
            maxX: 10,
            maxY: 5
          },
          closed: false,
          hasCurves: true,
          hasHoles: false,
          entities: [
            {
              kind: "ellipseArc",
              cx: 0,
              cy: 0,
              rx: 10,
              ry: 5,
              rotation: 0,
              startAngle: 0,
              endAngle: Math.PI / 2
            }
          ]
        }
      }
    ];

    const material: MaterialConfig = {
      width: 900,
      height: 600,
      unit: "mm",
      sheetCount: 1,
      name: "Material"
    };

    const result: NestingResult = {
      placements: [
        {
          pieceId: "pieza-4",
          sheetIndex: 0,
          x: 0,
          y: 0,
          width: 10,
          height: 5,
          rotation: 0
        }
      ],
      unplaced: [],
      usedSheets: 1,
      usedArea: 25,
      wasteArea: 0,
      utilization: 100,
      elapsedMs: 1
    };

    const dxf = buildResultDxf(pieces, material, result);
    expect(dxf).toContain("ELLIPSE");
    expect(dxf).toContain("\n41\n0.000000\n");
    expect(dxf).toContain("\n42\n1.570796\n");
  });

  it("keeps partial ellipse parameters valid when the major axis flips", () => {
    const pieces: PieceItem[] = [
      {
        id: "pieza-5",
        name: "Pieza 05",
        quantity: 1,
        enabled: true,
        sourceFile: "demo.dxf",
        warnings: [],
        geometry: {
          svgMarkup: "",
          width: 12,
          height: 40,
          area: 50,
          sourceBounds: {
            minX: 0,
            minY: 0,
            maxX: 12,
            maxY: 40
          },
          closed: false,
          hasCurves: true,
          hasHoles: false,
          entities: [
            {
              kind: "ellipseArc",
              cx: 0,
              cy: 0,
              rx: 6,
              ry: 20,
              rotation: 0,
              startAngle: 0,
              endAngle: Math.PI / 2
            }
          ]
        }
      }
    ];

    const material: MaterialConfig = {
      width: 900,
      height: 600,
      unit: "mm",
      sheetCount: 1,
      name: "Material"
    };

    const result: NestingResult = {
      placements: [
        {
          pieceId: "pieza-5",
          sheetIndex: 0,
          x: 0,
          y: 0,
          width: 12,
          height: 40,
          rotation: 0
        }
      ],
      unplaced: [],
      usedSheets: 1,
      usedArea: 50,
      wasteArea: 0,
      utilization: 100,
      elapsedMs: 1
    };

    const dxf = buildResultDxf(pieces, material, result);
    expect(dxf).toContain("ELLIPSE");
    expect(dxf).toContain("\n11\n0.0000\n");
    expect(dxf).toContain("\n21\n-20.0000\n");
    expect(dxf).toContain("\n41\n4.712389\n");
    expect(dxf).toContain("\n42\n6.283185\n");
  });

  it("writes model space tables expected by stricter CAD readers", () => {
    const pieces: PieceItem[] = [];
    const material: MaterialConfig = {
      width: 900,
      height: 600,
      unit: "mm",
      sheetCount: 1,
      name: "Material"
    };
    const result: NestingResult = {
      placements: [],
      unplaced: [],
      usedSheets: 1,
      usedArea: 0,
      wasteArea: 0,
      utilization: 0,
      elapsedMs: 1
    };

    const dxf = buildResultDxf(pieces, material, result);
    expect(dxf).toContain("BLOCK_RECORD");
    expect(dxf).toContain("*Model_Space");
    expect(dxf).toContain("*Paper_Space");
    expect(dxf).toContain("AcDbBlockBegin");
  });
});
