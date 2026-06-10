import { runNesting } from "./nesting";
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

  const promise = new Promise<NestingResult>((resolve, reject) => {
    rejectPromise = reject;

    // Temporary stable path: the nesting core still samples SVG geometry with DOM APIs,
    // so running it inside a worker breaks on real browsers where `document` is unavailable.
    setTimeout(async () => {
      if (settled) {
        return;
      }

      try {
        const result = await runNesting(pieces, material, config, (message, value) => {
          if (!settled) {
            onProgress?.(message, value);
          }
        });

        if (settled) {
          return;
        }

        settled = true;
        resolve(result);
      } catch (error) {
        if (settled) {
          return;
        }

        settled = true;
        reject(error instanceof Error ? error : new Error("No fue posible completar el anidado."));
      }
    }, 0);
  });

  return {
    promise,
    cancel() {
      if (settled) {
        return;
      }

      settled = true;
      rejectPromise?.(new Error("Anidado cancelado."));
    }
  };
}
