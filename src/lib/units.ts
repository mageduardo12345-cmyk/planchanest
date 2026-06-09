import type { Unit } from "../types";

const unitScale: Record<Unit, number> = {
  mm: 1,
  cm: 10,
  in: 25.4
};

export function toMm(value: number, unit: Unit): number {
  return value * unitScale[unit];
}

export function fromMm(value: number, unit: Unit): number {
  return value / unitScale[unit];
}

export function formatMeasure(value: number, unit: Unit): string {
  const display = fromMm(value, unit);
  return `${display.toFixed(display >= 100 ? 0 : 2)} ${unit}`;
}

export function formatArea(areaMm2: number, unit: Unit): string {
  const factor = unitScale[unit] * unitScale[unit];
  const display = areaMm2 / factor;
  return `${display.toFixed(display >= 1000 ? 0 : 2)} ${unit}²`;
}
