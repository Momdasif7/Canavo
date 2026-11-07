"use client";

import { useEffect, useState } from "react";
import { CalendarBlank } from "@phosphor-icons/react";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { ExportButtons, type ExportSpec } from "./ExportButtons";
import { daysBetween, MAX_RANGE_DAYS, RANGE_PRESETS, rangeLabel, useReportRange, type RangePreset } from "./range";

/**
 * Shared toolbar for date-range reports: preset chips (a select on narrow
 * screens), custom from/to inputs, optional extra controls, export buttons.
 */
export function ReportToolbar({ exports, children, disabled }: { exports?: ExportSpec[]; children?: React.ReactNode; disabled?: boolean }) {
  const { range, today, setPreset, setCustom } = useReportRange();
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);

  useEffect(() => {
    setFrom(range.from);
    setTo(range.to);
  }, [range.from, range.to]);

  const days = from && to ? daysBetween(from, to) : 0;
  const customError = !from || !to ? "Pick both dates" : from > to ? "Start must be before end" : days > MAX_RANGE_DAYS ? `Max ${MAX_RANGE_DAYS} days` : null;
  const dirty = from !== range.from || to !== range.to;

  return (
    <div className="mb-5 space-y-3 rounded-2xl border border-line bg-surface p-3 shadow-sm print:hidden">
      <div className="flex flex-wrap items-center gap-2">
        <div className="hidden flex-wrap gap-1.5 lg:flex" role="radiogroup" aria-label="Date range">
          {RANGE_PRESETS.map((p) => (
            <button
              key={p.value}
              type="button"
              role="radio"
              aria-checked={range.preset === p.value}
              onClick={() => setPreset(p.value)}
              className={
                range.preset === p.value
                  ? "min-h-[40px] rounded-lg bg-primary px-3 text-sm font-semibold text-primary-fg"
                  : "min-h-[40px] rounded-lg px-3 text-sm font-semibold text-muted hover:bg-surface-2 hover:text-fg"
              }
            >
              {p.label}
            </button>
          ))}
        </div>
        <Select
          aria-label="Date range"
          className="min-h-[40px] lg:hidden"
          wrapperClassName="lg:hidden"
          value={range.preset}
          onChange={(e) => setPreset(e.target.value as RangePreset)}
        >
          {RANGE_PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </Select>
        <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-muted">
          <CalendarBlank size={18} />
          {rangeLabel(range.from, range.to)}
        </span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {children}
          {exports && exports.length > 0 && <ExportButtons specs={exports} disabled={disabled} />}
        </div>
      </div>
      {range.preset === "custom" && (
        <form
          className="flex flex-wrap items-end gap-2 border-t border-line pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!customError) setCustom(from, to);
          }}
        >
          <Input label="From" type="date" value={from} max={to || today} onChange={(e) => setFrom(e.target.value)} className="min-h-[40px]" />
          <Input label="To" type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} className="min-h-[40px]" />
          <Button type="submit" size="sm" disabled={!!customError || !dirty}>
            Apply
          </Button>
          {customError && <p className="pb-2 text-sm font-medium text-red-600">{customError}</p>}
        </form>
      )}
    </div>
  );
}
