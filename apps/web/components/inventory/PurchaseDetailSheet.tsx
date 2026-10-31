"use client";

import { useEffect, useState } from "react";
import { CheckCircle, CurrencyInr, PencilSimple, XCircle } from "@phosphor-icons/react";
import { formatINR, purchasePaymentSchema, type PurchasePaymentInput } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { mediaUrl } from "@/lib/media";
import { formatDateTime, parseRupees, rupeesInput } from "@/lib/format";
import type { PurchaseDetail, PurchasePaymentMode } from "@/lib/types-inventory";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { Dialog, Sheet } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { Table, THead, Th, Td, Tr } from "@/components/ui/Table";
import { Alert, ErrorState, LoadingState } from "@/components/ui/States";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { PurchaseStatusBadge, Stat } from "./common";
import { InvoiceThumb } from "./PurchaseFormDialog";
import { UNIT_LABELS, formatQty, formatYmd, qtyChars } from "./units";

export function PurchaseDetailSheet({
  purchaseId,
  version,
  onClose,
  onEdit,
  onChanged,
}: {
  purchaseId: string | null;
  version: number;
  onClose: () => void;
  onEdit: (p: PurchaseDetail) => void;
  /** Called after any state change (receive, cancel, payment) */
  onChanged: (p: PurchaseDetail) => void;
}) {
  const { outletId, can } = useSession();
  const toast = useToast();
  const manage = can("inventory:manage");
  const q = useApiQuery<PurchaseDetail>(purchaseId ? `inv-purchase:${outletId}:${purchaseId}:${version}` : null, () =>
    api.get<PurchaseDetail>(`/inventory/purchases/${purchaseId}`),
  );
  const p = q.data && q.data.id === purchaseId ? q.data : undefined;
  const [receiving, setReceiving] = useState(false);
  const [confirmReceive, setConfirmReceive] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [paying, setPaying] = useState(false);

  const changed = (next: PurchaseDetail) => {
    q.setData(next);
    onChanged(next);
  };

  const receive = async () => {
    if (!p) return;
    setReceiving(true);
    try {
      changed(await api.post<PurchaseDetail>(`/inventory/purchases/${p.id}/receive`));
      toast("Purchase received — stock updated", "success");
    } catch (e) {
      throw new Error(errorMessage(e));
    } finally {
      setReceiving(false);
    }
  };

  return (
    <Sheet
      open={!!purchaseId}
      onClose={onClose}
      width="max-w-3xl"
      title={p ? `Purchase · ${p.vendor.name}` : "Purchase"}
      footer={
        p &&
        manage &&
        p.status !== "CANCELLED" && (
          <>
            <Button variant="ghost" icon={<XCircle size={18} />} className="mr-auto text-red-600 dark:text-red-400" onClick={() => setCancelling(true)}>
              Cancel purchase
            </Button>
            {p.status === "DRAFT" ? (
              <>
                <Button variant="outline" icon={<PencilSimple size={18} />} onClick={() => onEdit(p)}>
                  Edit draft
                </Button>
                <Button variant="secondary" icon={<CheckCircle size={18} />} loading={receiving} onClick={() => setConfirmReceive(true)}>
                  Receive stock
                </Button>
              </>
            ) : (
              <>
                <Button variant="outline" icon={<PencilSimple size={18} />} onClick={() => onEdit(p)}>
                  Edit invoice details
                </Button>
                {p.balance > 0 && (
                  <Button icon={<CurrencyInr size={18} />} onClick={() => setPaying(true)}>
                    Record payment
                  </Button>
                )}
              </>
            )}
          </>
        )
      }
    >
      {q.loading && !p ? (
        <LoadingState />
      ) : q.error ? (
        <ErrorState message={q.error} onRetry={q.reload} />
      ) : p ? (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-3">
            <PurchaseStatusBadge status={p.status} />
            <span className="text-sm text-muted">
              Created {formatDateTime(p.createdAt)}
              {p.receivedAt && ` · received ${formatDateTime(p.receivedAt)}`}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Total" value={formatINR(p.total)} note={`GST ${formatINR(p.tax)}`} />
            <Stat label="Paid" value={formatINR(p.paidAmount)} />
            <Stat label="Balance" value={formatINR(p.balance)} tone={p.status === "RECEIVED" && p.balance > 0 ? "warning" : undefined} />
            <Stat label="Invoice" value={p.invoiceNo ?? "—"} note={formatYmd(p.invoiceDate)} />
          </div>
          {p.invoiceImageUrl && (
            <div className="flex items-center gap-3 text-sm">
              <InvoiceThumb url={p.invoiceImageUrl} />
              <a href={mediaUrl(p.invoiceImageUrl)} target="_blank" rel="noreferrer noopener" className="truncate font-semibold text-primary-700 hover:underline dark:text-primary-200">
                View invoice photo
              </a>
            </div>
          )}
          <div className="rounded-xl border border-line">
            <Table>
              <THead>
                <tr>
                  <Th>Item</Th>
                  <Th className="text-right">Qty</Th>
                  <Th className="text-right">Unit cost</Th>
                  <Th className="text-right">GST</Th>
                  <Th className="text-right">Total</Th>
                </tr>
              </THead>
              <tbody>
                {p.items.map((l) => (
                  <Tr key={l.id}>
                    <Td className="font-medium">{l.item?.name ?? "Deleted item"}</Td>
                    <Td className="tabular whitespace-nowrap text-right">
                      {formatQty(l.quantity)} {l.item && <span className="text-xs text-muted">{UNIT_LABELS[l.item.unit]}</span>}
                    </Td>
                    <Td className="tabular text-right">{formatINR(l.unitCost)}</Td>
                    <Td className="tabular text-right">{l.taxRate}%</Td>
                    <Td className="tabular text-right font-semibold">{formatINR(l.total)}</Td>
                  </Tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-surface-2">
                  <Td colSpan={4} className="text-right text-muted">
                    Subtotal {formatINR(p.subtotal)} · GST {formatINR(p.tax)}
                  </Td>
                  <Td className="tabular text-right font-bold">{formatINR(p.total)}</Td>
                </tr>
              </tfoot>
            </Table>
          </div>
          {p.notes && (
            <section>
              <h3 className="mb-1 text-sm font-bold">Notes</h3>
              <p className="whitespace-pre-line text-sm text-muted">{p.notes}</p>
            </section>
          )}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirmReceive}
        tone="primary"
        title="Receive this purchase?"
        description="Stock is added to this outlet and item costs are updated. Quantities can't be edited afterwards."
        confirmLabel="Receive stock"
        onConfirm={receive}
        onClose={() => setConfirmReceive(false)}
      />
      <ConfirmDialog
        open={cancelling}
        title="Cancel purchase?"
        description={p?.status === "RECEIVED" ? "The received stock will be returned (deducted) from this outlet." : "The draft will be marked cancelled."}
        confirmLabel="Cancel purchase"
        reason={{ label: "Reason", placeholder: "At least 3 characters", minLength: 3 }}
        onConfirm={async (reason) => {
          try {
            changed(await api.post<PurchaseDetail>(`/inventory/purchases/${p!.id}/cancel`, { reason }));
          } catch (e) {
            throw new Error(errorMessage(e));
          }
          toast("Purchase cancelled", "success");
        }}
        onClose={() => setCancelling(false)}
      />
      <PaymentDialog
        purchase={paying ? (p ?? null) : null}
        onClose={() => setPaying(false)}
        onSaved={(next) => {
          changed(next);
          toast("Payment recorded", "success");
        }}
      />
    </Sheet>
  );
}

const MODES: { value: PurchasePaymentMode; label: string }[] = [
  { value: "CASH", label: "Cash" },
  { value: "UPI", label: "UPI" },
  { value: "BANK", label: "Bank" },
  { value: "CHEQUE", label: "Cheque" },
];

function PaymentDialog({ purchase, onClose, onSaved }: { purchase: PurchaseDetail | null; onClose: () => void; onSaved: (p: PurchaseDetail) => void }) {
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<PurchasePaymentMode>("CASH");
  const [reference, setReference] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!purchase) return;
    setAmount(rupeesInput(purchase.balance));
    setMode("CASH");
    setReference("");
    setError(null);
  }, [purchase]);

  if (!purchase) return null;
  const save = async () => {
    const paise = parseRupees(amount);
    if (!paise) return setError("Enter the amount paid");
    if (paise > purchase.balance) return setError(`Amount exceeds balance due (${formatINR(purchase.balance)})`);
    const parsed = purchasePaymentSchema.safeParse({ amount: paise, mode, reference: reference.trim() || null });
    if (!parsed.success) return setError(parsed.error.issues[0].message);
    const body: PurchasePaymentInput = parsed.data;
    setSaving(true);
    setError(null);
    try {
      onSaved(await api.post<PurchaseDetail>(`/inventory/purchases/${purchase.id}/payments`, body));
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      dismissible={!saving}
      title="Record payment"
      description={`Balance due ${formatINR(purchase.balance)} to ${purchase.vendor.name}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            Save payment
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Input label="Amount" aria-label="Payment amount" inputMode="decimal" prefix="₹" value={amount} onChange={(e) => setAmount(qtyChars(e.target.value))} data-autofocus />
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold">Mode</span>
          <Segmented value={mode} onChange={setMode} options={MODES} />
        </div>
        <Input label="Reference" aria-label="Payment reference" maxLength={100} value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR / cheque no. (optional)" />
      </div>
    </Dialog>
  );
}
