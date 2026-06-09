export function slugId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 9)}`;
}

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
