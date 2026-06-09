import type { ProjectState } from "../types";

const STORAGE_KEY = "nesting-local-project-v2";

export function saveProject(state: ProjectState) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function loadProject(): ProjectState | null {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as ProjectState;
  } catch {
    return null;
  }
}
