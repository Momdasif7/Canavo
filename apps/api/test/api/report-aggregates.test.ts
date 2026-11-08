/**
 * QA Phase 13 perf-1: the sales, items, categories and profit reports now sum bills / lines / payments in
 * PostgreSQL instead of loading every row. These figures must equal the row-by-row computation they replaced
 * (re-implemented here from the raw rows): payment modes, item quantities / revenue / net, profit revenue,
 * recipe-estimated COGS and the count of bills costed by estimate vs. by stock movements.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "../integration/helpers";
import { db, world, type World } from "./kit";

let srv: Awaited<ReturnType<typeof startServer>>;
let w: World;
const owner = () => w.as.BUSINESS_OWNER;

async function bill(items: { menuItemId: string; quantity: number }[], pay: (total: number) => { mode: string; amount: number }[]) {
  const o = await owner().call("POST", "/orders", { orderType: "TAKEAWAY", items });
  expect(o.status, JSON.stringify(o.body)).toBe(201);
  const p = await owner().call("POST", `/orders/${o.body.id}/payments`, { payments: pay(o.body.grandTotal) });
  expect(p.status, JSON.stringify(p.body)).toBe(200);
  return o.body as { id: string; grandTotal: number };
}

beforeAll(async () => {
  srv = await startServer();
  w = await world(srv.base, "Report aggregates", ["BILLING", "KOT", "INVENTORY", "REPORTS"]);
  const { chai, samosa, biryani } = w.h.items;
  // Sold before any recipe exists: costed by estimate.
  await bill([{ menuItemId: biryani, quantity: 2 }, { menuItemId: samosa, quantity: 1 }], (t) => [{ mode: "UPI", amount: t }]);
  const rice = await db.inventoryItem.create({ data: { businessId: w.h.businessId, name: "Rice", unit: "KG", costPerUnit: 8000 } });
  await db.recipe.create({ data: { menuItemId: biryani, inventoryItemId: rice.id, quantity: 0.15 } });
  // With the recipe: stock is deducted at billing, so this bill is costed from stock movements.
  await bill([{ menuItemId: biryani, quantity: 1 }, { menuItemId: chai, quantity: 3 }], (t) => [
    { mode: "CASH", amount: 1000 },
    { mode: "UPI", amount: t - 1000 },
  ]);
  const cancelled = await bill([{ menuItemId: chai, quantity: 1 }], (t) => [{ mode: "CARD", amount: t }]);
  await db.order.update({ where: { id: cancelled.id }, data: { status: "CANCELLED", cancelledAt: new Date() } });
}, 60_000);
afterAll(() => srv.close());

const taxOf = (o: { cgst: number; sgst: number; igst: number; cess: number; otherTaxes: number }) => o.cgst + o.sgst + o.igst + o.cess + o.otherTaxes;

describe("SQL-summed reports = row-by-row figures", () => {
  it("sales: payment modes of paid bills (SUCCESS only)", async () => {
    const r = await owner().call("GET", "/reports/sales");
    expect(r.status).toBe(200);
    const pays = await db.payment.findMany({ where: { status: "SUCCESS", order: { outletId: w.h.outletId, status: "PAID" } } });
    const want = new Map<string, { count: number; amount: number }>();
    for (const p of pays) {
      const m = want.get(p.mode) ?? { count: 0, amount: 0 };
      m.count++;
      m.amount += p.amount;
      want.set(p.mode, m);
    }
    const got = Object.fromEntries((r.body.byPaymentMode as { mode: string; count: number; amount: number }[]).map((m) => [m.mode, { count: m.count, amount: m.amount }]));
    expect(got).toEqual(Object.fromEntries(want));
    expect(got.CARD).toBeUndefined(); // the cancelled bill's card payment is not a sale
    expect(got.UPI.count).toBe(2);
  });

  it("items / categories: quantity, revenue, net per item", async () => {
    const lines = await db.orderItem.findMany({ where: { order: { outletId: w.h.outletId, status: "PAID" } } });
    const want = new Map<string, { quantity: number; revenue: number; net: number }>();
    for (const l of lines) {
      const a = want.get(l.menuItemId) ?? { quantity: 0, revenue: 0, net: 0 };
      a.quantity += l.quantity;
      a.revenue += l.total;
      a.net += l.total - taxOf(l);
      want.set(l.menuItemId, a);
    }
    const r = await owner().call("GET", "/reports/items?limit=100");
    expect(r.status).toBe(200);
    const rows = r.body.items as { menuItemId: string; quantity: number; revenue: number; netRevenue: number }[];
    for (const [id, a] of want) {
      const row = rows.find((x) => x.menuItemId === id);
      expect(row, id).toMatchObject({ quantity: a.quantity, revenue: a.revenue, netRevenue: a.net });
    }
    expect(rows.find((x) => x.menuItemId === w.h.items.chai)?.quantity).toBe(3); // not the cancelled chai
    const c = await owner().call("GET", "/reports/categories");
    expect(c.status).toBe(200);
    const catRevenue = (c.body.categories as { revenue: number }[]).reduce((s, x) => s + x.revenue, 0);
    expect(catRevenue).toBe([...want.values()].reduce((s, a) => s + a.revenue, 0));
  });

  it("profit: revenue, COGS from stock vs. estimated, estimated bill count", async () => {
    const orders = await db.order.findMany({ where: { outletId: w.h.outletId, status: "PAID" }, include: { items: true } });
    const stocked = new Set((await db.inventoryTransaction.findMany({ where: { outletId: w.h.outletId, type: { in: ["SALE", "SALE_REVERSAL"] }, refType: "Order" } })).map((t) => t.refId));
    expect(stocked.size).toBe(1); // the bill raised after the recipe
    const recipes = await db.recipe.findMany({ where: { menuItem: { businessId: w.h.businessId } }, include: { item: true } });
    const unitCost = (menuItemId: string) => Math.round(recipes.filter((x) => x.menuItemId === menuItemId && x.variantId === null).reduce((s, x) => s + x.quantity * x.item.costPerUnit, 0));
    let est = 0;
    let estOrders = 0;
    for (const o of orders) {
      if (stocked.has(o.id)) continue;
      estOrders++;
      for (const l of o.items) est += unitCost(l.menuItemId) * l.quantity;
    }
    const revenue = orders.reduce((s, o) => s + o.grandTotal - taxOf(o) - o.roundOff, 0);
    const r = await owner().call("GET", "/reports/profit");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ revenue, cogsEstimated: est, estimatedOrders: estOrders });
    expect(est).toBe(2 * 1200); // 2 biryani × 0.15 kg × ₹80 before the recipe existed
    const biryani = (r.body.items as { menuItemId: string; quantitySold: number }[]).find((i) => i.menuItemId === w.h.items.biryani);
    expect(biryani?.quantitySold).toBe(3);
  });
});
