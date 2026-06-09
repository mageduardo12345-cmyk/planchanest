import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  Boxes,
  Copy,
  Download,
  FileUp,
  Gauge,
  Play,
  RefreshCcw,
  Ruler,
  Settings2,
  ShieldCheck,
  Trash2
} from "lucide-react";
import PreviewCanvas from "./components/PreviewCanvas";
import StepsBar from "./components/StepsBar";
import { Button, Card, Label, Metric } from "./components/ui";
import { downloadPdf, downloadSvg } from "./lib/exporters";
import { importFiles } from "./lib/importers";
import { runNesting } from "./lib/nesting";
import { formatArea, formatMeasure } from "./lib/units";
import { useProjectStore } from "./state/useProjectStore";
import type { PieceItem } from "./types";

const presets = [
  { label: "1220 x 2440 mm", width: 1220, height: 2440 },
  { label: "1200 x 2400 mm", width: 1200, height: 2400 },
  { label: "600 x 900 mm", width: 600, height: 900 },
  { label: "900 x 1200 mm", width: 900, height: 1200 }
];

const inputClass =
  "rounded-2xl border border-line bg-white px-4 py-3 text-ink outline-none transition focus:border-accent/50 focus:ring-2 focus:ring-accent/15";

export default function App() {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("Esperando archivos.");
  const store = useProjectStore();

  useEffect(() => {
    if (store.result) {
      setProgress(1);
      setStatus("Resultado listo.");
      return;
    }

    if (store.pieces.length) {
      setProgress(0);
      setStatus("Listo para calcular nesting.");
    }
  }, [store.result, store.pieces.length]);

  async function handleFiles(fileList: FileList | null) {
    if (!fileList?.length) {
      return;
    }

    const files = Array.from(fileList);
    const { pieces, messages } = await importFiles(files);
    store.setPieces(mergePiecesByShape(pieces));
    store.setMessages(messages);
    store.setResult(null);
    store.setStep("piezas");
  }

  async function loadDemo() {
    const response = await fetch("/samples/demo.svg");
    const blob = await response.blob();
    const demo = new File([blob], "demo.svg", { type: "image/svg+xml" });
    const { pieces, messages } = await importFiles([demo]);
    store.setPieces(mergePiecesByShape(pieces));
    store.setMessages(messages);
    store.setResult(null);
    store.setStep("piezas");
  }

  async function startNesting() {
    store.setRunning(true);
    store.setStep("nesting");
    setProgress(0);
    setStatus("Preparando nesting.");
    const result = await runNesting(store.pieces, store.material, store.nesting, (message, value) => {
      setStatus(message);
      setProgress(value);
    });
    store.setResult(result);
    store.setRunning(false);
    store.setStep("resultado");
  }

  const enabledPieces = store.pieces.filter((piece) => piece.enabled);
  const invalidPieces = store.pieces.filter((piece) => piece.warnings.length > 0);

  return (
    <div className="min-h-screen bg-transparent px-4 py-6 text-ink lg:px-8">
      <div className="mx-auto flex max-w-[1520px] flex-col gap-6">
        <header className="grid gap-5 lg:grid-cols-[1.55fr_0.95fr]">
          <Card className="overflow-hidden">
            <div className="flex flex-col gap-6 p-7">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="inline-flex rounded-full border border-accent/35 bg-accent/10 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-accentDeep">
                    Inspirado en Nest&amp;Cut
                  </p>
                  <h1 className="mt-4 max-w-3xl text-3xl font-semibold tracking-tight md:text-5xl">
                    PlanchaNest para CNC y láser con una interfaz más clara y operativa.
                  </h1>
                  <p className="mt-3 max-w-2xl text-sm leading-6 text-ink/68 md:text-base">
                    Importa piezas, revisa geometrías, configura material y genera un acomodo práctico
                    desde una pantalla limpia, sobria y fácil de usar.
                  </p>
                </div>
                <div className="rounded-[22px] border border-accent/30 bg-accent/10 p-4 text-accentDeep">
                  <ShieldCheck size={26} />
                </div>
              </div>

              <div className="flex flex-wrap gap-2 text-xs text-ink/65">
                <span className="rounded-full border border-line bg-[#fafcf8] px-3 py-2">Local primero</span>
                <span className="rounded-full border border-line bg-[#fafcf8] px-3 py-2">SVG y DXF</span>
                <span className="rounded-full border border-line bg-[#fafcf8] px-3 py-2">Parámetros claros</span>
                <span className="rounded-full border border-line bg-[#fafcf8] px-3 py-2">Resultado exportable</span>
              </div>

              <StepsBar current={store.step} />
            </div>
          </Card>

          <Card className="border-shell bg-shell text-white">
            <div className="grid h-full gap-4 p-6">
              <div className="flex items-center gap-3 rounded-[20px] border border-white/10 bg-white/5 px-4 py-4">
                <div className="rounded-full bg-accent p-3 text-[#233117]">
                  <Gauge size={18} />
                </div>
                <div>
                  <p className="text-xs uppercase tracking-[0.18em] text-white/55">Estado del proyecto</p>
                  <p className="mt-1 text-lg font-semibold">Panel rápido de producción</p>
                </div>
              </div>
              <Metric label="Piezas activas" value={enabledPieces.length} tone="accent" />
              <Metric label="Advertencias" value={invalidPieces.length} tone={invalidPieces.length ? "warning" : "default"} />
              <Metric
                label="Área material"
                value={formatArea(store.material.width * store.material.height, store.material.unit)}
              />
            </div>
          </Card>
        </header>

        <main className="grid gap-6 xl:grid-cols-[1.08fr_0.92fr]">
          <div className="flex flex-col gap-6">
            <Card className="p-6">
              <div className="grid gap-4 md:grid-cols-[1.2fr_0.8fr]">
                <div
                  className="rounded-[28px] border border-dashed border-accent/35 bg-gradient-to-br from-white to-[#f4f8ef] p-6"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={(event) => {
                    event.preventDefault();
                    void handleFiles(event.dataTransfer.files);
                  }}
                >
                  <div className="flex h-full flex-col justify-between gap-6">
                    <div>
                      <div className="inline-flex rounded-[20px] border border-accent/30 bg-accent/10 p-3 text-accentDeep">
                        <FileUp size={26} />
                      </div>
                      <h2 className="mt-4 text-2xl font-semibold">Cargar piezas</h2>
                      <p className="mt-2 max-w-xl text-sm leading-6 text-ink/68">
                        Arrastra tus archivos aquí o usa el selector. Esta versión soporta `SVG` y `DXF`
                        localmente. `DWG` queda documentado con conversión previa a `DXF`.
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-3">
                      <input
                        ref={inputRef}
                        type="file"
                        hidden
                        multiple
                        accept=".svg,.dxf,.dwg"
                        onChange={(event) => void handleFiles(event.target.files)}
                      />
                      <Button onClick={() => inputRef.current?.click()}>Cargar piezas</Button>
                      <Button variant="secondary" onClick={() => void loadDemo()}>
                        Cargar demo
                      </Button>
                    </div>

                    <p className="text-xs uppercase tracking-[0.18em] text-ink/45">
                      Formatos: SVG, DXF, DWG
                    </p>
                  </div>
                </div>

                <div className="rounded-[28px] border border-line bg-[#fcfdfb] p-5">
                  <h3 className="flex items-center gap-2 text-lg font-semibold">
                    <AlertCircle size={18} />
                    Estado de importación
                  </h3>
                  <div className="mt-4 space-y-3">
                    {store.messages.length ? (
                      store.messages.map((message, index) => (
                        <p key={`${message}-${index}`} className="rounded-[18px] border border-line/70 bg-white px-3 py-2 text-sm text-ink/72">
                          {message}
                        </p>
                      ))
                    ) : (
                      <p className="text-sm text-ink/55">Todavía no hay mensajes. Puedes empezar con la demo.</p>
                    )}
                  </div>
                </div>
              </div>
            </Card>

            <Card className="p-6">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="flex items-center gap-2 text-2xl font-semibold">
                    <Boxes size={22} />
                    Piezas detectadas
                  </h2>
                  <p className="mt-2 text-sm text-ink/65">
                    Revisa cantidades, activa o desactiva piezas y confirma advertencias antes de acomodar.
                  </p>
                </div>
                <Button variant="ghost" onClick={() => store.setStep("piezas")}>
                  Ver piezas
                </Button>
              </div>

              <div className="mt-5 grid gap-4">
                {store.pieces.length ? (
                  store.pieces.map((piece) => <PieceCard key={piece.id} piece={piece} />)
                ) : (
                  <div className="rounded-[24px] border border-dashed border-line px-5 py-10 text-center text-sm text-ink/55">
                    Aún no hay piezas cargadas.
                  </div>
                )}
              </div>
            </Card>
          </div>

          <div className="flex flex-col gap-6">
            <Card className="p-6">
              <div className="flex items-center gap-2">
                <Ruler size={20} />
                <h2 className="text-2xl font-semibold">Material y configuración</h2>
              </div>

              <div className="mt-5 grid gap-4 md:grid-cols-2">
                <Label title="Ancho">
                  <input
                    className={inputClass}
                    inputMode="decimal"
                    type="number"
                    value={store.material.width}
                    onChange={(event) =>
                      store.setMaterial({ ...store.material, width: Number(event.target.value) || 0 })
                    }
                  />
                </Label>
                <Label title="Alto">
                  <input
                    className={inputClass}
                    inputMode="decimal"
                    type="number"
                    value={store.material.height}
                    onChange={(event) =>
                      store.setMaterial({ ...store.material, height: Number(event.target.value) || 0 })
                    }
                  />
                </Label>
                <Label title="Unidad">
                  <select
                    className={inputClass}
                    value={store.material.unit}
                    onChange={(event) =>
                      store.setMaterial({ ...store.material, unit: event.target.value as typeof store.material.unit })
                    }
                  >
                    <option value="mm">mm</option>
                    <option value="cm">cm</option>
                    <option value="in">pulgadas</option>
                  </select>
                </Label>
                <Label title="Cantidad de placas">
                  <input
                    className={inputClass}
                    type="number"
                    min={1}
                    value={store.material.sheetCount}
                    onChange={(event) =>
                      store.setMaterial({ ...store.material, sheetCount: Math.max(Number(event.target.value) || 1, 1) })
                    }
                  />
                </Label>
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                {presets.map((preset) => (
                  <Button
                    key={preset.label}
                    variant="secondary"
                    className="px-3 py-2 text-xs"
                    onClick={() => store.setMaterial({ ...store.material, width: preset.width, height: preset.height })}
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>

              <div className="mt-6 grid gap-4 md:grid-cols-2">
                <Label title="Margen de pieza">
                  <input
                    className={inputClass}
                    inputMode="decimal"
                    type="number"
                    value={store.nesting.pieceGap}
                    onChange={(event) =>
                      store.setNesting({ ...store.nesting, pieceGap: Number(event.target.value) || 0 })
                    }
                  />
                </Label>
                <Label title="Margen al borde">
                  <input
                    className={inputClass}
                    inputMode="decimal"
                    type="number"
                    value={store.nesting.edgeGap}
                    onChange={(event) =>
                      store.setNesting({ ...store.nesting, edgeGap: Number(event.target.value) || 0 })
                    }
                  />
                </Label>
                <Label title="Kerf">
                  <input
                    className={inputClass}
                    inputMode="decimal"
                    type="number"
                    step="0.01"
                    value={store.nesting.kerf}
                    onChange={(event) =>
                      store.setNesting({ ...store.nesting, kerf: Number(event.target.value) || 0 })
                    }
                  />
                </Label>
                <Label title="Rotaciones">
                  <select
                    className={inputClass}
                    value={store.nesting.rotations}
                    onChange={(event) =>
                      store.setNesting({ ...store.nesting, rotations: event.target.value as typeof store.nesting.rotations })
                    }
                  >
                    <option value="none">Sin rotación</option>
                    <option value="orthogonal">Cada 90°</option>
                    <option value="free45">Cada 45°</option>
                    <option value="free">Rotaciones libres aproximadas</option>
                  </select>
                </Label>
                <Label title="Calidad del nesting">
                  <select
                    className={inputClass}
                    value={store.nesting.quality}
                    onChange={(event) =>
                      store.setNesting({ ...store.nesting, quality: event.target.value as typeof store.nesting.quality })
                    }
                  >
                    <option value="fast">Rápido</option>
                    <option value="balanced">Equilibrado</option>
                    <option value="quality">Calidad</option>
                  </select>
                </Label>
                <Label title="Tiempo máximo">
                  <select
                    className={inputClass}
                    value={store.nesting.maxTimeMs}
                    onChange={(event) =>
                      store.setNesting({ ...store.nesting, maxTimeMs: Number(event.target.value) || 30000 })
                    }
                  >
                    <option value={10000}>10 segundos</option>
                    <option value={30000}>30 segundos</option>
                    <option value={60000}>1 minuto</option>
                    <option value={300000}>5 minutos</option>
                  </select>
                </Label>
              </div>

              <div className="mt-6 flex flex-wrap gap-3">
                <Button onClick={() => void startNesting()} disabled={!store.pieces.length || store.running}>
                  <Play size={16} className="mr-2" />
                  Empezar nesting
                </Button>
                <Button variant="secondary" onClick={() => store.reset()}>
                  <RefreshCcw size={16} className="mr-2" />
                  Reiniciar
                </Button>
              </div>
            </Card>

            <Card className="p-6">
              <div className="flex items-center gap-2">
                <Settings2 size={20} />
                <h2 className="text-2xl font-semibold">Vista previa y resultado</h2>
              </div>

              <div className="mt-5">
                <PreviewCanvas pieces={store.pieces} material={store.material} result={store.result} />
              </div>

              <div className="mt-5 grid gap-3 md:grid-cols-2">
                <Metric
                  label="Aprovechamiento"
                  value={store.result ? `${store.result.utilization.toFixed(1)}%` : "Sin calcular"}
                  tone="accent"
                />
                <Metric
                  label="Placas utilizadas"
                  value={store.result ? store.result.usedSheets : store.material.sheetCount}
                />
                <Metric
                  label="Área ocupada"
                  value={store.result ? formatArea(store.result.usedArea, store.material.unit) : "-"}
                />
                <Metric
                  label="Área desperdiciada"
                  value={store.result ? formatArea(store.result.wasteArea, store.material.unit) : "-"}
                />
              </div>

              <div className="mt-6">
                <div className="h-3 overflow-hidden rounded-full bg-[#dfe8dd]">
                  <div
                    className="h-full rounded-full bg-accent transition-all"
                    style={{ width: `${Math.round(progress * 100)}%` }}
                  />
                </div>
                <div className="mt-3 flex items-center justify-between text-sm text-ink/60">
                  <span>{status}</span>
                  <span>{Math.round(progress * 100)}%</span>
                </div>
              </div>

              <div className="mt-6 flex flex-wrap gap-3">
                <Button
                  variant="secondary"
                  onClick={() => store.result && downloadSvg(store.pieces, store.material, store.result)}
                  disabled={!store.result}
                >
                  <Download size={16} className="mr-2" />
                  Descargar SVG
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => store.result && void downloadPdf(store.pieces, store.material, store.result)}
                  disabled={!store.result}
                >
                  <Download size={16} className="mr-2" />
                  Descargar PDF
                </Button>
              </div>

              {store.result ? (
                <div className="mt-6 grid gap-4 rounded-[24px] border border-line bg-[#fcfdfb] p-4">
                  <div className="grid gap-3 md:grid-cols-2">
                    <Metric label="Piezas acomodadas" value={store.result.placements.length} />
                    <Metric
                      label="Piezas no acomodadas"
                      value={store.result.unplaced.length}
                      tone={store.result.unplaced.length ? "warning" : "default"}
                    />
                  </div>
                  <div className="flex flex-wrap gap-2 text-xs text-ink/65">
                    <span className="rounded-full bg-canvas px-3 py-2">
                      Margen de pieza: {store.nesting.pieceGap} {store.material.unit}
                    </span>
                    <span className="rounded-full bg-canvas px-3 py-2">
                      Margen al borde: {store.nesting.edgeGap} {store.material.unit}
                    </span>
                    <span className="rounded-full bg-canvas px-3 py-2">
                      Kerf: {store.nesting.kerf} {store.material.unit}
                    </span>
                    <span className="rounded-full bg-canvas px-3 py-2">
                      Rotaciones: {rotationLabel(store.nesting.rotations)}
                    </span>
                  </div>
                </div>
              ) : null}
            </Card>
          </div>
        </main>
      </div>
    </div>
  );
}

function PieceCard({ piece }: { piece: PieceItem }) {
  const updatePiece = useProjectStore((state) => state.updatePiece);
  const duplicatePiece = useProjectStore((state) => state.duplicatePiece);
  const removePiece = useProjectStore((state) => state.removePiece);
  const material = useProjectStore((state) => state.material);

  const tooLarge = piece.geometry.width > material.width || piece.geometry.height > material.height;

  return (
    <div className="grid gap-4 rounded-[26px] border border-line bg-[#fcfdfb] p-4 md:grid-cols-[120px_1fr]">
      <div className="flex h-[110px] items-center justify-center rounded-[20px] border border-line/70 bg-canvas p-3">
        <svg viewBox={`0 0 ${piece.geometry.width + 12} ${piece.geometry.height + 12}`} className="h-full w-full">
          <g transform="translate(6 6)" dangerouslySetInnerHTML={{ __html: piece.geometry.svgMarkup }} />
        </svg>
      </div>

      <div className="grid gap-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <input
              className="rounded-xl border border-transparent bg-transparent px-2 py-1 text-lg font-semibold outline-none transition focus:border-line focus:bg-canvas"
              value={piece.name}
              onChange={(event) =>
                updatePiece(piece.id, (current) => ({
                  ...current,
                  name: event.target.value
                }))
              }
            />
            <p className="text-sm text-ink/55">{piece.sourceFile}</p>
          </div>

          <div className="flex flex-wrap gap-2">
            <label className="inline-flex items-center gap-2 rounded-full bg-canvas px-3 py-2 text-sm">
              <input
                type="checkbox"
                checked={piece.enabled}
                onChange={(event) => updatePiece(piece.id, (current) => ({ ...current, enabled: event.target.checked }))}
              />
              Activa
            </label>
            <Button variant="ghost" className="px-3 py-2" onClick={() => duplicatePiece(piece.id)}>
              <Copy size={15} className="mr-2" />
              Duplicar
            </Button>
            <Button variant="ghost" className="px-3 py-2 text-danger" onClick={() => removePiece(piece.id)}>
              <Trash2 size={15} className="mr-2" />
              Eliminar
            </Button>
          </div>
        </div>

        <div className="grid gap-3 md:grid-cols-4">
          <Label title="Cantidad">
            <input
              className={inputClass}
              type="number"
              min={1}
              value={piece.quantity}
              onChange={(event) =>
                updatePiece(piece.id, (current) => ({
                  ...current,
                  quantity: Math.max(Number(event.target.value) || 1, 1)
                }))
              }
            />
          </Label>
          <Metric
            label="Medidas"
            value={`${formatMeasure(piece.geometry.width, material.unit)} x ${formatMeasure(piece.geometry.height, material.unit)}`}
          />
          <Metric label="Área" value={formatArea(piece.geometry.area, material.unit)} />
          <Metric label="Curvas" value={piece.geometry.hasCurves ? "Sí" : "No"} />
        </div>

        <div className="flex flex-wrap gap-2">
          {piece.warnings.map((warning) => (
            <span key={warning} className="rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-warning">
              {warningLabel(warning)}
            </span>
          ))}
          {tooLarge ? (
            <span className="rounded-full bg-rose-50 px-3 py-1 text-xs font-medium text-danger">
              La pieza supera el tamaño del material
            </span>
          ) : null}
          {!piece.warnings.length && !tooLarge ? (
            <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-accentDeep">Válida</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function warningLabel(warning: PieceItem["warnings"][number]) {
  switch (warning) {
    case "open-path":
      return "Contorno abierto";
    case "invalid-shape":
      return "Geometría inválida";
    case "partial-support":
      return "Compatibilidad parcial";
    case "too-large":
      return "Demasiado grande";
    default:
      return "Advertencia";
  }
}

function mergePiecesByShape(pieces: PieceItem[]) {
  const map = new Map<string, PieceItem>();

  pieces.forEach((piece) => {
    const key = `${piece.geometry.width.toFixed(2)}-${piece.geometry.height.toFixed(2)}-${piece.geometry.svgMarkup}`;
    const existing = map.get(key);
    if (existing) {
      existing.quantity += 1;
      return;
    }

    map.set(key, piece);
  });

  return Array.from(map.values());
}

function rotationLabel(value: string) {
  switch (value) {
    case "none":
      return "Sin rotación";
    case "free45":
      return "Cada 45°";
    case "free":
      return "Libres aproximadas";
    default:
      return "Cada 90°";
  }
}
