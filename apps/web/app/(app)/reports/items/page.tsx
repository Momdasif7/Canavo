"use client";

import { useMemo, useState } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { PageHeader } from "@/components/layout/PageHeader";
import { Donut, RankedBars } from "@/components/reports/charts";
import { ReportToolbar } from "@/components/reports/ReportToolbar";
import { CellBar, fmtInt, fmtPct, formatINR, Kpi, KpiGrid, ReportBody, Section, useReport } from "@/components/reports/shared";
import type { CategoriesReport, ItemRow, ItemsReport } from "@/components/reports/types";
import { Badge } from "@/components/ui/Badge";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { Table, THead, Th, Td } from "@/components/ui/Table";
import { EmptyState } from "@/components/ui/States";

const LIMIT = 10;

export default function ItemsReportPage() {
  const items = useReport<ItemsReport>("items", { limit: LIMIT });
  const cats = useReport<CategoriesReport>("categories");
  const [rankBy, setRankBy] = useState<"quantity" | "revenue">("quantity");

  return (
    <>
      <PageHeader title="Items & categories" subtitle="What sells, what doesn't, and where revenue comes from." />
      <ReportToolbar
        exports={[
          { path: "/reports/items", label: "Items", query: { from: items.from, to: items.to, limit: LIMIT } },
          { path: "/reports/categories", label: "Categories", query: { from: items.from, to: items.to } },
        ]}
      />
      <ReportBody state={items}>
        {(r) => {
          const best = rankBy === "quantity" ? r.bestSellers : [...r.items].filter((i) => i.revenue > 0).slice(0, LIMIT);
          return (
            <div className="space-y-5">
              <KpiGrid>
                <Kpi label="Item revenue" value={formatINR(r.totalRevenue)} note="Line totals incl. tax" />
                <Kpi label="Units sold" value={fmtInt(r.totalQuantity)} />
                <Kpi label="Items sold" value={`${fmtInt(r.items.filter((i) => i.quantity > 0).length)} / ${fmtInt(r.items.length)}`} note="Menu items with at least one sale" />
                <Kpi label="Zero sales" value={fmtInt(r.zeroSales.length)} tone={r.zeroSales.length ? "warn" : undefined} note="Visible items not sold in period" />
              </KpiGrid>

              <div className="grid gap-5 xl:grid-cols-2">
                <Section
                  title="Best sellers"
                  subtitle={`Top ${LIMIT} by ${rankBy}`}
                  action={
                    <Segmented
                      size="sm"
                      value={rankBy}
                      onChange={setRankBy}
                      options={[
                        { value: "quantity", label: "Qty" },
                        { value: "revenue", label: "Revenue" },
                      ]}
                    />
                  }
                >
                  <div className="p-4">
                    {best.length === 0 ? (
                      <EmptyState title="No items sold in this period" />
                    ) : (
                      <RankedBars
                        data={best}
                        nameKey="name"
                        valueKey={rankBy}
                        kind={rankBy === "quantity" ? "int" : "money"}
                        label={`Top items by ${rankBy}`}
                        extra={(i: ItemRow) => [
                          rankBy === "quantity" ? { label: "Revenue", value: formatINR(i.revenue) } : { label: "Qty", value: fmtInt(i.quantity) },
                          { label: "Share", value: fmtPct(i.share) },
                        ]}
                      />
                    )}
                  </div>
                </Section>

                <Section title="Category revenue share">
                  {cats.loading && !cats.data ? (
                    <p className="p-5 text-sm text-muted">Loading…</p>
                  ) : cats.error ? (
                    <p className="p-5 text-sm text-red-600">{cats.error}</p>
                  ) : !cats.data || cats.data.totalRevenue === 0 ? (
                    <EmptyState title="No category sales in this period" />
                  ) : (
                    <Donut label="Donut chart of revenue share by category" slices={cats.data.categories.map((c) => ({ label: c.category, value: c.revenue }))} />
                  )}
                </Section>
              </div>

              {cats.data && cats.data.categories.length > 0 && (
                <Section title="Categories">
                  <Table>
                    <THead>
                      <tr>
                        <Th>Category</Th>
                        <Th className="text-right">Items</Th>
                        <Th className="text-right">Sold</Th>
                        <Th className="text-right">Qty</Th>
                        <Th className="text-right">Revenue</Th>
                        <Th className="text-right">Net (ex-tax)</Th>
                        <Th className="text-right">Share</Th>
                      </tr>
                    </THead>
                    <tbody>
                      {cats.data.categories.map((c) => (
                        <tr key={c.categoryId}>
                          <Td className="font-semibold">{c.category}</Td>
                          <Td className="tabular text-right">{c.items}</Td>
                          <Td className="tabular text-right">{c.itemsSold}</Td>
                          <Td className="tabular text-right">{fmtInt(c.quantity)}</Td>
                          <Td className="tabular text-right font-bold">{formatINR(c.revenue)}</Td>
                          <Td className="tabular text-right">{formatINR(c.netRevenue)}</Td>
                          <Td className="tabular text-right">{fmtPct(c.share)}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </Section>
              )}

              <div className="grid gap-5 xl:grid-cols-2">
                <Section title="Slow movers" subtitle={`Bottom ${LIMIT} by quantity, including zero sales`}>
                  <Table>
                    <THead>
                      <tr>
                        <Th>Item</Th>
                        <Th>Category</Th>
                        <Th className="text-right">Qty</Th>
                        <Th className="text-right">Revenue</Th>
                      </tr>
                    </THead>
                    <tbody>
                      {r.slowMovers.map((i) => (
                        <tr key={i.menuItemId}>
                          <Td className="font-semibold">
                            {i.name}
                            {i.status === "OUT_OF_STOCK" && (
                              <Badge tone="warning" className="ml-2">
                                Out of stock
                              </Badge>
                            )}
                          </Td>
                          <Td className="text-muted">{i.category}</Td>
                          <Td className="tabular text-right">{i.quantity === 0 ? <Badge tone="danger">0</Badge> : fmtInt(i.quantity)}</Td>
                          <Td className="tabular text-right">{formatINR(i.revenue)}</Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </Section>
                <Section title="Not sold at all" subtitle="Consider promoting, re-pricing or retiring these">
                  {r.zeroSales.length === 0 ? (
                    <EmptyState title="Every visible item sold at least once" />
                  ) : (
                    <ul className="flex flex-wrap gap-2 p-5">
                      {r.zeroSales.map((z) => (
                        <li key={z.menuItemId}>
                          <Badge tone="warning">{z.name}</Badge>
                        </li>
                      ))}
                    </ul>
                  )}
                </Section>
              </div>

              <AllItems items={r.items} />
            </div>
          );
        }}
      </ReportBody>
    </>
  );
}

function AllItems({ items }: { items: ItemRow[] }) {
  const [q, setQ] = useState("");
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? items.filter((i) => i.name.toLowerCase().includes(s) || i.category.toLowerCase().includes(s)) : items;
  }, [items, q]);
  const max = Math.max(0, ...items.map((i) => i.revenue));
  return (
    <Section
      title="All items"
      subtitle="Ranked by revenue"
      action={<Input aria-label="Search items" placeholder="Search…" prefix={<MagnifyingGlass size={18} />} value={q} onChange={(e) => setQ(e.target.value)} className="min-h-[40px] w-48" />}
    >
      {rows.length === 0 ? (
        <EmptyState title="No matching items" />
      ) : (
        <div className="max-h-[560px] overflow-y-auto">
          <Table>
            <THead>
              <tr>
                <Th>#</Th>
                <Th>Item</Th>
                <Th>Category</Th>
                <Th className="text-right">Qty</Th>
                <Th className="text-right">Revenue</Th>
                <Th className="text-right">Share</Th>
              </tr>
            </THead>
            <tbody>
              {rows.map((i, idx) => (
                <tr key={i.menuItemId}>
                  <Td className="text-muted">{idx + 1}</Td>
                  <Td className="font-semibold">
                    {i.name}
                    <CellBar value={i.revenue} max={max} />
                  </Td>
                  <Td className="text-muted">{i.category}</Td>
                  <Td className="tabular text-right">{fmtInt(i.quantity)}</Td>
                  <Td className="tabular text-right font-bold">{formatINR(i.revenue)}</Td>
                  <Td className="tabular text-right">{fmtPct(i.share)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </Section>
  );
}
