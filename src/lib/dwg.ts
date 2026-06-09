import { Dwg_File_Type, LibreDwg } from "@mlightcad/libredwg-web";

let libreDwgPromise: Promise<LibreDwg> | null = null;

async function getLibreDwg() {
  if (!libreDwgPromise) {
    libreDwgPromise = LibreDwg.create("/libredwg-wasm");
  }

  return libreDwgPromise;
}

export async function convertDwgToSvg(fileContent: ArrayBuffer) {
  const libreDwg = await getLibreDwg();
  const data = libreDwg.dwg_read_data(fileContent, Dwg_File_Type.DWG);

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
