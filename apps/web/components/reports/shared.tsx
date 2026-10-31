"use client";

import clsx from "clsx";
import { Info } from "@phosphor-icons/react";
import { formatINR, ROLE_LABELS } from "@canavo/shared";
import { api } from "@/lib/api";
import { useApiQuery, type QueryState } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { useReportRange } from "./range";

export { formatINR };

type Extra = Record<string, string | number | undefined>;

/** Fetch an outlet-scoped date-range report for the shared toolbar range. */
export function useReport<T>(key: string, extra: Extra = {}): QueryState<T> & { from: string; to: string } {
  const { outletId } = useSession();
  const { range } = useReportRange();
  const query = { from: range.from, to: range.to, ...extra };
  const q = useApiQuery<T>(outletId ? `report:${key}:${outletId}:${JSON.stringify(query)}` : null, () => api.get<T>(`/reports/${key}`, { query }));
  return { ...q, from: range.from, to: range.to };
}

/** Loading / error / content switch. Keeps stale data visible (dimmed) while a new range loads. */
export function ReportBody<T>({ state, children }: { state: QueryState<T>; children: (data: T) => React.ReactNode }) {
  if (state.loading && state.data === undefined) return <LoadingState label="Crunching numbers…" />;
  if (state.error && state.data === undefined) return <ErrorState message={state.error} onRetry={state.reload} />;
  if (state.data === undefined) return null;
  return (
    <div className={clsx("transition-opacity", state.loading && "pointer-events-none opacity-60")} aria-busy={state.loading}>
      {state.error && (
        <div className="mb-4">
          <ErrorState message={state.error} onRetry={state.reload} />
        </div>
      )}
      {children(state.data)}
    </div>
  );
}

// ---------- Formatting ----------

export const fmtInt = (n: number) => n.toLocaleString("en-IN");
export const fmtPct = (n: number | null | undefined, digits = 1) => (n == null ? "—" : `${n.toFixed(digits).replace(/\.0+$/, "")}%`);
export const fmtNum = (n: number, digits = 2) => n.toLocaleString("en-IN", { maximumFractionDigits: digits });
/** ₹ amounts on chart axes: ₹1.2L, ₹3.4k */
export function compactINR(paise: number): string {
  const r = paise / 100;
  const abs = Math.abs(r);
  if (abs >= 10000000) return `₹${(r / 10000000).toFixed(1)}Cr`;
  if (abs >= 100000) return `₹${(r / 100000).toFixed(1)}L`;
  if (abs >= 1000) return `₹${(r / 1000).toFixed(1)}k`;
  return `₹${Math.round(r)}`;
}
export const fmtMin = (m: number | null | undefined) => (m == null ? "—" : `${fmtNum(m, 1)} min`);

// ---------- Building blocks ----------

export function Kpi({
  label,
  value,
  note,
  tone,
  icon,
}: {
  label: string;
  value: React.ReactNode;
  note?: React.ReactNode;
  tone?: "good" | "bad" | "warn";
  icon?: React.ReactNode;
}) {
  return (
    <Card className="p-4 md:p-5">
      <p className="flex items-center gap-1.5 text-sm font-semibold text-muted">
        {icon}
        {label}
      </p>
      <p
        className={clsx(
          "tabular mt-1 text-xl font-extrabold tracking-tight md:text-2xl",
          tone === "good" && "text-secondary dark:text-green-300",
          tone === "bad" && "text-red-600 dark:text-red-300",
          tone === "warn" && "text-amber-700 dark:text-amber-300",
        )}
      >
        {value}
      </p>
      {note && <p className="mt-1.5 text-xs text-muted">{note}</p>}
    </Card>
  );
}

export function KpiGrid({ children, cols = 4 }: { children: React.ReactNode; cols?: 3 | 4 | 6 }) {
  return (
    <div className={clsx("grid grid-cols-2 gap-3 md:gap-4", cols === 3 && "lg:grid-cols-3", cols === 4 && "lg:grid-cols-4", cols === 6 && "md:grid-cols-3 xl:grid-cols-6")}>
      {children}
    </div>
  );
}

export function Section({
  title,
  subtitle,
  action,
  children,
  className,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <Card className={clsx("min-w-0", className)}>
      <CardHeader title={title} subtitle={subtitle} action={action} />
      {children}
    </Card>
  );
}

/** Horizontal share bars (order types, payment modes, statuses). Text in ink, bar in brand colour. */
export function ShareList({
  rows,
  countLabel,
  valueFormat = formatINR,
}: {
  rows: { label: string; value: number; count?: number; share?: number }[];
  countLabel?: [string, string];
  valueFormat?: (n: number) => string;
}) {
  if (!rows.length) return <EmptyState title="No data in this period" />;
  const total = rows.reduce((s, r) => s + r.value, 0) || 1;
  return (
    <ul className="space-y-4 p-5">
      {rows.map((r) => {
        const pct = r.share ?? Math.round((r.value / total) * 1000) / 10;
        return (
          <li key={r.label}>
            <div className="mb-1.5 flex items-baseline justify-between gap-2 text-sm">
              <span className="font-semibold">
                {r.label}
                {r.count !== undefined && countLabel && (
                  <span className="font-normal text-muted">
                    {" "}
                    · {fmtInt(r.count)} {countLabel[r.count === 1 ? 0 : 1]}
                  </span>
                )}
              </span>
              <span className="tabular font-bold">
                {valueFormat(r.value)} <span className="font-normal text-muted">({fmtPct(pct)})</span>
              </span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-surface-2" role="presentation">
              <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function Notes({ notes }: { notes: string[] }) {
  if (!notes.length) return null;
  return (
    <ul className="space-y-1.5 rounded-2xl border border-line bg-surface-2/60 px-4 py-3 text-xs text-muted">
      {notes.map((n) => (
        <li key={n} className="flex gap-2">
          <Info size={16} className="mt-px shrink-0" />
          <span>{n}</span>
        </li>
      ))}
    </ul>
  );
}

/** Thin inline bar used inside table cells to show relative magnitude. */
export function CellBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.max(2, Math.round((value / max) * 100)) : 0;
  return (
    <div className="mt-1 h-1.5 w-full max-w-[160px] overflow-hidden rounded-full bg-surface-2" role="presentation">
      <div className="h-full rounded-full bg-primary/80" style={{ width: `${value > 0 ? pct : 0}%` }} />
    </div>
  );
}

export const ORDER_TYPE_LABEL: Record<string, string> = { DINE_IN: "Dine-In", TAKEAWAY: "Takeaway", DELIVERY: "Delivery", PRE_ORDER: "Pre-Order" };
export const PAYMENT_LABEL: Record<string, string> = { CASH: "Cash", UPI: "UPI", CARD: "Card", KHATA: "Khata" };
export const roleLabel = (role: string) => (ROLE_LABELS as Record<string, string>)[role] ?? role;
