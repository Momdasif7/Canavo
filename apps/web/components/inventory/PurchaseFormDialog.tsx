"use client";

import { useEffect, useMemo, useState } from "react";
import { ArrowSquareOut, Plus, Trash } from "@phosphor-icons/react";
import {
  computePurchaseTotals,
  formatINR,
  purchaseCreateSchema,
  purchaseUpdateSchema,
  type PurchaseCreateInput,
  type PurchaseUpdateInput,
} from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { parseRupees, rupeesInput } from "@/lib/format";
import { todayISO } from "@/lib/dates";
import { mediaUrl } from "@/lib/media";
import type { PurchaseDetail, VendorWithSummary } from "@/lib/types-inventory";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { Dialog } from "@/components/ui/Dialog";
import { Button, IconButton } from "@/components/ui/Button";
import { Input, Select, Textarea } from "@/components/ui/Input";
import { Alert, LoadingState } from "@/components/ui/States";
import { ItemSelect, lineKey, useStockItems } from "./common";
import { GST_RATES, UNIT_LABELS, parseQty, qtyChars } from "./units";

interface Line {
  key: string;
  itemId: string;
  qty: string;
  cost: string;
  taxRate: number;
}

interface FormState {
  vendorId: string;
  invoiceNo: string;
  invoiceDate: string;
  invoiceImageUrl: string;
  notes: string;
  lines: Line[];
}

const blankLine = (): Line => ({ key: lineKey(), itemId: "", qty: "", cost: "", taxRate: 0 });

/** create = new purchase; edit = draft (everything) or received (paperwork only); null = closed */
export type PurchaseFormTarget = { mode: "create"; vendorId?: string } | { mode: "edit"; purchase: PurchaseDetail } | null;

export function PurchaseFormDialog({ target, onClose, onSaved }: { target: PurchaseFormTarget; onClose: () => void; onSaved: (p: PurchaseDetail) => void }) {
  const { outletId } = useSession();
  const toast = useToast();
  const open = !!target;
  const vendors = useApiQuery<VendorWithSummary[]>(open && outletId ? `inv-vendors-active:${outletId}` : null, () => api.get<VendorWithSummary[]>("/inventory/vendors"));
  const stock = useStockItems(open);
  const items = useMemo(() => stock.data?.items ?? [], [stock.data]);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState<"draft" | "receive" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const editing = target?.mode === "edit" ? target.purchase : null;
  const paperworkOnly = editing?.status === "RECEIVED";

  useEffect(() => {
    if (!target) return;
    setError(null);
    if (target.mode === "edit") {
      const p = target.purchase;
      setForm({
        vendorId: p.vendorId,
        invoiceNo: p.invoiceNo ?? "",
        invoiceDate: p.invoiceDate ?? "",
        invoiceImageUrl: p.invoiceImageUrl ?? "",
        notes: p.notes ?? "",
        lines: p.items.map((l) => ({ key: lineKey(), itemId: l.inventoryItemId, qty: String(l.quantity), cost: rupeesInput(l.unitCost), taxRate: l.taxRate })),
      });
    } else {
      setForm({ vendorId: target.vendorId ?? "", invoiceNo: "", invoiceDate: todayISO(), invoiceImageUrl: "", notes: "", lines: [blankLine()] });
    }
  }, [target]);

  const totals = useMemo(
    () =>
      computePurchaseTotals(
        (form?.lines ?? []).map((l) => ({ quantity: parseQty(l.qty) ?? 0, unitCost: parseRupees(l.cost) ?? 0, taxRate: l.taxRate })),
      ),
    [form?.lines],
  );

  if (!form) return null;
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const updateLine = (key: string, patch: Partial<Line>) => setForm((f) => (f ? { ...f, lines: f.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) } : f));
  const used = new Set(form.lines.map((l) => l.itemId).filter(Boolean));

  const paperwork = {
    invoiceNo: form.invoiceNo.trim() || null,
    invoiceDate: form.invoiceDate || null,
    invoiceImageUrl: form.invoiceImageUrl.trim() || null,
    notes: form.notes.trim() || null,
  };

  const buildLines = () => {
    const filled = form.lines.filter((l) => l.itemId || l.qty || l.cost);
    if (!filled.length) throw new Error("Add at least one item");
    return filled.map((l, idx) => {
      const quantity = parseQty(l.qty);
      const unitCost = parseRupees(l.cost);
      if (!l.itemId) throw new Error(`Line ${idx + 1}: choose an item`);
      if (quantity == null || quantity <= 0) throw new Error(`Line ${idx + 1}: enter a quantity`);
      if (unitCost == null) throw new Error(`Line ${idx + 1}: enter the unit cost`);
      return { inventoryItemId: l.itemId, quantity, unitCost, taxRate: l.taxRate };
    });
  };

  const save = async (receive: boolean) => {
    setError(null);
    setSaving(receive ? "receive" : "draft");
    try {
      let saved: PurchaseDetail;
      if (paperworkOnly && editing) {
        const parsed = purchaseUpdateSchema.safeParse(paperwork);
        if (!parsed.success) throw new Error(parsed.error.issues[0].message);
        const body: PurchaseUpdateInput = parsed.data;
        saved = await api.patch<PurchaseDetail>(`/inventory/purchases/${editing.id}`, body);
        toast("Invoice details updated", "success");
      } else {
        if (!form.vendorId) throw new Error("Choose a vendor");
        const lines = buildLines();
        if (editing) {
          const parsed = purchaseUpdateSchema.safeParse({ vendorId: form.vendorId, ...paperwork, items: lines });
          if (!parsed.success) throw new Error(parsed.error.issues[0].message);
          const body: PurchaseUpdateInput = parsed.data;
          saved = await api.patch<PurchaseDetail>(`/inventory/purchases/${editing.id}`, body);
          if (receive) saved = await api.post<PurchaseDetail>(`/inventory/purchases/${editing.id}/receive`);
        } else {
          const parsed = purchaseCreateSchema.safeParse({ vendorId: form.vendorId, ...paperwork, items: lines, receive });
          if (!parsed.success) throw new Error(parsed.error.issues[0].message);
          const body: PurchaseCreateInput = parsed.data;
          saved = await api.post<PurchaseDetail>("/inventory/purchases", body);
        }
        toast(receive ? "Purchase received — stock updated" : "Draft saved", "success");
      }
      onSaved(saved);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(null);
    }
  };

  const activeVendors = (vendors.data ?? []).filter((v) => v.active || v.id === form.vendorId);
  const editingVendorMissing = editing && !activeVendors.some((v) => v.id === editing.vendorId);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      dismissible={!saving}
      title={paperworkOnly ? "Edit invoice details" : editing ? "Edit draft purchase" : "New purchase"}
      footer={
        <>
          {!paperworkOnly && (
            <span className="mr-auto self-center text-sm text-muted">
              Total <strong className="tabular text-base text-fg">{formatINR(totals.total)}</strong>
            </span>
          )}
          <Button variant="ghost" onClick={onClose} disabled={!!saving}>
            Cancel
          </Button>
          <Button variant={paperworkOnly ? "primary" : "outline"} onClick={() => save(false)} loading={saving === "draft"} disabled={!!saving}>
            {paperworkOnly ? "Save" : "Save draft"}
          </Button>
          {!paperworkOnly && (
            <Button variant="secondary" onClick={() => save(true)} loading={saving === "receive"} disabled={!!saving}>
              Save & receive
            </Button>
          )}
        </>
      }
    >
      {(vendors.loading && !vendors.data) || (stock.loading && !stock.data) ? (
        <LoadingState />
      ) : (
        <div className="space-y-4">
          {error && <Alert>{error}</Alert>}
          {(vendors.error || stock.error) && <Alert>{vendors.error ?? stock.error}</Alert>}
          <div className="grid gap-4 md:grid-cols-3">
            <Select label="Vendor" aria-label="Vendor" value={form.vendorId} disabled={paperworkOnly} onChange={(e) => set("vendorId", e.target.value)}>
              <option value="">Select vendor…</option>
              {editingVendorMissing && editing && <option value={editing.vendorId}>{editing.vendor.name}</option>}
              {activeVendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
            <Input label="Invoice no." aria-label="Invoice number" maxLength={60} value={form.invoiceNo} onChange={(e) => set("invoiceNo", e.target.value)} />
            <Input label="Invoice date" aria-label="Invoice date" type="date" value={form.invoiceDate} onChange={(e) => set("invoiceDate", e.target.value)} />
          </div>
          <div className="flex items-end gap-3">
            <Input
              label="Invoice photo URL"
              aria-label="Invoice photo URL"
              maxLength={1000}
              placeholder="https://…"
              value={form.invoiceImageUrl}
              onChange={(e) => set("invoiceImageUrl", e.target.value)}
              wrapperClassName="flex-1"
            />
            {/^https?:\/\//.test(form.invoiceImageUrl.trim()) && <InvoiceThumb url={form.invoiceImageUrl.trim()} />}
          </div>

          {!paperworkOnly ? (
            <section>
              <h3 className="mb-2 text-sm font-semibold">Items</h3>
              <div className="space-y-2">
                {form.lines.map((l, idx) => {
                  const item = byId.get(l.itemId);
                  const lt = totals.lines[idx];
                  return (
                    <div key={l.key} className="grid grid-cols-12 items-start gap-2 rounded-xl border border-line p-3">
                      <div className="col-span-12 lg:col-span-4">
                        <ItemSelect
                          aria-label={`Purchase item ${idx + 1}`}
                          items={items}
                          value={l.itemId}
                          exclude={used}
                          onChange={(id) => {
                            const it = byId.get(id);
                            updateLine(l.key, { itemId: id, ...(it && !l.cost && it.costPerUnit ? { cost: rupeesInput(it.costPerUnit) } : {}) });
                          }}
                        />
                      </div>
                      <Input
                        aria-label={`Purchase quantity ${idx + 1}`}
                        placeholder={item ? `Qty (${UNIT_LABELS[item.unit]})` : "Qty"}
                        inputMode="decimal"
                        value={l.qty}
                        onChange={(e) => updateLine(l.key, { qty: qtyChars(e.target.value) })}
                        wrapperClassName="col-span-4 lg:col-span-2"
                      />
                      <Input
                        aria-label={`Unit cost ${idx + 1}`}
                        placeholder={item ? `per ${UNIT_LABELS[item.unit]}` : "Unit cost"}
                        inputMode="decimal"
                        prefix="₹"
                        value={l.cost}
                        onChange={(e) => updateLine(l.key, { cost: qtyChars(e.target.value) })}
                        wrapperClassName="col-span-4 lg:col-span-2"
                      />
                      <Select aria-label={`GST rate ${idx + 1}`} value={l.taxRate} onChange={(e) => updateLine(l.key, { taxRate: Number(e.target.value) })} className="col-span-4 lg:col-span-1">
                        {GST_RATES.map((r) => (
                          <option key={r} value={r}>
                            {r}%
                          </option>
                        ))}
                      </Select>
                      <div className="col-span-8 flex min-h-tap items-center justify-end lg:col-span-2">
                        <span className="tabular font-semibold">{formatINR(lt?.total ?? 0)}</span>
                      </div>
                      <div className="col-span-4 flex justify-end lg:col-span-1">
                        <IconButton
                          label={`Remove line ${idx + 1}`}
                          disabled={form.lines.length === 1}
                          onClick={() => set("lines", form.lines.filter((x) => x.key !== l.key))}
                        >
                          <Trash size={20} />
                        </IconButton>
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="mt-3 flex flex-wrap items-start justify-between gap-4">
                <Button variant="outline" icon={<Plus size={18} />} onClick={() => set("lines", [...form.lines, blankLine()])} disabled={form.lines.length >= 200}>
                  Add line
                </Button>
                <dl className="tabular min-w-[220px] space-y-1 text-sm">
                  <div className="flex justify-between gap-6">
                    <dt className="text-muted">Subtotal</dt>
                    <dd>{formatINR(totals.subtotal)}</dd>
                  </div>
                  <div className="flex justify-between gap-6">
                    <dt className="text-muted">GST</dt>
                    <dd>{formatINR(totals.tax)}</dd>
                  </div>
                  <div className="flex justify-between gap-6 border-t border-line pt-1 text-base font-bold">
                    <dt>Total</dt>
                    <dd>{formatINR(totals.total)}</dd>
                  </div>
                </dl>
              </div>
            </section>
          ) : (
            <Alert tone="info">Quantities and costs are locked once a purchase is received. Cancel it to return the stock.</Alert>
          )}
          <Textarea label="Notes" maxLength={500} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
        </div>
      )}
    </Dialog>
  );
}

export function InvoiceThumb({ url }: { url: string }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);
  return (
    <a
      href={mediaUrl(url)}
      target="_blank"
      rel="noreferrer noopener"
      className="flex h-12 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border border-line bg-surface-2 text-muted"
      title="Open invoice photo"
      aria-label="Open invoice photo"
    >
      {broken ? (
        <ArrowSquareOut size={20} />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={mediaUrl(url)} alt="Invoice" className="h-full w-full object-cover" onError={() => setBroken(true)} />
      )}
    </a>
  );
}

