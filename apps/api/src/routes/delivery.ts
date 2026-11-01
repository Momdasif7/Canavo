import { Router, type Request } from "express";
import { z } from "zod";
import type { DeliveryStatus, Prisma } from "@prisma/client";
import {
  deliveryActivityQuerySchema,
  deliveryAssignSchema,
  deliveryHandoverSchema,
  deliveryHandoverUpdateSchema,
  deliveryCashSettleSchema,
  deliveryCollectSchema,
  deliveryIssueSchema,
  deliveryListQuerySchema,
  deliveryMineQuerySchema,
  deliverySummaryQuerySchema,
  deliveryLocationSchema,
  deliveryQuoteQuerySchema,
  deliveryStatusSchema,
  partnerLocationSchema,
  deliveryZoneSchema,
  deliveryZoneUpdateSchema,
  distanceMeters,
} from "@canavo/shared";
import { prisma } from "../db";
import { audit } from "../lib/audit";
import { badRequest, conflict, forbidden, HttpError, notFound, param, parse } from "../lib/http";
import { addDays, startOfLocalDay, zonedParts } from "../lib/time";
import { requireAnyPermission, authenticate, requireOutlet, requirePermission, requireModule, userCan } from "../middleware/auth";
import { emitToOutlet } from "../realtime";
import { notify, outletManagers } from "../services/notify";
import { deliveryStatusLink } from "../services/delivery-notify";
import { getWaConfig, sendWhatsApp } from "../services/whatsapp";
import { canTransitionDelivery, selectZone } from "../services/service-context";
import { amountPaid, settleIfPaid } from "../services/billing";
import { createUpiQr } from "../services/razorpay";
import { cashBalance, cashCollected, cashHandedOver, pendingCollections, reallocateHandovers } from "../services/delivery-cash";
import { assignWaitingDeliveries, canTakeOrder, markBackAtOutlet, partnerAvailability, reportPartnerLocation, startRun } from "../services/delivery-assign";
import { alertPartnerCash } from "../services/alerts";

export const deliveryRouter = Router();
deliveryRouter.use(authenticate, requireOutlet, requireModule("DELIVERY"));

const ACTIVE: DeliveryStatus[] = ["PENDING", "ACCEPTED", "PREPARING", "OUT_FOR_DELIVERY"];

const include = {
  order: {
    select: {
      id: true,
      invoiceNumber: true,
      grandTotal: true,
      status: true,
      notes: true,
      items: { select: { name: true, quantity: true, notes: true } },
      payments: { select: { id: true, amount: true, status: true, mode: true, collectedById: true, reference: true, confirmedAt: true, qrPayload: true } },
    },
  },
  agent: { select: { id: true, name: true, phone: true } },
} satisfies Prisma.DeliveryInclude;

/** Last known agent positions (in memory: live tracking only, not history). */
const lastLocation = new Map<string, { lat: number; lng: number; at: string; deliveryId: string; outletId: string }>();

function withExtras<T extends { agentId: string | null; order: { grandTotal: number; payments: { amount: number; status: string }[] } }>(d: T) {
  const paid = d.order.payments.filter((p) => p.status === "SUCCESS").reduce((s, p) => s + p.amount, 0);
  return { ...d, amountDue: Math.max(0, d.order.grandTotal - paid), amountPaid: paid, agentLocation: d.agentId ? lastLocation.get(d.agentId) ?? null : null };
}

async function findDelivery(id: string, outletId: string) {
  const d = await prisma.delivery.findFirst({ where: { id, outletId }, include });
  if (!d) throw notFound("Delivery");
  return d;
}

/** Statuses a customer is told about automatically (when the business turned it on). */
const AUTO_UPDATE_STATUSES = new Set(["ACCEPTED", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED"]);

/**
 * Customer status message: always a wa.me link for staff; on a status change with
 * "auto delivery updates" on and a WhatsApp provider set, it is also sent in the
 * background through the provider (never delays or fails the request).
 */
async function customerLink(d: Awaited<ReturnType<typeof findDelivery>>, opts: { autoSend?: boolean } = {}) {
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: d.outletId }, select: { name: true, timezone: true } });
  const msg = deliveryStatusLink({
    phone: d.customerPhone,
    status: d.status,
    outletName: outlet.name,
    invoiceNumber: d.order.invoiceNumber,
    etaAt: d.etaAt,
    agentName: d.agent?.name,
    timezone: outlet.timezone,
  });
  let autoSent = false;
  if (opts.autoSend && d.customerPhone && AUTO_UPDATE_STATUSES.has(d.status)) {
    const cfg = await getWaConfig();
    if (cfg.autoDeliveryUpdates && cfg.provider !== "NONE") {
      autoSent = true;
      void sendWhatsApp(
        {
          to: d.customerPhone,
          text: msg.text,
          purpose: "delivery_update",
          tag: `delivery_${d.order.invoiceNumber}`,
          params: [
            { name: "outlet", value: outlet.name },
            { name: "invoice", value: d.order.invoiceNumber },
            { name: "status", value: msg.text },
          ],
        },
        cfg,
      ).catch((e) => console.error("[whatsapp] delivery update failed", e));
    }
  }
  return { ...msg, autoSent };
}

// ---------- Zones ----------
deliveryRouter.get("/zones", requirePermission("delivery:manage"), async (req, res) => {
  res.json(await prisma.deliveryZone.findMany({ where: { outletId: req.outletId }, orderBy: { radiusKm: "asc" } }));
});

deliveryRouter.post("/zones", requirePermission("delivery:manage", "settings:outlet"), async (req, res) => {
  const data = parse(deliveryZoneSchema, req.body);
  const zone = await prisma.deliveryZone.create({ data: { ...data, outletId: req.outletId! } });
  await audit(req, "delivery.zone.create", "DeliveryZone", zone.id, data);
  res.status(201).json(zone);
});

async function findZone(id: string, outletId: string) {
  const z = await prisma.deliveryZone.findFirst({ where: { id, outletId } });
  if (!z) throw notFound("Delivery zone");
  return z;
}

deliveryRouter.patch("/zones/:id", requirePermission("delivery:manage", "settings:outlet"), async (req, res) => {
  const zone = await findZone(param(req, "id"), req.outletId!);
  const data = parse(deliveryZoneUpdateSchema, req.body);
  const updated = await prisma.deliveryZone.update({ where: { id: zone.id }, data });
  await audit(req, "delivery.zone.update", "DeliveryZone", zone.id, data);
  res.json(updated);
});

deliveryRouter.delete("/zones/:id", requirePermission("delivery:manage", "settings:outlet"), async (req, res) => {
  const zone = await findZone(param(req, "id"), req.outletId!);
  await prisma.deliveryZone.delete({ where: { id: zone.id } });
  await audit(req, "delivery.zone.delete", "DeliveryZone", zone.id, { name: zone.name });
  res.status(204).end();
});

/** Fee/ETA for a drop location; without coordinates returns the zone list to pick from. */
deliveryRouter.get("/quote", requirePermission("delivery:manage"), async (req, res) => {
  const q = parse(deliveryQuoteQuerySchema, req.query);
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: req.outletId } });
  const zones = await prisma.deliveryZone.findMany({ where: { outletId: outlet.id, active: true }, orderBy: { radiusKm: "asc" } });
  const base = { deliveryEnabled: outlet.deliveryEnabled, packagingCharge: outlet.packagingCharge };
  if (q.lat === undefined || q.lng === undefined) {
    return res.json({ ...base, needsCoordinates: true, address: q.address ?? null, zones });
  }
  if (outlet.latitude == null || outlet.longitude == null) throw badRequest("Outlet location is not set — choose a zone manually");
  const distanceKm = Math.round((distanceMeters({ latitude: outlet.latitude, longitude: outlet.longitude }, { latitude: q.lat, longitude: q.lng }) / 1000) * 100) / 100;
  const zone = selectZone(zones, distanceKm);
  res.json({
    ...base,
    distanceKm,
    deliverable: Boolean(zone) && outlet.deliveryEnabled,
    zone,
    fee: zone?.fee ?? null,
    minOrder: zone?.minOrder ?? null,
    etaMinutes: zone?.etaMinutes ?? null,
    etaAt: zone ? new Date(Date.now() + zone.etaMinutes * 60_000) : null,
    zones,
  });
});

/** Delivery routes used by both the board (managers) and the assigned partner; the handler checks it's their delivery. */
const managerOrPartner = requireAnyPermission("delivery:manage", "delivery:own");

// ---------- Agents ----------
/** Delivery partners of the outlet with live availability (on duty, at the outlet / on a run, orders held vs limit). */
deliveryRouter.get("/agents", requirePermission("delivery:manage"), async (req, res) => {
  const outletId = req.outletId!;
  const partners = await partnerAvailability(outletId);
  const clocked = await prisma.staffAttendance.findMany({
    where: { userId: { in: partners.map((p) => p.id) }, outletId, clockOutAt: null },
    select: { userId: true, clockInAt: true },
  });
  res.json(
    partners.map((p) => ({
      ...p,
      activeDeliveries: p.active,
      clockedIn: p.onDuty,
      clockedInAt: clocked.find((c) => c.userId === p.id)?.clockInAt ?? null,
      location: lastLocation.get(p.id) ?? (p.lastLocation ? { lat: p.lastLocation.lat, lng: p.lastLocation.lng, at: p.lastLocation.at.toISOString() } : null),
    })),
  );
});

/** Manager: partner is back (e.g. their phone isn't sharing GPS) — makes them available again. */
deliveryRouter.post("/agents/:id/back", requirePermission("delivery:manage"), async (req, res) => {
  const agentId = param(req, "id");
  const [p] = await partnerAvailability(req.outletId!, prisma, [agentId]);
  if (!p) throw notFound("Delivery partner");
  if (p.outForDelivery > 0) throw conflict(`${p.name} still has ${p.outForDelivery} order(s) out for delivery`);
  await markBackAtOutlet(req.outletId!, agentId, "manager");
  await audit(req, "delivery.partner_back", "User", agentId);
  const [after] = await partnerAvailability(req.outletId!, prisma, [agentId]);
  res.json(after);
});

/** Partner app: GPS while on duty. Detects the return to the outlet after a run. */
deliveryRouter.post("/me/location", requirePermission("delivery:own"), async (req, res) => {
  const fix = parse(partnerLocationSchema, req.body);
  res.json(await reportPartnerLocation(req.outletId!, req.user!.id, fix));
});

/** Partner: my dispatch state (at the outlet / on a run, orders held vs the limit). */
deliveryRouter.get("/me/status", requirePermission("delivery:own"), async (req, res) => {
  const [p] = await partnerAvailability(req.outletId!, prisma, [req.user!.id]);
  res.json(p ?? null);
});

/** Last known positions of agents on active deliveries (live map). */
deliveryRouter.get("/locations", requirePermission("delivery:manage"), async (req, res) => {
  res.json([...lastLocation.entries()].filter(([, l]) => l.outletId === req.outletId).map(([agentId, l]) => ({ agentId, ...l })));
});

// ---------- Deliveries ----------
deliveryRouter.get("/", requirePermission("delivery:manage"), async (req, res) => {
  const q = parse(deliveryListQuerySchema, req.query);
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: req.outletId } });
  const start = q.date ? startOfLocalDay(q.date, outlet.timezone) : undefined;
  const list = await prisma.delivery.findMany({
    where: {
      outletId: outlet.id,
      ...(q.status && { status: q.status }),
      ...(q.active === "1" && { status: { in: ACTIVE } }),
      ...(q.agentId && { agentId: q.agentId === "none" ? null : q.agentId }),
      ...(start && { createdAt: { gte: start, lt: new Date(start.getTime() + 86_400_000) } }),
    },
    include,
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  res.json(list.map(withExtras));
});

/** Local date range [from, to] in outlet time → UTC instants. Defaults to today. */
async function localRange(outletId: string, from?: string, to?: string) {
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: outletId }, select: { timezone: true } });
  const today = zonedParts(new Date(), outlet.timezone).date;
  const f = from ?? today;
  const t = to ?? from ?? today;
  if (t < f) throw badRequest("'to' must be on or after 'from'");
  return { from: f, to: t, start: startOfLocalDay(f, outlet.timezone), end: startOfLocalDay(addDays(t, 1), outlet.timezone), timezone: outlet.timezone };
}

/**
 * Delivery partner: `view=active` → assigned deliveries still to complete;
 * `view=history` → delivered / cancelled ones in a date range (default last 7 days).
 */
deliveryRouter.get("/mine", requirePermission("delivery:own"), async (req, res) => {
  const q = parse(deliveryMineQuerySchema, req.query);
  const base = { outletId: req.outletId, agentId: req.user!.id };
  if (q.view === "active") {
    const list = await prisma.delivery.findMany({
      where: { ...base, status: { in: ACTIVE } },
      include,
      orderBy: [{ etaAt: "asc" }, { createdAt: "asc" }],
    });
    return res.json(list.map(withExtras));
  }
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: req.outletId }, select: { timezone: true } });
  const today = zonedParts(new Date(), outlet.timezone).date;
  const range = await localRange(req.outletId!, q.from ?? addDays(today, -6), q.to ?? today);
  const list = await prisma.delivery.findMany({
    where: {
      ...base,
      status: { in: ["DELIVERED", "CANCELLED"] },
      OR: [{ deliveredAt: { gte: range.start, lt: range.end } }, { deliveredAt: null, updatedAt: { gte: range.start, lt: range.end } }],
    },
    include,
    orderBy: [{ deliveredAt: "desc" }, { updatedAt: "desc" }],
    take: 300,
  });
  res.json(list.map(withExtras));
});

/** How a delivered order was paid, from the partner's point of view. */
function collectionOf(d: { order: { payments: { amount: number; status: string; mode: string; collectedById: string | null }[] } }, agentId: string) {
  const ok = d.order.payments.filter((p) => p.status === "SUCCESS");
  const byMe = (mode: string) => ok.filter((p) => p.collectedById === agentId && p.mode === mode).reduce((s, p) => s + p.amount, 0);
  return {
    cash: byMe("CASH"),
    upi: byMe("UPI"),
    card: byMe("CARD"),
    /** Paid before dispatch (online / at the counter) — nothing to collect */
    prepaid: ok.filter((p) => p.collectedById !== agentId).reduce((s, p) => s + p.amount, 0),
  };
}

/**
 * Delivery partner dashboard: deliveries done, money collected by mode, cash
 * still in hand (not yet handed to the outlet), average delivery time, per-day trend.
 */
deliveryRouter.get("/mine/summary", requirePermission("delivery:own"), async (req, res) => {
  const q = parse(deliverySummaryQuerySchema, req.query);
  const me = req.user!.id;
  const range = await localRange(req.outletId!, q.from, q.to);
  const [inRange, active, unsettled, onDuty] = await Promise.all([
    prisma.delivery.findMany({
      where: {
        outletId: req.outletId,
        agentId: me,
        OR: [{ deliveredAt: { gte: range.start, lt: range.end } }, { status: "CANCELLED", updatedAt: { gte: range.start, lt: range.end } }],
      },
      include: { order: { select: { grandTotal: true, chargesBreakup: true, payments: { select: { amount: true, status: true, mode: true, collectedById: true } } } } },
    }),
    prisma.delivery.findMany({
      where: { outletId: req.outletId, agentId: me, status: { in: ACTIVE } },
      select: { cod: true, order: { select: { grandTotal: true, status: true, payments: { select: { amount: true, status: true } } } } },
    }),
    pendingCollections(req.outletId!, me),
    prisma.staffAttendance.findFirst({ where: { userId: me, clockOutAt: null }, select: { clockInAt: true } }),
  ]);
  const delivered = inRange.filter((d) => d.status === "DELIVERED");
  const totals = { cash: 0, upi: 0, card: 0, prepaid: 0 };
  const byDay = new Map<string, { date: string; deliveries: number; collected: number }>();
  let minutes = 0;
  let timed = 0;
  let distanceKm = 0;
  let deliveryFees = 0;
  for (const d of delivered) {
    const c = collectionOf(d, me);
    totals.cash += c.cash;
    totals.upi += c.upi;
    totals.card += c.card;
    totals.prepaid += c.prepaid;
    const day = zonedParts(d.deliveredAt!, range.timezone).date;
    const row = byDay.get(day) ?? { date: day, deliveries: 0, collected: 0 };
    row.deliveries++;
    row.collected += c.cash + c.upi + c.card;
    byDay.set(day, row);
    const startedAt = d.pickedAt ?? d.acceptedAt ?? d.assignedAt;
    if (startedAt) {
      minutes += (d.deliveredAt!.getTime() - startedAt.getTime()) / 60_000;
      timed++;
    }
    distanceKm += d.distanceKm ?? 0;
    deliveryFees += ((d.order.chargesBreakup as { label: string; amount: number }[] | null) ?? [])
      .filter((x) => /delivery/i.test(x.label))
      .reduce((s, x) => s + x.amount, 0);
  }
  res.json({
    from: range.from,
    to: range.to,
    onDuty: Boolean(onDuty),
    onDutySince: onDuty?.clockInAt ?? null,
    activeDeliveries: active.length,
    /** Cash still to collect on active Cash-on-Delivery orders */
    codToCollect: active
      .filter((d) => d.cod && d.order.status === "OPEN")
      .reduce((s, d) => s + Math.max(0, d.order.grandTotal - amountPaid(d.order)), 0),
    codOrders: active.filter((d) => d.cod && d.order.status === "OPEN").length,
    delivered: delivered.length,
    cancelled: inRange.length - delivered.length,
    orderValue: delivered.reduce((s, d) => s + d.order.grandTotal, 0),
    collected: { ...totals, total: totals.cash + totals.upi + totals.card },
    cashInHand: await cashBalance(req.outletId!, me),
    cashInHandOrders: new Set(unsettled.map((p) => p.orderId)).size,
    avgDeliveryMinutes: timed ? Math.round(minutes / timed) : null,
    distanceKm: Math.round(distanceKm * 10) / 10,
    deliveryFees,
    byDay: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
  });
});

// =====================================================================
// Cash ledger: collected at the door − handed over to the outlet
// =====================================================================

/** Delivery partner: cash to hand over (separate from deliveries) — balance, today's movement, pending orders, recent handovers. */
deliveryRouter.get("/mine/cash", requirePermission("delivery:own"), async (req, res) => {
  const me = req.user!.id;
  const outletId = req.outletId!;
  const today = await localRange(outletId);
  const range = { gte: today.start, lt: today.end };
  const [balance, collectedToday, handedToday, pending, handovers] = await Promise.all([
    cashBalance(outletId, me),
    cashCollected(outletId, me, range),
    cashHandedOver(outletId, me, range),
    pendingCollections(outletId, me),
    prisma.deliveryCashHandover.findMany({ where: { outletId, agentId: me }, orderBy: { receivedAt: "desc" }, take: 20 }),
  ]);
  const receivers = await prisma.user.findMany({ where: { id: { in: [...new Set(handovers.map((h) => h.receivedById))] } }, select: { id: true, name: true } });
  res.json({
    balance,
    collectedToday,
    handedOverToday: handedToday,
    pending,
    handovers: handovers.map((h) => ({ ...h, receivedBy: receivers.find((r) => r.id === h.receivedById) ?? null })),
  });
});

/** Partners who work in this outlet (DELIVERY role). */
async function outletPartners(outletId: string, agentId?: string) {
  return prisma.user.findMany({
    where: { role: "DELIVERY", outlets: { some: { outletId } }, ...(agentId && { id: agentId }) },
    select: { id: true, name: true, phone: true, status: true },
    orderBy: { name: "asc" },
  });
}

/** Manager: cash each delivery partner holds, today's collections / receipts, and pending orders. */
deliveryRouter.get("/cash", requirePermission("delivery:manage"), async (req, res) => {
  const outletId = req.outletId!;
  const today = await localRange(outletId);
  const range = { gte: today.start, lt: today.end };
  const partners = await outletPartners(outletId);
  const rows = await Promise.all(
    partners.map(async (agent) => {
      const [balance, collectedToday, receivedToday, pending, last] = await Promise.all([
        cashBalance(outletId, agent.id),
        cashCollected(outletId, agent.id, range),
        cashHandedOver(outletId, agent.id, range),
        pendingCollections(outletId, agent.id),
        prisma.deliveryCashHandover.findFirst({ where: { outletId, agentId: agent.id }, orderBy: { receivedAt: "desc" } }),
      ]);
      return { agent, balance, amount: balance, collectedToday, receivedToday, pending, deliveries: pending, lastHandoverAt: last?.receivedAt ?? null };
    }),
  );
  res.json(rows.filter((r) => r.balance !== 0 || r.collectedToday || r.receivedToday || r.agent.status === "ACTIVE"));
});

/** Handover history (filter by partner / dates). */
deliveryRouter.get("/cash/handovers", requirePermission("delivery:manage"), async (req, res) => {
  const q = parse(deliveryActivityQuerySchema, req.query);
  const range = await localRange(req.outletId!, q.from, q.to ?? q.from);
  const list = await prisma.deliveryCashHandover.findMany({
    where: { outletId: req.outletId, ...(q.agentId && { agentId: q.agentId }), ...((q.from || q.to) && { receivedAt: { gte: range.start, lt: range.end } }) },
    orderBy: { receivedAt: "desc" },
    take: 500,
  });
  const users = await prisma.user.findMany({ where: { id: { in: [...new Set(list.flatMap((h) => [h.agentId, h.receivedById]))] } }, select: { id: true, name: true } });
  const name = (id: string) => users.find((u) => u.id === id) ?? null;
  res.json(list.map((h) => ({ ...h, agent: name(h.agentId), receivedBy: name(h.receivedById) })));
});

async function assertPartner(outletId: string, agentId: string) {
  const partner = await prisma.user.findFirst({ where: { id: agentId, role: "DELIVERY", outlets: { some: { outletId } } }, select: { id: true, name: true } });
  if (!partner) throw badRequest("Delivery partner not found in this outlet");
  return partner;
}

/** Record cash received from a partner (any amount — partial handovers are fine). */
deliveryRouter.post("/cash/handovers", requirePermission("delivery:manage"), async (req, res) => {
  const data = parse(deliveryHandoverSchema, req.body);
  const outletId = req.outletId!;
  const partner = await assertPartner(outletId, data.agentId);
  const before = await cashBalance(outletId, data.agentId);
  const h = await prisma.deliveryCashHandover.create({
    data: {
      outletId,
      agentId: data.agentId,
      amount: data.amount,
      note: data.note,
      receivedById: req.user!.id,
      ...(data.receivedAt && { receivedAt: new Date(data.receivedAt) }),
    },
  });
  await reallocateHandovers(outletId, data.agentId);
  await audit(req, "delivery.cash.handover", "DeliveryCashHandover", h.id, { agentId: data.agentId, amount: data.amount, balanceBefore: before });
  await notify([data.agentId], "Cash handover recorded", `₹${(data.amount / 100).toFixed(2)} received by ${req.user!.name}`, "delivery");
  emitToOutlet(outletId, "delivery:updated", { cashHandover: data.agentId });
  const balance = await cashBalance(outletId, data.agentId);
  res.status(201).json({
    handover: h,
    balance,
    ...(balance < 0 && { warnings: [`More than the cash ${partner.name} held — they are now ₹${(-balance / 100).toFixed(2)} in credit`] }),
  });
});

/** Correct a handover entry (amount / note / time). */
deliveryRouter.patch("/cash/handovers/:id", requirePermission("delivery:manage"), async (req, res) => {
  const data = parse(deliveryHandoverUpdateSchema, req.body);
  const existing = await prisma.deliveryCashHandover.findFirst({ where: { id: param(req, "id"), outletId: req.outletId } });
  if (!existing) throw notFound("Handover");
  const h = await prisma.deliveryCashHandover.update({
    where: { id: existing.id },
    data: { amount: data.amount, note: data.note, ...(data.receivedAt && { receivedAt: new Date(data.receivedAt) }) },
  });
  await reallocateHandovers(existing.outletId, existing.agentId);
  await audit(req, "delivery.cash.handover_edit", "DeliveryCashHandover", h.id, { before: { amount: existing.amount, note: existing.note, receivedAt: existing.receivedAt }, after: data });
  emitToOutlet(existing.outletId, "delivery:updated", { cashHandover: existing.agentId });
  res.json({ handover: h, balance: await cashBalance(existing.outletId, existing.agentId) });
});

deliveryRouter.delete("/cash/handovers/:id", requirePermission("delivery:manage"), async (req, res) => {
  const existing = await prisma.deliveryCashHandover.findFirst({ where: { id: param(req, "id"), outletId: req.outletId } });
  if (!existing) throw notFound("Handover");
  await prisma.deliveryCashHandover.delete({ where: { id: existing.id } });
  await reallocateHandovers(existing.outletId, existing.agentId);
  await audit(req, "delivery.cash.handover_delete", "DeliveryCashHandover", existing.id, { agentId: existing.agentId, amount: existing.amount });
  emitToOutlet(existing.outletId, "delivery:updated", { cashHandover: existing.agentId });
  res.json({ balance: await cashBalance(existing.outletId, existing.agentId) });
});

/** Shortcut: the partner handed over everything they hold. */
deliveryRouter.post("/cash/settle", requirePermission("delivery:manage"), async (req, res) => {
  const { agentId } = parse(deliveryCashSettleSchema, req.body);
  const outletId = req.outletId!;
  await assertPartner(outletId, agentId);
  const amount = await cashBalance(outletId, agentId);
  if (amount <= 0) throw badRequest("No cash to settle for this delivery partner");
  const h = await prisma.deliveryCashHandover.create({ data: { outletId, agentId, amount, note: "Full handover", receivedById: req.user!.id } });
  await reallocateHandovers(outletId, agentId);
  await audit(req, "delivery.cash.settle", "DeliveryCashHandover", h.id, { agentId, amount });
  await notify([agentId], "Cash handover confirmed", `₹${(amount / 100).toFixed(2)} received by ${req.user!.name}`, "delivery");
  emitToOutlet(outletId, "delivery:updated", { cashHandover: agentId });
  res.json({ settled: 1, amount, handover: h });
});

// =====================================================================
// Partner activity (manager / owner)
// =====================================================================

/**
 * Per partner, per day: duty time, deliveries, cash collected, cash received
 * and the running balance (cash still to be received at the end of the day).
 */
deliveryRouter.get("/partners/activity", requirePermission("delivery:manage"), async (req, res) => {
  const q = parse(deliveryActivityQuerySchema, req.query);
  const outletId = req.outletId!;
  const range = await localRange(outletId, q.from, q.to);
  const days: string[] = [];
  for (let d = range.from; d <= range.to; d = addDays(d, 1)) days.push(d);
  const partners = await outletPartners(outletId, q.agentId);
  const result = await Promise.all(
    partners.map(async (agent) => {
      const [opening, attendance, deliveries, payments, handovers] = await Promise.all([
        cashBalance(outletId, agent.id, range.start),
        prisma.staffAttendance.findMany({
          where: { userId: agent.id, clockInAt: { gte: range.start, lt: range.end }, status: { in: ["PRESENT", "HALF_DAY"] } },
          select: { workDate: true, clockInAt: true, clockOutAt: true, workedMinutes: true, lateByMinutes: true },
          orderBy: { clockInAt: "asc" },
        }),
        prisma.delivery.findMany({
          where: {
            outletId,
            agentId: agent.id,
            OR: [{ assignedAt: { gte: range.start, lt: range.end } }, { deliveredAt: { gte: range.start, lt: range.end } }, { updatedAt: { gte: range.start, lt: range.end } }],
          },
          select: { status: true, assignedAt: true, acceptedAt: true, pickedAt: true, deliveredAt: true, updatedAt: true, notes: true, cod: true, distanceKm: true },
        }),
        prisma.payment.findMany({ where: { ...{ collectedById: agent.id, mode: "CASH" as const, status: "SUCCESS" as const, order: { outletId } }, confirmedAt: { gte: range.start, lt: range.end } }, select: { amount: true, confirmedAt: true } }),
        prisma.deliveryCashHandover.findMany({ where: { outletId, agentId: agent.id, receivedAt: { gte: range.start, lt: range.end } }, select: { amount: true, receivedAt: true } }),
      ]);
      const dayOf = (d: Date) => zonedParts(d, range.timezone).date;
      let balance = opening;
      const rows = days.map((date) => {
        const att = attendance.filter((a) => a.workDate === date || dayOf(a.clockInAt) === date);
        const delivered = deliveries.filter((d) => d.status === "DELIVERED" && d.deliveredAt && dayOf(d.deliveredAt) === date);
        const assigned = deliveries.filter((d) => d.assignedAt && dayOf(d.assignedAt) === date).length;
        const cancelled = deliveries.filter((d) => d.status === "CANCELLED" && dayOf(d.updatedAt) === date).length;
        const issues = deliveries.filter((d) => dayOf(d.updatedAt) === date && (d.notes ?? "").includes("ISSUE:")).length;
        const times = delivered
          .map((d) => {
            const s = d.pickedAt ?? d.acceptedAt ?? d.assignedAt;
            return s ? (d.deliveredAt!.getTime() - s.getTime()) / 60_000 : null;
          })
          .filter((m): m is number => m !== null);
        const collected = payments.filter((p) => p.confirmedAt && dayOf(p.confirmedAt) === date).reduce((s, p) => s + p.amount, 0);
        const received = handovers.filter((h) => dayOf(h.receivedAt) === date).reduce((s, h) => s + h.amount, 0);
        const openingBalance = balance;
        balance = balance + collected - received;
        return {
          date,
          clockIn: att[0]?.clockInAt ?? null,
          clockOut: att.length ? att[att.length - 1].clockOutAt : null,
          onDutyMinutes: att.reduce((s, a) => s + (a.workedMinutes ?? (a.clockOutAt ? 0 : Math.round((Date.now() - a.clockInAt.getTime()) / 60_000))), 0),
          lateByMinutes: att[0]?.lateByMinutes ?? 0,
          assigned,
          delivered: delivered.length,
          codDelivered: delivered.filter((d) => d.cod).length,
          cancelled,
          issues,
          avgDeliveryMinutes: times.length ? Math.round(times.reduce((a, b) => a + b, 0) / times.length) : null,
          distanceKm: Math.round(delivered.reduce((s, d) => s + (d.distanceKm ?? 0), 0) * 10) / 10,
          openingBalance,
          cashCollected: collected,
          cashReceived: received,
          /** Cash still to be received from the partner at the end of the day */
          closingBalance: balance,
        };
      });
      const sum = (k: "delivered" | "cancelled" | "cashCollected" | "cashReceived" | "onDutyMinutes" | "assigned") => rows.reduce((s, r) => s + r[k], 0);
      return {
        agent,
        totals: {
          assigned: sum("assigned"),
          delivered: sum("delivered"),
          cancelled: sum("cancelled"),
          onDutyMinutes: sum("onDutyMinutes"),
          cashCollected: sum("cashCollected"),
          cashReceived: sum("cashReceived"),
          openingBalance: opening,
          closingBalance: balance,
        },
        currentBalance: await cashBalance(outletId, agent.id),
        days: rows,
      };
    }),
  );
  res.json({ from: range.from, to: range.to, partners: result });
});

/** One partner's day as a timeline: duty, each delivery step, cash collected, handovers, problems. */
deliveryRouter.get("/partners/:agentId/timeline", requirePermission("delivery:manage"), async (req, res) => {
  const outletId = req.outletId!;
  const agentId = param(req, "agentId");
  const agent = await assertPartner(outletId, agentId);
  const date = typeof req.query.date === "string" ? req.query.date : undefined;
  const range = await localRange(outletId, date, date);
  const window = { gte: range.start, lt: range.end };
  const [attendance, deliveries, payments, handovers, issues] = await Promise.all([
    prisma.staffAttendance.findMany({ where: { userId: agentId, status: { in: ["PRESENT", "HALF_DAY"] }, OR: [{ clockInAt: window }, { clockOutAt: window }] } }),
    prisma.delivery.findMany({
      where: { outletId, agentId, OR: [{ assignedAt: window }, { acceptedAt: window }, { pickedAt: window }, { deliveredAt: window }] },
      include: { order: { select: { invoiceNumber: true, grandTotal: true } } },
    }),
    prisma.payment.findMany({
      where: { collectedById: agentId, status: "SUCCESS", confirmedAt: window, order: { outletId } },
      select: { amount: true, mode: true, confirmedAt: true, order: { select: { invoiceNumber: true } } },
    }),
    prisma.deliveryCashHandover.findMany({ where: { outletId, agentId, receivedAt: window } }),
    prisma.auditLog.findMany({ where: { action: "delivery.issue", userId: agentId, createdAt: window }, select: { createdAt: true, entityId: true, meta: true } }),
  ]);
  const receivers = await prisma.user.findMany({ where: { id: { in: [...new Set(handovers.map((h) => h.receivedById))] } }, select: { id: true, name: true } });
  type Ev = { at: Date; type: string; title: string; detail?: string; amount?: number };
  const ev: Ev[] = [];
  for (const a of attendance) {
    ev.push({ at: a.clockInAt, type: "CLOCK_IN", title: "Clocked in", detail: a.lateByMinutes ? `${a.lateByMinutes} min late` : undefined });
    if (a.clockOutAt) ev.push({ at: a.clockOutAt, type: "CLOCK_OUT", title: "Clocked out", detail: a.workedMinutes != null ? `${Math.floor(a.workedMinutes / 60)}h ${a.workedMinutes % 60}m on duty` : undefined });
  }
  for (const d of deliveries) {
    const label = `${d.order.invoiceNumber} · ${d.customerName}`;
    if (d.assignedAt) ev.push({ at: d.assignedAt, type: "ASSIGNED", title: "Delivery assigned", detail: `${label}${d.cod ? " · COD" : ""}` });
    if (d.acceptedAt) ev.push({ at: d.acceptedAt, type: "ACCEPTED", title: "Accepted", detail: label });
    if (d.pickedAt) ev.push({ at: d.pickedAt, type: "PICKED", title: "Out for delivery", detail: label });
    if (d.deliveredAt) ev.push({ at: d.deliveredAt, type: "DELIVERED", title: "Delivered", detail: `${label} · ${d.address}` });
  }
  for (const p of payments) ev.push({ at: p.confirmedAt!, type: "COLLECTED", title: `${p.mode === "CASH" ? "Cash" : p.mode} collected`, detail: p.order.invoiceNumber, amount: p.amount });
  for (const h of handovers) ev.push({ at: h.receivedAt, type: "HANDOVER", title: "Cash handed over", detail: [receivers.find((r) => r.id === h.receivedById)?.name, h.note].filter(Boolean).join(" · "), amount: h.amount });
  for (const i of issues) ev.push({ at: i.createdAt, type: "ISSUE", title: "Problem reported", detail: String((i.meta as { reason?: string } | null)?.reason ?? "") });
  ev.sort((a, b) => a.at.getTime() - b.at.getTime());
  res.json({
    agent,
    date: range.from,
    openingBalance: await cashBalance(outletId, agentId, range.start),
    closingBalance: await cashBalance(outletId, agentId, range.end),
    events: ev,
  });
});

function canSee(req: Request, d: { agentId: string | null }) {
  if (userCan(req, "delivery:manage")) return true;
  return userCan(req, "delivery:own") && d.agentId === req.user!.id;
}

deliveryRouter.get("/:id", managerOrPartner, async (req, res) => {
  const d = await findDelivery(param(req, "id"), req.outletId!);
  if (!canSee(req, d)) throw forbidden();
  res.json({ ...withExtras(d), customerMessage: await customerLink(d) });
});

deliveryRouter.patch("/:id/assign", requirePermission("delivery:manage"), async (req, res) => {
  const { agentId, force } = parse(deliveryAssignSchema, req.body);
  const outletId = req.outletId!;
  const d = await findDelivery(param(req, "id"), outletId);
  if (d.status === "DELIVERED" || d.status === "CANCELLED") throw conflict(`Delivery is ${d.status.toLowerCase()}`);
  if (agentId && agentId !== d.agentId) {
    const check = await canTakeOrder(outletId, agentId);
    if (!check.partner) throw badRequest("Delivery agent not found in this outlet");
    if (!check.ok) {
      const manager = ["OUTLET_MANAGER", "BUSINESS_OWNER", "SUPER_ADMIN"].includes(req.user!.role);
      if (!manager || !force) {
        throw new HttpError(409, `${check.partner.name} can't take this order: ${check.reason}`, { code: "PARTNER_UNAVAILABLE", reason: check.reason, canForce: manager });
      }
    }
  }
  const updated = await prisma.delivery.update({
    where: { id: d.id },
    data: { agentId, assignedAt: agentId ? new Date() : null },
    include,
  });
  await audit(req, d.agentId ? "delivery.reassign" : "delivery.assign", "Delivery", d.id, { from: d.agentId, to: agentId });
  if (agentId) await notify([agentId], "New delivery assigned", `${d.order.invoiceNumber} · ${d.customerName} · ${d.address}`, "delivery");
  if (d.agentId && d.agentId !== agentId) await notify([d.agentId], "Delivery reassigned", `${d.order.invoiceNumber} was moved to another agent`, "delivery");
  emitToOutlet(outletId, "delivery:updated", updated);
  res.json(withExtras(updated));
});

deliveryRouter.patch("/:id/status", managerOrPartner, async (req, res) => {
  const { status, note } = parse(deliveryStatusSchema, req.body);
  const outletId = req.outletId!;
  const d = await findDelivery(param(req, "id"), outletId);
  const manager = userCan(req, "delivery:manage");
  if (!manager) {
    if (!userCan(req, "delivery:own") || d.agentId !== req.user!.id) throw forbidden("Not your delivery");
    if (status === "CANCELLED") throw forbidden("Ask the outlet to cancel a delivery");
  }
  if (!canTransitionDelivery(d.status, status)) throw badRequest(`Cannot move delivery from ${d.status} to ${status}`);
  if (status === "OUT_FOR_DELIVERY" && !d.agentId) throw badRequest("Assign an agent before dispatch");
  if (d.order.status === "CANCELLED" && status !== "CANCELLED") throw conflict("Order was cancelled");
  if (status === "DELIVERED") {
    const due = d.order.status === "OPEN" ? d.order.grandTotal - amountPaid(d.order) : 0;
    // Partners confirm cash with POST /:id/complete; a manager marking it delivered records the
    // cash against the assigned partner, so it is never lost from their cash to hand over.
    if (due > 0 && !manager) {
      throw new HttpError(409, `Collect ₹${(due / 100).toFixed(2)} from the customer before marking delivered`, { code: "COLLECT_PAYMENT", amountDue: due });
    }
    return res.json(await completeDelivery(req, d));
  }
  const now = new Date();
  // Picking up an order means the partner leaves on a run (no new orders until they're back).
  if (status === "OUT_FOR_DELIVERY" && d.agentId) await startRun(prisma, d.agentId);
  const updated = await prisma.delivery.update({
    where: { id: d.id },
    data: {
      status,
      ...(status === "ACCEPTED" && { acceptedAt: now }),
      ...(status === "OUT_FOR_DELIVERY" && { pickedAt: now }),
      ...(note && { notes: [d.notes, `${status}: ${note}`].filter(Boolean).join("\n") }),
    },
    include,
  });
  await audit(req, "delivery.status", "Delivery", d.id, { from: d.status, to: status, note: note ?? null });
  if (status === "CANCELLED" && updated.agentId) lastLocation.delete(updated.agentId);
  emitToOutlet(outletId, "delivery:updated", updated);
  if (status === "CANCELLED") {
    const ids = (await outletManagers(outletId)).filter((id) => id !== req.user!.id);
    await notify(ids, "Delivery cancelled", `${d.order.invoiceNumber} · ${d.customerName}`, "delivery");
  }
  res.json({ ...withExtras(updated), customerMessage: await customerLink(updated, { autoSend: true }) });
});

/** Only the assigned partner (or a manager on their behalf) may act on a delivery's money. */
function assertMyDeliveryEarly(req: Request, d: { agentId: string | null }) {
  const manager = userCan(req, "delivery:manage");
  if (!manager && d.agentId !== req.user!.id) throw forbidden("Not your delivery");
  return manager;
}

/**
 * One tap at the door. COD / unpaid → the partner confirms they collected the
 * amount due in cash (recorded against them, adds to cash to hand over);
 * already paid → simply delivered. Then the delivery is marked DELIVERED.
 */
deliveryRouter.post("/:id/complete", managerOrPartner, async (req, res) => {
  const { cashCollected } = parse(z.object({ cashCollected: z.number().int().nonnegative().optional() }), req.body ?? {});
  const d = await findDelivery(param(req, "id"), req.outletId!);
  const manager = assertMyDeliveryEarly(req, d);
  if (d.status === "PENDING" && !manager) throw conflict("Accept the delivery first");
  res.json(await completeDelivery(req, d, cashCollected));
});

/**
 * Mark delivered; any amount still due is recorded as CASH collected by the
 * assigned partner (COD), so it shows up in their cash to hand over.
 * `expected` guards against the amount changing after the partner saw it.
 */
async function completeDelivery(req: Request, d: Awaited<ReturnType<typeof findDelivery>>, expected?: number) {
  const outletId = d.outletId;
  if (!canTransitionDelivery(d.status, "DELIVERED")) throw conflict(`Delivery is ${d.status.toLowerCase()}`);
  if (d.order.status === "CANCELLED") throw conflict("Order was cancelled");
  const due = d.order.status === "OPEN" ? Math.max(0, d.order.grandTotal - amountPaid(d.order)) : 0;
  if (expected !== undefined && expected !== due) {
    throw conflict(`The amount due changed to ₹${(due / 100).toFixed(2)} — refresh and try again`);
  }
  const collectorId = d.agentId ?? req.user!.id;
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    if (d.agentId) await startRun(tx, d.agentId);
    if (due > 0) {
      await tx.payment.updateMany({ where: { orderId: d.order.id, status: "PENDING" }, data: { status: "FAILED" } });
      await tx.payment.create({
        data: { orderId: d.order.id, mode: "CASH", amount: due, status: "SUCCESS", confirmedAt: now, collectedById: collectorId, reference: d.cod ? "COD" : "Collected at door" },
      });
      await settleIfPaid(d.order.id, tx);
    }
    await tx.delivery.update({
      where: { id: d.id },
      data: { status: "DELIVERED", deliveredAt: now, ...(!d.acceptedAt && { acceptedAt: now }), ...(!d.pickedAt && { pickedAt: now }) },
    });
    await audit(req, "delivery.complete", "Delivery", d.id, { cashCollected: due, cod: d.cod, collectorId }, tx);
  });
  if (d.agentId) lastLocation.delete(d.agentId);
  const updated = await findDelivery(d.id, outletId);
  if (due > 0) emitToOutlet(outletId, "order:paid", { id: d.order.id, invoiceNumber: d.order.invoiceNumber });
  emitToOutlet(outletId, "delivery:updated", updated);
  const managers = (await outletManagers(outletId)).filter((id) => id !== req.user!.id);
  await notify(managers, "Delivery delivered", `${d.order.invoiceNumber} · ${d.customerName}${due ? ` · ₹${(due / 100).toFixed(2)} cash collected` : ""}`, "delivery");
  if (due > 0) void cashBalance(outletId, collectorId).then((bal) => alertPartnerCash(outletId, collectorId, bal));
  // The partner is free again: hand them any delivery that is waiting.
  assignWaitingDeliveries(outletId).catch((e) => console.error("[delivery] auto-assign failed", e));
  return { ...withExtras(updated), cashCollected: due, customerMessage: await customerLink(updated, { autoSend: true }) };
}

function assertMyDelivery(req: Request, d: { agentId: string | null }) {
  const manager = userCan(req, "delivery:manage");
  if (!manager && d.agentId !== req.user!.id) throw forbidden("Not your delivery");
  return manager;
}

/**
 * Payment received at the door: cash, GPay/UPI (customer paid to the outlet's
 * UPI — enter the UTR) or card. Recorded against the partner who collected it.
 */
deliveryRouter.post("/:id/collect", managerOrPartner, async (req, res) => {
  const { payments } = parse(deliveryCollectSchema, req.body);
  const outletId = req.outletId!;
  const d = await findDelivery(param(req, "id"), outletId);
  assertMyDelivery(req, d);
  if (d.status === "CANCELLED") throw conflict("Delivery is cancelled");
  if (d.order.status !== "OPEN") throw conflict(d.order.status === "PAID" ? "This order is already paid" : "Order was cancelled");
  const balance = d.order.grandTotal - amountPaid(d.order);
  const total = payments.reduce((s, p) => s + p.amount, 0);
  if (total > balance) throw badRequest(`Amount ₹${(total / 100).toFixed(2)} is more than the ₹${(balance / 100).toFixed(2)} due`);
  const collectorId = d.agentId ?? req.user!.id;
  const paid = await prisma.$transaction(async (tx) => {
    await tx.payment.updateMany({ where: { orderId: d.order.id, mode: "UPI", status: "PENDING" }, data: { status: "FAILED" } });
    await tx.payment.createMany({
      data: payments.map((p) => ({
        orderId: d.order.id,
        mode: p.mode,
        amount: p.amount,
        reference: p.reference,
        status: "SUCCESS" as const,
        confirmedAt: new Date(),
        collectedById: collectorId,
      })),
    });
    await audit(req, "delivery.collect", "Delivery", d.id, { payments, collectorId }, tx);
    return settleIfPaid(d.order.id, tx);
  });
  const updated = await findDelivery(d.id, outletId);
  if (paid) emitToOutlet(outletId, "order:paid", { id: d.order.id, invoiceNumber: d.order.invoiceNumber });
  emitToOutlet(outletId, "delivery:updated", updated);
  res.json({ ...withExtras(updated), paid });
});

/** Show a UPI QR (GPay/PhonePe/Paytm) for the amount due, at the customer's door. */
deliveryRouter.post("/:id/upi-qr", managerOrPartner, async (req, res) => {
  const d = await findDelivery(param(req, "id"), req.outletId!);
  assertMyDelivery(req, d);
  if (d.order.status !== "OPEN") throw conflict("Nothing to collect on this order");
  const due = d.order.grandTotal - amountPaid(d.order);
  if (due <= 0) throw conflict("Nothing to collect on this order");
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: req.outletId } });
  await prisma.payment.updateMany({ where: { orderId: d.order.id, mode: "UPI", status: "PENDING" }, data: { status: "FAILED" } });
  const qr = await createUpiQr({ amount: due, orderId: d.order.id, invoiceNumber: d.order.invoiceNumber, payeeName: outlet.name, vpa: outlet.upiVpa });
  const payment = await prisma.payment.create({
    data: {
      orderId: d.order.id,
      mode: "UPI",
      amount: due,
      status: "PENDING",
      gatewayRef: qr.gatewayRef,
      qrPayload: qr.qrPayload,
      collectedById: d.agentId ?? req.user!.id,
    },
  });
  res.status(201).json({ paymentId: payment.id, amount: due, ...qr });
});

/** Partner confirms the customer's UPI payment arrived (no gateway webhook / mock mode). */
deliveryRouter.post("/:id/upi-qr/:paymentId/confirm", managerOrPartner, async (req, res) => {
  const outletId = req.outletId!;
  const d = await findDelivery(param(req, "id"), outletId);
  assertMyDelivery(req, d);
  const payment = d.order.payments.find((p) => p.id === param(req, "paymentId"));
  if (!payment || payment.status !== "PENDING") throw notFound("Pending UPI payment");
  const reference = typeof req.body?.reference === "string" ? String(req.body.reference).slice(0, 100) : undefined;
  const paid = await prisma.$transaction(async (tx) => {
    await tx.payment.update({ where: { id: payment.id }, data: { status: "SUCCESS", confirmedAt: new Date(), reference } });
    await audit(req, "delivery.upi_confirm", "Delivery", d.id, { paymentId: payment.id, reference: reference ?? null }, tx);
    return settleIfPaid(d.order.id, tx);
  });
  const updated = await findDelivery(d.id, outletId);
  if (paid) emitToOutlet(outletId, "order:paid", { id: d.order.id, invoiceNumber: d.order.invoiceNumber });
  emitToOutlet(outletId, "delivery:updated", updated);
  res.json({ ...withExtras(updated), paid });
});

const ISSUE_LABELS = {
  CUSTOMER_UNREACHABLE: "Customer not reachable",
  WRONG_ADDRESS: "Wrong / incomplete address",
  CUSTOMER_REFUSED: "Customer refused the order",
  VEHICLE_PROBLEM: "Vehicle problem",
  OTHER: "Other problem",
} as const;

/** Partner reports a problem (customer unreachable, wrong address…) — the outlet decides what to do. */
deliveryRouter.post("/:id/issue", managerOrPartner, async (req, res) => {
  const { reason, note } = parse(deliveryIssueSchema, req.body);
  const outletId = req.outletId!;
  const d = await findDelivery(param(req, "id"), outletId);
  assertMyDelivery(req, d);
  if (!ACTIVE.includes(d.status)) throw conflict(`Delivery is ${d.status.toLowerCase()}`);
  const text = `${ISSUE_LABELS[reason]}${note ? ` — ${note}` : ""}`;
  const updated = await prisma.delivery.update({
    where: { id: d.id },
    data: { notes: [d.notes, `ISSUE: ${text}`].filter(Boolean).join("\n") },
    include,
  });
  await audit(req, "delivery.issue", "Delivery", d.id, { reason, note: note ?? null });
  const managers = (await outletManagers(outletId)).filter((id) => id !== req.user!.id);
  await notify(managers, `Delivery problem: ${d.order.invoiceNumber}`, `${req.user!.name}: ${text} (${d.customerName})`, "delivery");
  emitToOutlet(outletId, "delivery:updated", updated);
  res.json(withExtras(updated));
});

/** Agent live location → broadcast to the outlet (kept in memory only). */
deliveryRouter.post("/:id/location", requirePermission("delivery:own"), async (req, res) => {
  const { lat, lng } = parse(deliveryLocationSchema, req.body);
  const outletId = req.outletId!;
  const d = await findDelivery(param(req, "id"), outletId);
  if (d.agentId !== req.user!.id) throw forbidden("Not your delivery");
  if (!ACTIVE.includes(d.status)) throw conflict(`Delivery is ${d.status.toLowerCase()}`);
  const loc = { lat, lng, at: new Date().toISOString(), deliveryId: d.id, outletId };
  lastLocation.set(req.user!.id, loc);
  void prisma.user.update({ where: { id: req.user!.id }, data: { lastLat: lat, lastLng: lng, lastLocationAt: new Date() } }).catch(() => {});
  const remainingKm =
    d.latitude != null && d.longitude != null
      ? Math.round((distanceMeters({ latitude: lat, longitude: lng }, { latitude: d.latitude, longitude: d.longitude }) / 1000) * 100) / 100
      : null;
  emitToOutlet(outletId, "delivery:location", { agentId: req.user!.id, ...loc, remainingKm });
  res.json({ ok: true, remainingKm });
});
