"use client";

import { useMemo } from "react";
import Link from "next/link";
import clsx from "clsx";
import { CaretRight, Clock, HandCoins, Money, Moped, Path, SealCheck, Storefront, Wallet } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { api } from "@/lib/api";
import { addDaysISO } from "@/lib/dates";
import { formatMinutes, formatTime } from "@/lib/format";
import type { DeliverySummary } from "@/lib/types-delivery";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useSocketEvent } from "@/components/providers/SocketProvider";
import { ColumnChart } from "@/components/reports/charts";
import { Kpi, KpiGrid, Section, fmtInt } from "@/components/reports/shared";
import { Card } from "@/components/ui/Card";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { PeriodChips, shortDay, usePeriod } from "./period";
import { RunStatusBanner } from "./run";

/** Fill days with no deliveries so the trend reads as a continuous timeline (ranges up to ~2 months). */
function fillDays(from: string, to: string, rows: DeliverySummary["byDay"]) {
  const byDate = new Map(rows.map((r) => [r.date, r]));
  const out: DeliverySummary["byDay"] = [];
  for (let d = from, i = 0; d <= to && i < 62; d = addDaysISO(d, 1), i++) out.push(byDate.get(d) ?? { date: d, deliveries: 0, collected: 0 });
  return out.length >= 62 ? rows : out;
}

export function PartnerDashboard() {
  const { outletId } = useSession();
  const { period, today, choose, setRange } = usePeriod("today");
  const q = useApiQuery<DeliverySummary>(outletId ? `partner-summary:${outletId}:${period.from}:${period.to}` : null, () =>
    api.get<DeliverySummary>("/delivery/mine/summary", { query: { from: period.from, to: period.to } }),
  );
  useSocketEvent("delivery:updated", () => void q.reload());
  useSocketEvent("order:paid", () => void q.reload());

  const days = useMemo(() => (q.data ? fillDays(q.data.from, q.data.to, q.data.byDay) : []), [q.data]);

  return (
    <div className="space-y-4">
      <RunStatusBanner />
      <PeriodChips presets={["today", "yesterday", "week", "month", "custom"]} period={period} today={today} onChoose={choose} onRange={setRange} />
      {q.loading && !q.data ? (
        <LoadingState label="Loading your numbers…" />
      ) : q.error && !q.data ? (
        <ErrorState message={q.error} onRetry={q.reload} />
      ) : q.data ? (
        <div className={clsx("space-y-4 transition-opacity", q.loading && "opacity-60")} aria-busy={q.loading}>
          <div className="grid gap-3 md:grid-cols-2 md:gap-4">
            <CashInHand s={q.data} />
            <CodToCollect s={q.data} />
          </div>
          <KpiGrid cols={3}>
            <Kpi icon={<SealCheck size={18} />} label="Deliveries completed" value={fmtInt(q.data.delivered)} note={q.data.cancelled ? `${q.data.cancelled} cancelled` : `Order value ${formatINR(q.data.orderValue)}`} />
            <Kpi icon={<Money size={18} />} label="Cash collected" value={formatINR(q.data.collected.cash)} tone="good" note="Cash on delivery at the door" />
            <Kpi icon={<Wallet size={18} />} label="Already paid orders" value={formatINR(q.data.collected.prepaid)} note="Paid before dispatch — nothing collected" />
          </KpiGrid>
          <div className="grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-4">
            <Kpi icon={<Clock size={18} />} label="Avg delivery time" value={formatMinutes(q.data.avgDeliveryMinutes)} note="Pick-up to doorstep" />
            <Kpi icon={<Path size={18} />} label="Distance" value={`${q.data.distanceKm} km`} note="Outlet to customer, one way" />
            <Kpi icon={<Moped size={18} />} label="Active now" value={fmtInt(q.data.activeDeliveries)} />
            <DutyCard s={q.data} />
          </div>
          {q.data.delivered === 0 ? (
            <Card>
              <EmptyState title="No deliveries in this period" description="Completed deliveries and collections will show up here." />
            </Card>
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              <Section title="Deliveries per day">
                <div className="p-3 md:p-4">
                  <ColumnChart data={days} xKey="date" yKey="deliveries" kind="int" xFormat={shortDay} label="Deliveries completed per day" height={240} />
                </div>
              </Section>
              <Section title="Collected per day" subtitle="Cash collected at the door">
                <div className="p-3 md:p-4">
                  <ColumnChart data={days} xKey="date" yKey="collected" kind="money" xFormat={shortDay} label="Cash collected per day" height={240} color="#2D6A4F" />
                </div>
              </Section>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function CashInHand({ s }: { s: DeliverySummary }) {
  const has = s.cashInHand > 0;
  return (
    <Link href="/delivery/cash" className="block rounded-2xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary" data-testid="cash-in-hand">
      <Card className={clsx("flex h-full items-center gap-4 p-4 hover:bg-surface-2 md:p-5", has ? "border-primary/50 bg-primary-50 hover:bg-primary-50/70 dark:bg-primary/15" : "")}>
        <span className={clsx("flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl", has ? "bg-primary text-white" : "bg-surface-2 text-muted")}>
          <Storefront size={30} weight="fill" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-muted">Cash in hand</p>
          <p className="tabular text-3xl font-extrabold tracking-tight" data-testid="cash-in-hand-amount">
            {formatINR(s.cashInHand)}
          </p>
          <p className="text-sm font-medium">
            {has
              ? `Hand over ${formatINR(s.cashInHand)} to the outlet · ${s.cashInHandOrders} order${s.cashInHandOrders === 1 ? "" : "s"}`
              : "All cash handed over — nothing pending."}
          </p>
        </div>
        <CaretRight size={22} className="shrink-0 text-muted" aria-label="Open cash handover" />
      </Card>
    </Link>
  );
}

/** Cash on Delivery still to collect on active runs (not range-bound). */
function CodToCollect({ s }: { s: DeliverySummary }) {
  const amount = s.codToCollect ?? 0;
  const orders = s.codOrders ?? 0;
  const has = amount > 0;
  return (
    <Card className={clsx("flex items-center gap-4 p-4 md:p-5", has ? "border-amber-400/70 bg-amber-50 dark:border-amber-500/40 dark:bg-amber-500/10" : "")} data-testid="cod-to-collect">
      <span className={clsx("flex h-14 w-14 shrink-0 items-center justify-center rounded-2xl", has ? "bg-amber-500 text-white" : "bg-surface-2 text-muted")}>
        <HandCoins size={30} weight="fill" />
      </span>
      <div className="min-w-0">
        <p className="text-sm font-bold text-muted">Cash to collect</p>
        <p className="tabular text-3xl font-extrabold tracking-tight" data-testid="cod-to-collect-amount">
          {formatINR(amount)}
        </p>
        <p className="text-sm font-medium">
          {has ? `Collect in cash at the door · ${orders} order${orders === 1 ? "" : "s"}` : "No cash to collect on your runs."}
        </p>
      </div>
    </Card>
  );
}

function DutyCard({ s }: { s: DeliverySummary }) {
  return (
    <Card className="p-4 md:p-5">
      <p className="text-sm font-semibold text-muted">Duty status</p>
      {s.onDuty ? (
        <p className="mt-1 flex items-center gap-2 text-xl font-extrabold text-secondary dark:text-green-300">
          <span className="h-3 w-3 rounded-full bg-green-500" aria-hidden /> On duty
        </p>
      ) : (
        <p className="mt-1 flex items-center gap-2 text-xl font-extrabold text-muted">
          <span className="h-3 w-3 rounded-full bg-line" aria-hidden /> Off duty
        </p>
      )}
      <p className="mt-1.5 text-xs text-muted">
        {s.onDuty && s.onDutySince ? `Since ${formatTime(s.onDutySince)}` : "Clock in (top of the page) to get orders assigned."}
      </p>
    </Card>
  );
}
