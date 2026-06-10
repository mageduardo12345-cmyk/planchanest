import { runPreparedNesting, type PreparedPiece } from "./nesting";
import type { NestingConfig } from "../types";

type NestingWorkerRequest = {
  type: "run";
  preparedPieces: PreparedPiece[];
  material: { width: number; height: number; sheetCount: number };
  config: NestingConfig;
};

type NestingWorkerResponse =
  | {
      type: "progress";
      message: string;
      value: number;
    }
  | {
      type: "result";
      result: Awaited<ReturnType<typeof runPreparedNesting>>;
    }
  | {
      type: "error";
      message: string;
    };

self.onmessage = async (event: MessageEvent<NestingWorkerRequest>) => {
  if (event.data.type !== "run") {
    return;
  }

  try {
    const result = await runPreparedNesting(
      event.data.preparedPieces,
      event.data.material,
      event.data.config,
      (message, value) => {
        const payload: NestingWorkerResponse = {
          type: "progress",
          message,
          value
        };
        self.postMessage(payload);
      }
    );

    const payload: NestingWorkerResponse = {
      type: "result",
      result
    };
    self.postMessage(payload);
  } catch (error) {
    const payload: NestingWorkerResponse = {
      type: "error",
      message: error instanceof Error ? error.message : "No fue posible completar el anidado."
    };
    self.postMessage(payload);
  }
};
