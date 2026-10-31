"use client";

import { useState } from "react";
import { CaretDown, CaretUp, WarningCircle } from "@phosphor-icons/react";
import type { LowStockAlerts } from "@/lib/types-inventory";
import { Badge } from "@/components/ui/Badge";
import { qtyWithUnit } from "./units";

/** Collapsible low-stock summary from GET /inventory/alerts. Renders nothing when all is well. */
export function LowStockBanner({ alerts, onOpenItem }: { alerts: LowStockAlerts | undefined; onOpenItem: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  if (!alerts || alerts.count === 0) return null;
  return (
    <div className="mb-4 rounded-2xl border border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100" role="status">
      <button
        type="button"
        aria-expanded={open}
        aria-label="Toggle low stock list"
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-tap w-full items-center gap-3 px-4 py-3 text-left"
      >
        <WarningCircle size={24} weight="fill" className="shrink-0 text-amber-600 dark:text-amber-300" />
        <span className="flex-1 text-sm font-semibold">
          {alerts.count} item{alerts.count === 1 ? "" : "s"} at or below reorder level
          {alerts.outOfStock > 0 && <span className="text-red-700 dark:text-red-300"> · {alerts.outOfStock} out of stock</span>}
        </span>
        <span className="text-sm font-semibold">{open ? "Hide" : "Show"}</span>
        {open ? <CaretUp size={18} /> : <CaretDown size={18} />}
      </button>
      {open && (
        <ul className="divide-y divide-amber-200 border-t border-amber-200 dark:divide-amber-500/20 dark:border-amber-500/20">
          {alerts.items.map((i) => (
            <li key={i.id}>
              <button type="button" onClick={() => onOpenItem(i.id)} className="flex min-h-tap w-full flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-left text-sm hover:bg-amber-100/60 dark:hover:bg-amber-500/10">
                <span className="flex-1 font-semibold">{i.name}</span>
                {i.outOfStock ? <Badge tone="danger">Out of stock</Badge> : <Badge tone="warning">Low</Badge>}
                <span className="tabular">
                  {qtyWithUnit(i.quantity, i.unit)} <span className="opacity-70">/ reorder at {qtyWithUnit(i.reorderLevel, i.unit)}</span>
                </span>
                <span className="tabular font-semibold">Order {qtyWithUnit(i.suggestedOrderQty, i.unit)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
