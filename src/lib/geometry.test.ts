import { describe, expect, it } from "vitest";
import { getGeometrySignature } from "./geometry";
import type { PieceGeometry } from "../types";

describe("geometry signatures", () => {
  it("matches equivalent polylines with the same normalized geometry", () => {
    const first: PieceGeometry = {
      svgMarkup: "<polygon points='10,10 30,10 30,30 10,30' />",
      width: 20,
      height: 20,
      area: 400,
      sourceBounds: { minX: 10, minY: 10, maxX: 30, maxY: 30 },
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
    };

    const second: PieceGeometry = {
      svgMarkup: "<polygon points='100,100 120,100 120,120 100,120' />",
      width: 20,
      height: 20,
      area: 400,
      sourceBounds: { minX: 100, minY: 100, maxX: 120, maxY: 120 },
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
    };

    expect(getGeometrySignature(first)).toBe(getGeometrySignature(second));
  });

  it("distinguishes different geometry even if dimensions are similar", () => {
    const rectangle: PieceGeometry = {
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
    };

    const circle: PieceGeometry = {
      svgMarkup: "",
      width: 20,
      height: 20,
      area: 314.159,
      sourceBounds: { minX: 0, minY: 0, maxX: 20, maxY: 20 },
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
    };

    expect(getGeometrySignature(rectangle)).not.toBe(getGeometrySignature(circle));
  });
});
