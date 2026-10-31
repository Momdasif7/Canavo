"use client";

import clsx from "clsx";
import { HandCoins, Receipt, Storefront, UserCircle } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { MyCash } from "@/lib/types-delivery";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useSocketEvent } from "@/components/providers/SocketProvider";
import { Card, CardHeader } from "@/components/ui/Card";
import { ErrorState, LoadingState } from "@/components/ui/States";

/** Delivery partner: cash collected at the door that still has to go to the outlet — kept apart from deliveries. */
export function CashHandover() {
  const { outletId } = useSession();
  const q = useApiQuery<MyCash>(outletId ? `partner-cash:${outletId}` : null, () => api.get<MyCash>("/delivery/mine/cash"));
  useSocketEvent("delivery:updated", () => void q.reload());
  useSocketEvent("order:paid", () => void q.reload());
  useSocketEvent("notification", () => void q.reload());

  if (q.loading && !q.data) return <LoadingState label="Loading your cash…" />;
  if (q.error && !q.data) return <ErrorState message={q.error} onRetry={q.reload} />;
  if (!q.data) return null;
  const c = q.data;
  const has = c.balance > 0;

  return (
    <div className={clsx("mx-auto max-w-2xl space-y-4 transition-opacity", q.loading && "opacity-70")}>
      <Card className={clsx("p-5", has ? "border-primary/50 bg-primary-50 dark:bg-primary/15" : "")} data-testid="cash-to-hand-over">
        <div className="flex items-center gap-4">
          <span className={clsx("flex h-16 w-16 shrink-0 items-center justify-center rounded-2xl", has ? "bg-primary text-white" : "bg-surface-2 text-muted")}>
            <Storefront size={34} weight="fill" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-bold text-muted">Cash to hand over</p>
            <p className="tabular text-4xl font-extrabold tracking-tight" data-testid="cash-to-hand-over-amount">
              {formatINR(Math.max(0, c.balance))}
            </p>
          </div>
        </div>
        <p className="mt-3 text-[15px] font-semibold">
          {has ? "Hand this cash to the cashier/manager — they'll record it." : c.balance < 0 ? `The outlet has recorded ${formatINR(-c.balance)} more than you collected — ask the manager to check.` : "All cash handed over — nothing pending."}
        </p>
      </Card>

      <div className="grid grid-cols-2 gap-3">
        <Card className="p-4">
          <p className="text-sm font-semibold text-muted">Collected today</p>
          <p className="tabular mt-1 text-2xl font-extrabold" data-testid="collected-today">
            {formatINR(c.collectedToday)}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-sm font-semibold text-muted">Handed over today</p>
          <p className="tabular mt-1 text-2xl font-extrabold text-secondary dark:text-green-300" data-testid="handed-over-today">
            {formatINR(c.handedOverToday)}
          </p>
        </Card>
      </div>

      <Card>
        <CardHeader title="Cash still with you" subtitle="Orders whose cash you haven't handed over yet, oldest first" />
        {c.pending.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted">Nothing pending.</p>
        ) : (
          <ul className="divide-y divide-line" data-testid="pending-cash">
            {c.pending.map((p, i) => (
              <li key={`${p.orderId}-${i}`} className="flex items-center gap-3 px-4 py-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200">
                  <HandCoins size={22} weight="fill" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">
                    <span className="font-mono">{p.invoiceNumber}</span>
                    {p.customerName && <span className="text-muted"> · {p.customerName}</span>}
                  </p>
                  <p className="truncate text-xs text-muted">
                    {p.collectedAt ? formatDateTime(p.collectedAt) : ""}
                    {p.address ? ` · ${p.address}` : ""}
                  </p>
                </div>
                <span className="tabular text-lg font-extrabold">{formatINR(p.amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader title="Handed over" subtitle="Recorded by the outlet" />
        {c.handovers.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted">No handovers yet.</p>
        ) : (
          <ul className="divide-y divide-line" data-testid="handover-history">
            {c.handovers.map((h) => (
              <li key={h.id} className="flex items-center gap-3 px-4 py-3">
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-secondary-50 text-secondary dark:bg-secondary/25 dark:text-green-300">
                  <Receipt size={22} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1 truncate font-semibold">
                    <UserCircle size={16} className="shrink-0 text-muted" /> {h.receivedBy?.name ?? "Outlet"}
                  </p>
                  <p className="truncate text-xs text-muted">
                    {formatDateTime(h.receivedAt)}
                    {h.note ? ` · ${h.note}` : ""}
                  </p>
                </div>
                <span className="tabular text-lg font-extrabold text-secondary dark:text-green-300">{formatINR(h.amount)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
