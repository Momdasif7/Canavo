/** Delivery assignment after a charge (pure; shared with the verification script). */
import type { Order } from "../lib/types";

/** Assigned partner's name, or null while the order waits for one. */
export const assignedPartner = (order: Pick<Order, "delivery"> | null | undefined): string | null => order?.delivery?.agent?.name ?? null;

/** Headline shown after charging a delivery order. */
export const assignmentLabel = (order: Pick<Order, "delivery"> | null | undefined): string | null => {
  if (!order?.delivery || order.delivery.status === "CANCELLED") return null;
  const p = assignedPartner(order);
  return p ? `Assigned to ${p}` : "Waiting for a partner";
};
