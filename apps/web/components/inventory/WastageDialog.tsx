"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus, Trash } from "@phosphor-icons/react";
import { formatINR, wastageSchema, type WastageInput } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import type { StockItem, StockUnit, WastageResult } from "@/lib/types-inventory";
import { useToast } from "@/components/providers/ToastProvider";
import { Dialog } from "@/components/ui/Dialog";
import { Button, IconButton } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Alert } from "@/components/ui/States";
import { ItemSelect, UnitSelect, lineKey } from "./common";
import { convertQty, parseQty, qtyChars, qtyWithUnit } from "./units";

interface Line {
  key: string;
  itemId: string;
  qty: string;
  unit: StockUnit | undefined;
  reason: string;
}

const blank = (itemId = "", unit?: StockUnit): Line => ({ key: lineKey(), itemId, qty: "", unit, reason: "" });

export function WastageDialog({
  open,
  items,
  initialItem,
  onClose,
  onSaved,
}: {
  open: boolean;
  items: StockItem[];
  /** Pre-select this item on the first line */
  initialItem?: StockItem | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const [lines, setLines] = useState<Line[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setLines([blank(initialItem?.id ?? "", initialItem?.unit)]);
  }, [open, initialItem]);

  const update = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const estimate = lines.reduce((s, l) => {
    const item = byId.get(l.itemId);
    const q = parseQty(l.qty);
    if (!item || q == null || !l.unit) return s;
    return s + Math.round(convertQty(q, l.unit, item.unit) * item.costPerUnit);
  }, 0);

  const save = async () => {
    const filled = lines.filter((l) => l.itemId || l.qty || l.reason);
    if (!filled.length) return setError("Add at least one item");
    for (const [idx, l] of filled.entries()) {
      const q = parseQty(l.qty);
      if (!l.itemId) return setError(`Line ${idx + 1}: choose an item`);
      if (q == null || q <= 0) return setError(`Line ${idx + 1}: enter a quantity`);
      if (l.reason.trim().length < 2) return setError(`Line ${idx + 1}: give a reason`);
    }
    const parsed = wastageSchema.safeParse({
      items: filled.map((l) => ({ inventoryItemId: l.itemId, quantity: parseQty(l.qty)!, unit: l.unit, reason: l.reason.trim() })),
    });
    if (!parsed.success) return setError(parsed.error.issues[0].message);
    const body: WastageInput = parsed.data;
    setSaving(true);
    setError(null);
    try {
      const res = await api.post<WastageResult>("/inventory/wastage", body);
      toast(`Wastage recorded (${formatINR(res.value)})`, "success");
      onSaved();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="xl"
      dismissible={!saving}
      title="Record wastage"
      description="Spoiled, expired or spilled stock. Deducted from the active outlet."
      footer={
        <>
          <span className="mr-auto self-center text-sm text-muted">
            Estimated value: <strong className="tabular text-fg">{formatINR(estimate)}</strong>
          </span>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="danger" onClick={save} loading={saving}>
            Record wastage
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <Alert>{error}</Alert>}
        {lines.map((l, idx) => {
          const item = byId.get(l.itemId);
          return (
            <div key={l.key} className="grid grid-cols-12 items-start gap-2 rounded-xl border border-line p-3">
              <div className="col-span-12 md:col-span-4">
                <ItemSelect
                  aria-label={`Wastage item ${idx + 1}`}
                  items={items}
                  value={l.itemId}
                  onChange={(id) => update(l.key, { itemId: id, unit: byId.get(id)?.unit })}
                />
                {item && <p className="mt-1 text-xs text-muted">In stock: {qtyWithUnit(item.quantity, item.unit)}</p>}
              </div>
              <Input
                aria-label={`Wastage quantity ${idx + 1}`}
                placeholder="Qty"
                inputMode="decimal"
                value={l.qty}
                onChange={(e) => update(l.key, { qty: qtyChars(e.target.value) })}
                wrapperClassName="col-span-4 md:col-span-2"
              />
              <UnitSelect aria-label={`Wastage unit ${idx + 1}`} baseUnit={item?.unit} value={l.unit} onChange={(u) => update(l.key, { unit: u })} className="col-span-3 md:col-span-1" />
              <Input
                aria-label={`Wastage reason ${idx + 1}`}
                placeholder="Reason (e.g. spoiled)"
                maxLength={200}
                value={l.reason}
                onChange={(e) => update(l.key, { reason: e.target.value })}
                wrapperClassName="col-span-12 md:col-span-4 order-last md:order-none"
              />
              <div className="col-span-5 flex justify-end md:col-span-1">
                <IconButton label={`Remove line ${idx + 1}`} disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                  <Trash size={20} />
                </IconButton>
              </div>
            </div>
          );
        })}
        <Button variant="outline" icon={<Plus size={18} />} onClick={() => setLines((ls) => [...ls, blank()])} disabled={lines.length >= 100}>
          Add line
        </Button>
      </div>
    </Dialog>
  );
}
