"use client";

import { useMemo, useState } from "react";
import { Info } from "@phosphor-icons/react";
import { PageHeader } from "@/components/layout/PageHeader";
import { RankedBars } from "@/components/reports/charts";
import { ReportToolbar } from "@/components/reports/ReportToolbar";
import { fmtInt, fmtPct, formatINR, Kpi, KpiGrid, Notes, ReportBody, Section, useReport } from "@/components/reports/shared";
import type { ProfitItem, ProfitReport } from "@/components/reports/types";
import { Badge } from "@/components/ui/Badge";
import { Segmented } from "@/components/ui/Segmented";
import { Alert, EmptyState } from "@/components/ui/States";
import { Table, THead, Th, Td } from "@/components/ui/Table";

/** Food cost bands commonly used by Indian QSR/canteens: ≤30% healthy, ≤40% watch, above that act. */
function FoodCostBadge({ pct }: { pct: number | null }) {
  if (pct == null) return <Badge>No recipe</Badge>;
  const tone = pct <= 30 ? "success" : pct <= 40 ? "warning" : "danger";
  const word = pct <= 30 ? "Healthy" : pct <= 40 ? "Watch" : "High";
  return (
    <Badge tone={tone}>
      {fmtPct(pct)} <span className="font-normal opacity-80">· {word}</span>
    </Badge>
  );
}

type Filter = "all" | "recipe" | "high" | "missing";

export default function ProfitReportPage() {
  const report = useReport<ProfitReport>("profit");
  const [filter, setFilter] = useState<Filter>("all");

  return (
    <>
      <PageHeader title="Profit & food cost" subtitle="Revenue vs cost of goods, purchases and wastage." />
      <ReportToolbar exports={[{ path: "/reports/profit", query: { from: report.from, to: report.to } }]} />
      <ReportBody state={report}>
        {(r) => {
          const estimatedShare = r.cogs ? Math.round((r.cogsEstimated / r.cogs) * 100) : 0;
          return (
            <div className="space-y-5">
              {r.cogsEstimated > 0 && (
                <Alert tone="info">
                  <span className="flex gap-2">
                    <Info size={18} className="mt-px shrink-0" />
                    <span>
                      {estimatedShare}% of COGS ({formatINR(r.cogsEstimated)} across {fmtInt(r.estimatedOrders)} orders) is <b>estimated</b> from recipes × current cost,
                      because those orders have no stock movements. Set up recipes and receive purchases to get actual costs.
                    </span>
                  </span>
                </Alert>
              )}
              <KpiGrid cols={6}>
                <Kpi label="Revenue (ex-GST)" value={formatINR(r.revenue)} />
                <Kpi label="Cost of goods" value={formatINR(r.cogs)} note={`Food cost ${fmtPct(r.foodCostPercent)}`} />
                <Kpi label="Gross profit" value={formatINR(r.grossProfit)} tone={r.grossProfit >= 0 ? "good" : "bad"} />
                <Kpi label="Gross margin" value={fmtPct(r.grossMarginPercent)} tone={r.grossMarginPercent >= 60 ? "good" : r.grossMarginPercent >= 50 ? undefined : "warn"} />
                <Kpi label="Purchases" value={formatINR(r.purchases)} note={`${fmtInt(r.purchaseBills)} bills received`} />
                <Kpi label="Wastage" value={formatINR(r.wastageValue)} note={`${fmtPct(r.wastagePercent)} of revenue`} tone={r.wastagePercent > 3 ? "warn" : undefined} />
              </KpiGrid>

              <div className="grid gap-5 xl:grid-cols-[1fr_1fr]">
                <Section title="Where revenue goes" subtitle="Same scale, one bar per measure">
                  <div className="p-4">
                    {r.revenue === 0 ? (
                      <EmptyState title="No revenue in this period" />
                    ) : (
                      <RankedBars
                        data={[
                          { name: "Revenue", value: r.revenue },
                          { name: "Cost of goods", value: r.cogs },
                          { name: "Gross profit", value: Math.max(0, r.grossProfit) },
                          { name: "Purchases", value: r.purchases },
                          { name: "Wastage", value: r.wastageValue },
                        ]}
                        nameKey="name"
                        valueKey="value"
                        kind="money"
                        label="Bar chart of revenue, cost of goods, gross profit, purchases and wastage"
                        extra={(d) => (r.revenue ? [{ label: "of revenue", value: fmtPct((d.value / r.revenue) * 100) }] : [])}
                      />
                    )}
                  </div>
                </Section>
                <Section title="COGS breakdown">
                  <dl className="divide-y divide-line">
                    {[
                      ["From stock movements (actual)", r.cogsFromStock],
                      [`Estimated from recipes (${fmtInt(r.estimatedOrders)} orders)`, r.cogsEstimated],
                      ["Total cost of goods", r.cogs],
                    ].map(([label, v], i) => (
                      <div key={String(label)} className={i === 2 ? "flex justify-between px-5 py-3 font-bold" : "flex justify-between px-5 py-3"}>
                        <dt className={i === 2 ? "" : "text-muted"}>{label}</dt>
                        <dd className="tabular">{formatINR(Number(v))}</dd>
                      </div>
                    ))}
                  </dl>
                </Section>
              </div>

              <ItemTable items={r.items} filter={filter} setFilter={setFilter} />
              <Notes notes={r.notes} />
            </div>
          );
        }}
      </ReportBody>
    </>
  );
}

function ItemTable({ items, filter, setFilter }: { items: ProfitItem[]; filter: Filter; setFilter: (f: Filter) => void }) {
  const rows = useMemo(() => {
    if (filter === "recipe") return items.filter((i) => i.hasRecipe);
    if (filter === "high") return items.filter((i) => (i.foodCostPercent ?? 0) > 40);
    if (filter === "missing") return items.filter((i) => !i.hasRecipe);
    return items;
  }, [items, filter]);
  const missing = items.filter((i) => !i.hasRecipe).length;
  return (
    <Section
      title="Per-item food cost"
      subtitle="Recipe cost ÷ pre-tax selling price. ≤30% healthy · 30–40% watch · >40% high"
      action={
        <Segmented
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "All" },
            { value: "recipe", label: "With recipe" },
            { value: "high", label: "High cost" },
            { value: "missing", label: `No recipe (${missing})` },
          ]}
        />
      }
    >
      {rows.length === 0 ? (
        <EmptyState title="No items match" />
      ) : (
        <div className="max-h-[600px] overflow-y-auto">
          <Table>
            <THead>
              <tr>
                <Th>Item</Th>
                <Th className="text-right">Price ex-tax</Th>
                <Th className="text-right">Recipe cost</Th>
                <Th>Food cost</Th>
                <Th className="text-right">Qty sold</Th>
                <Th className="text-right">Net revenue</Th>
                <Th className="text-right">Est. COGS</Th>
                <Th className="text-right">Margin</Th>
              </tr>
            </THead>
            <tbody>
              {rows.map((i) => (
                <tr key={`${i.menuItemId}-${i.variantId ?? ""}`}>
                  <Td className="font-semibold">{i.name}</Td>
                  <Td className="tabular text-right">{formatINR(i.price)}</Td>
                  <Td className="tabular text-right">{i.recipeCost == null ? "—" : formatINR(i.recipeCost)}</Td>
                  <Td>
                    <FoodCostBadge pct={i.foodCostPercent} />
                  </Td>
                  <Td className="tabular text-right">{fmtInt(i.quantitySold)}</Td>
                  <Td className="tabular text-right font-bold">{formatINR(i.netRevenue)}</Td>
                  <Td className="tabular text-right">{i.estimatedCogs == null ? "—" : formatINR(i.estimatedCogs)}</Td>
                  <Td className="tabular text-right">{fmtPct(i.marginPercent)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </Section>
  );
}
