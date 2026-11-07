/**
 * QA Phase 6 — /cash-shifts (open, pay-in / pay-out, close, X / Z reports), /settlements (card / UPI
 * reconciliation upload, IST day matching, summary) and /gift-cards (sell, look up, list, block).
 * Contract, roles, feature / module gating, tenant isolation, validation, double submits.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "../integration/helpers";
import { assertIntegerMoney, assertNoSecrets, db, LONG, makeWorld, roleMatrix, setFeatures, type Client, type World } from "./service-fixtures";

let srv: Awaited<ReturnType<typeof startServer>>;
let w: World;
let cashier: Client, manager: Client, owner: Client;

beforeAll(async () => {
  srv = await startServer();
  w = await makeWorld(srv.base, "Cash API");
  ({ cashier, manager, owner } = w.as);
});
afterAll(() => srv.close());

const bill = async (mode: string, extra: object = {}) => {
  const o = await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: w.h.items.samosa, quantity: 1 }] });
  const p = await cashier.call("POST", `/orders/${o.body.id}/payments`, { payments: [{ mode, amount: o.body.grandTotal, ...extra }] });
  expect(p.status, JSON.stringify(p.body)).toBe(200);
  return o.body as { id: string; grandTotal: number };
};

// =====================================================================
describe("/cash-shifts", () => {
  it("no shift: current → null; movements / close → 409", async () => {
    expect((await cashier.call("GET", "/cash-shifts/current")).body).toBeNull();
    expect((await cashier.call("POST", "/cash-shifts/current/movements", { type: "PAY_IN", amount: 100, reason: "change" })).status).toBe(409);
    expect((await cashier.call("POST", "/cash-shifts/current/close", { countedCash: 0 })).status).toBe(409);
  });

  it.each([{}, { openingFloat: -1 }, { openingFloat: 1.5 }, { openingFloat: "100" }, { openingFloat: null }])("open with %j → 400", async (body) => {
    expect((await cashier.call("POST", "/cash-shifts/open", body)).status).toBe(400);
    expect(await db.cashShift.count({ where: { outletId: w.h.outletId } })).toBe(0);
  });

  it("two devices opening at the same moment → one shift", async () => {
    const rs = await Promise.all([cashier.call("POST", "/cash-shifts/open", { openingFloat: 100000 }), manager.call("POST", "/cash-shifts/open", { openingFloat: 100000 })]);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await db.cashShift.count({ where: { outletId: w.h.outletId, status: "OPEN" } })).toBe(1);
    const shift = rs.find((r) => r.status === 201)!.body;
    expect(shift).toMatchObject({ status: "OPEN", openingFloat: 100000, outletId: w.h.outletId });
  });

  it("movements: validation; pay-in / pay-out move expected cash; X-report is integer", async () => {
    for (const body of [{ type: "TIP", amount: 100, reason: "abc" }, { type: "PAY_IN", amount: 0, reason: "abc" }, { type: "PAY_IN", amount: -5, reason: "abc" }, { type: "PAY_IN", amount: 1.5, reason: "abc" }, { type: "PAY_IN", amount: 100, reason: "ab" }, { type: "PAY_IN", amount: 100, reason: LONG }, { type: "PAY_IN", amount: 100 }]) {
      expect((await cashier.call("POST", "/cash-shifts/current/movements", body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    const before = (await cashier.call("GET", "/cash-shifts/current")).body.summary.expectedCash as number;
    expect((await cashier.call("POST", "/cash-shifts/current/movements", { type: "PAY_IN", amount: 5000, reason: "more change", shiftId: "x" })).status).toBe(201);
    expect((await manager.call("POST", "/cash-shifts/current/movements", { type: "PAY_OUT", amount: 2000, reason: "milk" })).status).toBe(201);
    const o = await bill("CASH");
    const cur = await cashier.call("GET", "/cash-shifts/current");
    expect(cur.body.summary.expectedCash).toBe(before + 5000 - 2000 + o.grandTotal);
    assertIntegerMoney(cur.body);
    assertNoSecrets(cur.body);
  });

  it("close: validation; variance = counted − expected; closing twice (even at once) → one close", async () => {
    for (const body of [{}, { countedCash: -1 }, { countedCash: 1.5 }, { countedCash: 100, denominations: { abc: 1 } }, { countedCash: 100, denominations: { "500": -1 } }, { countedCash: 100, note: LONG }]) {
      expect((await cashier.call("POST", "/cash-shifts/current/close", body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    const expected = (await cashier.call("GET", "/cash-shifts/current")).body.summary.expectedCash as number;
    const rs = await Promise.all([cashier.call("POST", "/cash-shifts/current/close", { countedCash: expected - 100, denominations: { "500": 2 } }), manager.call("POST", "/cash-shifts/current/close", { countedCash: expected + 999 })]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    const closed = rs.find((r) => r.status === 200)!.body;
    expect(closed.variance).toBe(closed.countedCash - closed.expectedCash);
    const row = await db.cashShift.findUniqueOrThrow({ where: { id: closed.id } });
    expect(row.countedCash).toBe(closed.countedCash);
    expect((await cashier.call("POST", "/cash-shifts/current/close", { countedCash: 0 })).status).toBe(409);
  });

  it("Z-report / history: report:view roles; 404s; limit validated; other hotel sees nothing", async () => {
    const id = (await db.cashShift.findFirstOrThrow({ where: { outletId: w.h.outletId } })).id;
    const z = await manager.call("GET", `/cash-shifts/${id}`);
    expect(z.status).toBe(200);
    assertIntegerMoney(z.body);
    expect((await manager.call("GET", "/cash-shifts/cl0000000000000000000000")).status).toBe(404);
    expect((await w.otherOwner.call("GET", `/cash-shifts/${id}`)).status).toBe(404);
    expect((await w.otherOwner.call("GET", "/cash-shifts")).body).toEqual([]);
    for (const q of ["limit=0", "limit=201", "limit=x"]) expect((await manager.call("GET", `/cash-shifts?${q}`)).status).toBe(400);
    expect(await roleMatrix(w, ["owner", "manager", "accountant", "auditor"], (c) => c.call("GET", "/cash-shifts"), 200)).toEqual([]);
    expect(await roleMatrix(w, ["owner", "manager", "accountant", "auditor"], (c) => c.call("GET", `/cash-shifts/${id}`), 200)).toEqual([]);
  });

  it("drawer roles: payment:collect (owner, manager, cashier); auditor / admin / unassigned outlet refused", async () => {
    expect(await roleMatrix(w, ["owner", "manager", "cashier"], (c) => c.call("GET", "/cash-shifts/current"), 200)).toEqual([]);
    expect((await w.admin.call("GET", "/cash-shifts/current")).status).toBe(403);
    expect((await w.managerOutlet2.call("GET", "/cash-shifts/current")).status).toBe(403);
    expect((await w.otherOwner.call("POST", "/cash-shifts/open", { openingFloat: 1 }, { "x-outlet-id": w.h.outletId })).status).toBe(403);
  });
});

// =====================================================================
describe("/settlements", () => {
  const D = "2026-01-20";
  let early: string, late: string;
  beforeAll(async () => {
    // 23:59:59.999 IST on the 20th, and 00:00 IST on the 21st, both CARD for the same amount.
    const a = await bill("CARD", { authCode: "AUTH01", cardLast4: "4242" });
    const b = await bill("CARD", { authCode: "AUTH02", cardLast4: "4242" });
    const pa = await db.payment.findFirstOrThrow({ where: { orderId: a.id } });
    const pb = await db.payment.findFirstOrThrow({ where: { orderId: b.id } });
    await db.payment.update({ where: { id: pa.id }, data: { createdAt: new Date("2026-01-20T18:29:59.999Z") } });
    await db.payment.update({ where: { id: pb.id }, data: { createdAt: new Date("2026-01-20T18:30:00.000Z") } });
    [early, late] = [pa.id, pb.id];
  });

  const bad: [string, unknown][] = [
    ["no rows", { mode: "CARD", rows: [] }],
    ["mode CASH", { mode: "CASH", rows: [{ date: D, amount: 1 }] }],
    ["bad date", { mode: "CARD", rows: [{ date: "20-01-2026", amount: 1 }] }],
    ["impossible date", { mode: "CARD", rows: [{ date: "2026-02-30", amount: 1 }] }],
    ["month 13", { mode: "CARD", rows: [{ date: "2026-13-01", amount: 1 }] }],
    ["float amount", { mode: "CARD", rows: [{ date: D, amount: 1.5 }] }],
    ["negative amount", { mode: "CARD", rows: [{ date: D, amount: -1 }] }],
    ["reference 10k", { mode: "CARD", rows: [{ date: D, amount: 1, reference: LONG }] }],
    ["5001 rows", { mode: "CARD", rows: Array.from({ length: 5001 }, () => ({ date: D, amount: 1 })) }],
  ];
  it.each(bad)("upload %s → 400 (never 500), nothing settled", async (_n, body) => {
    const r = await owner.call("POST", "/settlements", body);
    expect(r.status, JSON.stringify(r.body).slice(0, 200)).toBe(400);
    expect(await db.payment.count({ where: { settledAt: { not: null }, order: { outletId: w.h.outletId } } })).toBe(0);
  });

  it("matches on the payment's IST day, by reference first; a re-upload doesn't settle twice", async () => {
    const amount = (await db.payment.findUniqueOrThrow({ where: { id: early } })).amount;
    const r = await owner.call("POST", "/settlements", { mode: "CARD", rows: [{ date: D, amount, reference: "AUTH01" }, { date: D, amount, reference: "AUTH02" }] });
    expect(r.status).toBe(200);
    expect(r.body.matched).toEqual([expect.objectContaining({ paymentId: early, by: "reference" })]);
    expect(r.body.unmatched).toHaveLength(1);
    const again = await owner.call("POST", "/settlements", { mode: "CARD", rows: [{ date: D, amount, reference: "AUTH01" }] });
    expect(again.body.matched).toEqual([]);
    const next = await owner.call("POST", "/settlements", { mode: "CARD", rows: [{ date: "2026-01-21", amount }] });
    expect(next.body.matched).toEqual([expect.objectContaining({ paymentId: late, by: "amount" })]);
  });

  it("summary: dates validated; expected vs settled integer; other hotel sees none of it", async () => {
    const s = await owner.call("GET", "/settlements?from=2026-01-20&to=2026-01-21");
    expect(s.status).toBe(200);
    expect(s.body.byMode.CARD.settled.count).toBe(2);
    assertIntegerMoney(s.body);
    for (const q of ["from=2026-02-30", "to=2026-13-01", "from=x"]) expect((await owner.call("GET", `/settlements?${q}`)).status, q).toBe(400);
    const o = await w.otherOwner.call("GET", "/settlements?from=2026-01-20&to=2026-01-21");
    expect(o.body.byMode.CARD.expected.count).toBe(0);
    const up = await w.otherOwner.call("POST", "/settlements", { mode: "CARD", rows: [{ date: "2026-01-21", amount: 3000 }] });
    expect(up.body.matched).toEqual([]);
  });

  it("roles: report:view reads (owner, manager, accountant, auditor); the auditor can't upload", async () => {
    expect(await roleMatrix(w, ["owner", "manager", "accountant", "auditor"], (c) => c.call("GET", "/settlements"), 200)).toEqual([]);
    expect(await roleMatrix(w, ["owner", "manager", "accountant"], (c) => c.call("POST", "/settlements", { mode: "UPI", rows: [{ date: D, amount: 1 }] }), 200)).toEqual([]);
  });
});

// =====================================================================
describe("/gift-cards", () => {
  it("feature off → 403 on every endpoint", async () => {
    await setFeatures(w.h.businessId, {});
    for (const [m, p, b] of [["POST", "/gift-cards", { value: 5000, soldMode: "CASH" }], ["GET", "/gift-cards", undefined], ["GET", "/gift-cards/code/X", undefined], ["POST", "/gift-cards/x/active", undefined]] as const) {
      expect((await owner.call(m, p, b)).status, `${m} ${p}`).toBe(403);
    }
    await setFeatures(w.h.businessId, { GIFT_CARDS: true });
  });

  const bad: [string, object][] = [
    ["no value", { soldMode: "CASH" }],
    ["value 4999", { value: 4999, soldMode: "CASH" }],
    ["value above ₹50,000", { value: 5_000_001, soldMode: "CASH" }],
    ["float value", { value: 5000.5, soldMode: "CASH" }],
    ["sold by khata", { value: 5000, soldMode: "KHATA" }],
    ["sold by gift card", { value: 5000, soldMode: "GIFT_CARD" }],
    ["short code", { value: 5000, soldMode: "CASH", code: "AB" }],
    ["code with spaces", { value: 5000, soldMode: "CASH", code: "AB CD EF" }],
    ["code injection", { value: 5000, soldMode: "CASH", code: "'; DROP--" }],
    ["bad phone", { value: 5000, soldMode: "CASH", customerPhone: "123" }],
    ["bad expiry", { value: 5000, soldMode: "CASH", expiresAt: "soon" }],
    ["name 10k", { value: 5000, soldMode: "CASH", customerName: LONG }],
  ];
  it.each(bad)("sell %s → 400, nothing written", async (_n, body) => {
    const before = await db.giftCard.count({ where: { businessId: w.h.businessId } });
    expect((await cashier.call("POST", "/gift-cards", body)).status).toBe(400);
    expect(await db.giftCard.count({ where: { businessId: w.h.businessId } })).toBe(before);
  });

  it("sell: 201, server sets balance / active; code normalised; duplicate (even at once) → one card", async () => {
    const r = await cashier.call("POST", "/gift-cards", { value: 10000, soldMode: "UPI", code: "diwali-2026", balance: 99999999, initialValue: 1, active: false, businessId: w.other.businessId });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ code: "DIWALI-2026", balance: 10000, initialValue: 10000, active: true, businessId: w.h.businessId });
    assertIntegerMoney(r.body);
    expect((await cashier.call("POST", "/gift-cards", { value: 5000, soldMode: "UPI", code: "DIWALI-2026" })).status).toBe(409);
    const rs = await Promise.all([cashier.call("POST", "/gift-cards", { value: 5000, soldMode: "UPI", code: "RACE-0001" }), manager.call("POST", "/gift-cards", { value: 5000, soldMode: "UPI", code: "RACE-0001" })]);
    expect(rs.map((x) => x.status).sort()).toEqual([201, 409]);
    expect(await db.giftCard.count({ where: { code: "RACE-0001" } })).toBe(1);
  });

  it("selling for cash needs an open shift under REQUIRE_CASH_SHIFT", async () => {
    await setFeatures(w.h.businessId, { GIFT_CARDS: true, REQUIRE_CASH_SHIFT: true });
    try {
      const r = await cashier.call("POST", "/gift-cards", { value: 5000, soldMode: "CASH" });
      expect(r.status).toBe(409);
      expect(r.body.details.code).toBe("CASH_SHIFT_CLOSED");
      expect((await cashier.call("POST", "/gift-cards", { value: 5000, soldMode: "UPI" })).status).toBe(201);
    } finally {
      await setFeatures(w.h.businessId, { GIFT_CARDS: true });
    }
  });

  it("look-up by code (case-insensitive); unknown / other hotel's code → 404; expired flag; an expired card can't pay", async () => {
    const card = (await cashier.call("POST", "/gift-cards", { value: 5000, soldMode: "UPI" })).body;
    const got = await cashier.call("GET", `/gift-cards/code/${card.code.toLowerCase()}`);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ id: card.id, expired: false, transactions: [expect.objectContaining({ type: "ISSUE", amount: 5000 })] });
    expect((await cashier.call("GET", "/gift-cards/code/NOPE-NOPE")).status).toBe(404);
    await setFeatures(w.other.businessId, { GIFT_CARDS: true });
    expect((await w.otherOwner.call("GET", `/gift-cards/code/${card.code}`)).status).toBe(404);
    expect((await w.otherOwner.call("GET", "/gift-cards")).body.cards).toEqual([]);
    await db.giftCard.update({ where: { id: card.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await cashier.call("GET", `/gift-cards/code/${card.code}`)).body.expired).toBe(true);
    const o = await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: w.h.items.chai, quantity: 1 }] });
    const pay = await cashier.call("POST", `/orders/${o.body.id}/payments`, { payments: [{ mode: "GIFT_CARD", amount: 100, giftCardCode: card.code }] });
    expect(pay.status).toBe(400);
    expect(pay.body.error).toMatch(/expired/);
    expect((await db.giftCard.findUniqueOrThrow({ where: { id: card.id } })).balance).toBe(5000);
  });

  it("list: report:view roles, integer outstanding; block / unblock: owner only; unknown / other hotel → 404", async () => {
    const list = await owner.call("GET", "/gift-cards");
    expect(list.status).toBe(200);
    expect(Number.isInteger(list.body.outstanding.balance)).toBe(true);
    expect(await roleMatrix(w, ["owner", "manager", "accountant", "auditor"], (c) => c.call("GET", "/gift-cards"), 200)).toEqual([]);
    expect(await roleMatrix(w, ["owner", "manager", "cashier"], (c) => c.call("GET", "/gift-cards/code/DIWALI-2026"), 200)).toEqual([]);
    expect(await roleMatrix(w, ["owner", "manager", "cashier"], (c) => c.call("POST", "/gift-cards", { value: 5000, soldMode: "CARD" }), 201)).toEqual([]);
    const card = (await cashier.call("POST", "/gift-cards", { value: 5000, soldMode: "UPI" })).body;
    expect(await roleMatrix(w, ["owner"], (c) => c.call("POST", `/gift-cards/${card.id}/active`), 200)).toEqual([]);
    expect((await db.giftCard.findUniqueOrThrow({ where: { id: card.id } })).active).toBe(false);
    expect((await owner.call("POST", "/gift-cards/cl0000000000000000000000/active")).status).toBe(404);
    expect((await w.otherOwner.call("POST", `/gift-cards/${card.id}/active`)).status).toBe(404);
    expect((await db.giftCard.findUniqueOrThrow({ where: { id: card.id } })).active).toBe(false);
  });
});
