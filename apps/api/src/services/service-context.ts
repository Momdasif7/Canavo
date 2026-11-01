import type { Request } from "express";
import { AsyncLocalStorage } from "node:async_hooks";
import type { DeliveryStatus, Outlet, Prisma } from "@prisma/client";
import { can, distanceMeters, type BillSplitMode, type OrderCreateInput } from "@canavo/shared";
import { prisma } from "../db";
import { outboxEmitOutlet, outboxTask } from "../lib/outbox";
import { badRequest, forbidden, HttpError } from "../lib/http";
import { autoAssignEnabled, canTakeOrder, notifyNoPartner, pickAvailablePartner } from "./delivery-assign";

type Tx = Prisma.TransactionClient;

export interface ServiceContext {
  /** Delivery fee, packaging etc. — pre-tax, taxed at line rates */
  extraCharges: { label: string; amount: number }[];
  /** Pre-orders: KOTs are hidden from the kitchen until this time */
  kotReleaseAt?: Date;
  /** Opaque data the module needs again in onOrderCreatedService */
  data?: Record<string, unknown>;
}

// =====================================================================
// Pure helpers (unit tested)
// =====================================================================

export const DEFAULT_PRE_ORDER_LEAD_MIN = 30;
export const MAX_PRE_ORDER_DAYS = 30;

export interface ZoneLike {
  id: string;
  radiusKm: number;
  active: boolean;
}

/** Smallest active zone whose radius covers the distance (null = outside all zones). */
export function selectZone<Z extends ZoneLike>(zones: Z[], distanceKm: number): Z | null {
  return (
    zones
      .filter((z) => z.active && distanceKm <= z.radiusKm + 1e-9)
      .sort((a, b) => a.radiusKm - b.radiusKm)[0] ?? null
  );
}

/**
 * KOT release time for a pre-order: scheduledFor − lead. Returns undefined
 * when that moment is already (or within a minute of) passing — fire
 * immediately. The margin keeps the billing-time emit and the release job
 * from both announcing the same KOT.
 */
export function preOrderReleaseAt(scheduledFor: Date, leadMinutes: number, now = new Date()): Date | undefined {
  const at = new Date(scheduledFor.getTime() - leadMinutes * 60_000);
  return at.getTime() > now.getTime() + 60_000 ? at : undefined;
}

/**
 * Split `total` paise into `parts` amounts that sum exactly to `total`,
 * the first ones carrying the extra paise (e.g. 1000/3 → 334, 333, 333).
 */
export function equalSplit(total: number, parts: number): number[] {
  if (!Number.isInteger(parts) || parts < 1) throw new Error("parts must be a positive integer");
  const base = Math.floor(total / parts);
  const extra = total - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < extra ? 1 : 0));
}

export interface BillableItem {
  id: string;
  seat: number | null;
  billedOrderId: string | null;
}

export interface BillGroup {
  label: string;
  itemIds: string[];
  seat?: number | null;
}

/**
 * Group unbilled session items into bills.
 * - FULL / EQUAL: one bill with everything unbilled.
 * - BY_SEAT: one bill per seat (optionally only `seats`); items without a seat
 *   form their own "Shared" bill (only when no seat filter is given).
 * - BY_ITEMS: one bill per group (`groups`) or a single bill of `itemIds`.
 */
export function groupBillItems(
  items: BillableItem[],
  mode: BillSplitMode,
  opts: { itemIds?: string[]; groups?: string[][]; seats?: number[] } = {},
): BillGroup[] {
  const unbilled = items.filter((i) => !i.billedOrderId);
  const unbilledIds = new Set(unbilled.map((i) => i.id));
  if (unbilled.length === 0) throw badRequest("Nothing left to bill on this table");

  if (mode === "FULL" || mode === "EQUAL") return [{ label: "Full", itemIds: unbilled.map((i) => i.id) }];

  if (mode === "BY_SEAT") {
    const bySeat = new Map<number | null, string[]>();
    for (const i of unbilled) {
      if (opts.seats?.length && (i.seat === null || !opts.seats.includes(i.seat))) continue;
      const arr = bySeat.get(i.seat) ?? [];
      arr.push(i.id);
      bySeat.set(i.seat, arr);
    }
    if (bySeat.size === 0) throw badRequest("No unbilled items for the selected seats");
    return [...bySeat.entries()]
      .sort(([a], [b]) => (a ?? Number.MAX_SAFE_INTEGER) - (b ?? Number.MAX_SAFE_INTEGER))
      .map(([seat, itemIds]) => ({ label: seat === null ? "Shared" : `Seat ${seat}`, seat, itemIds }));
  }

  // BY_ITEMS
  const groups = opts.groups?.length ? opts.groups : opts.itemIds?.length ? [opts.itemIds] : [];
  if (!groups.length) throw badRequest("Select the items to bill");
  const seen = new Set<string>();
  return groups.map((g, idx) => {
    for (const id of g) {
      if (!unbilledIds.has(id)) throw badRequest(`Item ${id} is not an unbilled item of this table`);
      if (seen.has(id)) throw badRequest(`Item ${id} appears in more than one bill`);
      seen.add(id);
    }
    return { label: `Bill ${idx + 1}`, itemIds: [...g] };
  });
}

const DELIVERY_FLOW: DeliveryStatus[] = ["PENDING", "ACCEPTED", "PREPARING", "OUT_FOR_DELIVERY", "DELIVERED"];

/** Deliveries only move forward (skipping steps is allowed); CANCELLED from any open state. */
export function canTransitionDelivery(from: DeliveryStatus, to: DeliveryStatus): boolean {
  if (from === "DELIVERED" || from === "CANCELLED") return false;
  if (to === "CANCELLED") return true;
  return DELIVERY_FLOW.indexOf(to) > DELIVERY_FLOW.indexOf(from);
}

// =====================================================================
// Session billing context — lets the table routes hand the session item ids
// to the order transaction so marking them billed is atomic with the bill.
// =====================================================================

interface SessionBillContext {
  sessionId: string;
  itemIds: string[];
}
const sessionBillStore = new AsyncLocalStorage<SessionBillContext>();

export function runWithSessionBill<T>(ctx: SessionBillContext, fn: () => Promise<T>): Promise<T> {
  return sessionBillStore.run(ctx, fn);
}

// =====================================================================
// Billing hooks
// =====================================================================

async function settingNumber(scope: string, key: string, fallback: number): Promise<number> {
  const s = await prisma.setting.findUnique({ where: { scope_key: { scope, key } } });
  const v = typeof s?.value === "number" ? s.value : Number(s?.value);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** Rough pre-discount, tax-as-priced subtotal of the input items (for zone minimum order). */
async function roughSubtotal(outletId: string, items: OrderCreateInput["items"]): Promise<number> {
  const menu = await prisma.menuItem.findMany({
    where: { id: { in: [...new Set(items.map((i) => i.menuItemId))] } },
    include: { variants: true, addons: true, overrides: { where: { outletId } } },
  });
  const byId = new Map(menu.map((m) => [m.id, m]));
  return items.reduce((sum, l) => {
    const m = byId.get(l.menuItemId);
    if (!m) return sum;
    const base = m.variants.find((v) => v.id === l.variantId)?.price ?? m.overrides[0]?.price ?? m.price;
    const addons = m.addons.filter((a) => l.addonIds.includes(a.id)).reduce((s, a) => s + a.price, 0);
    return sum + Math.max(0, (base + addons) * l.quantity - (l.discount ?? 0));
  }, 0);
}

/**
 * Billing hook: validate order-type specific input (delivery address/zone,
 * scheduledFor…) and return charges. Throws HttpError(400) on invalid input.
 */
export async function prepareServiceContext(req: Request, input: OrderCreateInput, outlet: Outlet): Promise<ServiceContext> {
  // Choosing Cash on Delivery is a payment decision: same permission as POST /orders/:id/cod.
  if (input.delivery?.cod && req.user && !can(req.user.role, "payment:collect")) {
    throw forbidden("You don't have permission to place Cash on Delivery orders");
  }
  const extraCharges: ServiceContext["extraCharges"] =
    outlet.packagingCharge > 0 && (input.orderType === "TAKEAWAY" || input.orderType === "DELIVERY")
      ? [{ label: "Packaging", amount: outlet.packagingCharge }]
      : [];
  const data: Record<string, unknown> = {};
  let kotReleaseAt: Date | undefined;
  const offline = Boolean(input.createdAt);

  if (input.orderType === "DELIVERY") {
    const d = input.delivery;
    if (!d) throw badRequest("Delivery address is required for delivery orders");
    if (!input.customerPhone || !input.customerName) throw badRequest("Customer name and phone are required for delivery");
    if (!outlet.deliveryEnabled && !offline) throw badRequest("Delivery is not enabled for this outlet");

    let distanceKm: number | undefined;
    if (d.latitude !== undefined && d.longitude !== undefined && outlet.latitude != null && outlet.longitude != null) {
      distanceKm =
        Math.round(
          (distanceMeters({ latitude: outlet.latitude, longitude: outlet.longitude }, { latitude: d.latitude, longitude: d.longitude }) / 1000) * 100,
        ) / 100;
    }
    const zones = await prisma.deliveryZone.findMany({ where: { outletId: outlet.id, active: true } });
    let zone: (typeof zones)[number] | null = null;
    if (d.zoneId) {
      zone = zones.find((z) => z.id === d.zoneId) ?? null;
      if (!zone) throw badRequest("Unknown or inactive delivery zone");
      if (distanceKm !== undefined && distanceKm > zone.radiusKm && !offline) {
        throw badRequest(`Address is ${distanceKm} km away, outside zone ${zone.name} (${zone.radiusKm} km)`);
      }
    } else if (zones.length) {
      if (distanceKm === undefined) throw badRequest("Provide map coordinates or choose a delivery zone");
      zone = selectZone(zones, distanceKm);
      if (!zone && !offline) {
        const max = Math.max(...zones.map((z) => z.radiusKm));
        throw badRequest(`Address is ${distanceKm} km away — we deliver within ${max} km`);
      }
    }
    if (zone && zone.minOrder > 0 && !offline) {
      const sub = await roughSubtotal(outlet.id, input.items);
      if (sub < zone.minOrder) {
        throw badRequest(`Minimum order for ${zone.name} is ₹${(zone.minOrder / 100).toFixed(2)}`);
      }
    }
    if (zone && zone.fee > 0) extraCharges.push({ label: "Delivery fee", amount: zone.fee });

    if (d.agentId) {
      const check = await canTakeOrder(outlet.id, d.agentId);
      if (!check.partner) throw badRequest("Delivery agent not found in this outlet");
      if (!check.ok) {
        // Only managers may overload a partner, and only after confirming (forceAssign).
        const manager = req.user && ["OUTLET_MANAGER", "BUSINESS_OWNER", "SUPER_ADMIN"].includes(req.user.role);
        if (!manager || !d.forceAssign) {
          throw new HttpError(409, `${check.partner.name} can't take this order: ${check.reason}`, {
            code: "PARTNER_UNAVAILABLE",
            reason: check.reason,
            canForce: Boolean(manager),
          });
        }
      }
    }
    data.delivery = { zoneId: zone?.id ?? null, etaMinutes: zone?.etaMinutes ?? null, distanceKm: distanceKm ?? null };
  }

  if (input.orderType === "PRE_ORDER") {
    if (!input.scheduledFor) throw badRequest("Pre-orders need scheduledFor (pickup/serve time)");
    const at = new Date(input.scheduledFor);
    const now = Date.now();
    if (!offline) {
      if (at.getTime() <= now) throw badRequest("scheduledFor must be in the future");
      if (at.getTime() > now + MAX_PRE_ORDER_DAYS * 86_400_000) throw badRequest(`Pre-orders can be at most ${MAX_PRE_ORDER_DAYS} days ahead`);
    }
    const lead = await settingNumber(outlet.id, "service.preOrderLeadMinutes", DEFAULT_PRE_ORDER_LEAD_MIN);
    kotReleaseAt = preOrderReleaseAt(at, lead);
  }

  const bill = sessionBillStore.getStore();
  if (bill) {
    if (input.orderType !== "DINE_IN") throw badRequest("Table bills must be DINE_IN");
    data.sessionBill = bill;
  }

  void req;
  return { extraCharges, kotReleaseAt, data };
}

/** Inside the order tx: create the Delivery row, mark table-session items billed. */
export async function onOrderCreatedService(tx: Tx, orderId: string, input: OrderCreateInput, ctx: ServiceContext): Promise<void> {
  const bill = ctx.data?.sessionBill as SessionBillContext | undefined;
  if (bill) {
    // Conditional update guards against two cashiers billing the same items concurrently.
    const { count } = await tx.tableSessionItem.updateMany({
      where: { id: { in: bill.itemIds }, sessionId: bill.sessionId, billedOrderId: null },
      data: { billedOrderId: orderId },
    });
    if (count !== bill.itemIds.length) throw badRequest("Some items were already billed — refresh the table");
  }

  if (input.orderType === "DELIVERY" && input.delivery) {
    const meta = (ctx.data?.delivery ?? {}) as { zoneId?: string | null; etaMinutes?: number | null; distanceKm?: number | null };
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { outletId: true, createdAt: true } });
    const d = input.delivery;
    // No partner chosen → give it to an available (on-duty) partner automatically.
    let agentId = d.agentId;
    if (!agentId && (await autoAssignEnabled(order.outletId, tx))) {
      agentId = (await pickAvailablePartner(order.outletId, tx))?.id;
    }
    const delivery = await tx.delivery.create({
      data: {
        orderId,
        outletId: order.outletId,
        agentId,
        assignedAt: agentId ? new Date() : undefined,
        source: d.source,
        cod: d.cod ?? false,
        customerName: input.customerName!,
        customerPhone: input.customerPhone!,
        address: d.address,
        landmark: d.landmark,
        latitude: d.latitude,
        longitude: d.longitude,
        distanceKm: meta.distanceKm ?? undefined,
        zoneId: meta.zoneId ?? undefined,
        etaAt: new Date(Date.now() + (meta.etaMinutes ?? 30) * 60_000),
        notes: d.notes,
      },
    });
    await outboxTask(tx, "delivery.announce", { deliveryId: delivery.id });
    if (!agentId) {
      const inv = (await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { invoiceNumber: true } })).invoiceNumber;
      await outboxTask(tx, "delivery.noPartner", { outletId: order.outletId, invoiceNumber: inv });
    }
  }
}

/** Inside the cancel tx: cancel the delivery, un-bill table-session items. */
export async function onOrderCancelledService(tx: Tx, orderId: string): Promise<void> {
  const delivery = await tx.delivery.findUnique({ where: { orderId } });
  if (delivery && delivery.status !== "DELIVERED" && delivery.status !== "CANCELLED") {
    await tx.delivery.update({ where: { id: delivery.id }, data: { status: "CANCELLED" } });
    await outboxTask(tx, "delivery.announce", { deliveryId: delivery.id });
  }
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { tableSessionId: true } });
  if (order?.tableSessionId) {
    await tx.tableSessionItem.updateMany({ where: { billedOrderId: orderId }, data: { billedOrderId: null } });
    await tx.kotTicket.updateMany({ where: { orderId, sessionId: { not: null } }, data: { orderId: null } });
  }
}

/** Outbox task "delivery.announce": tell the board / partner about a delivery after its transaction committed. */
export async function announceDelivery(deliveryId: string) {
  const { emitToOutlet } = await import("../realtime");
  const { notify } = await import("./notify");
  const d = await prisma.delivery.findUnique({ where: { id: deliveryId }, include: { order: { select: { invoiceNumber: true, grandTotal: true } } } });
  if (!d) return; // transaction rolled back
  emitToOutlet(d.outletId, "delivery:updated", d);
  if (d.agentId && d.status !== "CANCELLED") {
    await notify([d.agentId], "New delivery assigned", `${d.order.invoiceNumber} · ${d.customerName} · ${d.address}`, "delivery");
  }
}

/**
 * Billing hook (from settleIfPaid, inside the payment tx): when the last bill
 * of a dine-in tab is paid and nothing is left unbilled, close the tab and
 * free its tables.
 */
export async function onOrderPaidService(tx: Tx, orderId: string): Promise<void> {
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { tableSessionId: true, outletId: true } });
  if (!order?.tableSessionId) return;
  const session = await tx.tableSession.findUnique({ where: { id: order.tableSessionId } });
  if (!session || session.status !== "OPEN") return;
  const [unbilled, openOrders] = await Promise.all([
    tx.tableSessionItem.count({ where: { sessionId: session.id, billedOrderId: null } }),
    tx.order.count({ where: { tableSessionId: session.id, status: "OPEN", id: { not: orderId } } }),
  ]);
  if (unbilled || openOrders) return;
  const tableIds = [session.tableId, ...session.mergedTableIds];
  await tx.tableSession.update({ where: { id: session.id }, data: { status: "CLOSED", closedAt: new Date() } });
  await tx.diningTable.updateMany({ where: { id: { in: tableIds } }, data: { status: "AVAILABLE" } });
  await tx.reservation.updateMany({ where: { sessionId: session.id, status: "SEATED" }, data: { status: "COMPLETED" } });
  // The tab is paid, so its food has been served — clear its tickets from the kitchen display.
  await tx.kotTicket.updateMany({ where: { sessionId: session.id, status: { not: "SERVED" } }, data: { status: "SERVED" } });
  await outboxEmitOutlet(tx, order.outletId, "table:updated", { tableIds, sessionId: session.id, action: "close" });
}
