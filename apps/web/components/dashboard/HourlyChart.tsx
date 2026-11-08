"use client";

import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatINR } from "@canavo/shared";
import type { DailyReport } from "@/lib/types";
import { useTheme } from "@/components/providers/ThemeProvider";

const compactINR = (paise: number) => {
  const r = paise / 100;
  if (r >= 10000000) return `₹${(r / 10000000).toFixed(1)}Cr`;
  if (r >= 100000) return `₹${(r / 100000).toFixed(1)}L`;
  if (r >= 1000) return `₹${(r / 1000).toFixed(1)}k`;
  return `₹${Math.round(r)}`;
};

export default function HourlyChart({ hourly }: { hourly: DailyReport["hourly"] }) {
  const { theme, accent } = useTheme();
  const dark = theme === "dark";
  // Trim to trading hours: first to last hour with sales, padded, at least 7:00–22:00.
  const data = useMemo(() => {
    const active = hourly.filter((h) => h.orders > 0).map((h) => h.hour);
    const from = Math.min(7, ...active);
    const to = Math.max(22, ...active);
    return hourly
      .filter((h) => h.hour >= from && h.hour <= to)
      .map((h) => ({ ...h, label: `${h.hour % 12 || 12}${h.hour < 12 ? "a" : "p"}` }));
  }, [hourly]);
  const axis = dark ? "#A8A8BE" : "#626270";
  const grid = dark ? "#3E3E60" : "#E2E0DA";

  return (
    <div className="h-72 w-full" role="img" aria-label="Bar chart of sales by hour">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap={2}>
          <CartesianGrid vertical={false} stroke={grid} strokeDasharray="0" />
          <XAxis dataKey="label" tick={{ fill: axis, fontSize: 12 }} tickLine={false} axisLine={{ stroke: grid }} interval={0} />
          <YAxis tickFormatter={compactINR} tick={{ fill: axis, fontSize: 12 }} tickLine={false} axisLine={false} width={56} />
          <Tooltip
            cursor={{ fill: dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)" }}
            content={({ active, payload }) => {
              const p = payload?.[0]?.payload as (typeof data)[number] | undefined;
              if (!active || !p) return null;
              return (
                <div className="rounded-lg border border-line bg-surface px-3 py-2 text-sm shadow-lg">
                  <p className="font-semibold">
                    {String(p.hour).padStart(2, "0")}:00 – {String(p.hour + 1).padStart(2, "0")}:00
                  </p>
                  <p className="tabular font-bold">{formatINR(p.amount)}</p>
                  <p className="text-muted">
                    {p.orders} order{p.orders === 1 ? "" : "s"}
                  </p>
                </div>
              );
            }}
          />
          <Bar dataKey="amount" fill={accent} radius={[4, 4, 0, 0]} maxBarSize={36} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
