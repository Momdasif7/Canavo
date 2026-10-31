"use client";

import { useMemo, useState } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";
import { PageHeader } from "@/components/layout/PageHeader";
import { RankedBars } from "@/components/reports/charts";
import { ReportToolbar } from "@/components/reports/ReportToolbar";
import { fmtInt, fmtNum, formatINR, Kpi, KpiGrid, ReportBody, Section, useReport } from "@/components/reports/shared";
import type { InventoryReport, InventoryRow } from "@/components/reports/types";
import { Badge } from "@/components/ui/Badge";
import { Input, Select } from "@/components/ui/Input";
import { EmptyState } from "@/components/ui/States";
import { Table, THead, Th, Td } from "@/components/ui/Table";

export default function InventoryReportPage() {
  const report = useReport<InventoryReport>("inventory");
  return (
    <>
      <PageHeader title="Inventory movement" subtitle="Opening → in → out → closing per ingredient, wastage and vendor purchases." />
      <ReportToolbar exports={[{ path: "/reports/inventory", query: { from: report.from, to: report.to } }]} />
      <ReportBody state={report}>
        {(r) => {
          const wasted = r.items.filter((i) => i.wastageValue > 0).sort((a, b) => b.wastageValue - a.wastageValue).slice(0, 8);
          const due = r.vendors.reduce((s, v) => s + v.due, 0);
          const moved = r.items.filter((i) => i.in > 0 || i.out > 0).length;
          return (
            <div className="space-y-5">
              <KpiGrid>
                <Kpi label="Closing stock value" value={formatINR(r.totals.closingValue)} note="At current cost per unit" />
                <Kpi label="Purchases received" value={formatINR(r.totals.purchases)} note={`${fmtInt(r.vendors.reduce((s, v) => s + v.bills, 0))} bills`} />
                <Kpi label="Wastage" value={formatINR(r.totals.wastageValue)} tone={r.totals.wastageValue > 0 ? "warn" : undefined} />
                <Kpi label="Vendor dues" value={formatINR(due)} tone={due > 0 ? "bad" : undefined} note={`${moved} items moved`} />
              </KpiGrid>

              <div className="grid gap-5 xl:grid-cols-2">
                <Section title="Top wastage" subtitle="By value">
                  <div className="p-4">
                    {wasted.length === 0 ? (
                      <EmptyState title="No wastage recorded" />
                    ) : (
                      <RankedBars
                        data={wasted}
                        nameKey="name"
                        valueKey="wastageValue"
                        kind="money"
                        label="Bar chart of wastage value by item"
                        extra={(i: InventoryRow) => [{ label: "Qty", value: `${fmtNum(i.wasted, 3)} ${i.unit}` }]}
                      />
                    )}
                  </div>
                </Section>
                <Section title="Vendor purchases">
                  {r.vendors.length === 0 ? (
                    <EmptyState title="No purchases received" />
                  ) : (
                    <Table>
                      <THead>
                        <tr>
                          <Th>Vendor</Th>
                          <Th className="text-right">Bills</Th>
                          <Th className="text-right">Total</Th>
                          <Th className="text-right">Paid</Th>
                          <Th className="text-right">Due</Th>
                        </tr>
                      </THead>
                      <tbody>
                        {r.vendors.map((v) => (
                          <tr key={v.vendorId}>
                            <Td className="font-semibold">{v.vendor}</Td>
                            <Td className="tabular text-right">{v.bills}</Td>
                            <Td className="tabular text-right font-bold">{formatINR(v.total)}</Td>
                            <Td className="tabular text-right">{formatINR(v.paid)}</Td>
                            <Td className="tabular text-right">{v.due > 0 ? <Badge tone="danger">{formatINR(v.due)}</Badge> : "—"}</Td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  )}
                </Section>
              </div>

              <Movement items={r.items} />
            </div>
          );
        }}
      </ReportBody>
    </>
  );
}

function Movement({ items }: { items: InventoryRow[] }) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [movedOnly, setMovedOnly] = useState(true);
  const categories = useMemo(() => [...new Set(items.map((i) => i.category))].sort(), [items]);
  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return items.filter((i) => (!cat || i.category === cat) && (!s || i.name.toLowerCase().includes(s)) && (!movedOnly || i.in > 0 || i.out > 0));
  }, [items, q, cat, movedOnly]);
  const n = (v: number) => (v === 0 ? <span className="text-muted">0</span> : fmtNum(v, 3));

  return (
    <Section
      title="Stock movement"
      subtitle="Quantities in each item's unit"
      action={
        <div className="flex flex-wrap items-center gap-2">
          <Input aria-label="Search items" placeholder="Search…" prefix={<MagnifyingGlass size={18} />} value={q} onChange={(e) => setQ(e.target.value)} className="min-h-[40px] w-40" />
          <Select aria-label="Category" value={cat} onChange={(e) => setCat(e.target.value)} className="min-h-[40px]">
            <option value="">All categories</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </Select>
          <label className="flex min-h-[40px] items-center gap-2 text-sm font-semibold">
            <input type="checkbox" className="h-4 w-4 accent-[#FF6B35]" checked={movedOnly} onChange={(e) => setMovedOnly(e.target.checked)} />
            Moved only
          </label>
        </div>
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
                <Th className="text-right">Opening</Th>
                <Th className="text-right">Purchased</Th>
                <Th className="text-right">Other in</Th>
                <Th className="text-right">Consumed</Th>
                <Th className="text-right">Wasted</Th>
                <Th className="text-right">Other out</Th>
                <Th className="text-right">Closing</Th>
                <Th className="text-right">Value</Th>
              </tr>
            </THead>
            <tbody>
              {rows.map((i) => (
                <tr key={i.inventoryItemId}>
                  <Td>
                    <p className="font-semibold">{i.name}</p>
                    <p className="text-xs text-muted">
                      {i.category} · {i.unit}
                    </p>
                  </Td>
                  <Td className="tabular text-right">{n(i.opening)}</Td>
                  <Td className="tabular text-right">{n(i.purchased)}</Td>
                  <Td className="tabular text-right">{n(i.otherIn)}</Td>
                  <Td className="tabular text-right">{n(i.sold)}</Td>
                  <Td className="tabular text-right">{i.wasted ? <span className="font-semibold text-amber-700 dark:text-amber-300">{fmtNum(i.wasted, 3)}</span> : n(0)}</Td>
                  <Td className="tabular text-right">{n(i.otherOut)}</Td>
                  <Td className="tabular text-right font-bold">{fmtNum(i.closing, 3)}</Td>
                  <Td className="tabular text-right">{formatINR(i.closingValue)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </div>
      )}
    </Section>
  );
}
