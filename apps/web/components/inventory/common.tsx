"use client";

import { useMemo } from "react";
import clsx from "clsx";
import { api } from "@/lib/api";
import type { AuditStatus, PurchaseStatus, StockItem, StockItemList, StockUnit, TransferStatus } from "@/lib/types-inventory";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { Badge } from "@/components/ui/Badge";
import { Select } from "@/components/ui/Input";
import { UNIT_LABELS, compatibleUnits } from "./units";

/** Active stock items at the active outlet (for pickers). */
export function useStockItems(enabled = true) {
  const { outletId } = useSession();
  return useApiQuery<StockItemList>(enabled && outletId ? `inv-items-all:${outletId}` : null, () => api.get<StockItemList>("/inventory/items"));
}

export function Stat({ label, value, note, tone }: { label: string; value: React.ReactNode; note?: React.ReactNode; tone?: "danger" | "warning" | "success" }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</p>
      <p
        className={clsx(
          "tabular mt-1 text-xl font-extrabold",
          tone === "danger" && "text-red-600 dark:text-red-400",
          tone === "warning" && "text-amber-700 dark:text-amber-300",
          tone === "success" && "text-secondary dark:text-green-300",
        )}
      >
        {value}
      </p>
      {note && <p className="mt-0.5 text-xs text-muted">{note}</p>}
    </div>
  );
}

const PURCHASE_TONES = { DRAFT: "warning", RECEIVED: "success", CANCELLED: "neutral" } as const;
export function PurchaseStatusBadge({ status }: { status: PurchaseStatus }) {
  return <Badge tone={PURCHASE_TONES[status]}>{status === "DRAFT" ? "Draft" : status === "RECEIVED" ? "Received" : "Cancelled"}</Badge>;
}

const AUDIT_TONES = { IN_PROGRESS: "primary", COMPLETED: "success", CANCELLED: "neutral" } as const;
export function AuditStatusBadge({ status }: { status: AuditStatus }) {
  return <Badge tone={AUDIT_TONES[status]}>{status === "IN_PROGRESS" ? "In progress" : status === "COMPLETED" ? "Completed" : "Cancelled"}</Badge>;
}

const TRANSFER_TONES = { REQUESTED: "warning", APPROVED: "info", DISPATCHED: "primary", RECEIVED: "success", REJECTED: "danger", CANCELLED: "neutral" } as const;
export function TransferStatusBadge({ status }: { status: TransferStatus }) {
  return <Badge tone={TRANSFER_TONES[status]}>{status.charAt(0) + status.slice(1).toLowerCase()}</Badge>;
}

/** Native select of stock items grouped by category (fast on tablets, keyboard-searchable). */
export function ItemSelect({
  items,
  value,
  onChange,
  label,
  exclude,
  className,
  "aria-label": ariaLabel,
}: {
  items: StockItem[];
  value: string;
  onChange: (id: string) => void;
  label?: string;
  /** Ids already used on other lines */
  exclude?: Set<string>;
  className?: string;
  "aria-label"?: string;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, StockItem[]>();
    for (const i of items) map.set(i.category, [...(map.get(i.category) ?? []), i]);
    return [...map];
  }, [items]);
  return (
    <Select label={label} aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)} className={className}>
      <option value="">Select item…</option>
      {groups.map(([cat, list]) => (
        <optgroup key={cat} label={cat}>
          {list.map((i) => (
            <option key={i.id} value={i.id} disabled={i.id !== value && exclude?.has(i.id)}>
              {i.name} ({UNIT_LABELS[i.unit]})
            </option>
          ))}
        </optgroup>
      ))}
    </Select>
  );
}

export function UnitSelect({
  baseUnit,
  value,
  onChange,
  className,
  "aria-label": ariaLabel = "Unit",
}: {
  baseUnit: StockUnit | undefined;
  value: StockUnit | undefined;
  onChange: (u: StockUnit) => void;
  className?: string;
  "aria-label"?: string;
}) {
  const units = baseUnit ? compatibleUnits(baseUnit) : [];
  return (
    <Select aria-label={ariaLabel} value={value ?? ""} disabled={units.length <= 1} onChange={(e) => onChange(e.target.value as StockUnit)} className={className}>
      {units.length === 0 && <option value="">—</option>}
      {units.map((u) => (
        <option key={u} value={u}>
          {UNIT_LABELS[u]}
        </option>
      ))}
    </Select>
  );
}

let lineSeq = 0;
/** Stable React key for editable line rows. */
export const lineKey = () => `l${++lineSeq}`;
