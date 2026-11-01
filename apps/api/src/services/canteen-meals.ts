import type { Request } from "express";
import { Prisma, type MealSlot, type MealSubscription } from "@prisma/client";
import {
  orderCreateSchema,
  type CanteenPreorderInput,
  type MealSubscriptionInput,
} from "@canavo/shared";
import { prisma } from "../db";
import { audit } from "../lib/audit";
import { HttpError, badRequest, conflict, notFound } from "../lib/http";
import { addDays, startOfLocalDay, zonedParts } from "../lib/time";
import { moduleEnabled } from "../lib/tenant";
import { userCan } from "../middleware/auth";
import { createOrder, settleIfPaid } from "./billing";
import { assertCashShiftOpen } from "./cash-shifts";
import { createCreditNote } from "./credit-notes";
import { computeConsumption, restoreStockForOrder } from "./inventory";
import { preorderCutoffAt, slotStartOn } from "./meal-slots";
import { onOrderCancelled, onPaymentsRecorded } from "./promotions";
import { onOrderCancelledService } from "./service-context";

/**
 * Phase 5.3 / 5.4 (CANTEEN): next-day pre-orders, the kitchen's production plan and prepaid
 * meal subscriptions. Everything here is a normal bill underneath (PRE_ORDER orders with a
 * meal slot), so GST, KOTs, stock and sales reports work as for any other bill.
 *
 * Subscriptions (GST): the plan is paid upfront on one ordinary tax invoice (meal × number of
 * meals), so GST is charged when the money is received. Each day's meal is then a zero-value
 * PRE_ORDER linked to the plan: the kitchen gets its KOT, the production plan counts it, and
 * no tax is charged twice. Cancelling refunds the unused meals by a credit note on the upfront
 * invoice, reversing their GST.
 */

/** 0 = Monday … 6 = Sunday for a YYYY-MM-DD date. */
export const weekdayOf = (date: string) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;

/** Customer phone for a bill (only a valid mobile number passes the bill's validation). */
const billPhone = (phone: string | null | undefined) => (phone && /^[6-9]\d{9}$/.test(phone) ? phone : undefined);

const dayRange = (date: string, tz: string) => ({ gte: startOfLocalDay(date, tz), lt: startOfLocalDay(addDays(date, 1), tz) });

/** A paid bill refunded in full no longer needs cooking. */
const fullyRefunded = (o: { grandTotal: number; refundedAmount: number }) => o.grandTotal > 0 && o.refundedAmount >= o.grandTotal;

async function outletOf(outletId: string) {
  return prisma.outlet.findUniqueOrThrow({ where: { id: outletId }, select: { id: true, timezone: true } });
}

async function slotOf(outletId: string, slotId: string) {
  const slot = await prisma.mealSlot.findFirst({ where: { id: slotId, outletId } });
  if (!slot) throw notFound("Meal slot");
  return slot;
}

// =====================================================================
// Pre-orders
// =====================================================================

/** Book meals for a date + slot. Refused after the cutoff (previous day) unless a manager overrides. */
export async function bookPreorder(req: Request, input: CanteenPreorderInput) {
  const outlet = await outletOf(req.outletId!);
  const slot = await slotOf(outlet.id, input.slotId);
  if (!slot.active) throw badRequest(`${slot.name} is switched off`);
  const cutoff = preorderCutoffAt(slot, input.date, outlet.timezone);
  if (!cutoff) throw badRequest(`${slot.name} doesn't take pre-orders`);
  const start = slotStartOn(slot, input.date, outlet.timezone);
  if (start.getTime() <= Date.now()) throw badRequest(`${slot.name} on ${input.date} has already started`);
  if (Date.now() >= cutoff.getTime()) {
    const canOverride = userCan(req, "canteen:manage");
    if (!input.override || !canOverride) {
      throw new HttpError(409, `Pre-orders for ${slot.name} on ${input.date} closed at ${slot.preorderCutoff} the day before.`, {
        code: "PREORDER_CLOSED",
        canOverride,
      });
    }
  }
  const { order } = await createOrder(
    req,
    orderCreateSchema.parse({
      orderType: "PRE_ORDER",
      items: input.items,
      customerName: input.customerName,
      customerPhone: input.customerPhone,
      notes: input.notes,
      scheduledFor: start.toISOString(),
      mealSlotId: slot.id,
    }),
  );
  if (input.override && Date.now() >= cutoff.getTime()) await audit(req, "canteen.preorder_after_cutoff", "Order", order.id, { slot: slot.name, date: input.date });
  return order;
}

/** Canteen pre-orders (booked and subscription meals) for a date, optionally one slot. */
export async function listPreorders(outletId: string, date: string, slotId?: string) {
  const outlet = await outletOf(outletId);
  const orders = await prisma.order.findMany({
    where: { outletId, orderType: "PRE_ORDER", mealSlotId: slotId ?? { not: null }, scheduledFor: dayRange(date, outlet.timezone) },
    include: { items: { select: { id: true, name: true, quantity: true, menuItemId: true } }, payments: { where: { status: "SUCCESS" }, select: { amount: true, mode: true } } },
    orderBy: [{ scheduledFor: "asc" }, { createdAt: "asc" }],
  });
  const meals = await prisma.mealSubscriptionMeal.findMany({ where: { orderId: { in: orders.map((o) => o.id) } }, select: { orderId: true, subscriptionId: true } });
  const bySub = new Map(meals.map((m) => [m.orderId, m.subscriptionId]));
  return orders.map((o) => ({
    id: o.id,
    invoiceNumber: o.invoiceNumber,
    mealSlotId: o.mealSlotId,
    scheduledFor: o.scheduledFor,
    customerName: o.customerName,
    customerPhone: o.customerPhone,
    notes: o.notes,
    status: o.status,
    grandTotal: o.grandTotal,
    amountPaid: o.payments.reduce((s, p) => s + p.amount, 0),
    refunded: fullyRefunded(o),
    servedAt: o.servedAt,
    subscriptionId: bySub.get(o.id) ?? null,
    items: o.items,
  }));
}

/**
 * Cancel a pre-order that hasn't been served. Unpaid (or zero-value subscription meals) are voided;
 * a paid one is refunded in full by credit note (the bill stays as issued) and its held KOT dropped.
 */
export async function cancelPreorder(req: Request, id: string, input: { reason: string; refundMode?: "CASH" | "UPI" | "CARD" | "KHATA" }) {
  const order = await prisma.order.findFirst({ where: { id, outletId: req.outletId!, orderType: "PRE_ORDER", mealSlotId: { not: null } }, include: { items: true } });
  if (!order) throw notFound("Pre-order");
  if (order.servedAt) throw conflict("This pre-order was already served");
  if (order.status === "CANCELLED" || fullyRefunded(order)) throw conflict("This pre-order is already cancelled");
  if (order.status === "PAID" && order.grandTotal > 0) {
    if (!input.refundMode) throw badRequest("This pre-order is paid: choose how to give the money back");
    await createCreditNote(req, order.id, {
      reason: "CUSTOMER_CHANGED_MIND",
      note: input.reason,
      refundMode: input.refundMode,
      items: order.items.map((i) => ({ orderItemId: i.id, quantity: i.quantity })),
      restock: false,
    });
    // Nothing to cook: drop the KOT the kitchen hasn't seen yet.
    await prisma.kotTicket.deleteMany({ where: { orderId: order.id, releaseAt: { gt: new Date() } } });
    return { id: order.id, refunded: true };
  }
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.order.updateMany({ where: { id: order.id, status: { not: "CANCELLED" }, servedAt: null }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: input.reason } });
    if (!count) throw conflict("This pre-order changed. Refresh and try again.");
    await onOrderCancelled(tx, order.id);
    await onOrderCancelledService(tx, order.id);
    await restoreStockForOrder(tx, order.id);
    await audit(req, "canteen.preorder_cancel", "Order", order.id, { reason: input.reason, invoiceNumber: order.invoiceNumber }, tx);
  });
  return { id: order.id, cancelled: true };
}

/** Hand over a pre-order at the counter (redeem). It must be for today and paid (subscription meals are). */
export async function servePreorder(req: Request, id: string) {
  const outlet = await outletOf(req.outletId!);
  const order = await prisma.order.findFirst({ where: { id, outletId: outlet.id, orderType: "PRE_ORDER", mealSlotId: { not: null } } });
  if (!order) throw notFound("Pre-order");
  if (order.status === "CANCELLED" || fullyRefunded(order)) throw conflict("This pre-order was cancelled");
  if (order.status !== "PAID") throw conflict("Collect the payment for this pre-order first");
  const today = zonedParts(new Date(), outlet.timezone).date;
  if (!order.scheduledFor || zonedParts(order.scheduledFor, outlet.timezone).date !== today) throw conflict("This pre-order is for another day");
  // Compare-and-set so two counters can't hand out the same meal.
  const { count } = await prisma.order.updateMany({ where: { id: order.id, servedAt: null }, data: { servedAt: new Date() } });
  if (!count) throw conflict("Already served");
  await audit(req, "canteen.preorder_serve", "Order", order.id, { invoiceNumber: order.invoiceNumber });
  return prisma.order.findUniqueOrThrow({ where: { id: order.id }, select: { id: true, servedAt: true, invoiceNumber: true } });
}

// =====================================================================
// Production plan
// =====================================================================

const WALK_IN_WEEKS = 4;

interface PlanLine {
  menuItemId: string;
  variantId: string | null;
  name: string;
  preorders: number;
  subscriptions: number;
  /** pre-orders + subscriptions: confirmed portions */
  confirmed: number;
  /** Average of the last 4 same weekdays' counter sales in this slot (shown separately) */
  expectedWalkIn: number;
}

/**
 * What the kitchen should make on `date`: per slot and item, confirmed portions (pre-orders +
 * subscription meals, including plans not yet turned into pre-orders), an expected walk-in
 * figure, and (with Inventory) the ingredients needed vs current stock.
 */
export async function productionPlan(outletId: string, date: string) {
  const outlet = await outletOf(outletId);
  const tz = outlet.timezone;
  const slots = await prisma.mealSlot.findMany({ where: { outletId, active: true }, orderBy: [{ sortOrder: "asc" }, { startTime: "asc" }] });
  const slotIds = slots.map((s) => s.id);
  const lines = new Map<string, PlanLine & { slotId: string }>();
  const line = (slotId: string, menuItemId: string, variantId: string | null, name: string) => {
    const key = `${slotId}|${menuItemId}|${variantId ?? ""}`;
    let l = lines.get(key);
    if (!l) lines.set(key, (l = { slotId, menuItemId, variantId, name, preorders: 0, subscriptions: 0, confirmed: 0, expectedWalkIn: 0 }));
    return l;
  };

  // Pre-orders for the day (booked + materialised subscription meals).
  const preorders = await prisma.order.findMany({
    where: { outletId, orderType: "PRE_ORDER", mealSlotId: { in: slotIds }, status: { not: "CANCELLED" }, scheduledFor: dayRange(date, tz) },
    select: { id: true, mealSlotId: true, grandTotal: true, refundedAmount: true, items: { select: { menuItemId: true, variantId: true, name: true, quantity: true } } },
  });
  const subMeals = new Set((await prisma.mealSubscriptionMeal.findMany({ where: { orderId: { in: preorders.map((o) => o.id) } }, select: { orderId: true } })).map((m) => m.orderId));
  for (const o of preorders) {
    if (fullyRefunded(o)) continue;
    for (const i of o.items) {
      const l = line(o.mealSlotId!, i.menuItemId, i.variantId, i.name);
      if (subMeals.has(o.id)) l.subscriptions += i.quantity;
      else l.preorders += i.quantity;
    }
  }

  // Subscriptions due that day that aren't pre-orders yet (before the cutoff run).
  const due = await prisma.mealSubscription.findMany({
    where: { outletId, slotId: { in: slotIds }, ...dueOn(date) },
    select: { slotId: true, menuItemId: true, menuItem: { select: { name: true } } },
  });
  for (const s of due) line(s.slotId, s.menuItemId, null, s.menuItem.name).subscriptions += 1;

  // Expected walk-ins: counter bills in the slot on the last 4 same weekdays, averaged.
  const past = Array.from({ length: WALK_IN_WEEKS }, (_, k) => dayRange(addDays(date, -7 * (k + 1)), tz));
  {
    const rows = await prisma.orderItem.findMany({
      where: { order: { outletId, mealSlotId: { in: slotIds }, orderType: { not: "PRE_ORDER" }, status: { not: "CANCELLED" }, OR: past.map((createdAt) => ({ createdAt })) } },
      select: { menuItemId: true, variantId: true, name: true, quantity: true, order: { select: { mealSlotId: true } } },
    });
    const sums = new Map<string, { slotId: string; menuItemId: string; variantId: string | null; name: string; qty: number }>();
    for (const r of rows) {
      const key = `${r.order.mealSlotId}|${r.menuItemId}|${r.variantId ?? ""}`;
      const s = sums.get(key) ?? { slotId: r.order.mealSlotId!, menuItemId: r.menuItemId, variantId: r.variantId, name: r.name, qty: 0 };
      s.qty += r.quantity;
      sums.set(key, s);
    }
    for (const s of sums.values()) {
      const avg = Math.round(s.qty / WALK_IN_WEEKS);
      if (avg > 0) line(s.slotId, s.menuItemId, s.variantId, s.name).expectedWalkIn = avg;
    }
  }
  for (const l of lines.values()) l.confirmed = l.preorders + l.subscriptions;

  const all = [...lines.values()];
  const result = slots.map((slot) => {
    const items = all.filter((l) => l.slotId === slot.id).sort((a, b) => b.confirmed - a.confirmed || a.name.localeCompare(b.name));
    return {
      slot: { id: slot.id, name: slot.name, startTime: slot.startTime, endTime: slot.endTime },
      items: items.map(({ slotId: _s, ...l }) => l),
      totals: {
        preorders: items.reduce((s, l) => s + l.preorders, 0),
        subscriptions: items.reduce((s, l) => s + l.subscriptions, 0),
        confirmed: items.reduce((s, l) => s + l.confirmed, 0),
        expectedWalkIn: items.reduce((s, l) => s + l.expectedWalkIn, 0),
      },
    };
  });

  // Ingredients for the whole day (stock is shared by the slots), from recipes.
  let ingredients: { inventoryItemId: string; name: string; unit: string; confirmed: number; withWalkIn: number; inStock: number; short: number }[] = [];
  if (moduleEnabled("INVENTORY") && all.length) {
    const recipes = await prisma.recipe.findMany({
      where: { menuItemId: { in: [...new Set(all.map((l) => l.menuItemId))] }, item: { active: true } },
      select: { menuItemId: true, variantId: true, inventoryItemId: true, quantity: true, item: { select: { name: true, unit: true } } },
    });
    const confirmed = computeConsumption(all.map((l) => ({ menuItemId: l.menuItemId, variantId: l.variantId, quantity: l.confirmed })), recipes);
    const withWalkIn = computeConsumption(all.map((l) => ({ menuItemId: l.menuItemId, variantId: l.variantId, quantity: l.confirmed + l.expectedWalkIn })), recipes);
    const ids = [...withWalkIn.keys()];
    const stocks = new Map((await prisma.inventoryStock.findMany({ where: { outletId, inventoryItemId: { in: ids } } })).map((s) => [s.inventoryItemId, s.quantity]));
    const info = new Map(recipes.map((r) => [r.inventoryItemId, r.item]));
    const r3 = (n: number) => Math.round(n * 1000) / 1000;
    ingredients = ids
      .map((id) => {
        const need = withWalkIn.get(id) ?? 0;
        const inStock = stocks.get(id) ?? 0;
        return { inventoryItemId: id, name: info.get(id)!.name, unit: info.get(id)!.unit, confirmed: r3(confirmed.get(id) ?? 0), withWalkIn: r3(need), inStock: r3(inStock), short: r3(Math.max(0, need - inStock)) };
      })
      .sort((a, b) => b.short - a.short || a.name.localeCompare(b.name));
  }
  return { date, weekday: weekdayOf(date), slots: result, ingredients, inventory: moduleEnabled("INVENTORY") };
}

// =====================================================================
// Meal subscriptions
// =====================================================================

/** Subscriptions whose meal falls on `date` and isn't a pre-order yet (active, that weekday, not skipped). */
const dueOn = (date: string): Prisma.MealSubscriptionWhereInput => ({
  status: "ACTIVE",
  startDate: { lte: date },
  endDate: { gte: date },
  daysOfWeek: { has: weekdayOf(date) },
  skips: { none: { date } },
  meals: { none: { date } },
});

/** The plan's meal dates (start…end on the chosen weekdays). */
export function mealDates(s: { startDate: string; endDate: string; daysOfWeek: number[] }): string[] {
  const out: string[] = [];
  for (let d = s.startDate; d <= s.endDate; d = addDays(d, 1)) if (s.daysOfWeek.includes(weekdayOf(d))) out.push(d);
  return out;
}

const MAX_PLAN_DAYS = 366;

/** The item's price in a slot: slot price → outlet price → menu price. */
async function slotPrice(outletId: string, slotId: string, menuItemId: string) {
  const item = await prisma.menuItem.findUnique({ where: { id: menuItemId }, include: { overrides: { where: { outletId } } } });
  if (!item || item.status === "HIDDEN") throw badRequest("Unknown menu item");
  const row = await prisma.mealSlotItem.findUnique({ where: { slotId_menuItemId: { slotId, menuItemId } } });
  return { item, price: row?.price ?? item.overrides[0]?.price ?? item.price };
}

/** Create a plan and its upfront paid bill (one invoice: meal × number of meals) atomically. */
export async function createSubscription(req: Request, input: MealSubscriptionInput) {
  const outlet = await outletOf(req.outletId!);
  const slot = await slotOf(outlet.id, input.slotId);
  if (!slot.active) throw badRequest(`${slot.name} is switched off`);
  const customer = await prisma.customer.findUnique({ where: { id: input.customerId }, select: { id: true, name: true, phone: true, blocked: true } });
  if (!customer) throw badRequest("Unknown customer");
  if (customer.blocked) throw badRequest("Customer is blocked");
  const today = zonedParts(new Date(), outlet.timezone).date;
  if (input.startDate < today) throw badRequest("The plan can't start in the past");
  if (addDays(input.startDate, MAX_PLAN_DAYS) <= input.endDate) throw badRequest(`A plan can run at most ${MAX_PLAN_DAYS} days`);
  const daysOfWeek = [...new Set(input.daysOfWeek)].sort();
  const mealCount = mealDates({ ...input, daysOfWeek }).length;
  if (!mealCount) throw badRequest("No meal days between those dates");
  const { item, price } = await slotPrice(outlet.id, slot.id, input.menuItemId);
  const pricePerMeal = input.pricePerMeal ?? price;
  if (pricePerMeal <= 0) throw badRequest("Set a price per meal");
  await assertCashShiftOpen(outlet.id, [input.paymentMode]);

  let effects: () => void = () => undefined;
  const sub = await prisma.$transaction(async (tx) => {
    const r = await createOrder(
      req,
      orderCreateSchema.parse({
        orderType: "DINE_IN",
        items: [{ menuItemId: item.id, quantity: mealCount }],
        customerName: customer.name ?? undefined,
        customerPhone: billPhone(customer.phone),
        notes: `Meal plan: ${slot.name}, ${input.startDate} to ${input.endDate}`,
      }),
      { tx, unitPrices: { [item.id]: pricePerMeal }, skipKot: true, skipAvailability: true, noMealSlot: true },
    );
    effects = r.effects;
    const amount = r.order.grandTotal;
    await tx.payment.create({ data: { orderId: r.order.id, mode: input.paymentMode, amount, reference: input.reference, status: "SUCCESS", confirmedAt: new Date() } });
    await onPaymentsRecorded(tx, r.order.id, [{ mode: input.paymentMode, amount }], req.user!.id);
    await settleIfPaid(r.order.id, tx);
    const created = await tx.mealSubscription.create({
      data: {
        outletId: outlet.id,
        customerId: customer.id,
        slotId: slot.id,
        menuItemId: item.id,
        daysOfWeek,
        startDate: input.startDate,
        endDate: input.endDate,
        pricePerMeal,
        mealCount,
        orderId: r.order.id,
        notes: input.notes,
        createdById: req.user!.id,
      },
    });
    await audit(req, "canteen.subscription_create", "MealSubscription", created.id, { mealCount, pricePerMeal, invoiceNumber: r.order.invoiceNumber, amount }, tx);
    return created;
  });
  effects();
  return getSubscription(outlet.id, sub.id);
}

export async function getSubscription(outletId: string, id: string) {
  const sub = await prisma.mealSubscription.findFirst({
    where: { id, outletId },
    include: { skips: { orderBy: { date: "asc" } }, meals: { orderBy: { date: "asc" } }, slot: { select: { id: true, name: true } }, menuItem: { select: { id: true, name: true } } },
  });
  if (!sub) throw notFound("Subscription");
  return withSummary(sub);
}

export async function listSubscriptions(outletId: string, status?: MealSubscription["status"]) {
  const subs = await prisma.mealSubscription.findMany({
    where: { outletId, ...(status && { status }) },
    include: { skips: { orderBy: { date: "asc" } }, meals: { orderBy: { date: "asc" } }, slot: { select: { id: true, name: true } }, menuItem: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  return Promise.all(subs.map(withSummary));
}

type SubWithMeals = MealSubscription & { meals: { orderId: string; date: string }[]; skips: { date: string }[] };

/** Meals delivered (pre-orders made and not cancelled) vs the plan's paid meals. */
async function deliveredMeals(sub: SubWithMeals) {
  if (!sub.meals.length) return 0;
  return prisma.order.count({ where: { id: { in: sub.meals.map((m) => m.orderId) }, status: { not: "CANCELLED" } } });
}

async function withSummary<T extends SubWithMeals>(sub: T) {
  const [customer, order, delivered] = await Promise.all([
    prisma.customer.findUnique({ where: { id: sub.customerId }, select: { id: true, name: true, phone: true } }),
    sub.orderId ? prisma.order.findUnique({ where: { id: sub.orderId }, select: { id: true, invoiceNumber: true, grandTotal: true, refundedAmount: true } }) : null,
    deliveredMeals(sub),
  ]);
  return { ...sub, customer, order, delivered, remaining: Math.max(0, sub.mealCount - delivered - sub.refundedMeals) };
}

async function loadSub(outletId: string, id: string) {
  const sub = await prisma.mealSubscription.findFirst({ where: { id, outletId }, include: { slot: true, meals: true, skips: true } });
  if (!sub) throw notFound("Subscription");
  return sub;
}

export async function setPaused(req: Request, id: string, paused: boolean) {
  const sub = await loadSub(req.outletId!, id);
  if (sub.status === "CANCELLED") throw conflict("This plan is cancelled");
  const { count } = await prisma.mealSubscription.updateMany({ where: { id, status: paused ? "ACTIVE" : "PAUSED" }, data: { status: paused ? "PAUSED" : "ACTIVE" } });
  if (!count) throw conflict(paused ? "This plan is already paused" : "This plan isn't paused");
  await audit(req, paused ? "canteen.subscription_pause" : "canteen.subscription_resume", "MealSubscription", id);
  return getSubscription(req.outletId!, id);
}

/**
 * Skip one meal date. Allowed until that meal is sent to the kitchen (the slot's cutoff run);
 * after that, a manager can force it, which cancels that day's meal order. Skipped meals are
 * paid for and come back as part of the refund if the plan is cancelled.
 */
export async function skipDate(req: Request, id: string, date: string, force = false) {
  const outlet = await outletOf(req.outletId!);
  const sub = await loadSub(outlet.id, id);
  if (sub.status === "CANCELLED") throw conflict("This plan is cancelled");
  if (!mealDates(sub).includes(date)) throw badRequest("There's no meal on that date in this plan");
  if (sub.skips.some((s) => s.date === date)) throw conflict("That date is already skipped");
  if (slotStartOn(sub.slot, date, outlet.timezone).getTime() <= Date.now()) throw conflict("That meal time has already started");
  const meal = sub.meals.find((m) => m.date === date);
  if (meal && !(force && userCan(req, "canteen:manage"))) {
    throw new HttpError(409, "That day's meal is already sent to the kitchen.", { code: "MEAL_ALREADY_PLANNED", canOverride: userCan(req, "canteen:manage") });
  }
  await prisma.$transaction(async (tx) => {
    await tx.mealSubscriptionSkip.create({ data: { subscriptionId: sub.id, date } });
    if (meal) {
      await tx.order.updateMany({ where: { id: meal.orderId, status: { not: "CANCELLED" }, servedAt: null }, data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: "Meal plan date skipped" } });
      await restoreStockForOrder(tx, meal.orderId);
    }
    await audit(req, "canteen.subscription_skip", "MealSubscription", sub.id, { date, forced: Boolean(meal) }, tx);
  });
  return getSubscription(outlet.id, id);
}

export async function unskipDate(req: Request, id: string, date: string) {
  const sub = await loadSub(req.outletId!, id);
  const { count } = await prisma.mealSubscriptionSkip.deleteMany({ where: { subscriptionId: sub.id, date } });
  if (!count) throw notFound("Skipped date");
  // A forced skip cancelled that meal's pre-order: let the next run make a fresh one.
  const meal = sub.meals.find((m) => m.date === date);
  if (meal) {
    const order = await prisma.order.findUnique({ where: { id: meal.orderId }, select: { status: true } });
    if (order?.status === "CANCELLED") await prisma.mealSubscriptionMeal.delete({ where: { id: meal.id } });
  }
  await audit(req, "canteen.subscription_unskip", "MealSubscription", sub.id, { date });
  return getSubscription(req.outletId!, id);
}

/**
 * Cancel a plan: no more meals are made, and every paid meal not delivered (future, skipped,
 * paused) is refunded pro-rata by a credit note on the upfront bill, which reverses its GST.
 */
export async function cancelSubscription(req: Request, id: string, input: { refundMode: "CASH" | "UPI" | "CARD" | "KHATA"; note?: string }) {
  const sub = await loadSub(req.outletId!, id);
  if (sub.status === "CANCELLED") throw conflict("This plan is already cancelled");
  // Claim the cancel first so two clicks can't refund twice.
  const { count } = await prisma.mealSubscription.updateMany({ where: { id, status: { not: "CANCELLED" } }, data: { status: "CANCELLED", cancelledAt: new Date() } });
  if (!count) throw conflict("This plan is already cancelled");
  try {
    const refundable = sub.mealCount - (await deliveredMeals(sub)) - sub.refundedMeals;
    let creditNoteId: string | null = null;
    if (refundable > 0 && sub.orderId) {
      const line = await prisma.orderItem.findFirst({ where: { orderId: sub.orderId, menuItemId: sub.menuItemId } });
      if (!line) throw conflict("The plan's bill has no meal line to refund");
      const note = await createCreditNote(req, sub.orderId, {
        reason: "OTHER",
        note: input.note?.length && input.note.length >= 3 ? input.note : `Meal plan cancelled: ${refundable} unused meal(s)`,
        refundMode: input.refundMode,
        items: [{ orderItemId: line.id, quantity: Math.min(refundable, line.quantity) }],
        restock: false,
      });
      creditNoteId = note.id;
    }
    await prisma.mealSubscription.update({ where: { id }, data: { creditNoteId, refundedMeals: { increment: Math.max(0, refundable) } } });
    await audit(req, "canteen.subscription_cancel", "MealSubscription", id, { refundedMeals: Math.max(0, refundable), creditNoteId });
  } catch (e) {
    await prisma.mealSubscription.update({ where: { id }, data: { status: sub.status, cancelledAt: null } });
    throw e;
  }
  return getSubscription(req.outletId!, id);
}

// =====================================================================
// Daily materialisation (job)
// =====================================================================

/** A request-shaped context for billing outside HTTP (jobs): the plan's creator is the cashier. */
function systemRequest(outletId: string, userId: string): Request {
  return { outletId, user: { id: userId, name: "System", role: "OUTLET_MANAGER", businessId: null, outletIds: [outletId] }, ip: undefined, headers: {} } as unknown as Request;
}

/** A meal date is made into a pre-order once its slot's cutoff passed (midnight when the slot has none), until the slot starts. */
export function materialiseWindow(slot: Pick<MealSlot, "startTime" | "preorderCutoff">, date: string, timezone: string) {
  return { from: preorderCutoffAt(slot, date, timezone) ?? startOfLocalDay(date, timezone), until: slotStartOn(slot, date, timezone) };
}

/**
 * Turn due subscription meals of one outlet into zero-value PRE_ORDER bills (KOT held until
 * shortly before the slot, like any pre-order). Idempotent: one meal per plan and date.
 * Runs inside the business's tenant context.
 */
export async function materialiseOutlet(outletId: string, now = new Date()) {
  const outlet = await outletOf(outletId);
  const slots = await prisma.mealSlot.findMany({ where: { outletId, active: true } });
  const today = zonedParts(now, outlet.timezone).date;
  let created = 0;
  for (const slot of slots) {
    for (const date of [today, addDays(today, 1)]) {
      const w = materialiseWindow(slot, date, outlet.timezone);
      if (now < w.from || now >= w.until) continue;
      const subs = await prisma.mealSubscription.findMany({ where: { outletId, slotId: slot.id, ...dueOn(date) } });
      for (const sub of subs) {
        if (await materialiseMeal(outletId, sub, slot, date, w.until)) created++;
      }
    }
  }
  return created;
}

async function materialiseMeal(outletId: string, sub: MealSubscription, slot: MealSlot, date: string, at: Date) {
  const customer = await prisma.customer.findUnique({ where: { id: sub.customerId }, select: { name: true, phone: true } });
  const req = systemRequest(outletId, sub.createdById);
  try {
    let effects: () => void = () => undefined;
    await prisma.$transaction(async (tx) => {
      const r = await createOrder(
        req,
        orderCreateSchema.parse({
          orderType: "PRE_ORDER",
          items: [{ menuItemId: sub.menuItemId, quantity: 1 }],
          customerName: customer?.name ?? undefined,
          customerPhone: billPhone(customer?.phone),
          notes: "Meal plan",
          scheduledFor: at.toISOString(),
          mealSlotId: slot.id,
        }),
        { tx, unitPrices: { [sub.menuItemId]: 0 }, skipAvailability: true },
      );
      effects = r.effects;
      await tx.mealSubscriptionMeal.create({ data: { subscriptionId: sub.id, date, orderId: r.order.id } });
      // Already paid on the plan's bill: a zero-value bill settles at once.
      await settleIfPaid(r.order.id, tx);
    });
    effects();
    return true;
  } catch (e) {
    // Another run made it first (unique plan + date): fine.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return false;
    console.error(`[canteen] meal for plan ${sub.id} on ${date} failed:`, e);
    return false;
  }
}
