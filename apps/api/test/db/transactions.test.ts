/**
 * QA Phase 7 — transactions and isolation.
 *  1. Rollback: a failure injected after the order insert, or mid-way through payments /
 *     refunds, leaves nothing behind (no order without items, no payment without its ledger
 *     row, no stock deduction, no points / coupon / counter consumed, no KOT, no audit row).
 *  2. Deadlocks: real code paths that lock the same rows in opposite orders, run at the same
 *     moment — never a 500; afterwards the books still reconcile.
 *  3. Counters under parallel writes: invoice numbers (50 bills at once, unique + gapless),
 *     KOT numbers, loyalty points, stock decrements, khata settlements, UPI confirmations.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { billingTestHooks } from "../../src/services/billing";
import { createHotel, db, login, startServer, type Client, type Hotel } from "../integration/helpers";
import { failures, ownerClient, runChecks } from "./recon-kit";

const MODULES = ["BILLING", "KOT", "TABLES", "DELIVERY", "INVENTORY", "CUSTOMERS", "OFFERS", "REPORTS", "CANTEEN"];
let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel;
let owner: Client, manager: Client, cashier: Client;
const owner_db = ownerClient();
type R = { status: number; body: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
let rice: string, oil: string, milk: string;

const phone = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
const bill = (c: Client, extra: Record<string, unknown> = {}, items: unknown[] = [{ menuItemId: h.items.biryani, quantity: 1 }]): Promise<R> =>
  c.call("POST", "/orders", { orderType: "TAKEAWAY", items, ...extra });
const ok = async (p: Promise<R>) => {
  const r = await p;
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body;
};
const statuses = (rs: R[]) => rs.map((r) => r.status).sort();
const no5xx = (rs: R[]) => expect(rs.filter((r) => r.status >= 500).map((r) => JSON.stringify(r.body).slice(0, 200))).toEqual([]);
const stockOf = async (itemId: string, outletId = h.outletId) =>
  (await db.inventoryStock.findUnique({ where: { outletId_inventoryItemId: { outletId, inventoryItemId: itemId } } }))?.quantity ?? 0;

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("Tx", { modules: MODULES });
  await db.business.update({ where: { id: h.businessId }, data: { features: { GIFT_CARDS: true } } });
  owner = await login(srv.base, h.users.owner.email, h.outletId);
  manager = await login(srv.base, h.users.manager.email, h.outletId);
  cashier = await login(srv.base, h.users.cashier.email, h.outletId);
  const inv = async (name: string, unit: string, openingStock: number) => (await ok(owner.call("POST", "/inventory/items", { name, unit, openingStock, costPerUnit: 1000 }))).id as string;
  rice = await inv("Rice", "KG", 100);
  oil = await inv("Oil", "L", 100);
  milk = await inv("Milk", "L", 100);
  await ok(owner.call("PUT", `/inventory/recipes/${h.items.biryani}`, { lines: [{ inventoryItemId: rice, quantity: 0.25 }, { inventoryItemId: oil, quantity: 0.02 }] }));
  await ok(owner.call("PUT", `/inventory/recipes/${h.items.chai}`, { lines: [{ inventoryItemId: milk, quantity: 0.1 }] }));
  await ok(owner.call("PUT", "/customers/loyalty/config", { minRedeemPoints: 1, maxRedeemPercent: 100 }));
}, 120_000);
afterEach(() => {
  billingTestHooks.beforeCommit = undefined;
});
afterAll(async () => {
  // Whatever these tests did, the books must still reconcile.
  expect(failures(await runChecks(owner_db))).toEqual([]);
  await owner_db.$disconnect();
  await srv.close();
});

// =====================================================================
describe("rollback on failure", () => {
  it("a failure after the order insert leaves no order, item, KOT, payment, stock move, points, coupon use, counter step or audit row", async () => {
    const p = phone();
    const first = await ok(bill(cashier, { customerPhone: p }));
    await ok(cashier.call("POST", `/orders/${first.id}/payments`, { payments: [{ mode: "UPI", amount: first.grandTotal }] }));
    await ok(owner.call("POST", "/offers/coupons", { code: "TXROLL", discountType: "FLAT", value: 500, usageLimit: 10 }));
    const customer = await db.customer.findFirstOrThrow({ where: { businessId: h.businessId, phone: p } });
    expect(customer.points).toBeGreaterThan(0);
    const before = {
      orders: await db.order.count({ where: { outletId: h.outletId } }),
      items: await db.orderItem.count({ where: { order: { outletId: h.outletId } } }),
      kots: await db.kotTicket.count({ where: { outletId: h.outletId } }),
      counter: (await db.invoiceCounter.findFirstOrThrow({ where: { outletId: h.outletId } })).lastSeq,
      rice: await stockOf(rice),
      ledger: await db.inventoryTransaction.count({ where: { outletId: h.outletId } }),
      points: customer.points,
      loyaltyRows: await db.loyaltyTransaction.count({ where: { customerId: customer.id } }),
      coupon: (await db.coupon.findFirstOrThrow({ where: { code: "TXROLL" } })).usedCount,
      audits: await db.auditLog.count({ where: { outletId: h.outletId, action: "order.create" } }),
      outbox: await db.outboxEvent.count(),
    };
    billingTestHooks.beforeCommit = (input) => {
      if (input.notes === "INJECT") throw new Error("injected failure after the order insert");
    };
    const r = await bill(cashier, { customerPhone: p, couponCode: "TXROLL", redeemPoints: 1, notes: "INJECT" }, [{ menuItemId: h.items.biryani, quantity: 2 }]);
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: "Internal server error", requestId: expect.any(String) });
    expect(await db.order.count({ where: { outletId: h.outletId } })).toBe(before.orders);
    expect(await db.order.count({ where: { notes: "INJECT" } })).toBe(0);
    expect(await db.orderItem.count({ where: { order: { outletId: h.outletId } } })).toBe(before.items);
    expect(await db.kotTicket.count({ where: { outletId: h.outletId } })).toBe(before.kots);
    expect((await db.invoiceCounter.findFirstOrThrow({ where: { outletId: h.outletId } })).lastSeq).toBe(before.counter);
    expect(await stockOf(rice)).toBe(before.rice);
    expect(await db.inventoryTransaction.count({ where: { outletId: h.outletId } })).toBe(before.ledger);
    const c2 = await db.customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(c2.points).toBe(before.points);
    expect(await db.loyaltyTransaction.count({ where: { customerId: customer.id } })).toBe(before.loyaltyRows);
    expect((await db.coupon.findFirstOrThrow({ where: { code: "TXROLL" } })).usedCount).toBe(before.coupon);
    expect(await db.couponRedemption.count({ where: { coupon: { code: "TXROLL" } } })).toBe(0);
    expect(await db.auditLog.count({ where: { outletId: h.outletId, action: "order.create" } })).toBe(before.audits);
    expect(await db.outboxEvent.count()).toBe(before.outbox);
    // The next bill takes the very next number: the failed one left no gap.
    billingTestHooks.beforeCommit = undefined;
    const next = await ok(bill(cashier));
    expect(next.invoiceNumber).toMatch(new RegExp(`-${String(before.counter + 1).padStart(5, "0")}$`));
  });

  it("a payment that fails half-way (2nd tender refused) stores none of the tenders and no ledger rows", async () => {
    const p = phone();
    const o = await ok(bill(cashier, { customerPhone: p, customerName: "Half Way" }));
    const card = await ok(cashier.call("POST", "/gift-cards", { value: 5000, soldMode: "UPI" }));
    // CASH first, then a gift card that can't cover its part.
    const r1 = await cashier.call("POST", `/orders/${o.id}/payments`, { payments: [{ mode: "CASH", amount: 1000 }, { mode: "GIFT_CARD", amount: o.grandTotal - 1000, giftCardCode: card.code }] });
    expect(r1.status).toBe(400);
    // UPI first, then khata past the customer's limit (the customer row exists from the bill).
    const c = await db.customer.findFirstOrThrow({ where: { businessId: h.businessId, phone: p } });
    await db.customer.update({ where: { id: c.id }, data: { khataLimit: 100 } });
    const r2 = await cashier.call("POST", `/orders/${o.id}/payments`, { payments: [{ mode: "UPI", amount: 1000 }, { mode: "KHATA", amount: o.grandTotal - 1000 }] });
    expect(r2.status).toBe(400);
    expect(await db.payment.count({ where: { orderId: o.id } })).toBe(0);
    expect(await db.giftCardTxn.count({ where: { giftCardId: card.id, type: "REDEEM" } })).toBe(0);
    expect((await db.giftCard.findUniqueOrThrow({ where: { id: card.id } })).balance).toBe(5000);
    expect(await db.khataTransaction.count({ where: { customerId: c.id } })).toBe(0);
    expect((await db.customer.findUniqueOrThrow({ where: { id: c.id } })).khataBalance).toBe(0);
    expect((await db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("OPEN");
  });

  it("a refund that fails after its checks stores no credit note and doesn't use a credit-note number", async () => {
    const o = await ok(bill(cashier));
    await ok(cashier.call("POST", `/orders/${o.id}/payments`, { payments: [{ mode: "CASH", amount: o.grandTotal }] }));
    const counter = async () => (await db.creditNoteCounter.findFirst({ where: { outletId: h.outletId } }))?.lastSeq ?? 0;
    const before = await counter();
    // Refund "to the gift card" on a cash bill: refused inside the refund transaction.
    expect((await manager.call("POST", `/orders/${o.id}/refunds`, { reason: "QUALITY", refundMode: "GIFT_CARD", amount: 1000 })).status).toBe(400);
    expect((await manager.call("POST", `/orders/${o.id}/refunds`, { reason: "QUALITY", refundMode: "KHATA", amount: 1000 })).status).toBe(400);
    expect(await db.creditNote.count({ where: { orderId: o.id } })).toBe(0);
    expect(await counter()).toBe(before);
    expect((await db.order.findUniqueOrThrow({ where: { id: o.id } })).refundedAmount).toBe(0);
    const okNote = await ok(manager.call("POST", `/orders/${o.id}/refunds`, { reason: "QUALITY", refundMode: "CASH", amount: 1000 }));
    expect(okNote.number).toMatch(new RegExp(`-${String(before + 1).padStart(5, "0")}$`));
  });

  it("a tab bill split in groups is all-or-nothing: a failure on the 2nd group leaves no bill and every item unbilled", async () => {
    const t = await ok(owner.call("POST", "/tables", { label: `TX${Date.now() % 10000}` }));
    const s = await ok(cashier.call("POST", `/tables/${t.id}/open`, { guests: 2 }));
    const added = await ok(cashier.call("POST", `/tables/sessions/${s.id}/items`, { items: [{ menuItemId: h.items.biryani, quantity: 1 }, { menuItemId: h.items.chai, quantity: 1 }] }));
    const ids = added.session.items.map((i: { id: string }) => i.id);
    let n = 0;
    billingTestHooks.beforeCommit = () => {
      if (++n === 2) throw new Error("injected failure on the second split bill");
    };
    const r = await cashier.call("POST", `/tables/sessions/${s.id}/bill`, { mode: "BY_ITEMS", groups: [[ids[0]], [ids[1]]] });
    expect(r.status).toBe(500);
    expect(await db.order.count({ where: { tableSessionId: s.id } })).toBe(0);
    expect(await db.tableSessionItem.count({ where: { sessionId: s.id, billedOrderId: { not: null } } })).toBe(0);
  });
});

// =====================================================================
describe("deadlocks: same rows, opposite lock order, same moment", () => {
  it("wastage [rice, oil] vs [oil, rice] ×10 pairs: no 500, stock = ledger", async () => {
    const before = { rice: await stockOf(rice), oil: await stockOf(oil) };
    const rs = await Promise.all(
      Array.from({ length: 10 }, () => [
        owner.call("POST", "/inventory/wastage", { items: [{ inventoryItemId: rice, quantity: 0.1, reason: "Spill" }, { inventoryItemId: oil, quantity: 0.1, reason: "Spill" }] }),
        manager.call("POST", "/inventory/wastage", { items: [{ inventoryItemId: oil, quantity: 0.1, reason: "Spill" }, { inventoryItemId: rice, quantity: 0.1, reason: "Spill" }] }),
      ]).flat(),
    );
    no5xx(rs);
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(await stockOf(rice)).toBeCloseTo(before.rice - 2, 3);
    expect(await stockOf(oil)).toBeCloseTo(before.oil - 2, 3);
  });

  it("purchases received / transfers dispatched with lines in opposite order, plus sales of the same ingredients: no 500", async () => {
    const vendor = (await ok(owner.call("POST", "/inventory/vendors", { name: "Tx Vendor" }))).id;
    const mk = (a: string, b: string) => ok(owner.call("POST", "/inventory/purchases", { vendorId: vendor, items: [{ inventoryItemId: a, quantity: 1, unitCost: 900 }, { inventoryItemId: b, quantity: 1, unitCost: 900 }] }));
    const drafts = await Promise.all([mk(rice, oil), mk(oil, rice), mk(rice, oil), mk(oil, rice)]);
    const tr = await Promise.all([[rice, oil], [oil, rice], [rice, oil], [oil, rice]].map(([a, b]) => ok(owner.call("POST", "/inventory/transfers", { toOutletId: h.outlet2Id, items: [{ inventoryItemId: a, quantity: 0.5 }, { inventoryItemId: b, quantity: 0.5 }] }))));
    const rs = await Promise.all([
      ...drafts.map((d) => owner.call("POST", `/inventory/purchases/${d.id}/receive`)),
      ...tr.map((t) => owner.call("POST", `/inventory/transfers/${t.id}/dispatch`)),
      ...Array.from({ length: 6 }, () => bill(cashier)),
    ]);
    no5xx(rs);
    expect(rs.filter((r) => r.status >= 300).map((r) => r.body)).toEqual([]);
  });

  it("merging table A into B and B into A at the same moment: no 500, one merge wins, no item lost", async () => {
    const lbl = Date.now() % 10000;
    const tA = await ok(owner.call("POST", "/tables", { label: `MA${lbl}` }));
    const tB = await ok(owner.call("POST", "/tables", { label: `MB${lbl}` }));
    const sA = await ok(cashier.call("POST", `/tables/${tA.id}/open`, { guests: 2 }));
    const sB = await ok(manager.call("POST", `/tables/${tB.id}/open`, { guests: 3 }));
    await ok(cashier.call("POST", `/tables/sessions/${sA.id}/items`, { items: [{ menuItemId: h.items.biryani, quantity: 1 }] }));
    await ok(manager.call("POST", `/tables/sessions/${sB.id}/items`, { items: [{ menuItemId: h.items.chai, quantity: 2 }] }));
    const rs = await Promise.all([
      cashier.call("POST", `/tables/sessions/${sA.id}/merge`, { tableIds: [tB.id] }),
      manager.call("POST", `/tables/sessions/${sB.id}/merge`, { tableIds: [tA.id] }),
    ]);
    no5xx(rs);
    expect(statuses(rs)).toEqual([200, 409]);
    // Exactly one tab is still open, it holds both tables and both rounds of items.
    const open = await db.tableSession.findMany({ where: { id: { in: [sA.id, sB.id] }, status: "OPEN" }, include: { items: true } });
    expect(open).toHaveLength(1);
    expect(open[0].items).toHaveLength(2);
    expect(new Set([open[0].tableId, ...open[0].mergedTableIds])).toEqual(new Set([tA.id, tB.id]));
  });

  it("bills of one customer paid on khata / cancelled / settled at once (bill → customer locks): no 500", async () => {
    const p = phone();
    const os = [];
    for (let i = 0; i < 6; i++) os.push(await ok(bill(cashier, { customerPhone: p })));
    await ok(cashier.call("POST", `/orders/${os[0].id}/payments`, { payments: [{ mode: "KHATA", amount: os[0].grandTotal }] }));
    const c = await db.customer.findFirstOrThrow({ where: { businessId: h.businessId, phone: p } });
    const rs = await Promise.all([
      ...os.slice(1, 4).map((o) => cashier.call("POST", `/orders/${o.id}/payments`, { payments: [{ mode: "KHATA", amount: o.grandTotal }] })),
      manager.call("POST", `/orders/${os[0].id}/cancel`, { reason: "Lock order test" }),
      manager.call("POST", `/orders/${os[4].id}/cancel`, { reason: "Lock order test" }),
      cashier.call("POST", `/customers/${c.id}/khata/settle`, { amount: 100, mode: "CASH" }),
      owner.call("POST", `/customers/${c.id}/loyalty/adjust`, { points: 3, note: "lock test" }),
    ]);
    no5xx(rs);
  });
});

// =====================================================================
describe("counters under parallel writes", () => {
  it("50 bills at once on an outlet's first day: invoice numbers unique and 1..50 without a gap", async () => {
    const o3 = await db.outlet.create({ data: { businessId: h.businessId, name: `Third ${Date.now()}`, stateCode: "33", gstEnabled: false, invoicePrefix: "TX3" } });
    const c3 = await login(srv.base, h.users.owner.email, o3.id);
    const rs = await Promise.all(Array.from({ length: 50 }, () => bill(c3, {}, [{ menuItemId: h.items.samosa, quantity: 1 }])));
    no5xx(rs);
    expect(rs.filter((r) => r.status !== 201).map((r) => r.body)).toEqual([]);
    const seqs = rs.map((r) => Number(String(r.body.invoiceNumber).split("-").pop())).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect((await db.invoiceCounter.findFirstOrThrow({ where: { outletId: o3.id } })).lastSeq).toBe(50);
  });

  it("KOT numbers stay unique when counter bills and tab rounds are fired at the same moment", async () => {
    const t = await ok(owner.call("POST", "/tables", { label: `K${Date.now() % 10000}` }));
    const s = await ok(cashier.call("POST", `/tables/${t.id}/open`, { guests: 2 }));
    const rs = await Promise.all([
      ...Array.from({ length: 8 }, () => bill(cashier, {}, [{ menuItemId: h.items.samosa, quantity: 1 }])),
      ...Array.from({ length: 8 }, () => manager.call("POST", `/tables/sessions/${s.id}/items`, { items: [{ menuItemId: h.items.chai, quantity: 1 }] })),
    ]);
    no5xx(rs);
    const dupes = await owner_db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT "kotNumber", COUNT(*) AS n FROM "KotTicket" WHERE "outletId" = $1 GROUP BY 1 HAVING COUNT(*) > 1`,
      h.outletId,
    );
    expect(dupes).toEqual([]);
  });

  it("5 bills redeeming all of one customer's points at once: one succeeds, points never negative, ledger = balance", async () => {
    const p = phone();
    const seed = await ok(bill(cashier, { customerPhone: p }));
    await ok(cashier.call("POST", `/orders/${seed.id}/payments`, { payments: [{ mode: "UPI", amount: seed.grandTotal }] }));
    const c = await db.customer.findFirstOrThrow({ where: { businessId: h.businessId, phone: p } });
    expect(c.points).toBeGreaterThan(0);
    const rs = await Promise.all(Array.from({ length: 5 }, () => bill(cashier, { customerPhone: p, redeemPoints: c.points })));
    no5xx(rs);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    const after = await db.customer.findUniqueOrThrow({ where: { id: c.id } });
    const ledger = await db.loyaltyTransaction.aggregate({ where: { customerId: c.id }, _sum: { points: true } });
    expect(after.points).toBe(0);
    expect(ledger._sum.points).toBe(0);
  });

  it("two loyalty deductions at once can't take the balance below zero", async () => {
    const p = phone();
    const seed = await ok(bill(cashier, { customerPhone: p }));
    await ok(cashier.call("POST", `/orders/${seed.id}/payments`, { payments: [{ mode: "UPI", amount: seed.grandTotal }] }));
    const c = await db.customer.findFirstOrThrow({ where: { businessId: h.businessId, phone: p } });
    const rs = await Promise.all([0, 1, 2].map(() => owner.call("POST", `/customers/${c.id}/loyalty/adjust`, { points: -c.points, note: "Expired by hand" })));
    no5xx(rs);
    expect(statuses(rs)).toEqual([200, 400, 400]);
    expect((await db.customer.findUniqueOrThrow({ where: { id: c.id } })).points).toBe(0);
  });

  it("30 sales at once deduct exactly 30 recipes of stock", async () => {
    const before = { rice: await stockOf(rice), oil: await stockOf(oil) };
    const rs = await Promise.all(Array.from({ length: 30 }, (_, i) => bill(i % 2 ? cashier : manager)));
    no5xx(rs);
    expect(rs.every((r) => r.status === 201)).toBe(true);
    expect(await stockOf(rice)).toBeCloseTo(before.rice - 30 * 0.25, 3);
    expect(await stockOf(oil)).toBeCloseTo(before.oil - 30 * 0.02, 3);
  });

  it("settling the whole khata twice at once collects it once (balance never below zero)", async () => {
    const p = phone();
    const o = await ok(bill(cashier, { customerPhone: p }));
    await ok(cashier.call("POST", `/orders/${o.id}/payments`, { payments: [{ mode: "KHATA", amount: o.grandTotal }] }));
    const c = await db.customer.findFirstOrThrow({ where: { businessId: h.businessId, phone: p } });
    const rs = await Promise.all([cashier, manager, cashier].map((x) => x.call("POST", `/customers/${c.id}/khata/settle`, { amount: o.grandTotal, mode: "CASH" })));
    no5xx(rs);
    expect(statuses(rs)).toEqual([200, 400, 400]);
    expect((await db.customer.findUniqueOrThrow({ where: { id: c.id } })).khataBalance).toBe(0);
    expect(await db.khataTransaction.count({ where: { customerId: c.id, type: "CREDIT" } })).toBe(1);
  });

  it("a shown UPI QR confirmed after the bill was paid in cash doesn't pay it twice", async () => {
    const o = await ok(bill(cashier));
    const qr = await ok(cashier.call("POST", `/orders/${o.id}/upi-qr`, {}));
    // Customer pays cash instead; later someone taps "confirm" on the old QR (or both at once).
    const rs = await Promise.all([
      cashier.call("POST", `/orders/${o.id}/payments`, { payments: [{ mode: "CASH", amount: o.grandTotal }] }),
      manager.call("POST", `/orders/${o.id}/payments/${qr.paymentId}/confirm`, { reference: "UTR1" }),
    ]);
    no5xx(rs);
    const late = await manager.call("POST", `/orders/${o.id}/payments/${qr.paymentId}/confirm`, { reference: "UTR1" });
    expect(late.status).toBe(409);
    const paid = await db.payment.aggregate({ where: { orderId: o.id, status: "SUCCESS" }, _sum: { amount: true } });
    expect(paid._sum.amount).toBe(o.grandTotal);
  });
});
