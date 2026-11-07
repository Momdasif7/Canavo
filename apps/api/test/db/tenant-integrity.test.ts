/**
 * QA Phase 7 (database) — tenant integrity under a realistic multi-hotel workload.
 *
 * Three hotels are driven through the real API (menu with variants / add-ons / recipes, customers,
 * khata, coupons and offers, counter bills paid by cash / UPI / card / khata / gift card, cancels,
 * credit notes, running tabs with KOTs, transfer and merge, reservations, delivery, cash shifts,
 * inventory purchases / transfers / wastage / audits, staff, canteen accounts / wallets / tokens /
 * slots / pre-orders / subscriptions). Then every check of docs/qa/sql/tenant-integrity.sql
 * (generated from the catalog by scripts/tenant-integrity.ts) must report 0 rows.
 *
 * Also: the committed SQL matches the migrated catalog; the checks really fire on planted
 * cross-tenant links (mutation test, rolled back); the Phase 7 CHECK / unique constraints hold.
 */
import { readFileSync } from "node:fs";
import { Prisma, PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, zonedParts } from "../../src/lib/time";
import { generateFrom, SQL_FILE } from "../../scripts/tenant-integrity";
import { createHotel, createPlatformAdmin, db, login, startServer, type Client, type Hotel } from "../integration/helpers";

const ALL = ["BILLING", "KOT", "TABLES", "DELIVERY", "RESERVATIONS", "INVENTORY", "CUSTOMERS", "OFFERS", "ATTENDANCE", "REPORTS", "CANTEEN"];
const SQL = readFileSync(SQL_FILE, "utf8");
const today = () => zonedParts(new Date(), "Asia/Kolkata").date;
const mobile = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
const tag = () => Math.random().toString(36).slice(2, 8).toUpperCase();

/** Owner connection (migrations role): reads across tenants, used read-only except in the rolled-back mutation test. */
const ownerDb = new PrismaClient({ datasources: { db: { url: process.env.IT_DATABASE_URL! } } });

type Row = { check: string; violations: bigint };
async function runChecks(tx: Prisma.TransactionClient): Promise<Map<string, number>> {
  await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);
  await tx.$executeRawUnsafe(`SET LOCAL jit = off`);
  const rows = await tx.$queryRawUnsafe<Row[]>(SQL.replace(/;\s*$/, ""));
  return new Map(rows.map((r) => [r.check, Number(r.violations)]));
}
const readOnlyChecks = () =>
  ownerDb.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    return runChecks(tx);
  });
const nonZero = (m: Map<string, number>) => [...m].filter(([, n]) => n > 0);

let srv: Awaited<ReturnType<typeof startServer>>;
const hotels: { h: Hotel; owner: Client; manager: Client; cashier: Client; ctx: Record<string, string> }[] = [];

async function ok<T = any>(p: Promise<{ status: number; body: T }>, expected: number | number[] = [200, 201]): Promise<T> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const r = await p;
  const want = Array.isArray(expected) ? expected : [expected];
  if (!want.includes(r.status)) throw new Error(`expected ${want.join("/")} got ${r.status}: ${JSON.stringify(r.body).slice(0, 400)}`);
  return r.body;
}

/** One hotel's day of trading, through the API. Returns ids other tests use. */
async function trade(h: Hotel, owner: Client, manager: Client, cashier: Client) {
  const ctx: Record<string, string> = {};
  const outlet2 = await login(srv.base, h.users.owner.email, h.outlet2Id);

  // --- staff
  const waiter = await ok(owner.call("POST", "/staff", { name: "Waiter W", phone: mobile(), role: "WAITER", outletIds: [h.outletId, h.outlet2Id], password: "Masala-Dosa-2026" }));
  ctx.waiterId = waiter.id;

  // --- menu: tax rate, category, item with variants + add-ons
  const tax = await ok(owner.call("POST", "/tax-rates", { name: `GST 12 ${tag()}`, cgst: 6, sgst: 6 }));
  const cat = await ok(owner.call("POST", "/menu/categories", { name: `Mains ${tag()}` }));
  const dosa = await ok(
    owner.call("POST", "/menu/items", {
      name: "Masala Dosa", categoryId: cat.id, price: 9000, taxRateId: tax.id,
      variants: [{ name: "Regular", price: 9000 }, { name: "Ghee", price: 11000 }],
      addons: [{ name: "Extra chutney", price: 1000 }],
    }),
  );
  ctx.dosa = dosa.id;
  const variantId: string = dosa.variants[1].id;
  const addonId: string = dosa.addons[0].id;

  // --- inventory: items, recipe, vendor, purchase (received + paid), transfer, wastage, audit
  const rice = await ok(owner.call("POST", "/inventory/items", { name: `Rice ${tag()}`, unit: "KG", costPerUnit: 6000 }));
  const oil = await ok(owner.call("POST", "/inventory/items", { name: `Oil ${tag()}`, unit: "L", costPerUnit: 15000 }));
  ctx.rice = rice.id;
  await ok(owner.call("PUT", `/inventory/recipes/${dosa.id}`, { lines: [{ inventoryItemId: rice.id, quantity: 100, unit: "G" }] }));
  await ok(owner.call("PUT", `/inventory/recipes/${dosa.id}`, { variantId, lines: [{ inventoryItemId: rice.id, quantity: 120, unit: "G" }, { inventoryItemId: oil.id, quantity: 20, unit: "ML" }] }));
  const vendor = await ok(owner.call("POST", "/inventory/vendors", { name: `Vendor ${tag()}` }));
  const purchase = await ok(owner.call("POST", "/inventory/purchases", { vendorId: vendor.id, items: [{ inventoryItemId: rice.id, quantity: 25, unitCost: 5500 }, { inventoryItemId: oil.id, quantity: 10, unitCost: 14000 }] }));
  await ok(owner.call("POST", `/inventory/purchases/${purchase.id}/receive`));
  await ok(owner.call("POST", `/inventory/purchases/${purchase.id}/payments`, { amount: 50000, mode: "UPI", reference: "UTR1" }));
  const transfer = await ok(owner.call("POST", "/inventory/transfers", { toOutletId: h.outlet2Id, items: [{ inventoryItemId: rice.id, quantity: 2 }] }));
  if (transfer.status === "REQUESTED") await ok(owner.call("POST", `/inventory/transfers/${transfer.id}/approve`));
  await ok(owner.call("POST", `/inventory/transfers/${transfer.id}/dispatch`));
  await ok(outlet2.call("POST", `/inventory/transfers/${transfer.id}/receive`));
  await ok(owner.call("POST", "/inventory/wastage", { items: [{ inventoryItemId: oil.id, quantity: 200, unit: "ML", reason: "Spilt" }] }));
  const audit = await ok(owner.call("POST", "/inventory/audits", {}));
  await ok(owner.call("PUT", `/inventory/audits/${audit.id}/counts`, { counts: [{ inventoryItemId: rice.id, countedQty: 22 }] }));
  await ok(owner.call("POST", `/inventory/audits/${audit.id}/complete`));

  // --- CRM: customer with khata, offer, coupon
  const cust = await ok(owner.call("POST", "/customers", { phone: mobile(), name: "Ravi", khataLimit: 500000 }));
  ctx.customerId = cust.id;
  await ok(owner.call("POST", "/offers", { name: "Flat 10", type: "BILL_DISCOUNT", config: { discountType: "FLAT", value: 1000 } }));
  const coupon = await ok(owner.call("POST", "/offers/coupons", { code: `SAVE${tag()}`, discountType: "PERCENT", value: 10 }));

  // --- cash shift
  await ok(cashier.call("POST", "/cash-shifts/open", { openingFloat: 50000 }));
  await ok(cashier.call("POST", "/cash-shifts/current/movements", { type: "PAY_OUT", amount: 2000, reason: "milk vendor" }));

  // --- counter bills
  const bill = (body: object) => ok(cashier.call("POST", "/orders", { orderType: "TAKEAWAY", ...body }), 201);
  const pay = (id: string, payments: object[]) => ok(cashier.call("POST", `/orders/${id}/payments`, { payments }));
  const b1 = await bill({ items: [{ menuItemId: dosa.id, variantId, addonIds: [addonId], quantity: 2 }, { menuItemId: h.items.chai, quantity: 3 }], customerId: cust.id, couponCode: coupon.code });
  await pay(b1.id, [{ mode: "CASH", amount: b1.grandTotal - 5000 }, { mode: "UPI", amount: 5000 }]);
  ctx.orderId = b1.id;
  const b2 = await bill({ items: [{ menuItemId: h.items.samosa, quantity: 4 }], customerId: cust.id, customerPhone: cust.phone, customerName: cust.name });
  await pay(b2.id, [{ mode: "KHATA", amount: b2.grandTotal }]);
  await ok(owner.call("POST", `/customers/${cust.id}/khata/settle`, { amount: 1000, mode: "CASH" }));
  const b3 = await bill({ items: [{ menuItemId: h.items.biryani, quantity: 1 }] });
  await pay(b3.id, [{ mode: "CARD", amount: b3.grandTotal, cardLast4: "4242", authCode: "A1" }]);
  const refundLine = (b3.items as { id: string }[])[0]!.id;
  await ok(manager.call("POST", `/orders/${b3.id}/refunds`, { reason: "QUALITY", refundMode: "CASH", items: [{ orderItemId: refundLine, quantity: 1 }], restock: true }), 201);
  const b4 = await bill({ items: [{ menuItemId: h.items.chai, quantity: 1 }] });
  await ok(manager.call("POST", `/orders/${b4.id}/cancel`, { reason: "Customer walked out" }));
  const card = await ok(cashier.call("POST", "/gift-cards", { value: 50000, soldMode: "CASH" }), 201);
  ctx.giftCardId = card.id;
  const b5 = await bill({ items: [{ menuItemId: dosa.id, quantity: 1 }] });
  await pay(b5.id, [{ mode: "GIFT_CARD", amount: b5.grandTotal, giftCardCode: card.code }]);

  // --- tables: area, tables, running tab with two rounds, transfer, merge, bill
  const area = await ok(owner.call("POST", "/tables/areas", { name: `Hall ${tag()}` }));
  const [t1, t2, t3] = await Promise.all(["T1", "T2", "T3"].map((label) => ok(owner.call("POST", "/tables", { label: `${label}-${tag()}`, capacity: 4, areaId: area.id }))));
  ctx.tableId = t1.id;
  const s1 = await ok(cashier.call("POST", `/tables/${t1.id}/open`, { guests: 2, waiterId: waiter.id }), 201);
  await ok(cashier.call("POST", `/tables/sessions/${s1.id}/items`, { items: [{ menuItemId: dosa.id, variantId, addonIds: [addonId], quantity: 1 }] }));
  await ok(cashier.call("POST", `/tables/sessions/${s1.id}/items`, { items: [{ menuItemId: h.items.chai, quantity: 2 }] }));
  await ok(cashier.call("POST", `/tables/sessions/${s1.id}/transfer`, { toTableId: t2.id }));
  const s3 = await ok(cashier.call("POST", `/tables/${t3.id}/open`, { guests: 1 }), 201);
  await ok(cashier.call("POST", `/tables/sessions/${s3.id}/items`, { items: [{ menuItemId: h.items.samosa, quantity: 1 }] }));
  await ok(cashier.call("POST", `/tables/sessions/${s1.id}/merge`, { tableIds: [t3.id] }));
  const tabBill = await ok(cashier.call("POST", `/tables/sessions/${s1.id}/bill`, {}));
  const tabOrder = tabBill.orders[0].order;
  await pay(tabOrder.id, [{ mode: "UPI", amount: tabOrder.grandTotal }]);
  ctx.tabOrderId = tabOrder.id;
  const kot = await db.kotTicket.findFirstOrThrow({ where: { outletId: h.outletId, status: "RECEIVED" } });
  await ok(owner.call("PATCH", `/kot/${kot.id}`, { status: "PREPARING" }));

  // --- reservation, seated at t1
  const at = new Date(Date.now() + 3600_000).toISOString();
  const resv = await ok(owner.call("POST", "/reservations", { customerName: "Asha", customerPhone: mobile(), partySize: 2, reservedFor: at, preOrderItems: [{ menuItemId: h.items.chai, quantity: 2, addonIds: [] }] }), 201);
  await ok(owner.call("POST", `/reservations/${resv.id}/seat`, { tableId: t1.id }));

  // --- delivery: zone, order, assign partner
  await ok(owner.call("POST", "/delivery/zones", { name: "Near", radiusKm: 5, fee: 3000, minOrder: 0 }), 201);
  const del = await ok(
    cashier.call("POST", "/orders", { orderType: "DELIVERY", customerName: "Door", customerPhone: mobile(), items: [{ menuItemId: h.items.biryani, quantity: 2 }], delivery: { address: "12 Anna Salai, Chennai", latitude: 13.01, longitude: 80.2 } }),
    201,
  );
  const delivery = await db.delivery.findUniqueOrThrow({ where: { orderId: del.id } });
  // partner on duty (fixture: clock-in itself needs GPS + PIN, covered by the attendance suites)
  await db.staffAttendance.create({ data: { userId: h.users.delivery.id, outletId: h.outletId, workDate: today(), clockInAt: new Date(), clockInDistance: 0, status: "PRESENT" } });
  await ok(cashier.call("PATCH", `/delivery/${delivery.id}/assign`, { agentId: h.users.delivery.id }));

  // --- canteen: account + rule, member (wallet, tokens), slot, pre-order, subscription
  const account = await ok(owner.call("POST", "/canteen/accounts", { name: `Corp ${tag()}` }), 201);
  await ok(owner.call("POST", `/canteen/accounts/${account.id}/rules`, { type: "PERCENT", value: 50 }), 201);
  const member = await ok(owner.call("POST", "/canteen/members", { name: "Emp One", phone: mobile(), corporateAccountId: account.id, cardUid: `C${tag()}` }), 201);
  await ok(owner.call("POST", `/canteen/members/${member.id}/topup`, { amount: 20000, mode: "UPI" }));
  await ok(owner.call("POST", `/canteen/members/${member.id}/tokens`, { count: 3, unitPrice: 1000, mode: "CASH" }));
  const slot = (await ok(manager.call("POST", "/canteen/slots", { name: "All day", startTime: "00:00", endTime: "23:59", preorderCutoff: "23:59" }), 201)).slot;
  await ok(cashier.call("POST", "/canteen/preorders", { date: addDays(today(), 1), slotId: slot.id, items: [{ menuItemId: h.items.chai, quantity: 1 }], customerId: member.id }), 201);
  await ok(
    manager.call("POST", "/canteen/subscriptions", { customerId: member.id, slotId: slot.id, menuItemId: h.items.chai, daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startDate: addDays(today(), 1), endDate: addDays(today(), 3), paymentMode: "CASH" }),
    201,
  );
  const wb = await bill({ items: [{ menuItemId: h.items.chai, quantity: 1 }], customerId: member.id, customerPhone: member.phone });
  await pay(wb.id, [{ mode: "WALLET", amount: wb.grandTotal }]);

  // --- close the drawer
  await ok(cashier.call("POST", "/cash-shifts/current/close", { countedCash: 0 }));
  return ctx;
}

beforeAll(async () => {
  srv = await startServer();
  for (const name of ["DB Integrity A", "DB Integrity B", "DB Integrity C"]) {
    const h = await createHotel(name, { modules: ALL, gst: true });
    await db.business.update({ where: { id: h.businessId }, data: { features: { GIFT_CARDS: true } } });
    const owner = await login(srv.base, h.users.owner.email, h.outletId);
    const manager = await login(srv.base, h.users.manager.email, h.outletId);
    const cashier = await login(srv.base, h.users.cashier.email, h.outletId);
    hotels.push({ h, owner, manager, cashier, ctx: {} });
  }
  // Platform staff sign in too: their sessions / audit rows have no business and must not be flagged.
  const admin = await login(srv.base, (await createPlatformAdmin()).email);
  await ok(admin.call("GET", "/platform/businesses"));
  // Hotels trade at the same time, like production.
  const ctxs = await Promise.all(hotels.map((x) => trade(x.h, x.owner, x.manager, x.cashier)));
  ctxs.forEach((c, i) => (hotels[i]!.ctx = c));
}, 300_000);
afterAll(async () => {
  await srv.close();
  await ownerDb.$disconnect();
});

describe("tenant integrity SQL (docs/qa/sql/tenant-integrity.sql)", () => {
  it("is up to date with the migrated catalog (regenerate with scripts/tenant-integrity.ts)", async () => {
    const fresh = await generateFrom((s) => ownerDb.$queryRawUnsafe(s));
    expect(fresh).toBe(SQL);
    expect(SQL).toMatch(/Tables without an owner path \(not checked\): none/);
    expect(SQL).toMatch(/\*Id columns with no known target \(not checked\): none/);
  });

  it("the workload wrote rows in every area it drives", async () => {
    const ids = hotels.map((x) => x.h.outletId);
    const counts = {
      orders: await db.order.count({ where: { outletId: { in: ids } } }),
      kots: await db.kotTicket.count({ where: { outletId: { in: ids } } }),
      creditNotes: await db.creditNote.count({ where: { outletId: { in: ids } } }),
      transfers: await db.stockTransfer.count({ where: { fromOutletId: { in: ids } } }),
      walletTxns: await db.walletTxn.count({ where: { customer: { businessId: { in: hotels.map((x) => x.h.businessId) } } } }),
      giftCardTxns: await db.giftCardTxn.count({ where: { giftCard: { businessId: { in: hotels.map((x) => x.h.businessId) } } } }),
      deliveries: await db.delivery.count({ where: { outletId: { in: ids } } }),
      mergedSessions: await db.tableSession.count({ where: { outletId: { in: ids }, NOT: { mergedTableIds: { isEmpty: true } } } }),
    };
    for (const [k, n] of Object.entries(counts)) expect(n, k).toBeGreaterThanOrEqual(3);
  });

  it("every check returns 0 rows after the multi-hotel workload", async () => {
    const result = await readOnlyChecks();
    expect(result.size).toBeGreaterThan(300);
    expect(nonZero(result)).toEqual([]);
  });

  it("the checks fire on planted cross-tenant links (mutation test, rolled back)", async () => {
    const [A, B] = hotels;
    const ROLLBACK = new Error("rollback");
    let fired: Map<string, number> | undefined;
    await ownerDb
      .$transaction(async (tx) => {
        const aItem = await tx.orderItem.findFirstOrThrow({ where: { orderId: A!.ctx.orderId } });
        await tx.orderItem.update({ where: { id: aItem.id }, data: { menuItemId: B!.ctx.dosa } });
        await tx.kotTicket.updateMany({ where: { orderId: A!.ctx.tabOrderId }, data: { outletId: A!.h.outlet2Id } });
        await tx.kotTicket.updateMany({ where: { session: { orders: { some: { id: A!.ctx.tabOrderId } } } }, data: { outletId: A!.h.outlet2Id } });
        await tx.userOutlet.create({ data: { userId: A!.h.users.cashier.id, outletId: B!.h.outletId } });
        await tx.payment.updateMany({ where: { orderId: A!.ctx.orderId }, data: { giftCardId: B!.ctx.giftCardId } });
        await tx.recipe.updateMany({ where: { menuItemId: A!.ctx.dosa }, data: { inventoryItemId: B!.ctx.rice } });
        await tx.stockTransfer.updateMany({ where: { fromOutletId: A!.h.outletId }, data: { toOutletId: B!.h.outletId } });
        await tx.walletTxn.updateMany({ where: { customer: { businessId: A!.h.businessId } }, data: { outletId: "cl_missing_outlet" } });
        await tx.order.update({ where: { id: A!.ctx.orderId }, data: { customerId: B!.ctx.customerId } });
        fired = await runChecks(tx);
        throw ROLLBACK;
      })
      .catch((e) => {
        if (e !== ROLLBACK) throw e;
      });
    const hit = Object.fromEntries(nonZero(fired!));
    for (const name of [
      "cross-business:OrderItem.menuItemId->MenuItem",
      "cross-business:UserOutlet.userId->User",
      "cross-business:Payment.giftCardId->GiftCard",
      "cross-business:Recipe.inventoryItemId->InventoryItem",
      "cross-business:StockTransfer.toOutletId->Outlet",
      "orphan:WalletTxn.outletId->Outlet",
      "cross-business:Order.customerId->Customer",
    ]) {
      expect(hit[name], `${name} should fire; fired: ${JSON.stringify(hit)}`).toBeGreaterThan(0);
    }
    expect(Object.keys(hit).some((k) => k.startsWith("cross-outlet:KotTicket."))).toBe(true);
    // and nothing was left behind
    expect(nonZero(await readOnlyChecks())).toEqual([]);
  });
});

describe("Phase 7 constraints", () => {
  const sqlState = async (p: Promise<unknown>) => {
    try {
      await p;
      return "ok";
    } catch (e) {
      return /23514|violates check constraint/.test(String(e)) ? "23514" : /P2002|23505|Unique constraint/.test(String(e)) ? "23505" : String(e);
    }
  };

  it("a wallet, gift card, points or coupon count can't go below zero, whatever the writer", async () => {
    const { h, ctx } = hotels[0]!;
    expect(await sqlState(db.customer.update({ where: { id: ctx.customerId }, data: { walletBalance: -1 } }))).toBe("23514");
    expect(await sqlState(db.customer.update({ where: { id: ctx.customerId }, data: { points: -5 } }))).toBe("23514");
    expect(await sqlState(db.giftCard.update({ where: { id: ctx.giftCardId }, data: { balance: -100 } }))).toBe("23514");
    expect(await sqlState(db.coupon.updateMany({ where: { businessId: h.businessId }, data: { usedCount: -1 } }))).toBe("23514");
  });

  it("bills: no negative money, no zero quantity, no refund beyond the bill", async () => {
    const { ctx } = hotels[0]!;
    const o = await db.order.findUniqueOrThrow({ where: { id: ctx.orderId }, include: { items: true } });
    expect(await sqlState(db.order.update({ where: { id: o.id }, data: { refundedAmount: o.grandTotal + 1 } }))).toBe("23514");
    expect(await sqlState(db.order.update({ where: { id: o.id }, data: { grandTotal: -1, refundedAmount: 0 } }))).toBe("23514");
    expect(await sqlState(db.orderItem.update({ where: { id: o.items[0]!.id }, data: { quantity: 0 } }))).toBe("23514");
    expect(await sqlState(db.payment.updateMany({ where: { orderId: o.id }, data: { amount: -100 } }))).toBe("23514");
    expect(await sqlState(db.order.update({ where: { id: o.id }, data: { roundOff: -49 } }))).toBe("ok"); // round-off is signed
    // Put it back: the reconciliation checks other test/db files run afterwards (A06) would see a broken bill.
    await db.order.update({ where: { id: o.id }, data: { roundOff: o.roundOff } });
  });

  it("one open running tab per table", async () => {
    const { h, ctx } = hotels[1]!;
    const open = await db.tableSession.findFirst({ where: { tableId: ctx.tableId, status: "OPEN" } });
    const tableId = open ? ctx.tableId : (await db.diningTable.create({ data: { outletId: h.outletId, label: `X-${tag()}` } })).id;
    if (!open) await db.tableSession.create({ data: { outletId: h.outletId, tableId, mergedTableIds: [] } });
    expect(await sqlState(db.tableSession.create({ data: { outletId: h.outletId, tableId, mergedTableIds: [] } }))).toBe("23505");
  });

  it("a CHECK violation reaching the API is a 409, not a 500", async () => {
    const { errorHandler } = await import("../../src/lib/http");
    let status = 0;
    const res = { status: (s: number) => ((status = s), { json: () => undefined }) } as never;
    errorHandler(new Error('new row for relation "Customer" violates check constraint "Customer_balances_check" (23514)'), { id: "t", method: "PATCH", originalUrl: "/x" } as never, res, () => undefined);
    expect(status).toBe(409);
  });
});
