export type AppStep = "carga" | "piezas" | "material" | "resultado";

export type Unit = "mm" | "cm" | "in";

export type RotationMode = "none" | "orthogonal" | "free45" | "free";

export type QualityMode = "fast" | "balanced" | "quality";

export type GeometryWarning =
  | "open-path"
  | "too-large"
  | "invalid-shape"
  | "partial-support";

export interface PieceGeometry {
  svgMarkup: string;
  width: number;
  height: number;
  area: number;
  sourceBounds: {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  };
  closed: boolean;
  hasCurves: boolean;
  hasHoles: boolean;
}

export interface PieceItem {
  id: string;
  name: string;
  quantity: number;
  enabled: boolean;
  sourceFile: string;
  warnings: GeometryWarning[];
  geometry: PieceGeometry;
}

export interface MaterialConfig {
  width: number;
  height: number;
  unit: Unit;
  sheetCount: number;
  name: string;
  thickness?: number;
}

export interface NestingConfig {
  pieceGap: number;
  edgeGap: number;
  kerf: number;
  rotations: RotationMode;
  quality: QualityMode;
  maxTimeMs: number;
  keepOrientation: boolean;
  prioritizeLarge: boolean;
}

export interface Placement {
  pieceId: string;
  sheetIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

export interface NestingResult {
  placements: Placement[];
  unplaced: string[];
  usedSheets: number;
  usedArea: number;
  wasteArea: number;
  utilization: number;
  elapsedMs: number;
}

export interface ProjectState {
  step: AppStep;
  pieces: PieceItem[];
  material: MaterialConfig;
  nesting: NestingConfig;
  result: NestingResult | null;
  messages: string[];
  running: boolean;
}
