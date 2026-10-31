"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { ArrowRight, HandCoins, Phone } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { CashSettleResult, PartnerCash } from "@/lib/types-delivery";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useSocketEvent } from "@/components/providers/SocketProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { HandoverDialog, type PartnerOption } from "./manager/HandoverDialog";

/** Manager: cash each delivery partner holds (ledger), today's movement, pending orders; record what they hand over. */
export function CashPanel({ onTotal }: { onTotal?: (amount: number) => void }) {
  const { outletId } = useSession();
  const toast = useToast();
  const q = useApiQuery<PartnerCash[]>(outletId ? `delivery-cash:${outletId}` : null, () => api.get<PartnerCash[]>("/delivery/cash"));
  useSocketEvent("delivery:updated", () => void q.reload());
  useSocketEvent("order:paid", () => void q.reload());
  const [recording, setRecording] = useState<string | null>(null);
  const [settling, setSettling] = useState<PartnerCash | null>(null);

  const rows = useMemo(() => q.data ?? [], [q.data]);
  const total = rows.reduce((s, r) => s + Math.max(0, r.balance), 0);
  useEffect(() => {
    if (q.data) onTotal?.(total);
  }, [q.data, total, onTotal]);
  const partners = useMemo<PartnerOption[]>(() => rows.map((r) => ({ id: r.agent.id, name: r.agent.name, balance: r.balance })), [rows]);

  if (q.loading && !q.data) return <LoadingState label="Loading cash with partners…" />;
  if (q.error && !q.data) return <ErrorState message={q.error} onRetry={q.reload} />;

  return (
    <div className="space-y-3">
      <Card className="flex flex-wrap items-center gap-3 p-4">
        <HandCoins size={32} className="text-primary" weight="duotone" />
        <div>
          <p className="text-sm font-semibold text-muted">Cash with delivery partners</p>
          <p className="tabular text-2xl font-extrabold" data-testid="cash-with-partners-total">
            {formatINR(total)}
          </p>
        </div>
        <Link href="/delivery/partners" className="ml-auto inline-flex min-h-tap items-center gap-1.5 rounded-xl px-3 text-sm font-semibold text-primary hover:bg-surface-2">
          Partner activity & history <ArrowRight size={16} weight="bold" />
        </Link>
      </Card>
      {rows.length === 0 ? (
        <Card>
          <EmptyState title="No delivery partners" description="When partners collect cash on delivery, it shows up here until you record the handover." />
        </Card>
      ) : (
        rows.map((r) => (
          <Card key={r.agent.id} className="overflow-hidden" data-testid="partner-cash">
            <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="font-bold">{r.agent.name}</p>
                <a href={`tel:${r.agent.phone}`} className="flex items-center gap-1 text-xs text-muted hover:text-primary">
                  <Phone size={12} /> {r.agent.phone}
                </a>
              </div>
              <div className="text-right">
                <p className="text-xs font-semibold text-muted">To receive</p>
                <p className={clsx("tabular text-xl font-extrabold", r.balance > 0 && "text-primary-700 dark:text-primary-200")}>{formatINR(r.balance)}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-sm">
              <span>
                Collected today <strong className="tabular">{formatINR(r.collectedToday)}</strong>
              </span>
              <span>
                Received today <strong className="tabular text-secondary dark:text-green-300">{formatINR(r.receivedToday)}</strong>
              </span>
              <span className="text-muted">Last handover {r.lastHandoverAt ? formatDateTime(r.lastHandoverAt) : "—"}</span>
            </div>
            {r.pending.length > 0 && (
              <ul className="divide-y divide-line border-t border-line">
                {r.pending.map((x, i) => (
                  <li key={`${x.orderId}-${i}`} className="flex items-center gap-3 px-4 py-2 text-sm">
                    <span className="font-mono font-semibold">{x.invoiceNumber}</span>
                    <span className="min-w-0 flex-1 truncate text-muted">{x.customerName ?? ""}</span>
                    <span className="hidden text-xs text-muted sm:inline">{x.collectedAt ? formatDateTime(x.collectedAt) : ""}</span>
                    <span className="tabular font-bold">{formatINR(x.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex flex-wrap justify-end gap-2 border-t border-line px-4 py-3">
              <Button variant="outline" disabled={r.balance <= 0} onClick={() => setSettling(r)}>
                Received everything
              </Button>
              <Button variant="secondary" onClick={() => setRecording(r.agent.id)}>
                Record cash received
              </Button>
            </div>
          </Card>
        ))
      )}
      <HandoverDialog open={!!recording} partners={partners} agentId={recording} onClose={() => setRecording(null)} onSaved={() => void q.reload()} />
      <ConfirmDialog
        open={!!settling}
        tone="primary"
        title={settling ? `Received ${formatINR(settling.balance)} from ${settling.agent.name}?` : ""}
        description="Confirm you counted all the cash the partner holds. For a partial amount, use Record cash received."
        confirmLabel="Confirm handover"
        onClose={() => setSettling(null)}
        onConfirm={async () => {
          if (!settling) return;
          const res = await api.post<CashSettleResult>("/delivery/cash/settle", { agentId: settling.agent.id });
          toast(`Received ${formatINR(res.amount)} from ${settling.agent.name}`, "success");
          await q.reload();
        }}
      />
    </div>
  );
}
