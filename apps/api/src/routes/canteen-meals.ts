import { Router } from "express";
import { z } from "zod";
import {
  canteenPreorderSchema,
  mealSlotItemsSchema,
  mealSlotSchema,
  mealSlotUpdateSchema,
  mealSubscriptionCancelSchema,
  mealSubscriptionSchema,
  SUBSCRIPTION_PAY_MODES,
} from "@canavo/shared";
import { prisma } from "../db";
import { audit } from "../lib/audit";
import { badRequest, notFound, param, parse } from "../lib/http";
import { zonedParts } from "../lib/time";
import { authenticate, requireAnyPermission, requireModule, requireOutlet, requirePermission } from "../middleware/auth";
import { emitToOutlet } from "../realtime";
import { overlapWarnings, preorderCutoffAt, slotAt } from "../services/meal-slots";
import { sendExport } from "../services/report-export";
import {
  bookPreorder,
  cancelPreorder,
  cancelSubscription,
  createSubscription,
  getSubscription,
  listPreorders,
  listSubscriptions,
  productionPlan,
  servePreorder,
  setPaused,
  skipDate,
  unskipDate,
} from "../services/canteen-meals";

/**
 * Phase 5.3 / 5.4 (CANTEEN): meal slots and their menus, next-day pre-orders, the production
 * plan and meal subscriptions. Mounted at /canteen (corporate accounts live in their own router).
 */
export const canteenMealsRouter = Router();
canteenMealsRouter.use(authenticate, requireOutlet, requireModule("CANTEEN"));

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const today = async (outletId: string) => zonedParts(new Date(), (await prisma.outlet.findUniqueOrThrow({ where: { id: outletId }, select: { timezone: true } })).timezone).date;

// ---------- Slots ----------

async function slotsPayload(outletId: string) {
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: outletId }, select: { timezone: true } });
  const slots = await prisma.mealSlot.findMany({
    where: { outletId },
    include: { _count: { select: { items: true } } },
    orderBy: [{ sortOrder: "asc" }, { startTime: "asc" }],
  });
  const current = await slotAt(outletId, new Date(), outlet.timezone);
  return { slots: slots.map(({ _count, ...s }) => ({ ...s, itemCount: _count.items })), currentSlotId: current?.id ?? null, warnings: overlapWarnings(slots) };
}

/** Slots of this outlet (+ the one open now, and overlap warnings). Staff booking pre-orders need them too. */
canteenMealsRouter.get("/slots", requireAnyPermission("canteen:manage", "order:create"), async (req, res) => {
  res.json(await slotsPayload(req.outletId!));
});

canteenMealsRouter.post("/slots", requirePermission("canteen:manage"), async (req, res) => {
  const data = parse(mealSlotSchema, req.body);
  const slot = await prisma.mealSlot.create({ data: { ...data, outletId: req.outletId! } });
  await audit(req, "canteen.slot_create", "MealSlot", slot.id, data);
  emitToOutlet(req.outletId!, "menu:changed", { slotId: slot.id });
  res.status(201).json({ slot, warnings: (await slotsPayload(req.outletId!)).warnings });
});

canteenMealsRouter.patch("/slots/:id", requirePermission("canteen:manage"), async (req, res) => {
  const data = parse(mealSlotUpdateSchema, req.body);
  const slot = await prisma.mealSlot.findFirst({ where: { id: param(req, "id"), outletId: req.outletId! } });
  if (!slot) throw notFound("Meal slot");
  if ((data.startTime ?? slot.startTime) === (data.endTime ?? slot.endTime)) throw badRequest("Start and end time can't be the same");
  const updated = await prisma.mealSlot.update({ where: { id: slot.id }, data });
  await audit(req, "canteen.slot_update", "MealSlot", slot.id, data);
  emitToOutlet(req.outletId!, "menu:changed", { slotId: slot.id });
  res.json({ slot: updated, warnings: (await slotsPayload(req.outletId!)).warnings });
});

/** Delete a slot; one with bills or plans is switched off instead (history keeps pointing at it). */
canteenMealsRouter.delete("/slots/:id", requirePermission("canteen:manage"), async (req, res) => {
  const slot = await prisma.mealSlot.findFirst({ where: { id: param(req, "id"), outletId: req.outletId! } });
  if (!slot) throw notFound("Meal slot");
  const used = (await prisma.order.count({ where: { mealSlotId: slot.id } })) + (await prisma.mealSubscription.count({ where: { slotId: slot.id } }));
  if (used) await prisma.mealSlot.update({ where: { id: slot.id }, data: { active: false } });
  else await prisma.mealSlot.delete({ where: { id: slot.id } });
  await audit(req, used ? "canteen.slot_deactivate" : "canteen.slot_delete", "MealSlot", slot.id);
  emitToOutlet(req.outletId!, "menu:changed", { slotId: slot.id });
  res.json({ deleted: !used, deactivated: Boolean(used) });
});

canteenMealsRouter.get("/slots/:id/items", requireAnyPermission("canteen:manage", "order:create"), async (req, res) => {
  const slot = await prisma.mealSlot.findFirst({ where: { id: param(req, "id"), outletId: req.outletId! } });
  if (!slot) throw notFound("Meal slot");
  res.json(await prisma.mealSlotItem.findMany({ where: { slotId: slot.id }, include: { menuItem: { select: { id: true, name: true, price: true } } }, orderBy: { menuItem: { name: "asc" } } }));
});

/** Replace the slot's menu (items + optional slot prices). */
canteenMealsRouter.put("/slots/:id/items", requirePermission("canteen:manage"), async (req, res) => {
  const { items } = parse(mealSlotItemsSchema, req.body);
  const slot = await prisma.mealSlot.findFirst({ where: { id: param(req, "id"), outletId: req.outletId! } });
  if (!slot) throw notFound("Meal slot");
  const known = await prisma.menuItem.count({ where: { id: { in: items.map((i) => i.menuItemId) } } });
  if (known !== items.length) throw badRequest("Unknown menu item");
  await prisma.$transaction(async (tx) => {
    await tx.mealSlotItem.deleteMany({ where: { slotId: slot.id } });
    if (items.length) await tx.mealSlotItem.createMany({ data: items.map((i) => ({ slotId: slot.id, menuItemId: i.menuItemId, price: i.price })) });
    await audit(req, "canteen.slot_items", "MealSlot", slot.id, { count: items.length }, tx);
  });
  emitToOutlet(req.outletId!, "menu:changed", { slotId: slot.id });
  res.json(await prisma.mealSlotItem.findMany({ where: { slotId: slot.id } }));
});

// ---------- Pre-orders ----------

/** Book a meal for a date + slot (default: tomorrow). Cutoff: the slot's preorderCutoff on the previous day. */
canteenMealsRouter.post("/preorders", requirePermission("order:create"), async (req, res) => {
  res.status(201).json(await bookPreorder(req, parse(canteenPreorderSchema, req.body)));
});

canteenMealsRouter.get("/preorders", requireAnyPermission("canteen:manage", "order:create"), async (req, res) => {
  const q = parse(z.object({ date: ymd.optional(), slotId: z.string().optional() }), req.query);
  const date = q.date ?? (await today(req.outletId!));
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: req.outletId! }, select: { timezone: true } });
  const slots = await prisma.mealSlot.findMany({ where: { outletId: req.outletId!, active: true }, orderBy: [{ sortOrder: "asc" }, { startTime: "asc" }] });
  res.json({
    date,
    slots: slots.map((s) => ({ id: s.id, name: s.name, startTime: s.startTime, endTime: s.endTime, cutoffAt: preorderCutoffAt(s, date, outlet.timezone) })),
    preorders: await listPreorders(req.outletId!, date, q.slotId),
  });
});

canteenMealsRouter.post("/preorders/:id/cancel", requireAnyPermission("order:cancel", "canteen:manage"), async (req, res) => {
  const body = parse(z.object({ reason: z.string().trim().min(3).max(200), refundMode: z.enum(SUBSCRIPTION_PAY_MODES).optional() }), req.body);
  const out = await cancelPreorder(req, param(req, "id"), body);
  emitToOutlet(req.outletId!, "order:cancelled", { id: out.id });
  res.json(out);
});

/** Redeem at the counter: hand over today's pre-order (or subscription meal). */
canteenMealsRouter.post("/preorders/:id/serve", requirePermission("order:create"), async (req, res) => {
  res.json(await servePreorder(req, param(req, "id")));
});

// ---------- Production plan ----------

canteenMealsRouter.get("/production", requirePermission("canteen:manage"), async (req, res) => {
  const q = parse(z.object({ date: ymd.optional(), format: z.enum(["json", "xlsx", "pdf"]).default("json") }), req.query);
  const plan = await productionPlan(req.outletId!, q.date ?? (await today(req.outletId!)));
  if (q.format === "json") return res.json(plan);
  await sendExport(
    res,
    q.format,
    `production_${plan.date}`,
    [
      ...plan.slots.map((s, i) => ({
        title: `${s.slot.name} (${s.slot.startTime}–${s.slot.endTime})`,
        ...(i === 0 && { subtitle: plan.date }),
        columns: [
          { key: "name", header: "Item", width: 28 },
          { key: "preorders", header: "Pre-orders", type: "int" as const },
          { key: "subscriptions", header: "Plans", type: "int" as const },
          { key: "confirmed", header: "Confirmed", type: "int" as const },
          { key: "expectedWalkIn", header: "Expected walk-in", type: "int" as const },
        ],
        rows: s.items,
        totals: { name: "Total", ...s.totals },
      })),
      ...(plan.inventory
        ? [{
            title: "Ingredients",
            columns: [
              { key: "name", header: "Ingredient", width: 24 },
              { key: "unit", header: "Unit" },
              { key: "confirmed", header: "For confirmed", type: "number" as const },
              { key: "withWalkIn", header: "With walk-ins", type: "number" as const },
              { key: "inStock", header: "In stock", type: "number" as const },
              { key: "short", header: "Short", type: "number" as const },
            ],
            rows: plan.ingredients,
          }]
        : []),
    ],
    "Production plan",
  );
});

// ---------- Subscriptions ----------

canteenMealsRouter.get("/subscriptions", requirePermission("canteen:manage"), async (req, res) => {
  const q = parse(z.object({ status: z.enum(["ACTIVE", "PAUSED", "CANCELLED"]).optional() }), req.query);
  res.json(await listSubscriptions(req.outletId!, q.status));
});

canteenMealsRouter.get("/subscriptions/:id", requirePermission("canteen:manage"), async (req, res) => {
  res.json(await getSubscription(req.outletId!, param(req, "id")));
});

/** Create a plan; it's paid upfront on a normal bill (GST charged once, on that bill). */
canteenMealsRouter.post("/subscriptions", requirePermission("canteen:manage", "payment:collect"), async (req, res) => {
  res.status(201).json(await createSubscription(req, parse(mealSubscriptionSchema, req.body)));
});

canteenMealsRouter.post("/subscriptions/:id/pause", requirePermission("canteen:manage"), async (req, res) => {
  res.json(await setPaused(req, param(req, "id"), true));
});

canteenMealsRouter.post("/subscriptions/:id/resume", requirePermission("canteen:manage"), async (req, res) => {
  res.json(await setPaused(req, param(req, "id"), false));
});

canteenMealsRouter.post("/subscriptions/:id/skips", requirePermission("canteen:manage"), async (req, res) => {
  const { date, force } = parse(z.object({ date: ymd, force: z.boolean().optional() }), req.body);
  res.json(await skipDate(req, param(req, "id"), date, force));
});

canteenMealsRouter.delete("/subscriptions/:id/skips/:date", requirePermission("canteen:manage"), async (req, res) => {
  res.json(await unskipDate(req, param(req, "id"), parse(ymd, param(req, "date"))));
});

/** Cancel with a pro-rata refund of the meals not delivered (credit note on the plan's bill). */
canteenMealsRouter.post("/subscriptions/:id/cancel", requirePermission("canteen:manage"), async (req, res) => {
  res.json(await cancelSubscription(req, param(req, "id"), parse(mealSubscriptionCancelSchema, req.body)));
});
