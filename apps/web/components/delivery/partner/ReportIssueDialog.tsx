"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { api, errorMessage } from "@/lib/api";
import type { Delivery } from "@/lib/types-service";
import { DELIVERY_ISSUES, DELIVERY_ISSUE_LABELS, type DeliveryIssueReason } from "@/lib/types-delivery";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Input";
import { Alert } from "@/components/ui/States";

/** "Report a problem" — the outlet's managers are notified and decide what to do. */
export function ReportIssueDialog({ delivery, onClose, onReported }: { delivery: Delivery | null; onClose: () => void; onReported: (d: Delivery) => void }) {
  const [reason, setReason] = useState<DeliveryIssueReason | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (delivery) {
      setReason(null);
      setNote("");
      setError(null);
      setBusy(false);
    }
  }, [delivery]);

  const submit = async () => {
    if (!delivery || !reason) return;
    setBusy(true);
    setError(null);
    try {
      onReported(await api.post<Delivery>(`/delivery/${delivery.id}/issue`, { reason, note: note.trim() || undefined }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={!!delivery}
      onClose={onClose}
      dismissible={!busy}
      title="Report a problem"
      description={delivery ? `${delivery.order.invoiceNumber} · ${delivery.customerName}` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Back
          </Button>
          <Button variant="danger" onClick={() => void submit()} loading={busy} disabled={!reason}>
            Notify outlet
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <Alert>{error}</Alert>}
        <div className="grid gap-2" role="radiogroup" aria-label="Problem">
          {DELIVERY_ISSUES.map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={reason === r}
              onClick={() => setReason(r)}
              className={clsx(
                "min-h-[52px] rounded-xl border px-4 text-left font-semibold transition-colors",
                reason === r ? "border-red-500 bg-red-50 text-red-800 dark:bg-red-500/15 dark:text-red-200" : "border-line hover:bg-surface-2",
              )}
            >
              {DELIVERY_ISSUE_LABELS[r]}
            </button>
          ))}
        </div>
        <Textarea label="Details (optional)" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="e.g. called twice, gate locked" />
      </div>
    </Dialog>
  );
}
