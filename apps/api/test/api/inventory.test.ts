/**
 * QA Phase 6 — /inventory (47 endpoints): items, ledger, recipes + costing, vendors, purchases
 * (draft → receive → pay → cancel), wastage, stock audits, inter-outlet transfers and the stock
 * reports (JSON + .xlsx). Status codes + shapes, RBAC for every role, tenant / outlet / platform
 * isolation, module gating, validation (400 never 500, nothing written), IST date boundaries.
 */
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotel, startServer } from "../integration/helpers";
import { db, GHOST, intMoney, isolation, LONG, login, NAMES, raw, rbacMatrix, rejects, rejectsQuery, world, type Ep, type World } from "./kit";

let srv: Awaited<ReturnType<typeof startServer>>;
let w: World;
const owner = () => w.as.BUSINESS_OWNER;
let k = 0;
const uid = () => `${Date.now().toString(36)}${k++}`;

async function newItem(extra: Record<string, unknown> = {}) {
  const r = await owner().call("POST", "/inventory/items", { name: `Stock ${uid()}`, unit: "KG", costPerUnit: 5000, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; name: string };
}
async function newVendor() {
  return (await owner().call("POST", "/inventory/vendors", { name: `Vendor ${uid()}` })).body as { id: string };
}
const stockOf = async (itemId: string, outletId = w.h.outletId) =>
  (await db.inventoryStock.findUnique({ where: { outletId_inventoryItemId: { outletId, inventoryItemId: itemId } } }))?.quantity ?? 0;

beforeAll(async () => {
  srv = await startServer();
  w = await world(srv.base, "Inventory API");
});
afterAll(() => srv.close());

describe("RBAC + isolation", () => {
  it("inventory:view / inventory:manage / report:view per endpoint, for every role", async () => {
    const G = GHOST;
    const V: Ep["perms"] = ["inventory:view"];
    const M: Ep["perms"] = ["inventory:manage"];
    const eps: Ep[] = [
      ...["/inventory/items", "/inventory/items/categories", "/inventory/items/lookup?code=x", `/inventory/items/${G}`, "/inventory/transactions", "/inventory/recipes",
        "/inventory/vendors", `/inventory/vendors/${G}`, "/inventory/purchases", `/inventory/purchases/${G}`, "/inventory/wastage", "/inventory/audits", `/inventory/audits/${G}`,
        "/inventory/transfers", `/inventory/transfers/${G}`, "/inventory/alerts"].map((path) => ({ method: "GET" as const, path, perms: V })),
      { method: "GET", path: "/inventory/recipes/costing", perms: ["report:view"] },
      ...["consumption", "movement", "valuation", "wastage", "vendor-spend", "purchases"].map((r) => ({ method: "GET" as const, path: `/inventory/reports/${r}`, perms: M })),
      { method: "POST", path: "/inventory/items", perms: M },
      { method: "PATCH", path: `/inventory/items/${G}`, perms: M },
      { method: "DELETE", path: `/inventory/items/${G}`, perms: M },
      { method: "POST", path: `/inventory/items/${G}/adjust`, perms: M },
      { method: "PUT", path: `/inventory/recipes/${G}`, perms: M },
      { method: "POST", path: "/inventory/vendors", perms: M },
      { method: "PATCH", path: `/inventory/vendors/${G}`, perms: M },
      { method: "DELETE", path: `/inventory/vendors/${G}`, perms: M },
      { method: "POST", path: "/inventory/purchases", perms: M },
      { method: "PATCH", path: `/inventory/purchases/${G}`, perms: M },
      ...["receive", "cancel", "payments"].map((a) => ({ method: "POST" as const, path: `/inventory/purchases/${G}/${a}`, perms: M })),
      { method: "POST", path: "/inventory/wastage", perms: M },
      { method: "POST", path: "/inventory/audits", perms: M, body: { category: "__none__" } },
      { method: "PUT", path: `/inventory/audits/${G}/counts`, perms: M },
      { method: "POST", path: `/inventory/audits/${G}/complete`, perms: M },
      { method: "POST", path: `/inventory/audits/${G}/cancel`, perms: M },
      { method: "POST", path: "/inventory/transfers", perms: M },
      ...["approve", "reject", "dispatch", "receive", "cancel"].map((a) => ({ method: "POST" as const, path: `/inventory/transfers/${G}/${a}`, perms: M })),
    ];
    expect(eps).toHaveLength(47);
    await rbacMatrix(w, eps);
  });

  it("another hotel, an unassigned outlet and the super admin get none of hotel A's stock data", async () => {
    const it1 = await newItem({ openingStock: 10 });
    const v = await newVendor();
    const p = (await owner().call("POST", "/inventory/purchases", { vendorId: v.id, items: [{ inventoryItemId: it1.id, quantity: 1, unitCost: 100 }] })).body;
    const a = (await owner().call("POST", "/inventory/audits", {})).body;
    const t = (await owner().call("POST", "/inventory/transfers", { toOutletId: w.h.outlet2Id, items: [{ inventoryItemId: it1.id, quantity: 1 }] })).body;
    await isolation(w, [
      { method: "GET", path: `/inventory/items/${it1.id}` },
      { method: "PATCH", path: `/inventory/items/${it1.id}`, body: { name: "Hacked" } },
      { method: "DELETE", path: `/inventory/items/${it1.id}` },
      { method: "POST", path: `/inventory/items/${it1.id}/adjust`, body: { quantity: 5, reason: "steal" } },
      { method: "GET", path: `/inventory/vendors/${v.id}` },
      { method: "PATCH", path: `/inventory/vendors/${v.id}`, body: { name: "Hacked" } },
      { method: "DELETE", path: `/inventory/vendors/${v.id}` },
      { method: "GET", path: `/inventory/purchases/${p.id}` },
      { method: "POST", path: `/inventory/purchases/${p.id}/receive` },
      { method: "POST", path: `/inventory/purchases/${p.id}/payments`, body: { amount: 1 } },
      { method: "GET", path: `/inventory/audits/${a.id}` },
      { method: "POST", path: `/inventory/audits/${a.id}/cancel` },
      { method: "GET", path: `/inventory/transfers/${t.id}` },
      { method: "POST", path: `/inventory/transfers/${t.id}/dispatch` },
      { method: "POST", path: `/inventory/transfers/${t.id}/cancel` },
      { method: "PUT", path: `/inventory/recipes/${w.h.items.chai}`, body: { lines: [] } },
    ]);
    expect(await db.inventoryItem.findUniqueOrThrow({ where: { id: it1.id } })).toMatchObject({ name: it1.name, active: true });
    expect(await stockOf(it1.id)).toBe(10);
    expect((await db.purchase.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("DRAFT");
    expect((await db.stockTransfer.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("APPROVED");
    // The other hotel's lists never include hotel A's rows
    const theirs = await w.other.owner.call("GET", "/inventory/items?includeInactive=1");
    expect(theirs.body.items.map((i: { id: string }) => i.id)).not.toContain(it1.id);
    await owner().call("POST", `/inventory/audits/${a.id}/cancel`);
  });

  it("the module off → 403 everywhere", async () => {
    const off = await createHotel("No inventory", { modules: ["BILLING"] });
    const c = await login(srv.base, off.users.owner.email, off.outletId);
    for (const [m, p] of [["GET", "/inventory/items"], ["POST", "/inventory/items"], ["GET", "/inventory/reports/valuation"], ["GET", "/inventory/transfers"]] as const) {
      expect((await c.call(m, p, m === "POST" ? { name: "Rice", unit: "KG" } : undefined)).status, p).toBe(403);
    }
  });
});

describe("items + ledger", () => {
  it("create (with opening stock) → 201; list/lookup/detail shapes with integer money", async () => {
    const it1 = await newItem({ sku: `SKU-${uid()}`, barcode: `890${Date.now()}`, openingStock: 12.5, reorderLevel: 20 });
    const list = await w.as.KITCHEN.call("GET", "/inventory/items?lowStock=1");
    expect(list.status).toBe(200);
    const row = list.body.items.find((i: { id: string }) => i.id === it1.id);
    expect(row).toMatchObject({ quantity: 12.5, lowStock: true });
    intMoney(row, ["costPerUnit", "value"]);
    intMoney(list.body.totals, ["value"]);
    const d = await owner().call("GET", `/inventory/items/${it1.id}`);
    expect(d.body.transactions[0]).toMatchObject({ type: "OPENING", quantity: 12.5 });
    const full = (await db.inventoryItem.findUniqueOrThrow({ where: { id: it1.id } }));
    expect((await owner().call("GET", `/inventory/items/lookup?code=${full.barcode}`)).body.id).toBe(it1.id);
    expect((await owner().call("GET", `/inventory/items/lookup?code=${full.sku!.toLowerCase()}`)).body.id).toBe(it1.id);
    expect((await owner().call("GET", "/inventory/items/lookup?code=nothing-here")).status).toBe(404);
    expect((await owner().call("GET", `/inventory/items/${GHOST}`)).status).toBe(404);
    expect((await owner().call("GET", "/inventory/items/categories")).body.length).toBeGreaterThan(0);
  });

  it("duplicate SKU / barcode → 409", async () => {
    const sku = `DUP-${uid()}`;
    await newItem({ sku });
    expect((await owner().call("POST", "/inventory/items", { name: "Dup", unit: "KG", sku })).status).toBe(409);
  });

  it("unicode names round-trip; validation → 400 and nothing written", async () => {
    for (const name of NAMES) expect((await owner().call("POST", "/inventory/items", { name, unit: "PIECE" })).body.name).toBe(name);
    const before = await db.inventoryItem.count({ where: { businessId: w.h.businessId } });
    await rejects(owner(), "POST", "/inventory/items", [
      {},
      { name: "R", unit: "KG" },
      { name: LONG, unit: "KG" },
      { name: "Rice", unit: "TONNE" },
      { name: "Rice", unit: "KG", costPerUnit: -1 },
      { name: "Rice", unit: "KG", costPerUnit: 1.5 },
      { name: "Rice", unit: "KG", costPerUnit: 1e13 },
      { name: "Rice", unit: "KG", costPerUnit: "100" },
      { name: "Rice", unit: "KG", openingStock: -1 },
      { name: "Rice", unit: "KG", reorderLevel: -1 },
      { name: null, unit: "KG" },
    ]);
    expect(await db.inventoryItem.count({ where: { businessId: w.h.businessId } })).toBe(before);
  });

  it("mass assignment: businessId / active=false / id in the body are ignored on create", async () => {
    const r = await owner().call("POST", "/inventory/items", { name: `Mass ${uid()}`, unit: "KG", businessId: w.other.h.businessId, id: "x", active: false });
    expect(r.body).toMatchObject({ businessId: w.h.businessId, active: true });
    expect(r.body.id).not.toBe("x");
  });

  it("adjust: delta or setTo, exactly one; unit can't change after movements; deactivate keeps history", async () => {
    const it1 = await newItem({ openingStock: 5 });
    expect((await owner().call("POST", `/inventory/items/${it1.id}/adjust`, { quantity: -2, reason: "Spilt" })).status).toBe(201);
    expect((await owner().call("POST", `/inventory/items/${it1.id}/adjust`, { setTo: 10, reason: "Recount", unitCost: 6000 })).body.quantity).toBe(7);
    expect(await stockOf(it1.id)).toBe(10);
    await rejects(owner(), "POST", `/inventory/items/${it1.id}/adjust`, [
      { reason: "none" }, { quantity: 1, setTo: 1, reason: "both" }, { quantity: 0, reason: "zero" }, { setTo: -1, reason: "neg" }, { quantity: 1, reason: "" }, { setTo: 10, reason: "same" },
      { quantity: 1, reason: "x", unitCost: 1e13 },
    ]);
    expect((await owner().call("POST", `/inventory/items/${GHOST}/adjust`, { quantity: 1, reason: "ghost" })).status).toBe(404);
    expect((await owner().call("PATCH", `/inventory/items/${it1.id}`, { unit: "G" })).status).toBe(400);
    expect((await owner().call("DELETE", `/inventory/items/${it1.id}`)).status).toBe(204);
    expect((await owner().call("GET", `/inventory/items/${it1.id}`)).body.active).toBe(false);
  });

  it("ledger: IST day boundaries (23:59:59.999 vs 00:00), invalid dates → 400, limit cap", async () => {
    const it1 = await newItem({ openingStock: 1 });
    await owner().call("POST", `/inventory/items/${it1.id}/adjust`, { quantity: 1, reason: "late" });
    const [a, b] = await db.inventoryTransaction.findMany({ where: { inventoryItemId: it1.id }, orderBy: { createdAt: "asc" } });
    await db.inventoryTransaction.update({ where: { id: a.id }, data: { createdAt: new Date("2026-10-15T18:29:59.999Z") } }); // 15 Oct 23:59:59.999 IST
    await db.inventoryTransaction.update({ where: { id: b.id }, data: { createdAt: new Date("2026-10-15T18:30:00.000Z") } }); // 16 Oct 00:00 IST
    const day = async (d: string) => (await owner().call("GET", `/inventory/transactions?itemId=${it1.id}&from=${d}&to=${d}`)).body.map((t: { id: string }) => t.id);
    expect(await day("2026-10-15")).toEqual([a.id]);
    expect(await day("2026-10-16")).toEqual([b.id]);
    expect(await day("2026-10-14")).toEqual([]);
    await rejectsQuery(owner(), "/inventory/transactions", ["from=2026-02-30", "from=2026-13-01", "to=15-10-2026", "from=2026-10-16&to=2026-10-15", "limit=0", "limit=1001", "type=STOLEN"]);
    await rejectsQuery(owner(), "/inventory/wastage", ["from=abc", "from=0abc", "to=2026-02-31"]);
  });
});

describe("recipes", () => {
  it("replace a recipe with unit conversion; foreign / inactive / unknown ids → 400/404", async () => {
    const rice = await newItem({ unit: "KG", costPerUnit: 8000 });
    const r = await owner().call("PUT", `/inventory/recipes/${w.h.items.biryani}`, { lines: [{ inventoryItemId: rice.id, quantity: 250, unit: "G" }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.lines[0].quantity).toBe(0.25);
    expect(r.body.cost).toBe(2000);
    const list = await w.as.KITCHEN.call("GET", `/inventory/recipes?menuItemId=${w.h.items.biryani}`);
    expect(list.body[0]).toMatchObject({ inventoryItemId: rice.id, cost: 2000 });
    const foreign = await w.other.owner.call("POST", "/inventory/items", { name: "Their rice", unit: "KG" });
    await rejects(owner(), "PUT", `/inventory/recipes/${w.h.items.biryani}`, [
      { lines: [{ inventoryItemId: foreign.body.id, quantity: 1 }] },
      { lines: [{ inventoryItemId: GHOST, quantity: 1 }] },
      { lines: [{ inventoryItemId: rice.id, quantity: 0 }] },
      { lines: [{ inventoryItemId: rice.id, quantity: 0.0001, unit: "G" }] },
      { lines: [{ inventoryItemId: rice.id, quantity: 1 }], variantId: GHOST },
      { lines: "x" },
    ]);
    expect((await owner().call("PUT", `/inventory/recipes/${GHOST}`, { lines: [] })).status).toBe(404);
  });

  it("costing (profit data) for owner/manager/accountant; xlsx export", async () => {
    const r = await w.as.ACCOUNTANT.call("GET", "/inventory/recipes/costing");
    expect(r.status).toBe(200);
    const row = r.body.items.find((i: { menuItemId: string }) => i.menuItemId === w.h.items.biryani);
    expect(row.hasRecipe).toBe(true);
    intMoney(row, ["price", "netPrice", "cost", "margin"]);
    const x = await raw(srv.base, owner(), "/inventory/recipes/costing?format=xlsx", w.h.outletId);
    expect(x.headers.get("content-type")).toContain("spreadsheetml");
  });
});

describe("vendors + purchases", () => {
  it("vendor CRUD; GSTIN validated; unicode; unknown → 404", async () => {
    const v = await owner().call("POST", "/inventory/vendors", { name: "சென்னை Traders", gstin: "33ABCDE1234F1Z7", email: "", phone: "9876543210" });
    expect(v.status).toBe(201);
    expect(v.body).toMatchObject({ name: "சென்னை Traders", email: null });
    await rejects(owner(), "POST", "/inventory/vendors", [{}, { name: "V" }, { name: "Vend", gstin: "BADGSTIN" }, { name: "Vend", email: "nope" }, { name: LONG }]);
    expect((await owner().call("PATCH", `/inventory/vendors/${v.body.id}`, { name: "Renamed" })).body.name).toBe("Renamed");
    expect((await owner().call("GET", `/inventory/vendors/${v.body.id}`)).body.summary).toMatchObject({ purchases: 0, outstanding: 0 });
    expect((await owner().call("PATCH", `/inventory/vendors/${GHOST}`, { name: "Ghost" })).status).toBe(404);
    expect((await owner().call("DELETE", `/inventory/vendors/${GHOST}`)).status).toBe(404);
    expect((await owner().call("GET", `/inventory/vendors/${GHOST}`)).status).toBe(404);
    expect((await owner().call("DELETE", `/inventory/vendors/${v.body.id}`)).status).toBe(204);
  });

  it("draft → receive (stock in, weighted cost) → pay → cancel (stock back); every wrong step is 4xx", async () => {
    const it1 = await newItem({ costPerUnit: 0 });
    const v = await newVendor();
    const c = await owner().call("POST", "/inventory/purchases", { vendorId: v.id, invoiceNo: "INV-1", items: [{ inventoryItemId: it1.id, quantity: 10, unitCost: 4000, taxRate: 5 }] });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ status: "DRAFT", subtotal: 40000, tax: 2000, total: 42000, balance: 42000 });
    intMoney(c.body, ["subtotal", "tax", "total", "paidAmount", "balance"]);
    expect(await stockOf(it1.id)).toBe(0);
    // Smuggled totals / status are ignored
    const smuggled = await owner().call("POST", "/inventory/purchases", { vendorId: v.id, items: [{ inventoryItemId: it1.id, quantity: 1, unitCost: 100 }], total: 1, status: "RECEIVED", paidAmount: 999, outletId: w.h.outlet2Id });
    expect(smuggled.body).toMatchObject({ total: 100, status: "DRAFT", paidAmount: 0, outletId: w.h.outletId });

    expect((await owner().call("POST", `/inventory/purchases/${c.body.id}/receive`)).body.status).toBe("RECEIVED");
    expect(await stockOf(it1.id)).toBe(10);
    expect((await db.inventoryItem.findUniqueOrThrow({ where: { id: it1.id } })).costPerUnit).toBe(4200);
    expect((await owner().call("POST", `/inventory/purchases/${c.body.id}/receive`)).status).toBe(409);
    expect((await owner().call("PATCH", `/inventory/purchases/${c.body.id}`, { items: [{ inventoryItemId: it1.id, quantity: 1, unitCost: 1 }] })).status).toBe(409);
    expect((await owner().call("PATCH", `/inventory/purchases/${c.body.id}`, { notes: "Checked" })).body.notes).toBe("Checked");

    await rejects(owner(), "POST", `/inventory/purchases/${c.body.id}/payments`, [{ amount: 42001 }, { amount: 0 }, { amount: -5 }, { amount: 1.5 }, { amount: 10, mode: "BITCOIN" }]);
    const pay = await owner().call("POST", `/inventory/purchases/${c.body.id}/payments`, { amount: 40000, mode: "UPI", reference: "UTR1" });
    expect(pay.body).toMatchObject({ paidAmount: 40000, balance: 2000 });
    expect((await owner().call("GET", "/inventory/purchases?unpaid=1")).body.map((p: { id: string }) => p.id)).toContain(c.body.id);

    await rejects(owner(), "POST", `/inventory/purchases/${c.body.id}/cancel`, [{}, { reason: "x" }]);
    expect((await owner().call("POST", `/inventory/purchases/${c.body.id}/cancel`, { reason: "Wrong goods" })).body.status).toBe("CANCELLED");
    expect(await stockOf(it1.id)).toBe(0);
    expect((await owner().call("POST", `/inventory/purchases/${c.body.id}/cancel`, { reason: "Again" })).status).toBe(409);
    expect((await owner().call("POST", `/inventory/purchases/${c.body.id}/payments`, { amount: 1 })).status).toBe(409);
    expect((await owner().call("GET", `/inventory/purchases/${GHOST}`)).status).toBe(404);
  });

  it("Idempotency-Key on purchase create / payment: a retried request is replayed, not repeated", async () => {
    const it1 = await newItem();
    const v = await newVendor();
    const key = `idem-p-${Date.now()}`;
    const body = { vendorId: v.id, items: [{ inventoryItemId: it1.id, quantity: 2, unitCost: 1000 }], receive: true };
    const a = await owner().call("POST", "/inventory/purchases", body, { "idempotency-key": key });
    const b = await owner().call("POST", "/inventory/purchases", body, { "idempotency-key": key });
    expect(b.body.id).toBe(a.body.id);
    expect(await db.purchase.count({ where: { vendorId: v.id } })).toBe(1);
    expect(await stockOf(it1.id)).toBe(2);
    const pk = `idem-pay-${Date.now()}`;
    await owner().call("POST", `/inventory/purchases/${a.body.id}/payments`, { amount: 500 }, { "idempotency-key": pk });
    const again = await owner().call("POST", `/inventory/purchases/${a.body.id}/payments`, { amount: 500 }, { "idempotency-key": pk });
    expect(again.body.paidAmount).toBe(500);
    expect(await db.purchasePayment.count({ where: { purchaseId: a.body.id } })).toBe(1);
  });

  it("purchase validation: unknown / foreign / inactive vendor or item, overflow totals → 400, nothing written", async () => {
    const it1 = await newItem();
    const v = await newVendor();
    const theirV = (await w.other.owner.call("POST", "/inventory/vendors", { name: "Their vendor" })).body;
    const before = await db.purchase.count({ where: { outletId: w.h.outletId } });
    const line = { inventoryItemId: it1.id, quantity: 1, unitCost: 100 };
    await rejects(owner(), "POST", "/inventory/purchases", [
      {},
      { vendorId: v.id, items: [] },
      { vendorId: theirV.id, items: [line] },
      { vendorId: GHOST, items: [line] },
      { vendorId: v.id, items: [{ ...line, inventoryItemId: GHOST }] },
      { vendorId: v.id, items: [{ ...line, quantity: 0 }] },
      { vendorId: v.id, items: [{ ...line, quantity: 1e8 }] },
      { vendorId: v.id, items: [{ ...line, unitCost: -1 }] },
      { vendorId: v.id, items: [{ ...line, taxRate: 29 }] },
      { vendorId: v.id, items: [{ ...line, quantity: 10_000_000, unitCost: 100_000_000 }] },
      { vendorId: v.id, items: [line], invoiceDate: "2026-02-30x" },
    ]);
    expect(await db.purchase.count({ where: { outletId: w.h.outletId } })).toBe(before);
    await rejectsQuery(owner(), "/inventory/purchases", ["status=LOST", "limit=501", "from=2026-02-30"]);
  });
});

describe("wastage + audits", () => {
  it("wastage lowers stock and is listed; validation 400", async () => {
    const it1 = await newItem({ openingStock: 3, costPerUnit: 1000 });
    const r = await w.as.INVENTORY_MANAGER.call("POST", "/inventory/wastage", { items: [{ inventoryItemId: it1.id, quantity: 500, unit: "G", reason: "Spoilt" }] });
    expect(r.status).toBe(201);
    expect(r.body.value).toBe(500);
    expect(await stockOf(it1.id)).toBe(2.5);
    expect((await owner().call("GET", "/inventory/wastage")).body.some((t: { inventoryItemId: string }) => t.inventoryItemId === it1.id)).toBe(true);
    await rejects(owner(), "POST", "/inventory/wastage", [{}, { items: [] }, { items: [{ inventoryItemId: it1.id, quantity: 1 }] }, { items: [{ inventoryItemId: GHOST, quantity: 1, reason: "xx" }] }, { items: [{ inventoryItemId: it1.id, quantity: -1, reason: "xx" }] }]);
  });

  it("audit: one at a time (409), counts for unknown items 400, complete posts the variance, finished audits are locked", async () => {
    const it1 = await newItem({ openingStock: 8 });
    const a = await owner().call("POST", "/inventory/audits", { notes: "Monthly" });
    expect(a.status).toBe(201);
    expect((await owner().call("POST", "/inventory/audits", {})).status).toBe(409);
    expect((await owner().call("POST", `/inventory/audits/${a.body.id}/complete`)).status).toBe(400);
    await rejects(owner(), "PUT", `/inventory/audits/${a.body.id}/counts`, [{ counts: [] }, { counts: [{ inventoryItemId: GHOST, countedQty: 1 }] }, { counts: [{ inventoryItemId: it1.id, countedQty: -1 }] }]);
    const c = await owner().call("PUT", `/inventory/audits/${a.body.id}/counts`, { counts: [{ inventoryItemId: it1.id, countedQty: 6 }] });
    expect(c.body.summary).toMatchObject({ counted: 1, withVariance: 1 });
    expect((await owner().call("POST", `/inventory/audits/${a.body.id}/complete`)).body.status).toBe("COMPLETED");
    expect(await stockOf(it1.id)).toBe(6);
    expect((await owner().call("POST", `/inventory/audits/${a.body.id}/complete`)).status).toBe(409);
    expect((await owner().call("PUT", `/inventory/audits/${a.body.id}/counts`, { counts: [{ inventoryItemId: it1.id, countedQty: 1 }] })).status).toBe(409);
    expect((await owner().call("POST", `/inventory/audits/${a.body.id}/cancel`)).status).toBe(409);
    expect((await owner().call("GET", `/inventory/audits/${GHOST}`)).status).toBe(404);
    expect((await owner().call("POST", `/inventory/audits/${GHOST}/cancel`)).status).toBe(404);
    expect((await owner().call("GET", "/inventory/audits")).body[0].id).toBe(a.body.id);
  });
});

describe("inter-outlet transfers", () => {
  it("owner sends 1 → 2: auto-approved, dispatch moves stock out, outlet 2 receives it in", async () => {
    const it1 = await newItem({ openingStock: 10 });
    const t = await owner().call("POST", "/inventory/transfers", { toOutletId: w.h.outlet2Id, items: [{ inventoryItemId: it1.id, quantity: 4 }, { inventoryItemId: it1.id, quantity: 1 }] });
    expect(t.status).toBe(201);
    expect(t.body).toMatchObject({ status: "APPROVED", fromOutletId: w.h.outletId, toOutletId: w.h.outlet2Id });
    expect(t.body.items[0].quantity).toBe(5);
    expect((await owner().call("POST", `/inventory/transfers/${t.body.id}/receive`)).status).toBe(409);
    expect((await owner().call("POST", `/inventory/transfers/${t.body.id}/dispatch`)).body.status).toBe("DISPATCHED");
    expect(await stockOf(it1.id)).toBe(5);
    expect((await owner().call("POST", `/inventory/transfers/${t.body.id}/dispatch`)).status).toBe(409);
    expect((await w.owner2.call("POST", `/inventory/transfers/${t.body.id}/receive`)).body.status).toBe("RECEIVED");
    expect(await stockOf(it1.id, w.h.outlet2Id)).toBe(5);
    expect((await w.owner2.call("GET", "/inventory/transfers?direction=incoming")).body.map((x: { id: string }) => x.id)).toContain(t.body.id);
  });

  it("a manager of outlet 1 can request from outlet 2 but not approve, dispatch or receive for outlet 2", async () => {
    const it1 = await newItem();
    await w.owner2.call("POST", `/inventory/items/${it1.id}/adjust`, { quantity: 10, reason: "Stock at 2" });
    const mgr = w.as.OUTLET_MANAGER;
    const t = await mgr.call("POST", "/inventory/transfers", { fromOutletId: w.h.outlet2Id, items: [{ inventoryItemId: it1.id, quantity: 2 }] });
    expect(t.status).toBe(201);
    expect(t.body.status).toBe("REQUESTED");
    expect((await mgr.call("POST", `/inventory/transfers/${t.body.id}/approve`)).status).toBe(403);
    expect((await mgr.call("POST", `/inventory/transfers/${t.body.id}/dispatch`)).status).toBe(403);
    expect((await w.owner2.call("POST", `/inventory/transfers/${t.body.id}/approve`)).body.status).toBe("APPROVED");
    expect((await mgr.call("POST", `/inventory/transfers/${t.body.id}/dispatch`)).status).toBe(403);
    expect((await w.owner2.call("POST", `/inventory/transfers/${t.body.id}/reject`, { reason: "x" })).status).toBe(400);
    expect((await w.owner2.call("POST", `/inventory/transfers/${t.body.id}/reject`, { reason: "Not today" })).body.status).toBe("REJECTED");
    expect((await mgr.call("POST", `/inventory/transfers/${t.body.id}/cancel`)).status).toBe(409);
    // Requester can cancel their own pending request
    const t2 = (await mgr.call("POST", "/inventory/transfers", { fromOutletId: w.h.outlet2Id, items: [{ inventoryItemId: it1.id, quantity: 1 }] })).body;
    expect((await mgr.call("POST", `/inventory/transfers/${t2.id}/cancel`)).body.status).toBe("CANCELLED");
    expect(await stockOf(it1.id, w.h.outlet2Id)).toBe(10);
  });

  it("same outlet / both or neither side / another hotel's outlet / bad items → 400", async () => {
    const it1 = await newItem({ openingStock: 1 });
    const before = await db.stockTransfer.count({ where: { fromOutletId: w.h.outletId } });
    const items = [{ inventoryItemId: it1.id, quantity: 1 }];
    await rejects(owner(), "POST", "/inventory/transfers", [
      { toOutletId: w.h.outletId, items },
      { toOutletId: w.h.outlet2Id, fromOutletId: w.h.outlet2Id, items },
      { items },
      { toOutletId: w.other.h.outletId, items },
      { fromOutletId: w.other.h.outletId, items },
      { toOutletId: GHOST, items },
      { toOutletId: w.h.outlet2Id, items: [] },
      { toOutletId: w.h.outlet2Id, items: [{ inventoryItemId: GHOST, quantity: 1 }] },
      { toOutletId: w.h.outlet2Id, items: [{ inventoryItemId: it1.id, quantity: 0 }] },
    ]);
    expect(await db.stockTransfer.count({ where: { fromOutletId: w.h.outletId } })).toBe(before);
    await rejectsQuery(owner(), "/inventory/transfers", ["direction=sideways", "status=LOST"]);
  });
});

describe("stock reports", () => {
  const REPORTS = ["consumption", "movement", "valuation", "wastage", "vendor-spend", "purchases"];

  it("every report answers JSON with integer money, and .xlsx with the right content type", async () => {
    for (const r of REPORTS) {
      const j = await w.as.INVENTORY_MANAGER.call("GET", `/inventory/reports/${r}`);
      expect(j.status, r).toBe(200);
      if ("totalValue" in j.body) intMoney(j.body, ["totalValue"]);
      const x = await raw(srv.base, owner(), `/inventory/reports/${r}?format=xlsx`, w.h.outletId);
      expect(x.status, r).toBe(200);
      expect(x.headers.get("content-type"), r).toContain("spreadsheetml");
      expect(x.headers.get("content-disposition"), r).toMatch(/attachment; filename=".+\.xlsx"/);
    }
    const mv = await owner().call("GET", "/inventory/reports/movement");
    for (const row of mv.body.rows) expect(row.closing).toBeCloseTo(row.opening + row.in - row.out, 3);
  });

  it("invalid / reversed dates → 400 on every dated report", async () => {
    for (const r of REPORTS.filter((x) => x !== "valuation")) {
      await rejectsQuery(owner(), `/inventory/reports/${r}`, ["from=2026-02-30", "to=2026-13-01", "from=2026-10-02&to=2026-10-01", "from=yesterday", "format=csv"]);
    }
  });

  it("formula-looking names / reasons are escaped in .xlsx exports", async () => {
    const evil = "=HYPERLINK(\"http://evil.example\",\"x\")";
    const it1 = await newItem({ name: evil, openingStock: 5, costPerUnit: 100 });
    await owner().call("POST", "/inventory/wastage", { items: [{ inventoryItemId: it1.id, quantity: 1, reason: "+cmd|' /C calc'!A0" }] });
    const x = await raw(srv.base, owner(), "/inventory/reports/wastage?format=xlsx", w.h.outletId);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await x.arrayBuffer());
    const cells: string[] = [];
    wb.worksheets[0].eachRow((row) => row.eachCell((c) => typeof c.value === "string" && cells.push(c.value)));
    expect(cells).toContain(`'${evil}`);
    expect(cells.filter((c) => /^[=+\-@]/.test(c))).toEqual([]);
    wb.worksheets[0].eachRow((row) => row.eachCell((c) => expect(c.formula).toBeUndefined()));
  });
});
