import { Router } from "express";
import type { Offer, Prisma } from "@prisma/client";
import { z } from "zod";
import {
  couponCreateSchema,
  couponUpdateSchema,
  couponValidateSchema,
  formatINR,
  OFFER_TYPES,
  offerCreateSchema,
  offerUpdateSchema,
} from "@canavo/shared";
import { prisma } from "../db";
import { audit } from "../lib/audit";
import { badRequest, conflict, notFound, param, parse } from "../lib/http";
import { isValidYmd, startOfLocalDay } from "../lib/time";
import { authenticate, requireOutlet, requirePermission, requireModule } from "../middleware/auth";
import { activeOffers, couponAmount, couponError, offerConfigError } from "../services/promotions";
import { emitToOutlet } from "../realtime";
import { requireBusinessId } from "../lib/tenant";

export const offersRouter = Router();
offersRouter.use(authenticate, requireOutlet, requireModule("OFFERS"));

const toDate = (v: string | null | undefined) => (v === undefined ? undefined : v === null ? null : new Date(v));

// ---------- Human-readable offer summaries (POS display) ----------
/** Plain-language summary of each offer (staff screens and the public online ordering page). */
export async function describer() {
  const [items, cats] = await Promise.all([
    prisma.menuItem.findMany({ select: { id: true, name: true } }),
    prisma.menuCategory.findMany({ select: { id: true, name: true } }),
  ]);
  const itemName = new Map(items.map((i) => [i.id, i.name]));
  const catName = new Map(cats.map((c) => [c.id, c.name]));
  const target = (t?: { menuItemIds?: string[]; categoryIds?: string[] }) => {
    const names = [
      ...(t?.menuItemIds ?? []).map((id) => itemName.get(id) ?? "item"),
      ...(t?.categoryIds ?? []).map((id) => catName.get(id) ?? "category"),
    ];
    return names.length ? names.join(", ") : "all items";
  };
  const off = (type: string, value: number) => (type === "PERCENT" ? `${value}% off` : `${formatINR(value)} off`);
  return (o: Offer): string => {
    const c = o.config as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    const when = o.startTime && o.endTime ? ` (${o.startTime}–${o.endTime})` : "";
    try {
      switch (o.type) {
        case "HAPPY_HOUR":
        case "ITEM_DISCOUNT":
          return `${off(c.discountType, c.value)}${c.discountType === "FLAT" ? " each" : ""} on ${target(c.target)}${when}`;
        case "BUY_X_GET_Y":
          return `Buy ${c.buy.quantity} ${target(c.buy)}, get ${c.get.quantity} ${target(c.get)} ${
            (c.getDiscountPercent ?? 100) >= 100 ? "free" : `${c.getDiscountPercent}% off`
          }${when}`;
        case "COMBO":
          return `${(c.items as { menuItemId: string; quantity: number }[])
            .map((i) => `${i.quantity > 1 ? `${i.quantity}× ` : ""}${itemName.get(i.menuItemId) ?? "item"}`)
            .join(" + ")} for ${formatINR(c.price)}${when}`;
        case "BILL_DISCOUNT":
          return `${off(c.discountType, c.value)} on bills over ${formatINR(c.minOrder ?? 0)}${
            c.maxDiscount ? ` (max ${formatINR(c.maxDiscount)})` : ""
          }${when}`;
      }
    } catch {
      /* malformed config */
    }
    return o.name;
  };
}

// ---------- Offers ----------
offersRouter.get("/", requirePermission("offer:manage"), async (req, res) => {
  const q = parse(
    z.object({ type: z.enum(OFFER_TYPES).optional(), active: z.enum(["0", "1"]).optional() }),
    req.query,
  );
  const offers = await prisma.offer.findMany({
    where: { ...(q.type && { type: q.type }), ...(q.active && { active: q.active === "1" }) },
    orderBy: [{ active: "desc" }, { priority: "desc" }, { createdAt: "desc" }],
  });
  const describe = await describer();
  res.json(offers.map((o) => ({ ...o, summary: describe(o) })));
});

/** Offers live right now at this outlet (POS banner). */
offersRouter.get("/active", requirePermission("order:create"), async (req, res) => {
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: req.outletId }, select: { timezone: true } });
  const now = new Date();
  const offers = await activeOffers(req.outletId!, now, outlet.timezone);
  const describe = await describer();
  const full = await prisma.offer.findMany({ where: { id: { in: offers.map((o) => o.id) } } });
  const byId = new Map(full.map((o) => [o.id, o]));
  res.json({
    at: now.toISOString(),
    offers: offers.map((o) => {
      const row = byId.get(o.id)!;
      return {
        id: o.id, name: o.name, type: o.type, priority: o.priority, config: o.config,
        startTime: o.startTime, endTime: o.endTime, endsAt: o.endsAt, summary: describe(row),
      };
    }),
  });
});

// ---------- Coupons (before /:id) ----------
offersRouter.get("/coupons", requirePermission("offer:manage"), async (req, res) => {
  const q = parse(z.object({ search: z.string().optional(), active: z.enum(["0", "1"]).optional() }), req.query);
  res.json(
    await prisma.coupon.findMany({
      where: {
        ...(q.search && { code: { contains: q.search.toUpperCase() } }),
        ...(q.active && { active: q.active === "1" }),
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    }),
  );
});

offersRouter.post("/coupons/validate", requirePermission("order:create"), async (req, res) => {
  const body = parse(couponValidateSchema, req.body);
  const coupon = await prisma.coupon.findFirst({ where: { code: body.code } });
  const customer = body.customerPhone ? await prisma.customer.findFirst({ where: { phone: body.customerPhone } }) : null;
  if (customer?.blocked) throw badRequest("Customer is blocked");
  const customerUses =
    coupon && customer ? await prisma.couponRedemption.count({ where: { couponId: coupon.id, customerId: customer.id } }) : 0;
  const err = couponError(coupon, { at: new Date(), subtotal: body.subtotal, hasCustomer: Boolean(body.customerPhone), customerUses, customerId: customer?.id });
  if (err || !coupon) throw badRequest(err ?? "Invalid coupon code");
  const estimatedDiscount = couponAmount(coupon, body.subtotal);
  res.json({
    valid: true,
    code: coupon.code,
    description: coupon.description,
    discountType: coupon.discountType,
    value: coupon.value,
    maxDiscount: coupon.maxDiscount,
    minOrder: coupon.minOrder,
    combinable: coupon.combinable,
    estimatedDiscount,
    message: `${coupon.code}: ${formatINR(estimatedDiscount)} off (final amount is computed on the pre-tax bill)`,
  });
});

offersRouter.get("/coupons/report", requirePermission("offer:manage"), async (req, res) => {
  const q = parse(
    z.object({
      from: z.string().refine(isValidYmd, "Use a real date (YYYY-MM-DD)").optional(),
      to: z.string().refine(isValidYmd, "Use a real date (YYYY-MM-DD)").optional(),
    }),
    req.query,
  );
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: req.outletId }, select: { timezone: true } });
  const createdAt: Prisma.DateTimeFilter = {};
  if (q.from) createdAt.gte = startOfLocalDay(q.from, outlet.timezone);
  if (q.to) createdAt.lt = new Date(startOfLocalDay(q.to, outlet.timezone).getTime() + 86_400_000);
  const redemptions = await prisma.couponRedemption.findMany({
    where: { ...((q.from || q.to) && { createdAt }) },
    include: { coupon: { select: { id: true, code: true, description: true, active: true, usageLimit: true, usedCount: true } } },
  });
  const orders = await prisma.order.findMany({
    where: { id: { in: redemptions.map((r) => r.orderId) }, outletId: req.outletId },
    select: { id: true, grandTotal: true, status: true },
  });
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const report = new Map<
    string,
    { couponId: string; code: string; description: string; active: boolean; usageLimit: number | null; usedCount: number; redemptions: number; discount: number; sales: number; customers: Set<string> }
  >();
  for (const r of redemptions) {
    const o = orderById.get(r.orderId);
    if (!o || o.status === "CANCELLED") continue;
    const e =
      report.get(r.couponId) ??
      { couponId: r.coupon.id, code: r.coupon.code, description: r.coupon.description, active: r.coupon.active, usageLimit: r.coupon.usageLimit, usedCount: r.coupon.usedCount, redemptions: 0, discount: 0, sales: 0, customers: new Set<string>() };
    e.redemptions++;
    e.discount += r.amount;
    e.sales += o.grandTotal;
    if (r.customerId) e.customers.add(r.customerId);
    report.set(r.couponId, e);
  }
  const rows = [...report.values()]
    .map(({ customers, ...e }) => ({ ...e, uniqueCustomers: customers.size }))
    .sort((a, b) => b.redemptions - a.redemptions);
  res.json({
    from: q.from ?? null,
    to: q.to ?? null,
    rows,
    totals: {
      redemptions: rows.reduce((s, r) => s + r.redemptions, 0),
      discount: rows.reduce((s, r) => s + r.discount, 0),
      sales: rows.reduce((s, r) => s + r.sales, 0),
    },
  });
});

offersRouter.post("/coupons", requirePermission("offer:manage"), async (req, res) => {
  const data = parse(couponCreateSchema, req.body);
  if (await prisma.coupon.findFirst({ where: { code: data.code } })) throw conflict(`Coupon ${data.code} already exists`);
  const coupon = await prisma.coupon.create({
    data: { ...data, startsAt: toDate(data.startsAt), expiresAt: toDate(data.expiresAt), businessId: requireBusinessId() },
  });
  await audit(req, "coupon.create", "Coupon", coupon.id, { code: coupon.code });
  res.status(201).json(coupon);
});

offersRouter.get("/coupons/:id", requirePermission("offer:manage"), async (req, res) => {
  const coupon = await prisma.coupon.findUnique({
    where: { id: param(req, "id") },
    include: { redemptions: { orderBy: { createdAt: "desc" }, take: 100 } },
  });
  if (!coupon) throw notFound("Coupon");
  res.json(coupon);
});

offersRouter.patch("/coupons/:id", requirePermission("offer:manage"), async (req, res) => {
  const id = param(req, "id");
  const existing = await prisma.coupon.findUnique({ where: { id } });
  if (!existing) throw notFound("Coupon");
  const data = parse(couponUpdateSchema, req.body);
  const type = data.discountType ?? existing.discountType;
  const value = data.value ?? existing.value;
  if (type === "PERCENT" && value > 100) throw badRequest("Percent must be ≤ 100");
  if (data.code && data.code !== existing.code && (await prisma.coupon.findFirst({ where: { code: data.code } }))) {
    throw conflict(`Coupon ${data.code} already exists`);
  }
  const coupon = await prisma.coupon.update({
    where: { id },
    data: { ...data, startsAt: toDate(data.startsAt), expiresAt: toDate(data.expiresAt), businessId: requireBusinessId() },
  });
  await audit(req, "coupon.update", "Coupon", id, { changes: Object.keys(data) });
  res.json(coupon);
});

offersRouter.delete("/coupons/:id", requirePermission("offer:manage"), async (req, res) => {
  const id = param(req, "id");
  const coupon = await prisma.coupon.findUnique({ where: { id }, include: { _count: { select: { redemptions: true } } } });
  if (!coupon) throw notFound("Coupon");
  if (coupon._count.redemptions > 0) {
    // Keep the redemption history; just switch it off.
    await prisma.coupon.update({ where: { id }, data: { active: false } });
    await audit(req, "coupon.deactivate", "Coupon", id, { code: coupon.code });
    return res.json({ deleted: false, deactivated: true });
  }
  await prisma.coupon.delete({ where: { id } });
  await audit(req, "coupon.delete", "Coupon", id, { code: coupon.code });
  res.status(204).end();
});

// ---------- Offer CRUD ----------
/** outletIds must be outlets of this business (RLS-scoped count); empty = all outlets. */
async function assertOwnOutlets(ids: string[] | undefined) {
  if (!ids?.length) return;
  const unique = [...new Set(ids)];
  if ((await prisma.outlet.count({ where: { id: { in: unique } } })) !== unique.length) throw badRequest("Unknown outlet in outletIds");
}

offersRouter.post("/", requirePermission("offer:manage"), async (req, res) => {
  const data = parse(offerCreateSchema, req.body);
  await assertOwnOutlets(data.outletIds);
  const offer = await prisma.offer.create({
    data: {
      ...data,
      businessId: requireBusinessId(),
      config: data.config as Prisma.InputJsonValue,
      startsAt: toDate(data.startsAt),
      endsAt: toDate(data.endsAt),
    },
  });
  await audit(req, "offer.create", "Offer", offer.id, { name: offer.name, type: offer.type });
  emitToOutlet(req.outletId!, "offers:changed", { id: offer.id });
  res.status(201).json(offer);
});

offersRouter.get("/:id", requirePermission("offer:manage"), async (req, res) => {
  const offer = await prisma.offer.findUnique({ where: { id: param(req, "id") } });
  if (!offer) throw notFound("Offer");
  const describe = await describer();
  res.json({ ...offer, summary: describe(offer) });
});

offersRouter.patch("/:id", requirePermission("offer:manage"), async (req, res) => {
  const id = param(req, "id");
  const existing = await prisma.offer.findUnique({ where: { id } });
  if (!existing) throw notFound("Offer");
  const data = parse(offerUpdateSchema, req.body);
  await assertOwnOutlets(data.outletIds);
  const type = data.type ?? existing.type;
  const config = data.config !== undefined ? data.config : existing.config;
  const err = offerConfigError(type, config);
  if (err) throw badRequest(`Invalid ${type} config: ${err}`);
  const startTime = data.startTime !== undefined ? data.startTime : existing.startTime;
  const endTime = data.endTime !== undefined ? data.endTime : existing.endTime;
  if (Boolean(startTime) !== Boolean(endTime)) throw badRequest("Give both startTime and endTime");
  const offer = await prisma.offer.update({
    where: { id },
    data: {
      ...data,
      config: data.config === undefined ? undefined : (data.config as Prisma.InputJsonValue),
      startsAt: toDate(data.startsAt),
      endsAt: toDate(data.endsAt),
    },
  });
  await audit(req, "offer.update", "Offer", id, { changes: Object.keys(data) });
  emitToOutlet(req.outletId!, "offers:changed", { id });
  res.json(offer);
});

offersRouter.post("/:id/toggle", requirePermission("offer:manage"), async (req, res) => {
  const id = param(req, "id");
  const existing = await prisma.offer.findUnique({ where: { id } });
  if (!existing) throw notFound("Offer");
  const body = parse(z.object({ active: z.boolean().optional() }), req.body ?? {});
  const offer = await prisma.offer.update({ where: { id }, data: { active: body.active ?? !existing.active } });
  await audit(req, offer.active ? "offer.activate" : "offer.deactivate", "Offer", id);
  emitToOutlet(req.outletId!, "offers:changed", { id });
  res.json(offer);
});

offersRouter.delete("/:id", requirePermission("offer:manage"), async (req, res) => {
  const id = param(req, "id");
  const existing = await prisma.offer.findUnique({ where: { id } });
  if (!existing) throw notFound("Offer");
  await prisma.offer.delete({ where: { id } });
  await audit(req, "offer.delete", "Offer", id, { name: existing.name });
  emitToOutlet(req.outletId!, "offers:changed", { id });
  res.status(204).end();
});
