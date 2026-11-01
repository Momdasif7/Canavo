/** Phase 5.3 / 5.4 — meal slots & slot menus, next-day pre-orders, production plan, meal subscriptions. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotel, db, login, startServer, type Client, type Hotel } from "./helpers";
import { materialiseSubscriptionMeals } from "../../src/jobs-canteen";
import { addDays, startOfLocalDay, zonedParts } from "../../src/lib/time";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel;
let manager: Client, cashier: Client;
let allDay: string, breakfast: string, customerId: string;
const TZ = "Asia/Kolkata";
const today = () => zonedParts(new Date(), TZ).date;
const tomorrow = () => addDays(today(), 1);
/** Just after the "Canteen day" slot's cutoff (23:59 today) for tomorrow's meals. */
const afterCutoff = () => new Date(startOfLocalDay(tomorrow(), TZ).getTime() - 30_000);

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("Canteen", { modules: ["BILLING", "KOT", "CUSTOMERS", "INVENTORY", "REPORTS", "CANTEEN"] });
  manager = await login(srv.base, h.users.manager.email, h.outletId);
  cashier = await login(srv.base, h.users.cashier.email, h.outletId);
  customerId = (await db.customer.create({ data: { businessId: h.businessId, phone: "9876500011", name: "Ravi" } })).id;
});
afterAll(() => srv.close());

describe("meal slots", () => {
  it("managers create, list and edit slots; overlaps are allowed with a warning; cashiers can't edit", async () => {
    // Nearly all day (so counter bills during the test land in it); pre-orders close 23:59 the day before.
    const a = await manager.call("POST", "/canteen/slots", { name: "Canteen day", startTime: "00:00", endTime: "23:59", preorderCutoff: "23:59" });
    expect(a.status).toBe(201);
    allDay = a.body.slot.id;
    // Pre-orders close at midnight the day before: always past for tomorrow.
    const b = await manager.call("POST", "/canteen/slots", { name: "Breakfast", startTime: "06:00", endTime: "07:00", preorderCutoff: "00:00", sortOrder: 1 });
    expect(b.status).toBe(201);
    breakfast = b.body.slot.id;
    expect(b.body.warnings.join(" ")).toMatch(/overlap/);
    expect((await manager.call("POST", "/canteen/slots", { name: "Bad", startTime: "25:00", endTime: "07:00" })).status).toBe(400);
    expect((await cashier.call("POST", "/canteen/slots", { name: "X", startTime: "08:00", endTime: "09:00" })).status).toBe(403);
    const list = await cashier.call("GET", "/canteen/slots");
    expect(list.status).toBe(200);
    expect(list.body.slots.map((s: { name: string }) => s.name)).toEqual(["Canteen day", "Breakfast"]);
    expect((await manager.call("PATCH", `/canteen/slots/${breakfast}`, { endTime: "07:30" })).body.slot.endTime).toBe("07:30");
    const tmp = await manager.call("POST", "/canteen/slots", { name: "Temp", startTime: "16:00", endTime: "17:00" });
    expect((await manager.call("DELETE", `/canteen/slots/${tmp.body.slot.id}`)).body.deleted).toBe(true);
  });

  it("slot menu: slot price applies on the bill; an item on another slot only is refused; unassigned items always sell", async () => {
    expect((await manager.call("PUT", `/canteen/slots/${allDay}/items`, { items: [{ menuItemId: h.items.biryani, price: 12000 }] })).status).toBe(200);
    expect((await manager.call("PUT", `/canteen/slots/${breakfast}/items`, { items: [{ menuItemId: h.items.samosa }] })).status).toBe(200);
    const bill = await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.biryani, quantity: 1 }, { menuItemId: h.items.chai, quantity: 1 }] });
    expect(bill.status).toBe(201);
    expect(bill.body.mealSlotId).toBe(allDay);
    expect(bill.body.items.find((i: { menuItemId: string }) => i.menuItemId === h.items.biryani).unitPrice).toBe(12000);
    const refused = await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.samosa, quantity: 1 }] });
    expect(refused.status).toBe(400);
    expect(refused.body.error ?? refused.body.message).toMatch(/Breakfast/);
    // POS menu for the slot open now: slot price, samosa hidden, chai still there.
    const menu = (await cashier.call("GET", "/menu?slot=current")).body;
    expect(menu.mealSlot.id).toBe(allDay);
    const ids = menu.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(h.items.chai);
    expect(ids).not.toContain(h.items.samosa);
    expect(menu.items.find((i: { id: string }) => i.id === h.items.biryani).price).toBe(12000);
    // Plain menu (menu editor) is unchanged.
    expect((await cashier.call("GET", "/menu")).body.items.find((i: { id: string }) => i.id === h.items.biryani).price).toBe(16000);
  });
});

describe("next-day pre-orders", () => {
  it("books before the cutoff; refuses after it unless a manager overrides", async () => {
    const ok = await cashier.call("POST", "/canteen/preorders", { date: tomorrow(), slotId: allDay, items: [{ menuItemId: h.items.biryani, quantity: 2 }], customerName: "Asha" });
    expect(ok.status).toBe(201);
    expect(ok.body.orderType).toBe("PRE_ORDER");
    expect(ok.body.mealSlotId).toBe(allDay);
    expect(ok.body.grandTotal).toBe(24000);
    expect(zonedParts(new Date(ok.body.scheduledFor), TZ)).toEqual({ date: tomorrow(), minutes: 0 });

    const late = await cashier.call("POST", "/canteen/preorders", { date: tomorrow(), slotId: breakfast, items: [{ menuItemId: h.items.samosa, quantity: 1 }], override: true });
    expect(late.status).toBe(409);
    expect(late.body.details.code).toBe("PREORDER_CLOSED");
    expect(late.body.details.canOverride).toBe(false);
    const forced = await manager.call("POST", "/canteen/preorders", { date: tomorrow(), slotId: breakfast, items: [{ menuItemId: h.items.samosa, quantity: 1 }], override: true });
    expect(forced.status).toBe(201);

    const list = await cashier.call("GET", `/canteen/preorders?date=${tomorrow()}`);
    expect(list.body.preorders).toHaveLength(2);
    // Cancel the breakfast one (unpaid → voided).
    const c = await manager.call("POST", `/canteen/preorders/${forced.body.id}/cancel`, { reason: "Changed plan" });
    expect(c.status).toBe(200);
    expect((await db.order.findUnique({ where: { id: forced.body.id } }))!.status).toBe("CANCELLED");
  });
});

describe("meal subscriptions", () => {
  let subA: string, subB: string, subC: string;

  it("creating a plan bills it upfront as a normal paid bill (meal × meals)", async () => {
    const body = { customerId, slotId: allDay, menuItemId: h.items.biryani, daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startDate: tomorrow(), endDate: addDays(tomorrow(), 6), paymentMode: "CASH" };
    const r = await manager.call("POST", "/canteen/subscriptions", body);
    expect(r.status).toBe(201);
    subA = r.body.id;
    expect(r.body.mealCount).toBe(7);
    expect(r.body.pricePerMeal).toBe(12000);
    const bill = await db.order.findUnique({ where: { id: r.body.orderId }, include: { items: true, payments: true, kots: true } });
    expect(bill!.status).toBe("PAID");
    expect(bill!.grandTotal).toBe(84000);
    expect(bill!.items[0]!.quantity).toBe(7);
    expect(bill!.payments[0]!.mode).toBe("CASH");
    expect(bill!.kots).toHaveLength(0);
    expect(bill!.mealSlotId).toBeNull();

    subB = (await manager.call("POST", "/canteen/subscriptions", body)).body.id;
    subC = (await manager.call("POST", "/canteen/subscriptions", body)).body.id;
    expect((await manager.call("POST", `/canteen/subscriptions/${subB}/skips`, { date: tomorrow() })).status).toBe(200);
    expect((await manager.call("POST", `/canteen/subscriptions/${subC}/pause`)).body.status).toBe("PAUSED");
    expect((await manager.call("POST", "/canteen/subscriptions", { ...body, startDate: addDays(today(), -1) })).status).toBe(400);
    expect((await cashier.call("POST", "/canteen/subscriptions", body)).status).toBe(403);
  });

  it("production plan: pre-orders + due plans + walk-in average + recipe ingredients vs stock", async () => {
    // Walk-ins: counter bills on the last two same weekdays as tomorrow (offline bills keep their time).
    for (const days of [6, 13]) {
      const at = new Date(Date.now() - days * 86_400_000).toISOString();
      expect((await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", createdAt: at, items: [{ menuItemId: h.items.biryani, quantity: 4 }] })).status).toBe(201);
    }
    const rice = await db.inventoryItem.create({ data: { businessId: h.businessId, name: "Rice", unit: "KG" } });
    await db.recipe.create({ data: { menuItemId: h.items.biryani, inventoryItemId: rice.id, quantity: 0.25 } });
    await db.inventoryStock.create({ data: { outletId: h.outletId, inventoryItemId: rice.id, quantity: 1 } });

    const plan = (await manager.call("GET", `/canteen/production?date=${tomorrow()}`)).body;
    const day = plan.slots.find((s: { slot: { id: string } }) => s.slot.id === allDay);
    const biryani = day.items.find((i: { menuItemId: string }) => i.menuItemId === h.items.biryani);
    // 2 pre-ordered + subA (subB skipped, subC paused); walk-ins (4 + 4) / 4 weeks = 2.
    expect(biryani).toMatchObject({ preorders: 2, subscriptions: 1, confirmed: 3, expectedWalkIn: 2 });
    const ing = plan.ingredients.find((i: { inventoryItemId: string }) => i.inventoryItemId === rice.id);
    expect(ing).toMatchObject({ confirmed: 0.75, withWalkIn: 1.25, inStock: 1, short: 0.25 });
    const pdf = await manager.call("GET", `/canteen/production?date=${tomorrow()}&format=xlsx`);
    expect(pdf.status).toBe(200);
  });

  it("daily run makes zero-value pre-orders for due meals once, respecting skips and pauses", async () => {
    // Before the cutoff nothing is made yet (skips can still change).
    await materialiseSubscriptionMeals();
    expect(await db.mealSubscriptionMeal.count({ where: { subscriptionId: { in: [subA, subB, subC] } } })).toBe(0);
    await materialiseSubscriptionMeals(afterCutoff());
    await materialiseSubscriptionMeals(afterCutoff());
    const meals = await db.mealSubscriptionMeal.findMany({ where: { subscriptionId: { in: [subA, subB, subC] } } });
    expect(meals).toHaveLength(1);
    expect(meals[0]).toMatchObject({ subscriptionId: subA, date: tomorrow() });
    const order = await db.order.findUnique({ where: { id: meals[0]!.orderId }, include: { kots: true } });
    expect(order).toMatchObject({ orderType: "PRE_ORDER", grandTotal: 0, status: "PAID", mealSlotId: allDay, customerId });
    expect(order!.kots).toHaveLength(1);
    expect(order!.kots[0]!.releaseAt).not.toBeNull();
    // The production plan counts it once (now a pre-order, not a pending plan).
    const plan = (await manager.call("GET", `/canteen/production?date=${tomorrow()}`)).body;
    const biryani = plan.slots[0].items.find((i: { menuItemId: string }) => i.menuItemId === h.items.biryani);
    expect(biryani.subscriptions).toBe(1);
    // Skipping a planned meal needs a manager's force.
    expect((await manager.call("POST", `/canteen/subscriptions/${subA}/skips`, { date: tomorrow() })).body.details.code).toBe("MEAL_ALREADY_PLANNED");

    // Redeem at the counter: only on the day.
    expect((await cashier.call("POST", `/canteen/preorders/${order!.id}/serve`)).status).toBe(409);
    await db.order.update({ where: { id: order!.id }, data: { scheduledFor: new Date() } });
    expect((await cashier.call("POST", `/canteen/preorders/${order!.id}/serve`)).status).toBe(200);
    expect((await cashier.call("POST", `/canteen/preorders/${order!.id}/serve`)).status).toBe(409);
  });

  it("cancelling refunds the undelivered meals pro-rata by credit note", async () => {
    const r = await manager.call("POST", `/canteen/subscriptions/${subA}/cancel`, { refundMode: "CASH" });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("CANCELLED");
    expect(r.body.refundedMeals).toBe(6);
    const note = await db.creditNote.findUnique({ where: { id: r.body.creditNoteId } });
    expect(note!.amount).toBe(6 * 12000);
    expect((await manager.call("POST", `/canteen/subscriptions/${subA}/cancel`, { refundMode: "CASH" })).status).toBe(409);
    // No more meals after cancelling.
    await materialiseSubscriptionMeals(afterCutoff());
    expect(await db.mealSubscriptionMeal.count({ where: { subscriptionId: subA } })).toBe(1);
  });
});

describe("module off", () => {
  it("canteen routes answer 403 and the POS menu is the normal menu", async () => {
    const plain = await createHotel("No canteen");
    const m = await login(srv.base, plain.users.manager.email, plain.outletId);
    expect((await m.call("GET", "/canteen/slots")).status).toBe(403);
    expect((await m.call("GET", "/canteen/production")).status).toBe(403);
    const menu = (await m.call("GET", "/menu?slot=current")).body;
    expect(menu.mealSlot).toBeUndefined();
    expect(menu.items).toHaveLength(3);
  });
});
