import type { GeometryPoint } from "../types";
import "./vendor/clipper.js";

const CLIPPER_SCALE = 1000;

function getClipperLib() {
  return (
    globalThis.ClipperLib ??
    (globalThis as typeof globalThis & { window?: { ClipperLib?: any } }).window?.ClipperLib ??
    (globalThis as typeof globalThis & { self?: { ClipperLib?: any } }).self?.ClipperLib
  );
}

export function hasClipperLib() {
  return Boolean(getClipperLib());
}

function toClipperPath(path: GeometryPoint[]) {
  return path.map((point) => ({
    X: Math.round(point.x * CLIPPER_SCALE),
    Y: Math.round(point.y * CLIPPER_SCALE)
  }));
}

function fromClipperPath(path: Array<{ X: number; Y: number }>) {
  return path.map((point) => ({
    x: point.X / CLIPPER_SCALE,
    y: point.Y / CLIPPER_SCALE
  }));
}

function pathArea(path: GeometryPoint[]) {
  let area = 0;
  for (let index = 0; index < path.length; index += 1) {
    const current = path[index];
    const next = path[(index + 1) % path.length];
    area += current.x * next.y - next.x * current.y;
  }
  return area / 2;
}

export function rectanglePath(minX: number, minY: number, maxX: number, maxY: number): GeometryPoint[] {
  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY }
  ];
}

export function pathBounds(path: GeometryPoint[]) {
  return {
    minX: Math.min(...path.map((point) => point.x)),
    minY: Math.min(...path.map((point) => point.y)),
    maxX: Math.max(...path.map((point) => point.x)),
    maxY: Math.max(...path.map((point) => point.y))
  };
}

export function unionPaths(paths: GeometryPoint[][]) {
  if (!paths.length) {
    return [];
  }

  const ClipperLib = getClipperLib();
  if (!ClipperLib) {
    return paths;
  }
  const clipper = new ClipperLib.Clipper();
  const clipperPaths = paths.map((path) => toClipperPath(path));
  clipper.AddPaths(clipperPaths, ClipperLib.PolyType.ptSubject, true);

  const solution = new ClipperLib.Paths();
  if (
    !clipper.Execute(
      ClipperLib.ClipType.ctUnion,
      solution,
      ClipperLib.PolyFillType.pftNonZero,
      ClipperLib.PolyFillType.pftNonZero
    )
  ) {
    return [];
  }

  return solution.map((path: Array<{ X: number; Y: number }>) => fromClipperPath(path));
}

export function differencePaths(subjectPaths: GeometryPoint[][], clipPaths: GeometryPoint[][]) {
  if (!subjectPaths.length) {
    return [];
  }

  const ClipperLib = getClipperLib();
  if (!ClipperLib) {
    return subjectPaths;
  }
  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(subjectPaths.map((path) => toClipperPath(path)), ClipperLib.PolyType.ptSubject, true);
  if (clipPaths.length) {
    clipper.AddPaths(clipPaths.map((path) => toClipperPath(path)), ClipperLib.PolyType.ptClip, true);
  }

  const solution = new ClipperLib.Paths();
  if (
    !clipper.Execute(
      ClipperLib.ClipType.ctDifference,
      solution,
      ClipperLib.PolyFillType.pftNonZero,
      ClipperLib.PolyFillType.pftNonZero
    )
  ) {
    return [];
  }

  return solution.map((path: Array<{ X: number; Y: number }>) => fromClipperPath(path));
}

export function intersectionPaths(subjectPaths: GeometryPoint[][], clipPaths: GeometryPoint[][]) {
  if (!subjectPaths.length || !clipPaths.length) {
    return [];
  }

  const ClipperLib = getClipperLib();
  if (!ClipperLib) {
    return [];
  }

  const clipper = new ClipperLib.Clipper();
  clipper.AddPaths(subjectPaths.map((path) => toClipperPath(path)), ClipperLib.PolyType.ptSubject, true);
  clipper.AddPaths(clipPaths.map((path) => toClipperPath(path)), ClipperLib.PolyType.ptClip, true);

  const solution = new ClipperLib.Paths();
  if (
    !clipper.Execute(
      ClipperLib.ClipType.ctIntersection,
      solution,
      ClipperLib.PolyFillType.pftNonZero,
      ClipperLib.PolyFillType.pftNonZero
    )
  ) {
    return [];
  }

  return solution.map((path: Array<{ X: number; Y: number }>) => fromClipperPath(path));
}

export function cleanPaths(paths: GeometryPoint[][], distance = 0.001) {
  if (!paths.length) {
    return [];
  }

  const ClipperLib = getClipperLib();
  if (!ClipperLib) {
    return paths;
  }

  const cleaned = ClipperLib.Clipper.CleanPolygons(
    paths.map((path) => toClipperPath(path)),
    distance * CLIPPER_SCALE
  );

  return cleaned.map((path: Array<{ X: number; Y: number }>) => fromClipperPath(path));
}

export function offsetPaths(paths: GeometryPoint[][], delta: number) {
  if (!paths.length) {
    return [];
  }

  const ClipperLib = getClipperLib();
  if (!ClipperLib) {
    return paths;
  }

  const offsetter = new ClipperLib.ClipperOffset(2, 0.25 * CLIPPER_SCALE);
  const normalized = paths
    .filter((path) => path.length >= 3)
    .map((path) => {
      const area = pathArea(path);
      return area >= 0 ? path : path.slice().reverse();
    })
    .map((path) => toClipperPath(path));

  if (!normalized.length) {
    return [];
  }

  offsetter.AddPaths(normalized, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon);
  const solution = new ClipperLib.Paths();
  offsetter.Execute(solution, delta * CLIPPER_SCALE);
  return solution.map((path: Array<{ X: number; Y: number }>) => fromClipperPath(path));
}

export function polygonArea(path: GeometryPoint[]) {
  return Math.abs(pathArea(path));
}
