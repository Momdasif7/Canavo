"use client";

import { useState } from "react";
import { formatINR } from "@canavo/shared";
import { api } from "@/lib/api";
import { addDaysISO, todayISO } from "@/lib/dates";
import type { CouponReport } from "@/lib/types-crm";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Table, THead, Th, Td, Tr } from "@/components/ui/Table";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { StatTile } from "./shared";

const PRESETS = [
  { label: "7 days", days: 7 },
  { label: "30 days", days: 30 },
  { label: "90 days", days: 90 },
];

export function CouponReportTab() {
  const { outletId, outlet } = useSession();
  const tz = outlet?.timezone;
  const today = todayISO(tz);
  const [from, setFrom] = useState(() => addDaysISO(todayISO(tz), -29));
  const [to, setTo] = useState(() => todayISO(tz));

  const report = useApiQuery<CouponReport>(outletId ? `coupon-report:${outletId}:${from}:${to}` : null, () =>
    api.get<CouponReport>("/offers/coupons/report", { query: { from, to } }),
  );
  const r = report.data;
  const uniqueTotal = r?.rows.reduce((s, x) => s + x.uniqueCustomers, 0) ?? 0;

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-end gap-3 p-4">
        <Input label="From" type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} />
        <Input label="To" type="date" value={to} min={from} max={today} onChange={(e) => e.target.value && setTo(e.target.value)} />
        <div className="flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <Button
              key={p.days}
              size="sm"
              variant={to === today && from === addDaysISO(today, -(p.days - 1)) ? "secondary" : "outline"}
              onClick={() => {
                setTo(today);
                setFrom(addDaysISO(today, -(p.days - 1)));
              }}
            >
              Last {p.label}
            </Button>
          ))}
        </div>
      </Card>

      {r && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatTile label="Redemptions" value={r.totals.redemptions} />
          <StatTile label="Discount given" value={formatINR(r.totals.discount)} />
          <StatTile label="Sales with coupons" value={formatINR(r.totals.sales)} />
          <StatTile label="Discount / sales" value={r.totals.sales ? `${((r.totals.discount / r.totals.sales) * 100).toFixed(1)}%` : "—"} />
        </div>
      )}

      <Card>
        {report.loading && !r ? (
          <LoadingState />
        ) : report.error ? (
          <ErrorState message={report.error} onRetry={report.reload} />
        ) : !r || r.rows.length === 0 ? (
          <EmptyState title="No coupon redemptions" description="No coupons were redeemed at this outlet in the selected period." />
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>Code</Th>
                <Th className="text-right">Redemptions</Th>
                <Th className="text-right">Unique customers</Th>
                <Th className="text-right">Discount</Th>
                <Th className="text-right">Sales</Th>
                <Th>Lifetime usage</Th>
              </tr>
            </THead>
            <tbody>
              {r.rows.map((row) => (
                <Tr key={row.couponId}>
                  <Td>
                    <p className="flex items-center gap-2 font-mono font-bold">
                      {row.code}
                      {!row.active && <Badge>Inactive</Badge>}
                    </p>
                    {row.description && <p className="text-xs text-muted">{row.description}</p>}
                  </Td>
                  <Td className="tabular text-right font-semibold">{row.redemptions}</Td>
                  <Td className="tabular text-right">{row.uniqueCustomers}</Td>
                  <Td className="tabular text-right">{formatINR(row.discount)}</Td>
                  <Td className="tabular text-right">{formatINR(row.sales)}</Td>
                  <Td className="tabular">
                    {row.usedCount} / {row.usageLimit ?? "∞"}
                  </Td>
                </Tr>
              ))}
              <Tr className="bg-surface-2 font-bold">
                <Td>Total</Td>
                <Td className="tabular text-right">{r.totals.redemptions}</Td>
                <Td className="tabular text-right text-muted" title="Sum per coupon; a customer may count under several coupons">
                  {uniqueTotal}
                </Td>
                <Td className="tabular text-right">{formatINR(r.totals.discount)}</Td>
                <Td className="tabular text-right">{formatINR(r.totals.sales)}</Td>
                <Td />
              </Tr>
            </tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
