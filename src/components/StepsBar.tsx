import type { AppStep } from "../types";
import clsx from "./utils-clsx";

const labels: Record<AppStep, string> = {
  carga: "Cargar",
  piezas: "Piezas",
  material: "Material",
  configuracion: "Parámetros",
  nesting: "Nesting",
  resultado: "Resultado"
};

const order: AppStep[] = ["carga", "piezas", "material", "configuracion", "nesting", "resultado"];

export default function StepsBar({ current }: { current: AppStep }) {
  const currentIndex = order.indexOf(current);

  return (
    <div className="grid gap-3 md:grid-cols-6">
      {order.map((step, index) => (
        <div
          key={step}
          className={clsx(
            "rounded-2xl border px-4 py-3 text-sm",
            index <= currentIndex
              ? "border-accent/20 bg-accent/10 text-accentDeep"
              : "border-line bg-white text-ink/55"
          )}
        >
          <p className="text-[11px] uppercase tracking-[0.18em]">Etapa {index + 1}</p>
          <p className="mt-1 font-semibold">{labels[step]}</p>
        </div>
      ))}
    </div>
  );
}
