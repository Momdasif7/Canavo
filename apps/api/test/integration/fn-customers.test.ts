/**
 * QA Phase 5 — group B — Customers, loyalty and khata: auto-created profiles,
 * phone validation, lookup, update, blacklist, points earn / redeem / tiers,
 * cancellation reversals, khata ledger / limit / settle / reminders, CUSTOMERS module off.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { bill, bind, db, line, mkCategory, mkItem, outletAgent, pay, phone, preview, tenant } from "./fx-b";

let T: Awaited<ReturnType<typeof tenant>>;
let token: string;
let owner: ReturnType<typeof bind>;
let I200: string;
let I100: string;
let I250: string;

beforeAll(async () => {
  T = await tenant(); // 0% GST → grand total == menu price
  token = (await T.owner()).token;
  owner = bind(token, T.outlet.id);
  const cat = (await mkCategory(T.business.id, "Food")).id;
  I200 = (await mkItem(T.business.id, cat, 20000)).id;
  I100 = (await mkItem(T.business.id, cat, 10000)).id;
  I250 = (await mkItem(T.business.id, cat, 25000)).id;
});

const cust = (p: string) => db.customer.findFirst({ where: { businessId: T.business.id, phone: p } });
async function paidFor(agent: ReturnType<typeof bind>, items: object[], extra: Record<string, unknown> = {}) {
  const o = await bill(agent, items, extra);
  expect(o.status, JSON.stringify(o.body)).toBe(201);
  const p = await pay(agent, o.body.id, o.body.grandTotal);
  expect(p.status, JSON.stringify(p.body)).toBe(200);
  return o.body;
}
const ledgerSum = async (customerId: string) =>
  (await db.loyaltyTransaction.findMany({ where: { customerId } })).reduce((s, t) => s + t.points, 0);
const khataSum = async (customerId: string) =>
  (await db.khataTransaction.findMany({ where: { customerId } })).reduce((s, t) => s + (t.type === "DEBIT" ? t.amount : -t.amount), 0);

describe("Profiles, phone validation, lookup @regression", () => {
  it("IT-CRM-001 billing with a new phone auto-creates the customer profile with the name @regression", async () => {
    const p = phone();
    await paidFor(owner, [line(I200)], { customerPhone: p, customerName: "Priya" });
    const c = await cust(p);
    expect(c).toMatchObject({ name: "Priya", visitCount: 1, totalSpend: 20000 });
    const lk = await owner.get(`/customers/lookup?phone=${p}`);
    expect(lk.body).toMatchObject({ found: true, id: c!.id, name: "Priya", visitCount: 1 });
  });

  it("IT-CRM-002 a second bill for the same phone reuses the profile; a blank name is filled later @regression", async () => {
    const p = phone();
    await paidFor(owner, [line(I100)], { customerPhone: p });
    await paidFor(owner, [line(I100)], { customerPhone: p, customerName: "Ravi" });
    expect(await db.customer.count({ where: { businessId: T.business.id, phone: p } })).toBe(1);
    expect((await cust(p))!).toMatchObject({ name: "Ravi", visitCount: 2, totalSpend: 20000 });
  });

  it("IT-CRM-003 phone validation (EP/BVA): 9 / 11 digits, leading 0-5, +91 prefix, letters → 400 on bill and lookup @regression", async () => {
    for (const bad of ["987654321", "98765432101", "5876543210", "0987654321", "+919876543210", "98765abcde", ""]) {
      expect((await bill(owner, [line(I100)], { customerPhone: bad })).status, bad).toBe(400);
      expect((await owner.get(`/customers/lookup?phone=${encodeURIComponent(bad)}`)).status, bad).toBe(400);
    }
    for (const good of ["6000000000", "9999999999", " 7012345678 "]) {
      expect((await bill(owner, [line(I100)], { customerPhone: good })).status, good).toBe(201);
    }
  });

  it("IT-CRM-004 lookup of an unknown phone → found:false with loyalty rules @regression", async () => {
    const res = await owner.get(`/customers/lookup?phone=${phone()}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ found: false, loyalty: { pointValuePaise: 25, minRedeemPoints: 100, maxRedeemPercent: 50 } });
  });

  it("IT-CRM-005 POST /customers: create, duplicate phone → 400, bad email / birthday → 400 @regression", async () => {
    const p = phone();
    const res = await owner.post("/customers", { phone: p, name: "Anita", email: "anita@example.com", birthday: "02-29" });
    expect(res.status).toBe(201);
    expect((await owner.post("/customers", { phone: p })).status).toBe(400);
    expect((await owner.post("/customers", { phone: phone(), email: "nope" })).status).toBe(400);
    expect((await owner.post("/customers", { phone: phone(), birthday: "13-01" })).status).toBe(400);
    expect((await owner.post("/customers", { phone: phone(), name: "n".repeat(101) })).status).toBe(400);
  });

  it("IT-CRM-006 cashier may create a customer but not set a khata limit or edit a profile @regression", async () => {
    const cashier = await T.cashier();
    expect((await cashier.post("/customers", { phone: phone(), name: "Walk-in" })).status).toBe(201);
    expect((await cashier.post("/customers", { phone: phone(), khataLimit: 100000 })).status).toBe(403);
    const c = await owner.post("/customers", { phone: phone() });
    expect((await cashier.patch(`/customers/${c.body.id}`, { khataLimit: 1 })).status).toBe(403);
    expect((await cashier.post(`/customers/${c.body.id}/block`, { blocked: true })).status).toBe(403);
    expect((await cashier.post(`/customers/${c.body.id}/loyalty/adjust`, { points: 1000, note: "gift" })).status).toBe(403);
  });

  it("IT-CRM-007 manager updates a profile; moving to another customer's phone → 400 @regression", async () => {
    const mgr = await T.manager();
    const a = await owner.post("/customers", { phone: phone() });
    const b = await owner.post("/customers", { phone: phone() });
    const upd = await mgr.patch(`/customers/${a.body.id}`, { name: "Updated", anniversary: "11-02", notes: "likes less spice", email: "" });
    expect(upd.status).toBe(200);
    expect(upd.body).toMatchObject({ name: "Updated", anniversary: "11-02", email: null });
    expect((await mgr.patch(`/customers/${a.body.id}`, { phone: b.body.phone })).status).toBe(400);
  });

  it("IT-CRM-008 list: search by phone fragment / name, blocked filter, pagination bounds @regression", async () => {
    const p = phone();
    const c = await owner.post("/customers", { phone: p, name: "Zebulon Searchable" });
    expect((await owner.get(`/customers?search=${p.slice(2, 8)}`)).body.items.map((x: { id: string }) => x.id)).toContain(c.body.id);
    expect((await owner.get("/customers?search=zebulon")).body.items.map((x: { id: string }) => x.id)).toContain(c.body.id);
    expect((await owner.get("/customers?limit=201")).status).toBe(400);
    expect((await owner.get("/customers?page=0")).status).toBe(400);
  });

  it("IT-CRM-009 profile page returns stats, ledgers and a 7×24 visit heatmap @regression", async () => {
    const p = phone();
    await paidFor(owner, [line(I200)], { customerPhone: p });
    const c = (await cust(p))!;
    const res = await owner.get(`/customers/${c.id}`);
    expect(res.status).toBe(200);
    expect(res.body.stats).toMatchObject({ totalSpend: 20000, visitCount: 1, paidOrders: 1, avgBill: 20000, points: 20 });
    expect(res.body.visitHeatmap).toHaveLength(7);
    expect(res.body.visitHeatmap.flat().reduce((s: number, x: number) => s + x, 0)).toBe(1);
    expect(res.body.recentOrders).toHaveLength(1);
  });

  it("IT-CRM-010 another business's customer → 404 on read / settle / block @critical @regression", async () => {
    const other = await tenant();
    const foreign = await db.customer.create({ data: { businessId: other.business.id, phone: phone(), khataBalance: 5000, name: "FOREIGN" } });
    expect((await owner.get(`/customers/${foreign.id}`)).status).toBe(404);
    expect((await owner.post(`/customers/${foreign.id}/khata/settle`, { amount: 5000, mode: "CASH" })).status).toBe(404);
    expect((await owner.post(`/customers/${foreign.id}/block`, { blocked: true })).status).toBe(404);
    expect((await owner.get(`/customers/lookup?phone=${foreign.phone}`)).body.found).toBe(false);
    expect((await db.customer.findUniqueOrThrow({ where: { id: foreign.id } })).khataBalance).toBe(5000);
  });

  // Expected: a rejected bill has no side effects. Actual: evaluatePromotions() calls findOrCreateCustomer()
  // before validating the coupon, so a 400 "Invalid coupon code" still leaves a new customer profile behind.
  it.fails("IT-CRM-011 (BUG-CANDIDATE-B8) a bill rejected for an invalid coupon does not create the customer @regression", async () => {
    const p = phone();
    const res = await bill(owner, [line(I100)], { customerPhone: p, couponCode: "NO-SUCH-COUPON" });
    expect(res.status).toBe(400);
    expect(await cust(p)).toBeNull();
  });
});

describe("Blacklist @regression", () => {
  it("IT-CRM-020 blocked customer cannot be billed, previewed or use a coupon; unblock restores @critical @regression", async () => {
    const p = phone();
    const c = await owner.post("/customers", { phone: p });
    const blk = await owner.post(`/customers/${c.body.id}/block`, { blocked: true, reason: "abusive" });
    expect(blk.body.blocked).toBe(true);
    const b = await bill(owner, [line(I100)], { customerPhone: p });
    expect(b.status).toBe(400);
    expect(b.body.error).toMatch(/blocked/);
    expect((await preview(owner, [line(I100)], { customerPhone: p })).status).toBe(400);
    expect((await owner.post("/offers/coupons/validate", { code: "ANY", subtotal: 1000, customerPhone: p })).status).toBe(400);
    expect((await owner.get("/customers?blocked=1")).body.items.map((x: { id: string }) => x.id)).toContain(c.body.id);
    await owner.post(`/customers/${c.body.id}/block`, { blocked: false });
    expect((await bill(owner, [line(I100)], { customerPhone: p })).status).toBe(201);
  });

  it("IT-CRM-021 customer blocked between billing and payment earns no points and gets no khata @critical @regression", async () => {
    const p = phone();
    const o1 = await bill(owner, [line(I200)], { customerPhone: p });
    const o2 = await bill(owner, [line(I200)], { customerPhone: p });
    const c = (await cust(p))!;
    await owner.post(`/customers/${c.id}/block`, { blocked: true });
    expect((await pay(owner, o1.body.id, o1.body.grandTotal)).status).toBe(200);
    expect((await cust(p))!.points).toBe(0);
    const k = await pay(owner, o2.body.id, o2.body.grandTotal, "KHATA");
    expect(k.status).toBe(400);
    expect((await cust(p))!.khataBalance).toBe(0);
  });
});

describe("Loyalty points & tiers @critical @regression", () => {
  it("IT-CRM-030 points are earned only when the bill is PAID: 1 per ₹10 (BRONZE ×1) @critical @regression", async () => {
    const p = phone();
    const o = await bill(owner, [line(I250)], { customerPhone: p });
    expect((await cust(p))!.points).toBe(0);
    await pay(owner, o.body.id, 10000);
    expect((await cust(p))!.points).toBe(0); // part-paid
    await pay(owner, o.body.id, 15000);
    const c = (await cust(p))!;
    expect(c.points).toBe(25);
    const earn = await db.loyaltyTransaction.findMany({ where: { customerId: c.id, type: "EARN" } });
    expect(earn).toHaveLength(1);
    expect(earn[0]).toMatchObject({ orderId: o.body.id, points: 25 });
  });

  it("IT-CRM-031 tier upgrade by total spend (boundary = threshold) and tier multiplier on the next bill @critical @regression", async () => {
    const t = await tenant();
    const own = await t.owner();
    const cat = await mkCategory(t.business.id);
    const i200 = (await mkItem(t.business.id, cat.id, 20000)).id;
    const i100 = (await mkItem(t.business.id, cat.id, 10000)).id;
    const cfg = await own.put("/customers/loyalty/config", { tierThresholds: { SILVER: 20000, GOLD: 50000, PLATINUM: 100000 } });
    expect(cfg.status).toBe(200);
    const p = phone();
    const ag = bind(own.token, t.outlet.id);
    const c = () => db.customer.findFirstOrThrow({ where: { businessId: t.business.id, phone: p } });
    await paidFor(ag, [line(i200)], { customerPhone: p });
    expect(await c()).toMatchObject({ tier: "SILVER", points: 20, totalSpend: 20000 }); // earned at BRONZE ×1
    await paidFor(ag, [line(i200)], { customerPhone: p });
    expect(await c()).toMatchObject({ tier: "SILVER", points: 45 }); // +25 at SILVER ×1.25
    await paidFor(ag, [line(i100)], { customerPhone: p });
    expect(await c()).toMatchObject({ tier: "GOLD", points: 57, totalSpend: 50000 }); // +12 (12.5 floored)
  });

  it("IT-CRM-032 redeem points: ₹0.25 each, preview == bill, balance and REDEEM ledger updated @critical @regression", async () => {
    const p = phone();
    const c = await owner.post("/customers", { phone: p });
    await owner.post(`/customers/${c.body.id}/loyalty/adjust`, { points: 1000, note: "opening balance" });
    const pv = await preview(owner, [line(I200)], { customerPhone: p, redeemPoints: 100 });
    const o = await bill(owner, [line(I200)], { customerPhone: p, redeemPoints: 100 });
    expect(o.status).toBe(201);
    expect(o.body.pointsRedeemed).toBe(100);
    expect(o.body.grandTotal).toBe(17500);
    expect(o.body.grandTotal).toBe(pv.body.bill.grandTotal);
    expect(pv.body.pointsValue).toBe(2500);
    expect((await cust(p))!.points).toBe(900);
    await pay(owner, o.body.id, o.body.grandTotal);
    expect((await cust(p))!.points).toBe(917); // + floor(175 / 10)
    expect(await ledgerSum(c.body.id)).toBe(917);
  });

  it("IT-CRM-033 redeem rules: below minimum, above balance, no phone → 400; above the 50% cap is trimmed to the cap @critical @regression", async () => {
    const p = phone();
    const c = await owner.post("/customers", { phone: p });
    await owner.post(`/customers/${c.body.id}/loyalty/adjust`, { points: 1000, note: "opening balance" });
    expect((await bill(owner, [line(I200)], { customerPhone: p, redeemPoints: 99 })).body.error).toMatch(/Minimum 100/);
    expect((await bill(owner, [line(I200)], { customerPhone: p, redeemPoints: 1001 })).body.error).toMatch(/Only 1000/);
    expect((await bill(owner, [line(I200)], { redeemPoints: 100 })).status).toBe(400);
    expect((await bill(owner, [line(I200)], { customerPhone: p, redeemPoints: 0 })).status).toBe(400);
    const capped = await bill(owner, [line(I200)], { customerPhone: p, redeemPoints: 1000 });
    expect(capped.status).toBe(201);
    expect(capped.body.pointsRedeemed).toBe(400); // 50% of ₹200 = ₹100 = 400 points
    expect(capped.body.grandTotal).toBe(10000);
    // a bill too small for the minimum: ₹100 → cap 200 points... still ≥100 ok; ₹50-equivalent would fail
    expect((await cust(p))!.points).toBe(600);
  });

  it("IT-CRM-034 cancelling a PAID bill reverses earned + redeemed points, spend, visits and tier @critical @regression", async () => {
    const t = await tenant();
    const own = await t.owner();
    const ag = bind(own.token, t.outlet.id);
    const cat = await mkCategory(t.business.id);
    const i200 = (await mkItem(t.business.id, cat.id, 20000)).id;
    await own.put("/customers/loyalty/config", { tierThresholds: { SILVER: 30000, GOLD: 1000000, PLATINUM: 2000000 } });
    const p = phone();
    const c0 = await ag.post("/customers", { phone: p });
    await ag.post(`/customers/${c0.body.id}/loyalty/adjust`, { points: 200, note: "opening balance" });
    await paidFor(ag, [line(i200)], { customerPhone: p }); // spend 20000, +20 → 220
    const o = await paidFor(ag, [line(i200)], { customerPhone: p, redeemPoints: 100 }); // −100, total 17500 → +17, spend 37500 → SILVER
    const before = await db.customer.findUniqueOrThrow({ where: { id: c0.body.id } });
    expect(before).toMatchObject({ points: 137, totalSpend: 37500, visitCount: 2, tier: "SILVER" });
    expect((await ag.post(`/orders/${o.id}/cancel`, { reason: "wrong order" })).status).toBe(200);
    const after = await db.customer.findUniqueOrThrow({ where: { id: c0.body.id } });
    expect(after).toMatchObject({ points: 220, totalSpend: 20000, visitCount: 1, tier: "BRONZE" });
    expect(await ledgerSum(c0.body.id)).toBe(220);
  });

  it("IT-CRM-035 manual adjust: cannot go below zero, note required; ledger sum always equals the balance @critical @regression", async () => {
    const c = await owner.post("/customers", { phone: phone() });
    expect((await owner.post(`/customers/${c.body.id}/loyalty/adjust`, { points: 50, note: "complaint goodwill" })).status).toBe(200);
    expect((await owner.post(`/customers/${c.body.id}/loyalty/adjust`, { points: -51, note: "correction" })).status).toBe(400);
    expect((await owner.post(`/customers/${c.body.id}/loyalty/adjust`, { points: 0, note: "noop" })).status).toBe(400);
    expect((await owner.post(`/customers/${c.body.id}/loyalty/adjust`, { points: 10, note: "x" })).status).toBe(400);
    expect((await owner.post(`/customers/${c.body.id}/loyalty/adjust`, { points: -50, note: "correction" })).body.customer.points).toBe(0);
    const led = await owner.get(`/customers/${c.body.id}/loyalty`);
    expect(led.body.balance).toBe(0);
    expect(await ledgerSum(c.body.id)).toBe(0);
  });

  it("IT-CRM-036 loyalty config: cashier 403; thresholds out of order → 400; settings are per business @regression", async () => {
    const t = await tenant();
    const own = await t.owner();
    expect((await (await t.cashier()).get("/customers/loyalty/config")).status).toBe(403);
    expect((await own.put("/customers/loyalty/config", { tierThresholds: { SILVER: 50000, GOLD: 10000, PLATINUM: 100000 } })).status).toBe(400);
    expect((await own.put("/customers/loyalty/config", { maxRedeemPercent: 101 })).status).toBe(400);
    expect((await own.put("/customers/loyalty/config", { earnRupeesPerPoint: 0 })).status).toBe(400);
    expect((await own.put("/customers/loyalty/config", { earnRupeesPerPoint: 20 })).body.earnRupeesPerPoint).toBe(20);
    expect((await own.get("/customers/loyalty/config")).body.earnRupeesPerPoint).toBe(20);
    expect((await owner.get("/customers/loyalty/config")).body.earnRupeesPerPoint).toBe(10);
  });

  it("IT-CRM-037 loyalty disabled: nothing earned and redemption refused @regression", async () => {
    const t = await tenant();
    const own = await t.owner();
    const ag = bind(own.token, t.outlet.id);
    const cat = await mkCategory(t.business.id);
    const i = (await mkItem(t.business.id, cat.id, 20000)).id;
    await own.put("/customers/loyalty/config", { enabled: false });
    const p = phone();
    await paidFor(ag, [line(i)], { customerPhone: p });
    const c = await db.customer.findFirstOrThrow({ where: { businessId: t.business.id, phone: p } });
    expect(c.points).toBe(0);
    await db.customer.update({ where: { id: c.id }, data: { points: 500 } });
    const r = await bill(ag, [line(i)], { customerPhone: p, redeemPoints: 100 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/disabled/);
  });
});

describe("Khata (credit) @critical @regression", () => {
  it("IT-CRM-040 KHATA payment without a customer phone → 400, bill stays OPEN @critical @regression", async () => {
    const o = await bill(owner, [line(I100)]);
    const r = await pay(owner, o.body.id, o.body.grandTotal, "KHATA");
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/phone/);
    expect((await db.order.findUniqueOrThrow({ where: { id: o.body.id } })).status).toBe("OPEN");
  });

  it("IT-CRM-041 KHATA payment debits the ledger; balance == ledger sum; bill PAID @critical @regression", async () => {
    const p = phone();
    const o = await bill(owner, [line(I200)], { customerPhone: p });
    const r = await pay(owner, o.body.id, 20000, "KHATA");
    expect(r.status).toBe(200);
    expect(r.body.paid).toBe(true);
    const c = (await cust(p))!;
    expect(c.khataBalance).toBe(20000);
    const k = await owner.get(`/customers/${c.id}/khata`);
    expect(k.body).toMatchObject({ balance: 20000, total: 1 });
    expect(k.body.items[0]).toMatchObject({ type: "DEBIT", amount: 20000, orderId: o.body.id });
    expect(await khataSum(c.id)).toBe(20000);
  });

  it("IT-CRM-042 split payment CASH + KHATA: only the khata part goes on credit @critical @regression", async () => {
    const p = phone();
    const o = await bill(owner, [line(I250)], { customerPhone: p });
    const r = await owner.post(`/orders/${o.body.id}/payments`, { payments: [{ mode: "CASH", amount: 10000 }, { mode: "KHATA", amount: 15000 }] });
    expect(r.body.paid).toBe(true);
    expect((await cust(p))!.khataBalance).toBe(15000);
  });

  it("IT-CRM-043 khata limit BVA: up to the limit OK, ₹0.01 over → 400 and nothing is recorded @critical @regression", async () => {
    const p = phone();
    const c = await owner.post("/customers", { phone: p, khataLimit: 30000 });
    expect(c.body.khataLimit).toBe(30000);
    const o1 = await bill(owner, [line(I200)], { customerPhone: p });
    expect((await pay(owner, o1.body.id, 20000, "KHATA")).status).toBe(200);
    const o2 = await bill(owner, [line(I200)], { customerPhone: p });
    const over = await pay(owner, o2.body.id, 10001, "KHATA");
    expect(over.status).toBe(400);
    expect(over.body.error).toMatch(/Khata limit exceeded/);
    expect(await db.payment.count({ where: { orderId: o2.body.id } })).toBe(0);
    expect((await cust(p))!.khataBalance).toBe(20000);
    expect((await pay(owner, o2.body.id, 10000, "KHATA")).status).toBe(200); // exactly at the limit
    expect((await cust(p))!.khataBalance).toBe(30000);
  });

  it("IT-CRM-044 settle: more than due / zero / bad mode → 400; partial and full settle reduce the balance @critical @regression", async () => {
    const p = phone();
    const o = await bill(owner, [line(I200)], { customerPhone: p });
    await pay(owner, o.body.id, 20000, "KHATA");
    const id = (await cust(p))!.id;
    const cashier = await T.cashier();
    expect((await cashier.post(`/customers/${id}/khata/settle`, { amount: 20001, mode: "CASH" })).status).toBe(400);
    expect((await cashier.post(`/customers/${id}/khata/settle`, { amount: 0, mode: "CASH" })).status).toBe(400);
    expect((await cashier.post(`/customers/${id}/khata/settle`, { amount: 100, mode: "BITCOIN" })).status).toBe(400);
    const part = await cashier.post(`/customers/${id}/khata/settle`, { amount: 5000, mode: "UPI", note: "part" });
    expect(part.status).toBe(200);
    expect(part.body.customer.khataBalance).toBe(15000);
    expect((await cashier.post(`/customers/${id}/khata/settle`, { amount: 15000, mode: "CASH" })).body.customer.khataBalance).toBe(0);
    expect((await cashier.post(`/customers/${id}/khata/settle`, { amount: 1, mode: "CASH" })).body.error).toMatch(/No outstanding/);
    expect(await khataSum(id)).toBe(0);
  });

  it("IT-CRM-045 outstanding list and reminder (wa.me link fallback, amount in the text) @regression", async () => {
    const { agent, outletId } = await outletAgent(T.business.id, token, { name: "Khata Corner", upiVpa: "khata@okaxis" });
    const p = phone();
    const o = await bill(agent, [line(I250)], { customerPhone: p, customerName: "Meena" });
    await pay(agent, o.body.id, 25000, "KHATA");
    const id = (await cust(p))!.id;
    const out = await agent.get("/customers/khata/outstanding");
    expect(out.body.items).toEqual([expect.objectContaining({ id, outletDue: 25000 })]);
    expect(out.body.totalOutstanding).toBe(25000);
    const rem = await agent.post(`/customers/${id}/khata/remind`);
    expect(rem.status).toBe(200);
    expect(rem.body.method).toBe("link");
    expect(rem.body.text).toContain("₹250");
    expect(rem.body.text).toContain("khata@okaxis");
    expect(rem.body.waLink).toContain(p);
    const none = await owner.post("/customers", { phone: phone() });
    expect((await agent.post(`/customers/${none.body.id}/khata/remind`)).status).toBe(400);
    expect(outletId).toBeTruthy();
  });

  it("IT-CRM-046 cancelling a khata bill reverses the outstanding debit @critical @regression", async () => {
    const p = phone();
    const o = await bill(owner, [line(I200)], { customerPhone: p });
    await pay(owner, o.body.id, 20000, "KHATA");
    const id = (await cust(p))!.id;
    expect((await owner.post(`/orders/${o.body.id}/cancel`, { reason: "dispute" })).status).toBe(200);
    expect((await cust(p))!.khataBalance).toBe(0);
    const rev = await db.khataTransaction.findFirst({ where: { customerId: id, mode: "REVERSAL" } });
    expect(rev).toMatchObject({ type: "CREDIT", amount: 20000 });
    expect(await khataSum(id)).toBe(0);
  });
});

describe("CUSTOMERS module disabled @regression", () => {
  it("IT-CRM-050 customer endpoints 403; bills still work with a phone but create no profile @regression", async () => {
    const t = await tenant({ modules: ["BILLING", "KOT", "OFFERS"] });
    const own = await t.owner();
    const cat = await mkCategory(t.business.id);
    const i = (await mkItem(t.business.id, cat.id, 20000)).id;
    for (const pth of ["/customers", `/customers/lookup?phone=${phone()}`, "/customers/khata/outstanding", "/customers/loyalty/config"]) {
      expect((await own.get(pth)).status, pth).toBe(403);
    }
    expect((await own.post("/customers", { phone: phone() })).status).toBe(403);
    expect((await preview(own, [line(i)])).status).toBe(200); // POS preview is part of billing
    const p = phone();
    const o = await bill(own, [line(i)], { customerPhone: p });
    expect(o.status).toBe(201);
    await pay(own, o.body.id, o.body.grandTotal);
    expect(await db.customer.count({ where: { businessId: t.business.id } })).toBe(0);
  });

  it("IT-CRM-051 points redemption and KHATA payment are refused when CUSTOMERS is off @critical @regression", async () => {
    const t = await tenant({ modules: ["BILLING", "KOT"] });
    const own = await t.owner();
    const cat = await mkCategory(t.business.id);
    const i = (await mkItem(t.business.id, cat.id, 20000)).id;
    const p = phone();
    await db.customer.create({ data: { businessId: t.business.id, phone: p, points: 1000 } });
    const r = await bill(own, [line(i)], { customerPhone: p, redeemPoints: 100 });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/not enabled/);
    const o = await bill(own, [line(i)], { customerPhone: p });
    const k = await pay(own, o.body.id, 20000, "KHATA");
    expect(k.status).toBe(400);
    expect(k.body.error).toMatch(/Customers module/);
    expect((await db.customer.findFirstOrThrow({ where: { businessId: t.business.id, phone: p } })).khataBalance).toBe(0);
  });
});
