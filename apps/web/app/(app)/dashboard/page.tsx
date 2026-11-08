"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import clsx from "clsx";
import { ArrowDownRight, ArrowUpRight } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { api } from "@/lib/api";
import { todayISO } from "@/lib/dates";
import { ORDER_TYPE_LABELS, PAYMENT_MODE_LABELS } from "@/lib/format";
import type { DailyReport, OrderType, PaymentMode } from "@/lib/types";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useSocketEvent } from "@/components/providers/SocketProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Table, THead, Th, Td } from "@/components/ui/Table";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";

// QA Phase 13 (perf-5): the chart library (~100 kB) loads after the page, not with it.
const HourlyChart = dynamic(() => import("@/components/dashboard/HourlyChart"), { ssr: false, loading: () => <div className="h-72 w-full" /> });

const pctChange = (cur: number, prev: number) => (prev === 0 ? null : Math.round(((cur - prev) / prev) * 1000) / 10);

export default function DashboardPage() {
  const { outletId, outlet } = useSession();
  const today = todayISO(outlet?.timezone);
  const [date, setDate] = useState(today);
  const report = useApiQuery<DailyReport>(outletId ? `daily:${outletId}:${date}` : null, () => api.get<DailyReport>("/reports/daily", { query: { date } }));

  // Live refresh while looking at today.
  useSocketEvent("order:paid", () => date === today && void report.reload());

  return (
    <PageContainer>
      <PageHeader
        title="Dashboard"
        subtitle={new Date(`${date}T00:00:00`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
        actions={<Input type="date" aria-label="Report date" value={date} max={today} onChange={(e) => setDate(e.target.value || today)} />}
      />
      {report.loading && !report.data ? (
        <LoadingState />
      ) : report.error ? (
        <ErrorState message={report.error} onRetry={report.reload} />
      ) : report.data ? (
        <Report r={report.data} />
      ) : null}
    </PageContainer>
  );
}

function Report({ r }: { r: DailyReport }) {
  const { yesterday, lastWeek } = r.comparison;
  const aov = (gross: number, orders: number) => (orders ? Math.round(gross / orders) : 0);
  const totalTax = r.tax.cgst + r.tax.sgst + r.tax.igst;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        <Kpi label="Gross sales" value={formatINR(r.grossSales)} vsYesterday={yesterday.changePercent} vsLastWeek={lastWeek.changePercent} />
        <Kpi label="Net sales (ex-GST)" value={formatINR(r.netSales)} note={`GST ${formatINR(totalTax)} · Discounts ${formatINR(r.discounts)}`} />
        <Kpi
          label="Orders"
          value={String(r.orders)}
          vsYesterday={pctChange(r.orders, yesterday.orders)}
          vsLastWeek={pctChange(r.orders, lastWeek.orders)}
          note={r.cancelledOrders ? `${r.cancelledOrders} cancelled` : undefined}
        />
        <Kpi
          label="Avg. order value"
          value={formatINR(r.averageOrderValue)}
          vsYesterday={pctChange(r.averageOrderValue, aov(yesterday.gross, yesterday.orders))}
          vsLastWeek={pctChange(r.averageOrderValue, aov(lastWeek.gross, lastWeek.orders))}
        />
      </div>

      {/* Exceptions: money that left or went missing (see the Exceptions report for details). */}
      <div className="grid grid-cols-2 gap-4 xl:grid-cols-3">
        <Kpi label="Voided bills" value={formatINR(r.voids.amount)} note={`${r.voids.count} bill${r.voids.count === 1 ? "" : "s"} voided`} tone={r.voids.count ? "warn" : undefined} />
        <Kpi
          label="Refunds"
          value={formatINR(r.refunds.amount)}
          note={`${r.refunds.count} refund${r.refunds.count === 1 ? "" : "s"} · Sales after refunds ${formatINR(r.salesAfterRefunds)}`}
          tone={r.refunds.count ? "warn" : undefined}
        />
        <Kpi
          label="Cash difference"
          value={`${r.cashDifference.amount > 0 ? "+" : ""}${formatINR(r.cashDifference.amount)}`}
          note={
            r.cashDifference.shifts
              ? `${r.cashDifference.shifts} cash shift${r.cashDifference.shifts === 1 ? "" : "s"} closed · ${r.cashDifference.amount < 0 ? "short" : r.cashDifference.amount > 0 ? "over" : "matched"}`
              : "No cash shift closed"
          }
          tone={r.cashDifference.amount ? "warn" : undefined}
        />
      </div>

      <Card>
        <CardHeader title="Sales by hour" subtitle="Paid bills, grand total" />
        <div className="p-4">{r.orders ? <HourlyChart hourly={r.hourly} /> : <EmptyState title="No sales yet" />}</div>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Payment modes" />
          <Breakdown
            rows={Object.entries(r.byPaymentMode).map(([k, v]) => ({ label: PAYMENT_MODE_LABELS[k as PaymentMode] ?? k, amount: v.amount, count: v.count }))}
            countLabel={["payment", "payments"]}
          />
        </Card>
        <Card>
          <CardHeader title="Order types" />
          <Breakdown
            rows={Object.entries(r.byOrderType).map(([k, v]) => ({ label: ORDER_TYPE_LABELS[k as OrderType] ?? k, amount: v.amount, count: v.orders }))}
            countLabel={["order", "orders"]}
          />
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Top 5 items" />
          {r.topItems.length === 0 ? (
            <EmptyState title="No items sold" />
          ) : (
            <Table>
              <THead>
                <tr>
                  <Th>#</Th>
                  <Th>Item</Th>
                  <Th className="text-right">Qty</Th>
                  <Th className="text-right">Sales</Th>
                </tr>
              </THead>
              <tbody>
                {r.topItems.map((i, idx) => (
                  <tr key={`${i.menuItemId}-${i.name}`}>
                    <Td className="text-muted">{idx + 1}</Td>
                    <Td className="font-semibold">{i.name}</Td>
                    <Td className="tabular text-right">{i.quantity}</Td>
                    <Td className="tabular text-right font-bold">{formatINR(i.amount)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
        <Card>
          <CardHeader title="Staff" subtitle="Bills raised per cashier" />
          {r.staff.length === 0 ? (
            <EmptyState title="No bills yet" />
          ) : (
            <Table>
              <THead>
                <tr>
                  <Th>Name</Th>
                  <Th className="text-right">Bills</Th>
                  <Th className="text-right">Sales</Th>
                  <Th className="text-right">Avg</Th>
                </tr>
              </THead>
              <tbody>
                {r.staff.map((s) => (
                  <tr key={s.id}>
                    <Td className="font-semibold">{s.name}</Td>
                    <Td className="tabular text-right">{s.bills}</Td>
                    <Td className="tabular text-right font-bold">{formatINR(s.amount)}</Td>
                    <Td className="tabular text-right text-muted">{formatINR(aov(s.amount, s.bills))}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}

function Change({ value, label }: { value: number | null | undefined; label: string }) {
  if (value === null || value === undefined) return <span className="text-xs text-muted">— {label}</span>;
  const up = value >= 0;
  return (
    <span className={clsx("inline-flex items-center gap-0.5 text-xs font-semibold", up ? "text-secondary dark:text-green-300" : "text-red-600 dark:text-red-300")}>
      {up ? <ArrowUpRight size={14} weight="bold" /> : <ArrowDownRight size={14} weight="bold" />}
      {Math.abs(value)}% <span className="font-normal text-muted">{label}</span>
    </span>
  );
}

function Kpi({
  label,
  value,
  vsYesterday,
  vsLastWeek,
  note,
  tone,
}: {
  label: string;
  value: string;
  vsYesterday?: number | null;
  vsLastWeek?: number | null;
  note?: string;
  /** "warn" colours the value when something needs a look */
  tone?: "warn";
}) {
  const hasCompare = vsYesterday !== undefined || vsLastWeek !== undefined;
  return (
    <Card className="p-5">
      <p className="text-sm font-semibold text-muted">{label}</p>
      <p className={clsx("tabular mt-1 text-2xl font-extrabold tracking-tight md:text-3xl", tone === "warn" && "text-red-600 dark:text-red-300")}>{value}</p>
      {hasCompare && (
        <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
          <Change value={vsYesterday} label="vs yesterday" />
          <Change value={vsLastWeek} label="vs last week" />
        </div>
      )}
      {note && <p className="mt-2 text-xs text-muted">{note}</p>}
    </Card>
  );
}

function Breakdown({ rows, countLabel }: { rows: { label: string; amount: number; count: number }[]; countLabel: [string, string] }) {
  if (!rows.length) return <EmptyState title="No data" />;
  const total = rows.reduce((s, r) => s + r.amount, 0) || 1;
  const sorted = [...rows].sort((a, b) => b.amount - a.amount);
  return (
    <ul className="space-y-4 p-5">
      {sorted.map((r) => {
        const pct = Math.round((r.amount / total) * 100);
        return (
          <li key={r.label}>
            <div className="mb-1.5 flex items-baseline justify-between gap-2 text-sm">
              <span className="font-semibold">
                {r.label} <span className="font-normal text-muted">· {r.count} {countLabel[r.count === 1 ? 0 : 1]}</span>
              </span>
              <span className="tabular font-bold">
                {formatINR(r.amount)} <span className="font-normal text-muted">({pct}%)</span>
              </span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-surface-2" role="presentation">
              <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
