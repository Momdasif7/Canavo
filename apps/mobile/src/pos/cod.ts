/**
 * Cash on Delivery (COD): request shapes and pure helpers.
 *
 * No React Native imports, so the same specs can be run from a node script
 * against the real API (like `src/delivery/portal.ts`). `src/lib/api.ts`
 * executes them.
 */
import type { OrderCreateInput } from "@canavo/shared";
import type { Order, OrderType } from "../lib/types";
import { inr } from "../lib/format";
import type { RequestSpec } from "../delivery/portal";

export const codRequests = {
  /** POST /orders — with `delivery.cod: true` the order is created as COD. */
  createOrder: (input: OrderCreateInput): RequestSpec<Order> => ({ method: "POST", path: "/orders", body: input }),
  getOrder: (id: string): RequestSpec<Order> => ({ method: "GET", path: `/orders/${id}` }),
  /** Mark an OPEN delivery order COD (`cod: false` undoes it). Needs `payment:collect`. */
  markCod: (orderId: string, cod = true): RequestSpec<Order> => ({
    method: "POST",
    path: `/orders/${orderId}/cod`,
    body: cod ? {} : { cod: false },
  }),
};

/** COD is offered for online DELIVERY orders only (offline delivery bills stay unpaid as before). */
export const codAvailable = (orderType: OrderType, online: boolean) => orderType === "DELIVERY" && online;

/** Is this order already COD? */
export const isCod = (o: Pick<Order, "delivery"> | null | undefined) => !!o?.delivery?.cod;

/** Cash the partner collects at the door: the order's open balance. */
export const codDue = (o: Pick<Order, "balance" | "grandTotal" | "amountPaid">) =>
  o.balance ?? Math.max(0, o.grandTotal - (o.amountPaid ?? 0));

/** First name of the assigned partner, or a generic fallback. */
export const partnerLabel = (name: string | null | undefined) => (name?.trim() ? name.trim().split(/\s+/)[0] : "The delivery partner");

/** "No payment now — Deepak collects ₹450.00 in cash at the door" */
export const codCopy = (partner: string | null | undefined, amount: number | null | undefined) =>
  `No payment now — ${partnerLabel(partner)} collects ${amount != null ? inr(amount) : "the bill amount"} in cash at the door`;
