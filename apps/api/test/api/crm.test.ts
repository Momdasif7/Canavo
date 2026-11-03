/**
 * QA Phase 6 — /customers (profiles, POS lookup, loyalty, khata/credit, phone uniqueness, PII)
 * and /offers (offers, coupons, validation, usage limits, priority, coupon report).
 * The one-offer-per-bill rule is a documented business rule: asserted, never changed here.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotel, startServer } from "../integration/helpers";
import { db, GHOST, intMoney, isolation, LONG, login, NAMES, noSecrets, rbacMatrix, rejects, rejectsQuery, world, type Ep, type World } from "./kit";

let srv: Awaited<ReturnType<typeof startServer>>;
let w: World;
const owner = () => w.as.BUSINESS_OWNER;
let seq = 0;
const phone = () => `7${String(Date.now()).slice(-6)}${String(seq++).padStart(3, "0")}`;
async function customer(extra: Record<string, unknown> = {}) {
  const r = await owner().call("POST", "/customers", { phone: phone(), name: "Ravi", ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; phone: string };
}

beforeAll(async () => {
  srv = await startServer();
  w = await world(srv.base, "CRM API");
});
afterAll(() => srv.close());

describe("RBAC + isolation", () => {
  it("customers: view / manage / payment:collect / order:create per endpoint, every role", async () => {
    const G = GHOST;
    const eps: Ep[] = [
      { method: "GET", path: "/customers", perms: ["customer:view"] },
      { method: "GET", path: "/customers/lookup?phone=9876543210", perms: ["customer:view"] },
      { method: "GET", path: "/customers/khata/outstanding", perms: ["customer:view"] },
      { method: "GET", path: "/customers/loyalty/config", perms: ["customer:manage"] },
      { method: "PUT", path: "/customers/loyalty/config", perms: ["customer:manage"] },
      { method: "POST", path: "/customers/preview-promotions", perms: ["order:create"] },
      { method: "POST", path: "/customers", perms: ["customer:view"] },
      { method: "GET", path: `/customers/${G}`, perms: ["customer:view"] },
      { method: "GET", path: `/customers/${G}/loyalty`, perms: ["customer:view"] },
      { method: "GET", path: `/customers/${G}/khata`, perms: ["customer:view"] },
      { method: "PATCH", path: `/customers/${G}`, perms: ["customer:manage"] },
      { method: "POST", path: `/customers/${G}/block`, perms: ["customer:manage"] },
      { method: "POST", path: `/customers/${G}/loyalty/adjust`, perms: ["customer:manage"] },
      { method: "POST", path: `/customers/${G}/khata/settle`, perms: ["payment:collect"] },
      { method: "POST", path: `/customers/${G}/khata/remind`, perms: ["customer:view"] },
    ];
    await rbacMatrix(w, eps);
  });

  it("offers: offer:manage / order:create per endpoint, every role", async () => {
    const G = GHOST;
    const M: Ep["perms"] = ["offer:manage"];
    const eps: Ep[] = [
      { method: "GET", path: "/offers", perms: M },
      { method: "GET", path: "/offers/active", perms: ["order:create"] },
      { method: "GET", path: "/offers/coupons", perms: M },
      { method: "POST", path: "/offers/coupons/validate", perms: ["order:create"] },
      { method: "GET", path: "/offers/coupons/report", perms: M },
      { method: "POST", path: "/offers/coupons", perms: M },
      { method: "GET", path: `/offers/coupons/${G}`, perms: M },
      { method: "PATCH", path: `/offers/coupons/${G}`, perms: M },
      { method: "DELETE", path: `/offers/coupons/${G}`, perms: M },
      { method: "POST", path: "/offers", perms: M },
      { method: "GET", path: `/offers/${G}`, perms: M },
      { method: "PATCH", path: `/offers/${G}`, perms: M },
      { method: "POST", path: `/offers/${G}/toggle`, perms: M },
      { method: "DELETE", path: `/offers/${G}`, perms: M },
    ];
    await rbacMatrix(w, eps);
  });

  it("another hotel / unassigned outlet / super admin can't read or touch hotel A's customers and offers", async () => {
    const c = await customer();
    const off = (await owner().call("POST", "/offers", { name: "Iso", type: "BILL_DISCOUNT", config: { discountType: "FLAT", value: 100 } })).body;
    const cp = (await owner().call("POST", "/offers/coupons", { code: `ISO${seq++}`, discountType: "FLAT", value: 100 })).body;
    await isolation(w, [
      { method: "GET", path: `/customers/${c.id}` },
      { method: "GET", path: `/customers/${c.id}/loyalty` },
      { method: "GET", path: `/customers/${c.id}/khata` },
      { method: "PATCH", path: `/customers/${c.id}`, body: { name: "Hacked" } },
      { method: "POST", path: `/customers/${c.id}/block`, body: { blocked: true } },
      { method: "POST", path: `/customers/${c.id}/loyalty/adjust`, body: { points: 1000, note: "gift" } },
      { method: "POST", path: `/customers/${c.id}/khata/settle`, body: { amount: 1, mode: "CASH" } },
      { method: "GET", path: `/offers/${off.id}` },
      { method: "PATCH", path: `/offers/${off.id}`, body: { name: "Hacked" } },
      { method: "POST", path: `/offers/${off.id}/toggle` },
      { method: "DELETE", path: `/offers/${off.id}` },
      { method: "GET", path: `/offers/coupons/${cp.id}` },
      { method: "PATCH", path: `/offers/coupons/${cp.id}`, body: { value: 99 } },
      { method: "DELETE", path: `/offers/coupons/${cp.id}` },
    ]);
    expect(await db.customer.findUniqueOrThrow({ where: { id: c.id } })).toMatchObject({ name: "Ravi", points: 0, blocked: false });
    expect(await db.offer.findUniqueOrThrow({ where: { id: off.id } })).toMatchObject({ name: "Iso", active: true });
    expect((await db.coupon.findUniqueOrThrow({ where: { id: cp.id } })).value).toBe(100);
    // Lookup by phone in another hotel: not found (phones are per business)
    const look = await w.other.owner.call("GET", `/customers/lookup?phone=${c.phone}`);
    expect(look.body.found).toBe(false);
    const list = await w.other.owner.call("GET", `/customers?search=${c.phone}`);
    expect(list.body.total).toBe(0);
    // Another hotel's coupon code doesn't validate here
    const theirs = (await w.other.owner.call("POST", "/offers/coupons", { code: `THEIRS${seq++}`, discountType: "FLAT", value: 100 })).body;
    expect((await owner().call("POST", "/offers/coupons/validate", { code: theirs.code, subtotal: 10000 })).status).toBe(400);
  });

  it("modules: CUSTOMERS off → customer pages 403 but the POS promotions preview still works; OFFERS off → 403", async () => {
    const hb = await createHotel("Billing only", { modules: ["BILLING"] });
    const c = await login(srv.base, hb.users.owner.email, hb.outletId);
    expect((await c.call("GET", "/customers")).status).toBe(403);
    expect((await c.call("POST", "/customers", { phone: phone() })).status).toBe(403);
    expect((await c.call("GET", "/offers")).status).toBe(403);
    const p = await c.call("POST", "/customers/preview-promotions", { orderType: "TAKEAWAY", items: [{ menuItemId: hb.items.chai, quantity: 1 }] });
    expect(p.status).toBe(200);
  });
});

describe("customers", () => {
  it("create → 201 with integer money fields; unicode names; no secrets in list / profile", async () => {
    for (const name of NAMES) {
      const r = await owner().call("POST", "/customers", { phone: phone(), name: name.slice(0, 100), email: "a@b.in", birthday: "02-29" });
      expect(r.status).toBe(201);
      expect(r.body.name).toBe(name.slice(0, 100));
      intMoney(r.body, ["totalSpend", "points", "khataBalance", "khataLimit"]);
    }
    const c = await customer();
    const p = await w.as.CASHIER.call("GET", `/customers/${c.id}`);
    expect(p.status).toBe(200);
    expect(p.body.visitHeatmap).toHaveLength(7);
    noSecrets(p.body);
    const l = await w.as.WAITER.call("GET", "/customers?limit=5");
    expect(l.status).toBe(200);
    noSecrets(l.body);
    expect((await owner().call("GET", `/customers/${GHOST}`)).status).toBe(404);
  });

  it("qac-5: a phone already used in this hotel → 409 Conflict (create and update)", async () => {
    const a = await customer();
    const b = await customer();
    const dup = await owner().call("POST", "/customers", { phone: a.phone });
    expect(dup.status).toBe(409);
    expect(dup.body.details?.id).toBe(a.id);
    expect((await owner().call("PATCH", `/customers/${b.id}`, { phone: a.phone })).status).toBe(409);
    expect((await owner().call("PATCH", `/customers/${a.id}`, { phone: a.phone, name: "Same phone ok" })).status).toBe(200);
    // Same phone in another hotel is a different customer
    expect((await w.other.owner.call("POST", "/customers", { phone: a.phone })).status).toBe(201);
  });

  it("mass assignment: points / khataBalance / tier / totalSpend / businessId in the body are ignored", async () => {
    const r = await w.as.CASHIER.call("POST", "/customers", { phone: phone(), points: 99999, khataBalance: 50000, tier: "PLATINUM", totalSpend: 9e6, businessId: w.other.h.businessId, blocked: true });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ points: 0, khataBalance: 0, tier: "BRONZE", totalSpend: 0, businessId: w.h.businessId, blocked: false });
    const u = await owner().call("PATCH", `/customers/${r.body.id}`, { points: 5000, khataBalance: 1, tier: "GOLD" });
    expect(u.body).toMatchObject({ points: 0, khataBalance: 0, tier: "BRONZE" });
  });

  it("validation → 400 and nothing written; cashiers can't set a khata limit (403)", async () => {
    const before = await db.customer.count({ where: { businessId: w.h.businessId } });
    await rejects(owner(), "POST", "/customers", [
      {},
      { phone: "12345" },
      { phone: "5876543210" },
      { phone: 9876543210 },
      { phone: phone(), name: LONG },
      { phone: phone(), email: "not-mail" },
      { phone: phone(), birthday: "13-01" },
      { phone: phone(), khataLimit: -1 },
      { phone: phone(), khataLimit: 1.5 },
      { phone: phone(), khataLimit: 1e13 },
      { phone: phone(), notes: LONG },
      { phone: null },
    ]);
    expect(await db.customer.count({ where: { businessId: w.h.businessId } })).toBe(before);
    expect((await w.as.CASHIER.call("POST", "/customers", { phone: phone(), khataLimit: 100000 })).status).toBe(403);
  });

  it("list: pagination, filters, sorting, limit caps; search with SQL text is inert", async () => {
    for (let i = 0; i < 3; i++) await customer({ name: `Page ${i}` });
    const p1 = await owner().call("GET", "/customers?limit=2&page=1&sort=name");
    const p2 = await owner().call("GET", "/customers?limit=2&page=2&sort=name");
    expect(p1.body.items).toHaveLength(2);
    expect(p1.body.items[0].id).not.toBe(p2.body.items[0]?.id);
    expect(p1.body.total).toBeGreaterThanOrEqual(3);
    expect((await owner().call("GET", "/customers?page=9999")).body.items).toEqual([]);
    expect((await owner().call("GET", "/customers?search=%27%20OR%201%3D1--")).body.total).toBe(0);
    await rejectsQuery(owner(), "/customers", ["limit=0", "limit=201", "page=0", "sort=phone", "tier=DIAMOND", "hasKhata=2", "limit=abc"]);
    await rejectsQuery(owner(), "/customers/lookup", ["phone=123", "phone=", "phone=98765432101"]);
  });

  it("Idempotency-Key: the same create twice → one customer, same response; a different body → 422/409", async () => {
    const key = `idem-${Date.now()}`;
    const body = { phone: phone(), name: "Idem" };
    const a = await w.as.CASHIER.call("POST", "/customers", body, { "idempotency-key": key });
    const b = await w.as.CASHIER.call("POST", "/customers", body, { "idempotency-key": key });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.id).toBe(a.body.id);
    expect(await db.customer.count({ where: { businessId: w.h.businessId, phone: body.phone } })).toBe(1);
    const c = await w.as.CASHIER.call("POST", "/customers", { ...body, phone: phone() }, { "idempotency-key": key });
    expect([409, 422]).toContain(c.status);
    // Without a key, a double submit is caught by phone uniqueness
    expect((await w.as.CASHIER.call("POST", "/customers", body)).status).toBe(409);
  });

  it("POS lookup: found / not found with loyalty settings", async () => {
    const c = await customer();
    const r = await w.as.CASHIER.call("GET", `/customers/lookup?phone=${c.phone}`);
    expect(r.body).toMatchObject({ found: true, id: c.id, points: 0 });
    intMoney(r.body, ["redeemableValue", "khataBalance"]);
    expect((await w.as.CASHIER.call("GET", "/customers/lookup?phone=9000000001")).body.found).toBe(false);
  });

  it("loyalty adjust: signed points, never below zero, huge / float / zero → 400; ledger paginates", async () => {
    const c = await customer();
    expect((await owner().call("POST", `/customers/${c.id}/loyalty/adjust`, { points: 150, note: "Welcome bonus" })).body.customer.points).toBe(150);
    await rejects(owner(), "POST", `/customers/${c.id}/loyalty/adjust`, [
      { points: -151, note: "Too many" }, { points: 0, note: "zero" }, { points: 1.5, note: "float" }, { points: 10, note: "x" }, { points: 1e12, note: "huge one" }, { points: 2 ** 31, note: "overflow" },
    ]);
    expect((await owner().call("POST", `/customers/${GHOST}/loyalty/adjust`, { points: 1, note: "ghost" })).status).toBe(404);
    const led = await owner().call("GET", `/customers/${c.id}/loyalty?limit=1`);
    expect(led.body).toMatchObject({ total: 1, balance: 150 });
    await rejectsQuery(owner(), `/customers/${c.id}/loyalty`, ["limit=201", "page=0"]);
    expect((await db.customer.findUniqueOrThrow({ where: { id: c.id } })).points).toBe(150);
  });

  it("khata: settle up to the balance (cashier may collect), never more; remind needs a balance", async () => {
    const c = await customer();
    expect((await w.as.CASHIER.call("POST", `/customers/${c.id}/khata/settle`, { amount: 100, mode: "CASH" })).status).toBe(400);
    expect((await owner().call("POST", `/customers/${c.id}/khata/remind`)).status).toBe(400);
    await db.customer.update({ where: { id: c.id }, data: { khataBalance: 5000 } });
    await db.khataTransaction.create({ data: { customerId: c.id, outletId: w.h.outletId, type: "DEBIT", amount: 5000, note: "Seed" } });
    await rejects(w.as.CASHIER, "POST", `/customers/${c.id}/khata/settle`, [{ amount: 5001, mode: "CASH" }, { amount: 0, mode: "CASH" }, { amount: 10.5, mode: "CASH" }, { amount: 10, mode: "BARTER" }, { amount: 10, mode: "CASH", note: LONG }]);
    const out = await owner().call("GET", "/customers/khata/outstanding");
    expect(out.body.items.find((x: { id: string }) => x.id === c.id)).toMatchObject({ outletDue: 5000 });
    const s = await w.as.CASHIER.call("POST", `/customers/${c.id}/khata/settle`, { amount: 2000, mode: "UPI" });
    expect(s.status).toBe(200);
    expect(s.body.customer.khataBalance).toBe(3000);
    const k = await owner().call("GET", `/customers/${c.id}/khata`);
    expect(k.body).toMatchObject({ balance: 3000, total: 2 });
    // Outlet 2 has no dues of this customer
    expect((await w.owner2.call("GET", "/customers/khata/outstanding")).body.items.map((x: { id: string }) => x.id)).not.toContain(c.id);
  });

  it("block / unblock; blocked customers can't use coupons", async () => {
    const c = await customer();
    await rejects(owner(), "POST", `/customers/${c.id}/block`, [{}, { blocked: "yes" }, { blocked: true, reason: LONG }]);
    expect((await owner().call("POST", `/customers/${c.id}/block`, { blocked: true, reason: "Fraud" })).body.blocked).toBe(true);
    const code = `BLK${seq++}`;
    await owner().call("POST", "/offers/coupons", { code, discountType: "FLAT", value: 100 });
    expect((await owner().call("POST", "/offers/coupons/validate", { code, subtotal: 5000, customerPhone: c.phone })).body.error).toMatch(/blocked/);
  });

  it("loyalty config: manager can change it, thresholds must ascend, bad values → 400", async () => {
    const r = await w.as.OUTLET_MANAGER.call("PUT", "/customers/loyalty/config", { pointValuePaise: 50 });
    expect(r.status).toBe(200);
    expect((await owner().call("GET", "/customers/loyalty/config")).body.pointValuePaise).toBe(50);
    await rejects(owner(), "PUT", "/customers/loyalty/config", [
      { tierThresholds: { SILVER: 10, GOLD: 5, PLATINUM: 20 } },
      { pointValuePaise: 0 },
      { pointValuePaise: 1.5 },
      { maxRedeemPercent: 101 },
      { pointsExpiryMonths: 121 },
      { earnRupeesPerPoint: -1 },
    ]);
    expect((await owner().call("GET", "/customers/loyalty/config")).body.pointValuePaise).toBe(50);
  });
});

describe("offers", () => {
  const flat = (value: number) => ({ discountType: "FLAT", value });

  it("create every type → 201; list with summary; GET / PATCH / toggle / DELETE; unknown → 404", async () => {
    const bodies = [
      { name: "Combo qa", type: "COMBO", config: { items: [{ menuItemId: w.h.items.chai, quantity: 1 }, { menuItemId: w.h.items.samosa, quantity: 1 }], price: 3500 } },
      { name: "Happy qa", type: "HAPPY_HOUR", startTime: "16:00", endTime: "18:00", config: { target: { menuItemIds: [w.h.items.chai] }, discountType: "PERCENT", value: 20 } },
      { name: "B1G1 qa", type: "BUY_X_GET_Y", config: { buy: { quantity: 1, menuItemIds: [w.h.items.samosa] }, get: { quantity: 1, menuItemIds: [w.h.items.samosa] } } },
      { name: "Item qa", type: "ITEM_DISCOUNT", config: { target: {}, ...flat(500) } },
      { name: "நாள் சலுகை 🎉", type: "BILL_DISCOUNT", config: { minOrder: 10000, maxDiscount: 5000, discountType: "PERCENT", value: 10 } },
    ];
    const ids: string[] = [];
    for (const b of bodies) {
      const r = await owner().call("POST", "/offers", { ...b, active: false });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.businessId).toBe(w.h.businessId);
      ids.push(r.body.id);
    }
    const list = await owner().call("GET", "/offers?active=0");
    expect(list.body.find((o: { id: string }) => o.id === ids[0]).summary).toMatch(/Chai/);
    expect((await owner().call("GET", `/offers/${ids[4]}`)).body.name).toBe("நாள் சலுகை 🎉");
    expect((await owner().call("PATCH", `/offers/${ids[3]}`, { priority: 50 })).body.priority).toBe(50);
    expect((await owner().call("POST", `/offers/${ids[3]}/toggle`, { active: true })).body.active).toBe(true);
    expect((await owner().call("POST", `/offers/${ids[3]}/toggle`)).body.active).toBe(false);
    expect((await owner().call("DELETE", `/offers/${ids[3]}`)).status).toBe(204);
    expect((await owner().call("GET", `/offers/${ids[3]}`)).status).toBe(404);
    for (const [m, p] of [["GET", `/offers/${GHOST}`], ["PATCH", `/offers/${GHOST}`], ["POST", `/offers/${GHOST}/toggle`], ["DELETE", `/offers/${GHOST}`]] as const) {
      expect((await owner().call(m, p, m === "GET" || m === "DELETE" ? undefined : {})).status, p).toBe(404);
    }
    await rejectsQuery(owner(), "/offers", ["type=FREE", "active=yes"]);
  });

  it("validation → 400 and nothing written (configs, windows, priority, dates)", async () => {
    const before = await db.offer.count({ where: { businessId: w.h.businessId } });
    await rejects(owner(), "POST", "/offers", [
      {},
      { name: "X", type: "BILL_DISCOUNT", config: flat(100) },
      { name: LONG, type: "BILL_DISCOUNT", config: flat(100) },
      { name: "Bad", type: "FREE_LUNCH", config: {} },
      { name: "Bad", type: "BILL_DISCOUNT", config: { discountType: "PERCENT", value: 150 } },
      { name: "Bad", type: "BILL_DISCOUNT", config: { discountType: "FLAT", value: -5 } },
      { name: "Bad", type: "COMBO", config: { items: [], price: 100 } },
      { name: "Bad", type: "BUY_X_GET_Y", config: { buy: { quantity: 0 }, get: { quantity: 1 } } },
      { name: "Bad", type: "BILL_DISCOUNT", config: flat(100), startTime: "10:00" },
      { name: "Bad", type: "BILL_DISCOUNT", config: flat(100), startTime: "25:00", endTime: "26:00" },
      { name: "Bad", type: "BILL_DISCOUNT", config: flat(100), priority: 1001 },
      { name: "Bad", type: "BILL_DISCOUNT", config: flat(100), priority: 1.5 },
      { name: "Bad", type: "BILL_DISCOUNT", config: flat(100), daysOfWeek: [7] },
      { name: "Bad", type: "BILL_DISCOUNT", config: flat(100), startsAt: "2026-12-01T00:00:00Z", endsAt: "2026-11-01T00:00:00Z" },
      { name: "Bad", type: "BILL_DISCOUNT", config: flat(100), startsAt: "tomorrow" },
    ]);
    expect(await db.offer.count({ where: { businessId: w.h.businessId } })).toBe(before);
  });

  it("qac-6: outletIds must be this hotel's outlets", async () => {
    const before = await db.offer.count({ where: { businessId: w.h.businessId } });
    await rejects(owner(), "POST", "/offers", [
      { name: "Leak", type: "BILL_DISCOUNT", config: flat(100), outletIds: [w.other.h.outletId] },
      { name: "Leak", type: "BILL_DISCOUNT", config: flat(100), outletIds: [GHOST] },
    ]);
    expect(await db.offer.count({ where: { businessId: w.h.businessId } })).toBe(before);
    const ok = await owner().call("POST", "/offers", { name: "Outlet 2 only", type: "BILL_DISCOUNT", config: flat(100), outletIds: [w.h.outlet2Id], active: false });
    expect(ok.status).toBe(201);
    await rejects(owner(), "PATCH", `/offers/${ok.body.id}`, [{ outletIds: [w.other.h.outletId] }]);
  });

  it("one offer per bill (documented rule): two live bill offers → only the better one applies", async () => {
    const h2 = await createHotel("One offer");
    const o2 = await login(srv.base, h2.users.owner.email, h2.outletId);
    await o2.call("POST", "/offers", { name: "Ten off", type: "BILL_DISCOUNT", priority: 10, config: flat(1000) });
    await o2.call("POST", "/offers", { name: "Twenty off", type: "BILL_DISCOUNT", priority: 1, config: flat(2000) });
    const active = await o2.call("GET", "/offers/active");
    expect(active.body.offers).toHaveLength(2);
    const p = await o2.call("POST", "/customers/preview-promotions", { orderType: "TAKEAWAY", items: [{ menuItemId: h2.items.biryani, quantity: 1 }] });
    expect(p.status).toBe(200);
    const offers = p.body.applied.filter((a: { kind: string }) => a.kind === "OFFER");
    expect(offers).toHaveLength(1);
    intMoney(p.body, ["promoDiscount"]);
    expect(p.body.promoDiscount).toBe(2000);
  });
});

describe("coupons", () => {
  it("create (code upper-cased) → 201; duplicate in any case → 409; GET/PATCH/DELETE; unknown → 404", async () => {
    const code = `save${seq++}`;
    const r = await owner().call("POST", "/offers/coupons", { code, discountType: "PERCENT", value: 10, maxDiscount: 5000, minOrder: 10000, usageLimit: 2, businessId: w.other.h.businessId, usedCount: 99 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ code: code.toUpperCase(), usedCount: 0, businessId: w.h.businessId });
    intMoney(r.body, ["value", "minOrder"]);
    expect((await owner().call("POST", "/offers/coupons", { code: code.toUpperCase(), discountType: "FLAT", value: 1 })).status).toBe(409);
    const other = (await owner().call("POST", "/offers/coupons", { code: `OTHER${seq++}`, discountType: "FLAT", value: 1 })).body;
    expect((await owner().call("PATCH", `/offers/coupons/${other.id}`, { code: code.toUpperCase() })).status).toBe(409);
    expect((await owner().call("PATCH", `/offers/coupons/${r.body.id}`, { value: 101 })).status).toBe(400);
    expect((await owner().call("PATCH", `/offers/coupons/${r.body.id}`, { description: "Ten percent" })).body.description).toBe("Ten percent");
    expect((await owner().call("GET", `/offers/coupons?search=${code}`)).body.map((c: { id: string }) => c.id)).toContain(r.body.id);
    expect((await owner().call("GET", `/offers/coupons/${r.body.id}`)).body.redemptions).toEqual([]);
    expect((await owner().call("DELETE", `/offers/coupons/${other.id}`)).status).toBe(204);
    for (const [m, p] of [["GET", `/offers/coupons/${GHOST}`], ["PATCH", `/offers/coupons/${GHOST}`], ["DELETE", `/offers/coupons/${GHOST}`]] as const) {
      expect((await owner().call(m, p, m === "PATCH" ? {} : undefined)).status, p).toBe(404);
    }
  });

  it("validation → 400 and nothing written", async () => {
    const before = await db.coupon.count({ where: { businessId: w.h.businessId } });
    await rejects(owner(), "POST", "/offers/coupons", [
      {},
      { code: "AB", discountType: "FLAT", value: 1 },
      { code: "BAD CODE", discountType: "FLAT", value: 1 },
      { code: "<SCRIPT>", discountType: "FLAT", value: 1 },
      { code: "OKCODE1", discountType: "PERCENT", value: 101 },
      { code: "OKCODE1", discountType: "FLAT", value: 0 },
      { code: "OKCODE1", discountType: "FLAT", value: 1.5 },
      { code: "OKCODE1", discountType: "FLAT", value: 1e13 },
      { code: "OKCODE1", discountType: "FLAT", value: 1, usageLimit: 0 },
      { code: "OKCODE1", discountType: "FLAT", value: 1, expiresAt: "soon" },
      { code: "OKCODE1", discountType: "FLAT", value: 1, description: LONG },
    ]);
    expect(await db.coupon.count({ where: { businessId: w.h.businessId } })).toBe(before);
  });

  it("validate: min order, expiry, usage limit, per-customer limit; estimated discount is integer paise", async () => {
    const code = `TENPC${seq++}`;
    await owner().call("POST", "/offers/coupons", { code, discountType: "PERCENT", value: 10, maxDiscount: 1500, minOrder: 5000, perCustomerLimit: 1 });
    const ok = await w.as.CASHIER.call("POST", "/offers/coupons/validate", { code: code.toLowerCase(), subtotal: 33333 });
    expect(ok.status).toBe(400); // per-customer limit needs a customer
    const c = await customer();
    const v = await w.as.CASHIER.call("POST", "/offers/coupons/validate", { code, subtotal: 33333, customerPhone: c.phone });
    expect(v.status, JSON.stringify(v.body)).toBe(200);
    expect(v.body.estimatedDiscount).toBe(1500);
    intMoney(v.body, ["estimatedDiscount", "value", "minOrder"]);
    expect((await w.as.CASHIER.call("POST", "/offers/coupons/validate", { code, subtotal: 4999, customerPhone: c.phone })).status).toBe(400);
    const exp = `OLD${seq++}`;
    await owner().call("POST", "/offers/coupons", { code: exp, discountType: "FLAT", value: 100, expiresAt: "2020-01-01T00:00:00Z" });
    expect((await w.as.CASHIER.call("POST", "/offers/coupons/validate", { code: exp, subtotal: 10000 })).status).toBe(400);
    const lim = `ONCE${seq++}`;
    const lc = (await owner().call("POST", "/offers/coupons", { code: lim, discountType: "FLAT", value: 100, usageLimit: 1 })).body;
    await db.coupon.update({ where: { id: lc.id }, data: { usedCount: 1 } });
    expect((await w.as.CASHIER.call("POST", "/offers/coupons/validate", { code: lim, subtotal: 10000 })).status).toBe(400);
    await rejects(w.as.CASHIER, "POST", "/offers/coupons/validate", [{}, { code: "", subtotal: 1 }, { code: "X", subtotal: -1 }, { code: "X", subtotal: 1.5 }, { code: "X", subtotal: 1, customerPhone: "123" }, { code: "NOPE", subtotal: 100 }]);
  });

  it("report: IST date filter, invalid dates → 400", async () => {
    const r = await owner().call("GET", "/offers/coupons/report?from=2026-10-01&to=2026-10-31");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ from: "2026-10-01", to: "2026-10-31" });
    intMoney(r.body.totals, ["discount", "sales"]);
    await rejectsQuery(owner(), "/offers/coupons/report", ["from=2026-02-30", "to=2026-13-01", "from=01-10-2026", "from=abc"]);
  });
});
