import type { AppStep } from "../types";
import clsx from "./utils-clsx";

const labels: Record<AppStep, string> = {
  carga: "Cargar archivos",
  piezas: "Elegir piezas",
  material: "Material y ajuste",
  resultado: "Resultado"
};

const order: AppStep[] = ["carga", "piezas", "material", "resultado"];

export default function StepsBar({ current }: { current: AppStep }) {
  const currentIndex = order.indexOf(current);

  return (
    <div className="grid gap-2 md:grid-cols-4">
      {order.map((step, index) => (
        <div
          key={step}
          className={clsx(
            "rounded-full border px-4 py-3 text-sm",
            index <= currentIndex
              ? "border-accent/30 bg-accent/12 text-accentDeep"
              : "border-line bg-[#fafcf8] text-ink/55"
          )}
        >
          <p className="text-[10px] uppercase tracking-[0.18em]">Paso {index + 1}</p>
          <p className="mt-1 font-semibold">{labels[step]}</p>
        </div>
      ))}
    </div>
  );
}
