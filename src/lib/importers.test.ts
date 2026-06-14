import { describe, expect, it } from "vitest";
import {
  dxfEntityToGeometry,
  flattenDxfEntities,
  getDxfUnitScaleFactor,
  importDxfText,
  importSvgText,
  mergeConnectedPolylines,
  scaleGeometryEntity,
  splitCompoundPathData,
  transformGeometryEntity
} from "./importers";

function installSimplePathMetrics() {
  const prototype = SVGElement.prototype as SVGElement & {
    getTotalLength?: () => number;
    getPointAtLength?: (distance: number) => DOMPoint;
    getBBox?: () => DOMRect;
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

  prototype.getBBox = function getBBox() {
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

  it("merges connected open polylines into a single closed contour", () => {
    const merged = mergeConnectedPolylines([
      {
        kind: "polyline",
        closed: false,
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 }
        ]
      },
      {
        kind: "polyline",
        closed: false,
        points: [
          { x: 10, y: 0 },
          { x: 10, y: 10 }
        ]
      },
      {
        kind: "polyline",
        closed: false,
        points: [
          { x: 10, y: 10 },
          { x: 0, y: 10 }
        ]
      },
      {
        kind: "polyline",
        closed: false,
        points: [
          { x: 0, y: 10 },
          { x: 0, y: 0 }
        ]
      }
    ]);

    expect(merged).toHaveLength(1);
    expect(merged[0].kind).toBe("polyline");
    if (merged[0].kind !== "polyline") {
      throw new Error("Expected merged polyline");
    }

    expect(merged[0].closed).toBe(true);
    expect(merged[0].points).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 }
    ]);
  });

  it("splits compound SVG paths into separate subpaths", () => {
    expect(splitCompoundPathData("M 0 0 L 10 0 L 10 10 Z M 20 20 L 30 20 L 30 30 Z")).toEqual([
      "M 0 0 L 10 0 L 10 10 Z",
      "M 20 20 L 30 20 L 30 30 Z"
    ]);
  });

  it("imports compound SVG paths as multiple detected pieces when subpaths are separate", () => {
    const svg = [
      "<svg xmlns='http://www.w3.org/2000/svg'>",
      "<path d='M 0 0 L 10 0 L 10 10 L 0 10 Z M 30 0 L 40 0 L 40 10 L 30 10 Z' />",
      "</svg>"
    ].join("");

    const pieces = importSvgText(svg, "compound.svg");

    expect(pieces).toHaveLength(2);
    expect(pieces.every((piece) => piece.geometry.closed)).toBe(true);
  });

  it("keeps separate SVG pieces apart when they are positioned by parent group transforms", () => {
    const svg = [
      "<svg xmlns='http://www.w3.org/2000/svg'>",
      "<g transform='translate(0 0)'><rect x='0' y='0' width='10' height='10' /></g>",
      "<g transform='translate(40 0)'><rect x='0' y='0' width='10' height='10' /></g>",
      "</svg>"
    ].join("");

    const pieces = importSvgText(svg, "group-transform.svg");

    expect(pieces).toHaveLength(2);
    expect(pieces[0].geometry.width).toBeCloseTo(10, 3);
    expect(pieces[1].geometry.width).toBeCloseTo(10, 3);
  });

  it("does not merge nearby SVG pieces that are close but still separated", () => {
    const svg = [
      "<svg xmlns='http://www.w3.org/2000/svg'>",
      "<rect x='0' y='0' width='10' height='10' />",
      "<rect x='10.2' y='0' width='10' height='10' />",
      "</svg>"
    ].join("");

    const pieces = importSvgText(svg, "nearby-separated.svg");

    expect(pieces).toHaveLength(2);
  });

  it("keeps nested SVG contours together when they form a piece with a hole", () => {
    const svg = [
      "<svg xmlns='http://www.w3.org/2000/svg'>",
      "<rect x='0' y='0' width='40' height='40' />",
      "<rect x='10' y='10' width='20' height='20' />",
      "</svg>"
    ].join("");

    const pieces = importSvgText(svg, "hole-piece.svg");

    expect(pieces).toHaveLength(1);
    expect(pieces[0].geometry.hasHoles).toBe(true);
  });

  it("imports rotated SVG geometry from transform attributes as usable closed pieces", () => {
    const svg = [
      "<svg xmlns='http://www.w3.org/2000/svg'>",
      "<g transform='translate(20 20) rotate(45)'>",
      "<rect x='0' y='0' width='20' height='10' />",
      "</g>",
      "</svg>"
    ].join("");

    const pieces = importSvgText(svg, "rotated-group.svg");

    expect(pieces).toHaveLength(1);
    expect(pieces[0].geometry.closed).toBe(true);
    expect(pieces[0].geometry.width).toBeGreaterThan(20);
    expect(pieces[0].geometry.height).toBeGreaterThan(10);
  });

  it("removes duplicated overlapping SVG contours inside the same imported piece", () => {
    const svg = [
      "<svg xmlns='http://www.w3.org/2000/svg'>",
      "<rect x='0' y='0' width='20' height='20' />",
      "<rect x='0' y='0' width='20' height='20' />",
      "</svg>"
    ].join("");

    const pieces = importSvgText(svg, "duplicate-rect.svg");

    expect(pieces).toHaveLength(1);
    expect(pieces[0].geometry.entities).toHaveLength(1);
    expect(pieces[0].geometry.width).toBeCloseTo(20, 3);
    expect(pieces[0].geometry.height).toBeCloseTo(20, 3);
  });

  it("removes nearly duplicated SVG contours created by small coordinate drift", () => {
    const svg = [
      "<svg xmlns='http://www.w3.org/2000/svg'>",
      "<rect x='0' y='0' width='20' height='20' />",
      "<polygon points='0.04,0.03 20.02,0.02 20.01,20.04 0.03,20.01' />",
      "</svg>"
    ].join("");

    const pieces = importSvgText(svg, "near-duplicate.svg");

    expect(pieces).toHaveLength(1);
    expect(pieces[0].geometry.entities).toHaveLength(1);
  });

  it("drops tiny closed SVG contours that are effectively noise", () => {
    const svg = [
      "<svg xmlns='http://www.w3.org/2000/svg'>",
      "<rect x='0' y='0' width='20' height='20' />",
      "<rect x='50' y='50' width='0.05' height='0.05' />",
      "</svg>"
    ].join("");

    const pieces = importSvgText(svg, "tiny-noise.svg");

    expect(pieces).toHaveLength(1);
    expect(pieces[0].geometry.width).toBeCloseTo(20, 3);
    expect(pieces[0].geometry.height).toBeCloseTo(20, 3);
  });

  it("supports SVG line elements as open helper geometry when no closed shapes exist", () => {
    const svg = [
      "<svg xmlns='http://www.w3.org/2000/svg'>",
      "<line x1='0' y1='0' x2='40' y2='0' />",
      "<line x1='40' y1='0' x2='40' y2='20' />",
      "</svg>"
    ].join("");

    const pieces = importSvgText(svg, "lines-only.svg");

    expect(pieces).toHaveLength(1);
    expect(pieces[0].geometry.entities.length).toBeGreaterThan(0);
    expect(pieces[0].geometry.closed).toBe(false);
  });

  it("ignores open helper geometry when importing DXF pieces", () => {
    const dxf = [
      "0",
      "SECTION",
      "2",
      "HEADER",
      "9",
      "$INSUNITS",
      "70",
      "4",
      "0",
      "ENDSEC",
      "0",
      "SECTION",
      "2",
      "ENTITIES",
      "0",
      "LINE",
      "8",
      "0",
      "10",
      "0",
      "20",
      "0",
      "11",
      "50",
      "21",
      "0",
      "0",
      "LWPOLYLINE",
      "8",
      "0",
      "90",
      "4",
      "70",
      "1",
      "10",
      "100",
      "20",
      "100",
      "10",
      "130",
      "20",
      "100",
      "10",
      "130",
      "20",
      "130",
      "10",
      "100",
      "20",
      "130",
      "0",
      "ENDSEC",
      "0",
      "EOF"
    ].join("\n");

    const pieces = importDxfText(dxf, "helpers.dxf");
    expect(pieces).toHaveLength(1);
    expect(pieces[0].geometry.closed).toBe(true);
    expect(pieces[0].geometry.width).toBeCloseTo(30, 3);
    expect(pieces[0].geometry.height).toBeCloseTo(30, 3);
  });
});
