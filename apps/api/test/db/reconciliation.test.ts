/**
 * QA Phase 7 — data reconciliation under a heavy mixed workload.
 *
 * Drives one hotel (every module + canteen, gift cards, offline invoice series, cash shift
 * required) through a busy day over the real API — bills, split payments, cancels, refunds,
 * khata, loyalty, coupons, gift cards, delivery COD + handovers, inventory purchases /
 * wastage / transfers / audits / adjustments, canteen wallets and meal tokens, offline sync,
 * running tabs — much of it in parallel, then runs every query of
 * docs/qa/sql/reconciliation.sql and expects each @check to return no rows.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotel, db, login, startServer, type Client, type Hotel } from "../integration/helpers";
import { failures, loadChecks, ownerClient, runChecks, runChecksOn } from "./recon-kit";

const MODULES = ["BILLING", "KOT", "TABLES", "DELIVERY", "RESERVATIONS", "INVENTORY", "CUSTOMERS", "OFFERS", "ATTENDANCE", "REPORTS", "CANTEEN"];

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel;
let owner: Client, owner2: Client, manager: Client, cashier: Client;
const owner_db = ownerClient();
/** Every 5xx seen anywhere in the workload (must stay empty). */
const serverErrors: string[] = [];

type R = { status: number; body: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const track = async (label: string, p: Promise<R>) => {
  const r = await p;
  if (r.status >= 500) serverErrors.push(`${label} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
  return r;
};
/** A call that must succeed. */
const ok = async (c: Client, method: string, path: string, body?: unknown) => {
  const r = await track(`${method} ${path}`, c.call(method, path, body));
  if (r.status >= 300) throw new Error(`${method} ${path} → ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body;
};
const phones = Array.from({ length: 6 }, (_, i) => `98${String(Date.now()).slice(-6)}${i}${i}`.slice(0, 10));
const pick = <T>(a: T[], i: number) => a[i % a.length];

const bill = (c: Client, extra: Record<string, unknown> = {}, items = [{ menuItemId: h.items.biryani, quantity: 1 }, { menuItemId: h.items.chai, quantity: 2 }]) =>
  track("POST /orders", c.call("POST", "/orders", { orderType: "TAKEAWAY", items, ...extra }));
const pay = (c: Client, id: string, payments: unknown[], tendered?: number) => track(`pay ${id}`, c.call("POST", `/orders/${id}/payments`, { payments, ...(tendered !== undefined && { tendered }) }));

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("Recon", { modules: MODULES, gst: true });
  await db.business.update({ where: { id: h.businessId }, data: { features: { GIFT_CARDS: true, OFFLINE_INVOICE_SERIES: true, REQUIRE_CASH_SHIFT: true } } });
  await db.outlet.update({ where: { id: h.outletId }, data: { gstin: "33ABCDE1234F1Z5", serviceChargeEnabled: true, serviceChargePercent: 5 } }).catch(() => undefined);
  owner = await login(srv.base, h.users.owner.email, h.outletId);
  owner2 = await login(srv.base, h.users.owner.email, h.outlet2Id);
  manager = await login(srv.base, h.users.manager.email, h.outletId);
  cashier = await login(srv.base, h.users.cashier.email, h.outletId);
}, 120_000);
afterAll(async () => {
  await owner_db.$disconnect();
  await srv.close();
});

describe("reconciliation after a busy mixed day", () => {
  it("every reconciliation query is empty and nothing answered 5xx", async () => {
    const o1 = h.outletId;
    // ---------------- setup: loyalty, coupon, inventory, recipes, tables ----------------
    await ok(owner, "PUT", "/customers/loyalty/config", { minRedeemPoints: 5, maxRedeemPercent: 50 });
    await ok(owner, "POST", "/offers/coupons", { code: "RECON10", discountType: "PERCENT", value: 10, usageLimit: 5 });
    const inv = async (name: string, unit: string, openingStock: number, costPerUnit: number) =>
      (await ok(owner, "POST", "/inventory/items", { name, unit, openingStock, costPerUnit, reorderLevel: 1 })).id as string;
    const rice = await inv("Rice", "KG", 50, 6000);
    const oil = await inv("Oil", "L", 20, 15000);
    const milk = await inv("Milk", "L", 30, 5000);
    const flour = await inv("Flour", "KG", 25, 4000);
    await ok(owner, "PUT", `/inventory/recipes/${h.items.biryani}`, { lines: [{ inventoryItemId: rice, quantity: 0.2 }, { inventoryItemId: oil, quantity: 15, unit: "ML" }] });
    await ok(owner, "PUT", `/inventory/recipes/${h.items.chai}`, { lines: [{ inventoryItemId: milk, quantity: 150, unit: "ML" }] });
    await ok(owner, "PUT", `/inventory/recipes/${h.items.samosa}`, { lines: [{ inventoryItemId: flour, quantity: 0.05 }, { inventoryItemId: oil, quantity: 0.01 }] });
    const vendor = (await ok(owner, "POST", "/inventory/vendors", { name: "Recon Supplies" })).id;

    // ---------------- cash shift ----------------
    await ok(cashier, "POST", "/cash-shifts/open", { openingFloat: 200000 });

    // ---------------- 1. 40 bills in parallel (customers, coupons, inter-state) ----------------
    const created = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        bill(i % 2 ? cashier : manager, {
          ...(i % 3 !== 0 && { customerPhone: pick(phones, i), customerName: `Guest ${i % 6}` }),
          ...(i % 10 === 4 && { couponCode: "RECON10" }),
          ...(i % 7 === 0 && { interState: true }),
          ...(i % 5 === 0 && { discount: { type: "FLAT", value: 1000 } }),
        }, i % 4 === 0 ? [{ menuItemId: h.items.samosa, quantity: 3 }] : undefined),
      ),
    );
    const orders = created.filter((r) => r.status === 201).map((r) => r.body as { id: string; grandTotal: number; customerPhone: string | null; items: { id: string }[] });
    const refused = created.filter((r) => r.status !== 201).map((r) => `${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    expect(refused.filter((x) => !/RECON10|usage limit/.test(x))).toEqual([]); // only the coupon's usage limit may refuse a bill

    // ---------------- 2. payments: split cash+UPI, card, khata, tips — in parallel ----------------
    await Promise.all(
      orders.slice(0, 30).map((o, i) => {
        if (i % 5 === 0) return pay(cashier, o.id, [{ mode: "CASH", amount: Math.floor(o.grandTotal / 2), tip: 500 }, { mode: "UPI", amount: o.grandTotal - Math.floor(o.grandTotal / 2) }], o.grandTotal);
        if (i % 5 === 1) return pay(cashier, o.id, [{ mode: "CARD", amount: o.grandTotal, cardLast4: "4242", tip: 1000 }]);
        if (i % 5 === 2 && o.customerPhone) return pay(manager, o.id, [{ mode: "KHATA", amount: o.grandTotal }]);
        if (i % 5 === 3) return pay(cashier, o.id, [{ mode: "CASH", amount: 1000 }]).then(() => pay(manager, o.id, [{ mode: "UPI", amount: o.grandTotal - 1000 }]));
        return pay(cashier, o.id, [{ mode: "CASH", amount: o.grandTotal }], o.grandTotal + 5000);
      }),
    );
    // Double collection race on a few bills: only one may win.
    await Promise.all(orders.slice(30, 34).flatMap((o) => [pay(cashier, o.id, [{ mode: "CASH", amount: o.grandTotal }]), pay(manager, o.id, [{ mode: "UPI", amount: o.grandTotal }])]));

    // ---------------- 3. loyalty: redeem points on new bills (parallel for one customer) ----------------
    const rich = await db.customer.findFirst({ where: { businessId: h.businessId, points: { gt: 20 } }, orderBy: { points: "desc" } });
    if (rich) {
      const rs = await Promise.all([0, 1, 2].map(() => bill(cashier, { customerPhone: rich.phone, redeemPoints: rich.points - 5 })));
      for (const r of rs.filter((x) => x.status === 201)) await pay(cashier, r.body.id, [{ mode: "UPI", amount: r.body.grandTotal }]);
    }
    await ok(owner, "POST", `/customers/${(await db.customer.findFirstOrThrow({ where: { businessId: h.businessId } })).id}/loyalty/adjust`, { points: 7, note: "Goodwill" });

    // ---------------- 4. gift cards ----------------
    const cards = [];
    for (const [value, soldMode] of [[100000, "CASH"], [50000, "UPI"], [200000, "CARD"]] as const) cards.push(await ok(cashier, "POST", "/gift-cards", { value, soldMode }));
    const gcBills = await Promise.all([0, 1, 2, 3].map(() => bill(cashier)));
    // Four bills race for card 2 (₹500): at most what's on the card is spent.
    await Promise.all(gcBills.map((r) => pay(cashier, r.body.id, [{ mode: "GIFT_CARD", amount: r.body.grandTotal, giftCardCode: cards[1].code }])));
    for (const r of gcBills) {
      const o = await db.order.findUniqueOrThrow({ where: { id: r.body.id }, include: { payments: true } });
      if (o.status === "OPEN") await pay(cashier, o.id, [{ mode: "GIFT_CARD", amount: 10000, giftCardCode: cards[0].code }, { mode: "CASH", amount: o.grandTotal - 10000 }]);
    }

    // ---------------- 5. cancels (open, cash-paid, khata-paid, gift-card-paid, points) ----------------
    const toCancel = [orders[38], orders[2], orders[7], orders[4], gcBills[0].body].filter(Boolean);
    await Promise.all(toCancel.flatMap((o) => [0, 1].map(() => track("cancel", manager.call("POST", `/orders/${o.id}/cancel`, { reason: "Recon cancel" })))));

    // ---------------- 6. refunds: items (restock), value to khata / gift card / cash ----------------
    const paidList = await db.order.findMany({ where: { outletId: o1, status: "PAID" }, include: { items: true, payments: true }, orderBy: { createdAt: "asc" } });
    const khataPaid = paidList.find((o) => o.payments.some((p) => p.mode === "KHATA"));
    const gcPaid = paidList.find((o) => o.payments.some((p) => p.mode === "GIFT_CARD") && o.id !== gcBills[0].body.id);
    const cashPaid = paidList.filter((o) => o.payments.every((p) => p.mode === "CASH"));
    await ok(manager, "POST", `/orders/${cashPaid[0].id}/refunds`, { reason: "QUALITY", refundMode: "CASH", items: [{ orderItemId: cashPaid[0].items[0].id, quantity: 1 }], restock: true });
    await Promise.all([1, 2].map(() => track("refund race", manager.call("POST", `/orders/${cashPaid[1].id}/refunds`, { reason: "OVERCHARGED", refundMode: "CASH", amount: cashPaid[1].grandTotal }))));
    if (khataPaid) await ok(manager, "POST", `/orders/${khataPaid.id}/refunds`, { reason: "OVERCHARGED", refundMode: "KHATA", amount: 2000 });
    if (gcPaid) await ok(manager, "POST", `/orders/${gcPaid.id}/refunds`, { reason: "WRONG_ITEM", refundMode: "GIFT_CARD", amount: 3000 });

    // ---------------- 7. khata settlements ----------------
    const debtors = await db.customer.findMany({ where: { businessId: h.businessId, khataBalance: { gt: 0 } } });
    for (const c of debtors) await ok(cashier, "POST", `/customers/${c.id}/khata/settle`, { amount: Math.max(1, Math.floor(c.khataBalance / 3)), mode: "CASH" });

    // ---------------- 8. delivery COD + handovers ----------------
    const partner = h.users.delivery.id;
    await db.staffAttendance.create({ data: { userId: partner, outletId: o1, workDate: new Date().toISOString().slice(0, 10), clockInAt: new Date(), clockInDistance: 0, status: "PRESENT" } });
    const deliveries = [];
    for (let i = 0; i < 4; i++) {
      const r = await ok(cashier, "POST", "/orders", {
        orderType: "DELIVERY", customerName: "Door", customerPhone: pick(phones, i),
        delivery: { address: "12 Anna Salai, Chennai", latitude: 13.01, longitude: 80.2, cod: true },
        items: [{ menuItemId: h.items.biryani, quantity: 1 }],
      });
      const d = await db.delivery.findFirstOrThrow({ where: { orderId: r.id } });
      await ok(manager, "PATCH", `/delivery/${d.id}/assign`, { agentId: partner, force: true });
      deliveries.push({ id: d.id, orderId: r.id as string, grandTotal: r.grandTotal as number });
    }
    // Complete three (one twice at once), cancel the last before it leaves.
    await Promise.all([manager, manager].map((c) => track("complete race", c.call("POST", `/delivery/${deliveries[0].id}/complete`, { cashCollected: deliveries[0].grandTotal }))));
    for (const d of deliveries.slice(1, 3)) await ok(manager, "POST", `/delivery/${d.id}/complete`, { cashCollected: d.grandTotal });
    await ok(manager, "POST", `/orders/${deliveries[3].orderId}/cancel`, { reason: "Customer cancelled" });
    const h1 = await ok(manager, "POST", "/delivery/cash/handovers", { agentId: partner, amount: deliveries[0].grandTotal - 500 });
    await ok(manager, "PATCH", `/delivery/cash/handovers/${h1.handover.id}`, { amount: deliveries[0].grandTotal });
    await Promise.all([1, 2].map(() => track("settle race", manager.call("POST", "/delivery/cash/settle", { agentId: partner }))));

    // ---------------- 9. canteen: wallets, meal tokens, member bills ----------------
    const member = await ok(owner, "POST", "/canteen/members", { name: "Recon Emp", phone: phones[5], cardUid: `RC${Date.now()}` });
    await ok(cashier, "POST", `/canteen/members/${member.id}/topup`, { amount: 50000, mode: "CASH" });
    await ok(cashier, "POST", `/canteen/members/${member.id}/topup`, { amount: 30000, mode: "UPI" });
    await ok(cashier, "POST", `/canteen/members/${member.id}/tokens`, { count: 3, unitPrice: 20000, mode: "CASH" });
    const mb = await Promise.all([0, 1, 2, 3].map(() => bill(cashier, { memberId: member.id }, [{ menuItemId: h.items.samosa, quantity: 1 }])));
    // Wallet race: four bills paid from one wallet at once.
    await Promise.all(mb.map((r) => pay(cashier, r.body.id, [{ mode: "WALLET", amount: r.body.grandTotal }])));
    const tokenBill = await bill(cashier, { memberId: member.id }, [{ menuItemId: h.items.samosa, quantity: 1 }]);
    await pay(cashier, tokenBill.body.id, [{ mode: "MEAL_TOKEN", amount: tokenBill.body.grandTotal, tokens: 1 }]);
    await ok(manager, "POST", `/orders/${mb[0].body.id}/cancel`, { reason: "Wallet bill void" });
    await ok(manager, "POST", `/orders/${mb[1].body.id}/refunds`, { reason: "QUALITY", refundMode: "WALLET", amount: 1000 });
    await ok(manager, "POST", `/orders/${tokenBill.body.id}/cancel`, { reason: "Token bill void" });
    await ok(owner, "POST", `/canteen/members/${member.id}/wallet/adjust`, { amount: -500, note: "Correction" });

    // ---------------- 10. inventory: purchases, wastage, transfers, audit, adjustments ----------------
    await Promise.all([
      track("purchase", owner.call("POST", "/inventory/purchases", { vendorId: vendor, items: [{ inventoryItemId: rice, quantity: 10, unitCost: 5800, taxRate: 5 }, { inventoryItemId: oil, quantity: 5, unitCost: 14500 }], receive: true })),
      track("wastage", owner.call("POST", "/inventory/wastage", { items: [{ inventoryItemId: milk, quantity: 1.5, reason: "Spoiled" }, { inventoryItemId: oil, quantity: 250, unit: "ML", reason: "Spilled" }] })),
      track("wastage2", manager.call("POST", "/inventory/wastage", { items: [{ inventoryItemId: oil, quantity: 0.1, reason: "Burnt" }, { inventoryItemId: milk, quantity: 0.5, reason: "Spoiled" }] })),
      track("adjust", owner.call("POST", `/inventory/items/${flour}/adjust`, { quantity: -0.75, reason: "Recount" })),
      ...orders.slice(34, 38).map((o) => pay(cashier, o.id, [{ mode: "UPI", amount: o.grandTotal }])),
    ]);
    const draft = await ok(owner, "POST", "/inventory/purchases", { vendorId: vendor, items: [{ inventoryItemId: flour, quantity: 4, unitCost: 3900 }] });
    await ok(owner, "POST", `/inventory/purchases/${draft.id}/receive`);
    await ok(owner, "POST", `/inventory/purchases/${draft.id}/payments`, { amount: 5000, mode: "CASH" });
    await ok(owner, "POST", `/inventory/purchases/${draft.id}/cancel`, { reason: "Wrong flour" });
    const t1 = await ok(owner, "POST", "/inventory/transfers", { toOutletId: h.outlet2Id, items: [{ inventoryItemId: rice, quantity: 3 }, { inventoryItemId: milk, quantity: 2 }] });
    await ok(owner, "POST", `/inventory/transfers/${t1.id}/dispatch`);
    await ok(owner2, "POST", `/inventory/transfers/${t1.id}/receive`);
    const t2 = await ok(owner, "POST", "/inventory/transfers", { toOutletId: h.outlet2Id, items: [{ inventoryItemId: oil, quantity: 1 }] });
    await ok(owner, "POST", `/inventory/transfers/${t2.id}/dispatch`);
    const t3 = await ok(owner2, "POST", "/inventory/transfers", { fromOutletId: o1, items: [{ inventoryItemId: flour, quantity: 1 }] });
    await ok(owner2, "POST", `/inventory/transfers/${t3.id}/cancel`);
    const audit = await ok(owner, "POST", "/inventory/audits", {});
    // Sales keep happening while the count is on.
    const during = await bill(cashier);
    await pay(cashier, during.body.id, [{ mode: "CARD", amount: during.body.grandTotal }]);
    await ok(owner, "PUT", `/inventory/audits/${audit.id}/counts`, { counts: [{ inventoryItemId: rice, countedQty: 40 }, { inventoryItemId: milk, countedQty: 20 }] });
    await ok(owner, "POST", `/inventory/audits/${audit.id}/complete`);

    // ---------------- 11. offline sync with a device series (+ resend) ----------------
    const series = await ok(cashier, "POST", "/orders/offline-series", { deviceId: "recon-device-0001" });
    const fy = new Date().getUTCMonth() >= 3 ? new Date().getUTCFullYear() : new Date().getUTCFullYear() - 1;
    const offline = [1, 2, 4].map((seq, i) => ({
      clientOrderId: randomUUID(), orderType: "TAKEAWAY", items: [{ menuItemId: pick([h.items.chai, h.items.samosa], i), quantity: 2 }],
      createdAt: new Date(Date.now() - (10 - i) * 60_000).toISOString(),
      offlineInvoiceNumber: `${series.prefix}-${fy}-${String(seq).padStart(5, "0")}`,
    }));
    const noNumber = { clientOrderId: randomUUID(), orderType: "TAKEAWAY", items: [{ menuItemId: h.items.chai, quantity: 1 }], createdAt: new Date(Date.now() - 120_000).toISOString() };
    const [s1, s2] = await Promise.all([ok(cashier, "POST", "/orders/sync", { orders: [...offline, noNumber] }), ok(cashier, "POST", "/orders/sync", { orders: [...offline, noNumber] })]);
    for (const r of [...s1.results, ...s2.results]) expect(r.ok, JSON.stringify(r)).toBe(true);
    for (const r of s1.results.slice(0, 2)) await pay(cashier, r.orderId, [{ mode: "CASH", amount: r.grandTotal }]);

    // ---------------- 12. running tabs: two tables, merge, bill, pay ----------------
    const tA = await ok(owner, "POST", "/tables", { label: `R${Date.now() % 1000}A` });
    const tB = await ok(owner, "POST", "/tables", { label: `R${Date.now() % 1000}B` });
    const sA = await ok(cashier, "POST", `/tables/${tA.id}/open`, { guests: 2 });
    const sB = await ok(cashier, "POST", `/tables/${tB.id}/open`, { guests: 2 });
    await Promise.all([
      ok(cashier, "POST", `/tables/sessions/${sA.id}/items`, { items: [{ menuItemId: h.items.biryani, quantity: 2 }] }),
      ok(manager, "POST", `/tables/sessions/${sB.id}/items`, { items: [{ menuItemId: h.items.chai, quantity: 3 }] }),
      bill(cashier),
    ]);
    await ok(cashier, "POST", `/tables/sessions/${sA.id}/merge`, { tableIds: [tB.id] });
    const tab = await ok(cashier, "POST", `/tables/sessions/${sA.id}/bill`, {});
    // Paying the last bill closes the tab (and frees both tables).
    for (const { order } of tab.orders) await pay(cashier, order.id, [{ mode: "CASH", amount: order.grandTotal }]);

    // ---------------- 13. close the drawer ----------------
    await ok(cashier, "POST", "/cash-shifts/current/movements", { type: "PAY_OUT", amount: 20000, reason: "Vegetables" });
    await ok(cashier, "POST", "/cash-shifts/current/movements", { type: "PAY_IN", amount: 5000, reason: "Change" });
    await ok(cashier, "POST", "/cash-shifts/current/close", { countedCash: 123456 });

    // ---------------- the books ----------------
    expect(serverErrors).toEqual([]);
    const results = await runChecks(owner_db);
    const warns = results.filter((r) => r.check.kind === "warn").map((r) => `${r.check.id}=${r.rows.length}`);
    console.info(`[recon] ${results.length} queries; warnings: ${warns.join(" ")}; orders=${await db.order.count({ where: { outlet: { businessId: h.businessId } } })}`);
    expect(failures(results)).toEqual([]);
  }, 240_000);

  it("each query really catches its kind of damage (corrupt in a rolled-back transaction)", async () => {
    // Every corruption below breaks exactly the invariant of the listed check(s).
    const ROLLBACK = new Error("rollback");
    let caught: Record<string, number> = {};
    const bid = h.businessId;
    await owner_db
      .$transaction(
        async (tx) => {
          await tx.$queryRawUnsafe("SELECT set_config('app.bypass_rls', 'on', true)");
          const paid = await tx.order.findFirstOrThrow({ where: { outlet: { businessId: bid }, status: "PAID", payments: { every: { mode: "CASH" } } } });
          const kh = await tx.khataTransaction.findFirstOrThrow({ where: { customer: { businessId: bid }, type: "DEBIT", orderId: { not: null } } });
          const cust = await tx.customer.findFirstOrThrow({ where: { businessId: bid, points: { gt: 0 } } });
          const card = await tx.giftCard.findFirstOrThrow({ where: { businessId: bid } });
          const member = await tx.customer.findFirstOrThrow({ where: { businessId: bid, canteenMember: true } });
          const stock = await tx.inventoryStock.findFirstOrThrow({ where: { outletId: h.outletId } });
          const shift = await tx.cashShift.findFirstOrThrow({ where: { outletId: h.outletId, status: "CLOSED" } });
          const kots = await tx.kotTicket.findMany({ where: { outletId: h.outletId }, take: 2 });
          const coupon = await tx.coupon.findFirstOrThrow({ where: { businessId: bid } });
          const open = await tx.order.findFirstOrThrow({ where: { outletId: h.outletId, status: "OPEN" } });
          await tx.order.update({ where: { id: paid.id }, data: { grandTotal: { increment: 1 } } }); // A01, A06
          await tx.payment.create({ data: { orderId: open.id, mode: "CASH", amount: open.grandTotal + 1, status: "SUCCESS" } }); // A02, A03
          await tx.order.update({ where: { id: paid.id }, data: { refundedAmount: { increment: 1 } } }); // A04
          await tx.khataTransaction.delete({ where: { id: kh.id } }); // A07, B02
          await tx.customer.update({ where: { id: cust.id }, data: { points: { increment: 1 } } }); // B01
          await tx.giftCard.update({ where: { id: card.id }, data: { balance: { increment: 1 } } }); // B04
          await tx.customer.update({ where: { id: member.id }, data: { walletBalance: { increment: 1 } } }); // B05
          await tx.coupon.update({ where: { id: coupon.id }, data: { usedCount: { increment: 1 } } }); // B07
          await tx.inventoryStock.update({ where: { outletId_inventoryItemId: { outletId: stock.outletId, inventoryItemId: stock.inventoryItemId } }, data: { quantity: { increment: 0.01 } } }); // C01, C02
          await tx.invoiceCounter.updateMany({ where: { outletId: h.outletId }, data: { lastSeq: { increment: 1 } } }); // E02 (a gap)
          await tx.cashShift.update({ where: { id: shift.id }, data: { expectedCash: { increment: 1 } } }); // F01
          await tx.kotTicket.update({ where: { id: kots[1].id }, data: { kotNumber: kots[0].kotNumber } }); // G02
          const results = await runChecksOn(tx);
          caught = Object.fromEntries(results.map((r) => [r.check.id, r.rows.length]));
          throw ROLLBACK;
        },
        { timeout: 120_000 },
      )
      .catch((e) => {
        if (e !== ROLLBACK) throw e;
      });
    for (const id of ["A01", "A02", "A03", "A04", "A06", "A07", "B01", "B02", "B04", "B05", "B07", "C01", "C02", "E02", "F01", "F02", "G02"]) expect(caught[id], id).toBeGreaterThan(0);
    // ...and nothing stuck: the books are right again after the rollback.
    expect(failures(await runChecks(owner_db))).toEqual([]);
  }, 120_000);

  it("the reconciliation file is well-formed (ids unique, every query parses)", () => {
    const checks = loadChecks();
    expect(checks.length).toBeGreaterThanOrEqual(35);
    expect(new Set(checks.map((c) => c.id)).size).toBe(checks.length);
  });
});
