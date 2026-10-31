import type { Prisma } from "@prisma/client";
import { distanceMeters } from "@canavo/shared";
import { prisma } from "../db";
import { emitToOutlet } from "../realtime";
import { notify, outletManagers } from "./notify";

type Db = Prisma.TransactionClient | typeof prisma;

const ACTIVE = ["PENDING", "ACCEPTED", "PREPARING", "OUT_FOR_DELIVERY"] as const;
/** GPS on cheap phones drifts: allow up to 100 m of reported accuracy on top of the outlet radius. */
const MAX_ACCURACY_ALLOWANCE = 100;

/**
 * Delivery partner dispatch rules
 * - A partner can hold at most `Outlet.maxDeliveriesPerPartner` orders (default 2).
 * - While at the outlet they can be given orders up to that limit (batched on one trip).
 * - Picking up an order starts a **run**: no new orders until every picked-up order
 *   is completed and their GPS shows them back within the outlet radius.
 * - Clocking in at the outlet, or a manager's "Mark back at outlet", also counts as back.
 */

/** Auto-assignment is on unless the outlet turns it off (Setting `delivery.autoAssign` = false). */
export async function autoAssignEnabled(outletId: string, db: Db = prisma): Promise<boolean> {
  const s = await db.setting.findUnique({ where: { scope_key: { scope: outletId, key: "delivery.autoAssign" } } });
  return s?.value !== false;
}

export interface PartnerAvailability {
  id: string;
  name: string;
  phone: string;
  onDuty: boolean;
  atOutlet: boolean;
  onRunSince: Date | null;
  /** Orders currently assigned (not delivered / cancelled) */
  active: number;
  /** Of those, already picked up */
  outForDelivery: number;
  max: number;
  available: boolean;
  /** Why not available (for the POS / board) */
  reason: string | null;
  lastAssignedAt: Date | null;
  lastLocation: { lat: number; lng: number; at: Date } | null;
}

/** Availability of every delivery partner of an outlet (or the given ones). */
export async function partnerAvailability(outletId: string, db: Db = prisma, onlyIds?: string[]): Promise<PartnerAvailability[]> {
  const outlet = await db.outlet.findUniqueOrThrow({ where: { id: outletId }, select: { maxDeliveriesPerPartner: true } });
  const max = outlet.maxDeliveriesPerPartner;
  const partners = await db.user.findMany({
    where: { role: "DELIVERY", status: "ACTIVE", outlets: { some: { outletId } }, ...(onlyIds && { id: { in: onlyIds } }) },
    select: { id: true, name: true, phone: true, deliveryAtOutlet: true, deliveryRunStartedAt: true, lastLat: true, lastLng: true, lastLocationAt: true },
    orderBy: { name: "asc" },
  });
  return Promise.all(
    partners.map(async (p) => {
      const [onDuty, deliveries, last] = await Promise.all([
        db.staffAttendance.count({ where: { userId: p.id, outletId, clockOutAt: null, status: { in: ["PRESENT", "HALF_DAY"] } } }),
        db.delivery.findMany({ where: { agentId: p.id, status: { in: [...ACTIVE] } }, select: { status: true } }),
        db.delivery.findFirst({ where: { agentId: p.id, assignedAt: { not: null } }, orderBy: { assignedAt: "desc" }, select: { assignedAt: true } }),
      ]);
      const active = deliveries.length;
      const outForDelivery = deliveries.filter((d) => d.status === "OUT_FOR_DELIVERY").length;
      const onRun = !p.deliveryAtOutlet || outForDelivery > 0;
      let reason: string | null = null;
      if (!onDuty) reason = "Not clocked in";
      else if (onRun) reason = outForDelivery > 0 ? "Out for delivery" : "Returning to the outlet";
      else if (active >= max) reason = `Has ${active} of ${max} orders`;
      return {
        id: p.id,
        name: p.name,
        phone: p.phone,
        onDuty: onDuty > 0,
        atOutlet: !onRun,
        onRunSince: onRun ? p.deliveryRunStartedAt : null,
        active,
        outForDelivery,
        max,
        available: reason === null,
        reason,
        lastAssignedAt: last?.assignedAt ?? null,
        lastLocation: p.lastLat != null && p.lastLng != null && p.lastLocationAt ? { lat: p.lastLat, lng: p.lastLng, at: p.lastLocationAt } : null,
      };
    }),
  );
}

/**
 * The partner who should get the next order: available (on duty, at the outlet,
 * under the limit); prefer whoever already has an order (fills a trip of two),
 * then whoever has waited longest since their last assignment.
 */
export async function pickAvailablePartner(outletId: string, db: Db = prisma): Promise<{ id: string; name: string } | null> {
  const ranked = (await partnerAvailability(outletId, db))
    .filter((p) => p.available)
    .sort((a, b) => b.active - a.active || (a.lastAssignedAt?.getTime() ?? 0) - (b.lastAssignedAt?.getTime() ?? 0));
  return ranked[0] ? { id: ranked[0].id, name: ranked[0].name } : null;
}

/** Can this partner take one more order right now? (manual assignment / POS picker) */
export async function canTakeOrder(outletId: string, agentId: string, db: Db = prisma) {
  const [p] = await partnerAvailability(outletId, db, [agentId]);
  if (!p) return { ok: false, reason: "Delivery partner not found in this outlet", partner: null };
  return { ok: p.available, reason: p.reason, partner: p };
}

/** A partner picked up an order (or completed one straight away): they're out on a run. */
export async function startRun(db: Db, agentId: string) {
  await db.user.updateMany({ where: { id: agentId, deliveryAtOutlet: true }, data: { deliveryAtOutlet: false, deliveryRunStartedAt: new Date() } });
}

/** Partner is back at the outlet: available again; hand them waiting orders. */
export async function markBackAtOutlet(outletId: string, agentId: string, how: "gps" | "clock-in" | "manager") {
  const { count } = await prisma.user.updateMany({ where: { id: agentId, deliveryAtOutlet: false }, data: { deliveryAtOutlet: true, deliveryRunStartedAt: null } });
  if (!count) return false;
  emitToOutlet(outletId, "delivery:updated", { agentId, backAtOutlet: true, how });
  if (how !== "clock-in") await notify([agentId], "You're back at the outlet", "You can take new delivery orders now", "delivery.back", { outletId, link: "/delivery" });
  await assignWaitingDeliveries(outletId);
  return true;
}

/**
 * GPS from the partner app. Saves the fix; if the partner finished every
 * picked-up order and is now within the outlet radius, they're back.
 */
export async function reportPartnerLocation(outletId: string, agentId: string, fix: { lat: number; lng: number; accuracy?: number }) {
  await prisma.user.update({ where: { id: agentId }, data: { lastLat: fix.lat, lastLng: fix.lng, lastLocationAt: new Date() } });
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: outletId }, select: { latitude: true, longitude: true, geofenceMeters: true } });
  const user = await prisma.user.findUniqueOrThrow({ where: { id: agentId }, select: { deliveryAtOutlet: true } });
  const distance =
    outlet.latitude != null && outlet.longitude != null
      ? Math.round(distanceMeters({ latitude: fix.lat, longitude: fix.lng }, { latitude: outlet.latitude, longitude: outlet.longitude }))
      : null;
  const radius = outlet.geofenceMeters + Math.min(fix.accuracy ?? 0, MAX_ACCURACY_ALLOWANCE);
  let back = false;
  if (!user.deliveryAtOutlet && distance !== null && distance <= radius) {
    const stillOut = await prisma.delivery.count({ where: { agentId, status: "OUT_FOR_DELIVERY" } });
    if (!stillOut) back = await markBackAtOutlet(outletId, agentId, "gps");
  }
  emitToOutlet(outletId, "delivery:location", { agentId, lat: fix.lat, lng: fix.lng, at: new Date().toISOString(), distanceToOutlet: distance });
  return { distanceToOutlet: distance, atOutlet: user.deliveryAtOutlet || back, backNow: back };
}

/**
 * Give waiting (unassigned) deliveries to available partners, oldest first.
 * Runs when a partner gets back, clocks in, and periodically.
 */
export async function assignWaitingDeliveries(outletId: string): Promise<number> {
  if (!(await autoAssignEnabled(outletId))) return 0;
  const waiting = await prisma.delivery.findMany({
    where: { outletId, agentId: null, status: { in: ["PENDING", "ACCEPTED", "PREPARING"] }, order: { status: { not: "CANCELLED" } } },
    include: { order: { select: { invoiceNumber: true } } },
    orderBy: { createdAt: "asc" },
  });
  let assigned = 0;
  for (const d of waiting) {
    const partner = await pickAvailablePartner(outletId);
    if (!partner) break;
    // Conditional update: never steal a delivery someone assigned in the meantime.
    const { count } = await prisma.delivery.updateMany({ where: { id: d.id, agentId: null }, data: { agentId: partner.id, assignedAt: new Date() } });
    if (!count) continue;
    assigned++;
    await notify([partner.id], "New delivery assigned", `${d.order.invoiceNumber} · ${d.customerName} · ${d.address}${d.cod ? " · COD" : ""}`, "delivery");
    emitToOutlet(outletId, "delivery:updated", { id: d.id, orderId: d.orderId, agentId: partner.id, agentName: partner.name, autoAssigned: true });
  }
  return assigned;
}

/** Tell the outlet's managers a delivery is waiting (nobody on duty, or everyone full / out). */
export async function notifyNoPartner(outletId: string, invoiceNumber: string) {
  const partners = await partnerAvailability(outletId);
  const onDuty = partners.filter((p) => p.onDuty);
  const why = !onDuty.length
    ? "no delivery partner is on duty"
    : `all ${onDuty.length} partner${onDuty.length === 1 ? " is" : "s are"} out or full (${onDuty.map((p) => `${p.name}: ${p.reason}`).join("; ")})`;
  await notify(
    await outletManagers(outletId),
    "Delivery waiting for a partner",
    `${invoiceNumber}: ${why}. It will be assigned automatically when a partner is back — or a manager can assign it.`,
    "delivery.unassigned",
    { outletId },
  );
}
