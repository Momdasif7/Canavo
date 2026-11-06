/**
 * QA Phase 7 (dbb) — reports over a busy outlet's long range. PostgreSQL caps one statement at
 * 32,767 bind values; Prisma loads relations / `in` lists as `IN ($1 … $n)`, so a report that
 * passes one id per bill broke (500) once a range held more bills than that (a year of a
 * ~90 bills/day outlet). Found on the 300k-order perf dataset (docs/qa/phase-7/dbb.md).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotel, db, login, startServer, type Client, type Hotel } from "../integration/helpers";

const BILLS = 33_000; // > 32,767
let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel;
let owner: Client;
let memberId: string;
const ymd = (d: Date) => d.toISOString().slice(0, 10);
const from = ymd(new Date(Date.now() - 20 * 86_400_000));
const to = ymd(new Date(Date.now() + 86_400_000));

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("BigRange", {
    modules: ["BILLING", "KOT", "TABLES", "DELIVERY", "RESERVATIONS", "INVENTORY", "CUSTOMERS", "OFFERS", "ATTENDANCE", "REPORTS", "CANTEEN"],
  });
  owner = await login(srv.base, h.users.owner.email, h.outletId);
  const member = await db.customer.create({ data: { businessId: h.businessId, phone: "9811100000", name: "Canteen Member", canteenMember: true } });
  memberId = member.id;
  const tag = h.outletId;
  // 33,000 paid bills over the last ~15 days, each with one line and one successful cash payment.
  await db.$executeRawUnsafe(`
    INSERT INTO "Order"(id, "outletId", "cashierId", "invoiceNumber", "documentType", "orderType", status, subtotal, discount,
      "taxableValue", "serviceCharge", cgst, sgst, igst, "roundOff", "grandTotal", "taxBreakup", "createdAt", "updatedAt", "paidAt", "customerId")
    SELECT '${tag}-o' || g, '${h.outletId}', '${h.users.cashier.id}', 'BIG-' || g, 'BILL', 'TAKEAWAY', 'PAID', 1000, 0, 1000, 0, 0, 0, 0, 0, 1000,
      '[]'::jsonb, now() - (g % 15 || ' days')::interval, now(), now(), '${memberId}'
    FROM generate_series(1, ${BILLS}) g`);
  await db.$executeRawUnsafe(`
    INSERT INTO "OrderItem"(id, "orderId", "menuItemId", name, quantity, "unitPrice", "gstRate", "hsnCode", discount, "taxableValue",
      "serviceCharge", cgst, sgst, igst, total)
    SELECT '${tag}-i' || g, '${tag}-o' || g, '${h.items.chai}', 'Chai', 1, 1000, 0, '996331', 0, 1000, 0, 0, 0, 0, 1000
    FROM generate_series(1, ${BILLS}) g`);
  await db.$executeRawUnsafe(`
    INSERT INTO "Payment"(id, "orderId", mode, amount, status, "createdAt")
    SELECT '${tag}-p' || g, '${tag}-o' || g, 'CASH', 1000, 'SUCCESS', now() FROM generate_series(1, ${BILLS}) g`);
}, 180_000);
afterAll(() => srv.close());

describe(`reports over a range holding ${BILLS.toLocaleString("en-IN")} bills`, () => {
  it("sales report: 200 with every bill and its cash", async () => {
    const r = await owner.call("GET", `/reports/sales?from=${from}&to=${to}`);
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    expect(r.body.totals.orders).toBe(BILLS);
    const cash = r.body.byPaymentMode.find((m: { mode: string }) => m.mode === "CASH");
    expect(cash).toMatchObject({ count: BILLS, amount: BILLS * 1000 });
  });

  it("customers report: 200, the member's bills counted", async () => {
    const r = await owner.call("GET", `/reports/customers?from=${from}&to=${to}`);
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    expect(r.body.topCustomers[0]).toMatchObject({ customerId: memberId, orders: BILLS, spend: BILLS * 1000 });
  });

  it("canteen report: 200, every meal counted", async () => {
    const r = await owner.call("GET", `/reports/canteen?from=${from}&to=${to}`);
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    expect(r.body.totals).toMatchObject({ meals: BILLS, gross: BILLS * 1000 });
  });

  it("bills summary: 200 with the cash total", async () => {
    const r = await owner.call("GET", `/orders/summary?from=${from}&to=${to}`);
    expect(r.status).toBe(200);
    expect(r.body.byMode.CASH).toEqual({ amount: BILLS * 1000, count: BILLS });
  });

  it("customer detail: last 10 bills with their item counts (no whole-table item count)", async () => {
    const r = await owner.call("GET", `/customers/${memberId}`);
    expect(r.status, JSON.stringify(r.body).slice(0, 300)).toBe(200);
    expect(r.body.recentOrders).toHaveLength(10);
    for (const o of r.body.recentOrders) expect(o._count).toEqual({ items: 1 });
  });
});
