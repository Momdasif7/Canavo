/**
 * QA Phase 5 — group E: vendors, purchases & payments, wastage, stock audits,
 * inter-outlet transfers and the stock reconciliation identity.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createTenant, db } from "./helpers";
import { as, bill, costOf, invItem, ledgerSum, menuItem, r3, stockOf, twoOutletTenant, uid, type Agent, type Fx } from "./fx-e";

let fx: Fx;
let other: Awaited<ReturnType<typeof createTenant>>;
let inv: Agent; // inventory staff @ A
let mgr: Agent; // manager @ A
let mgrB: Agent; // manager @ B
let invB: Agent; // inventory staff @ B
let cashier: Agent;
let kitchen: Agent;
let otherInv: Agent;

const GSTIN = "33AAAAA0000A1Z5";

beforeAll(async () => {
  fx = await twoOutletTenant();
  other = await createTenant({ name: `E-Other ${uid()}` });
  inv = await as(fx.users.INVENTORY_MANAGER.email, fx.outletA.id);
  mgr = await as(fx.users.OUTLET_MANAGER.email, fx.outletA.id);
  mgrB = await as(fx.mgrB.email, fx.outletB.id);
  invB = await as(fx.invB.email, fx.outletB.id);
  cashier = await as(fx.users.CASHIER.email, fx.outletA.id);
  kitchen = await as(fx.users.KITCHEN.email, fx.outletA.id);
  otherInv = await as(other.users.INVENTORY_MANAGER.email, other.outlet.id);
});

async function vendor(agent: Agent = inv, body: Record<string, unknown> = {}) {
  const res = await agent.post("/inventory/vendors", { name: `Vendor ${uid()}`, ...body });
  if (res.status !== 201) throw new Error(`vendor → ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; name: string };
}

async function purchase(body: Record<string, unknown>, agent: Agent = inv) {
  const res = await agent.post("/inventory/purchases", body);
  if (res.status !== 201) throw new Error(`purchase → ${res.status} ${JSON.stringify(res.body)}`);
  return res.body as { id: string; status: string; total: number; subtotal: number; tax: number; paidAmount: number; balance: number };
}

// ---------------------------------------------------------------------------
describe("@regression Vendors", () => {
  it("IT-PUR-001 creates a vendor with a valid GSTIN; empty GSTIN/email stored as null", async () => {
    const a = await inv.post("/inventory/vendors", { name: `GV ${uid()}`, gstin: GSTIN, email: "v@x.in" });
    expect(a.status).toBe(201);
    expect(a.body.gstin).toBe(GSTIN);
    const b = await inv.post("/inventory/vendors", { name: `NV ${uid()}`, gstin: "", email: "" });
    expect(b.status).toBe(201);
    expect(b.body).toMatchObject({ gstin: null, email: null });
  });

  it.each([
    ["wrong checksum letter position", "33AAAAA0000A1X5"],
    ["lower case", "33aaaaa0000a1z5"],
    ["too short", "33AAAAA0000A1Z"],
    ["zero entity code", "33AAAAA0000A0Z5"],
  ])("IT-PUR-002 rejects GSTIN (%s) with 400", async (_l, gstin) => {
    expect((await inv.post("/inventory/vendors", { name: `BadG ${uid()}`, gstin })).status).toBe(400);
  });

  it("IT-PUR-003 vendor validation: name 1 char / invalid email → 400", async () => {
    expect((await inv.post("/inventory/vendors", { name: "V" })).status).toBe(400);
    expect((await inv.post("/inventory/vendors", { name: `E ${uid()}`, email: "not-an-email" })).status).toBe(400);
  });

  it("IT-PUR-004 update + deactivate; inactive vendor hidden by default and can't take purchases (400)", async () => {
    const v = await vendor();
    expect((await inv.patch(`/inventory/vendors/${v.id}`, { phone: "9876543210" })).body.phone).toBe("9876543210");
    expect((await inv.delete(`/inventory/vendors/${v.id}`)).status).toBe(204);
    const list = await inv.get("/inventory/vendors");
    expect(list.body.some((x: { id: string }) => x.id === v.id)).toBe(false);
    expect((await inv.get("/inventory/vendors?includeInactive=1")).body.some((x: { id: string }) => x.id === v.id)).toBe(true);
    const it0 = await invItem(inv);
    expect((await inv.post("/inventory/purchases", { vendorId: v.id, items: [{ inventoryItemId: it0.id, quantity: 1, unitCost: 100 }] })).status).toBe(400);
  });

  it("IT-PUR-005 another business's vendor: GET/PATCH/DELETE → 404 and can't be used in a purchase (400)", async () => {
    const theirs = await vendor(otherInv);
    expect((await inv.get(`/inventory/vendors/${theirs.id}`)).status).toBe(404);
    expect((await inv.patch(`/inventory/vendors/${theirs.id}`, { name: "Hijacked" })).status).toBe(404);
    expect((await inv.delete(`/inventory/vendors/${theirs.id}`)).status).toBe(404);
    expect((await db.vendor.findUniqueOrThrow({ where: { id: theirs.id } })).active).toBe(true);
    const it0 = await invItem(inv);
    expect((await inv.post("/inventory/purchases", { vendorId: theirs.id, items: [{ inventoryItemId: it0.id, quantity: 1, unitCost: 100 }] })).status).toBe(400);
  });

  it("IT-PUR-006 kitchen (view only) cannot create vendors (403); cashier cannot list them (403)", async () => {
    expect((await kitchen.post("/inventory/vendors", { name: `K ${uid()}` })).status).toBe(403);
    expect((await cashier.get("/inventory/vendors")).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
describe("@regression @critical Purchases", () => {
  it("IT-PUR-010 draft purchase: GST per line, totals in paise, no stock movement yet", async () => {
    const v = await vendor();
    const a = await invItem(inv);
    const b = await invItem(inv);
    const p = await purchase({
      vendorId: v.id,
      invoiceNo: `INV-${uid()}`,
      items: [
        { inventoryItemId: a.id, quantity: 10, unitCost: 5000, taxRate: 5 },
        { inventoryItemId: b.id, quantity: 2.5, unitCost: 3333, taxRate: 12 },
      ],
    });
    expect(p).toMatchObject({ status: "DRAFT", subtotal: 58333, tax: 3500, total: 61833, paidAmount: 0, balance: 61833 });
    expect(await db.inventoryTransaction.count({ where: { refType: "Purchase", refId: p.id } })).toBe(0);
    expect(await stockOf(fx.outletA.id, a.id)).toBe(0);
  });

  it("IT-PUR-011 receive: stock up, PURCHASE rows at landed (GST-inclusive) cost, weighted cost updated", async () => {
    const v = await vendor();
    const a = await invItem(inv, { openingStock: 10, costPerUnit: 4000 });
    const p = await purchase({ vendorId: v.id, items: [{ inventoryItemId: a.id, quantity: 10, unitCost: 5000, taxRate: 5 }] });
    const res = await inv.post(`/inventory/purchases/${p.id}/receive`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("RECEIVED");
    expect(res.body.receivedAt).toBeTruthy();
    expect(await stockOf(fx.outletA.id, a.id)).toBe(20);
    const t = await db.inventoryTransaction.findFirstOrThrow({ where: { refType: "Purchase", refId: p.id } });
    expect(t).toMatchObject({ type: "PURCHASE", quantity: 10, unitCost: 5250, outletId: fx.outletA.id });
    expect(await costOf(a.id)).toBe(4625); // (10×4000 + 10×5250) / 20
  });

  it("IT-PUR-012 receive is one-shot: second receive → 409, stock unchanged", async () => {
    const v = await vendor();
    const a = await invItem(inv);
    const p = await purchase({ vendorId: v.id, receive: true, items: [{ inventoryItemId: a.id, quantity: 3, unitCost: 100 }] });
    expect(p.status).toBe("RECEIVED");
    expect((await inv.post(`/inventory/purchases/${p.id}/receive`)).status).toBe(409);
    expect(await stockOf(fx.outletA.id, a.id)).toBe(3);
  });

  it("IT-PUR-013 payments: partial, then exact balance; overpay → 400; status reflected in balance/unpaid filter", async () => {
    const v = await vendor();
    const a = await invItem(inv);
    const p = await purchase({ vendorId: v.id, receive: true, items: [{ inventoryItemId: a.id, quantity: 10, unitCost: 1000, taxRate: 5 }] });
    expect(p.total).toBe(10500);
    const p1 = await inv.post(`/inventory/purchases/${p.id}/payments`, { amount: 4000, mode: "UPI", reference: "UTR1" });
    expect(p1.status).toBe(200);
    expect(p1.body).toMatchObject({ paidAmount: 4000, balance: 6500 });
    let unpaid = await inv.get("/inventory/purchases?unpaid=1");
    expect(unpaid.body.some((x: { id: string }) => x.id === p.id)).toBe(true);
    expect((await inv.post(`/inventory/purchases/${p.id}/payments`, { amount: 6501 })).status).toBe(400);
    const p2 = await inv.post(`/inventory/purchases/${p.id}/payments`, { amount: 6500 });
    expect(p2.body).toMatchObject({ paidAmount: 10500, balance: 0 });
    expect(p2.body.payments).toHaveLength(2);
    expect((await inv.post(`/inventory/purchases/${p.id}/payments`, { amount: 1 })).status).toBe(400);
    unpaid = await inv.get("/inventory/purchases?unpaid=1");
    expect(unpaid.body.some((x: { id: string }) => x.id === p.id)).toBe(false);
  });

  it("IT-PUR-014 payment validation: 0, negative, fractional paise, unknown mode → 400", async () => {
    const v = await vendor();
    const a = await invItem(inv);
    const p = await purchase({ vendorId: v.id, items: [{ inventoryItemId: a.id, quantity: 1, unitCost: 1000 }] });
    for (const body of [{ amount: 0 }, { amount: -5 }, { amount: 10.5 }, { amount: 10, mode: "CRYPTO" }]) {
      expect((await inv.post(`/inventory/purchases/${p.id}/payments`, body)).status).toBe(400);
    }
  });

  it("IT-PUR-015 vendor summary/vendor-spend: received purchases only, outstanding = total − paid", async () => {
    const v = await vendor();
    const a = await invItem(inv);
    const r = await purchase({ vendorId: v.id, receive: true, items: [{ inventoryItemId: a.id, quantity: 2, unitCost: 5000 }] });
    await purchase({ vendorId: v.id, items: [{ inventoryItemId: a.id, quantity: 9, unitCost: 5000 }] }); // draft — excluded
    await inv.post(`/inventory/purchases/${r.id}/payments`, { amount: 3000 });
    const det = await inv.get(`/inventory/vendors/${v.id}`);
    expect(det.body.summary).toMatchObject({ purchases: 1, totalSpend: 10000, paid: 3000, outstanding: 7000 });
    expect(det.body.purchases).toHaveLength(2);
    const spend = await inv.get("/inventory/reports/vendor-spend");
    expect(spend.body.rows.find((x: { vendorId: string }) => x.vendorId === v.id)).toMatchObject({ total: 10000, paid: 3000, outstanding: 7000 });
  });

  it("IT-PUR-016 edit: draft lines recompute totals; received purchase lines locked (409), notes still editable", async () => {
    const v = await vendor();
    const a = await invItem(inv);
    const p = await purchase({ vendorId: v.id, items: [{ inventoryItemId: a.id, quantity: 1, unitCost: 1000 }] });
    const e = await inv.patch(`/inventory/purchases/${p.id}`, { items: [{ inventoryItemId: a.id, quantity: 2, unitCost: 1000, taxRate: 18 }] });
    expect(e.status).toBe(200);
    expect(e.body).toMatchObject({ subtotal: 2000, tax: 360, total: 2360 });
    await inv.post(`/inventory/purchases/${p.id}/receive`);
    expect((await inv.patch(`/inventory/purchases/${p.id}`, { items: [{ inventoryItemId: a.id, quantity: 5, unitCost: 1 }] })).status).toBe(409);
    expect((await inv.patch(`/inventory/purchases/${p.id}`, { notes: "Bill attached" })).body.notes).toBe("Bill attached");
  });

  it("IT-PUR-017 purchase validation: empty items, qty 0, taxRate 29, unknown item → 400", async () => {
    const v = await vendor();
    const a = await invItem(inv);
    const p = (items: unknown[]) => inv.post("/inventory/purchases", { vendorId: v.id, items });
    expect((await p([])).status).toBe(400);
    expect((await p([{ inventoryItemId: a.id, quantity: 0, unitCost: 1 }])).status).toBe(400);
    expect((await p([{ inventoryItemId: a.id, quantity: 1, unitCost: 1, taxRate: 29 }])).status).toBe(400);
    expect((await p([{ inventoryItemId: "missing", quantity: 1, unitCost: 1 }])).status).toBe(400);
  });

  it("IT-PUR-018 cancel draft: CANCELLED, no stock movement; cancel again → 409; pay cancelled → 409; receive cancelled → 409", async () => {
    const v = await vendor();
    const a = await invItem(inv);
    const p = await purchase({ vendorId: v.id, items: [{ inventoryItemId: a.id, quantity: 1, unitCost: 100 }] });
    const c = await inv.post(`/inventory/purchases/${p.id}/cancel`, { reason: "Duplicate" });
    expect(c.body.status).toBe("CANCELLED");
    expect((await inv.post(`/inventory/purchases/${p.id}/cancel`, { reason: "Again" })).status).toBe(409);
    expect((await inv.post(`/inventory/purchases/${p.id}/payments`, { amount: 1 })).status).toBe(409);
    expect((await inv.post(`/inventory/purchases/${p.id}/receive`)).status).toBe(409);
    expect(await db.inventoryTransaction.count({ where: { inventoryItemId: a.id } })).toBe(0);
    expect((await inv.post(`/inventory/purchases/${p.id}/cancel`, { reason: "x" })).status).toBe(400);
  });

  it("IT-PUR-019 cancel received: stock reversed with RETURN rows (refType Purchase)", async () => {
    const v = await vendor();
    const a = await invItem(inv, { openingStock: 2 });
    const p = await purchase({ vendorId: v.id, receive: true, items: [{ inventoryItemId: a.id, quantity: 5, unitCost: 1000 }] });
    expect(await stockOf(fx.outletA.id, a.id)).toBe(7);
    await inv.post(`/inventory/purchases/${p.id}/cancel`, { reason: "Goods returned" });
    expect(await stockOf(fx.outletA.id, a.id)).toBe(2);
    const ret = await db.inventoryTransaction.findFirstOrThrow({ where: { refId: p.id, type: "RETURN" } });
    expect(ret.quantity).toBe(-5);
    expect(await ledgerSum(fx.outletA.id, a.id)).toBe(2);
  });

  // Receiving updates weighted-average cost; cancelling (RETURN) never reverses it, so the
  // remaining stock stays valued at the blended cost of goods that went back.
  it.fails("IT-PUR-020 (BUG-CANDIDATE-E3) cancelling a received purchase restores the weighted-average cost", async () => {
    const v = await vendor();
    const a = await invItem(inv, { openingStock: 10, costPerUnit: 4000 });
    const p = await purchase({ vendorId: v.id, receive: true, items: [{ inventoryItemId: a.id, quantity: 30, unitCost: 6000 }] });
    expect(await costOf(a.id)).toBe(5500);
    await inv.post(`/inventory/purchases/${p.id}/cancel`, { reason: "Goods returned" });
    expect(await stockOf(fx.outletA.id, a.id)).toBe(10);
    expect(await costOf(a.id)).toBe(4000); // actual: 5500 → 10 kg valued ₹550 instead of ₹400
  });

  // A received + paid purchase can be cancelled; the vendor summary then only counts RECEIVED
  // purchases, so the ₹ already paid disappears from the vendor's paid/outstanding figures.
  it.fails("IT-PUR-021 (BUG-CANDIDATE-E4) cancelling a paid purchase is refused or the payment stays visible on the vendor", async () => {
    const v = await vendor();
    const a = await invItem(inv);
    const p = await purchase({ vendorId: v.id, receive: true, items: [{ inventoryItemId: a.id, quantity: 1, unitCost: 10000 }] });
    await inv.post(`/inventory/purchases/${p.id}/payments`, { amount: 10000 });
    const c = await inv.post(`/inventory/purchases/${p.id}/cancel`, { reason: "Goods returned" });
    if (c.status === 409) return;
    const det = await inv.get(`/inventory/vendors/${v.id}`);
    expect(det.body.summary.paid).toBe(10000); // actual: 0 — payment no longer tracked anywhere
  });

  it("IT-PUR-022 another outlet's purchase is not visible (404) even inside the same business", async () => {
    const v = await vendor();
    const a = await invItem(inv);
    const p = await purchase({ vendorId: v.id, items: [{ inventoryItemId: a.id, quantity: 1, unitCost: 100 }] });
    expect((await mgrB.get(`/inventory/purchases/${p.id}`)).status).toBe(404);
    expect((await mgrB.post(`/inventory/purchases/${p.id}/receive`)).status).toBe(404);
    expect((await otherInv.get(`/inventory/purchases/${p.id}`)).status).toBe(404);
  });

  it("IT-PUR-023 purchases report totals count received only", async () => {
    const v = await vendor();
    const a = await invItem(inv);
    const r = await purchase({ vendorId: v.id, receive: true, items: [{ inventoryItemId: a.id, quantity: 1, unitCost: 1000, taxRate: 5 }] });
    const res = await inv.get("/inventory/reports/purchases");
    expect(res.status).toBe(200);
    const row = res.body.rows.find((x: { id: string }) => x.id === r.id);
    expect(row).toMatchObject({ status: "RECEIVED", subtotal: 1000, tax: 50, total: 1050, balance: 1050 });
    const received = res.body.rows.filter((x: { status: string }) => x.status === "RECEIVED");
    expect(res.body.totals.total).toBe(received.reduce((s: number, x: { total: number }) => s + x.total, 0));
  });
});

// ---------------------------------------------------------------------------
describe("@regression @critical Wastage", () => {
  it("IT-INV-070 wastage reduces stock (unit-converted), valued at cost, shows in the wastage report", async () => {
    const a = await invItem(inv, { unit: "KG", openingStock: 5, costPerUnit: 8000 });
    const res = await inv.post("/inventory/wastage", { items: [{ inventoryItemId: a.id, quantity: 500, unit: "G", reason: "Spoiled" }] });
    expect(res.status).toBe(201);
    expect(res.body.value).toBe(4000);
    expect(await stockOf(fx.outletA.id, a.id)).toBe(4.5);
    const rep = await inv.get(`/inventory/reports/wastage?itemId=${a.id}`);
    expect(rep.body.rows).toHaveLength(1);
    expect(rep.body.rows[0]).toMatchObject({ quantity: 0.5, value: 4000, reason: "Spoiled", by: expect.stringContaining("INVENTORY_MANAGER") });
    expect(rep.body.totalValue).toBe(4000);
    const list = await inv.get("/inventory/wastage");
    expect(list.body.some((t: { inventoryItemId: string }) => t.inventoryItemId === a.id)).toBe(true);
  });

  it("IT-INV-071 wastage validation: empty list, qty 0, incompatible unit, inactive item, short reason → 400", async () => {
    const a = await invItem(inv, { unit: "KG", openingStock: 5 });
    const w = (items: unknown[]) => inv.post("/inventory/wastage", { items });
    expect((await w([])).status).toBe(400);
    expect((await w([{ inventoryItemId: a.id, quantity: 0, reason: "xx" }])).status).toBe(400);
    expect((await w([{ inventoryItemId: a.id, quantity: 1, unit: "L", reason: "xx" }])).status).toBe(400);
    expect((await w([{ inventoryItemId: a.id, quantity: 1, reason: "x" }])).status).toBe(400);
    const dead = await invItem(inv);
    await inv.delete(`/inventory/items/${dead.id}`);
    expect((await w([{ inventoryItemId: dead.id, quantity: 1, reason: "xx" }])).status).toBe(400);
    expect(await stockOf(fx.outletA.id, a.id)).toBe(5);
  });

  it("IT-INV-072 wastage of another business's item → 400 and their stock untouched", async () => {
    const theirs = await invItem(otherInv, { openingStock: 3 });
    expect((await inv.post("/inventory/wastage", { items: [{ inventoryItemId: theirs.id, quantity: 1, reason: "xx" }] })).status).toBe(400);
    expect(await stockOf(other.outlet.id, theirs.id)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
describe("@regression @critical Stock audits", () => {
  // Audits are one-at-a-time per outlet: each test runs at outlet B of its own tenant.
  async function auditFx() {
    const t = await twoOutletTenant();
    const a = await as(t.users.BUSINESS_OWNER.email, t.outletA.id);
    return { t, a };
  }

  it("IT-AUD-001 start snapshots systemQty of active items in the category; second start → 409", async () => {
    const { a } = await auditFx();
    const cat = `Aud${uid()}`;
    const x = await invItem(a, { category: cat, openingStock: 7 });
    const y = await invItem(a, { category: cat });
    await invItem(a, { category: "Other", openingStock: 1 });
    const s = await a.post("/inventory/audits", { category: cat });
    expect(s.status).toBe(201);
    expect(s.body.status).toBe("IN_PROGRESS");
    expect(s.body.lines.map((l: { inventoryItemId: string; systemQty: number }) => [l.inventoryItemId, l.systemQty]).sort()).toEqual([[x.id, 7], [y.id, 0]].sort());
    expect((await a.post("/inventory/audits", {})).status).toBe(409);
    expect((await a.post(`/inventory/audits/${s.body.id}/cancel`)).status).toBe(200);
  });

  it("IT-AUD-002 complete applies variance (counted − snapshot) to CURRENT stock, preserving movements made while counting", async () => {
    const { t, a } = await auditFx();
    const cat = `Aud${uid()}`;
    const x = await invItem(a, { category: cat, openingStock: 10, costPerUnit: 1000 });
    const s = await a.post("/inventory/audits", { category: cat });
    await a.post(`/inventory/items/${x.id}/adjust`, { quantity: -2, reason: "Sold while counting" });
    const c = await a.put(`/inventory/audits/${s.body.id}/counts`, { counts: [{ inventoryItemId: x.id, countedQty: 9 }] });
    expect(c.status).toBe(200);
    expect(c.body.summary).toMatchObject({ counted: 1, withVariance: 1, varianceValue: -1000 });
    const done = await a.post(`/inventory/audits/${s.body.id}/complete`);
    expect(done.status).toBe(200);
    expect(done.body.status).toBe("COMPLETED");
    expect(await stockOf(t.outletA.id, x.id)).toBe(7);
    const row = await db.inventoryTransaction.findFirstOrThrow({ where: { refType: "StockAudit", refId: s.body.id } });
    expect(row).toMatchObject({ type: "AUDIT", quantity: -1 });
  });

  it("IT-AUD-003 complete without any count → 400; uncounted lines produce no adjustment", async () => {
    const { t, a } = await auditFx();
    const cat = `Aud${uid()}`;
    const x = await invItem(a, { category: cat, openingStock: 3 });
    const y = await invItem(a, { category: cat, openingStock: 4 });
    const s = await a.post("/inventory/audits", { category: cat });
    expect((await a.post(`/inventory/audits/${s.body.id}/complete`)).status).toBe(400);
    await a.put(`/inventory/audits/${s.body.id}/counts`, { counts: [{ inventoryItemId: x.id, countedQty: 5 }] });
    await a.post(`/inventory/audits/${s.body.id}/complete`);
    expect(await stockOf(t.outletA.id, x.id)).toBe(5);
    expect(await stockOf(t.outletA.id, y.id)).toBe(4);
  });

  it("IT-AUD-004 state machine: after COMPLETED counts/complete/cancel → 409", async () => {
    const { a } = await auditFx();
    const cat = `Aud${uid()}`;
    const x = await invItem(a, { category: cat, openingStock: 1 });
    const s = await a.post("/inventory/audits", { category: cat });
    await a.put(`/inventory/audits/${s.body.id}/counts`, { counts: [{ inventoryItemId: x.id, countedQty: 1 }] });
    await a.post(`/inventory/audits/${s.body.id}/complete`);
    expect((await a.put(`/inventory/audits/${s.body.id}/counts`, { counts: [{ inventoryItemId: x.id, countedQty: 2 }] })).status).toBe(409);
    expect((await a.post(`/inventory/audits/${s.body.id}/complete`)).status).toBe(409);
    expect((await a.post(`/inventory/audits/${s.body.id}/cancel`)).status).toBe(409);
  });

  it("IT-AUD-005 cancel IN_PROGRESS: no stock change, later counts → 409, a new audit can start", async () => {
    const { t, a } = await auditFx();
    const cat = `Aud${uid()}`;
    const x = await invItem(a, { category: cat, openingStock: 6 });
    const s = await a.post("/inventory/audits", { category: cat });
    await a.put(`/inventory/audits/${s.body.id}/counts`, { counts: [{ inventoryItemId: x.id, countedQty: 1 }] });
    expect((await a.post(`/inventory/audits/${s.body.id}/cancel`)).body.status).toBe("CANCELLED");
    expect(await stockOf(t.outletA.id, x.id)).toBe(6);
    expect((await a.put(`/inventory/audits/${s.body.id}/counts`, { counts: [{ inventoryItemId: x.id, countedQty: 2 }] })).status).toBe(409);
    const s2 = await a.post("/inventory/audits", { category: cat });
    expect(s2.status).toBe(201);
    await a.post(`/inventory/audits/${s2.body.id}/cancel`);
  });

  it("IT-AUD-006 counts validation: item not in audit → 400, negative count → 400, null clears a count", async () => {
    const { a } = await auditFx();
    const cat = `Aud${uid()}`;
    const x = await invItem(a, { category: cat, openingStock: 2 });
    const outsider = await invItem(a, { category: `Else${uid()}` });
    const s = await a.post("/inventory/audits", { category: cat });
    expect((await a.put(`/inventory/audits/${s.body.id}/counts`, { counts: [{ inventoryItemId: outsider.id, countedQty: 1 }] })).status).toBe(400);
    expect((await a.put(`/inventory/audits/${s.body.id}/counts`, { counts: [{ inventoryItemId: x.id, countedQty: -1 }] })).status).toBe(400);
    await a.put(`/inventory/audits/${s.body.id}/counts`, { counts: [{ inventoryItemId: x.id, countedQty: 1 }] });
    const cleared = await a.put(`/inventory/audits/${s.body.id}/counts`, { counts: [{ inventoryItemId: x.id, countedQty: null }] });
    expect(cleared.body.summary.counted).toBe(0);
    await a.post(`/inventory/audits/${s.body.id}/cancel`);
  });

  it("IT-AUD-007 unknown category → 400; audit of another outlet → 404", async () => {
    const { t, a } = await auditFx();
    expect((await a.post("/inventory/audits", { category: `Nothing${uid()}` })).status).toBe(400);
    const cat = `Aud${uid()}`;
    await invItem(a, { category: cat });
    const s = await a.post("/inventory/audits", { category: cat });
    const atB = await as(t.mgrB.email, t.outletB.id);
    expect((await atB.get(`/inventory/audits/${s.body.id}`)).status).toBe(404);
    expect((await atB.post(`/inventory/audits/${s.body.id}/cancel`)).status).toBe(409);
    await a.post(`/inventory/audits/${s.body.id}/cancel`);
  });
});

// ---------------------------------------------------------------------------
describe("@regression @critical Inter-outlet transfers", () => {
  it("IT-TRF-001 manager sends A→B: auto-approved, dispatch moves stock out of A, receive into B; total conserved", async () => {
    const x = await invItem(mgr, { openingStock: 10, costPerUnit: 3000 });
    const before = (await stockOf(fx.outletA.id, x.id)) + (await stockOf(fx.outletB.id, x.id));
    const c = await mgr.post("/inventory/transfers", { toOutletId: fx.outletB.id, items: [{ inventoryItemId: x.id, quantity: 2.5 }, { inventoryItemId: x.id, quantity: 1.5 }] });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ status: "APPROVED", fromOutletId: fx.outletA.id, toOutletId: fx.outletB.id });
    expect(c.body.items).toHaveLength(1);
    expect(c.body.items[0].quantity).toBe(4);
    const d = await mgr.post(`/inventory/transfers/${c.body.id}/dispatch`);
    expect(d.body.status).toBe("DISPATCHED");
    expect(await stockOf(fx.outletA.id, x.id)).toBe(6);
    expect(await stockOf(fx.outletB.id, x.id)).toBe(0);
    const r = await mgrB.post(`/inventory/transfers/${c.body.id}/receive`);
    expect(r.body.status).toBe("RECEIVED");
    expect(await stockOf(fx.outletB.id, x.id)).toBe(4);
    expect((await stockOf(fx.outletA.id, x.id)) + (await stockOf(fx.outletB.id, x.id))).toBe(before);
    const rows = await db.inventoryTransaction.findMany({ where: { refType: "StockTransfer", refId: c.body.id } });
    expect(rows.map((t) => [t.type, t.outletId, t.quantity, t.unitCost]).sort()).toEqual(
      [["TRANSFER_IN", fx.outletB.id, 4, 3000], ["TRANSFER_OUT", fx.outletA.id, -4, 3000]].sort(),
    );
  });

  it("IT-TRF-002 request from B (by A's inventory staff): REQUESTED; A's manager can't approve (403); B's manager approves", async () => {
    const x = await invItem(inv, { openingStock: 0 });
    await invB.post(`/inventory/items/${x.id}/adjust`, { quantity: 5, reason: "Stock at B" });
    const c = await inv.post("/inventory/transfers", { fromOutletId: fx.outletB.id, items: [{ inventoryItemId: x.id, quantity: 2 }] });
    expect(c.body.status).toBe("REQUESTED");
    expect((await mgr.post(`/inventory/transfers/${c.body.id}/approve`)).status).toBe(403);
    expect((await inv.post(`/inventory/transfers/${c.body.id}/dispatch`)).status).toBe(403);
    expect((await mgrB.post(`/inventory/transfers/${c.body.id}/approve`)).body.status).toBe("APPROVED");
    expect((await invB.post(`/inventory/transfers/${c.body.id}/dispatch`)).body.status).toBe("DISPATCHED");
    expect((await inv.post(`/inventory/transfers/${c.body.id}/receive`)).body.status).toBe("RECEIVED");
    expect(await stockOf(fx.outletA.id, x.id)).toBe(2);
    expect(await stockOf(fx.outletB.id, x.id)).toBe(3);
  });

  it("IT-TRF-003 inventory staff sending is not auto-approved and can't approve own transfer (403)", async () => {
    const x = await invItem(inv, { openingStock: 3 });
    const c = await inv.post("/inventory/transfers", { toOutletId: fx.outletB.id, items: [{ inventoryItemId: x.id, quantity: 1 }] });
    expect(c.body.status).toBe("REQUESTED");
    expect((await inv.post(`/inventory/transfers/${c.body.id}/approve`)).status).toBe(403);
    expect((await mgrB.post(`/inventory/transfers/${c.body.id}/approve`)).status).toBe(403); // destination manager can't approve for the source
    expect((await mgr.post(`/inventory/transfers/${c.body.id}/approve`)).body.status).toBe("APPROVED");
  });

  it("IT-TRF-004 invalid transitions: dispatch REQUESTED → 409, receive APPROVED → 409, receive twice → 409, approve twice → 409", async () => {
    const x = await invItem(inv, { openingStock: 5 });
    const c = await inv.post("/inventory/transfers", { toOutletId: fx.outletB.id, items: [{ inventoryItemId: x.id, quantity: 1 }] });
    expect((await mgr.post(`/inventory/transfers/${c.body.id}/dispatch`)).status).toBe(409);
    await mgr.post(`/inventory/transfers/${c.body.id}/approve`);
    expect((await mgr.post(`/inventory/transfers/${c.body.id}/approve`)).status).toBe(409);
    expect((await mgrB.post(`/inventory/transfers/${c.body.id}/receive`)).status).toBe(409);
    await mgr.post(`/inventory/transfers/${c.body.id}/dispatch`);
    expect((await mgr.post(`/inventory/transfers/${c.body.id}/dispatch`)).status).toBe(409);
    await mgrB.post(`/inventory/transfers/${c.body.id}/receive`);
    expect((await mgrB.post(`/inventory/transfers/${c.body.id}/receive`)).status).toBe(409);
    expect(await stockOf(fx.outletA.id, x.id)).toBe(4);
    expect(await stockOf(fx.outletB.id, x.id)).toBe(1);
  });

  it("IT-TRF-005 receive by someone without access to the destination → 403", async () => {
    const x = await invItem(mgr, { openingStock: 5 });
    const c = await mgr.post("/inventory/transfers", { toOutletId: fx.outletB.id, items: [{ inventoryItemId: x.id, quantity: 1 }] });
    await mgr.post(`/inventory/transfers/${c.body.id}/dispatch`);
    expect((await mgr.post(`/inventory/transfers/${c.body.id}/receive`)).status).toBe(403);
    expect(await stockOf(fx.outletB.id, x.id)).toBe(0);
  });

  it("IT-TRF-006 reject (REQUESTED or APPROVED) by source manager with reason; short reason → 400; then dispatch → 409", async () => {
    const x = await invItem(inv, { openingStock: 5 });
    const c = await inv.post("/inventory/transfers", { toOutletId: fx.outletB.id, items: [{ inventoryItemId: x.id, quantity: 1 }] });
    expect((await mgr.post(`/inventory/transfers/${c.body.id}/reject`, { reason: "no" })).status).toBe(400);
    const r = await mgr.post(`/inventory/transfers/${c.body.id}/reject`, { reason: "Not needed" });
    expect(r.body.status).toBe("REJECTED");
    expect(r.body.notes).toContain("Rejected: Not needed");
    expect((await mgr.post(`/inventory/transfers/${c.body.id}/dispatch`)).status).toBe(409);
    const c2 = await mgr.post("/inventory/transfers", { toOutletId: fx.outletB.id, items: [{ inventoryItemId: x.id, quantity: 1 }] });
    expect((await mgr.post(`/inventory/transfers/${c2.body.id}/reject`, { reason: "Changed mind" })).body.status).toBe("REJECTED");
    expect(await stockOf(fx.outletA.id, x.id)).toBe(5);
  });

  it("IT-TRF-007 cancel: REQUESTED by requester ok, APPROVED ok, DISPATCHED → 409; stock unchanged until dispatch", async () => {
    const x = await invItem(mgr, { openingStock: 5 });
    const a = await inv.post("/inventory/transfers", { toOutletId: fx.outletB.id, items: [{ inventoryItemId: x.id, quantity: 1 }] });
    expect((await inv.post(`/inventory/transfers/${a.body.id}/cancel`)).body.status).toBe("CANCELLED");
    const b = await mgr.post("/inventory/transfers", { toOutletId: fx.outletB.id, items: [{ inventoryItemId: x.id, quantity: 1 }] });
    expect((await mgrB.post(`/inventory/transfers/${b.body.id}/cancel`)).body.status).toBe("CANCELLED");
    const c = await mgr.post("/inventory/transfers", { toOutletId: fx.outletB.id, items: [{ inventoryItemId: x.id, quantity: 1 }] });
    await mgr.post(`/inventory/transfers/${c.body.id}/dispatch`);
    expect((await mgr.post(`/inventory/transfers/${c.body.id}/cancel`)).status).toBe(409);
    expect(await stockOf(fx.outletA.id, x.id)).toBe(4);
    expect((await mgr.post(`/inventory/transfers/${a.body.id}/dispatch`)).status).toBe(409);
  });

  it("IT-TRF-008 create validation: same outlet, both/neither of to/from, unknown outlet → 400", async () => {
    const x = await invItem(inv, { openingStock: 1 });
    const items = [{ inventoryItemId: x.id, quantity: 1 }];
    expect((await inv.post("/inventory/transfers", { toOutletId: fx.outletA.id, items })).status).toBe(400);
    expect((await inv.post("/inventory/transfers", { toOutletId: fx.outletB.id, fromOutletId: fx.outletB.id, items })).status).toBe(400);
    expect((await inv.post("/inventory/transfers", { items })).status).toBe(400);
    expect((await inv.post("/inventory/transfers", { toOutletId: "nope-outlet", items })).status).toBe(400);
    expect((await inv.post("/inventory/transfers", { toOutletId: fx.outletB.id, items: [{ inventoryItemId: x.id, quantity: 0 }] })).status).toBe(400);
  });

  it("IT-TRF-009 @critical transfer to / from another business's outlet is refused (400) and no stock leaves", async () => {
    const x = await invItem(mgr, { openingStock: 5 });
    const items = [{ inventoryItemId: x.id, quantity: 1 }];
    expect((await mgr.post("/inventory/transfers", { toOutletId: other.outlet.id, items })).status).toBe(400);
    expect((await mgr.post("/inventory/transfers", { fromOutletId: other.outlet.id, items })).status).toBe(400);
    const theirs = await invItem(otherInv, { openingStock: 5 });
    expect((await mgr.post("/inventory/transfers", { toOutletId: fx.outletB.id, items: [{ inventoryItemId: theirs.id, quantity: 1 }] })).status).toBe(400);
    expect(await db.stockTransfer.count({ where: { OR: [{ toOutletId: other.outlet.id }, { fromOutletId: other.outlet.id }] } })).toBe(0);
  });

  it("IT-TRF-010 another business can't see or act on the transfer (404)", async () => {
    const x = await invItem(mgr, { openingStock: 5 });
    const c = await mgr.post("/inventory/transfers", { toOutletId: fx.outletB.id, items: [{ inventoryItemId: x.id, quantity: 1 }] });
    const otherMgr = await as(other.users.OUTLET_MANAGER.email, other.outlet.id);
    expect((await otherMgr.get(`/inventory/transfers/${c.body.id}`)).status).toBe(404);
    expect((await otherMgr.post(`/inventory/transfers/${c.body.id}/dispatch`)).status).toBe(404);
    expect((await otherMgr.post(`/inventory/transfers/${c.body.id}/cancel`)).status).toBe(404);
  });

  it("IT-TRF-011 list direction filters: outgoing at A / incoming at B", async () => {
    const x = await invItem(mgr, { openingStock: 5 });
    const c = await mgr.post("/inventory/transfers", { toOutletId: fx.outletB.id, items: [{ inventoryItemId: x.id, quantity: 1 }] });
    const out = await mgr.get("/inventory/transfers?direction=outgoing");
    expect(out.body.find((t: { id: string }) => t.id === c.body.id)?.direction).toBe("outgoing");
    const inc = await mgrB.get("/inventory/transfers?direction=incoming");
    expect(inc.body.find((t: { id: string }) => t.id === c.body.id)?.direction).toBe("incoming");
    expect((await mgrB.get("/inventory/transfers?direction=outgoing")).body.some((t: { id: string }) => t.id === c.body.id)).toBe(false);
    expect((await mgr.get("/inventory/transfers?status=BOGUS")).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
describe("@regression @critical Reconciliation (INV-007)", () => {
  it("IT-INV-080 opening + purchase − sales + reversal − wastage − transfer ± audit = stock = Σ ledger = hand-computed", async () => {
    const owner = await as(fx.users.BUSINESS_OWNER.email, fx.outletA.id);
    const cat = `Rec${uid()}`;
    const x = await invItem(owner, { unit: "KG", category: cat, openingStock: 20, costPerUnit: 4000 }); // 20
    const v = await vendor(owner);
    await purchase({ vendorId: v.id, receive: true, items: [{ inventoryItemId: x.id, quantity: 10, unitCost: 5000 }] }, owner); // 30
    const m = await menuItem(fx);
    await owner.put(`/inventory/recipes/${m.id}`, { lines: [{ inventoryItemId: x.id, quantity: 500, unit: "G" }] });
    await bill(cashier, [{ menuItemId: m.id, quantity: 4 }]); // −2 → 28
    const o2 = await bill(cashier, [{ menuItemId: m.id, quantity: 2 }]); // −1 → 27
    await owner.post(`/orders/${o2.id}/cancel`, { reason: "Returned" }); // +1 → 28
    await owner.post("/inventory/wastage", { items: [{ inventoryItemId: x.id, quantity: 1.5, reason: "Spoiled" }] }); // 26.5
    const t = await owner.post("/inventory/transfers", { toOutletId: fx.outletB.id, items: [{ inventoryItemId: x.id, quantity: 4 }] });
    await owner.post(`/inventory/transfers/${t.body.id}/dispatch`); // 22.5
    await mgrB.post(`/inventory/transfers/${t.body.id}/receive`);
    const au = await owner.post("/inventory/audits", { category: cat });
    expect(au.status).toBe(201);
    expect(au.body.lines[0].systemQty).toBe(22.5);
    await owner.put(`/inventory/audits/${au.body.id}/counts`, { counts: [{ inventoryItemId: x.id, countedQty: 22 }] });
    await owner.post(`/inventory/audits/${au.body.id}/complete`); // −0.5 → 22

    expect(await stockOf(fx.outletA.id, x.id)).toBe(22);
    expect(await ledgerSum(fx.outletA.id, x.id)).toBe(22);
    expect(await stockOf(fx.outletB.id, x.id)).toBe(4);
    expect(await ledgerSum(fx.outletB.id, x.id)).toBe(4);
    const last = await db.inventoryTransaction.findFirstOrThrow({ where: { outletId: fx.outletA.id, inventoryItemId: x.id }, orderBy: { createdAt: "desc" } });
    expect(last.balanceAfter).toBe(22);
    const mv = await owner.get(`/inventory/reports/movement?itemId=${x.id}`);
    expect(mv.body.rows[0]).toMatchObject({ closing: 22 });
    expect(mv.body.rows[0].byType).toMatchObject({ OPENING: 20, PURCHASE: 10, SALE: -3, SALE_REVERSAL: 1, WASTAGE: -1.5, TRANSFER_OUT: -4, AUDIT: -0.5 });
    // Weighted cost: 20 @ 4000 + 10 @ 5000 → 4333 (rounded)
    expect(await costOf(x.id)).toBe(Math.round((20 * 4000 + 10 * 5000) / 30));
    expect(r3(22)).toBe(22);
  });
});
