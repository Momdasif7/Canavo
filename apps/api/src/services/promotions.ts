import type { Prisma } from "@prisma/client";
import {
  formatINR,
  loyaltyConfigSchema,
  type BillDiscount,
  type LoyaltyConfig,
  type OrderCreateInput,
  totalTaxPercent,
  billDiscountConfigSchema,
} from "@canavo/shared";
import { prisma } from "../db";
import { resolveItemTax } from "./tax";
import { badRequest } from "../lib/http";
import { currentBusinessId, moduleEnabled, requireBusinessId } from "../lib/tenant";
import {
  couponAmount,
  couponError,
  evaluateBillOffer,
  evaluateLineOffers,
  isOfferActive,
  pointsToEarn,
  preTaxRemaining,
  redeemPoints,
  suggestFreeItems,
  tierForSpend,
  toPreTax,
  bestOffer,
  rankOffers,
  type BestOffer,
  type EngineLine,
  type EngineOffer,
  type FreeItemSuggestion,
  type TaxMode,
} from "./offer-engine";

export * from "./offer-engine";

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

/** One priced cart line, before tax. */
export interface PricingLine {
  menuItemId: string;
  variantId?: string;
  categoryId: string;
  name: string;
  /** Unit price incl. variant + add-ons (as on the menu; may be tax-inclusive) */
  unitPrice: number;
  quantity: number;
  /** Manual item discount from the cashier, paise for the whole line */
  manualDiscount: number;
}

export interface PricingContext {
  outletId: string;
  at: Date;
  timezone: string;
  input: OrderCreateInput;
  lines: PricingLine[];
}

export interface AppliedOffer {
  kind: "OFFER" | "COUPON" | "POINTS";
  id?: string;
  label: string;
  /** Discount value in paise — pre-tax (same basis as Order.discount / promoDiscount) */
  amount: number;
}

export interface PricingResult {
  /** Extra per-line discounts from promotions (same order as ctx.lines), paise */
  lineDiscounts: number[];
  /** Extra bill-level discounts (coupon, points, bill offers), applied after the manual discount */
  billDiscounts: BillDiscount[];
  applied: AppliedOffer[];
  couponId?: string;
  couponCode?: string;
  pointsRedeemed: number;
  customerId?: string;
}

// ---------------------------------------------------------------------------
// Loyalty config
// ---------------------------------------------------------------------------

/** Loyalty rules are stored per business (GLOBAL only as a platform-wide fallback). */
export const loyaltySetting = () => ({ scope: currentBusinessId() ?? "GLOBAL", key: "loyalty" });

/** Loyalty rules from the business's "loyalty" setting, with defaults for anything missing. */
export async function getLoyaltyConfig(db: Db = prisma): Promise<LoyaltyConfig> {
  const row = await db.setting.findUnique({ where: { scope_key: loyaltySetting() } });
  const stored = row?.value && typeof row.value === "object" && !Array.isArray(row.value) ? row.value : {};
  const parsed = loyaltyConfigSchema.safeParse(stored);
  return parsed.success ? parsed.data : loyaltyConfigSchema.parse({});
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

/** Offers active for the outlet at `at` (outlet timezone), highest priority first. */
export async function activeOffers(outletId: string, at: Date, timezone: string): Promise<EngineOffer[]> {
  const offers = await prisma.offer.findMany({
    where: {
      active: true,
      OR: [{ outletIds: { isEmpty: true } }, { outletIds: { has: outletId } }],
      AND: [
        { OR: [{ startsAt: null }, { startsAt: { lte: at } }] },
        { OR: [{ endsAt: null }, { endsAt: { gt: at } }] },
      ],
    },
    orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
  });
  return offers.filter((o) => isOfferActive(o, { outletId, at, timezone }));
}

/** categoryId → [itself, parent, grandparent…] */
async function categoryAncestry(): Promise<Map<string, string[]>> {
  const cats = await prisma.menuCategory.findMany({ select: { id: true, parentId: true } });
  const parent = new Map(cats.map((c) => [c.id, c.parentId]));
  const out = new Map<string, string[]>();
  for (const c of cats) {
    const chain: string[] = [];
    let cur: string | null | undefined = c.id;
    while (cur && !chain.includes(cur)) {
      chain.push(cur);
      cur = parent.get(cur);
    }
    out.set(c.id, chain);
  }
  return out;
}

export async function findCustomerByPhone(phone: string, db: Db = prisma) {
  return db.customer.findFirst({ where: { phone } });
}

/** Find or create a customer by phone; fills in the name if we didn't have one. */
export async function findOrCreateCustomer(phone: string, name: string | null | undefined, db: Db = prisma) {
  const existing = await db.customer.findFirst({ where: { phone } });
  if (existing) {
    if (!existing.name && name?.trim()) {
      return db.customer.update({ where: { id: existing.id }, data: { name: name.trim() } });
    }
    return existing;
  }
  return db.customer.upsert({
    where: { businessId_phone: { businessId: requireBusinessId(), phone } },
    create: { phone, name: name?.trim() || null, businessId: requireBusinessId() },
    update: {},
  });
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

export interface EvaluateOptions {
  /** Preview: never create customers or write anything */
  dryRun?: boolean;
}

export interface EvaluatedPromotions extends PricingResult {
  customer: Awaited<ReturnType<typeof findCustomerByPhone>>;
  /** Preview only: problems that would reject the real order (e.g. too many points) */
  warnings: string[];
  /** Free items the cart qualifies for but doesn't contain yet (Buy X Get Y) */
  suggestions: FreeItemSuggestion[];
  /** Phase 3.7: every offer / coupon checked and what it would save — "why this offer won" */
  comparison: OfferComparison[];
}

export interface OfferComparison {
  kind: "OFFER" | "COUPON";
  id: string;
  label: string;
  /** Pre-tax saving if applied alone */
  saving: number;
  applied: boolean;
  /** Why it was or wasn't applied */
  note: string;
}

/**
 * Evaluate offers, coupon and points for a cart.
 *
 * One offer per bill: of all active offers (item offers, Buy X Get Y, combos,
 * bill discounts) and a valid coupon, only the single one that saves the
 * customer the most is applied (ties: higher offer priority; a coupon wins a
 * tie because the customer asked for it). Loyalty points and the cashier's
 * manual discount still apply on top. Bill-level order: offer/coupon → points.
 */
export async function evaluatePromotions(ctx: PricingContext, opts: EvaluateOptions = {}): Promise<EvaluatedPromotions> {
  const { input } = ctx;
  const [outlet, items, ancestry, offers] = await Promise.all([
    prisma.outlet.findUniqueOrThrow({
      where: { id: ctx.outletId },
      select: { pricesIncludeTax: true, compositionScheme: true, gstEnabled: true, flatDiscountsIncludeTax: true },
    }),
    prisma.menuItem.findMany({
      where: { id: { in: [...new Set(ctx.lines.map((l) => l.menuItemId))] } },
      select: { id: true, gstRate: true, taxRateId: true },
    }),
    categoryAncestry(),
    moduleEnabled("OFFERS") ? activeOffers(ctx.outletId, ctx.at, ctx.timezone) : Promise.resolve([] as EngineOffer[]),
  ]);
  const mode: TaxMode = { pricesIncludeTax: outlet.pricesIncludeTax, compositionScheme: outlet.compositionScheme, taxEnabled: outlet.gstEnabled };
  // Pre-tax conversions strip the item's full composition (GST + cess + extras), as computeBill does.
  const taxes = await resolveItemTax(items);
  const rate = new Map(items.map((i) => [i.id, totalTaxPercent(taxes.get(i.id)!, input.interState)]));
  const gst = (i: number) => rate.get(ctx.lines[i].menuItemId) ?? 0;
  const lineDiscountBase = ctx.lines.map((l) => l.manualDiscount);

  // Customer (profiles, points and khata need the Customers module; the phone is still kept on the bill)
  const crm = moduleEnabled("CUSTOMERS");
  let customer = crm && input.customerPhone ? await findCustomerByPhone(input.customerPhone) : null;
  if (customer?.blocked) throw badRequest("Customer is blocked");
  if (crm && input.customerPhone && !opts.dryRun) {
    customer = await findOrCreateCustomer(input.customerPhone, input.customerName);
  }

  // 1. The best single offer
  const engineLines = ctx.lines.map((l) => ({
    menuItemId: l.menuItemId,
    categoryIds: ancestry.get(l.categoryId) ?? [l.categoryId],
    unitPrice: l.unitPrice,
    quantity: l.quantity,
    manualDiscount: l.manualDiscount,
  }));
  const rates = (ls: EngineLine[]) => ls.map((l) => rate.get(l.menuItemId) ?? 0);
  const ranked = rankOffers(offers, engineLines, rates(engineLines), mode, input.discount);
  const best = ranked[0] ?? null;

  // Free items (Buy X Get Y) are suggested only when, with the item added, that
  // offer would be the one applied — so the POS never shows FREE for an item the bill charges.
  const suggestions: FreeItemSuggestion[] = [];
  const rawSuggestions = suggestFreeItems(offers, engineLines);
  if (rawSuggestions.length) {
    const extra = await prisma.menuItem.findMany({
      where: { id: { in: rawSuggestions.map((x) => x.menuItemId) } },
      select: { id: true, categoryId: true, price: true, gstRate: true, taxRateId: true, variants: { select: { price: true }, orderBy: { price: "asc" }, take: 1 } },
    });
    const extraTax = await resolveItemTax(extra.filter((e) => !rate.has(e.id)));
    for (const e of extra) if (!rate.has(e.id)) rate.set(e.id, totalTaxPercent(extraTax.get(e.id)!, input.interState));
    for (const sug of rawSuggestions) {
      const item = extra.find((e) => e.id === sug.menuItemId);
      if (!item) continue;
      const withFree = [
        ...engineLines,
        { menuItemId: item.id, categoryIds: ancestry.get(item.categoryId) ?? [item.categoryId], unitPrice: item.variants[0]?.price ?? item.price, quantity: sug.quantity, manualDiscount: 0 },
      ];
      if (bestOffer(offers, withFree, rates(withFree), mode, input.discount)?.offer.id === sug.offerId) suggestions.push(sug);
    }
  }

  const lineDiscounts = ctx.lines.map(() => 0);
  const applied: AppliedOffer[] = [];
  const billDiscounts: BillDiscount[] = [];
  const billLines = ctx.lines.map((l, i) => ({ unitPrice: l.unitPrice, quantity: l.quantity, gstRate: gst(i), lineDiscount: lineDiscountBase[i] }));
  const menuSubtotal = ctx.lines.reduce((s, l) => s + Math.max(0, l.unitPrice * l.quantity - l.manualDiscount), 0);
  const remainingBase = preTaxRemaining(billLines, mode, input.discount ? [input.discount] : []);
  const useOffer = (b: BestOffer) => {
    if (b.lineDiscounts) b.lineDiscounts.forEach((d, i) => (lineDiscounts[i] += d));
    else {
      // D1: a ₹-off bill offer is GST-inclusive when the outlet chose that; a %-off saving is already pre-tax.
      const flat = billDiscountConfigSchema.safeParse(b.offer.config).data?.discountType === "FLAT";
      billDiscounts.push({ type: "FLAT", value: b.saving, includesTax: flat && outlet.flatDiscountsIncludeTax });
    }
    applied.push({ kind: "OFFER", id: b.offer.id, label: b.offer.name, amount: b.saving });
  };
  const remaining = () =>
    preTaxRemaining(
      ctx.lines.map((l, i) => ({ ...billLines[i], lineDiscount: lineDiscountBase[i] + lineDiscounts[i] })),
      mode,
      [...(input.discount ? [input.discount] : []), ...billDiscounts],
    );

  const comparison: OfferComparison[] = [];
  let couponSaving: number | null = null;

  // 3. Coupon
  let couponId: string | undefined;
  let couponCode: string | undefined;
  // A preview reports coupon / points problems as warnings, so the cashier still sees correct totals.
  const warnings: string[] = [];
  if (input.couponCode && !moduleEnabled("OFFERS")) {
    if (!opts.dryRun) throw badRequest("Coupons are not enabled for this business");
    warnings.push("Coupons are not enabled for this business");
  } else if (input.couponCode) {
    const coupon = await prisma.coupon.findFirst({ where: { code: input.couponCode.trim().toUpperCase() } });
    const customerUses =
      coupon && customer ? await prisma.couponRedemption.count({ where: { couponId: coupon.id, customerId: customer.id } }) : 0;
    const err = couponError(coupon, {
      at: ctx.at,
      subtotal: menuSubtotal,
      hasCustomer: Boolean(input.customerPhone),
      customerUses,
      customerId: customer?.id,
    });
    if (err || !coupon) {
      if (!opts.dryRun) throw badRequest(err ?? "Invalid coupon code");
      warnings.push(err ?? "Invalid coupon code");
    } else {
      const amount = couponAmount(coupon, remainingBase);
      couponSaving = amount;
      comparison.push({ kind: "COUPON", id: coupon.id, label: `Coupon ${coupon.code}`, saving: amount, applied: !(best && best.saving > amount), note: "" });
      if (best && best.saving > amount) {
        warnings.push(`Coupon ${coupon.code} not applied — only one offer per bill, and “${best.offer.name}” saves more`);
      } else {
        couponId = coupon.id;
        couponCode = coupon.code;
        billDiscounts.push({ type: "FLAT", value: amount, includesTax: coupon.discountType === "FLAT" && outlet.flatDiscountsIncludeTax });
        applied.push({ kind: "COUPON", id: coupon.id, label: `Coupon ${coupon.code}`, amount });
      }
    }
  }
  if (!couponId && best) useOffer(best);

  // Phase 3.7: combinable offers apply on top, on items no other offer has discounted yet.
  const appliedIds = new Set(applied.filter((a) => a.kind === "OFFER").map((a) => a.id));
  for (const cand of ranked) {
    if (!cand.offer.combinable || appliedIds.has(cand.offer.id)) continue;
    if (cand.lineDiscounts) {
      const free = engineLines.map((l, i) => (lineDiscounts[i] > 0 ? { ...l, quantity: 0 } : l));
      const r = evaluateLineOffers([cand.offer], free);
      const before = remaining();
      r.lineDiscounts.forEach((d, i) => (lineDiscounts[i] += d));
      const saving = before - remaining();
      if (saving > 0) {
        applied.push({ kind: "OFFER", id: cand.offer.id, label: cand.offer.name, amount: saving });
        appliedIds.add(cand.offer.id);
      }
    } else {
      const b = evaluateBillOffer([cand.offer], menuSubtotal, remaining());
      if (b) {
        const flat = billDiscountConfigSchema.safeParse(cand.offer.config).data?.discountType === "FLAT";
        billDiscounts.push({ type: "FLAT", value: b.amount, includesTax: flat && outlet.flatDiscountsIncludeTax });
        applied.push({ kind: "OFFER", id: cand.offer.id, label: cand.offer.name, amount: b.amount });
        appliedIds.add(cand.offer.id);
      }
    }
  }
  // Why each offer was or wasn't used (shown on the POS).
  const winner = couponId ? `the coupon (${couponCode})` : best ? `“${best.offer.name}”` : null;
  for (const c of ranked) {
    const on = appliedIds.has(c.offer.id);
    comparison.push({
      kind: "OFFER",
      id: c.offer.id,
      label: c.offer.name,
      saving: c.saving,
      applied: on,
      note: on ? (c === best && !couponId ? "Saves the most" : "Combines with other offers") : c.offer.combinable ? "Its items already have a discount" : `One offer per bill: ${winner} saves more`,
    });
  }
  for (const c of comparison) if (c.kind === "COUPON") c.note = c.applied ? (best && couponSaving !== null && best.saving === couponSaving ? "Same saving as the best offer; the customer's coupon wins a tie" : "Saves the most") : `One offer per bill: “${best?.offer.name}” saves more`;

  // 4. Points (a preview reports problems as warnings so the cart stays usable while editing)
  let pointsRedeemed = 0;
  if (input.redeemPoints && !crm) throw badRequest("Loyalty points are not enabled for this business");
  if (input.redeemPoints) {
    const cfg = await getLoyaltyConfig();
    const r = input.customerPhone
      ? redeemPoints(cfg, { balance: customer?.points ?? 0, requested: input.redeemPoints, remaining: remaining() })
      : ({ ok: false, error: "Redeeming points needs the customer's phone number" } as const);
    if (r.ok) {
      pointsRedeemed = r.points;
      billDiscounts.push({ type: "FLAT", value: r.value, includesTax: outlet.flatDiscountsIncludeTax });
      applied.push({ kind: "POINTS", label: `${r.points} loyalty points`, amount: r.value });
    } else if (opts.dryRun) warnings.push(r.error);
    else throw badRequest(r.error);
  }

  return {
    lineDiscounts,
    billDiscounts,
    applied,
    couponId,
    couponCode,
    pointsRedeemed,
    customerId: customer?.id,
    customer,
    warnings,
    suggestions,
    comparison: comparison.sort((a, b) => Number(b.applied) - Number(a.applied) || b.saving - a.saving),
  };
}

/**
 * Billing hook: evaluate active offers, coupon and points redemption for a
 * cart. Throws HttpError(400) for an invalid coupon / insufficient points /
 * blocked customer. Creates the customer when a new phone number is given.
 */
export async function applyPromotions(ctx: PricingContext): Promise<PricingResult> {
  const { customer: _c, warnings: _w, suggestions: _s, comparison: _cmp, ...result } = await evaluatePromotions(ctx);
  return result;
}

// ---------------------------------------------------------------------------
// Order lifecycle hooks (all run inside the caller's transaction)
// ---------------------------------------------------------------------------

/** Inside the order tx after the order row exists: record coupon redemption and points redemption. */
export async function onOrderCreated(tx: Tx, orderId: string, pricing: PricingResult): Promise<void> {
  if (pricing.couponId) {
    const n = await tx.$executeRaw`
      UPDATE "Coupon" SET "usedCount" = "usedCount" + 1
      WHERE id = ${pricing.couponId} AND ("usageLimit" IS NULL OR "usedCount" < "usageLimit")`;
    if (n === 0) throw badRequest(`Coupon ${pricing.couponCode} has reached its usage limit`);
    await tx.couponRedemption.create({
      data: {
        couponId: pricing.couponId,
        orderId,
        customerId: pricing.customerId,
        amount: pricing.applied.find((a) => a.kind === "COUPON")?.amount ?? 0,
      },
    });
  }
  if (pricing.pointsRedeemed > 0) {
    if (!pricing.customerId) throw badRequest("Redeeming points needs a customer");
    const r = await tx.customer.updateMany({
      where: { id: pricing.customerId, points: { gte: pricing.pointsRedeemed } },
      data: { points: { decrement: pricing.pointsRedeemed } },
    });
    if (r.count === 0) throw badRequest("Not enough loyalty points");
    const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { invoiceNumber: true } });
    await tx.loyaltyTransaction.create({
      data: {
        customerId: pricing.customerId,
        orderId,
        type: "REDEEM",
        points: -pricing.pointsRedeemed,
        note: `Redeemed on ${order.invoiceNumber}`,
      },
    });
  }
}

/** Link (or create) the order's customer from its phone number when billing didn't. */
async function ensureOrderCustomer(
  tx: Tx,
  order: { id: string; customerId: string | null; customerPhone: string | null; customerName: string | null },
) {
  if (order.customerId) return tx.customer.findUnique({ where: { id: order.customerId } });
  if (!order.customerPhone || !/^[6-9]\d{9}$/.test(order.customerPhone)) return null;
  const customer = await findOrCreateCustomer(order.customerPhone, order.customerName, tx);
  await tx.order.update({ where: { id: order.id }, data: { customerId: customer.id } });
  return customer;
}

/** Inside the payment tx when an order becomes PAID: earn points, update customer spend/visits/tier. */
export async function onOrderPaid(tx: Tx, orderId: string): Promise<void> {
  if (!moduleEnabled("CUSTOMERS")) return;
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { id: true, customerId: true, customerPhone: true, customerName: true, grandTotal: true, invoiceNumber: true },
  });
  const customer = await ensureOrderCustomer(tx, order);
  if (!customer) return;
  if (await tx.loyaltyTransaction.findFirst({ where: { orderId, type: "EARN" }, select: { id: true } })) return;

  const cfg = await getLoyaltyConfig(tx);
  const points = customer.blocked ? 0 : pointsToEarn(order.grandTotal, customer.tier, cfg);
  const totalSpend = customer.totalSpend + order.grandTotal;
  await tx.customer.update({
    where: { id: customer.id },
    data: {
      totalSpend,
      visitCount: { increment: 1 },
      lastVisitAt: new Date(),
      tier: tierForSpend(totalSpend, cfg),
      points: { increment: points },
    },
  });
  if (points > 0) {
    await tx.loyaltyTransaction.create({
      data: { customerId: customer.id, orderId, type: "EARN", points, note: `Earned on ${order.invoiceNumber}` },
    });
  }
}

/** Inside the payment tx after payments are recorded: KHATA → debit the customer's khata ledger. */
export async function onPaymentsRecorded(
  tx: Tx,
  orderId: string,
  payments: { mode: string; amount: number }[],
  userId?: string,
): Promise<void> {
  const khata = payments.filter((p) => p.mode === "KHATA").reduce((s, p) => s + p.amount, 0);
  if (khata <= 0) return;
  if (!moduleEnabled("CUSTOMERS")) throw badRequest("Khata (credit) needs the Customers module");
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { id: true, outletId: true, invoiceNumber: true, customerId: true, customerPhone: true, customerName: true },
  });
  const found = await ensureOrderCustomer(tx, order);
  if (!found) throw badRequest("Khata (credit) needs a customer phone number on the bill");
  // Lock the customer and re-read the balance, so two bills put on credit at the same moment
  // can't both pass the limit check (QA BUG-049).
  await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${found.id} FOR UPDATE`;
  const customer = await tx.customer.findUniqueOrThrow({ where: { id: found.id } });
  if (customer.blocked) throw badRequest("Customer is blocked");
  if (customer.khataLimit > 0 && customer.khataBalance + khata > customer.khataLimit) {
    throw badRequest(
      `Khata limit exceeded: outstanding ${formatINR(customer.khataBalance)}, limit ${formatINR(customer.khataLimit)} — ` +
        `at most ${formatINR(Math.max(0, customer.khataLimit - customer.khataBalance))} more on credit`,
    );
  }
  await tx.khataTransaction.create({
    data: {
      customerId: customer.id,
      outletId: order.outletId,
      orderId,
      type: "DEBIT",
      amount: khata,
      mode: "KHATA",
      note: `Bill ${order.invoiceNumber}`,
      createdById: userId,
    },
  });
  await tx.customer.update({ where: { id: customer.id }, data: { khataBalance: { increment: khata } } });
}

/** Inside the cancel tx: reverse points, coupon usage, khata debits and spend. */
export async function onOrderCancelled(tx: Tx, orderId: string): Promise<void> {
  const order = await tx.order.findUniqueOrThrow({
    where: { id: orderId },
    select: { id: true, customerId: true, grandTotal: true, paidAt: true, invoiceNumber: true, outletId: true },
  });

  // Coupon
  const redemption = await tx.couponRedemption.findUnique({ where: { orderId } });
  if (redemption) {
    await tx.couponRedemption.delete({ where: { id: redemption.id } });
    await tx.coupon.updateMany({ where: { id: redemption.couponId, usedCount: { gt: 0 } }, data: { usedCount: { decrement: 1 } } });
  }

  // Khata: net debit still outstanding for this bill
  const khataTxns = await tx.khataTransaction.findMany({ where: { orderId } });
  const byCustomer = new Map<string, number>();
  for (const t of khataTxns) {
    byCustomer.set(t.customerId, (byCustomer.get(t.customerId) ?? 0) + (t.type === "DEBIT" ? t.amount : -t.amount));
  }
  for (const [customerId, net] of byCustomer) {
    if (net <= 0) continue;
    await tx.khataTransaction.create({
      data: { customerId, outletId: order.outletId, orderId, type: "CREDIT", amount: net, mode: "REVERSAL", note: "Bill cancelled" },
    });
    await tx.customer.update({ where: { id: customerId }, data: { khataBalance: { decrement: net } } });
  }

  // Loyalty: reverse redeemed (give back) and earned (take back) points
  const txns = await tx.loyaltyTransaction.findMany({ where: { orderId } });
  const customerIds = new Set(txns.map((t) => t.customerId));
  for (const customerId of customerIds) {
    const mine = txns.filter((t) => t.customerId === customerId);
    const sum = (type: string) => mine.filter((t) => t.type === type).reduce((s, t) => s + t.points, 0);
    if (mine.some((t) => t.type === "REVERSE")) continue; // already reversed
    const redeemed = -sum("REDEEM");
    const earned = sum("EARN");
    if (redeemed > 0) {
      await tx.loyaltyTransaction.create({
        data: { customerId, orderId, type: "REVERSE", points: redeemed, note: `Redeemed points returned — ${order.invoiceNumber} cancelled` },
      });
      await tx.customer.update({ where: { id: customerId }, data: { points: { increment: redeemed } } });
    }
    if (earned > 0) {
      const c = await tx.customer.findUniqueOrThrow({ where: { id: customerId }, select: { points: true } });
      const take = Math.min(earned, c.points);
      if (take > 0) {
        await tx.loyaltyTransaction.create({
          data: {
            customerId,
            orderId,
            type: "REVERSE",
            points: -take,
            note: `Earned points reversed — ${order.invoiceNumber} cancelled${take < earned ? ` (${earned - take} already used)` : ""}`,
          },
        });
        await tx.customer.update({ where: { id: customerId }, data: { points: { decrement: take } } });
      }
    }
  }

  // Spend / visits, if the bill had been paid and counted
  if (order.paidAt && order.customerId) {
    const cfg = await getLoyaltyConfig(tx);
    const c = await tx.customer.findUnique({ where: { id: order.customerId } });
    if (c) {
      const totalSpend = Math.max(0, c.totalSpend - order.grandTotal);
      await tx.customer.update({
        where: { id: c.id },
        data: { totalSpend, visitCount: Math.max(0, c.visitCount - 1), tier: tierForSpend(totalSpend, cfg) },
      });
    }
  }
}
