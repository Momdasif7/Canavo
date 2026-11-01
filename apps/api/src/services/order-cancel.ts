import type { Request } from "express";
import type { Prisma } from "@prisma/client";
import { audit } from "../lib/audit";
import type { OrderWithRelations } from "./billing";
import { creditGiftCard } from "./gift-cards";
import { restoreCanteenForOrder } from "./canteen";
import { onOrderCancelled } from "./promotions";
import { onOrderCancelledService } from "./service-context";
import { restoreStockForOrder } from "./inventory";

/**
 * Void a bill inside the caller's transaction: status, promotions/loyalty, gift cards,
 * canteen wallet/tokens, delivery / table session, stock, audit. Shared by the staff
 * cancel route and channel cancellations (Phase 6.1); approvals and channel pushes
 * stay with the caller.
 */
export async function cancelOrderInTx(tx: Prisma.TransactionClient, req: Request, order: OrderWithRelations, reason: string, meta: Record<string, string> = {}) {
  const u = await tx.order.update({
    where: { id: order.id },
    data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: reason },
  });
  await onOrderCancelled(tx, order.id);
  for (const p of order.payments.filter((x) => x.mode === "GIFT_CARD" && x.giftCardId && x.status === "SUCCESS")) {
    await creditGiftCard(tx, p.giftCardId!, p.amount, { outletId: order.outletId, orderId: order.id, note: `Bill ${order.invoiceNumber} cancelled`, userId: req.user!.id });
  }
  await restoreCanteenForOrder(tx, order.id, { outletId: order.outletId, invoiceNumber: order.invoiceNumber, userId: req.user!.id });
  await onOrderCancelledService(tx, order.id);
  await restoreStockForOrder(tx, order.id);
  await audit(req, "order.cancel", "Order", order.id, { reason, wasPaid: order.status === "PAID", invoiceNumber: order.invoiceNumber, ...meta }, tx);
  return u;
}
