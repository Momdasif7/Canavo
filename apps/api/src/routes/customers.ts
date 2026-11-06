import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import {
  customerBlockSchema,
  customerCreateSchema,
  customerListQuerySchema,
  customerUpdateSchema,
  formatINR,
  indianPhone,
  khataSettleSchema,
  loyaltyAdjustSchema,
  loyaltyConfigSchema,
  promotionPreviewSchema,
  type CustomerLookup,
} from "@canavo/shared";
import { prisma } from "../db";
import { audit } from "../lib/audit";
import { badRequest, conflict, forbidden, HttpError, notFound, param, parse } from "../lib/http";
import { authenticate, requireOutlet, requirePermission, requireModule } from "../middleware/auth";
import { CRM_TEMPLATES, sendCustomerMessage } from "../services/customer-messages";
import { getLoyaltyConfig, loyaltySetting, redeemableNow } from "../services/promotions";
import { previewPromotions } from "../services/promotion-preview";
import { requireBusinessId } from "../lib/tenant";

export const customersRouter = Router();
customersRouter.use(authenticate, requireOutlet, (req, res, next) =>
  // The POS promotions preview is part of billing; everything else needs the Customers module.
  req.path === "/preview-promotions" ? requireModule("BILLING")(req, res, next) : requireModule("CUSTOMERS")(req, res, next),
);

const pageQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

async function getCustomer(id: string) {
  const c = await prisma.customer.findUnique({ where: { id } });
  if (!c) throw notFound("Customer");
  return c;
}

// ---------- List / search ----------
customersRouter.get("/", requirePermission("customer:view"), async (req, res) => {
  const q = parse(customerListQuerySchema, req.query);
  const where: Prisma.CustomerWhereInput = {
    ...(q.search && {
      OR: [{ phone: { contains: q.search } }, { name: { contains: q.search, mode: "insensitive" } }],
    }),
    ...(q.tier && { tier: q.tier }),
    ...(q.hasKhata === "1" && { khataBalance: { gt: 0 } }),
    ...(q.hasKhata === "0" && { khataBalance: { lte: 0 } }),
    ...(q.blocked && { blocked: q.blocked === "1" }),
  };
  const orderBy: Prisma.CustomerOrderByWithRelationInput[] = {
    spend: [{ totalSpend: "desc" as const }],
    recent: [{ lastVisitAt: { sort: "desc" as const, nulls: "last" as const } }, { createdAt: "desc" as const }],
    points: [{ points: "desc" as const }],
    khata: [{ khataBalance: "desc" as const }],
    name: [{ name: { sort: "asc" as const, nulls: "last" as const } }],
  }[q.sort];
  const [items, total] = await Promise.all([
    prisma.customer.findMany({ where, orderBy, skip: (q.page - 1) * q.limit, take: q.limit }),
    prisma.customer.count({ where }),
  ]);
  res.json({ items, total, page: q.page, limit: q.limit });
});

// ---------- POS lookup ----------
customersRouter.get("/lookup", requirePermission("customer:view"), async (req, res) => {
  const { phone } = parse(z.object({ phone: indianPhone }), req.query);
  const [c, cfg] = await Promise.all([prisma.customer.findFirst({ where: { phone } }), getLoyaltyConfig()]);
  const loyalty = {
    pointValuePaise: cfg.pointValuePaise,
    minRedeemPoints: cfg.minRedeemPoints,
    maxRedeemPercent: cfg.maxRedeemPercent,
  };
  if (!c) return res.json({ found: false, phone, loyalty } satisfies CustomerLookup & { loyalty: unknown });
  const redeemable = redeemableNow(c.points, cfg);
  res.json({
    found: true,
    id: c.id,
    phone: c.phone,
    name: c.name,
    tier: c.tier,
    points: c.points,
    redeemablePoints: redeemable,
    redeemableValue: redeemable * cfg.pointValuePaise,
    khataBalance: c.khataBalance,
    khataLimit: c.khataLimit,
    blocked: c.blocked,
    visitCount: c.visitCount,
    lastVisitAt: c.lastVisitAt?.toISOString() ?? null,
    loyalty,
  } satisfies CustomerLookup & { loyalty: unknown });
});

// ---------- Khata outstanding (outlet) ----------
customersRouter.get("/khata/outstanding", requirePermission("customer:view"), async (req, res) => {
  const rows = await prisma.khataTransaction.groupBy({
    by: ["customerId", "type"],
    where: { outletId: req.outletId },
    _sum: { amount: true },
    _max: { createdAt: true },
  });
  const net = new Map<string, { due: number; lastTxnAt: Date | null; lastDebitAt: Date | null }>();
  for (const r of rows) {
    const e = net.get(r.customerId) ?? { due: 0, lastTxnAt: null, lastDebitAt: null };
    e.due += (r.type === "DEBIT" ? 1 : -1) * (r._sum.amount ?? 0);
    const at = r._max.createdAt;
    if (at && (!e.lastTxnAt || at > e.lastTxnAt)) e.lastTxnAt = at;
    if (r.type === "DEBIT") e.lastDebitAt = at;
    net.set(r.customerId, e);
  }
  const customers = await prisma.customer.findMany({
    where: { id: { in: [...net.keys()] }, khataBalance: { gt: 0 } },
    select: { id: true, name: true, phone: true, khataBalance: true, khataLimit: true, blocked: true, tier: true },
  });
  const items = customers
    .map((c) => {
      const e = net.get(c.id)!;
      return { ...c, outletDue: Math.max(0, e.due), lastTxnAt: e.lastTxnAt, lastDebitAt: e.lastDebitAt };
    })
    .filter((c) => c.outletDue > 0)
    .sort((a, b) => b.outletDue - a.outletDue);
  res.json({
    items,
    totalOutstanding: items.reduce((s, c) => s + c.outletDue, 0),
    customers: items.length,
  });
});

// ---------- Loyalty config ----------
customersRouter.get("/loyalty/config", requirePermission("customer:manage"), async (_req, res) => {
  res.json(await getLoyaltyConfig());
});

customersRouter.put("/loyalty/config", requirePermission("customer:manage"), async (req, res) => {
  if (!["SUPER_ADMIN", "BUSINESS_OWNER", "OUTLET_MANAGER"].includes(req.user!.role)) throw forbidden();
  const current = await getLoyaltyConfig();
  const body = parse(loyaltyConfigSchema.partial(), req.body);
  const next = parse(loyaltyConfigSchema, { ...current, ...body });
  const t = next.tierThresholds;
  if (!(t.SILVER <= t.GOLD && t.GOLD <= t.PLATINUM)) throw badRequest("Tier thresholds must be Silver ≤ Gold ≤ Platinum");
  await prisma.setting.upsert({
    where: { scope_key: loyaltySetting() },
    create: { ...loyaltySetting(), value: next },
    update: { value: next },
  });
  await audit(req, "loyalty.config.update", "Setting", `${loyaltySetting().scope}:loyalty`, { before: current, after: next });
  res.json(next);
});

// ---------- Live promotions preview for POS ----------
customersRouter.post("/preview-promotions", requirePermission("order:create"), async (req, res) => {
  res.json(await previewPromotions(req, parse(promotionPreviewSchema, req.body)));
});

// ---------- Create ----------
customersRouter.post("/", requirePermission("customer:view"), async (req, res) => {
  const data = parse(customerCreateSchema, req.body);
  if (data.khataLimit && !["SUPER_ADMIN", "BUSINESS_OWNER", "OUTLET_MANAGER"].includes(req.user!.role)) {
    throw forbidden("Only managers can set a khata limit");
  }
  const existing = await prisma.customer.findFirst({ where: { phone: data.phone } });
  if (existing) throw new HttpError(409, `Customer with phone ${data.phone} already exists`, { id: existing.id });
  const customer = await prisma.customer.create({ data: { ...data, email: data.email || null, businessId: requireBusinessId() } });
  await audit(req, "customer.create", "Customer", customer.id);
  res.status(201).json(customer);
});

// ---------- Profile ----------
customersRouter.get("/:id", requirePermission("customer:view"), async (req, res) => {
  const c = await getCustomer(param(req, "id"));
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: req.outletId }, select: { timezone: true } });
  const [recentOrders, orderStats, loyalty, khata, fav, heat, cfg, coupons] = await Promise.all([
    prisma.order.findMany({
      where: { customerId: c.id },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true, invoiceNumber: true, outletId: true, createdAt: true, status: true, orderType: true,
        grandTotal: true, promoDiscount: true, couponCode: true, pointsRedeemed: true,
        // Not `_count`: Prisma counts a relation by grouping the WHOLE OrderItem table (~0.4 s at 1M
        // lines, QA Phase 7); loading the 10 bills' line ids is an index lookup.
        items: { select: { id: true } },
      },
    }).then((rows) => rows.map(({ items, ...o }) => ({ ...o, _count: { items: items.length } }))),
    prisma.order.groupBy({ by: ["status"], where: { customerId: c.id }, _count: true, _sum: { grandTotal: true } }),
    prisma.loyaltyTransaction.findMany({ where: { customerId: c.id }, orderBy: { createdAt: "desc" }, take: 30 }),
    prisma.khataTransaction.findMany({ where: { customerId: c.id }, orderBy: { createdAt: "desc" }, take: 30 }),
    prisma.orderItem.groupBy({
      by: ["menuItemId"],
      where: { order: { customerId: c.id, status: "PAID" } },
      _sum: { quantity: true, total: true },
      _count: true,
      orderBy: { _sum: { quantity: "desc" } },
      take: 5,
    }),
    prisma.$queryRaw<{ dow: number; hour: number; n: bigint }[]>`
      SELECT EXTRACT(DOW FROM ("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${outlet.timezone})::int AS dow,
             EXTRACT(HOUR FROM ("createdAt" AT TIME ZONE 'UTC') AT TIME ZONE ${outlet.timezone})::int AS hour,
             COUNT(*) AS n
      FROM "Order" WHERE "customerId" = ${c.id} AND status = 'PAID'
      GROUP BY 1, 2`,
    getLoyaltyConfig(),
    prisma.couponRedemption.findMany({
      where: { customerId: c.id },
      orderBy: { createdAt: "desc" },
      take: 10,
      include: { coupon: { select: { code: true } } },
    }),
  ]);
  const names = new Map(
    (await prisma.menuItem.findMany({ where: { id: { in: fav.map((f) => f.menuItemId) } }, select: { id: true, name: true } })).map(
      (m) => [m.id, m.name],
    ),
  );
  const heatmap = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  for (const h of heat) heatmap[h.dow][h.hour] = Number(h.n);
  const paid = orderStats.find((s) => s.status === "PAID");
  const firstOrder = await prisma.order.findFirst({ where: { customerId: c.id }, orderBy: { createdAt: "asc" }, select: { createdAt: true } });
  const t = cfg.tierThresholds;
  const nextTier =
    c.tier === "PLATINUM" ? null : c.totalSpend < t.SILVER ? { tier: "SILVER", at: t.SILVER } : c.totalSpend < t.GOLD ? { tier: "GOLD", at: t.GOLD } : { tier: "PLATINUM", at: t.PLATINUM };
  res.json({
    customer: c,
    stats: {
      totalSpend: c.totalSpend,
      visitCount: c.visitCount,
      avgBill: c.visitCount ? Math.round(c.totalSpend / c.visitCount) : 0,
      lastVisitAt: c.lastVisitAt,
      firstVisitAt: firstOrder?.createdAt ?? null,
      paidOrders: paid?._count ?? 0,
      cancelledOrders: orderStats.find((s) => s.status === "CANCELLED")?._count ?? 0,
      openOrders: orderStats.find((s) => s.status === "OPEN")?._count ?? 0,
      points: c.points,
      pointsValue: c.points * cfg.pointValuePaise,
      redeemablePoints: redeemableNow(c.points, cfg),
      tier: c.tier,
      nextTier: nextTier && { ...nextTier, remaining: nextTier.at - c.totalSpend },
      khataBalance: c.khataBalance,
      khataLimit: c.khataLimit,
    },
    recentOrders,
    loyaltyLedger: loyalty,
    khataLedger: khata,
    couponRedemptions: coupons.map((r) => ({ code: r.coupon.code, orderId: r.orderId, amount: r.amount, createdAt: r.createdAt })),
    favouriteItems: fav.map((f) => ({
      menuItemId: f.menuItemId,
      name: names.get(f.menuItemId) ?? "Item",
      quantity: f._sum.quantity ?? 0,
      orders: f._count,
      amount: f._sum.total ?? 0,
    })),
    /** heatmap[weekday 0=Sun][hour 0–23] = paid visits, outlet timezone */
    visitHeatmap: heatmap,
  });
});

customersRouter.get("/:id/loyalty", requirePermission("customer:view"), async (req, res) => {
  const c = await getCustomer(param(req, "id"));
  const q = parse(pageQuery, req.query);
  const [items, total] = await Promise.all([
    prisma.loyaltyTransaction.findMany({
      where: { customerId: c.id },
      orderBy: { createdAt: "desc" },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.loyaltyTransaction.count({ where: { customerId: c.id } }),
  ]);
  res.json({ items, total, page: q.page, balance: c.points });
});

customersRouter.get("/:id/khata", requirePermission("customer:view"), async (req, res) => {
  const c = await getCustomer(param(req, "id"));
  const q = parse(pageQuery, req.query);
  const [items, total] = await Promise.all([
    prisma.khataTransaction.findMany({
      where: { customerId: c.id },
      orderBy: { createdAt: "desc" },
      skip: (q.page - 1) * q.limit,
      take: q.limit,
    }),
    prisma.khataTransaction.count({ where: { customerId: c.id } }),
  ]);
  res.json({ items, total, page: q.page, balance: c.khataBalance, limit: c.khataLimit });
});

// ---------- Update / block ----------
customersRouter.patch("/:id", requirePermission("customer:manage"), async (req, res) => {
  const c = await getCustomer(param(req, "id"));
  const data = parse(customerUpdateSchema, req.body);
  if (data.phone && data.phone !== c.phone && (await prisma.customer.findFirst({ where: { phone: data.phone } }))) {
    throw conflict(`Another customer already uses ${data.phone}`);
  }
  const updated = await prisma.customer.update({
    where: { id: c.id },
    data: { ...data, ...(data.email !== undefined && { email: data.email || null }) },
  });
  await audit(req, "customer.update", "Customer", c.id, { changes: Object.keys(data) });
  res.json(updated);
});

customersRouter.post("/:id/block", requirePermission("customer:manage"), async (req, res) => {
  const c = await getCustomer(param(req, "id"));
  const { blocked, reason } = parse(customerBlockSchema, req.body);
  const updated = await prisma.customer.update({ where: { id: c.id }, data: { blocked } });
  await audit(req, blocked ? "customer.block" : "customer.unblock", "Customer", c.id, { reason: reason ?? null });
  res.json(updated);
});

// ---------- Loyalty manual adjust ----------
customersRouter.post("/:id/loyalty/adjust", requirePermission("customer:manage"), async (req, res) => {
  const id = param(req, "id");
  const { points, note } = parse(loyaltyAdjustSchema, req.body);
  const result = await prisma.$transaction(async (tx) => {
    const c = await tx.customer.findUnique({ where: { id } });
    if (!c) throw notFound("Customer");
    if (c.points + points < 0) throw badRequest(`Customer has only ${c.points} points`);
    // Compare-and-set: two deductions at the same moment used to both pass the check above and
    // leave the customer with negative points (QA Phase 7).
    const moved = await tx.customer.updateMany({ where: { id, ...(points < 0 && { points: { gte: -points } }) }, data: { points: { increment: points } } });
    if (!moved.count) throw badRequest(`Customer has fewer than ${-points} points now`);
    const txn = await tx.loyaltyTransaction.create({
      data: { customerId: id, type: "ADJUST", points, note: `${note} (by ${req.user!.name})`, createdById: req.user!.id },
    });
    const customer = await tx.customer.findUniqueOrThrow({ where: { id } });
    await audit(req, "loyalty.adjust", "Customer", id, { points, note, before: c.points, after: customer.points }, tx);
    return { customer, transaction: txn };
  });
  res.json(result);
});

// ---------- Khata settle / remind ----------
customersRouter.post("/:id/khata/settle", requirePermission("payment:collect"), async (req, res) => {
  const id = param(req, "id");
  const { amount, mode, note } = parse(khataSettleSchema, req.body);
  const result = await prisma.$transaction(async (tx) => {
    const c = await tx.customer.findUnique({ where: { id } });
    if (!c) throw notFound("Customer");
    if (c.khataBalance <= 0) throw badRequest("No outstanding khata balance");
    if (amount > c.khataBalance) throw badRequest(`Amount exceeds outstanding ${formatINR(c.khataBalance)}`);
    // Compare-and-set: two settlements of the full balance at once used to both pass the check
    // above — the cash was collected twice and the balance went negative (QA Phase 7).
    const moved = await tx.customer.updateMany({ where: { id, khataBalance: { gte: amount } }, data: { khataBalance: { decrement: amount } } });
    if (!moved.count) throw badRequest("The outstanding khata changed meanwhile — reload and try again");
    const txn = await tx.khataTransaction.create({
      data: {
        customerId: id,
        outletId: req.outletId!,
        type: "CREDIT",
        amount,
        mode,
        note: note ?? "Khata settlement",
        createdById: req.user!.id,
      },
    });
    const customer = await tx.customer.findUniqueOrThrow({ where: { id } });
    await audit(req, "khata.settle", "Customer", id, { amount, mode, balanceAfter: customer.khataBalance }, tx);
    return { customer, transaction: txn };
  });
  res.json(result);
});

customersRouter.post("/:id/khata/remind", requirePermission("customer:view"), async (req, res) => {
  const c = await getCustomer(param(req, "id"));
  if (c.khataBalance <= 0) throw badRequest("No outstanding khata balance");
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: req.outletId }, select: { name: true, upiVpa: true } });
  const amount = formatINR(c.khataBalance);
  const text =
    `Hi ${c.name ?? "there"}, this is a friendly reminder from ${outlet.name}: ${amount} is pending on your khata. ` +
    (outlet.upiVpa ? `You can pay via UPI to ${outlet.upiVpa} or at the counter. ` : "Please clear it at the counter. ") +
    "Thank you!";
  const result = await sendCustomerMessage({
    phone: c.phone,
    text,
    template: CRM_TEMPLATES.khataReminder,
    broadcast: `khata_${c.id}_${Date.now()}`,
    parameters: [
      { name: "name", value: c.name ?? "Customer" },
      { name: "outlet", value: outlet.name },
      { name: "amount", value: amount },
    ],
  });
  await audit(req, "khata.remind", "Customer", c.id, { balance: c.khataBalance, method: result.method });
  res.json({ ...result, balance: c.khataBalance, text });
});
