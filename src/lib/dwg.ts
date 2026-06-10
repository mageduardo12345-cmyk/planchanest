import type { LibreDwg } from "@mlightcad/libredwg-web";

type LibreDwgModule = typeof import("@mlightcad/libredwg-web");

let libreDwgPromise: Promise<LibreDwg> | null = null;
let libreDwgModulePromise: Promise<LibreDwgModule> | null = null;

function getWasmPath() {
  if (typeof window === "undefined") {
    return "./node_modules/@mlightcad/libredwg-web/wasm";
  }

  const base = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
  return `${base.replace(/\/?$/, "/")}libredwg-wasm`;
}

async function getLibreDwg() {
  if (!libreDwgModulePromise) {
    libreDwgModulePromise = import("@mlightcad/libredwg-web");
  }

  if (!libreDwgPromise) {
    libreDwgPromise = libreDwgModulePromise.then((module) => module.LibreDwg.create(getWasmPath()));
  }

  return libreDwgPromise;
}

export async function convertDwgToSvg(fileContent: ArrayBuffer) {
  const module = await (libreDwgModulePromise ?? import("@mlightcad/libredwg-web"));
  const libreDwg = await getLibreDwg();
  const data = libreDwg.dwg_read_data(fileContent, module.Dwg_File_Type.DWG);

  if (!data) {
    throw new Error("No fue posible abrir el DWG.");
  }

  try {
    const database = libreDwg.convert(data);
    return libreDwg.dwg_to_svg(database);
  } finally {
    libreDwg.dwg_free(data);
  }
}
