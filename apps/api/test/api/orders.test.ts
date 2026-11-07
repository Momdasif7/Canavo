/**
 * QA Phase 6 — /orders API: create (server-side pricing, clientOrderId idempotency, validation,
 * mass assignment), bill list filters / IST date ranges / pagination, payments (split, khata limit,
 * gift cards, double collection), cancel, refunds / credit notes, approvals with PIN, receipts, UPI QR,
 * offline sync. Business-logic abuse: tampered totals, double cancel, cancel after refund, refund
 * more than paid, paying a cancelled bill, concurrent double payment / cancel / refund.
 */
import bcrypt from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "../integration/helpers";
import { assertIntegerMoney, assertNoSecrets, db, LONG, makeWorld, roleMatrix, setFeatures, SQLI, UNICODE_NAME, XSS, type Client, type World } from "./service-fixtures";

let srv: Awaited<ReturnType<typeof startServer>>;
let w: World;
let cashier: Client, manager: Client, owner: Client;

beforeAll(async () => {
  srv = await startServer();
  w = await makeWorld(srv.base, "Orders API", { gst: true });
  ({ cashier, manager, owner } = w.as);
  await db.user.update({ where: { id: w.h.users.manager.id }, data: { pinHash: await bcrypt.hash("2468", 4) } });
});
afterAll(() => srv.close());

const item = (menuItemId: string, quantity = 1) => ({ menuItemId, quantity });
const newBill = async (c: Client = cashier, extra: Record<string, unknown> = {}) => {
  const r = await c.call("POST", "/orders", { orderType: "TAKEAWAY", items: [item(w.h.items.biryani)], ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; grandTotal: number; invoiceNumber: string; items: { id: string; quantity: number }[] };
};
const pay = (c: Client, id: string, payments: object[], extra: object = {}) => c.call("POST", `/orders/${id}/payments`, { payments, ...extra });
const paidBill = async (extra: Record<string, unknown> = {}) => {
  const o = await newBill(cashier, extra);
  expect((await pay(cashier, o.id, [{ mode: "CASH", amount: o.grandTotal }])).status).toBe(200);
  return o;
};
const orderCount = () => db.order.count({ where: { outletId: w.h.outletId } });

// =====================================================================
describe("POST /orders — contract, pricing and mass assignment", () => {
  it("201 with server-computed integer money, no secrets", async () => {
    const r = await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [item(w.h.items.biryani, 2), item(w.h.items.chai, 3)] });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ id: expect.any(String), invoiceNumber: expect.any(String), status: "OPEN", outletId: w.h.outletId, cashierId: w.h.users.cashier.id });
    expect(r.body.subtotal).toBe(2 * 16000 + 3 * 1500);
    expect(Number.isInteger(r.body.grandTotal)).toBe(true);
    assertIntegerMoney(r.body);
    assertNoSecrets(r.body);
  });

  it("client-sent totals, prices, status, outlet, cashier and channel are ignored", async () => {
    const r = await cashier.call("POST", "/orders", {
      orderType: "TAKEAWAY",
      items: [{ ...item(w.h.items.biryani), unitPrice: 1, price: 1, total: 1, taxableValue: 1, gstRate: 0 }],
      grandTotal: 1, subtotal: 1, total: 1, roundOff: -99999, status: "PAID", paidAt: new Date().toISOString(),
      outletId: w.h.outlet2Id, businessId: w.other.businessId, cashierId: w.h.users.owner.id, channel: "ZOMATO", refundedAmount: 5,
      invoiceNumber: "HACK-0001", documentType: "BILL",
    });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ status: "OPEN", outletId: w.h.outletId, cashierId: w.h.users.cashier.id, channel: "POS", refundedAmount: 0 });
    expect(r.body.subtotal).toBe(16000);
    expect(r.body.grandTotal).toBeGreaterThanOrEqual(16000);
    expect(r.body.items[0].unitPrice).toBe(16000);
    expect(r.body.invoiceNumber).not.toBe("HACK-0001");
    expect(r.body.paidAt).toBeNull();
  });

  it("a FLAT discount larger than the bill never makes the total negative", async () => {
    const r = await manager.call("POST", "/orders", { orderType: "TAKEAWAY", items: [item(w.h.items.chai)], discount: { type: "FLAT", value: 9_999_999 } });
    if (r.status === 201) expect(r.body.grandTotal).toBeGreaterThanOrEqual(0);
    else expect(r.status).toBe(400);
    const line = await manager.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ ...item(w.h.items.chai), discount: 999_999 }] });
    if (line.status === 201) {
      expect(line.body.grandTotal).toBeGreaterThanOrEqual(0);
      for (const i of line.body.items) expect(i.total).toBeGreaterThanOrEqual(0);
    } else expect(line.status).toBe(400);
  });

  const invalid: [string, unknown][] = [
    ["no body", undefined],
    ["empty object", {}],
    ["no items", { orderType: "TAKEAWAY" }],
    ["empty items", { orderType: "TAKEAWAY", items: [] }],
    ["bad orderType", { orderType: "FREE", items: [{ menuItemId: "x", quantity: 1 }] }],
    ["null items", { orderType: "TAKEAWAY", items: null }],
    ["items not array", { orderType: "TAKEAWAY", items: "biryani" }],
    ["quantity 0", { orderType: "TAKEAWAY", items: [{ menuItemId: "M", quantity: 0 }] }],
    ["quantity negative", { orderType: "TAKEAWAY", items: [{ menuItemId: "M", quantity: -2 }] }],
    ["quantity float", { orderType: "TAKEAWAY", items: [{ menuItemId: "M", quantity: 1.5 }] }],
    ["quantity string", { orderType: "TAKEAWAY", items: [{ menuItemId: "M", quantity: "2" }] }],
    ["quantity huge", { orderType: "TAKEAWAY", items: [{ menuItemId: "M", quantity: 1e12 }] }],
    ["quantity null", { orderType: "TAKEAWAY", items: [{ menuItemId: "M", quantity: null }] }],
    ["line discount negative", { orderType: "TAKEAWAY", items: [{ menuItemId: "M", quantity: 1, discount: -500 }] }],
    ["line discount float", { orderType: "TAKEAWAY", items: [{ menuItemId: "M", quantity: 1, discount: 1.5 }] }],
    ["percent discount > 100", { orderType: "TAKEAWAY", items: [{ menuItemId: "M", quantity: 1 }], discount: { type: "PERCENT", value: 101 } }],
    ["flat discount negative", { orderType: "TAKEAWAY", items: [{ menuItemId: "M", quantity: 1 }], discount: { type: "FLAT", value: -100 } }],
    ["notes 10k", { orderType: "TAKEAWAY", items: [{ menuItemId: "M", quantity: 1 }], notes: LONG }],
    ["customerName 10k", { orderType: "TAKEAWAY", items: [{ menuItemId: "M", quantity: 1 }], customerName: LONG }],
    ["bad phone", { orderType: "TAKEAWAY", items: [{ menuItemId: "M", quantity: 1 }], customerPhone: "12345" }],
    ["clientOrderId not uuid", { orderType: "TAKEAWAY", items: [{ menuItemId: "M", quantity: 1 }], clientOrderId: "abc" }],
    ["createdAt not a date", { orderType: "TAKEAWAY", items: [{ menuItemId: "M", quantity: 1 }], createdAt: "yesterday" }],
    ["unknown menu item", { orderType: "TAKEAWAY", items: [{ menuItemId: "cl0000000000000000000000", quantity: 1 }] }],
    ["redeemPoints negative", { orderType: "TAKEAWAY", items: [{ menuItemId: "M", quantity: 1 }], redeemPoints: -5 }],
  ];
  it.each(invalid)("400 and nothing written: %s", async (_name, body) => {
    const before = await orderCount();
    const b = body && typeof body === "object" ? JSON.parse(JSON.stringify(body).replaceAll('"M"', JSON.stringify(w.h.items.chai))) : body;
    const r = await cashier.call("POST", "/orders", b);
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.error).toEqual(expect.any(String));
    expect(await orderCount()).toBe(before);
  });

  it("malformed JSON → 400, not 500", async () => {
    const r = await fetch(`${srv.base}/orders`, { method: "POST", headers: { authorization: `Bearer ${cashier.token}`, "x-outlet-id": w.h.outletId, "content-type": "application/json" }, body: "{bad json" });
    expect(r.status).toBe(400);
  });

  it("a menu item of another hotel can't be billed (400)", async () => {
    const r = await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [item(w.other.items.biryani)] });
    expect(r.status).toBe(400);
  });

  it("unicode / Tamil / Hindi / emoji names round-trip; SQL and HTML are stored as inert text", async () => {
    const r = await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ ...item(w.h.items.chai), notes: XSS }], customerName: UNICODE_NAME, notes: SQLI });
    expect(r.status).toBe(201);
    const got = (await cashier.call("GET", `/orders/${r.body.id}`)).body;
    expect(got.customerName).toBe(UNICODE_NAME);
    expect(got.notes).toBe(SQLI);
    expect(got.items[0].notes).toBe(XSS);
    expect(await db.order.count()).toBeGreaterThan(0);
  });

  it("roles: owner, manager, cashier, waiter create; everyone else 403", async () => {
    const bad = await roleMatrix(w, ["owner", "manager", "cashier", "waiter"], (c) => c.call("POST", "/orders", { orderType: "TAKEAWAY", items: [item(w.h.items.chai)] }), 201);
    expect(bad).toEqual([]);
  });

  it("super admin, manager on an unassigned outlet and a foreign outlet header are refused", async () => {
    const body = { orderType: "TAKEAWAY", items: [item(w.h.items.chai)] };
    expect((await w.admin.call("POST", "/orders", body)).status).toBe(403);
    expect((await w.managerOutlet2.call("POST", "/orders", body)).status).toBe(403);
    expect((await w.otherOwner.call("POST", "/orders", body, { "x-outlet-id": w.h.outletId })).status).toBe(403);
  });

  it("BILLING module off → 403", async () => {
    const off = await makeWorldLite(["INVENTORY"]);
    expect((await off.call("POST", "/orders", { orderType: "TAKEAWAY", items: [item(w.h.items.chai)] })).status).toBe(403);
    expect((await off.call("GET", "/orders")).status).toBe(403);
  });
});

async function makeWorldLite(modules: string[]) {
  const { createHotel, login } = await import("../integration/helpers");
  const h = await createHotel("No billing", { modules });
  return login(srv.base, h.users.owner.email, h.outletId);
}

// =====================================================================
describe("POST /orders — clientOrderId idempotency", () => {
  it("same clientOrderId twice → one bill, 201 then 200 with the same body", async () => {
    const clientOrderId = crypto.randomUUID();
    const body = { orderType: "TAKEAWAY", items: [item(w.h.items.samosa, 2)], clientOrderId };
    const a = await cashier.call("POST", "/orders", body);
    const b = await cashier.call("POST", "/orders", body);
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(b.body.id).toBe(a.body.id);
    expect(b.body.invoiceNumber).toBe(a.body.invoiceNumber);
    expect(await db.order.count({ where: { clientOrderId } })).toBe(1);
  });

  it("a retry with a different (tampered) body still returns the original bill", async () => {
    const clientOrderId = crypto.randomUUID();
    const a = await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [item(w.h.items.samosa)], clientOrderId });
    const b = await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [item(w.h.items.biryani, 9)], clientOrderId });
    expect(b.status).toBe(200);
    expect(b.body.grandTotal).toBe(a.body.grandTotal);
  });

  it("double submit at the same moment → exactly one bill, no 500", async () => {
    const clientOrderId = crypto.randomUUID();
    const body = { orderType: "TAKEAWAY", items: [item(w.h.items.chai)], clientOrderId };
    const rs = await Promise.all(Array.from({ length: 4 }, () => cashier.call("POST", "/orders", body)));
    expect(rs.map((r) => r.status).every((s) => s === 200 || s === 201 || s === 409)).toBe(true);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await db.order.count({ where: { clientOrderId } })).toBe(1);
  });

  it("the same clientOrderId at another outlet is refused; at another hotel it never leaks the bill", async () => {
    const clientOrderId = crypto.randomUUID();
    const a = await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [item(w.h.items.chai)], clientOrderId });
    expect(a.status).toBe(201);
    const o2 = await owner.call("POST", "/orders", { orderType: "TAKEAWAY", items: [item(w.h.items.chai)], clientOrderId }, { "x-outlet-id": w.h.outlet2Id });
    expect(o2.status).toBe(400);
    const x = await w.otherOwner.call("POST", "/orders", { orderType: "TAKEAWAY", items: [item(w.other.items.chai)], clientOrderId });
    expect([400, 409]).toContain(x.status);
    expect(JSON.stringify(x.body)).not.toContain(a.body.id);
    expect(JSON.stringify(x.body)).not.toContain(a.body.invoiceNumber);
  });
});

// =====================================================================
describe("GET /orders/:id and tenant isolation", () => {
  it("200 with balance; 404 for unknown / other outlet / other hotel ids", async () => {
    const o = await newBill();
    const r = await cashier.call("GET", `/orders/${o.id}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: o.id, amountPaid: 0, balance: o.grandTotal });
    assertNoSecrets(r.body);
    expect((await cashier.call("GET", "/orders/cl0000000000000000000000")).status).toBe(404);
    expect((await owner.call("GET", `/orders/${o.id}`, undefined, { "x-outlet-id": w.h.outlet2Id })).status).toBe(404);
    expect((await w.otherOwner.call("GET", `/orders/${o.id}`)).status).toBe(404);
    for (const path of ["receipt", "receipt.pdf", "payment-status", "credit-notes"]) {
      expect((await w.otherOwner.call("GET", `/orders/${o.id}/${path}`)).status, path).toBe(404);
    }
    for (const [path, body] of [["cancel", { reason: "steal it" }], ["payments", { payments: [{ mode: "CASH", amount: 100 }] }], ["refunds", { reason: "QUALITY", refundMode: "CASH", amount: 100 }], ["cod", {}], ["upi-qr", {}]] as const) {
      expect((await w.otherOwner.call("POST", `/orders/${o.id}/${path}`, body)).status, path).toBe(404);
    }
    expect((await db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("OPEN");
  });

  it("view roles: order:view → owner, manager, cashier, accountant, auditor", async () => {
    const o = await newBill();
    expect(await roleMatrix(w, ["owner", "manager", "cashier", "accountant", "auditor"], (c) => c.call("GET", `/orders/${o.id}`), 200)).toEqual([]);
  });
});

// =====================================================================
describe("GET /orders, /orders/summary, /orders/export — filters, IST dates, pagination", () => {
  let early: string, late: string, cancelled: string;
  beforeAll(async () => {
    // 23:59:59.999 IST on 15 Jan and 00:00:00.000 IST on 16 Jan (IST = UTC+5:30)
    const a = await newBill(cashier, { customerName: "Boundary Early" });
    const b = await newBill(cashier, { customerName: "Boundary Late" });
    const c = await newBill(cashier, { customerName: "Boundary Cancel" });
    await db.order.update({ where: { id: a.id }, data: { createdAt: new Date("2026-01-15T18:29:59.999Z") } });
    await db.order.update({ where: { id: b.id }, data: { createdAt: new Date("2026-01-15T18:30:00.000Z") } });
    await db.order.update({ where: { id: c.id }, data: { createdAt: new Date("2026-01-14T06:00:00.000Z"), status: "CANCELLED", cancelledAt: new Date() } });
    [early, late, cancelled] = [a.id, b.id, c.id];
  });
  const ids = (r: { body: { id: string }[] }) => r.body.map((o) => o.id);

  it("IST day boundaries: 23:59:59.999 belongs to the 15th, 00:00 to the 16th", async () => {
    const d15 = await manager.call("GET", "/orders?date=2026-01-15");
    expect(d15.status).toBe(200);
    expect(ids(d15)).toContain(early);
    expect(ids(d15)).not.toContain(late);
    const d16 = await manager.call("GET", "/orders?date=2026-01-16");
    expect(ids(d16)).toEqual([late]);
    const range = await manager.call("GET", "/orders?from=2026-01-14&to=2026-01-16");
    expect(ids(range).sort()).toEqual([early, late, cancelled].sort());
  });

  it("an empty day → [] and zeroed summary", async () => {
    expect((await manager.call("GET", "/orders?date=2020-02-29")).body).toEqual([]);
    const s = (await manager.call("GET", "/orders/summary?date=2020-02-29")).body;
    expect(s).toMatchObject({ count: 0, billed: 0, paidCount: 0, cancelledCount: 0 });
  });

  it("status / orderType / search filters", async () => {
    const r = await manager.call("GET", "/orders?from=2026-01-14&to=2026-01-16&status=CANCELLED");
    expect(ids(r)).toEqual([cancelled]);
    const s = await manager.call("GET", `/orders?from=2026-01-14&to=2026-01-16&search=${encodeURIComponent("boundary late")}`);
    expect(ids(s)).toEqual([late]);
    expect((await manager.call("GET", `/orders?search=${encodeURIComponent(SQLI)}`)).body).toEqual([]);
  });

  it("summary counts cancelled bills apart and money is integer", async () => {
    const s = await manager.call("GET", "/orders/summary?from=2026-01-14&to=2026-01-16");
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ count: 3, openCount: 2, cancelledCount: 1 });
    assertIntegerMoney(s.body);
  });

  it("'to' alone is honoured (not silently ignored)", async () => {
    const r = await manager.call("GET", "/orders?to=2026-01-15&limit=200");
    expect(r.status).toBe(200);
    // Either a 400 ("from is required") or only bills on/before the 15th — never today's bills.
    expect(ids(r)).not.toContain(late);
  });

  it("pagination: limit/offset page through newest first; limit capped at 200", async () => {
    const p1 = await manager.call("GET", "/orders?limit=2&offset=0");
    const p2 = await manager.call("GET", "/orders?limit=2&offset=2");
    expect(p1.body).toHaveLength(2);
    expect(ids(p1).some((id) => ids(p2).includes(id))).toBe(false);
    expect(new Date(p1.body[1].createdAt).getTime()).toBeGreaterThanOrEqual(new Date(p2.body[0].createdAt).getTime());
    expect((await manager.call("GET", "/orders?offset=100000")).body).toEqual([]);
  });

  const badQueries = [
    "limit=0", "limit=201", "limit=-1", "limit=abc", "limit=1.5", "offset=-1", "offset=100001",
    "date=2026-13-45", "date=2026-02-30", "date=15-01-2026", "date=yesterday", "from=2026-01-16&to=2026-01-15",
    "from=2024-01-01&to=2026-01-01", "status=PAIDX", "paymentMode=BITCOIN", "orderType=X", "channel=X", `search=${"a".repeat(101)}`,
  ];
  it.each(badQueries)("GET /orders?%s → 400 (never 500)", async (q) => {
    const r = await manager.call("GET", `/orders?${q}`);
    expect(r.status, JSON.stringify(r.body)).toBe(400);
  });
  it.each(["date=2026-13-45", "from=2026-01-16&to=2026-01-15", "status=X"])("summary and export ?%s → 400", async (q) => {
    expect((await manager.call("GET", `/orders/summary?${q}`)).status).toBe(400);
    expect((await manager.call("GET", `/orders/export?${q}`)).status).toBe(400);
  });

  it("export streams an Excel file", async () => {
    const r = await fetch(`${srv.base}/orders/export?from=2026-01-14&to=2026-01-16`, { headers: { authorization: `Bearer ${manager.token}`, "x-outlet-id": w.h.outletId } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/spreadsheetml|octet-stream/);
    expect((await r.arrayBuffer()).byteLength).toBeGreaterThan(100);
  });

  it("bills:view roles for list / summary / export; others 403", async () => {
    const allowed = ["owner", "manager", "cashier", "accountant", "auditor"] as const;
    for (const p of ["/orders?limit=1", "/orders/summary", "/orders/export?date=2020-01-01"]) {
      expect(await roleMatrix(w, allowed, (c) => c.call("GET", p), 200), p).toEqual([]);
    }
  });

  it("another hotel's owner sees none of these bills", async () => {
    const r = await w.otherOwner.call("GET", "/orders?from=2026-01-14&to=2026-01-16");
    expect(r.body).toEqual([]);
  });
});

// =====================================================================
describe("POST /orders/:id/payments", () => {
  it("split payments: partial then the rest → PAID; integer money; change computed", async () => {
    const o = await newBill();
    const half = Math.floor(o.grandTotal / 2);
    const a = await pay(cashier, o.id, [{ mode: "UPI", amount: half }]);
    expect(a.status).toBe(200);
    expect(a.body).toMatchObject({ paid: false, balance: o.grandTotal - half });
    const b = await pay(cashier, o.id, [{ mode: "CASH", amount: o.grandTotal - half }], { tendered: o.grandTotal });
    expect(b.body).toMatchObject({ paid: true, balance: 0, change: half });
    assertIntegerMoney(b.body);
  });

  it("split payments that exceed the balance are refused as a whole (nothing recorded)", async () => {
    const o = await newBill();
    const r = await pay(cashier, o.id, [{ mode: "CASH", amount: o.grandTotal }, { mode: "UPI", amount: 1 }]);
    expect(r.status).toBe(400);
    expect(await db.payment.count({ where: { orderId: o.id } })).toBe(0);
  });

  const badPayments: [string, unknown][] = [
    ["no payments", {}],
    ["empty payments", { payments: [] }],
    ["zero amount", { payments: [{ mode: "CASH", amount: 0 }] }],
    ["negative amount", { payments: [{ mode: "CASH", amount: -100 }] }],
    ["float amount", { payments: [{ mode: "CASH", amount: 10.5 }] }],
    ["string amount", { payments: [{ mode: "CASH", amount: "100" }] }],
    ["unknown mode", { payments: [{ mode: "BITCOIN", amount: 100 }] }],
    ["negative tip", { payments: [{ mode: "CASH", amount: 100, tip: -1 }] }],
    ["tendered float", { payments: [{ mode: "CASH", amount: 100 }], tendered: 1.5 }],
    ["tendered short", { payments: [{ mode: "CASH", amount: 100 }], tendered: 50 }],
    ["corporate typed at counter", { payments: [{ mode: "CORPORATE", amount: 100 }] }],
    ["online on a POS bill", { payments: [{ mode: "ONLINE", amount: 100 }] }],
    ["khata without phone", { payments: [{ mode: "KHATA", amount: 100 }] }],
    ["gift card when off", { payments: [{ mode: "GIFT_CARD", amount: 100, giftCardCode: "GC-NOPE" }] }],
    ["wallet without canteen", { payments: [{ mode: "WALLET", amount: 100 }] }],
    ["overpay", { payments: [{ mode: "CASH", amount: 10_000_000 }] }],
  ];
  it.each(badPayments)("400 and nothing recorded: %s", async (_n, body) => {
    const o = await newBill();
    const r = await cashier.call("POST", `/orders/${o.id}/payments`, body);
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(await db.payment.count({ where: { orderId: o.id } })).toBe(0);
  });

  it("paying a paid bill → 409; paying a cancelled bill → 409", async () => {
    const o = await paidBill();
    expect((await pay(cashier, o.id, [{ mode: "CASH", amount: 1 }])).status).toBe(409);
    const c = await newBill();
    expect((await manager.call("POST", `/orders/${c.id}/cancel`, { reason: "customer left" })).status).toBe(200);
    expect((await pay(cashier, c.id, [{ mode: "CASH", amount: c.grandTotal }])).status).toBe(409);
    expect(await db.payment.count({ where: { orderId: c.id } })).toBe(0);
  });

  it("two tills collecting the full amount at the same moment → collected once (no overpayment)", async () => {
    const o = await newBill();
    const rs = await Promise.all([pay(cashier, o.id, [{ mode: "CASH", amount: o.grandTotal }]), pay(manager, o.id, [{ mode: "UPI", amount: o.grandTotal }])]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409].sort());
    const sum = await db.payment.aggregate({ where: { orderId: o.id, status: "SUCCESS" }, _sum: { amount: true } });
    expect(sum._sum.amount).toBe(o.grandTotal);
  });

  it("khata: needs a phone; the customer's khata limit is enforced", async () => {
    const phone = `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
    const o = await newBill(cashier, { customerPhone: phone, customerName: "Khata Kumar" });
    expect((await pay(cashier, o.id, [{ mode: "KHATA", amount: 1000 }])).status).toBe(200);
    const customer = await db.customer.findFirstOrThrow({ where: { phone } });
    expect(customer.khataBalance).toBe(1000);
    await db.customer.update({ where: { id: customer.id }, data: { khataLimit: 2000 } });
    const over = await pay(cashier, o.id, [{ mode: "KHATA", amount: 1001 }]);
    expect(over.status).toBe(400);
    expect(over.body.error).toMatch(/Khata limit/);
    expect((await pay(cashier, o.id, [{ mode: "KHATA", amount: 1000 }])).status).toBe(200);
    expect((await db.customer.findUniqueOrThrow({ where: { id: customer.id } })).khataBalance).toBe(2000);
  });

  it("payment:collect roles: owner, manager, cashier; others 403 (and nothing recorded)", async () => {
    const o = await newBill();
    const bad = await roleMatrix(w, ["owner", "manager", "cashier"], (c) => c.call("POST", `/orders/${o.id}/payments`, { payments: [{ mode: "UPI", amount: 1 }] }), 200);
    expect(bad).toEqual([]);
    expect(await db.payment.count({ where: { orderId: o.id } })).toBe(3);
  });
});

// =====================================================================
describe("gift cards on a bill", () => {
  beforeAll(() => setFeatures(w.h.businessId, { GIFT_CARDS: true }));
  afterAll(() => setFeatures(w.h.businessId, {}));

  it("over-redeem is refused; two bills racing for one card's full balance spend it once", async () => {
    const card = (await cashier.call("POST", "/gift-cards", { value: 16800, soldMode: "UPI" })).body;
    const o1 = await newBill();
    const big = await pay(cashier, o1.id, [{ mode: "GIFT_CARD", amount: card.balance + 1, giftCardCode: card.code }]);
    expect(big.status).toBe(400);
    const o2 = await newBill();
    const amt = Math.min(card.balance, o1.grandTotal, o2.grandTotal);
    const rs = await Promise.all([pay(cashier, o1.id, [{ mode: "GIFT_CARD", amount: amt, giftCardCode: card.code }]), pay(manager, o2.id, [{ mode: "GIFT_CARD", amount: amt, giftCardCode: card.code }])]);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    const after = await db.giftCard.findUniqueOrThrow({ where: { id: card.id } });
    expect(after.balance).toBe(card.balance - amt);
    expect(after.balance).toBeGreaterThanOrEqual(0);
  });

  it("an unknown / missing gift card code → 400/404, nothing recorded", async () => {
    const o = await newBill();
    expect((await pay(cashier, o.id, [{ mode: "GIFT_CARD", amount: 100 }])).status).toBe(400);
    expect([400, 404]).toContain((await pay(cashier, o.id, [{ mode: "GIFT_CARD", amount: 100, giftCardCode: "GC-DOES-NOT-EXIST" }])).status);
    expect(await db.payment.count({ where: { orderId: o.id } })).toBe(0);
  });

  it("a card cancelled twice at the same moment is credited back once", async () => {
    const card = (await cashier.call("POST", "/gift-cards", { value: 50000, soldMode: "CASH" })).body;
    const o = await newBill();
    expect((await pay(cashier, o.id, [{ mode: "GIFT_CARD", amount: o.grandTotal, giftCardCode: card.code }])).status).toBe(200);
    const rs = await Promise.all([manager.call("POST", `/orders/${o.id}/cancel`, { reason: "double tap" }), owner.call("POST", `/orders/${o.id}/cancel`, { reason: "double tap" })]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await db.giftCard.findUniqueOrThrow({ where: { id: card.id } })).balance).toBe(50000);
  });
});

// =====================================================================
describe("POST /orders/:id/cancel", () => {
  it("200 → CANCELLED; a second cancel → 409; reason validated", async () => {
    const o = await newBill();
    for (const body of [{}, { reason: "" }, { reason: "ab" }, { reason: LONG }, { reason: 123 }]) {
      expect((await manager.call("POST", `/orders/${o.id}/cancel`, body)).status).toBe(400);
    }
    const r = await manager.call("POST", `/orders/${o.id}/cancel`, { reason: "customer left", status: "PAID" });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: o.id, status: "CANCELLED", cancelReason: "customer left" });
    expect((await manager.call("POST", `/orders/${o.id}/cancel`, { reason: "again please" })).status).toBe(409);
    expect((await manager.call("POST", "/orders/cl0000000000000000000000/cancel", { reason: "nothing" })).status).toBe(404);
  });

  it("cancel after a refund → 409 (refund the rest instead)", async () => {
    const o = await paidBill();
    expect((await manager.call("POST", `/orders/${o.id}/refunds`, { reason: "QUALITY", refundMode: "CASH", amount: 100 })).status).toBe(201);
    expect((await manager.call("POST", `/orders/${o.id}/cancel`, { reason: "after refund" })).status).toBe(409);
  });

  it("two cancels of one bill at the same moment → one 200, one 409, voided once", async () => {
    const o = await newBill();
    const rs = await Promise.all([manager.call("POST", `/orders/${o.id}/cancel`, { reason: "race one" }), owner.call("POST", `/orders/${o.id}/cancel`, { reason: "race two" })]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await db.auditLog.count({ where: { action: "order.cancel", entityId: o.id } })).toBe(1);
  });

  it("roles without approvals: owner and manager only", async () => {
    const bills = await Promise.all(Array.from({ length: 9 }, () => newBill()));
    let i = 0;
    expect(await roleMatrix(w, ["owner", "manager"], (c) => c.call("POST", `/orders/${bills[i++].id}/cancel`, { reason: "role check" }), 200)).toEqual([]);
  });

  describe("with APPROVAL_PINS", () => {
    beforeAll(() => setFeatures(w.h.businessId, { APPROVAL_PINS: true }));
    afterAll(async () => {
      await setFeatures(w.h.businessId, {});
      await db.user.update({ where: { id: w.h.users.manager.id }, data: { pinFailedAttempts: 0, pinLockedUntil: null } });
    });

    it("a cashier needs a manager PIN: none → 403 APPROVAL_REQUIRED, wrong → refused, own id → APPROVER_INVALID, right → 200", async () => {
      const o = await newBill();
      const none = await cashier.call("POST", `/orders/${o.id}/cancel`, { reason: "needs pin" });
      expect(none.status).toBe(403);
      expect(none.body.details.code).toBe("APPROVAL_REQUIRED");
      const wrong = await cashier.call("POST", `/orders/${o.id}/cancel`, { reason: "needs pin", approval: { approverId: w.h.users.manager.id, pin: "0000" } });
      expect([401, 403]).toContain(wrong.status);
      const self = await cashier.call("POST", `/orders/${o.id}/cancel`, { reason: "needs pin", approval: { approverId: w.h.users.cashier.id, pin: "2468" } });
      expect(self.body.details?.code).toBe("APPROVER_INVALID");
      const foreign = await cashier.call("POST", `/orders/${o.id}/cancel`, { reason: "needs pin", approval: { approverId: w.other.users.owner.id, pin: "2468" } });
      expect(foreign.status).toBe(403);
      for (const approval of [{ approverId: w.h.users.manager.id, pin: "12" }, { approverId: w.h.users.manager.id, pin: "abcd" }, { approverId: "", pin: "2468" }, { pin: "2468" }]) {
        expect((await cashier.call("POST", `/orders/${o.id}/cancel`, { reason: "needs pin", approval })).status).toBe(400);
      }
      expect((await db.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("OPEN");
      const ok = await cashier.call("POST", `/orders/${o.id}/cancel`, { reason: "needs pin", approval: { approverId: w.h.users.manager.id, pin: "2468" } });
      expect(ok.status).toBe(200);
      expect(await db.approvalLog.findFirst({ where: { orderId: o.id, action: "VOID", approvedById: w.h.users.manager.id } })).toBeTruthy();
    });

    it("GET /orders/approvers lists PIN holders, never their PIN hash", async () => {
      const r = await cashier.call("GET", "/orders/approvers");
      expect(r.status).toBe(200);
      expect(r.body.enabled).toBe(true);
      expect(r.body.approvers.map((a: { id: string }) => a.id)).toContain(w.h.users.manager.id);
      assertNoSecrets(r.body);
    });
  });
});

// =====================================================================
describe("POST /orders/:id/refunds and credit notes", () => {
  it("refund on an OPEN or CANCELLED bill → 409", async () => {
    const o = await newBill();
    expect((await manager.call("POST", `/orders/${o.id}/refunds`, { reason: "QUALITY", refundMode: "CASH", amount: 100 })).status).toBe(409);
    await manager.call("POST", `/orders/${o.id}/cancel`, { reason: "cancelled first" });
    expect((await manager.call("POST", `/orders/${o.id}/refunds`, { reason: "QUALITY", refundMode: "CASH", amount: 100 })).status).toBe(409);
  });

  it("refunding more than paid → 400; the rest then a further refund → 409", async () => {
    const o = await paidBill();
    expect((await manager.call("POST", `/orders/${o.id}/refunds`, { reason: "OVERCHARGED", refundMode: "CASH", amount: o.grandTotal + 1 })).status).toBe(400);
    expect((await manager.call("POST", `/orders/${o.id}/refunds`, { reason: "OVERCHARGED", refundMode: "CASH", amount: o.grandTotal })).status).toBe(201);
    expect((await manager.call("POST", `/orders/${o.id}/refunds`, { reason: "OVERCHARGED", refundMode: "CASH", amount: 1 })).status).toBe(409);
    const list = await manager.call("GET", `/orders/${o.id}/credit-notes`);
    expect(list.status).toBe(200);
    expect(list.body).toHaveLength(1);
    assertIntegerMoney(list.body);
  });

  it("two full refunds at the same moment → refunded once", async () => {
    const o = await paidBill();
    const body = { reason: "QUALITY", refundMode: "CASH", amount: o.grandTotal };
    const rs = await Promise.all([manager.call("POST", `/orders/${o.id}/refunds`, body), owner.call("POST", `/orders/${o.id}/refunds`, body)]);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    const after = await db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(after.refundedAmount).toBe(o.grandTotal);
    expect(await db.creditNote.count({ where: { orderId: o.id } })).toBe(1);
  });

  it("a refund racing a cancel: never both", async () => {
    const o = await paidBill();
    const rs = await Promise.all([manager.call("POST", `/orders/${o.id}/refunds`, { reason: "QUALITY", refundMode: "CASH", amount: o.grandTotal }), owner.call("POST", `/orders/${o.id}/cancel`, { reason: "race cancel" })]);
    expect(rs.filter((r) => r.status < 300)).toHaveLength(1);
  });

  it("item refunds: quantity above what was sold, from another bill, zero / float → 400", async () => {
    const o = await paidBill();
    const other = await paidBill();
    const line = o.items[0];
    const cases = [
      { items: [{ orderItemId: line.id, quantity: line.quantity + 1 }] },
      { items: [{ orderItemId: other.items[0].id, quantity: 1 }] },
      { items: [{ orderItemId: line.id, quantity: 0 }] },
      { items: [{ orderItemId: line.id, quantity: 0.5 }] },
      { items: [{ orderItemId: line.id, quantity: -1 }] },
      { items: [{ orderItemId: line.id, quantity: 1 }], amount: 100 },
      {},
      { amount: 0 },
      { amount: -5 },
      { amount: 1.5 },
    ];
    for (const c of cases) {
      const r = await manager.call("POST", `/orders/${o.id}/refunds`, { reason: "QUALITY", refundMode: "CASH", ...c });
      expect(r.status, JSON.stringify(c)).toBe(400);
    }
    for (const bad of [{ reason: "NOPE", refundMode: "CASH", amount: 10 }, { reason: "OTHER", refundMode: "CASH", amount: 10 }, { reason: "QUALITY", refundMode: "BITCOIN", amount: 10 }, { reason: "QUALITY", refundMode: "CASH", amount: 10, note: LONG }]) {
      expect((await manager.call("POST", `/orders/${o.id}/refunds`, bad)).status, JSON.stringify(bad).slice(0, 80)).toBe(400);
    }
    expect(await db.creditNote.count({ where: { orderId: o.id } })).toBe(0);
  });

  it("refund to khata / gift card beyond what was paid that way → 400", async () => {
    const o = await paidBill();
    expect((await manager.call("POST", `/orders/${o.id}/refunds`, { reason: "QUALITY", refundMode: "KHATA", amount: 100 })).status).toBe(400);
    expect((await manager.call("POST", `/orders/${o.id}/refunds`, { reason: "QUALITY", refundMode: "GIFT_CARD", amount: 100 })).status).toBe(400);
  });

  it("refund roles without approvals: owner and manager; mass-assigned amount fields ignored", async () => {
    const bills = await Promise.all(Array.from({ length: 9 }, () => paidBill()));
    let i = 0;
    const bad = await roleMatrix(w, ["owner", "manager"], (c) => c.call("POST", `/orders/${bills[i++].id}/refunds`, { reason: "QUALITY", refundMode: "CASH", amount: 100, cgst: 99999, number: "CN-HACK", approvedById: w.h.users.owner.id }), 201);
    expect(bad).toEqual([]);
    const note = await db.creditNote.findFirstOrThrow({ where: { orderId: bills[0].id } });
    expect(note.number).not.toBe("CN-HACK");
    expect(note.approvedById).toBeNull();
    expect(note.cgst).toBeLessThan(100);
  });
});

// =====================================================================
describe("receipts, UPI QR, payment status, COD on a non-delivery bill", () => {
  it("receipt JSON (with a signed public link), text and PDF", async () => {
    const o = await paidBill();
    const j = await cashier.call("GET", `/orders/${o.id}/receipt`);
    expect(j.status).toBe(200);
    expect(j.body.invoiceNumber).toBe(o.invoiceNumber);
    expect(j.body.publicUrl).toMatch(/\/public\/receipts\//);
    assertNoSecrets(j.body);
    const t = await fetch(`${srv.base}/orders/${o.id}/receipt?format=text&paper=80`, { headers: { authorization: `Bearer ${cashier.token}`, "x-outlet-id": w.h.outletId } });
    expect(t.headers.get("content-type")).toMatch(/text\/plain/);
    expect(await t.text()).toContain(o.invoiceNumber);
    const p = await fetch(`${srv.base}/orders/${o.id}/receipt.pdf`, { headers: { authorization: `Bearer ${cashier.token}`, "x-outlet-id": w.h.outletId } });
    expect(p.headers.get("content-type")).toMatch(/application\/pdf/);
    const pub = await fetch(j.body.publicUrl.replace(/^https?:\/\/[^/]+(\/api)?/, srv.base));
    expect(pub.status).toBe(200);
  });

  it("WhatsApp share validates the phone", async () => {
    const o = await newBill();
    for (const body of [{}, { phone: "123" }, { phone: LONG }, { phone: null }]) {
      expect((await cashier.call("POST", `/orders/${o.id}/share/whatsapp`, body)).status).toBe(400);
    }
  });

  it("UPI QR: amount above the balance / zero / float → 400; on a paid bill → 409; replaces the earlier QR", async () => {
    const o = await newBill();
    for (const amount of [o.grandTotal + 1, 0, -1, 1.5, "100"]) expect((await cashier.call("POST", `/orders/${o.id}/upi-qr`, { amount })).status).toBe(400);
    const q1 = await cashier.call("POST", `/orders/${o.id}/upi-qr`, {});
    expect(q1.status).toBe(201);
    expect(q1.body.amount).toBe(o.grandTotal);
    const q2 = await cashier.call("POST", `/orders/${o.id}/upi-qr`, { amount: 100 });
    expect(q2.status).toBe(201);
    expect((await db.payment.findUniqueOrThrow({ where: { id: q1.body.paymentId } })).status).toBe("FAILED");
    // A pending QR isn't money received.
    expect((await cashier.call("GET", `/orders/${o.id}/payment-status`)).body).toMatchObject({ status: "OPEN", amountPaid: 0, balance: o.grandTotal });
    const c = await cashier.call("POST", `/orders/${o.id}/payments/${q2.body.paymentId}/confirm`, { reference: "UTR123" });
    expect(c.body.paid).toBe(false);
    expect((await cashier.call("POST", `/orders/${o.id}/payments/${q2.body.paymentId}/confirm`, {})).status).toBe(409);
    expect((await cashier.call("POST", `/orders/${o.id}/payments/${q1.body.paymentId}/confirm`, {})).status).toBe(409);
    expect((await cashier.call("POST", `/orders/${o.id}/payments/cl0000000000000000000000/confirm`, {})).status).toBe(404);
    const p = await paidBill();
    expect((await cashier.call("POST", `/orders/${p.id}/upi-qr`, {})).status).toBe(409);
  });

  it("COD on a takeaway bill → 400", async () => {
    const o = await newBill();
    expect((await cashier.call("POST", `/orders/${o.id}/cod`, { cod: true })).status).toBe(400);
  });
});

// =====================================================================
describe("POST /orders/sync (offline queue)", () => {
  it("each entry independently; idempotent on clientOrderId; bad entries reported, not fatal", async () => {
    const id1 = crypto.randomUUID();
    const good = { orderType: "TAKEAWAY", items: [item(w.h.items.chai)], clientOrderId: id1, createdAt: new Date(Date.now() - 60_000).toISOString(), grandTotal: 1 };
    const r = await cashier.call("POST", "/orders/sync", { orders: [good, { orderType: "TAKEAWAY", items: [item(w.h.items.chai)] }, { junk: true }, null] });
    expect(r.status).toBe(200);
    expect(r.body.results.map((x: { ok: boolean }) => x.ok)).toEqual([true, false, false, false]);
    expect(r.body.results[0].grandTotal).toBeGreaterThan(1);
    const again = await cashier.call("POST", "/orders/sync", { orders: [good] });
    expect(again.body.results[0]).toMatchObject({ ok: true, duplicate: true, orderId: r.body.results[0].orderId });
    expect(await db.order.count({ where: { clientOrderId: id1 } })).toBe(1);
  });

  it("validation: not an array / > 200 entries → 400", async () => {
    expect((await cashier.call("POST", "/orders/sync", { orders: "x" })).status).toBe(400);
    expect((await cashier.call("POST", "/orders/sync", { orders: Array.from({ length: 201 }, () => ({})) })).status).toBe(400);
    expect((await cashier.call("POST", "/orders/sync", {})).status).toBe(400);
  });

  it("offline-series: deviceId validated; disabled flag answers enabled:false", async () => {
    expect((await cashier.call("POST", "/orders/offline-series", { deviceId: "short" })).body).toMatchObject({ enabled: false });
    await setFeatures(w.h.businessId, { OFFLINE_INVOICE_SERIES: true });
    try {
      expect((await cashier.call("POST", "/orders/offline-series", { deviceId: "short" })).status).toBe(400);
      expect((await cashier.call("POST", "/orders/offline-series", { deviceId: LONG })).status).toBe(400);
      const ok = await cashier.call("POST", "/orders/offline-series", { deviceId: "device-0001-abc" });
      expect(ok.status).toBe(200);
      expect(ok.body.enabled).toBe(true);
    } finally {
      await setFeatures(w.h.businessId, {});
    }
  });
});
