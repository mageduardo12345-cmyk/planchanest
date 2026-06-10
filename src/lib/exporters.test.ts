import { describe, expect, it } from "vitest";
import { buildResultDxf } from "./exporters";
import type { MaterialConfig, NestingResult, PieceItem } from "../types";

describe("DXF export", () => {
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
