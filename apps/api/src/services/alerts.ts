import { formatINR } from "@canavo/shared";
import { prisma } from "../db";
import { notify, outletManagers, outletStaff } from "./notify";

/**
 * Operational alerts (in-app bell + push + live socket). Each helper decides
 * who needs to know; all are best-effort and never throw into the caller.
 */
const safe = (name: string, fn: () => Promise<void>) => fn().catch((e) => console.error(`[alerts] ${name} failed`, e));

type KotLike = { kotNumber: number; station: string; items: unknown };
const itemsText = (items: unknown) =>
  ((items as { name: string; quantity: number }[] | null) ?? [])
    .slice(0, 4)
    .map((i) => `${i.quantity}× ${i.name}`)
    .join(", ");

/** Kitchen staff: new tickets to cook (bill, running-tab round, released pre-order). */
export function alertKitchenNewKots(outletId: string, kots: KotLike[], where: string) {
  return safe("kot.new", async () => {
    if (!kots.length) return;
    const kitchen = await outletStaff(outletId, ["KITCHEN"]);
    const numbers = kots.map((k) => `#${k.kotNumber}`).join(", ");
    await notify(kitchen, `New order · KOT ${numbers}`, `${where} · ${kots.map((k) => itemsText(k.items)).join(" | ")}`, "kot.new", { outletId });
  });
}

/** Food is ready: the waiter / cashiers (dine-in, takeaway) or the delivery partner (pickup). */
export function alertOrderReady(outletId: string, kotId: string) {
  return safe("order.ready", async () => {
    const kot = await prisma.kotTicket.findUnique({
      where: { id: kotId },
      include: {
        session: { select: { waiterId: true, table: { select: { label: true } } } },
        order: { select: { invoiceNumber: true, cashierId: true, orderType: true, tableLabel: true, delivery: { select: { agentId: true, customerName: true } } } },
      },
    });
    if (!kot) return;
    const what = itemsText(kot.items);
    if (kot.session) {
      const cashiers = await outletStaff(outletId, ["CASHIER"]);
      const to = [...(kot.session.waiterId ? [kot.session.waiterId] : []), ...cashiers];
      await notify(to, `Ready to serve · Table ${kot.session.table.label}`, `KOT #${kot.kotNumber}: ${what}`, "order.ready", { outletId, link: "/tables" });
      return;
    }
    if (!kot.order) return;
    if (kot.order.orderType === "DELIVERY" && kot.order.delivery?.agentId) {
      await notify([kot.order.delivery.agentId], "Order ready for pickup", `${kot.order.invoiceNumber} · ${kot.order.delivery.customerName} · KOT #${kot.kotNumber}`, "delivery.ready", { outletId, link: "/delivery" });
    }
    const cashiers = await outletStaff(outletId, ["CASHIER"]);
    const label = kot.order.tableLabel ? `Table ${kot.order.tableLabel}` : kot.order.orderType === "DELIVERY" ? "Delivery" : "Takeaway";
    await notify([kot.order.cashierId, ...cashiers], `Order ready · ${label}`, `${kot.order.invoiceNumber} · KOT #${kot.kotNumber}: ${what}`, "order.ready", { outletId, link: "/pos" });
  });
}

/** A bill was cancelled: kitchen stops cooking; managers hear about cancellations by others. */
export function alertOrderCancelled(outletId: string, orderId: string, actor: { id: string; name: string; role: string }, reason: string) {
  return safe("order.cancelled", async () => {
    const order = await prisma.order.findUnique({ where: { id: orderId }, select: { invoiceNumber: true, grandTotal: true, kots: { select: { status: true } } } });
    if (!order) return;
    if (order.kots.some((k) => k.status !== "SERVED")) {
      await notify(await outletStaff(outletId, ["KITCHEN"]), "Order cancelled — stop preparing", `${order.invoiceNumber} was cancelled`, "kot.cancelled", { outletId, link: "/kitchen" });
    }
    if (actor.role !== "OUTLET_MANAGER" && actor.role !== "BUSINESS_OWNER") {
      const managers = (await outletManagers(outletId)).filter((id) => id !== actor.id);
      await notify(managers, "Bill cancelled", `${order.invoiceNumber} (${formatINR(order.grandTotal)}) by ${actor.name}: ${reason}`, "order.cancelled", { outletId });
    }
  });
}

/** UPI paid via the gateway: tell the cashier who raised the bill. */
export function alertPaymentReceived(outletId: string, orderId: string, amount: number) {
  return safe("payment.received", async () => {
    const order = await prisma.order.findUnique({ where: { id: orderId }, select: { invoiceNumber: true, cashierId: true } });
    if (!order) return;
    await notify([order.cashierId], "UPI payment received", `${formatINR(amount)} for ${order.invoiceNumber}`, "payment.received", { outletId });
  });
}

/** A table needs attention: its waiter, cashiers and managers. */
export function alertTableAttention(outletId: string, tableId: string, actorId: string) {
  return safe("table.attention", async () => {
    const table = await prisma.diningTable.findUnique({ where: { id: tableId }, select: { label: true, waiterId: true } });
    if (!table) return;
    const to = [...(table.waiterId ? [table.waiterId] : []), ...(await outletStaff(outletId, ["CASHIER"])), ...(await outletManagers(outletId))].filter((id) => id !== actorId);
    await notify(to, `Table ${table.label} needs attention`, "A guest is waiting for service", "table.attention", { outletId });
  });
}

/** An employee's attendance was added / corrected by a manager. */
export function alertAttendanceMarked(userId: string, date: string, status: string, byName: string, outletId: string) {
  return safe("attendance.marked", async () => {
    const label = { PRESENT: "Present", HALF_DAY: "Half day", ABSENT: "Absent", LEAVE: "Leave" }[status] ?? status;
    await notify([userId], "Attendance updated", `${date}: marked ${label} by ${byName}`, "attendance.marked", { outletId });
  });
}

/** A delivery partner is holding a lot of cash — remind managers to collect it (once a day per partner). */
export function alertPartnerCash(outletId: string, agentId: string, balance: number) {
  return safe("delivery.cash", async () => {
    const limitRow = await prisma.setting.findUnique({ where: { scope_key: { scope: outletId, key: "delivery.cashAlertLimit" } } });
    const limit = typeof limitRow?.value === "number" ? limitRow.value : 200_000; // ₹2,000
    if (balance < limit) return;
    const today = new Date().toISOString().slice(0, 10);
    const key = { scope: outletId, key: `delivery.cashAlert.${agentId}` };
    const sent = await prisma.setting.findUnique({ where: { scope_key: key } });
    if (sent?.value === today) return;
    await prisma.setting.upsert({ where: { scope_key: key }, create: { ...key, value: today }, update: { value: today } });
    const agent = await prisma.user.findUnique({ where: { id: agentId }, select: { name: true } });
    await notify(await outletManagers(outletId), "Collect cash from delivery partner", `${agent?.name ?? "A partner"} is holding ${formatINR(balance)}`, "delivery.cash", { outletId, link: "/delivery/partners" });
  });
}

/** The platform changed which features the business has. */
export function alertModulesChanged(businessId: string, labels: string[]) {
  return safe("platform.modules", async () => {
    const owners = await prisma.user.findMany({ where: { businessId, role: "BUSINESS_OWNER", status: "ACTIVE" }, select: { id: true } });
    await notify(owners.map((o) => o.id), "Your CANAVO features were updated", `Enabled: ${labels.join(", ")}`, "platform.modules");
  });
}
