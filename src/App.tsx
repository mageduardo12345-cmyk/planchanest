import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  Boxes,
  Download,
  FileUp,
  Gauge,
  Play,
  RefreshCcw,
  Ruler,
  Settings2,
  Trash2
} from "lucide-react";
import PreviewCanvas from "./components/PreviewCanvas";
import StepsBar from "./components/StepsBar";
import { Button, Card, Label, Metric } from "./components/ui";
import { downloadPdf, downloadSvg } from "./lib/exporters";
import { normalizeSvgMarkup } from "./lib/geometry";
import { importFiles } from "./lib/importers";
import { runNesting } from "./lib/nesting";
import { formatArea, formatMeasure } from "./lib/units";
import { useProjectStore } from "./state/useProjectStore";
import type { AppStep, PieceItem } from "./types";

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
      setStatus("Listo para continuar con el flujo.");
    } else {
      setProgress(0);
      setStatus("Esperando archivos.");
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
    setProgress(0);
    setStatus("Preparando anidado.");
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
  const canContinueFromPieces = enabledPieces.length > 0;
  const canContinueFromMaterial =
    canContinueFromPieces && store.material.width > 0 && store.material.height > 0;
  const resultMetrics = store.result
    ? [
        { label: "Aprovechamiento", value: `${store.result.utilization.toFixed(1)}%`, tone: "accent" as const },
        { label: "Placas usadas", value: store.result.usedSheets, tone: "default" as const },
        { label: "Piezas acomodadas", value: store.result.placements.length, tone: "default" as const },
        {
          label: "Sin acomodar",
          value: store.result.unplaced.length,
          tone: store.result.unplaced.length ? ("warning" as const) : ("default" as const)
        }
      ]
    : null;

  function goToStep(step: AppStep) {
    store.setStep(step);
  }

  return (
    <div className="min-h-screen bg-transparent px-4 py-6 text-ink lg:px-8">
      <div className="mx-auto flex max-w-[1640px] flex-col gap-6">
        <header className="grid gap-5 lg:grid-cols-[1.45fr_0.55fr]">
          <Card className="overflow-hidden">
            <div className="flex flex-col gap-6 p-7">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="inline-flex rounded-full border border-accent/35 bg-accent/10 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-accentDeep">
                    Flujo por etapas
                  </p>
                  <h1 className="mt-4 max-w-3xl text-3xl font-semibold tracking-tight md:text-5xl">
                    PlanchaNest
                  </h1>
                  <p className="mt-3 max-w-2xl text-sm leading-6 text-ink/68 md:text-base">
                    Sube tus archivos, elige las piezas y cantidades, ajusta el material y genera el
                    anidado antes de descargar el resultado final.
                  </p>
                </div>
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
                  <p className="text-xs uppercase tracking-[0.18em] text-white/55">Resumen rápido</p>
                  <p className="mt-1 text-lg font-semibold">Estado actual del proyecto</p>
                </div>
              </div>
              <Metric label="Piezas activas" value={enabledPieces.length} tone="accent" />
              <Metric
                label="Advertencias"
                value={invalidPieces.length}
                tone={invalidPieces.length ? "warning" : "default"}
              />
              <Metric
                label="Área material"
                value={formatArea(store.material.width * store.material.height, store.material.unit)}
              />
            </div>
          </Card>
        </header>

        <main className="flex flex-col gap-6">
          {store.step === "carga" ? (
            <Card className="p-6">
              <div className="grid gap-4 md:grid-cols-[1.25fr_0.75fr]">
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
                      <h2 className="mt-4 text-2xl font-semibold">Paso 1. Cargar archivos</h2>
                      <p className="mt-2 max-w-xl text-sm leading-6 text-ink/68">
                        Arrastra tus archivos aquí o usa el selector. Puedes trabajar con `SVG`,
                        `DXF` y también `DWG`.
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
                      <Button onClick={() => inputRef.current?.click()}>Subir archivos</Button>
                      <Button variant="secondary" onClick={() => void loadDemo()}>
                        Cargar demo
                      </Button>
                    </div>

                    <p className="text-xs uppercase tracking-[0.18em] text-ink/45">
                      Formatos admitidos: SVG, DXF, DWG
                    </p>
                  </div>
                </div>

                <div className="rounded-[28px] border border-line bg-[#fcfdfb] p-5">
                  <h3 className="flex items-center gap-2 text-lg font-semibold">
                    <AlertCircle size={18} />
                    Notas de importación
                  </h3>
                  <div className="mt-4 space-y-3">
                    <p className="rounded-[18px] border border-line/70 bg-white px-3 py-3 text-sm text-ink/72">
                      `DWG` ya se intenta abrir directo dentro de la app usando un lector local en
                      navegador.
                    </p>
                    <p className="rounded-[18px] border border-line/70 bg-white px-3 py-3 text-sm text-ink/72">
                      Si un `DWG` trae objetos o versiones no compatibles, la mejor salida sigue
                      siendo guardarlo como `DXF` y volverlo a subir.
                    </p>
                    {store.messages.map((message, index) => (
                      <p
                        key={`${message}-${index}`}
                        className="rounded-[18px] border border-line/70 bg-white px-3 py-2 text-sm text-ink/72"
                      >
                        {message}
                      </p>
                    ))}
                  </div>
                </div>
              </div>
            </Card>
          ) : null}

          {store.step === "piezas" ? (
            <Card className="p-6">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h2 className="flex items-center gap-2 text-2xl font-semibold">
                    <Boxes size={22} />
                    Paso 2. Elegir piezas y cantidades
                  </h2>
                  <p className="mt-2 text-sm text-ink/65">
                    Revisa las piezas cargadas, ajusta cantidades y deja lista la selección antes de
                    pasar al material.
                  </p>
                </div>
              </div>

              <div className="sticky top-4 z-10 mt-5 rounded-[22px] border border-line bg-white/95 p-4 shadow-panel backdrop-blur">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="text-sm text-ink/65">
                    Ajusta aquí tus piezas y luego continúa al siguiente paso.
                  </div>
                  <div className="flex flex-wrap gap-3">
                    <Button variant="secondary" onClick={() => goToStep("carga")}>
                      <ArrowLeft size={16} className="mr-2" />
                      Volver a carga
                    </Button>
                    <Button onClick={() => goToStep("material")} disabled={!canContinueFromPieces}>
                      Continuar a material
                      <ArrowRight size={16} className="ml-2" />
                    </Button>
                  </div>
                </div>
              </div>

              <div className="mt-5 overflow-auto rounded-[28px] border border-line bg-white">
                <div className="min-w-[1120px]">
                  <div className="grid grid-cols-[72px_minmax(360px,1.7fr)_minmax(260px,1fr)_minmax(170px,0.65fr)_minmax(170px,0.65fr)] items-center border-b border-line bg-[#fbfcfa] px-4 py-4 text-sm font-semibold uppercase tracking-[0.06em] text-ink/80">
                    <div className="flex justify-center">
                      <span className="h-6 w-6 rounded-md border border-line bg-white" />
                    </div>
                    <div>Filename</div>
                    <div>Cantidad</div>
                    <div>Longitud</div>
                    <div>Altura</div>
                  </div>

                  {store.pieces.length ? (
                    store.pieces.map((piece, index) => (
                      <PieceRow key={piece.id} piece={piece} isLast={index === store.pieces.length - 1} />
                    ))
                  ) : (
                    <div className="px-5 py-10 text-center text-sm text-ink/55">
                      Aún no hay piezas cargadas.
                    </div>
                  )}
                </div>
              </div>
            </Card>
          ) : null}

          {store.step === "material" ? (
            <Card className="p-6">
              <div className="flex items-center gap-2">
                <Ruler size={20} />
                <h2 className="text-2xl font-semibold">Paso 3. Material y configuración</h2>
              </div>

              <div className="mt-5 grid gap-4 md:grid-cols-2">
                <Label title="Nombre del material">
                  <input
                    className={inputClass}
                    value={store.material.name}
                    onChange={(event) => store.setMaterial({ ...store.material, name: event.target.value })}
                  />
                </Label>
                <Label title="Cantidad de placas">
                  <input
                    className={inputClass}
                    type="number"
                    min={1}
                    value={store.material.sheetCount}
                    onChange={(event) =>
                      store.setMaterial({
                        ...store.material,
                        sheetCount: Math.max(Number(event.target.value) || 1, 1)
                      })
                    }
                  />
                </Label>
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
              </div>

              <div className="mt-4 flex flex-wrap gap-2">
                {presets.map((preset) => (
                  <Button
                    key={preset.label}
                    variant="secondary"
                    className="px-3 py-2 text-xs"
                    onClick={() =>
                      store.setMaterial({ ...store.material, width: preset.width, height: preset.height })
                    }
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>

              <div className="mt-6 grid gap-4 md:grid-cols-2">
                <Label title="Margen entre piezas">
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
                      store.setNesting({
                        ...store.nesting,
                        rotations: event.target.value as typeof store.nesting.rotations
                      })
                    }
                  >
                    <option value="none">Sin rotación</option>
                    <option value="orthogonal">Cada 90°</option>
                    <option value="free45">Cada 45°</option>
                    <option value="free">Rotaciones libres aproximadas</option>
                  </select>
                </Label>
                <Label title="Calidad">
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

              <div className="mt-6 flex flex-wrap justify-between gap-3">
                <Button variant="secondary" onClick={() => goToStep("piezas")}>
                  <ArrowLeft size={16} className="mr-2" />
                  Volver a piezas
                </Button>
                <div className="flex flex-wrap gap-3">
                  <Button variant="secondary" onClick={() => store.reset()}>
                    <RefreshCcw size={16} className="mr-2" />
                    Reiniciar
                  </Button>
                  <Button onClick={() => void startNesting()} disabled={!canContinueFromMaterial || store.running}>
                    <Play size={16} className="mr-2" />
                    {store.running ? "Calculando..." : "Realizar anidado"}
                  </Button>
                </div>
              </div>
            </Card>
          ) : null}

          {store.step === "resultado" ? (
            <Card className="p-6">
              <div className="flex items-center gap-2">
                <Settings2 size={20} />
                <h2 className="text-2xl font-semibold">Paso 4. Resultado y descarga</h2>
              </div>

              <div className="mt-5">
                <PreviewCanvas pieces={store.pieces} material={store.material} result={store.result} />
              </div>

              {resultMetrics ? (
                <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
                  {resultMetrics.map((metric) => (
                    <Metric key={metric.label} label={metric.label} value={metric.value} tone={metric.tone} />
                  ))}
                </div>
              ) : null}

              <div className="mt-6 flex flex-wrap justify-between gap-3">
                <Button variant="secondary" onClick={() => goToStep("material")}>
                  <ArrowLeft size={16} className="mr-2" />
                  Volver a material
                </Button>
                <div className="flex flex-wrap gap-3">
                  <Button
                    variant="secondary"
                    onClick={() => store.result && downloadSvg(store.pieces, store.material, store.result)}
                    disabled={!store.result}
                  >
                    <Download size={16} className="mr-2" />
                    Descargar SVG
                  </Button>
                  <Button
                    onClick={() => store.result && void downloadPdf(store.pieces, store.material, store.result)}
                    disabled={!store.result}
                  >
                    <Download size={16} className="mr-2" />
                    Descargar PDF
                  </Button>
                </div>
              </div>
            </Card>
          ) : null}
        </main>
      </div>
    </div>
  );
}

function PieceRow({ piece, isLast }: { piece: PieceItem; isLast: boolean }) {
  const updatePiece = useProjectStore((state) => state.updatePiece);
  const removePiece = useProjectStore((state) => state.removePiece);
  const material = useProjectStore((state) => state.material);
  const tooLarge = piece.geometry.width > material.width || piece.geometry.height > material.height;
  const markup = normalizeSvgMarkup(piece.geometry.svgMarkup, piece.geometry.sourceBounds);

  return (
    <div
      className={`grid grid-cols-[72px_minmax(360px,1.7fr)_minmax(260px,1fr)_minmax(170px,0.65fr)_minmax(170px,0.65fr)] items-center gap-4 px-4 py-4 ${
        isLast ? "" : "border-b border-line"
      }`}
    >
      <div className="flex justify-center">
        <input
          type="checkbox"
          className="h-6 w-6 rounded-md border-line"
          checked={piece.enabled}
          onChange={(event) => updatePiece(piece.id, (current) => ({ ...current, enabled: event.target.checked }))}
        />
      </div>

      <div className="grid grid-cols-[200px_1fr] items-start gap-5">
        <div className="flex h-[160px] items-center justify-center overflow-hidden rounded-[24px] border border-line bg-[#f3f7ef] p-4">
          <svg viewBox={`0 0 ${piece.geometry.width + 18} ${piece.geometry.height + 18}`} className="h-full w-full">
            <g
              transform="translate(9 9)"
              className="[&_circle]:fill-transparent [&_ellipse]:fill-transparent [&_path]:fill-transparent [&_polygon]:fill-transparent [&_polyline]:fill-transparent [&_rect]:fill-transparent [&_*]:stroke-[#9eb4c8] [&_*]:stroke-[1.4]"
              dangerouslySetInnerHTML={{ __html: markup }}
            />
          </svg>
        </div>

        <div className="flex min-h-[160px] flex-col justify-between gap-4">
          <div>
            <input
              className="rounded-xl border border-transparent bg-transparent px-2 py-1 text-[18px] font-semibold outline-none transition focus:border-line focus:bg-canvas"
              value={piece.name}
              onChange={(event) =>
                updatePiece(piece.id, (current) => ({
                  ...current,
                  name: event.target.value
                }))
              }
            />
            <p className="mt-1 px-2 text-sm text-ink/55">{piece.sourceFile}</p>
          </div>

          <div className="flex flex-wrap items-center gap-2 px-2">
            {piece.warnings.map((warning) => (
              <span key={warning} className="rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-warning">
                {warningLabel(warning)}
              </span>
            ))}
            {tooLarge ? (
              <span className="rounded-full bg-rose-50 px-3 py-1 text-xs font-medium text-danger">
                Supera el tamaño del material
              </span>
            ) : null}
            {!piece.warnings.length && !tooLarge ? (
              <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-medium text-accentDeep">
                Válida
              </span>
            ) : null}
            <Button variant="ghost" className="px-3 py-2 text-danger" onClick={() => removePiece(piece.id)}>
              <Trash2 size={15} className="mr-2" />
              Eliminar
            </Button>
          </div>
        </div>
      </div>

      <div className="flex items-center">
        <QuantityControl piece={piece} />
      </div>

      <div className="text-[22px] font-medium text-ink/85">
        {formatMeasure(piece.geometry.width, material.unit)}
      </div>

      <div className="text-[22px] font-medium text-ink/85">
        {formatMeasure(piece.geometry.height, material.unit)}
      </div>
    </div>
  );
}

function QuantityControl({ piece }: { piece: PieceItem }) {
  const updatePiece = useProjectStore((state) => state.updatePiece);

  function setQuantity(next: number) {
    updatePiece(piece.id, (current) => ({
      ...current,
      quantity: Math.max(next, 1)
    }));
  }

  return (
    <div className="inline-flex items-center overflow-hidden rounded-full border border-line bg-white shadow-sm">
      <button
        type="button"
        className="flex h-11 w-12 items-center justify-center bg-[#9a9894] text-[26px] leading-none text-white transition hover:bg-[#888681]"
        onClick={() => setQuantity(piece.quantity - 1)}
        aria-label="Restar una pieza"
      >
        -
      </button>
      <div className="flex h-11 min-w-[58px] items-center justify-center text-xl">{piece.quantity}</div>
      <button
        type="button"
        className="flex h-11 w-12 items-center justify-center bg-[#9a9894] text-[26px] leading-none text-white transition hover:bg-[#888681]"
        onClick={() => setQuantity(piece.quantity + 1)}
        aria-label="Sumar una pieza"
      >
        +
      </button>
      <button
        type="button"
        className="border-l border-line px-4 text-lg font-semibold text-[#314867] transition hover:bg-[#eef3f8]"
        onClick={() => setQuantity(piece.quantity + 10)}
      >
        +10
      </button>
      <button
        type="button"
        className="border-l border-line px-4 text-lg font-semibold text-[#314867] transition hover:bg-[#eef3f8]"
        onClick={() => setQuantity(piece.quantity + 100)}
      >
        +100
      </button>
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
