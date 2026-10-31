"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus, Trash } from "@phosphor-icons/react";
import { formatINR, stockTransferCreateSchema, type StockTransferCreateInput } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import type { TransferDetail } from "@/lib/types-inventory";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { Dialog } from "@/components/ui/Dialog";
import { Button, IconButton } from "@/components/ui/Button";
import { Input, Select, Textarea } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { Alert, EmptyState, LoadingState } from "@/components/ui/States";
import { ItemSelect, lineKey, useStockItems } from "./common";
import { UNIT_LABELS, parseQty, qtyChars, qtyWithUnit } from "./units";

type Direction = "send" | "request";
interface Line {
  key: string;
  itemId: string;
  qty: string;
}
const blank = (): Line => ({ key: lineKey(), itemId: "", qty: "" });

export function TransferFormDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: (t: TransferDetail) => void }) {
  const { me, outletId } = useSession();
  const toast = useToast();
  const stock = useStockItems(open);
  const items = useMemo(() => stock.data?.items ?? [], [stock.data]);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const others = (me?.outlets ?? []).filter((o) => o.id !== outletId);
  const activeName = me?.outlets.find((o) => o.id === outletId)?.name ?? "this outlet";

  const [direction, setDirection] = useState<Direction>("send");
  const [other, setOther] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([blank()]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDirection("send");
    setOther(others.length === 1 ? others[0].id : "");
    setNotes("");
    setLines([blank()]);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const update = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const used = new Set(lines.map((l) => l.itemId).filter(Boolean));
  const value = lines.reduce((s, l) => s + Math.round((parseQty(l.qty) ?? 0) * (byId.get(l.itemId)?.costPerUnit ?? 0)), 0);

  const save = async () => {
    setError(null);
    if (!other) return setError("Choose the other outlet");
    const filled = lines.filter((l) => l.itemId || l.qty);
    if (!filled.length) return setError("Add at least one item");
    for (const [idx, l] of filled.entries()) {
      if (!l.itemId) return setError(`Line ${idx + 1}: choose an item`);
      const q = parseQty(l.qty);
      if (q == null || q <= 0) return setError(`Line ${idx + 1}: enter a quantity`);
    }
    const parsed = stockTransferCreateSchema.safeParse({
      ...(direction === "send" ? { toOutletId: other } : { fromOutletId: other }),
      notes: notes.trim() || null,
      items: filled.map((l) => ({ inventoryItemId: l.itemId, quantity: parseQty(l.qty)! })),
    });
    if (!parsed.success) return setError(parsed.error.issues[0].message);
    const body: StockTransferCreateInput = parsed.data;
    setSaving(true);
    try {
      const t = await api.post<TransferDetail>("/inventory/transfers", body);
      toast(t.status === "APPROVED" ? "Transfer created and approved — dispatch when ready" : "Transfer requested", "success");
      onSaved(t);
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
      title="New stock transfer"
      footer={
        others.length > 0 && (
          <>
            <span className="mr-auto self-center text-sm text-muted">
              Value approx. <strong className="tabular text-fg">{formatINR(value)}</strong>
            </span>
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={save} loading={saving}>
              {direction === "send" ? "Create transfer" : "Send request"}
            </Button>
          </>
        )
      }
    >
      {others.length === 0 ? (
        <EmptyState title="Only one outlet" description="Transfers move stock between outlets. You have access to just this outlet, so there's nowhere to transfer to." />
      ) : stock.loading && !stock.data ? (
        <LoadingState />
      ) : (
        <div className="space-y-4">
          {error && <Alert>{error}</Alert>}
          {stock.error && <Alert>{stock.error}</Alert>}
          <Segmented
            className="w-full"
            value={direction}
            onChange={setDirection}
            options={[
              { value: "send", label: "Send to outlet" },
              { value: "request", label: "Request from outlet" },
            ]}
          />
          <Select
            label={direction === "send" ? `Send from ${activeName} to` : `Request into ${activeName} from`}
            aria-label="Other outlet"
            value={other}
            onChange={(e) => setOther(e.target.value)}
          >
            <option value="">Select outlet…</option>
            {others.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </Select>
          <div className="space-y-2">
            {lines.map((l, idx) => {
              const item = byId.get(l.itemId);
              return (
                <div key={l.key} className="grid grid-cols-12 items-start gap-2 rounded-xl border border-line p-3">
                  <div className="col-span-12 md:col-span-7">
                    <ItemSelect aria-label={`Transfer item ${idx + 1}`} items={items} value={l.itemId} exclude={used} onChange={(id) => update(l.key, { itemId: id })} />
                    {item && direction === "send" && <p className="mt-1 text-xs text-muted">Available here: {qtyWithUnit(item.quantity, item.unit)}</p>}
                  </div>
                  <Input
                    aria-label={`Transfer quantity ${idx + 1}`}
                    placeholder={item ? `Qty (${UNIT_LABELS[item.unit]})` : "Qty"}
                    inputMode="decimal"
                    value={l.qty}
                    onChange={(e) => update(l.key, { qty: qtyChars(e.target.value) })}
                    wrapperClassName="col-span-8 md:col-span-4"
                  />
                  <div className="col-span-4 flex justify-end md:col-span-1">
                    <IconButton label={`Remove line ${idx + 1}`} disabled={lines.length === 1} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                      <Trash size={20} />
                    </IconButton>
                  </div>
                </div>
              );
            })}
            <Button variant="outline" icon={<Plus size={18} />} onClick={() => setLines((ls) => [...ls, blank()])} disabled={lines.length >= 200}>
              Add line
            </Button>
          </div>
          <Textarea label="Notes" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
      )}
    </Dialog>
  );
}
