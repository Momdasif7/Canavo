"use client";

import { ArrowsDownUp, PencilSimple, Prohibit, Trash } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { StockItemDetail } from "@/lib/types-inventory";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { Sheet } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Table, THead, Th, Td, Tr } from "@/components/ui/Table";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { Stat } from "./common";
import { TXN_LABELS, TXN_TONES, UNIT_LABELS, formatQty, qtyWithUnit } from "./units";

export function ItemDetailSheet({
  itemId,
  version,
  onClose,
  onEdit,
  onAdjust,
  onWastage,
  onDeactivate,
}: {
  itemId: string | null;
  /** Bump to force a reload after changes */
  version: number;
  onClose: () => void;
  onEdit: (item: StockItemDetail) => void;
  onAdjust: (item: StockItemDetail) => void;
  onWastage: (item: StockItemDetail) => void;
  onDeactivate: (item: StockItemDetail) => void;
}) {
  const { me, outletId, can } = useSession();
  const manage = can("inventory:manage");
  const q = useApiQuery<StockItemDetail>(itemId ? `inv-item:${outletId}:${itemId}:${version}` : null, () => api.get<StockItemDetail>(`/inventory/items/${itemId}`));
  const d = q.data && q.data.id === itemId ? q.data : undefined;
  const outletName = new Map((me?.outlets ?? []).map((o) => [o.id, o.name]));

  return (
    <Sheet
      open={!!itemId}
      onClose={onClose}
      width="max-w-3xl"
      title={d ? d.name : "Item"}
      footer={
        d &&
        manage &&
        d.active && (
          <>
            <Button variant="ghost" icon={<Prohibit size={18} />} onClick={() => onDeactivate(d)} className="mr-auto text-red-600 dark:text-red-400">
              Deactivate
            </Button>
            <Button variant="outline" icon={<PencilSimple size={18} />} onClick={() => onEdit(d)}>
              Edit item
            </Button>
            <Button variant="outline" icon={<Trash size={18} />} onClick={() => onWastage(d)}>
              Wastage
            </Button>
            <Button icon={<ArrowsDownUp size={18} />} onClick={() => onAdjust(d)}>
              Adjust stock
            </Button>
          </>
        )
      }
    >
      {q.loading && !d ? (
        <LoadingState />
      ) : q.error ? (
        <ErrorState message={q.error} onRetry={q.reload} />
      ) : d ? (
        <div className="space-y-6">
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
            <Badge>{d.category}</Badge>
            {d.sku && <span>SKU {d.sku}</span>}
            {d.barcode && <span className="font-mono">· {d.barcode}</span>}
            {!d.active && <Badge tone="neutral">Inactive</Badge>}
            {d.lowStock && <Badge tone={d.quantity <= 0 ? "danger" : "warning"}>{d.quantity <= 0 ? "Out of stock" : "Low stock"}</Badge>}
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="In stock" value={qtyWithUnit(d.quantity, d.unit)} tone={d.lowStock ? (d.quantity <= 0 ? "danger" : "warning") : undefined} />
            <Stat label={`Cost / ${UNIT_LABELS[d.unit]}`} value={formatINR(d.costPerUnit)} note="Weighted average" />
            <Stat label="Value" value={formatINR(d.value)} />
            <Stat label="Reorder at" value={d.reorderLevel ? qtyWithUnit(d.reorderLevel, d.unit) : "—"} note={d.reorderQty ? `Order ${qtyWithUnit(d.reorderQty, d.unit)}` : undefined} />
          </div>

          {d.outletStocks.length > 1 && (
            <section>
              <h3 className="mb-2 text-sm font-bold">Stock by outlet</h3>
              <div className="flex flex-wrap gap-2">
                {d.outletStocks.map((s) => (
                  <div key={s.outletId} className="rounded-xl border border-line px-3 py-2 text-sm">
                    <span className="text-muted">{outletName.get(s.outletId) ?? "Other outlet"}</span>
                    <span className="tabular ml-2 font-semibold">{qtyWithUnit(s.quantity, d.unit)}</span>
                    {s.outletId === outletId && <span className="ml-1 text-xs text-primary-700 dark:text-primary-200">(this outlet)</span>}
                  </div>
                ))}
              </div>
            </section>
          )}

          <section>
            <h3 className="mb-2 text-sm font-bold">Used in recipes</h3>
            {d.usedIn.length === 0 ? (
              <p className="text-sm text-muted">Not used in any recipe yet.</p>
            ) : (
              <ul className="divide-y divide-line rounded-xl border border-line">
                {d.usedIn.map((r) => (
                  <li key={`${r.menuItemId}:${r.variantId ?? ""}`} className="flex items-center justify-between px-3 py-2 text-sm">
                    <span>
                      {r.menuItemName}
                      {r.variantName && <span className="text-muted"> · {r.variantName}</span>}
                    </span>
                    <span className="tabular font-semibold">{qtyWithUnit(r.quantity, d.unit)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3 className="mb-2 text-sm font-bold">Recent movements (this outlet)</h3>
            {d.transactions.length === 0 ? (
              <EmptyState title="No stock movements yet" />
            ) : (
              <div className="rounded-xl border border-line">
                <Table>
                  <THead>
                    <tr>
                      <Th>When</Th>
                      <Th>Type</Th>
                      <Th className="text-right">Qty</Th>
                      <Th className="text-right">Balance</Th>
                      <Th>Note</Th>
                    </tr>
                  </THead>
                  <tbody>
                    {d.transactions.map((t) => (
                      <Tr key={t.id}>
                        <Td className="whitespace-nowrap text-muted">{formatDateTime(t.createdAt)}</Td>
                        <Td>
                          <Badge tone={TXN_TONES[t.type]}>{TXN_LABELS[t.type]}</Badge>
                        </Td>
                        <Td className={`tabular whitespace-nowrap text-right font-semibold ${t.quantity < 0 ? "text-red-600 dark:text-red-400" : "text-secondary dark:text-green-300"}`}>
                          {t.quantity > 0 ? "+" : ""}
                          {formatQty(t.quantity)}
                        </Td>
                        <Td className="tabular text-right">{formatQty(t.balanceAfter)}</Td>
                        <Td className="max-w-[220px] truncate text-muted" title={t.note ?? undefined}>
                          {t.note ?? "—"}
                        </Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            )}
          </section>
        </div>
      ) : null}
    </Sheet>
  );
}
