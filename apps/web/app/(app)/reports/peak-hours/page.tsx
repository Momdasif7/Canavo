"use client";

import { useState } from "react";
import { Fire } from "@phosphor-icons/react";
import { PageHeader } from "@/components/layout/PageHeader";
import { ColumnChart, Heatmap } from "@/components/reports/charts";
import { ReportToolbar } from "@/components/reports/ReportToolbar";
import { fmtInt, fmtNum, formatINR, Kpi, KpiGrid, ReportBody, Section, useReport } from "@/components/reports/shared";
import type { PeakHoursReport } from "@/components/reports/types";
import { Segmented } from "@/components/ui/Segmented";
import { EmptyState } from "@/components/ui/States";

const slot = (h: number) => `${String(h).padStart(2, "0")}:00–${String((h + 1) % 24).padStart(2, "0")}:00`;
const hourShort = (h: number) => `${h % 12 || 12}${h < 12 ? "am" : "pm"}`;

export default function PeakHoursPage() {
  const report = useReport<PeakHoursReport>("peak-hours");
  const [measure, setMeasure] = useState<"orders" | "revenue">("orders");

  return (
    <>
      <PageHeader title="Peak hours" subtitle="When your counter is busiest — plan staff and prep around it." />
      <ReportToolbar exports={[{ path: "/reports/peak-hours", query: { from: report.from, to: report.to } }]} />
      <ReportBody state={report}>
        {(r) => {
          const totalOrders = r.byHour.reduce((s, h) => s + h.orders, 0);
          if (totalOrders === 0) return <EmptyState title="No paid orders in this period" description="Pick a longer range to see the weekly pattern." />;
          const active = r.byHour.filter((h) => h.orders > 0).map((h) => h.hour);
          const from = Math.min(...active);
          const to = Math.max(...active);
          const hours = Array.from({ length: to - from + 1 }, (_, i) => from + i);
          const busiestHour = [...r.byHour].sort((a, b) => b.orders - a.orders)[0];
          const busiestDay = [...r.byWeekday].sort((a, b) => b.orders / (b.days || 1) - a.orders / (a.days || 1))[0];
          const matrix = measure === "orders" ? r.orders : r.revenue;
          return (
            <div className="space-y-5">
              <KpiGrid>
                <Kpi label="Busiest hour" value={slot(busiestHour.hour)} note={`${fmtInt(busiestHour.orders)} orders · ${formatINR(busiestHour.revenue)}`} />
                <Kpi
                  label="Busiest weekday"
                  value={busiestDay.weekday}
                  note={`${fmtNum(busiestDay.orders / (busiestDay.days || 1), 1)} orders per ${busiestDay.weekday}`}
                />
                <Kpi label="Trading hours" value={`${hourShort(from)} – ${hourShort(to + 1)}`} note="First to last hour with a paid order" />
                <Kpi label="Paid orders" value={fmtInt(totalOrders)} />
              </KpiGrid>

              <Section
                title="Weekday × hour"
                subtitle={measure === "orders" ? "Number of paid orders" : "Revenue (grand total)"}
                action={
                  <Segmented
                    size="sm"
                    value={measure}
                    onChange={setMeasure}
                    options={[
                      { value: "orders", label: "Orders" },
                      { value: "revenue", label: "Revenue" },
                    ]}
                  />
                }
              >
                <Heatmap
                  rows={r.weekdays}
                  hours={hours}
                  matrix={matrix}
                  kind={measure === "orders" ? "int" : "money"}
                  detail={(w, h) => {
                    const cell = r.cells.find((c) => c.weekday === r.weekdays[w] && c.hour === h);
                    return measure === "orders"
                      ? [{ label: "revenue", value: formatINR(r.revenue[w][h]) }, { label: "avg/day", value: fmtNum(cell?.avgOrders ?? 0, 1) }]
                      : [{ label: "orders", value: fmtInt(r.orders[w][h]) }];
                  }}
                />
              </Section>

              <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
                <Section title="By hour of day" subtitle={measure === "orders" ? "Orders" : "Revenue"}>
                  <div className="p-4">
                    <ColumnChart
                      data={r.byHour.filter((h) => h.hour >= from && h.hour <= to)}
                      xKey="hour"
                      yKey={measure}
                      kind={measure === "orders" ? "int" : "money"}
                      xFormat={(h) => hourShort(Number(h))}
                      tooltipTitle={(h) => slot(h.hour)}
                      label={`Bar chart of ${measure} by hour`}
                      height={240}
                    />
                  </div>
                </Section>
                <Section title="Busiest slots" subtitle="Top 5 weekday-hour combinations">
                  <ol className="divide-y divide-line">
                    {r.peaks.map((p, i) => (
                      <li key={`${p.weekday}-${p.hour}`} className="flex items-center gap-3 px-5 py-3">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-50 text-sm font-bold text-primary-700 dark:bg-primary/15 dark:text-primary-200">
                          {i === 0 ? <Fire size={18} weight="fill" /> : i + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="font-semibold">
                            {p.weekday} · {slot(p.hour)}
                          </p>
                          <p className="text-xs text-muted">{fmtNum(p.avgOrders, 1)} orders on an average day</p>
                        </div>
                        <div className="text-right">
                          <p className="tabular font-bold">{fmtInt(p.orders)}</p>
                          <p className="tabular text-xs text-muted">{formatINR(p.revenue)}</p>
                        </div>
                      </li>
                    ))}
                  </ol>
                </Section>
              </div>
            </div>
          );
        }}
      </ReportBody>
    </>
  );
}
