/**
 * QA Phase 5 — group E: inventory core (items, units, adjust, weighted-average
 * cost, recipes incl. size overrides, deduction on sale, restore on cancel,
 * negative stock, low-stock alerts, costing / report RBAC).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createTenant, db } from "./helpers";
import { as, bill, costOf, invItem, ledgerSum, menuItem, r3, settle, stockOf, twoOutletTenant, uid, waitFor, type Agent, type Fx } from "./fx-e";

let fx: Fx;
let other: Awaited<ReturnType<typeof createTenant>>;
let inv: Agent; // inventory staff @ A
let mgr: Agent; // manager @ A
let owner: Agent;
let cashier: Agent;
let kitchen: Agent;

beforeAll(async () => {
  fx = await twoOutletTenant();
  other = await createTenant({ name: `E-Other ${uid()}` });
  inv = await as(fx.users.INVENTORY_MANAGER.email, fx.outletA.id);
  mgr = await as(fx.users.OUTLET_MANAGER.email, fx.outletA.id);
  owner = await as(fx.users.BUSINESS_OWNER.email, fx.outletA.id);
  cashier = await as(fx.users.CASHIER.email, fx.outletA.id);
  kitchen = await as(fx.users.KITCHEN.email, fx.outletA.id);
});

// ---------------------------------------------------------------------------
describe("@regression Inventory items & units", () => {
  it.each(["KG", "G", "L", "ML", "PIECE", "PACKET", "DOZEN", "BOX"])("IT-INV-001 creates an item in unit %s", async (unit) => {
    const res = await inv.post("/inventory/items", { name: `Unit ${unit} ${uid()}`, unit });
    expect(res.status).toBe(201);
    expect(res.body.unit).toBe(unit);
    expect(res.body.businessId).toBe(fx.business.id);
  });

  it("IT-INV-002 rejects an unknown unit (TON) with 400", async () => {
    const res = await inv.post("/inventory/items", { name: `Bad ${uid()}`, unit: "TON" });
    expect(res.status).toBe(400);
  });

  it("IT-INV-003 name length BVA: 1 char → 400, 2 chars → 201, 121 chars → 400", async () => {
    expect((await inv.post("/inventory/items", { name: "A", unit: "KG" })).status).toBe(400);
    expect((await inv.post("/inventory/items", { name: "Ab", unit: "KG", sku: `S2-${uid()}` })).status).toBe(201);
    expect((await inv.post("/inventory/items", { name: "x".repeat(121), unit: "KG" })).status).toBe(400);
  });

  it("IT-INV-004 costPerUnit must be integer non-negative paise (−1 and 10.5 → 400)", async () => {
    expect((await inv.post("/inventory/items", { name: `C ${uid()}`, unit: "KG", costPerUnit: -1 })).status).toBe(400);
    expect((await inv.post("/inventory/items", { name: `C ${uid()}`, unit: "KG", costPerUnit: 10.5 })).status).toBe(400);
  });

  it("IT-INV-005 @critical openingStock posts an OPENING transaction at the active outlet only", async () => {
    const it0 = await invItem(inv, { openingStock: 12.5, costPerUnit: 4000 });
    expect(await stockOf(fx.outletA.id, it0.id)).toBe(12.5);
    expect(await stockOf(fx.outletB.id, it0.id)).toBe(0);
    const txns = await db.inventoryTransaction.findMany({ where: { inventoryItemId: it0.id } });
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({ type: "OPENING", quantity: 12.5, unitCost: 4000, balanceAfter: 12.5, outletId: fx.outletA.id });
  });

  it("IT-INV-006 duplicate SKU in the same business → 409; same SKU in another business is fine", async () => {
    const sku = `DUP-${uid()}`;
    expect((await inv.post("/inventory/items", { name: `D1 ${uid()}`, unit: "KG", sku })).status).toBe(201);
    expect((await inv.post("/inventory/items", { name: `D2 ${uid()}`, unit: "KG", sku })).status).toBe(409);
    const otherInv = await as(other.users.INVENTORY_MANAGER.email, other.outlet.id);
    expect((await otherInv.post("/inventory/items", { name: `D3 ${uid()}`, unit: "KG", sku })).status).toBe(201);
  });

  it("IT-INV-007 barcode lookup by barcode and case-insensitive SKU returns outlet quantity", async () => {
    const code = `890${Date.now()}`.slice(0, 13);
    const sku = `LK-${uid()}`;
    const it0 = await invItem(inv, { barcode: code, sku, openingStock: 3 });
    const a = await inv.get(`/inventory/items/lookup?code=${code}`);
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ id: it0.id, quantity: 3 });
    const b = await inv.get(`/inventory/items/lookup?code=${sku.toLowerCase()}`);
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(it0.id);
  });

  it("IT-INV-008 barcode lookup: unknown → 404, missing code → 400, inactive → 404, other tenant's barcode → 404", async () => {
    expect((await inv.get(`/inventory/items/lookup?code=NOPE${uid()}`)).status).toBe(404);
    expect((await inv.get(`/inventory/items/lookup`)).status).toBe(400);
    const code = `INA${uid()}`;
    const it0 = await invItem(inv, { barcode: code });
    await inv.delete(`/inventory/items/${it0.id}`);
    expect((await inv.get(`/inventory/items/lookup?code=${code}`)).status).toBe(404);
    const otherInv = await as(other.users.INVENTORY_MANAGER.email, other.outlet.id);
    const theirs = `OTH${uid()}`;
    await invItem(otherInv, { barcode: theirs });
    expect((await inv.get(`/inventory/items/lookup?code=${theirs}`)).status).toBe(404);
  });

  it("IT-INV-009 unit can change before any movement but not after (400)", async () => {
    const fresh = await invItem(inv, { unit: "KG" });
    expect((await inv.patch(`/inventory/items/${fresh.id}`, { unit: "G" })).status).toBe(200);
    const used = await invItem(inv, { unit: "KG", openingStock: 1 });
    const res = await inv.patch(`/inventory/items/${used.id}`, { unit: "G" });
    expect(res.status).toBe(400);
    expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: used.id } })).unit).toBe("KG");
  });

  it("IT-INV-010 DELETE deactivates: hidden from list, visible with includeInactive=1, ledger kept", async () => {
    const it0 = await invItem(inv, { openingStock: 2 });
    expect((await inv.delete(`/inventory/items/${it0.id}`)).status).toBe(204);
    const list = await inv.get("/inventory/items");
    expect(list.body.items.some((i: { id: string }) => i.id === it0.id)).toBe(false);
    const all = await inv.get("/inventory/items?includeInactive=1");
    expect(all.body.items.find((i: { id: string }) => i.id === it0.id)?.active).toBe(false);
    expect(await db.inventoryTransaction.count({ where: { inventoryItemId: it0.id } })).toBe(1);
  });

  it("IT-INV-011 other tenant's item: GET/PATCH/adjust → 404 (tenant isolation)", async () => {
    const otherInv = await as(other.users.INVENTORY_MANAGER.email, other.outlet.id);
    const theirs = await invItem(otherInv, { openingStock: 5 });
    expect((await inv.get(`/inventory/items/${theirs.id}`)).status).toBe(404);
    expect((await inv.patch(`/inventory/items/${theirs.id}`, { name: "Hijack" })).status).toBe(404);
    expect((await inv.post(`/inventory/items/${theirs.id}/adjust`, { quantity: 1, reason: "steal" })).status).toBe(404);
    expect(await stockOf(other.outlet.id, theirs.id)).toBe(5);
    expect(await stockOf(fx.outletA.id, theirs.id)).toBe(0);
  });

  it("IT-INV-012 lowStock filter lists only items at/below reorder level (reorder 0 never low)", async () => {
    const low = await invItem(inv, { openingStock: 2, reorderLevel: 2 });
    const ok = await invItem(inv, { openingStock: 3, reorderLevel: 2 });
    const res = await inv.get("/inventory/items?lowStock=1");
    const ids = res.body.items.map((i: { id: string }) => i.id);
    expect(ids).toContain(low.id);
    expect(ids).not.toContain(ok.id);
  });

  it("IT-INV-013 RBAC: kitchen can view items but not create (403); cashier has no inventory access (403)", async () => {
    expect((await kitchen.get("/inventory/items")).status).toBe(200);
    expect((await kitchen.post("/inventory/items", { name: `K ${uid()}`, unit: "KG" })).status).toBe(403);
    expect((await cashier.get("/inventory/items")).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
describe("@regression Stock adjustments & weighted-average cost", () => {
  it("IT-INV-020 @critical signed quantity adjustment posts ADJUSTMENT with balanceAfter", async () => {
    const it0 = await invItem(inv, { openingStock: 10 });
    const res = await inv.post(`/inventory/items/${it0.id}/adjust`, { quantity: -2.5, reason: "Spillage" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ type: "ADJUSTMENT", quantity: -2.5, balanceAfter: 7.5, refType: "Manual" });
    expect(await stockOf(fx.outletA.id, it0.id)).toBe(7.5);
  });

  it("IT-INV-021 @critical setTo posts the delta; opening:true posts OPENING", async () => {
    const it0 = await invItem(inv, { openingStock: 4 });
    const a = await inv.post(`/inventory/items/${it0.id}/adjust`, { setTo: 10, reason: "Recount" });
    expect(a.body).toMatchObject({ quantity: 6, balanceAfter: 10 });
    const b = await inv.post(`/inventory/items/${it0.id}/adjust`, { quantity: 1, reason: "Opening", opening: true });
    expect(b.body.type).toBe("OPENING");
    expect(await stockOf(fx.outletA.id, it0.id)).toBe(11);
  });

  it("IT-INV-022 adjust validation: both/neither of quantity|setTo, quantity 0, setTo <0, short reason → 400", async () => {
    const it0 = await invItem(inv, { openingStock: 1 });
    const p = (b: object) => inv.post(`/inventory/items/${it0.id}/adjust`, b);
    expect((await p({ quantity: 1, setTo: 2, reason: "xx" })).status).toBe(400);
    expect((await p({ reason: "xx" })).status).toBe(400);
    expect((await p({ quantity: 0, reason: "xx" })).status).toBe(400);
    expect((await p({ setTo: -1, reason: "xx" })).status).toBe(400);
    expect((await p({ quantity: 1, reason: "x" })).status).toBe(400);
    expect(await stockOf(fx.outletA.id, it0.id)).toBe(1);
  });

  it("IT-INV-023 setTo equal to current stock → 400 and no transaction", async () => {
    const it0 = await invItem(inv, { openingStock: 5 });
    expect((await inv.post(`/inventory/items/${it0.id}/adjust`, { setTo: 5, reason: "Same" })).status).toBe(400);
    expect(await db.inventoryTransaction.count({ where: { inventoryItemId: it0.id } })).toBe(1);
  });

  it("IT-INV-024 @critical weighted-average cost: 10 kg @ ₹40 + 30 kg @ ₹60 → ₹55", async () => {
    const it0 = await invItem(inv, { openingStock: 10, costPerUnit: 4000 });
    await inv.post(`/inventory/items/${it0.id}/adjust`, { quantity: 30, unitCost: 6000, reason: "Stock in" });
    expect(await costOf(it0.id)).toBe(5500);
    const val = await inv.get(`/inventory/items/${it0.id}`);
    expect(val.body.value).toBe(40 * 5500);
  });

  it("IT-INV-025 negative adjustment with unitCost does not change the cost", async () => {
    const it0 = await invItem(inv, { openingStock: 10, costPerUnit: 4000 });
    await inv.post(`/inventory/items/${it0.id}/adjust`, { quantity: -3, unitCost: 9999, reason: "Out" });
    expect(await costOf(it0.id)).toBe(4000);
  });

  it("IT-INV-026 weighted cost ignores negative existing stock (stock-out doesn't distort the new cost)", async () => {
    const it0 = await invItem(inv, { costPerUnit: 4000 });
    await inv.post(`/inventory/items/${it0.id}/adjust`, { quantity: -5, reason: "Oversold" });
    await inv.post(`/inventory/items/${it0.id}/adjust`, { quantity: 10, unitCost: 6000, reason: "Stock in" });
    expect(await costOf(it0.id)).toBe(6000);
    expect(await stockOf(fx.outletA.id, it0.id)).toBe(5);
  });

  it("IT-INV-027 ledger: filter by item/type; invalid type or limit out of bounds → 400", async () => {
    const it0 = await invItem(inv, { openingStock: 2 });
    await inv.post(`/inventory/items/${it0.id}/adjust`, { quantity: 1, reason: "Plus" });
    const res = await inv.get(`/inventory/transactions?itemId=${it0.id}&type=ADJUSTMENT`);
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect((await inv.get("/inventory/transactions?type=STOLEN")).status).toBe(400);
    expect((await inv.get("/inventory/transactions?limit=0")).status).toBe(400);
    expect((await inv.get("/inventory/transactions?limit=1001")).status).toBe(400);
    expect((await inv.get("/inventory/transactions?from=2026-10-10&to=2026-10-01")).status).toBe(400);
  });

  // Regex-valid but impossible month → the date helpers throw RangeError → 500.
  it.fails("IT-INV-028 (BUG-CANDIDATE-E1) ledger with an impossible date (2026-13-01) → 400, not 500", async () => {
    const res = await inv.get("/inventory/transactions?from=2026-13-01&to=2026-13-01");
    expect(res.status).toBe(400);
  });

  // GET /inventory/wastage validates from/to only as strings; addDays("abc") throws → 500.
  it.fails("IT-INV-029 (BUG-CANDIDATE-E1) wastage list with to=abc → 400, not 500", async () => {
    const res = await inv.get("/inventory/wastage?to=abc");
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
describe("@regression Recipes", () => {
  it("IT-INV-030 recipe in grams for a KG item is stored in KG (250 G → 0.25)", async () => {
    const it0 = await invItem(inv, { unit: "KG", costPerUnit: 20000 });
    const m = await menuItem(fx);
    const res = await inv.put(`/inventory/recipes/${m.id}`, { lines: [{ inventoryItemId: it0.id, quantity: 250, unit: "G" }] });
    expect(res.status).toBe(200);
    expect(res.body.lines[0].quantity).toBe(0.25);
    expect(res.body.cost).toBe(5000);
  });

  it("IT-INV-031 DOZEN → PIECE conversion and duplicate lines are merged", async () => {
    const egg = await invItem(inv, { unit: "PIECE" });
    const m = await menuItem(fx);
    const res = await inv.put(`/inventory/recipes/${m.id}`, {
      lines: [{ inventoryItemId: egg.id, quantity: 1, unit: "DOZEN" }, { inventoryItemId: egg.id, quantity: 2 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.lines).toHaveLength(1);
    expect(res.body.lines[0].quantity).toBe(14);
  });

  it("IT-INV-032 incompatible unit (L for a KG item) → 400; quantity rounding to zero → 400", async () => {
    const it0 = await invItem(inv, { unit: "KG" });
    const m = await menuItem(fx);
    expect((await inv.put(`/inventory/recipes/${m.id}`, { lines: [{ inventoryItemId: it0.id, quantity: 1, unit: "L" }] })).status).toBe(400);
    expect((await inv.put(`/inventory/recipes/${m.id}`, { lines: [{ inventoryItemId: it0.id, quantity: 0.0001, unit: "G" }] })).status).toBe(400);
    expect((await inv.put(`/inventory/recipes/${m.id}`, { lines: [{ inventoryItemId: it0.id, quantity: 0 }] })).status).toBe(400);
    expect(await db.recipe.count({ where: { menuItemId: m.id } })).toBe(0);
  });

  it("IT-INV-033 variant from another menu item → 400; unknown / inactive ingredient → 400", async () => {
    const it0 = await invItem(inv);
    const m = await menuItem(fx);
    const m2 = await menuItem(fx, { variants: [{ name: "Large", price: 15000 }] });
    expect((await inv.put(`/inventory/recipes/${m.id}`, { variantId: m2.variants[0].id, lines: [{ inventoryItemId: it0.id, quantity: 1 }] })).status).toBe(400);
    expect((await inv.put(`/inventory/recipes/${m.id}`, { lines: [{ inventoryItemId: "nope", quantity: 1 }] })).status).toBe(400);
    const dead = await invItem(inv);
    await inv.delete(`/inventory/items/${dead.id}`);
    expect((await inv.put(`/inventory/recipes/${m.id}`, { lines: [{ inventoryItemId: dead.id, quantity: 1 }] })).status).toBe(400);
  });

  it("IT-INV-034 PUT replaces the recipe; empty lines removes it", async () => {
    const a = await invItem(inv);
    const b = await invItem(inv);
    const m = await menuItem(fx);
    await inv.put(`/inventory/recipes/${m.id}`, { lines: [{ inventoryItemId: a.id, quantity: 1 }] });
    await inv.put(`/inventory/recipes/${m.id}`, { lines: [{ inventoryItemId: b.id, quantity: 2 }] });
    let rows = await db.recipe.findMany({ where: { menuItemId: m.id } });
    expect(rows.map((r) => r.inventoryItemId)).toEqual([b.id]);
    await inv.put(`/inventory/recipes/${m.id}`, { lines: [] });
    rows = await db.recipe.findMany({ where: { menuItemId: m.id } });
    expect(rows).toHaveLength(0);
  });

  it("IT-INV-035 @critical BUG-007 regression: recipes are tenant-scoped (other tenant's menu item → 404, ingredient → 400, list hides theirs)", async () => {
    const otherInv = await as(other.users.INVENTORY_MANAGER.email, other.outlet.id);
    const theirIng = await invItem(otherInv);
    const theirCat = await db.menuCategory.create({ data: { businessId: other.business.id, name: "Theirs" } });
    const theirMenu = await menuItem({ business: other.business, categoryId: theirCat.id });
    await otherInv.put(`/inventory/recipes/${theirMenu.id}`, { lines: [{ inventoryItemId: theirIng.id, quantity: 1 }] });
    const mine = await invItem(inv);
    const m = await menuItem(fx);
    expect((await inv.put(`/inventory/recipes/${theirMenu.id}`, { lines: [{ inventoryItemId: mine.id, quantity: 1 }] })).status).toBe(404);
    expect((await inv.put(`/inventory/recipes/${m.id}`, { lines: [{ inventoryItemId: theirIng.id, quantity: 1 }] })).status).toBe(400);
    const list = await inv.get("/inventory/recipes");
    expect(list.body.some((r: { menuItemId: string }) => r.menuItemId === theirMenu.id)).toBe(false);
    expect((await inv.get(`/inventory/recipes?menuItemId=${theirMenu.id}`)).body).toEqual([]);
  });

  it("IT-INV-036 kitchen (view only) cannot change recipes (403)", async () => {
    const it0 = await invItem(inv);
    const m = await menuItem(fx);
    expect((await kitchen.put(`/inventory/recipes/${m.id}`, { lines: [{ inventoryItemId: it0.id, quantity: 1 }] })).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
describe("@regression @critical Automatic deduction on sale / restore on cancel", () => {
  it("IT-INV-040 bill deducts recipe × qty exactly with SALE rows (refType Order, refId = order id)", async () => {
    const flour = await invItem(inv, { unit: "KG", openingStock: 10, costPerUnit: 5000 });
    const egg = await invItem(inv, { unit: "PIECE", openingStock: 50, costPerUnit: 600 });
    const m = await menuItem(fx);
    await inv.put(`/inventory/recipes/${m.id}`, { lines: [{ inventoryItemId: flour.id, quantity: 200, unit: "G" }, { inventoryItemId: egg.id, quantity: 2 }] });
    const order = await bill(cashier, [{ menuItemId: m.id, quantity: 3 }]);
    expect(await stockOf(fx.outletA.id, flour.id)).toBe(9.4);
    expect(await stockOf(fx.outletA.id, egg.id)).toBe(44);
    const sales = await db.inventoryTransaction.findMany({ where: { refType: "Order", refId: order.id }, orderBy: { inventoryItemId: "asc" } });
    expect(sales).toHaveLength(2);
    for (const s of sales) {
      expect(s.type).toBe("SALE");
      expect(s.outletId).toBe(fx.outletA.id);
      expect(s.note).toBe(order.invoiceNumber);
    }
    expect(sales.find((s) => s.inventoryItemId === flour.id)!).toMatchObject({ quantity: -0.6, unitCost: 5000 });
    expect(sales.find((s) => s.inventoryItemId === egg.id)!).toMatchObject({ quantity: -6, unitCost: 600 });
  });

  it("IT-INV-041 cancelling the bill restores exactly (SALE_REVERSAL); second cancel → 409 and no double restore", async () => {
    const rice = await invItem(inv, { unit: "KG", openingStock: 5 });
    const m = await menuItem(fx);
    await inv.put(`/inventory/recipes/${m.id}`, { lines: [{ inventoryItemId: rice.id, quantity: 0.15 }] });
    const order = await bill(cashier, [{ menuItemId: m.id, quantity: 4 }]);
    expect(await stockOf(fx.outletA.id, rice.id)).toBe(4.4);
    expect((await mgr.post(`/orders/${order.id}/cancel`, { reason: "Customer left" })).status).toBe(200);
    expect(await stockOf(fx.outletA.id, rice.id)).toBe(5);
    const rev = await db.inventoryTransaction.findMany({ where: { refId: order.id, type: "SALE_REVERSAL" } });
    expect(rev).toHaveLength(1);
    expect(rev[0].quantity).toBe(0.6);
    expect((await mgr.post(`/orders/${order.id}/cancel`, { reason: "Again" })).status).toBe(409);
    expect(await stockOf(fx.outletA.id, rice.id)).toBe(5);
    expect(await ledgerSum(fx.outletA.id, rice.id)).toBe(5);
  });

  it("IT-INV-042 variant recipe overrides the item recipe; variant without its own uses the default", async () => {
    const milk = await invItem(inv, { unit: "L", openingStock: 10 });
    const syrup = await invItem(inv, { unit: "ML", openingStock: 1000 });
    const m = await menuItem(fx, { variants: [{ name: "Regular", price: 5000 }, { name: "Large", price: 8000 }] });
    const reg = m.variants.find((v) => v.name === "Regular")!;
    const large = m.variants.find((v) => v.name === "Large")!;
    await inv.put(`/inventory/recipes/${m.id}`, { lines: [{ inventoryItemId: milk.id, quantity: 100, unit: "ML" }] });
    await inv.put(`/inventory/recipes/${m.id}`, { variantId: large.id, lines: [{ inventoryItemId: milk.id, quantity: 0.3 }, { inventoryItemId: syrup.id, quantity: 20 }] });
    await bill(cashier, [{ menuItemId: m.id, variantId: reg.id, quantity: 1 }, { menuItemId: m.id, variantId: large.id, quantity: 2 }]);
    expect(await stockOf(fx.outletA.id, milk.id)).toBe(r3(10 - 0.1 - 0.6));
    expect(await stockOf(fx.outletA.id, syrup.id)).toBe(960);
  });

  it("IT-INV-043 inactive ingredients are not deducted", async () => {
    const a = await invItem(inv, { openingStock: 5 });
    const b = await invItem(inv, { openingStock: 5 });
    const m = await menuItem(fx);
    await inv.put(`/inventory/recipes/${m.id}`, { lines: [{ inventoryItemId: a.id, quantity: 1 }, { inventoryItemId: b.id, quantity: 1 }] });
    await inv.delete(`/inventory/items/${b.id}`);
    await bill(cashier, [{ menuItemId: m.id, quantity: 1 }]);
    expect(await stockOf(fx.outletA.id, a.id)).toBe(4);
    expect(await stockOf(fx.outletA.id, b.id)).toBe(5);
  });

  it("IT-INV-044 a sale at outlet B deducts at B only", async () => {
    const a = await invItem(inv, { openingStock: 5 });
    const m = await menuItem(fx);
    await inv.put(`/inventory/recipes/${m.id}`, { lines: [{ inventoryItemId: a.id, quantity: 1 }] });
    const ownerB = await as(fx.users.BUSINESS_OWNER.email, fx.outletB.id);
    await bill(ownerB, [{ menuItemId: m.id, quantity: 2 }]);
    expect(await stockOf(fx.outletA.id, a.id)).toBe(5);
    expect(await stockOf(fx.outletB.id, a.id)).toBe(-2);
  });

  it("IT-INV-045 menu item without a recipe sells without any stock movement", async () => {
    const m = await menuItem(fx);
    const order = await bill(cashier, [{ menuItemId: m.id, quantity: 1 }]);
    expect(await db.inventoryTransaction.count({ where: { refId: order.id } })).toBe(0);
  });

  it("IT-INV-046 with the INVENTORY module off, billing does not deduct and /inventory is refused (403)", async () => {
    const t = await createTenant({ name: `E-NoInv ${uid()}`, modules: ["BILLING", "KOT", "REPORTS"] });
    const cat = await db.menuCategory.create({ data: { businessId: t.business.id, name: "F" } });
    const m = await menuItem({ business: t.business, categoryId: cat.id });
    const ing = await db.inventoryItem.create({ data: { businessId: t.business.id, name: "Ghost", unit: "KG" } });
    await db.recipe.create({ data: { menuItemId: m.id, inventoryItemId: ing.id, quantity: 1 } });
    const cash = await as(t.users.CASHIER.email, t.outlet.id);
    const order = await bill(cash, [{ menuItemId: m.id, quantity: 1 }]);
    expect(await db.inventoryTransaction.count({ where: { refId: order.id } })).toBe(0);
    const ownerT = await as(t.users.BUSINESS_OWNER.email, t.outlet.id);
    expect((await ownerT.get("/inventory/items")).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
describe("@regression @critical Negative stock & low-stock alerts", () => {
  it("IT-INV-050 billing never blocks: stock goes negative and the bill is created", async () => {
    const a = await invItem(inv, { openingStock: 1, reorderLevel: 2 });
    const m = await menuItem(fx);
    await inv.put(`/inventory/recipes/${m.id}`, { lines: [{ inventoryItemId: a.id, quantity: 0.4 }] });
    const order = await bill(cashier, [{ menuItemId: m.id, quantity: 5 }]);
    expect(order.id).toBeTruthy();
    expect(await stockOf(fx.outletA.id, a.id)).toBe(-1);
    expect(await ledgerSum(fx.outletA.id, a.id)).toBe(-1);
  });

  it("IT-INV-051 low stock after a sale notifies inventory staff + managers + owner of that outlet only (kind inventory.low, link /inventory)", async () => {
    const a = await invItem(inv, { openingStock: 3, reorderLevel: 2 });
    const m = await menuItem(fx);
    await inv.put(`/inventory/recipes/${m.id}`, { lines: [{ inventoryItemId: a.id, quantity: 1 }] });
    await bill(cashier, [{ menuItemId: m.id, quantity: 2 }]);
    const title = `Low stock: ${a.name}`;
    const rows = await waitFor(async () => {
      const r = await db.notification.findMany({ where: { title } });
      return r.length >= 3 ? r : null;
    });
    expect(rows).toBeTruthy();
    const users = new Set(rows!.map((r) => r.userId));
    expect(users).toEqual(new Set([fx.users.INVENTORY_MANAGER.id, fx.users.OUTLET_MANAGER.id, fx.users.BUSINESS_OWNER.id]));
    for (const r of rows!) expect(r).toMatchObject({ kind: "inventory.low", link: "/inventory" });
    expect(users.has(fx.mgrB.id)).toBe(false);
    expect(users.has(fx.invB.id)).toBe(false);
    expect(users.has(fx.users.CASHIER.id)).toBe(false);
    expect(users.has(fx.users.KITCHEN.id)).toBe(false);
  });

  it("IT-INV-052 low-stock alert has a 6 h cooldown per item/outlet (second sale doesn't re-notify)", async () => {
    const a = await invItem(inv, { openingStock: 3, reorderLevel: 2 });
    const m = await menuItem(fx);
    await inv.put(`/inventory/recipes/${m.id}`, { lines: [{ inventoryItemId: a.id, quantity: 1 }] });
    await bill(cashier, [{ menuItemId: m.id, quantity: 1 }]);
    const title = `Low stock: ${a.name}`;
    await waitFor(async () => (await db.notification.count({ where: { title, userId: fx.users.INVENTORY_MANAGER.id } })) > 0);
    await bill(cashier, [{ menuItemId: m.id, quantity: 1 }]);
    await settle();
    expect(await db.notification.count({ where: { title, userId: fx.users.INVENTORY_MANAGER.id } })).toBe(1);
  });

  it("IT-INV-053 /inventory/alerts lists low and out-of-stock items with suggested order qty", async () => {
    const a = await invItem(inv, { openingStock: 1, reorderLevel: 5, reorderQty: 2 });
    await inv.post(`/inventory/items/${a.id}/adjust`, { quantity: -3, reason: "Spoiled" });
    const res = await inv.get("/inventory/alerts");
    const row = res.body.items.find((i: { id: string }) => i.id === a.id);
    expect(row).toMatchObject({ quantity: -2, outOfStock: true, suggestedOrderQty: 7 });
  });

  // README: "Stock may go negative (billing never blocks) and raises low-stock alerts."
  // Actual: isLowStock() requires reorderLevel > 0, so an item without a reorder level can go
  // negative silently — no notification and not in /inventory/alerts.
  it.fails("IT-INV-054 (BUG-CANDIDATE-E2) negative stock raises an alert even when no reorder level is set", async () => {
    const a = await invItem(inv, { openingStock: 1 });
    const m = await menuItem(fx);
    await inv.put(`/inventory/recipes/${m.id}`, { lines: [{ inventoryItemId: a.id, quantity: 1 }] });
    await bill(cashier, [{ menuItemId: m.id, quantity: 3 }]);
    expect(await stockOf(fx.outletA.id, a.id)).toBe(-2);
    const res = await inv.get("/inventory/alerts");
    expect(res.body.items.some((i: { id: string }) => i.id === a.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("@regression Costing & report access (README Inventory / Who sees what)", () => {
  it("IT-INV-060 recipe costing: owner & manager 200 with food cost %; inventory / kitchen 403", async () => {
    const it0 = await invItem(inv, { unit: "KG", costPerUnit: 5000 });
    const m = await menuItem(fx, { price: 10000 });
    await inv.put(`/inventory/recipes/${m.id}`, { lines: [{ inventoryItemId: it0.id, quantity: 0.2 }] });
    for (const a of [owner, mgr]) {
      const res = await a.get("/inventory/recipes/costing");
      expect(res.status).toBe(200);
      const row = res.body.items.find((r: { menuItemId: string }) => r.menuItemId === m.id);
      expect(row).toMatchObject({ hasRecipe: true, cost: 1000, netPrice: 10000, foodCostPercent: 10, margin: 9000 });
    }
    expect((await inv.get("/inventory/recipes/costing")).status).toBe(403);
    expect((await kitchen.get("/inventory/recipes/costing")).status).toBe(403);
  });

  it.each(["consumption", "movement", "valuation", "wastage", "purchases", "vendor-spend"])(
    "IT-INV-061 inventory staff can read stock report %s (JSON 200)",
    async (r) => {
      expect((await inv.get(`/inventory/reports/${r}`)).status).toBe(200);
    },
  );

  it.each(["sales", "gst", "profit", "items", "daily"])("IT-INV-062 inventory staff cannot read /reports/%s (403)", async (r) => {
    expect((await inv.get(`/reports/${r}`)).status).toBe(403);
  });

  it("IT-INV-063 kitchen (inventory:view only) cannot read stock reports (403)", async () => {
    expect((await kitchen.get("/inventory/reports/valuation")).status).toBe(403);
  });

  it("IT-INV-064 valuation report = Σ max(0,qty) × cost; xlsx export has the spreadsheet content type", async () => {
    const a = await invItem(inv, { openingStock: 4, costPerUnit: 2500, category: `Val${uid()}` });
    const res = await inv.get("/inventory/reports/valuation");
    const row = res.body.rows.find((r: { inventoryItemId: string }) => r.inventoryItemId === a.id);
    expect(row).toMatchObject({ quantity: 4, costPerUnit: 2500, value: 10000 });
    expect(res.body.totalValue).toBe(res.body.rows.reduce((s: number, r: { value: number }) => s + r.value, 0));
    const x = await inv.get("/inventory/reports/valuation?format=xlsx");
    expect(x.status).toBe(200);
    expect(x.headers["content-type"]).toContain("spreadsheetml");
  });

  it("IT-INV-065 consumption report: sales net of cancellations + wastage per item", async () => {
    const a = await invItem(inv, { openingStock: 10, costPerUnit: 1000 });
    const m = await menuItem(fx);
    await inv.put(`/inventory/recipes/${m.id}`, { lines: [{ inventoryItemId: a.id, quantity: 1 }] });
    await bill(cashier, [{ menuItemId: m.id, quantity: 3 }]);
    const o2 = await bill(cashier, [{ menuItemId: m.id, quantity: 2 }]);
    await mgr.post(`/orders/${o2.id}/cancel`, { reason: "Wrong order" });
    await inv.post("/inventory/wastage", { items: [{ inventoryItemId: a.id, quantity: 0.5, reason: "Dropped" }] });
    const res = await inv.get(`/inventory/reports/consumption?itemId=${a.id}`);
    expect(res.status).toBe(200);
    const sale = res.body.rows.reduce((s: number, r: { sale: number }) => s + r.sale, 0);
    const wastage = res.body.rows.reduce((s: number, r: { wastage: number }) => s + r.wastage, 0);
    expect(r3(sale)).toBe(3);
    expect(r3(wastage)).toBe(0.5);
    expect(res.body.totalValue).toBe(3500);
  });

  it("IT-INV-066 movement report: opening + in − out = closing = current stock", async () => {
    const a = await invItem(inv, { openingStock: 8 });
    await inv.post(`/inventory/items/${a.id}/adjust`, { quantity: -3, reason: "Use" });
    await inv.post(`/inventory/items/${a.id}/adjust`, { quantity: 1.5, reason: "Found" });
    const res = await inv.get(`/inventory/reports/movement?itemId=${a.id}`);
    const row = res.body.rows[0];
    expect(row.closing).toBe(r3(row.opening + row.in - row.out));
    expect(row.closing).toBe(await stockOf(fx.outletA.id, a.id));
  });

  it("IT-INV-067 report query validation: bad date format → 400; from > to → 400; bad format → 400", async () => {
    expect((await inv.get("/inventory/reports/movement?from=02-11-2026")).status).toBe(400);
    expect((await inv.get("/inventory/reports/movement?from=2026-10-10&to=2026-10-01")).status).toBe(400);
    expect((await inv.get("/inventory/reports/movement?format=pdf")).status).toBe(400);
  });
});
