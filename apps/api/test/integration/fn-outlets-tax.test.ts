/**
 * QA Phase 5 — Group A functional tests: Outlets & GST settings, shifts, and
 * custom tax rates (/tax-rates) including their effect on the next bill.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createTenant, db, demoTenant } from "./helpers";
import { makeItem, sessionFor, uniqTag, type Agent } from "./fx-a";

type Tenant = Awaited<ReturnType<typeof createTenant>>;

const BASIC_KEYS = ["address", "businessId", "deliveryEnabled", "geofenceMeters", "gstEnabled", "id", "latitude", "logoUrl", "longitude", "name", "phone", "posShowImages", "timezone"];
const SENSITIVE = ["gstin", "upiVpa", "fssai", "invoicePrefix", "compositionScheme", "pricesIncludeTax", "legalName", "serviceChargePercent"];

async function ownerOf(t: Tenant) {
  return sessionFor(t.users.BUSINESS_OWNER.id, t.outlet.id);
}
async function bill(agent: Agent, menuItemId: string, interState = false) {
  const r = await agent.post("/orders", { orderType: "TAKEAWAY", interState, items: [{ menuItemId, quantity: 1 }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}

describe("Outlets — create / edit permissions", () => {
  it("IT-OUT-001 owner creates an outlet (no X-Outlet-Id needed); it appears in GET /outlets and is usable @regression @critical", async () => {
    const t = await createTenant();
    const owner = await sessionFor(t.users.BUSINESS_OWNER.id);
    const res = await owner.post("/outlets", { name: "New Branch", stateCode: "29", gstin: "29ABCDE1234F1Z5", invoicePrefix: "NB" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ businessId: t.business.id, gstEnabled: true, compositionScheme: false, invoicePrefix: "NB" });
    expect(res.body.warnings).toBeUndefined();
    const list = await owner.get("/outlets");
    expect(list.body.map((o: { id: string }) => o.id)).toContain(res.body.id);
    const there = await sessionFor(t.users.BUSINESS_OWNER.id, res.body.id);
    expect((await there.get("/outlets/current")).body.id).toBe(res.body.id);
    expect(await db.auditLog.count({ where: { action: "outlet.create", entityId: res.body.id } })).toBe(1);
  });

  it("IT-OUT-002 manager and cashier cannot create outlets → 403 @regression @critical", async () => {
    const t = await createTenant();
    for (const role of ["OUTLET_MANAGER", "CASHIER"] as const) {
      const s = await sessionFor(t.users[role].id, t.outlet.id);
      expect((await s.post("/outlets", { name: "Rogue", stateCode: "29" })).status, role).toBe(403);
    }
  });

  it("IT-OUT-003 GST on without a GSTIN is allowed with a warning; composition without GST → 400 @regression", async () => {
    const t = await createTenant();
    const owner = await sessionFor(t.users.BUSINESS_OWNER.id);
    const w = await owner.post("/outlets", { name: "No GSTIN", stateCode: "29" });
    expect(w.status).toBe(201);
    expect(w.body.warnings[0]).toMatch(/no GSTIN/);
    expect((await owner.post("/outlets", { name: "Bad comp", stateCode: "29", gstEnabled: false, compositionScheme: true })).status).toBe(400);
  });

  it("IT-OUT-004 manager edits own outlet (name + GST settings); cannot edit an outlet they don't manage @regression @critical", async () => {
    const t = await createTenant();
    const o2 = await db.outlet.create({ data: { businessId: t.business.id, name: "Other", stateCode: "33" } });
    const mgr = await sessionFor(t.users.OUTLET_MANAGER.id, t.outlet.id);
    const res = await mgr.patch("/outlets/current", { name: "Manager Edited", legalName: "Edited Foods LLP", gstin: "33ABCDE1234F1Z5" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: "Manager Edited", legalName: "Edited Foods LLP", gstin: "33ABCDE1234F1Z5" });
    const mgr2 = await sessionFor(t.users.OUTLET_MANAGER.id, o2.id);
    expect((await mgr2.patch("/outlets/current", { name: "Hijack" })).status).toBe(403);
    expect((await db.outlet.findUniqueOrThrow({ where: { id: o2.id } })).name).toBe("Other");
  });

  it("IT-OUT-005 cashier / kitchen cannot change outlet settings → 403 @regression @critical", async () => {
    const t = await createTenant();
    for (const role of ["CASHIER", "KITCHEN"] as const) {
      const s = await sessionFor(t.users[role].id, t.outlet.id);
      expect((await s.patch("/outlets/current", { name: "Nope" })).status, role).toBe(403);
      expect((await s.patch("/outlets/current", { gstEnabled: false })).status, role).toBe(403);
    }
  });
});

describe("Outlets — GST settings validation (BVA / decision table)", () => {
  let t: Tenant;
  let owner: Agent;
  beforeAll(async () => {
    t = await createTenant();
    owner = await ownerOf(t);
  });

  it.each([
    ["33ABCDE1234F1Z5", 200], ["", 200], ["33ABCDE1234F1Z", 400], ["33abcde1234f1z5", 400],
    ["33ABCDE1234F1Y5", 400], ["3XABCDE1234F1Z5", 400], ["33ABCDE1234F0Z5", 400], ["33ABCDE1234F1Z55", 400],
  ] as const)("IT-OUT-010 GSTIN %j → %i @regression", async (gstin, status) => {
    const r = await owner.patch("/outlets/current", { gstin });
    expect(r.status).toBe(status);
    if (gstin === "" && status === 200) expect(r.body.gstin).toBeNull();
  });

  it.each([
    ["A", 200], ["ABCDE", 200], ["INV26", 200], ["ABCDEF", 400], ["inv", 400], ["IN-V", 400], ["", 400], ["IN V", 400],
  ] as const)("IT-OUT-011 invoice prefix %j → %i (1–5 of A-Z0-9) @regression", async (invoicePrefix, status) => {
    expect((await owner.patch("/outlets/current", { invoicePrefix })).status).toBe(status);
  });

  it("IT-OUT-012 composition ON with GST on → OK; GST OFF forces composition off even if sent true @regression @critical", async () => {
    const on = await owner.patch("/outlets/current", { gstEnabled: true, compositionScheme: true });
    expect(on.status).toBe(200);
    expect(on.body.compositionScheme).toBe(true);
    const off = await owner.patch("/outlets/current", { gstEnabled: false, compositionScheme: true });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ gstEnabled: false, compositionScheme: false });
    // turning composition on while GST stays off → 400
    expect((await owner.patch("/outlets/current", { compositionScheme: true })).status).toBe(400);
    await owner.patch("/outlets/current", { gstEnabled: true });
  });

  it("IT-OUT-013 billing changes are audited with from/to @regression", async () => {
    await owner.patch("/outlets/current", { invoicePrefix: "AUD" });
    await owner.patch("/outlets/current", { invoicePrefix: "AUE" });
    const a = await db.auditLog.findFirstOrThrow({ where: { action: "outlet.update", entityId: t.outlet.id }, orderBy: { createdAt: "desc" } });
    expect(a.meta).toMatchObject({ billing: { invoicePrefix: { from: "AUD", to: "AUE" } } });
  });

  it("IT-OUT-014 numeric settings boundaries: service charge 0–20, packaging ≤ 100000 paise, geofence 20–5000, max deliveries 1–10 @regression", async () => {
    const cases: Array<[Record<string, number>, number]> = [
      [{ serviceChargePercent: 20 }, 200], [{ serviceChargePercent: 20.01 }, 400], [{ serviceChargePercent: -1 }, 400],
      [{ packagingCharge: 100_000 }, 200], [{ packagingCharge: 100_001 }, 400], [{ packagingCharge: 1.5 }, 400],
      [{ geofenceMeters: 20 }, 200], [{ geofenceMeters: 19 }, 400], [{ geofenceMeters: 5001 }, 400],
      [{ maxDeliveriesPerPartner: 1 }, 200], [{ maxDeliveriesPerPartner: 0 }, 400], [{ maxDeliveriesPerPartner: 11 }, 400],
    ];
    for (const [body, status] of cases) expect((await owner.patch("/outlets/current", body)).status, JSON.stringify(body)).toBe(status);
    await owner.patch("/outlets/current", { packagingCharge: 0, serviceChargePercent: 0 });
  });

  // BUG-CANDIDATE-A7: the GSTIN's first two digits ARE the GST state code, and
  // the outlet's stateCode decides CGST+SGST vs IGST. The API accepts a GSTIN
  // from Karnataka (29…) on a Tamil Nadu (33) outlet, so tax invoices print a
  // GSTIN that contradicts the place of supply. Expected 400. Actual 200.
  it.fails("IT-OUT-015 GSTIN state code must match the outlet state code (BUG-CANDIDATE-A7) @regression", async () => {
    const r = await owner.patch("/outlets/current", { gstin: "29ABCDE1234F1Z5" }); // outlet stateCode is 33
    expect(r.status).toBe(400);
  });
});

describe("Outlets — who sees what (GET /outlets/current, GET /outlets)", () => {
  it("IT-OUT-020 kitchen / delivery / inventory get basic fields only — no GSTIN, UPI ID or billing config @regression @critical", async () => {
    const d = await demoTenant();
    for (const email of ["kitchen@canavo.local", "delivery@canavo.local", "inventory@canavo.local"]) {
      const s = await sessionFor(email, d.outlet.id);
      const cur = await s.get("/outlets/current");
      expect(cur.status, email).toBe(200);
      expect(Object.keys(cur.body).sort(), email).toEqual(BASIC_KEYS);
      const list = await s.get("/outlets");
      for (const o of list.body) for (const k of SENSITIVE) expect(o, `${email} ${k}`).not.toHaveProperty(k);
    }
  });

  it("IT-OUT-021 owner / manager / cashier get the full outlet incl. GSTIN and billing config @regression", async () => {
    const d = await demoTenant();
    for (const email of ["owner@canavo.local", "manager@canavo.local", "cashier@canavo.local"]) {
      const cur = await (await sessionFor(email, d.outlet.id)).get("/outlets/current");
      expect(cur.status).toBe(200);
      expect(cur.body.gstin, email).toBe("29ABCDE1234F1Z5");
      for (const k of ["invoicePrefix", "pricesIncludeTax", "compositionScheme", "upiVpa"]) expect(cur.body, `${email} ${k}`).toHaveProperty(k);
    }
  });

  it("IT-OUT-022 X-Outlet-Id of another business → 403 @regression @critical", async () => {
    const t = await createTenant();
    const d = await demoTenant();
    const s = await sessionFor(t.users.BUSINESS_OWNER.id, d.outlet.id);
    expect((await s.get("/outlets/current")).status).toBe(403);
    expect((await s.patch("/outlets/current", { name: "pwn" })).status).toBe(403);
  });
});

describe("Outlets — shifts", () => {
  it("IT-OUT-030 manager creates / lists / deletes shifts; cashier can list but not create @regression", async () => {
    const t = await createTenant();
    const mgr = await sessionFor(t.users.OUTLET_MANAGER.id, t.outlet.id);
    const c = await mgr.post("/outlets/current/shifts", { name: "Night", startTime: "22:00", endTime: "06:00" });
    expect(c.status).toBe(201);
    expect(c.body).toMatchObject({ outletId: t.outlet.id, graceMinutes: 10 });
    const cashier = await sessionFor(t.users.CASHIER.id, t.outlet.id);
    expect((await cashier.get("/outlets/current/shifts")).body.map((s: { id: string }) => s.id)).toContain(c.body.id);
    expect((await cashier.post("/outlets/current/shifts", { name: "X", startTime: "09:00", endTime: "10:00" })).status).toBe(403);
    expect((await mgr.delete(`/outlets/current/shifts/${c.body.id}`)).status).toBe(204);
    expect(await db.shift.count({ where: { id: c.body.id } })).toBe(0);
  });

  it.each([
    [{ name: "Bad", startTime: "24:00", endTime: "06:00" }], [{ name: "Bad", startTime: "9:00", endTime: "17:00" }],
    [{ name: "", startTime: "09:00", endTime: "17:00" }], [{ name: "Bad", startTime: "09:00", endTime: "17:00", graceMinutes: 121 }],
    [{ name: "Bad", startTime: "09:00", endTime: "17:60" }],
  ])("IT-OUT-031 invalid shift %j → 400 @regression", async (body) => {
    const t = await createTenant();
    const mgr = await sessionFor(t.users.OUTLET_MANAGER.id, t.outlet.id);
    expect((await mgr.post("/outlets/current/shifts", body)).status).toBe(400);
  });

  it("IT-OUT-032 deleting another outlet's shift through your own outlet does nothing @regression @critical", async () => {
    const t = await createTenant();
    const other = await createTenant();
    const foreign = await db.shift.create({ data: { outletId: other.outlet.id, name: "Foreign", startTime: "09:00", endTime: "17:00" } });
    const mgr = await sessionFor(t.users.OUTLET_MANAGER.id, t.outlet.id);
    await mgr.delete(`/outlets/current/shifts/${foreign.id}`);
    expect(await db.shift.count({ where: { id: foreign.id } })).toBe(1);
  });

  it("IT-OUT-033 deleting a shift that staff are assigned to does not 500 @regression", async () => {
    const t = await createTenant();
    const shift = await db.shift.create({ data: { outletId: t.outlet.id, name: "Assigned", startTime: "09:00", endTime: "17:00" } });
    await db.user.update({ where: { id: t.users.CASHIER.id }, data: { shiftId: shift.id } });
    const mgr = await sessionFor(t.users.OUTLET_MANAGER.id, t.outlet.id);
    const r = await mgr.delete(`/outlets/current/shifts/${shift.id}`);
    expect(r.status).toBeLessThan(500);
    if (r.status === 204) expect((await db.user.findUniqueOrThrow({ where: { id: t.users.CASHIER.id } })).shiftId).toBeNull();
  });
});

describe("Outlets — GST settings change the next bill", () => {
  it("IT-OUT-040 GST on → TAX_INVOICE with tax; GST off → plain BILL at menu price; composition → BILL_OF_SUPPLY with no tax @regression @critical", async () => {
    const t = await createTenant();
    const owner = await ownerOf(t);
    await owner.patch("/outlets/current", { pricesIncludeTax: false, roundOff: false, gstin: "33ABCDE1234F1Z5" });
    const item = await makeItem(t.business.id, { price: 10_000, gstRate: 5 });
    const cashier = await sessionFor(t.users.CASHIER.id, t.outlet.id);

    const b1 = await bill(cashier, item.id);
    expect(b1).toMatchObject({ documentType: "TAX_INVOICE", cgst: 250, sgst: 250, igst: 0, grandTotal: 10_500 });

    await owner.patch("/outlets/current", { gstEnabled: false });
    const b2 = await bill(cashier, item.id);
    expect(b2).toMatchObject({ documentType: "BILL", cgst: 0, sgst: 0, igst: 0, grandTotal: 10_000 });

    await owner.patch("/outlets/current", { gstEnabled: true, compositionScheme: true });
    const b3 = await bill(cashier, item.id);
    expect(b3).toMatchObject({ documentType: "BILL_OF_SUPPLY", cgst: 0, sgst: 0, igst: 0, grandTotal: 10_000 });
  });

  it("IT-OUT-041 inter-state bill uses IGST instead of CGST+SGST @regression @critical", async () => {
    const t = await createTenant();
    const owner = await ownerOf(t);
    await owner.patch("/outlets/current", { pricesIncludeTax: false, roundOff: false });
    const item = await makeItem(t.business.id, { price: 10_000, gstRate: 18 });
    const b = await bill(await sessionFor(t.users.CASHIER.id, t.outlet.id), item.id, true);
    expect(b).toMatchObject({ cgst: 0, sgst: 0, igst: 1_800, grandTotal: 11_800 });
  });

  it("IT-OUT-042 prices-include-tax keeps the grand total at menu price; invoice prefix change shows on the next invoice @regression", async () => {
    const t = await createTenant();
    const owner = await ownerOf(t);
    await owner.patch("/outlets/current", { pricesIncludeTax: true, roundOff: true, invoicePrefix: "QAX" });
    const item = await makeItem(t.business.id, { price: 10_500, gstRate: 5 });
    const b = await bill(await sessionFor(t.users.CASHIER.id, t.outlet.id), item.id);
    expect(b.grandTotal).toBe(10_500);
    expect(b.cgst + b.sgst).toBe(500);
    expect(b.invoiceNumber).toMatch(/^QAX/);
  });
});

describe("Tax rates — /tax-rates", () => {
  const vat = { name: "Liquor VAT", cgst: 2.5, sgst: 2.5, cess: 1, extras: [{ label: "VAT", percent: 2 }] };

  it("IT-TAX-001 create custom rate: IGST defaults to CGST+SGST, no warnings; first active rate becomes default @regression @critical", async () => {
    const t = await createTenant();
    const owner = await ownerOf(t);
    const r = await owner.post("/tax-rates", vat);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ name: "Liquor VAT", cgst: 2.5, sgst: 2.5, igst: 5, cess: 1, isDefault: true, active: true, itemCount: 0 });
    expect(r.body.extras).toEqual([{ label: "VAT", percent: 2 }]);
    expect(r.body.warnings).toBeUndefined();
    const second = await owner.post("/tax-rates", { name: "GST 12", cgst: 6, sgst: 6 });
    expect(second.body.isDefault).toBe(false);
  });

  it("IT-TAX-002 warnings: CGST≠SGST and IGST≠CGST+SGST (each and both) @regression", async () => {
    const t = await createTenant();
    const owner = await ownerOf(t);
    const a = await owner.post("/tax-rates", { name: "Uneven", cgst: 2, sgst: 3 });
    expect(a.status).toBe(201);
    expect(a.body.warnings).toHaveLength(1);
    expect(a.body.warnings[0]).toMatch(/CGST and SGST/);
    const b = await owner.post("/tax-rates", { name: "Odd IGST", cgst: 2.5, sgst: 2.5, igst: 6 });
    expect(b.body.warnings).toEqual([expect.stringMatching(/IGST is normally/)]);
    const c = await owner.post("/tax-rates", { name: "Both", cgst: 1, sgst: 2, igst: 9 });
    expect(c.body.warnings).toHaveLength(2);
  });

  it("IT-TAX-003 validation BVA: <0, >100, 4 decimals, extra 0%, 11 extras, empty name → 400; 100 and 3 decimals OK @regression", async () => {
    const t = await createTenant();
    const owner = await ownerOf(t);
    const bad = [
      { name: "N", cgst: -0.001, sgst: 0 }, { name: "N", cgst: 100.001, sgst: 0 }, { name: "N", cgst: 1.0005, sgst: 1 },
      { name: "N", cgst: 1, sgst: 1, extras: [{ label: "X", percent: 0 }] },
      { name: "N", cgst: 1, sgst: 1, extras: Array.from({ length: 11 }, (_, i) => ({ label: `E${i}`, percent: 1 })) },
      { name: "   ", cgst: 1, sgst: 1 }, { name: "N", cgst: "5", sgst: 1 },
    ];
    for (const b of bad) expect((await owner.post("/tax-rates", b)).status, JSON.stringify(b)).toBe(400);
    expect((await owner.post("/tax-rates", { name: "Max", cgst: 100, sgst: 0, igst: 100 })).status).toBe(201);
    expect((await owner.post("/tax-rates", { name: "Three dp", cgst: 1.125, sgst: 1.125 })).status).toBe(201);
  });

  it("IT-TAX-004 duplicate name (case-insensitive) → 409; same name in another business is fine @regression", async () => {
    const t = await createTenant();
    const other = await createTenant();
    expect((await (await ownerOf(t)).post("/tax-rates", { name: "Special 5", cgst: 2.5, sgst: 2.5 })).status).toBe(201);
    expect((await (await ownerOf(t)).post("/tax-rates", { name: "SPECIAL 5", cgst: 2.5, sgst: 2.5 })).status).toBe(409);
    expect((await (await ownerOf(other)).post("/tax-rates", { name: "Special 5", cgst: 2.5, sgst: 2.5 })).status).toBe(201);
  });

  it("IT-TAX-005 exactly one default: a new default demotes the old one; unsetting/deactivating the default → 400; inactive+default → 400 @regression @critical", async () => {
    const t = await createTenant();
    const owner = await ownerOf(t);
    const a = await owner.post("/tax-rates", { name: "A", cgst: 2.5, sgst: 2.5 });
    const b = await owner.post("/tax-rates", { name: "B", cgst: 9, sgst: 9, isDefault: true });
    expect(b.body.isDefault).toBe(true);
    expect(await db.taxRate.count({ where: { businessId: t.business.id, isDefault: true } })).toBe(1);
    expect((await owner.patch(`/tax-rates/${b.body.id}`, { isDefault: false })).status).toBe(400);
    expect((await owner.patch(`/tax-rates/${b.body.id}`, { active: false })).status).toBe(400);
    expect((await owner.post("/tax-rates", { name: "C", cgst: 1, sgst: 1, isDefault: true, active: false })).status).toBe(400);
    expect((await owner.patch(`/tax-rates/${a.body.id}`, { isDefault: true })).body.isDefault).toBe(true);
    expect(await db.taxRate.count({ where: { businessId: t.business.id, isDefault: true } })).toBe(1);
  });

  it("IT-TAX-006 permissions: cashier & kitchen can read, not write; delivery cannot read; manager can write @regression @critical", async () => {
    const t = await createTenant();
    const rate = await (await ownerOf(t)).post("/tax-rates", { name: "R", cgst: 2.5, sgst: 2.5 });
    for (const role of ["CASHIER", "KITCHEN"] as const) {
      const s = await sessionFor(t.users[role].id, t.outlet.id);
      expect((await s.get("/tax-rates")).status, role).toBe(200);
      expect((await s.post("/tax-rates", { name: "X", cgst: 1, sgst: 1 })).status, role).toBe(403);
      expect((await s.patch(`/tax-rates/${rate.body.id}`, { cgst: 9 })).status, role).toBe(403);
      expect((await s.delete(`/tax-rates/${rate.body.id}`)).status, role).toBe(403);
    }
    expect((await (await sessionFor(t.users.DELIVERY.id, t.outlet.id)).get("/tax-rates")).status).toBe(403);
    expect((await (await sessionFor(t.users.OUTLET_MANAGER.id, t.outlet.id)).post("/tax-rates", { name: "M", cgst: 6, sgst: 6 })).status).toBe(201);
  });

  it("IT-TAX-007 a menu item linked to the rate bills CGST/SGST/cess/extra exactly; inter-state uses IGST @regression @critical", async () => {
    const t = await createTenant();
    const owner = await ownerOf(t);
    await owner.patch("/outlets/current", { pricesIncludeTax: false, roundOff: false });
    const rate = await owner.post("/tax-rates", vat);
    const cat = await owner.post("/menu/categories", { name: "Bar" });
    const item = await owner.post("/menu/items", { name: "Beer", categoryId: cat.body.id, price: 10_000, taxRateId: rate.body.id });
    expect(item.status).toBe(201);
    expect(item.body.gstRate).toBe(5);
    const cashier = await sessionFor(t.users.CASHIER.id, t.outlet.id);
    const intra = await bill(cashier, item.body.id);
    expect(intra).toMatchObject({ cgst: 250, sgst: 250, igst: 0, cess: 100, otherTaxes: 200, grandTotal: 10_800 });
    const inter = await bill(cashier, item.body.id, true);
    expect(inter).toMatchObject({ cgst: 0, sgst: 0, igst: 500, cess: 100, otherTaxes: 200, grandTotal: 10_800 });
  });

  it("IT-TAX-008 editing a rate re-syncs linked items and the next bill uses the new %; IGST follows CGST+SGST @regression @critical", async () => {
    const t = await createTenant();
    const owner = await ownerOf(t);
    await owner.patch("/outlets/current", { pricesIncludeTax: false, roundOff: false });
    const rate = await owner.post("/tax-rates", { name: "Edit me", cgst: 2.5, sgst: 2.5 });
    const item = await makeItem(t.business.id, { price: 10_000, gstRate: 5, taxRateId: rate.body.id });
    const upd = await owner.patch(`/tax-rates/${rate.body.id}`, { cgst: 9, sgst: 9 });
    expect(upd.status).toBe(200);
    expect(upd.body.igst).toBe(18);
    expect((await db.menuItem.findUniqueOrThrow({ where: { id: item.id } })).gstRate).toBe(18);
    const b = await bill(await sessionFor(t.users.CASHIER.id, t.outlet.id), item.id);
    expect(b).toMatchObject({ cgst: 900, sgst: 900, grandTotal: 11_800 });
  });

  it("IT-TAX-009 delete: in-use → 409 with itemCount; reassignTo self/inactive/unknown → 400/400/404; reassign moves items @regression @critical", async () => {
    const t = await createTenant();
    const owner = await ownerOf(t);
    await owner.post("/tax-rates", { name: "Default", cgst: 0, sgst: 0 });
    const used = await owner.post("/tax-rates", { name: "Used", cgst: 2.5, sgst: 2.5 });
    const target = await owner.post("/tax-rates", { name: "Target", cgst: 9, sgst: 9 });
    const inactive = await owner.post("/tax-rates", { name: "Inactive", cgst: 6, sgst: 6, active: false });
    const item = await makeItem(t.business.id, { taxRateId: used.body.id });
    const r1 = await owner.delete(`/tax-rates/${used.body.id}`);
    expect(r1.status).toBe(409);
    expect(r1.body.details).toEqual({ itemCount: 1 });
    expect((await owner.delete(`/tax-rates/${used.body.id}?reassignTo=${used.body.id}`)).status).toBe(400);
    expect((await owner.delete(`/tax-rates/${used.body.id}?reassignTo=${inactive.body.id}`)).status).toBe(400);
    expect((await owner.delete(`/tax-rates/${used.body.id}?reassignTo=nope`)).status).toBe(404);
    expect((await owner.delete(`/tax-rates/${used.body.id}?reassignTo=${target.body.id}`)).status).toBe(204);
    const after = await db.menuItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.taxRateId).toBe(target.body.id);
    expect(after.gstRate).toBe(18);
    expect(await db.taxRate.count({ where: { id: used.body.id } })).toBe(0);
  });

  it("IT-TAX-010 deleting the default without reassignTo → 409; with reassignTo the target becomes default @regression", async () => {
    const t = await createTenant();
    const owner = await ownerOf(t);
    const def = await owner.post("/tax-rates", { name: "Def", cgst: 2.5, sgst: 2.5 });
    const other = await owner.post("/tax-rates", { name: "Other", cgst: 6, sgst: 6 });
    expect((await owner.delete(`/tax-rates/${def.body.id}`)).status).toBe(409);
    expect((await owner.delete(`/tax-rates/${def.body.id}?reassignTo=${other.body.id}`)).status).toBe(204);
    expect((await db.taxRate.findUniqueOrThrow({ where: { id: other.body.id } })).isDefault).toBe(true);
  });

  it("IT-TAX-011 cross-business isolation: GET/PATCH/DELETE another business's rate → 404; linking it to a menu item → 400; reassignTo it → 404 @regression @critical", async () => {
    const a = await createTenant();
    const b = await createTenant();
    const rateA = await (await ownerOf(a)).post("/tax-rates", { name: "A only", cgst: 2.5, sgst: 2.5 });
    const ownerB = await ownerOf(b);
    const rateB = await ownerB.post("/tax-rates", { name: "B only", cgst: 6, sgst: 6 });
    expect((await ownerB.get(`/tax-rates/${rateA.body.id}`)).status).toBe(404);
    expect((await ownerB.patch(`/tax-rates/${rateA.body.id}`, { cgst: 50, sgst: 50 })).status).toBe(404);
    expect((await ownerB.delete(`/tax-rates/${rateA.body.id}`)).status).toBe(404);
    expect((await ownerB.delete(`/tax-rates/${rateB.body.id}?reassignTo=${rateA.body.id}`)).status).toBe(404);
    expect((await ownerB.get("/tax-rates")).body.map((r: { id: string }) => r.id)).not.toContain(rateA.body.id);
    const cat = await ownerB.post("/menu/categories", { name: "Cat" });
    expect((await ownerB.post("/menu/items", { name: "Steal", categoryId: cat.body.id, price: 100, taxRateId: rateA.body.id })).status).toBe(400);
    expect((await db.taxRate.findUniqueOrThrow({ where: { id: rateA.body.id } })).cgst).toBe(2.5);
  });

  it("IT-TAX-012 /tax-rates works without X-Outlet-Id for owners; another business's outlet header → 403 @regression", async () => {
    const t = await createTenant();
    const d = await demoTenant();
    expect((await (await sessionFor(t.users.BUSINESS_OWNER.id)).get("/tax-rates")).status).toBe(200);
    expect((await (await sessionFor(t.users.BUSINESS_OWNER.id, d.outlet.id)).get("/tax-rates")).status).toBe(403);
  });

  it("IT-TAX-013 unknown rate id → 404 on GET/PATCH/DELETE @regression", async () => {
    const t = await createTenant();
    const owner = await ownerOf(t);
    const id = `nope-${uniqTag()}`;
    expect((await owner.get(`/tax-rates/${id}`)).status).toBe(404);
    expect((await owner.patch(`/tax-rates/${id}`, { cgst: 1 })).status).toBe(404);
    expect((await owner.delete(`/tax-rates/${id}`)).status).toBe(404);
  });
});
