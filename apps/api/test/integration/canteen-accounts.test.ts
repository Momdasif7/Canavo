/** Phase 5.1 / 5.2 / 5.5 — corporate subsidies and quotas, wallets, cards, meal tokens, statements, canteen report. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotel, db, login, startServer, type Client, type Hotel } from "./helpers";
import { zonedParts } from "../../src/lib/time";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel;
let owner: Client, cashier: Client;
let slotId: string;
const TZ = "Asia/Kolkata";
const today = zonedParts(new Date(), TZ).date;
const hhmm = (offsetMin: number) => {
  const m = (((zonedParts(new Date(), TZ).minutes + offsetMin) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("Canteen", { modules: ["BILLING", "KOT", "CUSTOMERS", "REPORTS", "CANTEEN"] });
  owner = await login(srv.base, h.users.owner.email, h.outletId);
  cashier = await login(srv.base, h.users.cashier.email, h.outletId);
  // A slot open right now (the slot CRUD belongs to the meal-slots work).
  slotId = (await db.mealSlot.create({ data: { outletId: h.outletId, name: "Lunch", startTime: hhmm(-120), endTime: hhmm(120) } })).id;
});
afterAll(() => srv.close());

type Order = { id: string; grandTotal: number; status: string; invoiceNumber: string; payments: { mode: string; amount: number }[] };
const bill = (c: Client, item: string, memberId?: string) => c.call<Order>("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: item, quantity: 1 }], ...(memberId && { memberId }) });
const pay = (c: Client, id: string, payments: object[]) => c.call("POST", `/orders/${id}/payments`, { payments });
const corporate = (o: Order) => o.payments.filter((p) => p.mode === "CORPORATE").reduce((s, p) => s + p.amount, 0);
let phoneSeq = 0;
const phone = () => `98${String(Date.now() % 1e6).padStart(6, "0")}${String(phoneSeq++).padStart(2, "0")}`;
const member = async (body: object) => {
  const r = await owner.call("POST", "/canteen/members", { name: "Emp", phone: phone(), ...body });
  expect(r.status).toBe(201);
  return r.body as { id: string; phone: string };
};
const account = async (body: object) => (await owner.call("POST", "/canteen/accounts", { name: `Acme ${phoneSeq++}`, ...body })).body as { id: string; name: string };

describe("module gate", () => {
  it("is off for hotels without the Canteen module", async () => {
    const other = await createHotel("NoCanteen");
    const o = await login(srv.base, other.users.owner.email, other.outletId);
    expect((await o.call("GET", "/canteen/accounts")).status).toBe(403);
    expect((await o.call("GET", "/canteen/members/lookup?q=X")).status).toBe(403);
    expect((await o.call("GET", "/reports/canteen")).status).toBe(403);
    const c = (await o.call("POST", "/customers", { phone: phone(), name: "Walk-in" })).body;
    expect((await o.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: other.items.chai, quantity: 1 }], memberId: c.id })).status).toBe(400);
  });

  it("cashiers can scan cards but not manage accounts", async () => {
    expect((await cashier.call("GET", "/canteen/accounts")).status).toBe(403);
    expect((await cashier.call("POST", "/canteen/members", { name: "X", phone: phone() })).status).toBe(403);
  });
});

describe("corporate subsidy", () => {
  let acc: { id: string; name: string };
  let m: { id: string };

  it("percent of the meal, capped per meal and per day", async () => {
    acc = await account({});
    expect((await owner.call("POST", `/canteen/accounts/${acc.id}/rules`, { type: "PERCENT", value: 50, maxPerMeal: 6000, maxPerDay: 8000 })).status).toBe(201);
    expect((await owner.call("POST", `/canteen/accounts/${acc.id}/rules`, { type: "FLAT", value: 100 })).status).toBe(409); // one all-slots rule
    expect((await owner.call("POST", `/canteen/accounts/${acc.id}/rules`, { type: "PERCENT", value: 150 })).status).toBe(400);
    m = await member({ corporateAccountId: acc.id, employeeCode: "E-100", department: "Finance", cardUid: "card-0001" });

    const a = (await bill(cashier, h.items.biryani, m.id)).body;
    expect(a.grandTotal).toBe(16000);
    expect(corporate(a)).toBe(6000); // 50% = 8000, capped at 6000 a meal
    const b = (await bill(cashier, h.items.biryani, m.id)).body;
    expect(corporate(b)).toBe(2000); // 8000 a day − 6000 already
    const c = (await bill(cashier, h.items.chai, m.id)).body;
    expect(corporate(c)).toBe(0);
    // The employee pays the rest by any mode; the company's share can't be typed at the counter.
    expect((await pay(cashier, a.id, [{ mode: "CORPORATE", amount: 100 }])).status).toBe(400);
    for (const o of [a, b, c]) expect((await pay(cashier, o.id, [{ mode: "CASH", amount: o.grandTotal - corporate(o) }])).body.paid).toBe(true);
  });

  it("monthly statement lists the company's share and can be invoiced and marked paid", async () => {
    const st = (await owner.call("GET", `/canteen/accounts/${acc.id}/statement?from=${today}&to=${today}`)).body;
    expect(st.totals).toMatchObject({ meals: 2, employerShare: 8000, billTotal: 32000, net: 8000 });
    expect(st.rows[0]).toMatchObject({ employeeCode: "E-100", department: "Finance", slot: "Lunch", amount: 6000 });
    const x = await owner.call("GET", `/canteen/accounts/${acc.id}/statement?from=${today}&to=${today}&format=xlsx`);
    expect(x.status).toBe(200);
    expect(x.headers.get("content-disposition")).toMatch(/statement_.*\.xlsx/);
    expect((await owner.call("GET", "/canteen/accounts")).body.find((a: { id: string }) => a.id === acc.id).outstanding).toBe(8000);
    const s = await owner.call("POST", `/canteen/accounts/${acc.id}/statements`, { from: today, to: today, invoiceRef: "INV-1" });
    expect(s.status).toBe(201);
    expect(s.body).toMatchObject({ amount: 8000, meals: 2, status: "INVOICED" });
    expect((await owner.call("POST", `/canteen/accounts/${acc.id}/statements`, { from: today, to: today })).status).toBe(409);
    expect((await owner.call("PATCH", `/canteen/statements/${s.body.id}`, { status: "PAID" })).body.status).toBe("PAID");
    expect((await owner.call("GET", "/canteen/accounts")).body.find((a: { id: string }) => a.id === acc.id).outstanding).toBe(0);
  });

  it("flat per meal for a slot, with slot and daily quotas (cancelled meals don't count)", async () => {
    const acc2 = await account({ dailyMealLimit: 2 });
    await owner.call("POST", `/canteen/accounts/${acc2.id}/rules`, { type: "FLAT", value: 1000 });
    const slotRule = (await owner.call("POST", `/canteen/accounts/${acc2.id}/rules`, { mealSlotId: slotId, type: "FLAT", value: 5000, maxPerMeal: 2500, slotMealLimit: 1 })).body;
    const m2 = await member({ corporateAccountId: acc2.id });

    const look = (await cashier.call("GET", `/canteen/members/lookup?q=${(await db.customer.findUniqueOrThrow({ where: { id: m2.id } })).phone}`)).body;
    expect(look).toMatchObject({ slot: { id: slotId }, rule: { type: "FLAT", value: 5000, maxPerMeal: 2500 }, mealsLeftToday: 1 });

    const a = (await bill(cashier, h.items.chai, m2.id)).body;
    expect(corporate(a)).toBe(1500); // whole chai: flat 5000 capped at the bill
    expect(a.status).toBe("PAID");
    const refused = await bill(cashier, h.items.samosa, m2.id);
    expect(refused.status).toBe(409);
    expect(refused.body.details.code).toBe("MEAL_QUOTA_REACHED");
    expect(refused.body.error).toMatch(/1 meal in this slot/);

    expect((await owner.call("POST", `/orders/${a.id}/cancel`, { reason: "wrong member" })).status).toBe(200);
    const b = (await bill(cashier, h.items.samosa, m2.id)).body;
    expect(corporate(b)).toBe(2500);

    // Daily limit (2 meals) once the slot limit is lifted.
    await owner.call("PATCH", `/canteen/rules/${slotRule.id}`, { slotMealLimit: null });
    expect((await bill(cashier, h.items.chai, m2.id)).status).toBe(201);
    const day = await bill(cashier, h.items.chai, m2.id);
    expect(day.status).toBe(409);
    expect(day.body.error).toMatch(/2 meals a day/);
  });

  it("refunds split between the company and the employee", async () => {
    const acc3 = await account({});
    await owner.call("POST", `/canteen/accounts/${acc3.id}/rules`, { type: "PERCENT", value: 25 });
    const m3 = await member({ corporateAccountId: acc3.id });
    const o = (await bill(cashier, h.items.biryani, m3.id)).body;
    await pay(cashier, o.id, [{ mode: "CASH", amount: 12000 }]);
    expect((await owner.call("POST", `/orders/${o.id}/refunds`, { reason: "QUALITY", refundMode: "CASH", amount: 13000 })).status).toBe(400);
    expect((await owner.call("POST", `/orders/${o.id}/refunds`, { reason: "QUALITY", refundMode: "CORPORATE", amount: 5000 })).status).toBe(400);
    expect((await owner.call("POST", `/orders/${o.id}/refunds`, { reason: "QUALITY", refundMode: "CORPORATE", amount: 4000 })).status).toBe(201);
    const st = (await owner.call("GET", `/canteen/accounts/${acc3.id}/statement?from=${today}&to=${today}`)).body;
    expect(st.totals).toMatchObject({ employerShare: 4000, refunds: 4000, net: 0 });
  });
});

describe("members, cards, wallet and meal tokens", () => {
  let w: { id: string; phone: string };

  it("card lookup by card, employee code or phone", async () => {
    w = await member({ employeeCode: "W-7", cardUid: "AB:CD:01" });
    expect((await cashier.call("GET", "/canteen/members/lookup?q=ab:cd:01")).body.id).toBe(w.id);
    expect((await cashier.call("GET", "/canteen/members/lookup?q=w-7")).body.id).toBe(w.id);
    expect((await cashier.call("GET", `/canteen/members/lookup?q=${w.phone}`)).body).toMatchObject({ id: w.id, walletBalance: 0, account: null, mealsLeftToday: null });
    expect((await cashier.call("GET", "/canteen/members/lookup?q=NOPE")).status).toBe(404);
    expect((await owner.call("POST", "/canteen/members", { name: "Dup", phone: phone(), cardUid: "ab:cd:01" })).status).toBe(409);
  });

  it("CSV import saves good rows and reports bad ones", async () => {
    const acc = await account({});
    const r = await owner.call("POST", "/canteen/members/import", {
      corporateAccountId: acc.id,
      rows: [
        { name: "Ravi", phone: phone(), employeeCode: "R1", department: "Ops", cardUid: "IMP-1" },
        { name: "Sita", phone: phone(), employeeCode: "S1" },
        { name: "Bad", phone: "12345" },
        { name: "Card clash", phone: phone(), cardUid: "imp-1" },
      ],
    });
    expect(r.body.created).toBe(2);
    expect(r.body.errors.map((e: { row: number }) => e.row)).toEqual([3, 4]);
    expect((await owner.call("GET", `/canteen/members?accountId=${acc.id}`)).body.total).toBe(2);
  });

  it("top-up, spend, insufficient balance, refund to wallet, cancel restores", async () => {
    await cashier.call("POST", "/cash-shifts/open", { openingFloat: 0 });
    const t = await cashier.call("POST", `/canteen/members/${w.id}/topup`, { amount: 20000, mode: "CASH" });
    expect(t.status).toBe(201);
    expect(t.body.walletBalance).toBe(20000);

    const a = (await bill(cashier, h.items.biryani, w.id)).body;
    expect(corporate(a)).toBe(0);
    expect((await pay(cashier, a.id, [{ mode: "WALLET", amount: 16000 }])).body.paid).toBe(true);
    const b = (await bill(cashier, h.items.samosa, w.id)).body;
    expect((await pay(cashier, b.id, [{ mode: "WALLET", amount: 3000 }])).body.paid).toBe(true); // 4000 left
    const c = (await bill(cashier, h.items.biryani, w.id)).body;
    const tooMuch = await pay(cashier, c.id, [{ mode: "WALLET", amount: 16000 }]);
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.error).toMatch(/only ₹10/);

    expect((await owner.call("POST", `/orders/${a.id}/refunds`, { reason: "QUALITY", refundMode: "WALLET", amount: 5000 })).status).toBe(201);
    expect((await db.customer.findUniqueOrThrow({ where: { id: w.id } })).walletBalance).toBe(1000 + 5000);
    expect((await owner.call("POST", `/orders/${b.id}/cancel`, { reason: "not served" })).status).toBe(200);
    expect((await db.customer.findUniqueOrThrow({ where: { id: w.id } })).walletBalance).toBe(6000 + 3000);

    // Wallet needs the member on the bill.
    const plain = (await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.chai, quantity: 1 }] })).body;
    expect((await pay(cashier, plain.id, [{ mode: "WALLET", amount: 1500 }])).status).toBe(400);
    await owner.call("POST", `/orders/${c.id}/cancel`, { reason: "test" });
    await owner.call("POST", `/orders/${plain.id}/cancel`, { reason: "test" });
  });

  it("meal tokens: buy, redeem on a bill, can't over-cover, cancel restores", async () => {
    const buy = await cashier.call("POST", `/canteen/members/${w.id}/tokens`, { mealSlotId: slotId, count: 5, unitPrice: 4000, mode: "CASH" });
    expect(buy.status).toBe(201);
    expect(buy.body).toMatchObject({ balance: 5, value: 20000 });
    const o = (await bill(cashier, h.items.samosa, w.id)).body;
    expect((await pay(cashier, o.id, [{ mode: "MEAL_TOKEN", amount: 3000 }])).body.paid).toBe(true);
    let acc = await db.mealTokenAccount.findFirstOrThrow({ where: { customerId: w.id } });
    expect(acc).toMatchObject({ balance: 4, value: 16000 });
    const big = (await bill(cashier, h.items.biryani, w.id)).body;
    expect((await pay(cashier, big.id, [{ mode: "MEAL_TOKEN", amount: 5000 }])).body.error).toMatch(/at most ₹40/);
    expect((await pay(cashier, big.id, [{ mode: "MEAL_TOKEN", amount: 8000, tokens: 2 }, { mode: "CASH", amount: 8000 }])).body.paid).toBe(true);
    expect((await owner.call("POST", `/orders/${o.id}/cancel`, { reason: "spilt" })).status).toBe(200);
    acc = await db.mealTokenAccount.findFirstOrThrow({ where: { customerId: w.id } });
    expect(acc).toMatchObject({ balance: 3, value: 12000 });
    expect((await cashier.call("GET", `/canteen/members/lookup?q=${w.phone}`)).body.tokens).toEqual([expect.objectContaining({ mealSlotId: slotId, slotName: "Lunch", balance: 3, unitValue: 4000 })]);
  });

  it("cash top-ups and token sales count in the cash drawer", async () => {
    const s = (await cashier.call("GET", "/cash-shifts/current")).body.summary;
    expect(s.canteenCashTopups).toBe(40000);
    expect(s.payments.WALLET.amount).toBeGreaterThan(0);
    expect(s.expectedCash).toBe(s.counterCash + s.cashTips + 40000 - s.cashRefunds);
  });
});

describe("canteen report", () => {
  it("meals by company and department, who paid, and wallet liability", async () => {
    const r = await owner.call("GET", `/reports/canteen?from=${today}&to=${today}`);
    expect(r.status).toBe(200);
    const finance = r.body.byDepartment.find((d: { key: string }) => d.key.endsWith("Finance"));
    expect(finance).toMatchObject({ meals: 3, gross: 33500, employerShare: 8000, employeeShare: 25500 });
    const none = r.body.byAccount.find((d: { key: string }) => d.key === "No company");
    expect(none).toMatchObject({ walletSpend: 16000, tokensRedeemed: 2, tokenValue: 8000 });
    const liability = await db.customer.aggregate({ where: { businessId: h.businessId, canteenMember: true }, _sum: { walletBalance: true } });
    expect(r.body.liability).toMatchObject({ walletBalance: liability._sum.walletBalance, tokensOutstanding: 3, tokenValue: 12000 });
    expect(r.body.topups).toMatchObject({ wallet: 20000, tokensSold: 5, tokenSales: 20000 });
    expect((await owner.call("GET", `/reports/canteen?from=${today}&to=${today}&format=xlsx`)).status).toBe(200);
  });
});
