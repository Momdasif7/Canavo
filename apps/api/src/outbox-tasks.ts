/**
 * Handlers for outbox tasks (see lib/outbox.ts). Imported once by the app so the
 * publisher can run them. Handlers must be idempotent: delivery is at-least-once.
 */
import { registerOutboxTask } from "./lib/outbox";
import { prisma } from "./db";
import { alertKitchenNewKots } from "./services/alerts";
import { checkLowStockAfterOrder } from "./services/inventory";
import { deliverExternal } from "./services/notify";
import { notifyNoPartner } from "./services/delivery-assign";
import { announceDelivery } from "./services/service-context";
import { notifyAvailability } from "./services/stock-availability";

registerOutboxTask<{ outletId: string; kotIds: string[]; label: string }>("kitchen.alert", async ({ outletId, kotIds, label }) => {
  const kots = await prisma.kotTicket.findMany({ where: { id: { in: kotIds }, outletId } });
  await alertKitchenNewKots(outletId, kots, label);
});

registerOutboxTask<{ outletId: string; orderId: string }>("inventory.lowStockAfterOrder", ({ outletId, orderId }) => checkLowStockAfterOrder(outletId, orderId));

registerOutboxTask<{ deliveryId: string }>("delivery.announce", ({ deliveryId }) => announceDelivery(deliveryId));

registerOutboxTask<{ outletId: string; invoiceNumber: string }>("delivery.noPartner", ({ outletId, invoiceNumber }) => notifyNoPartner(outletId, invoiceNumber));

registerOutboxTask("menu.availabilityNotify", notifyAvailability);

registerOutboxTask<{ userIds: string[]; title: string; body: string; kind: string; link: string | null; outletId: string | null; idByUser: Record<string, Record<string, unknown>> }>(
  "notify.external",
  ({ userIds, title, body, kind, link, outletId, idByUser }) => deliverExternal(userIds, title, body, kind, link, outletId, idByUser),
);
