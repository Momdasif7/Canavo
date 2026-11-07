"use client";

import { useMemo, useState } from "react";
import clsx from "clsx";
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { useTheme } from "@/components/providers/ThemeProvider";
import { compactINR, fmtInt, fmtPct, formatINR } from "./shared";


/**
 * Categorical palette — fixed order, never cycled (validated for CVD
 * separation in light and dark). Slots past 8 fold into "Other".
 */
const CATEGORICAL = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
};

export function useChartColors() {
  const { theme, accent } = useTheme();
  const dark = theme === "dark";
  return {
    dark,
    /** Single-series colour: the accent on screen (business brand or the user's own) */
    brand: accent,
    axis: dark ? "#A8A8BE" : "#626270",
    grid: dark ? "#3E3E60" : "#E2E0DA",
    surface: dark ? "#23233C" : "#FFFFFF",
    cursor: dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)",
    categorical: dark ? CATEGORICAL.dark : CATEGORICAL.light,
  };
}

export function TooltipBox({ title, rows }: { title: React.ReactNode; rows: { label?: string; value: React.ReactNode; color?: string }[] }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-2 text-sm shadow-lg">
      <p className="font-semibold">{title}</p>
      {rows.map((r, i) => (
        <p key={i} className="flex items-center gap-1.5">
          {r.color && <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: r.color }} aria-hidden />}
          {r.label && <span className="text-muted">{r.label}</span>}
          <span className="tabular font-bold">{r.value}</span>
        </p>
      ))}
    </div>
  );
}

export type ValueKind = "money" | "int";
const fmtValue = (v: number, kind: ValueKind) => (kind === "money" ? formatINR(v) : fmtInt(v));
const fmtAxis = (v: number, kind: ValueKind) => (kind === "money" ? compactINR(v) : fmtInt(v));

/** Vertical bar chart for one measure over categories/time. */
export function ColumnChart<T extends object>({
  data,
  xKey,
  yKey,
  kind,
  xFormat,
  tooltipTitle,
  tooltipExtra,
  height = 288,
  label,
  color,
}: {
  data: T[];
  xKey: keyof T & string;
  yKey: keyof T & string;
  kind: ValueKind;
  xFormat?: (v: string) => string;
  tooltipTitle?: (row: T) => React.ReactNode;
  tooltipExtra?: (row: T) => { label?: string; value: React.ReactNode }[];
  height?: number;
  label: string;
  color?: string;
}) {
  const c = useChartColors();
  const many = data.length > 16;
  return (
    <div className="w-full" style={{ height }} role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap={many ? 1 : "20%"}>
          <CartesianGrid vertical={false} stroke={c.grid} />
          <XAxis
            dataKey={xKey}
            tick={{ fill: c.axis, fontSize: 12 }}
            tickLine={false}
            axisLine={{ stroke: c.grid }}
            tickFormatter={xFormat}
            interval="preserveStartEnd"
            minTickGap={12}
          />
          <YAxis tickFormatter={(v: number) => fmtAxis(v, kind)} tick={{ fill: c.axis, fontSize: 12 }} tickLine={false} axisLine={false} width={60} allowDecimals={false} />
          <Tooltip
            cursor={{ fill: c.cursor }}
            content={({ active, payload }) => {
              const row = payload?.[0]?.payload as T | undefined;
              if (!active || !row) return null;
              const x = String(row[xKey]);
              return (
                <TooltipBox
                  title={tooltipTitle ? tooltipTitle(row) : xFormat ? xFormat(x) : x}
                  rows={[{ value: fmtValue(Number(row[yKey]), kind) }, ...(tooltipExtra?.(row) ?? [])]}
                />
              );
            }}
          />
          <Bar dataKey={yKey} fill={color ?? c.brand} radius={[4, 4, 0, 0]} maxBarSize={40} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Horizontal bars, ranked — for names that don't fit on an x-axis (items, staff, agents). */
export function RankedBars<T extends object>({
  data,
  nameKey,
  valueKey,
  kind,
  label,
  extra,
  color,
}: {
  data: T[];
  nameKey: keyof T & string;
  valueKey: keyof T & string;
  kind: ValueKind;
  label: string;
  extra?: (row: T) => { label?: string; value: React.ReactNode }[];
  color?: string;
}) {
  const c = useChartColors();
  const height = Math.max(160, data.length * 36 + 24);
  return (
    <div className="w-full" style={{ height }} role="img" aria-label={label}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} layout="vertical" margin={{ top: 4, right: 16, left: 0, bottom: 0 }} barCategoryGap={6}>
          <CartesianGrid horizontal={false} stroke={c.grid} />
          <XAxis type="number" tickFormatter={(v: number) => fmtAxis(v, kind)} tick={{ fill: c.axis, fontSize: 12 }} tickLine={false} axisLine={false} allowDecimals={false} />
          <YAxis
            type="category"
            dataKey={nameKey}
            width={132}
            tick={{ fill: c.axis, fontSize: 12 }}
            tickLine={false}
            axisLine={{ stroke: c.grid }}
            tickFormatter={(v: string) => (v.length > 18 ? `${v.slice(0, 17)}…` : v)}
          />
          <Tooltip
            cursor={{ fill: c.cursor }}
            content={({ active, payload }) => {
              const row = payload?.[0]?.payload as T | undefined;
              if (!active || !row) return null;
              return <TooltipBox title={String(row[nameKey])} rows={[{ value: fmtValue(Number(row[valueKey]), kind) }, ...(extra?.(row) ?? [])]} />;
            }}
          />
          <Bar dataKey={valueKey} fill={color ?? c.brand} radius={[0, 4, 4, 0]} maxBarSize={24} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface DonutSlice {
  label: string;
  value: number;
  /** Optional precomputed share in % */
  share?: number;
}

/** Donut + legend table. Legend carries labels and values so colour never stands alone. */
export function Donut({ slices, kind = "money", label, maxSlices = 7 }: { slices: DonutSlice[]; kind?: ValueKind; label: string; maxSlices?: number }) {
  const c = useChartColors();
  const [hover, setHover] = useState<number | null>(null);
  const data = useMemo(() => {
    const sorted = [...slices].filter((s) => s.value > 0).sort((a, b) => b.value - a.value);
    const total = sorted.reduce((s, x) => s + x.value, 0) || 1;
    const head = sorted.slice(0, maxSlices);
    const tail = sorted.slice(maxSlices);
    if (tail.length) head.push({ label: `Other (${tail.length})`, value: tail.reduce((s, x) => s + x.value, 0) });
    return head.map((s) => ({ ...s, share: Math.round((s.value / total) * 1000) / 10 }));
  }, [slices, maxSlices]);
  const total = data.reduce((s, x) => s + x.value, 0);
  if (!data.length) return null;
  const colorOf = (i: number) => c.categorical[i] ?? c.axis;

  return (
    <div className="grid items-center gap-4 p-5 sm:grid-cols-[200px_1fr]">
      <div className="relative mx-auto h-[200px] w-[200px]" role="img" aria-label={label}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="label"
              innerRadius={62}
              outerRadius={92}
              paddingAngle={data.length > 1 ? 1.5 : 0}
              stroke={c.surface}
              strokeWidth={2}
              isAnimationActive={false}
              onMouseEnter={(_, i) => setHover(i)}
              onMouseLeave={() => setHover(null)}
            >
              {data.map((d, i) => (
                <Cell key={d.label} fill={colorOf(i)} opacity={hover === null || hover === i ? 1 : 0.45} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          {hover !== null && data[hover] ? (
            <>
              <span className="max-w-[110px] truncate text-xs font-semibold text-muted">{data[hover].label}</span>
              <span className="tabular text-base font-extrabold">{fmtPct(data[hover].share)}</span>
            </>
          ) : (
            <>
              <span className="text-xs font-semibold text-muted">Total</span>
              <span className="tabular text-base font-extrabold">{kind === "money" ? compactINR(total) : fmtInt(total)}</span>
            </>
          )}
        </div>
      </div>
      <ul className="min-w-0 space-y-1.5">
        {data.map((d, i) => (
          <li
            key={d.label}
            className={clsx("flex items-center gap-2 rounded-lg px-2 py-1 text-sm", hover === i && "bg-surface-2")}
            onMouseEnter={() => setHover(i)}
            onMouseLeave={() => setHover(null)}
          >
            <span className="h-3 w-3 shrink-0 rounded-sm" style={{ background: colorOf(i) }} aria-hidden />
            <span className="min-w-0 flex-1 truncate font-semibold">{d.label}</span>
            <span className="tabular text-muted">{fmtPct(d.share)}</span>
            <span className="tabular w-24 text-right font-bold">{fmtValue(d.value, kind)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------- Heatmap ----------

const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hex(a);
  const [br, bg, bb] = hex(b);
  const ch = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, "0");
  return `#${ch(ar, br)}${ch(ag, bg)}${ch(ab, bb)}`;
}

/** Sequential single-hue ramp (brand orange), light → dark in light mode; dim → bright in dark mode. */
export function useSequential() {
  const { dark } = useChartColors();
  const [lo, hi] = dark ? ["#4A3236", "#FF8A5C"] : ["#FFE3D6", "#B23A10"];
  return (t: number) => mix(lo, hi, Math.min(1, Math.max(0, t)));
}

export function Heatmap({
  rows,
  hours,
  matrix,
  kind,
  detail,
}: {
  rows: string[];
  hours: number[];
  /** [row][hour 0..23] */
  matrix: number[][];
  kind: ValueKind;
  detail?: (row: number, hour: number) => { label?: string; value: React.ReactNode }[];
}) {
  const ramp = useSequential();
  const [hover, setHover] = useState<{ r: number; h: number } | null>(null);
  const max = Math.max(0, ...matrix.flatMap((r) => hours.map((h) => r[h])));
  const hourLabel = (h: number) => `${h % 12 || 12}${h < 12 ? "a" : "p"}`;
  const slot = (h: number) => `${String(h).padStart(2, "0")}:00–${String((h + 1) % 24).padStart(2, "0")}:00`;

  return (
    <div className="p-4">
      <div className="overflow-x-auto pb-2">
        <table className="w-full border-separate" style={{ borderSpacing: 2 }} aria-label="Heatmap of weekday by hour">
          <thead>
            <tr>
              <th className="w-12" />
              {hours.map((h) => (
                <th key={h} scope="col" className="min-w-[34px] px-0 pb-1 text-center text-[11px] font-semibold text-muted">
                  {hourLabel(h)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((name, r) => (
              <tr key={name}>
                <th scope="row" className="pr-2 text-left text-xs font-semibold text-muted">
                  {name}
                </th>
                {hours.map((h) => {
                  const v = matrix[r][h];
                  const t = max ? v / max : 0;
                  const active = hover?.r === r && hover.h === h;
                  return (
                    <td
                      key={h}
                      tabIndex={0}
                      onMouseEnter={() => setHover({ r, h })}
                      onMouseLeave={() => setHover(null)}
                      onFocus={() => setHover({ r, h })}
                      onBlur={() => setHover(null)}
                      title={`${name} ${slot(h)}: ${fmtValue(v, kind)}`}
                      className={clsx("h-9 min-w-[34px] rounded-md p-0 outline-none transition-shadow", v === 0 && "bg-surface-2", active && "ring-2 ring-fg")}
                      style={v > 0 ? { background: ramp(0.12 + t * 0.88) } : undefined}
                    >
                      <span className="sr-only">{fmtValue(v, kind)}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-3 text-xs text-muted">
        <div className="min-h-[40px]" aria-live="polite">
          {hover ? (
            <span>
              <b className="text-fg">
                {rows[hover.r]} · {slot(hover.h)}
              </b>{" "}
              — {fmtValue(matrix[hover.r][hover.h], kind)}
              {detail?.(hover.r, hover.h).map((d, i) => (
                <span key={i}>
                  {" · "}
                  {d.label} {d.value}
                </span>
              ))}
            </span>
          ) : (
            <span>Hover a cell for details.</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <span>0</span>
          <span className="h-2.5 w-36 rounded-full" style={{ background: `linear-gradient(90deg, ${ramp(0.12)}, ${ramp(0.56)}, ${ramp(1)})` }} aria-hidden />
          <span className="tabular">{fmtValue(max, kind)}</span>
        </div>
      </div>
    </div>
  );
}
