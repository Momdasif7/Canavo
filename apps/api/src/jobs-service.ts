// Background jobs for the service module: pre-order KOT release, reservation
// no-shows and RESERVED table marking.
import { prisma } from "./db";
import { registerJob } from "./jobs";
import { notify, outletManagers, outletStaff } from "./services/notify";
import { assignWaitingDeliveries } from "./services/delivery-assign";
import { runForOutlet } from "./lib/tenant";
import { emitToOutlet } from "./realtime";
import { alertKitchenNewKots } from "./services/alerts";

const CURSOR_KEY = "service.kotReleaseCursor";
const NO_SHOW_AFTER_MIN = 30;
const RESERVE_BEFORE_MIN = 30;

/**
 * Emit `kot:new` for pre-order KOTs whose releaseAt passed since the last run.
 * The cursor (last processed instant) is persisted in a GLOBAL Setting so each
 * KOT is announced exactly once, even across restarts. KOTs are only created
 * with a releaseAt in the future (billing fires immediately otherwise), so
 * `cursor < releaseAt <= now` never overlaps the billing-time emit.
 */
export async function releaseDueKots(now = new Date()) {
  const setting = await prisma.setting.findUnique({ where: { scope_key: { scope: "GLOBAL", key: CURSOR_KEY } } });
  const cursor = typeof setting?.value === "string" ? new Date(setting.value) : new Date(now.getTime() - 60_000);
  const due = await prisma.kotTicket.findMany({
    where: { releaseAt: { gt: cursor, lte: now }, OR: [{ orderId: null }, { order: { status: { not: "CANCELLED" } } }] },
    include: {
      order: { select: { id: true, invoiceNumber: true, orderType: true, tableLabel: true, notes: true, status: true, scheduledFor: true, customerName: true } },
    },
    orderBy: { releaseAt: "asc" },
  });
  const byOutlet = new Map<string, typeof due>();
  for (const k of due) byOutlet.set(k.outletId, [...(byOutlet.get(k.outletId) ?? []), k]);
  for (const [outletId, kots] of byOutlet) {
    emitToOutlet(outletId, "kot:new", kots.map((k) => ({ ...k, session: null })));
    void alertKitchenNewKots(outletId, kots, "Pre-order released");
    console.info(`[job:kot-release] released ${kots.length} pre-order KOT(s) for outlet ${outletId}`);
  }
  await prisma.setting.upsert({
    where: { scope_key: { scope: "GLOBAL", key: CURSOR_KEY } },
    create: { scope: "GLOBAL", key: CURSOR_KEY, value: now.toISOString() },
    update: { value: now.toISOString() },
  });
  return due.length;
}

/** BOOKED reservations 30 min past their time become NO_SHOW (table freed). */
export async function markNoShows(now = new Date()) {
  const stale = await prisma.reservation.findMany({
    where: { status: "BOOKED", reservedFor: { lt: new Date(now.getTime() - NO_SHOW_AFTER_MIN * 60_000) } },
  });
  for (const r of stale) {
    await prisma.reservation.update({ where: { id: r.id }, data: { status: "NO_SHOW" } });
    await prisma.auditLog.create({ data: { outletId: r.outletId, action: "reservation.auto_no_show", entity: "Reservation", entityId: r.id } });
    if (r.tableId) {
      const t = await prisma.diningTable.findUnique({ where: { id: r.tableId } });
      const busy = await prisma.tableSession.count({ where: { status: "OPEN", OR: [{ tableId: r.tableId }, { mergedTableIds: { has: r.tableId } }] } });
      const soon = await prisma.reservation.count({
        where: { tableId: r.tableId, status: "BOOKED", reservedFor: { lte: new Date(now.getTime() + RESERVE_BEFORE_MIN * 60_000) } },
      });
      if (t?.status === "RESERVED" && !busy && !soon) {
        await prisma.diningTable.update({ where: { id: t.id }, data: { status: "AVAILABLE" } });
        emitToOutlet(r.outletId, "table:updated", { tableIds: [t.id], action: "status" });
      }
    }
    emitToOutlet(r.outletId, "reservation:updated", { ...r, status: "NO_SHOW" });
    void notify(await outletManagers(r.outletId), "Reservation no-show", `${r.customerName} (${r.partySize} guests) didn't arrive — table freed`, "reservation.noshow", { outletId: r.outletId });
  }
  return stale.length;
}

/** Mark free tables RESERVED from 30 min before a booking. */
export async function markReservedTables(now = new Date()) {
  const upcoming = await prisma.reservation.findMany({
    where: {
      status: "BOOKED",
      tableId: { not: null },
      reservedFor: { lte: new Date(now.getTime() + RESERVE_BEFORE_MIN * 60_000), gte: new Date(now.getTime() - NO_SHOW_AFTER_MIN * 60_000) },
    },
    include: { table: true },
  });
  let n = 0;
  for (const r of upcoming) {
    if (!r.table || r.table.status !== "AVAILABLE") continue;
    const busy = await prisma.tableSession.count({ where: { status: "OPEN", OR: [{ tableId: r.table.id }, { mergedTableIds: { has: r.table.id } }] } });
    if (busy) continue;
    await prisma.diningTable.update({ where: { id: r.table.id }, data: { status: "RESERVED" } });
    emitToOutlet(r.outletId, "table:updated", { tableIds: [r.table.id], action: "reserved" });
    const time = r.reservedFor.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
    void notify(
      [...(await outletStaff(r.outletId, ["CASHIER"])), ...(await outletManagers(r.outletId))],
      `Reservation at ${time} · Table ${r.table.label}`,
      `${r.customerName}, ${r.partySize} guests${r.preOrderItems && Array.isArray(r.preOrderItems) && r.preOrderItems.length ? " · has a pre-order" : ""}`,
      "reservation.upcoming",
      { outletId: r.outletId },
    );
    n++;
  }
  return n;
}

export function registerJobs(): void {
  // Safety net: deliveries still waiting for a partner get one as soon as someone is on duty.
  registerJob("delivery-auto-assign", 60_000, async () => {
    const outlets = await prisma.delivery.findMany({
      where: { agentId: null, status: { in: ["PENDING", "ACCEPTED", "PREPARING"] } },
      select: { outletId: true },
      distinct: ["outletId"],
    });
    for (const { outletId } of outlets) {
      await runForOutlet(outletId, () => assignWaitingDeliveries(outletId));
    }
  });
  registerJob("service-kot-release", 30_000, async () => {
    await releaseDueKots();
  });
  registerJob("service-reservations", 30_000, async () => {
    await markReservedTables();
    await markNoShows();
  });
}
