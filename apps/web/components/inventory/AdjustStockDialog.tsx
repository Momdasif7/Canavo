"use client";

import { useEffect, useState } from "react";
import { stockAdjustSchema, type StockAdjustInput } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { parseRupees } from "@/lib/format";
import type { StockItem } from "@/lib/types-inventory";
import { useToast } from "@/components/providers/ToastProvider";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input, Toggle } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { Alert } from "@/components/ui/States";
import { UNIT_LABELS, parseQty, qtyChars, qtyWithUnit, round3 } from "./units";

type Mode = "add" | "remove" | "set";

export function AdjustStockDialog({ item, onClose, onSaved }: { item: StockItem | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<Mode>("add");
  const [qty, setQty] = useState("");
  const [reason, setReason] = useState("");
  const [opening, setOpening] = useState(false);
  const [cost, setCost] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!item) return;
    setMode("add");
    setQty("");
    setReason("");
    setOpening(false);
    setCost("");
    setError(null);
  }, [item]);

  if (!item) return null;
  const n = parseQty(qty);
  const after = n == null ? null : mode === "add" ? round3(item.quantity + n) : mode === "remove" ? round3(item.quantity - n) : n;
  const adding = mode === "add" || (mode === "set" && n != null && n > item.quantity);

  const save = async () => {
    if (n == null || n < 0 || (mode !== "set" && n === 0)) return setError("Enter a valid quantity");
    let unitCost: number | undefined;
    if (adding && cost.trim()) {
      const c = parseRupees(cost);
      if (c === null) return setError("Enter a valid unit cost");
      unitCost = c;
    }
    const payload = {
      ...(mode === "set" ? { setTo: n } : { quantity: mode === "add" ? n : -n }),
      reason: reason.trim(),
      opening,
      ...(unitCost !== undefined && { unitCost }),
    };
    const parsed = stockAdjustSchema.safeParse(payload);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return setError(issue.path[0] === "reason" ? "Give a reason (at least 2 characters)" : issue.message);
    }
    const body: StockAdjustInput = parsed.data;
    setSaving(true);
    setError(null);
    try {
      await api.post(`/inventory/items/${item.id}/adjust`, body);
      toast(`Stock updated for ${item.name}`, "success");
      onSaved();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const unit = UNIT_LABELS[item.unit];
  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!saving}
      title={`Adjust stock · ${item.name}`}
      description={`Current stock: ${qtyWithUnit(item.quantity, item.unit)}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            Save adjustment
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
        <Segmented
          className="w-full"
          value={mode}
          onChange={setMode}
          options={[
            { value: "add", label: "Add" },
            { value: "remove", label: "Remove" },
            { value: "set", label: "Set to" },
          ]}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label={mode === "set" ? `New quantity (${unit})` : `Quantity to ${mode} (${unit})`}
            aria-label="Adjustment quantity"
            inputMode="decimal"
            value={qty}
            onChange={(e) => setQty(qtyChars(e.target.value))}
            hint={after != null ? `Stock after: ${qtyWithUnit(after, item.unit)}` : undefined}
            data-autofocus
          />
          {adding && (
            <Input
              label={`Unit cost per ${unit} (optional)`}
              aria-label="Unit cost"
              inputMode="decimal"
              prefix="₹"
              value={cost}
              onChange={(e) => setCost(qtyChars(e.target.value))}
              hint="Updates the weighted-average cost"
            />
          )}
        </div>
        <Input label="Reason" aria-label="Adjustment reason" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Recount, spillage, opening balance" />
        <Toggle checked={opening} onChange={setOpening} label="Post as opening stock" description="Records an OPENING entry instead of an adjustment" />
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
