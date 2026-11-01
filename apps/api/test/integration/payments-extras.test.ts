/** Phase 3.8 — card details, tips, gift cards (closed-loop), settlement reconciliation. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotel, db, login, startServer, type Client, type Hotel } from "./helpers";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel;
let cashier: Client, owner: Client;

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("Payments");
  cashier = await login(srv.base, h.users.cashier.email, h.outletId);
  owner = await login(srv.base, h.users.owner.email, h.outletId);
});
afterAll(() => srv.close());

const bill = async (c: Client, qty = 1) => (await c.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.biryani, quantity: qty }] })).body as { id: string; grandTotal: number; invoiceNumber: string };
const pay = (c: Client, id: string, payments: object[], extra: object = {}) => c.call("POST", `/orders/${id}/payments`, { payments, ...extra });

describe("card details and tips", () => {
  it("stores the card's last 4 and approval code, and a tip on top of the bill", async () => {
    const o = await bill(cashier);
    const r = await pay(cashier, o.id, [{ mode: "CARD", amount: o.grandTotal, cardLast4: "4242", authCode: "AB12CD", tip: 2000 }]);
    expect(r.status).toBe(200);
    expect(r.body.paid).toBe(true);
    const p = await db.payment.findFirstOrThrow({ where: { orderId: o.id } });
    expect(p).toMatchObject({ cardLast4: "4242", authCode: "AB12CD", tip: 2000, amount: o.grandTotal });
    expect((await pay(cashier, (await bill(cashier)).id, [{ mode: "CARD", amount: 100, cardLast4: "42" }])).status).toBe(400);
  });

  it("cash tendered must cover a cash tip too, and change is computed on amount + tip", async () => {
    const o = await bill(cashier);
    const r = await pay(cashier, o.id, [{ mode: "CASH", amount: o.grandTotal, tip: 1000 }], { tendered: o.grandTotal + 5000 });
    expect(r.body.change).toBe(4000);
  });
});

describe("gift cards", () => {
  it("are off unless the hotel turns them on", async () => {
    expect((await cashier.call("POST", "/gift-cards", { value: 50000, soldMode: "CASH" })).status).toBe(403);
    await db.business.update({ where: { id: h.businessId }, data: { features: { GIFT_CARDS: true } } });
  });

  it("sell, spend partly, can't overspend, refund back to the card, cancel restores it", async () => {
    const card = (await cashier.call("POST", "/gift-cards", { value: 20000, soldMode: "UPI", customerName: "Asha" })).body;
    expect(card.code).toMatch(/^GC-/);
    expect(card.balance).toBe(20000);
    const o = await bill(cashier);
    // Split: gift card + cash.
    const r = await pay(cashier, o.id, [{ mode: "GIFT_CARD", amount: 15000, giftCardCode: card.code.toLowerCase() }, { mode: "CASH", amount: o.grandTotal - 15000 }]);
    expect(r.status).toBe(200);
    expect((await db.giftCard.findUniqueOrThrow({ where: { id: card.id } })).balance).toBe(5000);

    const o2 = await bill(cashier);
    const over = await pay(cashier, o2.id, [{ mode: "GIFT_CARD", amount: 6000, giftCardCode: card.code }]);
    expect(over.status).toBe(400);
    expect(over.body.error).toMatch(/only ₹50/);

    const refund = await owner.call("POST", `/orders/${o.id}/refunds`, { reason: "QUALITY", refundMode: "GIFT_CARD", amount: 3000 });
    expect(refund.status).toBe(201);
    expect((await db.giftCard.findUniqueOrThrow({ where: { id: card.id } })).balance).toBe(8000);

    const o3 = await bill(cashier);
    await pay(cashier, o3.id, [{ mode: "GIFT_CARD", amount: 5000, giftCardCode: card.code }]);
    expect((await owner.call("POST", `/orders/${o3.id}/cancel`, { reason: "wrong table" })).status).toBe(200);
    const after = (await cashier.call("GET", `/gift-cards/code/${card.code}`)).body;
    expect(after.balance).toBe(8000);
    expect(after.transactions.map((t: { type: string }) => t.type)).toEqual(expect.arrayContaining(["ISSUE", "REDEEM", "REFUND"]));
  });

  it("a blocked card can't be spent", async () => {
    const card = (await cashier.call("POST", "/gift-cards", { value: 10000, soldMode: "CASH" })).body;
    await owner.call("POST", `/gift-cards/${card.id}/active`);
    const o = await bill(cashier);
    expect((await pay(cashier, o.id, [{ mode: "GIFT_CARD", amount: 1000, giftCardCode: card.code }])).body.error).toMatch(/blocked/);
  });
});

describe("settlement reconciliation", () => {
  it("matches settlement rows to card payments by reference, then amount, and lists what's pending", async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
    const a = await bill(cashier);
    const b = await bill(cashier, 2);
    await pay(cashier, a.id, [{ mode: "CARD", amount: a.grandTotal, authCode: "REF777" }]);
    await pay(cashier, b.id, [{ mode: "CARD", amount: b.grandTotal }]);
    const r = (await owner.call("POST", "/settlements", { mode: "CARD", rows: [{ date: today, amount: a.grandTotal, reference: "REF777" }, { date: today, amount: 123 }] })).body;
    expect(r.matched).toEqual([expect.objectContaining({ invoiceNumber: a.invoiceNumber, by: "reference" })]);
    expect(r.unmatched).toHaveLength(1);
    const s = (await owner.call("GET", "/settlements")).body;
    expect(s.pending.map((p: { invoiceNumber: string }) => p.invoiceNumber)).toContain(b.invoiceNumber);
    expect(s.pending.map((p: { invoiceNumber: string }) => p.invoiceNumber)).not.toContain(a.invoiceNumber);
    expect((await cashier.call("GET", "/settlements")).status).toBe(403);
  });
});

describe("cash drawer", () => {
  it("counts cash tips and gift cards sold for cash", async () => {
    await cashier.call("POST", "/cash-shifts/open", { openingFloat: 0 });
    const o = await bill(cashier);
    await pay(cashier, o.id, [{ mode: "CASH", amount: o.grandTotal, tip: 1500 }]);
    await cashier.call("POST", "/gift-cards", { value: 10000, soldMode: "CASH" });
    const s = (await cashier.call("GET", "/cash-shifts/current")).body.summary;
    expect(s.cashTips).toBe(1500);
    expect(s.giftCardCashSales).toBe(10000);
    expect(s.expectedCash).toBe(o.grandTotal + 1500 + 10000);
  });
});
