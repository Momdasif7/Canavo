"use client";

import { useMemo, useState } from "react";
import clsx from "clsx";
import { DownloadSimple, HandCoins, Phone, Plus } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { api } from "@/lib/api";
import { saveBlob } from "@/lib/download";
import { formatDateTime, formatMinutes, formatTime } from "@/lib/format";
import type { ActivityDay, CashHandover, PartnerActivity as PartnerRow, PartnerCash, PartnersActivity } from "@/lib/types-delivery";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useSocketEvent } from "@/components/providers/SocketProvider";
import { PageHeader } from "@/components/layout/PageHeader";
import { Section } from "@/components/reports/shared";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Select } from "@/components/ui/Input";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { Table, THead, Td, Th, Tr } from "@/components/ui/Table";
import { PeriodChips, usePeriod } from "../partner/period";
import { HandoverDialog, type PartnerOption } from "./HandoverDialog";
import { HandoverHistory } from "./HandoverHistory";
import { TimelineSheet } from "./TimelineSheet";

const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
const rupees = (paise: number) => (paise / 100).toFixed(2);
const csvCell = (v: string | number) => {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Manager: per partner, per day — duty, deliveries, cash collected / received and cash still to receive. */
export function PartnerActivity() {
  const { outletId } = useSession();
  const { period, today, choose, setRange } = usePeriod("today");
  const [agentId, setAgentId] = useState("");
  const [timeline, setTimeline] = useState<{ agentId: string; name: string; date: string } | null>(null);
  const [recording, setRecording] = useState<{ agentId: string | null } | null>(null);
  const [editing, setEditing] = useState<CashHandover | null>(null);

  const query = { from: period.from, to: period.to, agentId: agentId || undefined };
  const key = outletId ? `${outletId}:${period.from}:${period.to}:${agentId}` : null;
  const activity = useApiQuery<PartnersActivity>(key && `partners-activity:${key}`, () => api.get<PartnersActivity>("/delivery/partners/activity", { query }));
  const cash = useApiQuery<PartnerCash[]>(outletId ? `delivery-cash:${outletId}` : null, () => api.get<PartnerCash[]>("/delivery/cash"));
  const handovers = useApiQuery<CashHandover[]>(key && `handovers:${key}`, () => api.get<CashHandover[]>("/delivery/cash/handovers", { query }));

  const reloadAll = () => {
    void activity.reload();
    void cash.reload();
    void handovers.reload();
  };
  useSocketEvent("delivery:updated", reloadAll);
  useSocketEvent("order:paid", reloadAll);

  /** Partner list for the filter + dialog: everyone from /delivery/cash, plus anyone only in the activity. */
  const partners = useMemo<PartnerOption[]>(() => {
    const map = new Map<string, PartnerOption>();
    for (const r of cash.data ?? []) map.set(r.agent.id, { id: r.agent.id, name: r.agent.name, balance: r.balance });
    for (const p of activity.data?.partners ?? []) if (!map.has(p.agent.id)) map.set(p.agent.id, { id: p.agent.id, name: p.agent.name, balance: p.currentBalance });
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [cash.data, activity.data]);
  const lastHandover = (id: string) => cash.data?.find((r) => r.agent.id === id)?.lastHandoverAt ?? null;

  const rows = activity.data?.partners ?? [];

  const exportCsv = () => {
    const head = ["Partner", "Date", "Clock in", "Clock out", "On duty (min)", "Late (min)", "Assigned", "Delivered", "COD delivered", "Cancelled", "Issues", "Avg delivery (min)", "Distance (km)", "Opening balance (Rs)", "Cash collected (Rs)", "Cash received (Rs)", "To receive (Rs)"];
    const lines = [head.join(",")];
    for (const p of rows) {
      for (const d of p.days) {
        lines.push(
          [
            p.agent.name,
            d.date,
            d.clockIn ? formatTime(d.clockIn) : "",
            d.clockOut ? formatTime(d.clockOut) : "",
            d.onDutyMinutes,
            d.lateByMinutes,
            d.assigned,
            d.delivered,
            d.codDelivered,
            d.cancelled,
            d.issues,
            d.avgDeliveryMinutes ?? "",
            d.distanceKm,
            rupees(d.openingBalance),
            rupees(d.cashCollected),
            rupees(d.cashReceived),
            rupees(d.closingBalance),
          ]
            .map(csvCell)
            .join(","),
        );
      }
      const t = p.totals;
      lines.push([p.agent.name, "TOTAL", "", "", t.onDutyMinutes, "", t.assigned, t.delivered, "", t.cancelled, "", "", "", rupees(t.openingBalance), rupees(t.cashCollected), rupees(t.cashReceived), rupees(t.closingBalance)].map(csvCell).join(","));
    }
    saveBlob(new Blob([`﻿${lines.join("\n")}`], { type: "text/csv;charset=utf-8" }), `delivery-partners_${period.from}_${period.to}.csv`);
  };

  return (
    <>
      <PageHeader
        title="Delivery partners"
        subtitle="Duty, deliveries and cash per day — record cash as partners hand it over"
        actions={
          <>
            <Button variant="outline" icon={<DownloadSimple size={20} />} onClick={exportCsv} disabled={!rows.length}>
              Export CSV
            </Button>
            <Button icon={<Plus size={20} weight="bold" />} onClick={() => setRecording({ agentId: agentId || null })} disabled={!partners.length} data-testid="record-cash">
              Record cash received
            </Button>
          </>
        }
      />
      <div className="space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start">
          <div className="min-w-0 flex-1">
            <PeriodChips presets={["today", "week", "month", "custom"]} period={period} today={today} onChoose={choose} onRange={setRange} />
          </div>
          <Select aria-label="Partner" value={agentId} onChange={(e) => setAgentId(e.target.value)} wrapperClassName="lg:w-64">
            <option value="">All partners</option>
            {partners.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </div>

        {activity.loading && !activity.data ? (
          <LoadingState label="Loading partner activity…" />
        ) : activity.error && !activity.data ? (
          <ErrorState message={activity.error} onRetry={activity.reload} />
        ) : rows.length === 0 ? (
          <Card>
            <EmptyState title="No delivery partners" description="Add staff with the Delivery role to this outlet to track their duty and cash here." />
          </Card>
        ) : (
          <div className={clsx("space-y-4 transition-opacity", activity.loading && "opacity-60")} aria-busy={activity.loading}>
            {rows.map((p) => (
              <PartnerCard
                key={p.agent.id}
                p={p}
                lastHandoverAt={lastHandover(p.agent.id)}
                onRecord={() => setRecording({ agentId: p.agent.id })}
                onDay={(d) => setTimeline({ agentId: p.agent.id, name: p.agent.name, date: d.date })}
              />
            ))}
          </div>
        )}

        <Section title="Cash handovers" subtitle="Recorded in this period · edit or delete to correct mistakes">
          <HandoverHistory q={handovers} onEdit={setEditing} onChanged={reloadAll} />
        </Section>
      </div>

      <HandoverDialog
        open={!!recording || !!editing}
        partners={partners}
        agentId={recording?.agentId}
        editing={editing}
        onClose={() => {
          setRecording(null);
          setEditing(null);
        }}
        onSaved={reloadAll}
      />
      <TimelineSheet target={timeline} onClose={() => setTimeline(null)} />
    </>
  );
}

function PartnerCard({ p, lastHandoverAt, onRecord, onDay }: { p: PartnerRow; lastHandoverAt: string | null; onRecord: () => void; onDay: (d: ActivityDay) => void }) {
  const t = p.totals;
  const due = p.currentBalance;
  const stat = "rounded-xl bg-surface-2 px-3 py-2";
  return (
    <Card className="overflow-hidden" data-testid="partner-activity" data-partner={p.agent.name}>
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-2 text-lg font-bold">
            {p.agent.name}
            {p.agent.status !== "ACTIVE" && <Badge>Inactive</Badge>}
          </p>
          <a href={`tel:${p.agent.phone}`} className="flex items-center gap-1 text-xs text-muted hover:text-primary">
            <Phone size={12} /> {p.agent.phone}
          </a>
        </div>
        <Button variant="secondary" icon={<HandCoins size={20} />} onClick={onRecord}>
          Record cash
        </Button>
      </div>
      <div className="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3 lg:grid-cols-6">
        <div className={stat}>
          <p className="text-xs font-semibold text-muted">Delivered</p>
          <p className="tabular text-lg font-extrabold">
            {t.delivered}
            {t.cancelled > 0 && <span className="ml-1 text-xs font-semibold text-muted">· {t.cancelled} cancelled</span>}
          </p>
        </div>
        <div className={stat}>
          <p className="text-xs font-semibold text-muted">On duty</p>
          <p className="tabular text-lg font-extrabold">{formatMinutes(t.onDutyMinutes)}</p>
        </div>
        <div className={stat}>
          <p className="text-xs font-semibold text-muted">Cash collected</p>
          <p className="tabular text-lg font-extrabold" data-testid="activity-collected">
            {formatINR(t.cashCollected)}
          </p>
        </div>
        <div className={stat}>
          <p className="text-xs font-semibold text-muted">Cash received</p>
          <p className="tabular text-lg font-extrabold text-secondary dark:text-green-300" data-testid="activity-received">
            {formatINR(t.cashReceived)}
          </p>
        </div>
        <div className={clsx("rounded-xl px-3 py-2", due > 0 ? "bg-primary text-white" : "bg-secondary-50 dark:bg-secondary/25")}>
          <p className={clsx("text-xs font-bold", due > 0 ? "text-white/90" : "text-muted")}>Cash to receive now</p>
          <p className="tabular text-xl font-black" data-testid="activity-to-receive">
            {formatINR(due)}
          </p>
        </div>
        <div className={stat}>
          <p className="text-xs font-semibold text-muted">Last handover</p>
          <p className="text-sm font-bold">{lastHandoverAt ? formatDateTime(lastHandoverAt) : "—"}</p>
        </div>
      </div>
      <Table className="min-w-[960px]">
        <THead>
          <tr>
            <Th>Date</Th>
            <Th>Clock in – out</Th>
            <Th className="text-right">On duty</Th>
            <Th className="text-right">Assigned / delivered / cancelled</Th>
            <Th className="text-right">Issues</Th>
            <Th className="text-right">Avg time</Th>
            <Th className="text-right">Cash collected</Th>
            <Th className="text-right">Cash received</Th>
            <Th className="text-right">To receive</Th>
          </tr>
        </THead>
        <tbody>
          {[...p.days].reverse().map((d) => {
            const idle = !d.clockIn && !d.assigned && !d.delivered && !d.cashCollected && !d.cashReceived;
            return (
              <Tr key={d.date} onClick={() => onDay(d)} className={clsx(idle && "text-muted")} data-testid="activity-day">
                <Td className="whitespace-nowrap font-semibold">
                  <button type="button" className="min-h-[36px] text-left underline-offset-2 hover:underline" onClick={(e) => (e.stopPropagation(), onDay(d))}>
                    {dayLabel(d.date)}
                  </button>
                </Td>
                <Td className="tabular whitespace-nowrap">
                  {d.clockIn ? (
                    <>
                      {formatTime(d.clockIn)} – {d.clockOut ? formatTime(d.clockOut) : <Badge tone="success">on duty</Badge>}
                      {d.lateByMinutes > 0 && <span className="ml-1 text-xs font-semibold text-amber-700 dark:text-amber-300">({d.lateByMinutes}m late)</span>}
                    </>
                  ) : (
                    "—"
                  )}
                </Td>
                <Td className="tabular text-right">{d.onDutyMinutes ? formatMinutes(d.onDutyMinutes) : "—"}</Td>
                <Td className="tabular text-right">
                  {d.assigned} / <strong>{d.delivered}</strong> / {d.cancelled}
                </Td>
                <Td className={clsx("tabular text-right", d.issues > 0 && "font-bold text-red-600 dark:text-red-300")}>{d.issues || "—"}</Td>
                <Td className="tabular text-right">{formatMinutes(d.avgDeliveryMinutes)}</Td>
                <Td className="tabular text-right">{d.cashCollected ? formatINR(d.cashCollected) : "—"}</Td>
                <Td className="tabular text-right">{d.cashReceived ? formatINR(d.cashReceived) : "—"}</Td>
                <Td className={clsx("tabular text-right font-bold", d.closingBalance > 0 && "text-primary-700 dark:text-primary-200")}>{formatINR(d.closingBalance)}</Td>
              </Tr>
            );
          })}
          <tr className="bg-surface-2 font-bold" data-testid="activity-totals">
            <Td>Total</Td>
            <Td className="text-xs font-semibold text-muted">Opening {formatINR(t.openingBalance)}</Td>
            <Td className="tabular text-right">{formatMinutes(t.onDutyMinutes)}</Td>
            <Td className="tabular text-right">
              {t.assigned} / {t.delivered} / {t.cancelled}
            </Td>
            <Td className="tabular text-right">{p.days.reduce((s, d) => s + d.issues, 0) || "—"}</Td>
            <Td />
            <Td className="tabular text-right">{formatINR(t.cashCollected)}</Td>
            <Td className="tabular text-right">{formatINR(t.cashReceived)}</Td>
            <Td className="tabular text-right">{formatINR(t.closingBalance)}</Td>
          </tr>
        </tbody>
      </Table>
    </Card>
  );
}
