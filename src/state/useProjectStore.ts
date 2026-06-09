import { create } from "zustand";
import type { AppStep, MaterialConfig, NestingConfig, PieceItem, ProjectState } from "../types";
import { loadProject, saveProject } from "../lib/storage";

const defaultState: ProjectState = {
  step: "carga",
  pieces: [],
  material: {
    width: 1220,
    height: 2440,
    unit: "mm",
    sheetCount: 1,
    name: "Triplay estándar"
  },
  nesting: {
    pieceGap: 5,
    edgeGap: 5,
    kerf: 0.15,
    rotations: "orthogonal",
    quality: "balanced",
    maxTimeMs: 30000,
    keepOrientation: false,
    prioritizeLarge: true
  },
  result: null,
  messages: [],
  running: false
};

type Store = ProjectState & {
  setStep: (step: AppStep) => void;
  setPieces: (pieces: PieceItem[]) => void;
  updatePiece: (pieceId: string, updater: (piece: PieceItem) => PieceItem) => void;
  removePiece: (pieceId: string) => void;
  duplicatePiece: (pieceId: string) => void;
  setMaterial: (material: MaterialConfig) => void;
  setNesting: (nesting: NestingConfig) => void;
  setResult: (result: ProjectState["result"]) => void;
  setMessages: (messages: string[]) => void;
  setRunning: (running: boolean) => void;
  reset: () => void;
};

const persisted = typeof window !== "undefined" ? loadProject() : null;

export const useProjectStore = create<Store>((set, get) => ({
  ...(persisted ?? defaultState),
  setStep: (step) => setAndPersist(set, get, { step }),
  setPieces: (pieces) => setAndPersist(set, get, { pieces }),
  updatePiece: (pieceId, updater) =>
    setAndPersist(set, get, {
      pieces: get().pieces.map((piece) => (piece.id === pieceId ? updater(piece) : piece))
    }),
  removePiece: (pieceId) =>
    setAndPersist(set, get, {
      pieces: get().pieces.filter((piece) => piece.id !== pieceId)
    }),
  duplicatePiece: (pieceId) =>
    setAndPersist(set, get, {
      pieces: get().pieces.map((piece) =>
        piece.id === pieceId ? { ...piece, quantity: piece.quantity + 1 } : piece
      )
    }),
  setMaterial: (material) => setAndPersist(set, get, { material }),
  setNesting: (nesting) => setAndPersist(set, get, { nesting }),
  setResult: (result) => setAndPersist(set, get, { result }),
  setMessages: (messages) => setAndPersist(set, get, { messages }),
  setRunning: (running) => setAndPersist(set, get, { running }),
  reset: () => setAndPersist(set, get, { ...defaultState })
}));

function setAndPersist(
  set: (partial: Partial<Store>) => void,
  get: () => Store,
  partial: Partial<ProjectState>
) {
  set(partial);
  saveProject({
    step: partial.step ?? get().step,
    pieces: partial.pieces ?? get().pieces,
    material: partial.material ?? get().material,
    nesting: partial.nesting ?? get().nesting,
    result: partial.result ?? get().result,
    messages: partial.messages ?? get().messages,
    running: partial.running ?? get().running
  });
}
