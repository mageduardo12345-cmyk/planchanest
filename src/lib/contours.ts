import type { GeometryEntity, GeometryPoint } from "../types";

type ProtectedPoint = GeometryPoint & { _protected?: boolean };

function round(n: number) {
  return Math.round(n * 1000) / 1000;
}

function distanceSquared(a: GeometryPoint, b: GeometryPoint) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function segmentDistanceSquared(point: GeometryPoint, start: GeometryPoint, end: GeometryPoint) {
  let x = start.x;
  let y = start.y;
  const dx = end.x - x;
  const dy = end.y - y;

  if (dx !== 0 || dy !== 0) {
    const t = ((point.x - x) * dx + (point.y - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = end.x;
      y = end.y;
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }

  const px = point.x - x;
  const py = point.y - y;
  return px * px + py * py;
}

function simplifyRadialDistance(points: ProtectedPoint[], sqTolerance: number) {
  const first = points[0];
  if (!first) {
    return [];
  }

  const result: ProtectedPoint[] = [first];
  let previous = first;

  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    if (point._protected || distanceSquared(point, previous) > sqTolerance) {
      result.push(point);
      previous = point;
    }
  }

  const last = points[points.length - 1];
  if (last && last !== previous) {
    result.push(last);
  }

  return result;
}

function simplifyDouglasPeuckerStep(
  points: ProtectedPoint[],
  first: number,
  last: number,
  sqTolerance: number,
  simplified: ProtectedPoint[]
) {
  let maxSqDistance = sqTolerance;
  let splitIndex = -1;
  let protectedIndex = -1;

  for (let index = first + 1; index < last; index += 1) {
    if (points[index]._protected && protectedIndex === -1) {
      protectedIndex = index;
    }
    const sqDistance = segmentDistanceSquared(points[index], points[first], points[last]);
    if (sqDistance > maxSqDistance) {
      splitIndex = index;
      maxSqDistance = sqDistance;
    }
  }

  if (splitIndex === -1 && protectedIndex > -1) {
    splitIndex = protectedIndex;
  }

  if (splitIndex > -1) {
    if (splitIndex - first > 1) {
      simplifyDouglasPeuckerStep(points, first, splitIndex, sqTolerance, simplified);
    }
    simplified.push(points[splitIndex]);
    if (last - splitIndex > 1) {
      simplifyDouglasPeuckerStep(points, splitIndex, last, sqTolerance, simplified);
    }
  }
}

function simplifyDouglasPeucker(points: GeometryPoint[], sqTolerance: number) {
  if (points.length <= 2) {
    return points.slice();
  }

  const last = points.length - 1;
  const simplified: GeometryPoint[] = [points[0]];
  simplifyDouglasPeuckerStep(points, 0, last, sqTolerance, simplified);
  simplified.push(points[last]);
  return simplified;
}

function markProtectedLongSegments(points: GeometryPoint[], tolerance: number, closed: boolean) {
  const protectedPoints = points.map((point) => ({ ...point })) as ProtectedPoint[];
  const segmentThresholdSquared = Math.max(tolerance * tolerance * 1600, 1);
  const segmentCount = closed ? protectedPoints.length : Math.max(protectedPoints.length - 1, 0);

  for (let index = 0; index < segmentCount; index += 1) {
    const nextIndex = (index + 1) % protectedPoints.length;
    const start = protectedPoints[index];
    const end = protectedPoints[nextIndex];
    if (distanceSquared(start, end) >= segmentThresholdSquared) {
      start._protected = true;
      end._protected = true;
    }
  }

  if (!closed && protectedPoints.length) {
    protectedPoints[0]._protected = true;
    protectedPoints[protectedPoints.length - 1]._protected = true;
  }

  return protectedPoints;
}

function signedArea(a: GeometryPoint, b: GeometryPoint, c: GeometryPoint) {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function rotateClosedPolylineStart(points: GeometryPoint[], target: GeometryPoint) {
  if (!points.length) {
    return points;
  }

  let bestIndex = 0;
  let bestDistance = distanceSquared(points[0], target);

  for (let index = 1; index < points.length; index += 1) {
    const currentDistance = distanceSquared(points[index], target);
    if (currentDistance < bestDistance) {
      bestDistance = currentDistance;
      bestIndex = index;
    }
  }

  if (bestIndex === 0) {
    return points;
  }

  return points.slice(bestIndex).concat(points.slice(0, bestIndex));
}

export function dedupePoints(points: GeometryPoint[], tolerance = 0.001) {
  const result: GeometryPoint[] = [];
  const sqTolerance = tolerance * tolerance;

  points.forEach((point) => {
    const previous = result[result.length - 1];
    if (!previous || distanceSquared(point, previous) > sqTolerance) {
      result.push({ x: round(point.x), y: round(point.y) });
    }
  });

  return result;
}

export function removeCollinearPoints(points: GeometryPoint[], tolerance = 0.001, closed = false) {
  if (points.length < (closed ? 4 : 3)) {
    return points.slice();
  }

  const result = points.slice();
  let changed = true;

  while (changed && result.length >= (closed ? 4 : 3)) {
    changed = false;

    for (let index = 0; index < result.length; index += 1) {
      if (!closed && (index === 0 || index === result.length - 1)) {
        continue;
      }

      const previous = result[(index - 1 + result.length) % result.length];
      const current = result[index];
      const next = result[(index + 1) % result.length];
      if (Math.abs(signedArea(previous, current, next)) <= tolerance) {
        result.splice(index, 1);
        changed = true;
        break;
      }
    }
  }

  return result.map((point) => ({ x: round(point.x), y: round(point.y) }));
}

export function simplifyPolyline(points: GeometryPoint[], tolerance = 0.35, closed = false) {
  if (points.length <= (closed ? 3 : 2)) {
    return dedupePoints(points);
  }

  const normalized = dedupePoints(points);
  if (normalized.length <= (closed ? 3 : 2)) {
    return normalized;
  }

  const protectedPoints = markProtectedLongSegments(normalized, tolerance, closed);
  const working = closed
    ? protectedPoints.concat([{ ...protectedPoints[0], _protected: protectedPoints[0]?._protected }])
    : protectedPoints.slice();
  const sqTolerance = tolerance * tolerance;
  const radial = simplifyRadialDistance(working, sqTolerance);
  const simplified = simplifyDouglasPeucker(radial, sqTolerance);
  const trimmed = closed ? simplified.slice(0, -1) : simplified;
  const cleaned = removeCollinearPoints(
    trimmed.map((point) => ({ x: point.x, y: point.y })),
    tolerance,
    closed
  );

  return closed ? rotateClosedPolylineStart(cleaned, normalized[0]) : cleaned;
}

export function normalizePolylineEntity(entity: Extract<GeometryEntity, { kind: "polyline" }>, tolerance = 0.35) {
  const simplified = simplifyPolyline(entity.points, tolerance, entity.closed);
  return {
    ...entity,
    points: simplified
  };
}
