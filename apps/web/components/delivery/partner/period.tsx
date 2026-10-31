"use client";

import { useState } from "react";
import clsx from "clsx";
import { addDaysISO, todayISO } from "@/lib/dates";
import { useSession } from "@/components/providers/SessionProvider";

export type PeriodPreset = "today" | "yesterday" | "week" | "month" | "last7" | "custom";

export const PERIOD_LABELS: Record<PeriodPreset, string> = {
  today: "Today",
  yesterday: "Yesterday",
  week: "This week",
  month: "This month",
  last7: "Last 7 days",
  custom: "Custom",
};

export interface Period {
  preset: PeriodPreset;
  from: string;
  to: string;
}

/** Monday of the week containing `day` (Indian weeks start Monday on duty rosters). */
function weekStart(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDaysISO(day, -((dow + 6) % 7));
}

export function resolvePeriod(preset: Exclude<PeriodPreset, "custom">, today: string): { from: string; to: string } {
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday":
      return { from: addDaysISO(today, -1), to: addDaysISO(today, -1) };
    case "week":
      return { from: weekStart(today), to: today };
    case "month":
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case "last7":
      return { from: addDaysISO(today, -6), to: today };
  }
}

/** Period state in outlet time. */
export function usePeriod(initial: Exclude<PeriodPreset, "custom">) {
  const { outlet } = useSession();
  const today = todayISO(outlet?.timezone);
  const [period, setPeriod] = useState<Period>(() => ({ preset: initial, ...resolvePeriod(initial, today) }));
  const choose = (preset: PeriodPreset) =>
    setPeriod((p) => (preset === "custom" ? { ...p, preset } : { preset, ...resolvePeriod(preset, today) }));
  const setRange = (from: string, to: string) => setPeriod({ preset: "custom", from, to: to < from ? from : to });
  return { period, today, choose, setRange };
}

/** Big, thumb-friendly period chips + custom date inputs. */
export function PeriodChips({
  presets,
  period,
  today,
  onChoose,
  onRange,
}: {
  presets: PeriodPreset[];
  period: Period;
  today: string;
  onChoose: (p: PeriodPreset) => void;
  onRange: (from: string, to: string) => void;
}) {
  const dateCls = "tabular min-h-[44px] rounded-xl border border-line bg-surface px-2 text-sm font-semibold";
  return (
    <div className="space-y-2">
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 md:mx-0 md:flex-wrap md:px-0" role="tablist" aria-label="Period">
        {presets.map((p) => (
          <button
            key={p}
            type="button"
            role="tab"
            aria-selected={period.preset === p}
            onClick={() => onChoose(p)}
            className={clsx(
              "min-h-[44px] shrink-0 whitespace-nowrap rounded-full border px-4 text-sm font-bold transition-colors",
              period.preset === p ? "border-primary bg-primary text-white" : "border-line bg-surface text-fg hover:bg-surface-2",
            )}
          >
            {PERIOD_LABELS[p]}
          </button>
        ))}
      </div>
      {period.preset === "custom" && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 text-sm font-semibold text-muted">
            From
            <input type="date" aria-label="From date" value={period.from} max={today} onChange={(e) => e.target.value && onRange(e.target.value, period.to)} className={dateCls} />
          </label>
          <label className="flex items-center gap-2 text-sm font-semibold text-muted">
            To
            <input type="date" aria-label="To date" value={period.to} min={period.from} max={today} onChange={(e) => e.target.value && onRange(period.from, e.target.value)} className={dateCls} />
          </label>
        </div>
      )}
    </div>
  );
}

export const shortDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" });
