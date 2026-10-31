"use client";

import { useState } from "react";
import { ArrowRight, Check, Package, Truck, X, XCircle } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { TransferDetail } from "@/lib/types-inventory";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { Sheet } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Table, THead, Th, Td, Tr } from "@/components/ui/Table";
import { ErrorState, LoadingState } from "@/components/ui/States";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { TransferStatusBadge } from "./common";
import { UNIT_LABELS, formatQty } from "./units";

type Action = "approve" | "dispatch" | "receive" | "cancel";

const ACTION_COPY: Record<Action, { title: string; description: string; label: string; done: string }> = {
  approve: { title: "Approve transfer?", description: "The source outlet can then dispatch the goods.", label: "Approve", done: "Transfer approved" },
  dispatch: { title: "Dispatch stock?", description: "Stock is deducted from the source outlet now.", label: "Dispatch", done: "Stock dispatched" },
  receive: { title: "Confirm receipt?", description: "Stock is added to this outlet at the source's cost.", label: "Receive", done: "Stock received" },
  cancel: { title: "Cancel transfer?", description: "No stock has moved yet; the transfer is closed.", label: "Cancel transfer", done: "Transfer cancelled" },
};

export function TransferDetailSheet({
  transferId,
  version,
  onClose,
  onChanged,
}: {
  transferId: string | null;
  version: number;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { outletId, can } = useSession();
  const toast = useToast();
  const manage = can("inventory:manage");
  const q = useApiQuery<TransferDetail>(transferId ? `inv-transfer:${transferId}:${version}` : null, () => api.get<TransferDetail>(`/inventory/transfers/${transferId}`));
  const t = q.data && q.data.id === transferId ? q.data : undefined;
  const [action, setAction] = useState<Action | null>(null);
  const [rejecting, setRejecting] = useState(false);

  const run = async (a: Action | "reject", body?: unknown) => {
    if (!t) return;
    let next: TransferDetail;
    try {
      next = await api.post<TransferDetail>(`/inventory/transfers/${t.id}/${a}`, body);
    } catch (e) {
      throw new Error(errorMessage(e));
    }
    q.setData(next);
    onChanged();
    toast(a === "reject" ? "Transfer rejected" : ACTION_COPY[a].done, a === "cancel" || a === "reject" ? "info" : "success");
  };

  const source = t?.fromOutletId === outletId;
  const dest = t?.toOutletId === outletId;
  const open = t && (t.status === "REQUESTED" || t.status === "APPROVED");

  return (
    <Sheet
      open={!!transferId}
      onClose={onClose}
      width="max-w-2xl"
      title="Stock transfer"
      footer={
        t &&
        manage &&
        (open || (t.status === "DISPATCHED" && dest)) && (
          <>
            {open && (
              <Button variant="ghost" icon={<XCircle size={18} />} className="mr-auto" onClick={() => setAction("cancel")}>
                Cancel transfer
              </Button>
            )}
            {open && source && (
              <Button variant="outline" icon={<X size={18} />} className="text-red-600 dark:text-red-400" onClick={() => setRejecting(true)}>
                Reject
              </Button>
            )}
            {t.status === "REQUESTED" && source && (
              <Button icon={<Check size={18} />} onClick={() => setAction("approve")}>
                Approve
              </Button>
            )}
            {t.status === "APPROVED" && source && (
              <Button icon={<Truck size={18} />} onClick={() => setAction("dispatch")}>
                Dispatch
              </Button>
            )}
            {t.status === "DISPATCHED" && dest && (
              <Button variant="secondary" icon={<Package size={18} />} onClick={() => setAction("receive")}>
                Receive stock
              </Button>
            )}
          </>
        )
      }
    >
      {q.loading && !t ? (
        <LoadingState />
      ) : q.error ? (
        <ErrorState message={q.error} onRetry={q.reload} />
      ) : t ? (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-3 text-base font-semibold">
            <span className={source ? "text-primary-700 dark:text-primary-200" : ""}>{t.fromOutletName ?? "Unknown outlet"}</span>
            <ArrowRight size={18} className="text-muted" />
            <span className={dest ? "text-primary-700 dark:text-primary-200" : ""}>{t.toOutletName ?? "Unknown outlet"}</span>
            <TransferStatusBadge status={t.status} />
          </div>
          <p className="text-sm text-muted">
            Created {formatDateTime(t.createdAt)} · updated {formatDateTime(t.updatedAt)} · value approx. {formatINR(t.value)}
          </p>
          <StatusHint t={t} source={!!source} dest={!!dest} />
          <div className="rounded-xl border border-line">
            <Table>
              <THead>
                <tr>
                  <Th>Item</Th>
                  <Th className="text-right">Quantity</Th>
                </tr>
              </THead>
              <tbody>
                {t.items.map((l) => (
                  <Tr key={l.id}>
                    <Td className="font-medium">{l.item?.name ?? "Deleted item"}</Td>
                    <Td className="tabular text-right">
                      {formatQty(l.quantity)} {l.item && <span className="text-xs text-muted">{UNIT_LABELS[l.item.unit]}</span>}
                    </Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          </div>
          {t.notes && (
            <section>
              <h3 className="mb-1 text-sm font-bold">Notes</h3>
              <p className="whitespace-pre-line text-sm text-muted">{t.notes}</p>
            </section>
          )}
        </div>
      ) : null}

      {action && (
        <ConfirmDialog
          open
          tone={action === "cancel" ? "danger" : "primary"}
          title={ACTION_COPY[action].title}
          description={ACTION_COPY[action].description}
          confirmLabel={ACTION_COPY[action].label}
          onConfirm={() => run(action)}
          onClose={() => setAction(null)}
        />
      )}
      <ConfirmDialog
        open={rejecting}
        title="Reject transfer?"
        confirmLabel="Reject"
        reason={{ label: "Reason", placeholder: "At least 3 characters", minLength: 3 }}
        onConfirm={(reason) => run("reject", { reason })}
        onClose={() => setRejecting(false)}
      />
    </Sheet>
  );
}

function StatusHint({ t, source, dest }: { t: TransferDetail; source: boolean; dest: boolean }) {
  const msg =
    t.status === "REQUESTED"
      ? source
        ? "Waiting for your approval (outlet managers only)."
        : `Waiting for ${t.fromOutletName ?? "the source outlet"} to approve.`
      : t.status === "APPROVED"
        ? source
          ? "Approved — dispatch when the goods leave."
          : `Approved — waiting for ${t.fromOutletName ?? "the source outlet"} to dispatch.`
        : t.status === "DISPATCHED"
          ? dest
            ? "On the way — confirm receipt when it arrives."
            : `Dispatched — waiting for ${t.toOutletName ?? "the destination"} to receive.`
          : null;
  return msg ? <p className="rounded-xl bg-surface-2 px-4 py-3 text-sm">{msg}</p> : null;
}
