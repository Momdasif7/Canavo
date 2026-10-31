"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { ArrowClockwise, ArrowRight, Package, Receipt, Storefront, UserCircleCheck } from "@phosphor-icons/react";
import { api } from "@/lib/api";
import { todayISO } from "@/lib/dates";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { PageHeader } from "@/components/layout/PageHeader";
import { ExportButtons } from "@/components/reports/ExportButtons";
import { fmtInt, formatINR, Kpi, KpiGrid, ReportBody } from "@/components/reports/shared";
import type { OutletOverviewRow, OutletsOverview } from "@/components/reports/types";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { EmptyState } from "@/components/ui/States";

export default function OutletsOverviewPage() {
  const { outlet } = useSession();
  const today = todayISO(outlet?.timezone);
  const [date, setDate] = useState(today);
  const data = useApiQuery<OutletsOverview>(`outlets-overview:${date}`, () => api.get<OutletsOverview>("/reports/outlets/overview", { query: { date }, outletId: null }));

  return (
    <>
      <PageHeader
        title="All outlets"
        subtitle={new Date(`${date}T00:00:00`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
      />
      <div className="mb-5 flex flex-wrap items-center gap-2 rounded-2xl border border-line bg-surface p-3 shadow-sm">
        <Input type="date" aria-label="Date" value={date} max={today} onChange={(e) => setDate(e.target.value || today)} className="min-h-[40px]" />
        {date !== today && (
          <Button variant="ghost" size="sm" onClick={() => setDate(today)}>
            Today
          </Button>
        )}
        <IconButton label="Refresh" onClick={() => void data.reload()}>
          <ArrowClockwise size={20} className={data.loading ? "animate-spin" : undefined} />
        </IconButton>
        <div className="ml-auto">
          <ExportButtons specs={[{ path: "/reports/outlets/overview", query: { date }, filename: `outlets_overview_${date}` }]} />
        </div>
      </div>
      <ReportBody state={data}>
        {(r) =>
          r.outlets.length === 0 ? (
            <EmptyState title="No outlets" />
          ) : (
            <div className="space-y-5">
              <KpiGrid cols={6}>
                <Kpi label="Gross sales" value={formatINR(r.totals.gross)} note={`${r.outlets.length} outlets`} />
                <Kpi label="Orders" value={fmtInt(r.totals.orders)} note={r.totals.cancelled ? `${r.totals.cancelled} cancelled` : undefined} />
                <Kpi label="Avg. order value" value={formatINR(r.totals.aov)} />
                <Kpi label="Open bills" value={fmtInt(r.totals.openBills)} note={formatINR(r.totals.openBillsValue)} tone={r.totals.openBills ? "warn" : undefined} />
                <Kpi label="Low-stock items" value={fmtInt(r.totals.lowStock)} tone={r.totals.lowStock ? "bad" : undefined} />
                <Kpi label="Staff clocked in" value={fmtInt(r.totals.staffClockedIn)} />
              </KpiGrid>
              <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
                {[...r.outlets]
                  .sort((a, b) => b.gross - a.gross)
                  .map((o) => (
                    <OutletCard key={o.outletId} o={o} share={r.totals.gross ? Math.round((o.gross / r.totals.gross) * 100) : 0} />
                  ))}
              </div>
            </div>
          )
        }
      </ReportBody>
    </>
  );
}

function OutletCard({ o, share }: { o: OutletOverviewRow; share: number }) {
  const router = useRouter();
  const { me, outletId, setOutlet } = useSession();
  const assigned = me?.outlets.some((x) => x.id === o.outletId);
  const current = outletId === o.outletId;
  return (
    <Card className={clsx("flex flex-col p-5", current && "ring-2 ring-primary/40")}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Storefront size={22} className="shrink-0 text-muted" />
          <h2 className="truncate text-base font-bold">{o.name}</h2>
        </div>
        {current && <Badge tone="primary">Current</Badge>}
      </div>
      <p className="tabular mt-3 text-3xl font-extrabold tracking-tight">{formatINR(o.gross)}</p>
      <p className="text-sm text-muted">
        {fmtInt(o.orders)} orders · AOV {formatINR(o.aov)}
        {o.cancelled > 0 && ` · ${o.cancelled} cancelled`}
      </p>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-2" role="presentation" title={`${share}% of total`}>
        <div className="h-full rounded-full bg-primary" style={{ width: `${share}%` }} />
      </div>
      <p className="mt-1 text-xs text-muted">{share}% of group sales</p>
      <dl className="mt-4 grid grid-cols-3 gap-2 text-center">
        <Stat icon={<Receipt size={18} />} label="Open bills" value={fmtInt(o.openBills)} sub={formatINR(o.openBillsValue)} warn={o.openBills > 0} />
        <Stat icon={<Package size={18} />} label="Low stock" value={fmtInt(o.lowStock)} warn={o.lowStock > 0} />
        <Stat icon={<UserCircleCheck size={18} />} label="Clocked in" value={fmtInt(o.staffClockedIn)} />
      </dl>
      {assigned && !current && (
        <Button
          variant="outline"
          size="sm"
          className="mt-4 self-start"
          icon={<ArrowRight size={18} />}
          onClick={() => {
            setOutlet(o.outletId);
            router.push("/reports/sales");
          }}
        >
          Open reports
        </Button>
      )}
    </Card>
  );
}

function Stat({ icon, label, value, sub, warn }: { icon: React.ReactNode; label: string; value: string; sub?: string; warn?: boolean }) {
  return (
    <div className={clsx("rounded-xl px-2 py-2.5", warn ? "bg-amber-50 dark:bg-amber-500/10" : "bg-surface-2")}>
      <dt className="flex items-center justify-center gap-1 text-xs font-semibold text-muted">
        {icon}
        {label}
      </dt>
      <dd className={clsx("tabular mt-0.5 text-lg font-extrabold", warn && "text-amber-800 dark:text-amber-200")}>{value}</dd>
      {sub && <dd className="tabular text-[11px] text-muted">{sub}</dd>}
    </div>
  );
}
