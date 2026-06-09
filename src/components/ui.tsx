import type { PropsWithChildren, ReactNode } from "react";
import clsx from "./utils-clsx";

export function Card({
  children,
  className
}: PropsWithChildren<{ className?: string }>) {
  return (
    <section className={clsx("rounded-[28px] border border-line bg-panel shadow-panel", className)}>
      {children}
    </section>
  );
}

export function Button({
  children,
  className,
  variant = "primary",
  ...props
}: PropsWithChildren<
  React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: "primary" | "secondary" | "ghost";
  }
>) {
  const base = "inline-flex items-center justify-center rounded-2xl px-4 py-3 text-sm font-semibold transition";
  const palette =
    variant === "primary"
      ? "bg-accent text-white hover:bg-accentDeep disabled:bg-slate-300"
      : variant === "secondary"
        ? "border border-line bg-white text-ink hover:bg-slate-50"
        : "text-ink/70 hover:bg-white";
  return (
    <button className={clsx(base, palette, className)} {...props}>
      {children}
    </button>
  );
}

export function Label({ title, children }: PropsWithChildren<{ title: string }>) {
  return (
    <label className="flex flex-col gap-2 text-sm text-ink/72">
      <span className="font-medium">{title}</span>
      {children}
    </label>
  );
}

export function Metric({
  label,
  value,
  tone = "default"
}: {
  label: string;
  value: ReactNode;
  tone?: "default" | "accent" | "warning";
}) {
  return (
    <div
      className={clsx(
        "rounded-2xl border px-4 py-3",
        tone === "accent"
          ? "border-accent/20 bg-accent/10"
          : tone === "warning"
            ? "border-warning/30 bg-amber-50"
            : "border-line bg-white"
      )}
    >
      <p className="text-xs uppercase tracking-[0.18em] text-ink/45">{label}</p>
      <p className="mt-1 text-xl font-semibold text-ink">{value}</p>
    </div>
  );
}
