"use client";

import { useEffect, useState } from "react";
import { BellRinging, Check, X } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { formatTime } from "@/lib/format";
import type { ChannelRequestRow } from "@/lib/storefront";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useSocketEvent } from "@/components/providers/SocketProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Dialog } from "@/components/ui/Dialog";

const PAYMENT_LABEL: Record<string, string> = { COUNTER: "Pay at counter", COD: "Cash on delivery", UPI: "UPI prepaid" };

/**
 * Phase 6.3 / 6.4: QR and online orders waiting for a waiter / cashier. A slim bar on the POS
 * and Tables screens (nothing at all when the CHANNELS module is off or nothing is waiting).
 */
export function IncomingOrders({ onChanged }: { onChanged?: () => void }) {
  const { me, outletId, can } = useSession();
  const enabled = Boolean(me?.modules?.includes("CHANNELS")) && (can("table:serve") || can("order:create"));
  const q = useApiQuery<ChannelRequestRow[]>(enabled && outletId ? `channel-requests:${outletId}` : null, () => api.get<ChannelRequestRow[]>("/storefront/requests"));
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<ChannelRequestRow | null>(null);
  const toast = useToast();
  const { reload } = q;

  useSocketEvent("channel:request", () => enabled && void reload());
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => void reload(), 30_000);
    return () => window.clearInterval(id);
  }, [enabled, reload]);

  const rows = q.data ?? [];
  useEffect(() => {
    if (open && rows.length === 0) setOpen(false);
  }, [open, rows.length]);
  if (!enabled || rows.length === 0) return null;

  const accept = async (r: ChannelRequestRow) => {
    setBusy(r.id);
    try {
      await api.post(`/storefront/requests/${r.id}/accept`);
      toast(r.channel === "QR" ? `Sent to the kitchen · Table ${r.tableLabel ?? ""}` : `Accepted · ${r.order?.invoiceNumber ?? ""}`, "success");
      onChanged?.();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(null);
      void reload();
    }
  };

  const qr = rows.filter((r) => r.channel === "QR").length;
  const online = rows.length - qr;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-center gap-2 bg-amber-100 px-4 py-2 text-left text-sm font-semibold text-amber-900 hover:bg-amber-200 dark:bg-amber-500/20 dark:text-amber-100 dark:hover:bg-amber-500/30"
      >
        <BellRinging size={18} weight="fill" className="shrink-0 animate-pulse" />
        <span className="flex-1">
          {[qr && `${qr} QR order${qr === 1 ? "" : "s"}`, online && `${online} online order${online === 1 ? "" : "s"}`].filter(Boolean).join(" · ")} waiting for you
        </span>
        <span className="underline">Review</span>
      </button>

      <Dialog open={open} onClose={() => setOpen(false)} title="New online orders" description="Accept to send to the kitchen, or reject with a reason." size="lg">
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.id} className="rounded-xl border border-line p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={r.channel === "QR" ? "info" : "primary"}>{r.channel === "QR" ? "QR" : "Online"}</Badge>
                <span className="font-bold text-fg">
                  {r.channel === "QR" ? `Table ${r.tableLabel ?? "?"}` : `${r.order?.orderType === "DELIVERY" ? "Delivery" : "Takeaway"} · ${r.order?.invoiceNumber ?? ""}`}
                </span>
                <span className="ml-auto text-sm text-muted">{formatTime(r.createdAt)}</span>
              </div>
              {(r.customerName || r.customerPhone) && (
                <p className="mt-1 text-sm text-muted">{[r.customerName, r.customerPhone].filter(Boolean).join(" · ")}</p>
              )}
              <ul className="mt-2 text-sm">
                {r.items.map((i, n) => (
                  <li key={n}>
                    <span className="font-semibold">{i.quantity} ×</span> {i.name}
                    {i.notes && <span className="text-muted"> — {i.notes}</span>}
                  </li>
                ))}
              </ul>
              {r.channel === "ONLINE" && r.order?.notes && <p className="mt-1 text-sm text-muted">{r.order.notes}</p>}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="mr-auto font-bold tabular-nums">
                  {formatINR(r.order?.grandTotal ?? r.total)}
                  {r.payment && <span className="ml-2 text-sm font-normal text-muted">{PAYMENT_LABEL[r.payment] ?? r.payment}</span>}
                </span>
                <Button size="sm" variant="outline" icon={<X size={18} />} onClick={() => setRejecting(r)} disabled={busy === r.id}>
                  Reject
                </Button>
                <Button size="sm" variant="secondary" icon={<Check size={18} />} loading={busy === r.id} onClick={() => void accept(r)}>
                  Accept
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Dialog>

      <ConfirmDialog
        open={!!rejecting}
        title="Reject this order?"
        description={rejecting?.channel === "ONLINE" ? "The bill is cancelled and the customer sees your reason." : "The guest sees your reason on their phone."}
        confirmLabel="Reject order"
        reason={{ label: "Reason", placeholder: "e.g. Item finished, kitchen closing", minLength: 3, required: true }}
        onClose={() => setRejecting(null)}
        onConfirm={async (reason) => {
          await api.post(`/storefront/requests/${rejecting!.id}/reject`, { reason });
          setRejecting(null);
          void reload();
          onChanged?.();
        }}
      />
    </>
  );
}
