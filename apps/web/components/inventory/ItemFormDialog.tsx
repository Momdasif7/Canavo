"use client";

import { useEffect, useId, useState } from "react";
import { inventoryItemSchema, inventoryItemUpdateSchema, type InventoryItemInput, type InventoryItemUpdateInput } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { parseRupees, rupeesInput } from "@/lib/format";
import type { InventoryItem, ItemCategory, StockUnit } from "@/lib/types-inventory";
import { useToast } from "@/components/providers/ToastProvider";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { Alert } from "@/components/ui/States";
import { STOCK_UNITS, UNIT_LABELS, UNIT_NAMES, parseQty, qtyChars } from "./units";

interface FormState {
  name: string;
  sku: string;
  barcode: string;
  category: string;
  unit: StockUnit;
  cost: string;
  reorderLevel: string;
  reorderQty: string;
  openingStock: string;
}

export type ItemFormTarget = { mode: "create"; barcode?: string } | { mode: "edit"; item: InventoryItem } | null;

export function ItemFormDialog({
  target,
  categories,
  onClose,
  onSaved,
}: {
  target: ItemFormTarget;
  categories: ItemCategory[];
  onClose: () => void;
  onSaved: (item: InventoryItem) => void;
}) {
  const toast = useToast();
  const listId = useId();
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editing = target?.mode === "edit" ? target.item : null;

  useEffect(() => {
    if (!target) return;
    setError(null);
    if (target.mode === "edit") {
      const i = target.item;
      setForm({
        name: i.name,
        sku: i.sku ?? "",
        barcode: i.barcode ?? "",
        category: i.category,
        unit: i.unit,
        cost: rupeesInput(i.costPerUnit),
        reorderLevel: String(i.reorderLevel),
        reorderQty: String(i.reorderQty),
        openingStock: "",
      });
    } else {
      setForm({ name: "", sku: "", barcode: target.barcode ?? "", category: "", unit: "KG", cost: "", reorderLevel: "", reorderQty: "", openingStock: "" });
    }
  }, [target]);

  if (!form) return null;
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const save = async () => {
    const cost = form.cost.trim() ? parseRupees(form.cost) : 0;
    if (cost === null) return setError("Enter a valid cost per unit");
    const base = {
      name: form.name.trim(),
      sku: form.sku.trim() || null,
      barcode: form.barcode.trim() || null,
      category: form.category.trim() || "General",
      unit: form.unit,
      costPerUnit: cost,
      reorderLevel: parseQty(form.reorderLevel) ?? 0,
      reorderQty: parseQty(form.reorderQty) ?? 0,
    };
    setSaving(true);
    setError(null);
    try {
      let saved: InventoryItem;
      if (editing) {
        const parsed = inventoryItemUpdateSchema.safeParse(base);
        if (!parsed.success) throw new Error(`${parsed.error.issues[0].path.join(".")}: ${parsed.error.issues[0].message}`);
        const body: InventoryItemUpdateInput = parsed.data;
        saved = await api.patch<InventoryItem>(`/inventory/items/${editing.id}`, body);
      } else {
        const opening = parseQty(form.openingStock);
        const parsed = inventoryItemSchema.safeParse({ ...base, ...(opening ? { openingStock: opening } : {}) });
        if (!parsed.success) throw new Error(`${parsed.error.issues[0].path.join(".")}: ${parsed.error.issues[0].message}`);
        const body: InventoryItemInput = parsed.data;
        saved = await api.post<InventoryItem>("/inventory/items", body);
      }
      toast(editing ? "Item updated" : `${saved.name} added`, "success");
      onSaved(saved);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={!!target}
      onClose={onClose}
      size="lg"
      dismissible={!saving}
      title={editing ? `Edit ${editing.name}` : "New stock item"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            {editing ? "Save changes" : "Create item"}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {error && <Alert>{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Item name" aria-label="Item name" maxLength={120} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Toor dal" data-autofocus />
          <div>
            <Input label="Category" aria-label="Category" list={listId} maxLength={60} value={form.category} onChange={(e) => set("category", e.target.value)} placeholder="General" />
            <datalist id={listId}>
              {categories.map((c) => (
                <option key={c.category} value={c.category} />
              ))}
            </datalist>
          </div>
          <Input label="SKU" aria-label="SKU" maxLength={60} value={form.sku} onChange={(e) => set("sku", e.target.value)} placeholder="Optional" />
          <Input label="Barcode" aria-label="Barcode" maxLength={64} value={form.barcode} onChange={(e) => set("barcode", e.target.value)} placeholder="Scan or type" />
          <Select
            label="Stock unit"
            aria-label="Stock unit"
            value={form.unit}
            onChange={(e) => set("unit", e.target.value as StockUnit)}
            hint={editing ? "Unit can't change once the item has stock movements" : undefined}
          >
            {STOCK_UNITS.map((u) => (
              <option key={u} value={u}>
                {UNIT_NAMES[u]}
              </option>
            ))}
          </Select>
          <Input
            label={`Cost per ${UNIT_LABELS[form.unit]}`}
            aria-label="Cost per unit"
            inputMode="decimal"
            prefix="₹"
            value={form.cost}
            onChange={(e) => set("cost", qtyChars(e.target.value))}
            placeholder="0"
            hint={editing ? "Purchases update this automatically (weighted average)" : undefined}
          />
          <Input
            label={`Reorder level (${UNIT_LABELS[form.unit]})`}
            aria-label="Reorder level"
            inputMode="decimal"
            value={form.reorderLevel}
            onChange={(e) => set("reorderLevel", qtyChars(e.target.value))}
            placeholder="0 = no alert"
          />
          <Input
            label={`Reorder quantity (${UNIT_LABELS[form.unit]})`}
            aria-label="Reorder quantity"
            inputMode="decimal"
            value={form.reorderQty}
            onChange={(e) => set("reorderQty", qtyChars(e.target.value))}
            placeholder="Suggested order size"
          />
          {!editing && (
            <Input
              label={`Opening stock (${UNIT_LABELS[form.unit]})`}
              aria-label="Opening stock"
              inputMode="decimal"
              value={form.openingStock}
              onChange={(e) => set("openingStock", qtyChars(e.target.value))}
              placeholder="Optional"
              hint="Posted at the active outlet"
            />
          )}
        </div>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
