/**
 * QA Phase 7 (dbe) — follow-ups of dba / dbd findings:
 *  D2 gift-card refunds go back to the cards that paid, never above what each card paid;
 *  D3 the khata balance never goes below zero (void after settlement, khata credit note, races);
 *  D4 birthday / anniversary PERCENT coupons are capped at 100 %;
 *  D5 a corporate statement can't be raised with a negative amount;
 *  D6 a tax rate's GST + cess can't exceed 100 %;
 *  automatic retry of deadlocked / serialization-failed transactions;
 *  cash shift close: the Z-report and the close are one transaction (no payment lost mid-close).
 */
import { Prisma } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runCrmDailyForBusiness } from "../../src/jobs-crm";
import { conflict } from "../../src/lib/http";
import { runForBusiness } from "../../src/lib/tenant";
import { zonedParts } from "../../src/lib/time";
import { retryTransaction, withConflictRetry } from "../../src/lib/tx-retry";
import { paymentTestHooks } from "../../src/routes/orders";
import { createHotel, db, login, startServer, type Client, type Hotel } from "../integration/helpers";
import { failures, ownerClient, runChecks } from "./recon-kit";

const MODULES = ["BILLING", "KOT", "INVENTORY", "CUSTOMERS", "OFFERS", "REPORTS", "CANTEEN"];
const TZ = "Asia/Kolkata";
let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel;
let owner: Client, cashier: Client;
const owner_db = ownerClient();
type R = { status: number; body: any }; // eslint-disable-line @typescript-eslint/no-explicit-any

let seq = 0;
const phone = () => `97${String(Date.now() % 1e6).padStart(6, "0")}${String(seq++ % 100).padStart(2, "0")}`;
const ok = async (p: Promise<R>) => {
  const r = await p;
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body;
};
const bill = (extra: Record<string, unknown> = {}, item = h.items.biryani) => ok(cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: item, quantity: 1 }], ...extra }));
const pay = (id: string, payments: object[]) => cashier.call("POST", `/orders/${id}/payments`, { payments });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("Followups", { modules: MODULES });
  await db.business.update({ where: { id: h.businessId }, data: { features: { GIFT_CARDS: true } } });
  owner = await login(srv.base, h.users.owner.email, h.outletId);
  cashier = await login(srv.base, h.users.cashier.email, h.outletId);
}, 120_000);
afterEach(() => {
  paymentTestHooks.beforeCommit = undefined;
});
afterAll(async () => {
  // Whatever these tests did, the books must still reconcile.
  expect(failures(await runChecks(owner_db))).toEqual([]);
  await owner_db.$disconnect();
  await srv.close();
});

// =====================================================================
describe("D2 gift-card refunds go back to the cards that paid", () => {
  const card = async (value: number) => (await ok(cashier.call("POST", "/gift-cards", { value, soldMode: "UPI" }))) as { id: string; code: string };
  const balance = async (id: string) => (await db.giftCard.findUniqueOrThrow({ where: { id } })).balance;
  const paidByTwo = async () => {
    const [a, b] = [await card(10000), await card(10000)];
    const o = await bill(); // biryani ₹160, no GST
    expect(o.grandTotal).toBe(16000);
    const r = await pay(o.id, [
      { mode: "GIFT_CARD", amount: 8000, giftCardCode: a.code },
      { mode: "GIFT_CARD", amount: 8000, giftCardCode: b.code },
    ]);
    expect(r.status).toBe(200);
    return { a, b, o };
  };

  it("a full refund to GIFT_CARD gives each card back what it paid (no card above its initial value)", async () => {
    const { a, b, o } = await paidByTwo();
    expect((await owner.call("POST", `/orders/${o.id}/refunds`, { reason: "QUALITY", refundMode: "GIFT_CARD", amount: 16000 })).status).toBe(201);
    expect([await balance(a.id), await balance(b.id)]).toEqual([10000, 10000]);
  });

  it("partial refunds go back in reverse order of use, each card capped at what it paid", async () => {
    const { a, b, o } = await paidByTwo();
    const refund = (amount: number) => owner.call("POST", `/orders/${o.id}/refunds`, { reason: "QUALITY", refundMode: "GIFT_CARD", amount });
    expect((await refund(5000)).status).toBe(201);
    expect([await balance(a.id), await balance(b.id)]).toEqual([2000, 7000]); // last card used first
    expect((await refund(6000)).status).toBe(201); // 3000 fills card B, 3000 goes to card A
    expect([await balance(a.id), await balance(b.id)]).toEqual([5000, 10000]);
    expect((await refund(5001)).status).toBe(400); // only 5000 left on the gift-card part
    expect((await refund(5000)).status).toBe(201);
    expect([await balance(a.id), await balance(b.id)]).toEqual([10000, 10000]);
  });

  it("voiding a bill paid by several gift cards gives each card back exactly its own payment", async () => {
    const { a, b, o } = await paidByTwo();
    expect((await owner.call("POST", `/orders/${o.id}/cancel`, { reason: "Wrong bill" })).status).toBe(200);
    expect([await balance(a.id), await balance(b.id)]).toEqual([10000, 10000]);
  });
});

// =====================================================================
describe("D3 the khata balance never goes below zero", () => {
  const customerOf = async (p: string) => db.customer.findFirstOrThrow({ where: { businessId: h.businessId, phone: p } });
  const onKhata = async () => {
    const p = phone();
    const o = await bill({ customerPhone: p });
    expect((await pay(o.id, [{ mode: "KHATA", amount: o.grandTotal }])).status).toBe(200);
    const c = await customerOf(p);
    expect(c.khataBalance).toBe(o.grandTotal);
    return { o, c };
  };
  const settle = (id: string, amount: number) => cashier.call("POST", `/customers/${id}/khata/settle`, { amount, mode: "CASH" });

  it("voiding a bill whose khata was already settled is refused (refund it instead); balance stays 0", async () => {
    const { o, c } = await onKhata();
    expect((await settle(c.id, o.grandTotal)).status).toBe(200);
    const r = await owner.call("POST", `/orders/${o.id}/cancel`, { reason: "Wrong bill" });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/refund/i);
    expect((await customerOf(c.phone)).khataBalance).toBe(0);
    expect((await db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("PAID");
  });

  it("voiding an unsettled khata bill still reverses its khata in full", async () => {
    const { o, c } = await onKhata();
    expect((await owner.call("POST", `/orders/${o.id}/cancel`, { reason: "Wrong bill" })).status).toBe(200);
    expect((await customerOf(c.phone)).khataBalance).toBe(0);
  });

  it("a khata credit note is capped at the current outstanding; the settled part goes back by another mode", async () => {
    const { o, c } = await onKhata();
    expect((await settle(c.id, 10000)).status).toBe(200); // 6000 still outstanding
    const refund = (refundMode: string, amount: number) => owner.call("POST", `/orders/${o.id}/refunds`, { reason: "QUALITY", refundMode, amount });
    const over = await refund("KHATA", 16000);
    expect(over.status).toBe(400);
    expect(over.body.error).toMatch(/outstanding/i);
    expect((await refund("KHATA", 6000)).status).toBe(201);
    expect((await refund("CASH", 10000)).status).toBe(201);
    expect((await customerOf(c.phone)).khataBalance).toBe(0);
  });

  it("settling the whole khata while the bill is voided at the same moment: exactly one wins, balance 0", async () => {
    for (let i = 0; i < 4; i++) {
      const { o, c } = await onKhata();
      const [s, v] = await Promise.all([settle(c.id, o.grandTotal), owner.call("POST", `/orders/${o.id}/cancel`, { reason: "Race" })]);
      expect([s.status, v.status].filter((x) => x === 200)).toHaveLength(1);
      expect([s.status, v.status].every((x) => x < 500)).toBe(true);
      expect((await customerOf(c.phone)).khataBalance).toBe(0);
    }
  });

  it("three settlements of the whole khata at once collect it once (dbd-7 still holds)", async () => {
    const { o, c } = await onKhata();
    const rs = await Promise.all([1, 2, 3].map(() => settle(c.id, o.grandTotal)));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 400, 400]);
    expect((await customerOf(c.phone)).khataBalance).toBe(0);
  });
});

// =====================================================================
describe("D4 birthday coupons are capped at 100 %", () => {
  it("the loyalty config refuses a PERCENT birthday coupon above 100", async () => {
    expect((await owner.call("PUT", "/customers/loyalty/config", { birthdayCouponType: "PERCENT", birthdayCouponValue: 150 })).status).toBe(400);
    // Switching a FLAT ₹50 (5000 paise) coupon to PERCENT without a new value would mean 5000 %.
    expect((await owner.call("PUT", "/customers/loyalty/config", { birthdayCouponType: "FLAT", birthdayCouponValue: 5000 })).status).toBe(200);
    expect((await owner.call("PUT", "/customers/loyalty/config", { birthdayCouponType: "PERCENT" })).status).toBe(400);
    expect((await owner.call("PUT", "/customers/loyalty/config", { birthdayCouponType: "PERCENT", birthdayCouponValue: 100 })).status).toBe(200);
  });

  it("a stored (legacy) config of 150 % makes a 100 % coupon, not 150 %", async () => {
    const current = (await owner.call("GET", "/customers/loyalty/config")).body;
    await db.setting.update({
      where: { scope_key: { scope: h.businessId, key: "loyalty" } },
      data: { value: { ...current, birthdayCouponEnabled: true, birthdayCouponType: "PERCENT", birthdayCouponValue: 150 } },
    });
    const today = zonedParts(new Date(), TZ).date;
    const c = await db.customer.create({ data: { businessId: h.businessId, phone: phone(), name: "Bday", birthday: today.slice(5), marketingOptIn: true, whatsappOptIn: true } });
    await runForBusiness(h.businessId, () => runCrmDailyForBusiness(new Date(), { force: true }));
    const coupon = await db.coupon.findFirstOrThrow({ where: { businessId: h.businessId, customerId: c.id } });
    expect(coupon.discountType).toBe("PERCENT");
    expect(coupon.value).toBe(100);
  });
});

// =====================================================================
describe("D5 a corporate statement can't be negative", () => {
  it("a period whose refunds (of earlier bills) exceed the company's share is refused", async () => {
    const hhmm = (offsetMin: number) => {
      const m = (((zonedParts(new Date(), TZ).minutes + offsetMin) % 1440) + 1440) % 1440;
      return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    };
    await db.mealSlot.create({ data: { outletId: h.outletId, name: "All day", startTime: hhmm(-120), endTime: hhmm(120) } });
    const acc = await ok(owner.call("POST", "/canteen/accounts", { name: `Acme ${Date.now()}` }));
    await ok(owner.call("POST", `/canteen/accounts/${acc.id}/rules`, { type: "PERCENT", value: 25 }));
    const m = await ok(owner.call("POST", "/canteen/members", { name: "Emp", phone: phone(), corporateAccountId: acc.id }));
    const o = await bill({ memberId: m.id });
    const company = o.payments.filter((p: { mode: string }) => p.mode === "CORPORATE").reduce((s: number, p: { amount: number }) => s + p.amount, 0);
    expect(company).toBeGreaterThan(0);
    expect((await pay(o.id, [{ mode: "CASH", amount: o.grandTotal - company }])).status).toBe(200);
    // The bill belongs to an earlier period; the refund to the company is issued today.
    const ten = new Date(Date.now() - 10 * 86_400_000);
    await db.order.update({ where: { id: o.id }, data: { createdAt: ten } });
    expect((await owner.call("POST", `/orders/${o.id}/refunds`, { reason: "QUALITY", refundMode: "CORPORATE", amount: company })).status).toBe(201);
    const today = zonedParts(new Date(), TZ).date;
    const preview = (await owner.call("GET", `/canteen/accounts/${acc.id}/statement?from=${today}&to=${today}`)).body;
    expect(preview.totals.net).toBe(-company); // the live preview shows it as it is
    const r = await owner.call("POST", `/canteen/accounts/${acc.id}/statements`, { from: today, to: today });
    expect(r.status).toBe(400);
    expect(await db.corporateStatement.count({ where: { corporateAccountId: acc.id } })).toBe(0);
    // Including the bill's own day nets to zero and is accepted.
    const from = zonedParts(ten, TZ).date;
    const s = await owner.call("POST", `/canteen/accounts/${acc.id}/statements`, { from, to: today });
    expect(s.status).toBe(201);
    expect(s.body.amount).toBe(0);
  });
});

// =====================================================================
describe("D6 a tax rate's GST + cess can't exceed 100 %", () => {
  const create = (body: object) => owner.call("POST", "/tax-rates", { name: `T${seq++}`, ...body });
  it("create and update refuse an effective rate above 100 %", async () => {
    expect((await create({ cgst: 60, sgst: 60 })).status).toBe(400);
    expect((await create({ cgst: 9, sgst: 9, cess: 92 })).status).toBe(400);
    expect((await create({ cgst: 9, sgst: 9, igst: 18, cess: 90 })).status).toBe(400);
    expect((await create({ cgst: 2.5, sgst: 2.5, igst: 99, cess: 2 })).status).toBe(400);
    const r = await create({ cgst: 14, sgst: 14, cess: 12 });
    expect(r.status).toBe(201);
    expect((await owner.call("PATCH", `/tax-rates/${r.body.id}`, { cess: 80 })).status).toBe(400);
    expect((await owner.call("PATCH", `/tax-rates/${r.body.id}`, { cgst: 50, sgst: 50 })).status).toBe(400);
    expect((await owner.call("PATCH", `/tax-rates/${r.body.id}`, { igst: 95 })).status).toBe(400);
    expect((await owner.call("PATCH", `/tax-rates/${r.body.id}`, { cess: 72 })).status).toBe(200); // exactly 100
  });
});

// =====================================================================
describe("automatic retry of transaction conflicts", () => {
  const conflictError = () => new Prisma.PrismaClientKnownRequestError("Transaction failed due to a write conflict or a deadlock", { code: "P2034", clientVersion: "test" });

  it("a real deadlock between two whole transactions: the loser is retried and both succeed", async () => {
    const [a, b] = [
      await db.customer.create({ data: { businessId: h.businessId, phone: phone() } }),
      await db.customer.create({ data: { businessId: h.businessId, phone: phone() } }),
    ];
    let arrived = 0;
    let release!: () => void;
    const both = new Promise<void>((r) => (release = r));
    const attempts = { ab: 0, ba: 0 };
    const run = (key: "ab" | "ba", first: string, second: string) =>
      retryTransaction(async (tx) => {
        attempts[key]++;
        await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${first} FOR UPDATE`;
        if (attempts[key] === 1) {
          if (++arrived === 2) release();
          await both; // both hold their first row: the second lock is a deadlock
        }
        await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${second} FOR UPDATE`;
        await tx.customer.update({ where: { id: second }, data: { visitCount: { increment: 1 } } });
        return key;
      });
    const results = await Promise.allSettled([run("ab", a.id, b.id), run("ba", b.id, a.id)]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(attempts.ab + attempts.ba).toBe(3); // one of them ran twice
    const visits = (await db.customer.findMany({ where: { id: { in: [a.id, b.id] } } })).map((c) => c.visitCount);
    expect(visits).toEqual([1, 1]); // the rolled-back attempt left nothing behind
  }, 20_000);

  it("gives up after 3 retries and lets the conflict through (→ 409 TRY_AGAIN)", async () => {
    let n = 0;
    await expect(
      withConflictRetry(async () => {
        n++;
        throw conflictError();
      }),
    ).rejects.toMatchObject({ code: "P2034" });
    expect(n).toBe(4);
  });

  it("never retries other errors", async () => {
    let n = 0;
    await expect(
      withConflictRetry(async () => {
        n++;
        throw conflict("Order already cancelled");
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(n).toBe(1);
    // nor a whole transaction that failed for another reason
    let m = 0;
    await expect(
      retryTransaction(async (tx) => {
        m++;
        await tx.$executeRaw`SELECT 1/0`;
      }),
    ).rejects.toThrow();
    expect(m).toBe(1);
  });
});

// =====================================================================
describe("cash shift close is one transaction with its Z-report", () => {
  it("a cash payment committing while the shift closes is in the frozen Z-report (or after it), never lost", async () => {
    expect((await cashier.call("POST", "/cash-shifts/open", { openingFloat: 0 })).status).toBe(201);
    const o = await bill({}, h.items.samosa);
    paymentTestHooks.beforeCommit = () => sleep(600);
    const paying = pay(o.id, [{ mode: "CASH", amount: o.grandTotal }]);
    await sleep(200); // the payment row is written, its transaction not yet committed
    paymentTestHooks.beforeCommit = undefined;
    const close = await cashier.call("POST", "/cash-shifts/current/close", { countedCash: o.grandTotal });
    expect((await paying).status).toBe(200);
    expect(close.status).toBe(200);
    const shift = await db.cashShift.findUniqueOrThrow({ where: { id: close.body.id } });
    const p = await db.payment.findFirstOrThrow({ where: { orderId: o.id, mode: "CASH" } });
    const inWindow = p.createdAt >= shift.openedAt && p.createdAt < shift.closedAt!;
    const summary = shift.summary as { counterCash: number };
    // Whatever the timing: inside the window ⇔ counted in the frozen figure.
    expect({ inWindow, counted: summary.counterCash }).toEqual(inWindow ? { inWindow, counted: o.grandTotal } : { inWindow, counted: 0 });
    expect(inWindow).toBe(true); // the close waited for the payment in flight
    expect(shift.expectedCash).toBe(o.grandTotal);
  });

  it("a pay-in racing the close is either in the closed shift's Z-report or refused", async () => {
    expect((await cashier.call("POST", "/cash-shifts/open", { openingFloat: 0 })).status).toBe(201);
    for (let i = 0; i < 5; i++) {
      const [mv, close] = await Promise.all([
        cashier.call("POST", "/cash-shifts/current/movements", { type: "PAY_IN", amount: 1000, reason: "Change" }),
        cashier.call("POST", "/cash-shifts/current/close", { countedCash: 0 }),
      ]);
      expect(close.status).toBe(200);
      expect(mv.status).toBeLessThan(500);
      const shift = await db.cashShift.findUniqueOrThrow({ where: { id: close.body.id }, include: { movements: true } });
      const moved = shift.movements.reduce((s, m) => s + m.amount, 0);
      expect((shift.summary as { payIns: number }).payIns).toBe(moved);
      expect(mv.status === 201 ? moved : 0).toBe(moved);
      expect((await cashier.call("POST", "/cash-shifts/open", { openingFloat: 0 })).status).toBe(201);
    }
    await cashier.call("POST", "/cash-shifts/current/close", { countedCash: 0 });
  });
});
