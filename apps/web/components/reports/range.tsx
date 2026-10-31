"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { addDaysISO, todayISO } from "@/lib/dates";
import { useSession } from "@/components/providers/SessionProvider";

export type RangePreset = "today" | "yesterday" | "last7" | "last30" | "thisMonth" | "lastMonth" | "custom";

export const RANGE_PRESETS: { value: RangePreset; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "last7", label: "Last 7 days" },
  { value: "last30", label: "Last 30 days" },
  { value: "thisMonth", label: "This month" },
  { value: "lastMonth", label: "Last month" },
  { value: "custom", label: "Custom" },
];

export interface DateRange {
  preset: RangePreset;
  from: string;
  to: string;
}

/** Resolve a preset to a from/to pair (YYYY-MM-DD, inclusive) relative to `today`. */
export function presetRange(preset: Exclude<RangePreset, "custom">, today: string): { from: string; to: string } {
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const y = addDaysISO(today, -1);
      return { from: y, to: y };
    }
    case "last7":
      return { from: addDaysISO(today, -6), to: today };
    case "last30":
      return { from: addDaysISO(today, -29), to: today };
    case "thisMonth":
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case "lastMonth": {
      const firstThis = `${today.slice(0, 7)}-01`;
      const lastPrev = addDaysISO(firstThis, -1);
      return { from: `${lastPrev.slice(0, 7)}-01`, to: lastPrev };
    }
  }
}

const STORAGE_KEY = "canavo.reports.range";
/** The API caps report ranges at 366 days. */
export const MAX_RANGE_DAYS = 366;

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

interface RangeValue {
  range: DateRange;
  today: string;
  setPreset: (p: RangePreset) => void;
  setCustom: (from: string, to: string) => void;
}

const RangeContext = createContext<RangeValue | null>(null);

/** Shared date range for every report tab (kept while switching tabs, remembered per browser session). */
export function ReportRangeProvider({ children }: { children: React.ReactNode }) {
  const { outlet } = useSession();
  const today = todayISO(outlet?.timezone);
  const [range, setRange] = useState<DateRange>(() => ({ preset: "last7", ...presetRange("last7", today) }));

  useEffect(() => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as DateRange;
      if (saved.preset === "custom") {
        if (/^\d{4}-\d{2}-\d{2}$/.test(saved.from) && /^\d{4}-\d{2}-\d{2}$/.test(saved.to)) setRange(saved);
      } else if (RANGE_PRESETS.some((p) => p.value === saved.preset)) {
        setRange({ preset: saved.preset, ...presetRange(saved.preset, today) });
      }
    } catch {
      /* ignore */
    }
    // Only on mount: later changes come from the toolbar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const persist = (next: DateRange) => {
    setRange(next);
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  };

  const setPreset = useCallback(
    (p: RangePreset) => {
      if (p === "custom") persist({ ...range, preset: "custom" });
      else persist({ preset: p, ...presetRange(p, today) });
    },
    [range, today],
  );

  const setCustom = useCallback((from: string, to: string) => persist({ preset: "custom", from, to }), []);

  const value = useMemo(() => ({ range, today, setPreset, setCustom }), [range, today, setPreset, setCustom]);
  return <RangeContext.Provider value={value}>{children}</RangeContext.Provider>;
}

export function useReportRange(): RangeValue {
  const ctx = useContext(RangeContext);
  if (!ctx) throw new Error("useReportRange must be used inside ReportRangeProvider");
  return ctx;
}

export function rangeLabel(from: string, to: string): string {
  const fmt = (d: string, withYear: boolean) =>
    new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", ...(withYear && { year: "numeric" }), timeZone: "UTC" });
  if (from === to) return fmt(from, true);
  return `${fmt(from, from.slice(0, 4) !== to.slice(0, 4))} – ${fmt(to, true)}`;
}
