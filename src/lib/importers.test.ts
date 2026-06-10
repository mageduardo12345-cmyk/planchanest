import { describe, expect, it } from "vitest";
import {
  dxfEntityToGeometry,
  flattenDxfEntities,
  getDxfUnitScaleFactor,
  scaleGeometryEntity,
  transformGeometryEntity
} from "./importers";

function installSimplePathMetrics() {
  const prototype = SVGElement.prototype as SVGElement & {
    getTotalLength?: () => number;
    getPointAtLength?: (distance: number) => DOMPoint;
  };

  prototype.getTotalLength = function getTotalLength() {
    const d = this.getAttribute("d") ?? "";
    const points = d
      .match(/-?\d+(\.\d+)?/g)
      ?.map(Number) ?? [];

    if (points.length < 4) {
      return 0;
    }

    let total = 0;
    for (let index = 0; index <= points.length - 4; index += 2) {
      total += Math.hypot(points[index + 2] - points[index], points[index + 3] - points[index + 1]);
    }
    return total;
  };

  prototype.getPointAtLength = function getPointAtLength(distance: number) {
    const d = this.getAttribute("d") ?? "";
    const values = d
      .match(/-?\d+(\.\d+)?/g)
      ?.map(Number) ?? [];

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
}

describe("DXF import helpers", () => {
  installSimplePathMetrics();

  it("preserves bulge segments as arc paths instead of flattening them", () => {
    const result = dxfEntityToGeometry({
      type: "LWPOLYLINE",
      shape: false,
      vertices: [
        { x: 0, y: 0, bulge: 1 },
        { x: 10, y: 0 }
      ]
    });

    expect(result.geometry?.kind).toBe("path");
    if (result.geometry?.kind !== "path") {
      throw new Error("Expected path geometry");
    }

    expect(result.geometry.d).toContain("A");
    expect(result.geometry.closed).toBe(false);
  });

  it("expands INSERT blocks and transforms nested geometry", () => {
    const flattened = flattenDxfEntities(
      [
        {
          type: "INSERT",
          name: "pieza_base",
          position: { x: 100, y: 50 },
          rotation: 90,
          xScale: 1,
          yScale: 1
        }
      ],
      {
        pieza_base: {
          entities: [
            {
              type: "LINE",
              vertices: [
                { x: 0, y: 0 },
                { x: 10, y: 0 }
              ]
            }
          ]
        }
      },
      false
    );

    expect(flattened).toHaveLength(1);
    expect(flattened[0].partial).toBe(true);
    expect(flattened[0].geometry.kind).toBe("polyline");
    if (flattened[0].geometry.kind !== "polyline") {
      throw new Error("Expected polyline geometry");
    }

    const [start, end] = flattened[0].geometry.points;
    expect(start.x).toBeCloseTo(100, 3);
    expect(start.y).toBeCloseTo(-50, 3);
    expect(end.x).toBeCloseTo(100, 3);
    expect(end.y).toBeCloseTo(-40, 3);
  });

  it("transforms path-based geometry inside INSERT-like operations", () => {
    const transformed = transformGeometryEntity(
      {
        kind: "path",
        d: "M 0 0 L 10 0 L 10 10 Z",
        closed: true
      },
      { x: 25, y: -10 },
      2,
      1,
      90
    );

    expect(transformed.kind).toBe("polyline");
    if (transformed.kind !== "polyline") {
      throw new Error("Expected transformed polyline");
    }

    expect(transformed.closed).toBe(true);
    expect(transformed.points.length).toBeGreaterThan(10);
    expect(transformed.points[0].x).toBeCloseTo(25, 1);
    expect(transformed.points[0].y).toBeCloseTo(-10, 1);
  });

  it("maps DXF units to millimeter scale factors for CAD-sized imports", () => {
    expect(getDxfUnitScaleFactor(1)).toBeCloseTo(25.4, 6);
    expect(getDxfUnitScaleFactor(5)).toBeCloseTo(10, 6);
    expect(getDxfUnitScaleFactor(4)).toBeCloseTo(1, 6);
    expect(getDxfUnitScaleFactor(0)).toBeCloseTo(1, 6);
  });

  it("scales imported DXF geometry into millimeters when the source file uses other units", () => {
    const scaled = scaleGeometryEntity(
      {
        kind: "circle",
        cx: 2,
        cy: -1,
        r: 0.5
      },
      getDxfUnitScaleFactor(1)
    );

    expect(scaled.kind).toBe("circle");
    if (scaled.kind !== "circle") {
      throw new Error("Expected scaled circle geometry");
    }

    expect(scaled.cx).toBeCloseTo(50.8, 4);
    expect(scaled.cy).toBeCloseTo(-25.4, 4);
    expect(scaled.r).toBeCloseTo(12.7, 4);
  });

  it("preserves DXF ellipse rotation from the major axis direction", () => {
    const result = dxfEntityToGeometry({
      type: "ELLIPSE",
      center: { x: 0, y: 0 },
      majorAxisEndPoint: { x: 10, y: 10 },
      axisRatio: 0.5
    });

    expect(result.partial).toBe(false);
    expect(result.geometry?.kind).toBe("ellipse");
    if (result.geometry?.kind !== "ellipse") {
      throw new Error("Expected ellipse geometry");
    }

    expect(result.geometry.rx).toBeCloseTo(Math.hypot(10, 10), 6);
    expect(result.geometry.ry).toBeCloseTo(Math.hypot(10, 10) * 0.5, 6);
    expect(result.geometry.rotation).toBeCloseTo(-Math.PI / 4, 6);
  });

  it("keeps partial DXF ellipses trimmed instead of converting them into full ellipses", () => {
    const result = dxfEntityToGeometry({
      type: "ELLIPSE",
      center: { x: 0, y: 0 },
      majorAxisEndPoint: { x: 10, y: 0 },
      axisRatio: 0.5,
      startAngle: 0,
      endAngle: Math.PI / 2
    });

    expect(result.partial).toBe(false);
    expect(result.geometry?.kind).toBe("ellipseArc");
    if (result.geometry?.kind !== "ellipseArc") {
      throw new Error("Expected ellipseArc geometry for trimmed ellipse");
    }

    expect(result.geometry.rx).toBeCloseTo(10, 6);
    expect(result.geometry.ry).toBeCloseTo(5, 6);
    expect(result.geometry.startAngle).toBeCloseTo(0, 6);
    expect(result.geometry.endAngle).toBeCloseTo(Math.PI / 2, 6);
  });
});
