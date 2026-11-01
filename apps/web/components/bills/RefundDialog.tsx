"use client";

import { useEffect, useMemo, useState } from "react";
import { REFUND_REASON_LABELS, REFUND_REASONS, formatINR, type RefundReason } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import type { CreditNote, Order } from "@/lib/types";
import { useApproval } from "@/components/providers/ApprovalProvider";
import { useSession } from "@/components/providers/SessionProvider";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea, Toggle } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { Alert } from "@/components/ui/States";

const MODES = [
  { value: "CASH", label: "Cash" },
  { value: "UPI", label: "UPI" },
  { value: "CARD", label: "Card" },
  { value: "KHATA", label: "Khata credit" },
] as const;

/**
 * Refund a paid bill as a GST credit note (Phase 3.1): pick items and quantities, or a value
 * only (overcharge). Approvals (APPROVAL_PINS) are asked for automatically.
 */
export function RefundDialog({ order, credited, open, onClose, onDone }: { order: Order; credited: CreditNote[]; open: boolean; onClose: () => void; onDone: (cn: CreditNote) => void }) {
  const withApproval = useApproval();
  const { me } = useSession();
  const [kind, setKind] = useState<"items" | "amount">("items");
  const [qty, setQty] = useState<Record<string, number>>({});
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState<RefundReason>("QUALITY");
  const [note, setNote] = useState("");
  const [mode, setMode] = useState<(typeof MODES)[number]["value"]>("CASH");
  const [restock, setRestock] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setQty({});
    setAmount("");
    setNote("");
    setError(null);
    setRestock(false);
    setKind("items");
  }, [open]);

  const left = useMemo(() => {
    const done = new Map<string, number>();
    for (const cn of credited) for (const l of cn.items) done.set(l.orderItemId, (done.get(l.orderItemId) ?? 0) + l.quantity);
    return new Map(order.items.map((i) => [i.id, i.quantity - (done.get(i.id) ?? 0)]));
  }, [credited, order.items]);
  const remaining = order.grandTotal - (order.refundedAmount ?? 0);
  const preview = kind === "items" ? order.items.reduce((s, i) => s + Math.round((i.total * (qty[i.id] ?? 0)) / i.quantity), 0) : Math.round(Number(amount || 0) * 100);
  const khataPaid = order.payments.some((p) => p.mode === "KHATA");
  const inventory = me?.modules?.includes("INVENTORY") ?? true;

  const save = async () => {
    const items = Object.entries(qty).filter(([, q]) => q > 0).map(([orderItemId, quantity]) => ({ orderItemId, quantity }));
    const body = {
      reason,
      note: note.trim() || undefined,
      refundMode: mode,
      restock: kind === "items" && restock,
      ...(kind === "items" ? { items } : { amount: Math.round(Number(amount) * 100) }),
    };
    setSaving(true);
    setError(null);
    try {
      const cn = await withApproval((approval) => api.post<CreditNote>(`/orders/${order.id}/refunds`, { ...body, approval }));
      onDone(cn);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const valid = preview > 0 && preview <= remaining && (reason !== "OTHER" || note.trim().length >= 3);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Refund on ${order.invoiceNumber}`}
      description={`A credit note is issued; the bill stays as it was. Up to ${formatINR(remaining)} can still be refunded.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={saving} disabled={!valid} onClick={() => void save()}>
            Refund {preview > 0 ? formatINR(Math.min(preview, remaining)) : ""}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Segmented
          value={kind}
          onChange={setKind}
          options={[
            { value: "items", label: "Items" },
            { value: "amount", label: "Amount only" },
          ]}
        />
        {kind === "items" ? (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {order.items.map((i) => {
              const max = left.get(i.id) ?? 0;
              return (
                <li key={i.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="font-medium">{i.name}</span>
                    <span className="block text-xs text-muted">
                      {max} of {i.quantity} refundable · {formatINR(Math.round(i.total / i.quantity))} each incl. tax
                    </span>
                  </span>
                  <Input
                    aria-label={`Quantity of ${i.name} to refund`}
                    type="number"
                    min={0}
                    max={max}
                    disabled={max === 0}
                    value={qty[i.id] ?? 0}
                    onChange={(e) => setQty((q) => ({ ...q, [i.id]: Math.max(0, Math.min(max, Number(e.target.value) || 0)) }))}
                    wrapperClassName="w-20"
                  />
                </li>
              );
            })}
          </ul>
        ) : (
          <Input label="Amount (₹, incl. tax)" type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Reason" value={reason} onChange={(e) => setReason(e.target.value as RefundReason)}>
            {REFUND_REASONS.map((r) => (
              <option key={r} value={r}>
                {REFUND_REASON_LABELS[r]}
              </option>
            ))}
          </Select>
          <Select label="Refund by" value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
            {MODES.filter((m) => m.value !== "KHATA" || khataPaid).map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </Select>
        </div>
        <Textarea label={reason === "OTHER" ? "Describe the reason" : "Note (optional)"} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
        {kind === "items" && inventory && (
          <Toggle label="Put ingredients back into stock" description="Only if the food wasn't made or came back unopened." checked={restock} onChange={setRestock} />
        )}
      </div>
    </Dialog>
  );
}
