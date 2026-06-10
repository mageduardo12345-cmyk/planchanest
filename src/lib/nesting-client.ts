import { preparePiecesForNesting } from "./nesting";
import type { NestingConfig, NestingResult, PieceItem } from "../types";

export interface NestingRunHandle {
  cancel: () => void;
  promise: Promise<NestingResult>;
}

export function runNestingInWorker(
  pieces: PieceItem[],
  material: { width: number; height: number; sheetCount: number },
  config: NestingConfig,
  onProgress?: (message: string, value: number) => void
): NestingRunHandle {
  let settled = false;
  let rejectPromise: ((reason?: unknown) => void) | null = null;
  const preparedPieces = preparePiecesForNesting(pieces, config);
  const worker = new Worker(new URL("./nesting.worker.ts", import.meta.url), { type: "module" });

  const promise = new Promise<NestingResult>((resolve, reject) => {
    rejectPromise = reject;
    worker.onmessage = (event: MessageEvent<
      | { type: "progress"; message: string; value: number }
      | { type: "result"; result: NestingResult }
      | { type: "error"; message: string }
    >) => {
      if (event.data.type === "progress") {
        onProgress?.(event.data.message, event.data.value);
        return;
      }

      if (settled) {
        return;
      }

      settled = true;
      worker.terminate();

      if (event.data.type === "result") {
        resolve(event.data.result);
        return;
      }

      reject(new Error(event.data.message));
    };

    worker.onerror = () => {
      if (settled) {
        return;
      }

      settled = true;
      worker.terminate();
      reject(new Error("No fue posible iniciar el proceso de anidado."));
    };

    worker.postMessage({
      type: "run",
      preparedPieces,
      material,
      config
    });
  });

  return {
    promise,
    cancel() {
      if (settled) {
        return;
      }

      settled = true;
      worker.terminate();
      rejectPromise?.(new Error("Anidado cancelado."));
    }
  };
}
