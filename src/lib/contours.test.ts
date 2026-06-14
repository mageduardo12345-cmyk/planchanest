import { describe, expect, it } from "vitest";
import { dedupePoints, normalizePolylineEntity, removeCollinearPoints, simplifyPolyline } from "./contours";

describe("contour cleanup", () => {
  it("removes duplicate consecutive points", () => {
    const cleaned = dedupePoints([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 0.0000001 },
      { x: 10, y: 10 }
    ]);

    expect(cleaned).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 }
    ]);
  });

  it("removes collinear middle points from closed loops", () => {
    const cleaned = removeCollinearPoints(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 20 },
        { x: 0, y: 20 }
      ],
      0.001,
      true
    );

    expect(cleaned).toEqual([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
      { x: 0, y: 20 }
    ]);
  });

  it("simplifies noisy open polylines while keeping endpoints", () => {
    const cleaned = simplifyPolyline(
      [
        { x: 0, y: 0 },
        { x: 5, y: 0.01 },
        { x: 10, y: -0.01 },
        { x: 15, y: 0.02 },
        { x: 20, y: 0 }
      ],
      0.2,
      false
    );

    expect(cleaned[0]).toEqual({ x: 0, y: 0 });
    expect(cleaned[cleaned.length - 1]).toEqual({ x: 20, y: 0 });
    expect(cleaned.length).toBeLessThan(5);
  });

  it("keeps important long-segment corners under aggressive simplification", () => {
    const cleaned = simplifyPolyline(
      [
        { x: 0, y: 0 },
        { x: 80, y: 0 },
        { x: 82, y: 1 },
        { x: 84, y: 3 },
        { x: 85, y: 40 }
      ],
      12,
      false
    );

    expect(cleaned).toContainEqual({ x: 80, y: 0 });
    expect(cleaned[0]).toEqual({ x: 0, y: 0 });
    expect(cleaned[cleaned.length - 1]).toEqual({ x: 85, y: 40 });
  });

  it("normalizes polyline entities through cleanup", () => {
    const entity = normalizePolylineEntity({
      kind: "polyline",
      closed: true,
      points: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 20 },
        { x: 0, y: 20 },
        { x: 0, y: 0 }
      ]
    });

    expect(entity.points).toEqual([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 20 },
      { x: 0, y: 20 }
    ]);
  });
});
