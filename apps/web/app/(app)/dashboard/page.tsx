"use client";

import { useMemo, useState } from "react";
import clsx from "clsx";
import { ArrowDownRight, ArrowUpRight } from "@phosphor-icons/react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatINR } from "@canavo/shared";
import { api } from "@/lib/api";
import { todayISO } from "@/lib/dates";
import { ORDER_TYPE_LABELS, PAYMENT_MODE_LABELS } from "@/lib/format";
import type { DailyReport, OrderType, PaymentMode } from "@/lib/types";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useSocketEvent } from "@/components/providers/SocketProvider";
import { useTheme } from "@/components/providers/ThemeProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Table, THead, Th, Td } from "@/components/ui/Table";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";

const pctChange = (cur: number, prev: number) => (prev === 0 ? null : Math.round(((cur - prev) / prev) * 1000) / 10);
const compactINR = (paise: number) => {
  const r = paise / 100;
  if (r >= 100000) return `₹${(r / 100000).toFixed(1)}L`;
  if (r >= 1000) return `₹${(r / 1000).toFixed(1)}k`;
  return `₹${Math.round(r)}`;
};

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
}: {
  label: string;
  value: string;
  vsYesterday?: number | null;
  vsLastWeek?: number | null;
  note?: string;
}) {
  const hasCompare = vsYesterday !== undefined || vsLastWeek !== undefined;
  return (
    <Card className="p-5">
      <p className="text-sm font-semibold text-muted">{label}</p>
      <p className="tabular mt-1 text-2xl font-extrabold tracking-tight md:text-3xl">{value}</p>
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

function HourlyChart({ hourly }: { hourly: DailyReport["hourly"] }) {
  const { theme } = useTheme();
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
          <Bar dataKey="amount" fill="#FF6B35" radius={[4, 4, 0, 0]} maxBarSize={36} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
