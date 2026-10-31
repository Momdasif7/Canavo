"use client";

import { HandCoins } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import type { Order } from "@/lib/types";
import { Badge } from "@/components/ui/Badge";
import { orderBalance } from "@/components/pos/PaymentDialog";

/** Who collects a COD bill at the door. */
export const codPartnerName = (order: Pick<Order, "delivery">) => order.delivery?.agent?.name ?? "the delivery partner";

/** COD still to be collected at the door. */
export const isCodPending = (order: Order) => order.status === "OPEN" && !!order.delivery?.cod;

/** One-line COD state: to collect → collected → cash handed over. Null when the bill isn't COD. */
export function codLabel(order: Order): { text: string; tone: "warning" | "success" | "info" | "neutral" } | null {
  const d = order.delivery;
  if (!d?.cod) return null;
  const agent = d.agent?.name;
  if (order.status === "OPEN") return { text: `COD · to collect ${formatINR(orderBalance(order))}${agent ? ` · ${agent}` : ""}`, tone: "warning" };
  if (order.status === "PAID") {
    const by = agent ? `collected by ${agent}` : "collected";
    return d.cashSettledAt ? { text: `COD · ${by} · cash handed over`, tone: "success" } : { text: `COD · ${by}`, tone: "info" };
  }
  return { text: "COD", tone: "neutral" };
}

export function CodBadge({ order, className }: { order: Order; className?: string }) {
  const l = codLabel(order);
  if (!l) return null;
  return (
    <Badge tone={l.tone} className={className}>
      <HandCoins size={14} weight="fill" aria-hidden />
      <span data-testid="cod-badge">{l.text}</span>
    </Badge>
  );
}
