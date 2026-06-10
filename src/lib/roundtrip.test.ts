import DxfParser from "dxf-parser";
import { describe, expect, it } from "vitest";
import { buildResultDxf } from "./exporters";
import { importDxfText } from "./importers";
import type { MaterialConfig, NestingResult } from "../types";

function installSimpleSvgMetrics() {
  const pathPrototype = SVGElement.prototype as SVGElement & {
    getTotalLength?: () => number;
    getPointAtLength?: (distance: number) => DOMPoint;
    getBBox?: () => DOMRect;
  };

  pathPrototype.getTotalLength = function getTotalLength() {
    const d = this.getAttribute("d") ?? "";
    const values = d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
    if (values.length < 4) {
      return 0;
    }
    let total = 0;
    for (let index = 0; index <= values.length - 4; index += 2) {
      total += Math.hypot(values[index + 2] - values[index], values[index + 3] - values[index + 1]);
    }
    return total;
  };

  pathPrototype.getPointAtLength = function getPointAtLength(distance: number) {
    const d = this.getAttribute("d") ?? "";
    const values = d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
    const segments: Array<{ x1: number; y1: number; x2: number; y2: number; length: number }> = [];
    for (let index = 0; index <= values.length - 4; index += 2) {
      const x1 = values[index];
      const y1 = values[index + 1];
      const x2 = values[index + 2];
      const y2 = values[index + 3];
      segments.push({ x1, y1, x2, y2, length: Math.hypot(x2 - x1, y2 - y1) });
    }

    let remaining = distance;
    for (const segment of segments) {
      if (remaining <= segment.length) {
        const ratio = segment.length ? remaining / segment.length : 0;
        return {
          x: segment.x1 + (segment.x2 - segment.x1) * ratio,
          y: segment.y1 + (segment.y2 - segment.y1) * ratio
        } as DOMPoint;
      }
      remaining -= segment.length;
    }

    const last = segments[segments.length - 1];
    return { x: last?.x2 ?? 0, y: last?.y2 ?? 0 } as DOMPoint;
  };

  pathPrototype.getBBox = function getBBox() {
    const tag = this.tagName.toLowerCase();

    if (tag === "circle") {
      const cx = Number(this.getAttribute("cx") ?? 0);
      const cy = Number(this.getAttribute("cy") ?? 0);
      const r = Number(this.getAttribute("r") ?? 0);
      return { x: cx - r, y: cy - r, width: r * 2, height: r * 2 } as DOMRect;
    }

    if (tag === "ellipse") {
      const cx = Number(this.getAttribute("cx") ?? 0);
      const cy = Number(this.getAttribute("cy") ?? 0);
      const rx = Number(this.getAttribute("rx") ?? 0);
      const ry = Number(this.getAttribute("ry") ?? 0);
      return { x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2 } as DOMRect;
    }

    if (tag === "polyline" || tag === "polygon") {
      const points = (this.getAttribute("points") ?? "")
        .trim()
        .split(/\s+/)
        .map((pair) => pair.split(",").map(Number))
        .filter((pair) => pair.length === 2 && pair.every((value) => Number.isFinite(value)));
      const xs = points.map(([x]) => x);
      const ys = points.map(([, y]) => y);
      return {
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys)
      } as DOMRect;
    }

    const d = this.getAttribute("d") ?? "";
    const values = d.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [0, 0];
    const xs = values.filter((_, index) => index % 2 === 0);
    const ys = values.filter((_, index) => index % 2 === 1);
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      width: Math.max(...xs) - Math.min(...xs),
      height: Math.max(...ys) - Math.min(...ys)
    } as DOMRect;
  };
}

describe("DXF roundtrip", () => {
  installSimpleSvgMetrics();

  it("imports a block-based DXF and exports a readable DXF again", () => {
    const dxf = [
      "0","SECTION","2","BLOCKS",
      "0","BLOCK","2","PIEZA1",
      "0","LWPOLYLINE","90","2","70","0","10","0","20","0","42","1","10","10","20","0",
      "0","LINE","10","10","20","0","11","10","21","10",
      "0","ENDBLK",
      "0","ENDSEC",
      "0","SECTION","2","ENTITIES",
      "0","INSERT","2","PIEZA1","10","25","20","15","41","1","42","1","50","0",
      "0","ENDSEC",
      "0","EOF"
    ].join("\n");

    const pieces = importDxfText(dxf, "fixture.dxf");
    expect(pieces.length).toBeGreaterThan(0);
    expect(pieces[0].geometry.entities.length).toBeGreaterThan(0);

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
          pieceId: pieces[0].id,
          sheetIndex: 0,
          x: 0,
          y: 0,
          width: pieces[0].geometry.width,
          height: pieces[0].geometry.height,
          rotation: 0
        }
      ],
      unplaced: [],
      usedSheets: 1,
      usedArea: pieces[0].geometry.area,
      wasteArea: 0,
      utilization: 100,
      elapsedMs: 1
    };

    const exported = buildResultDxf(pieces, material, result);
    const reparsed = new DxfParser().parseSync(exported);
    expect(reparsed).not.toBeNull();
    if (!reparsed) {
      throw new Error("Expected reparsed DXF data");
    }

    expect(exported).toContain("SECTION");
    expect(reparsed.entities.length).toBeGreaterThan(0);
    expect(
      reparsed.entities.some((entity: { type?: string }) => entity.type === "LWPOLYLINE" || entity.type === "ARC")
    ).toBe(true);
  });
});
