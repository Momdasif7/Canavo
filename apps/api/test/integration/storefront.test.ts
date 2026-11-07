/** Phase 6.3 / 6.4 — QR table ordering and the online ordering page (CHANNELS). */
import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../../src/env";
import { createHotel, db, login, startServer, type Client, type Hotel } from "./helpers";

const ALL = ["BILLING", "KOT", "TABLES", "DELIVERY", "INVENTORY", "CUSTOMERS", "OFFERS", "REPORTS", "CHANNELS"];

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel, off: Hotel;
let owner: Client, cashier: Client;
let slug: string;
let rotateIp = false;

/** Anonymous call (a customer's phone). */
async function pub<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const headers: Record<string, string> = body !== undefined ? { "content-type": "application/json" } : {};
  // Later blocks place many orders: a different client address per call keeps clear of the per-IP limits.
  if (rotateIp) headers["x-forwarded-for"] = `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250) + 1}`;
  const r = await fetch(`${srv.base}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}

async function table(label: string) {
  const r = await owner.call("POST", "/tables", { label, capacity: 4 });
  expect(r.status).toBe(201);
  const qr = (await owner.call("GET", "/storefront/tables")).body as { id: string; label: string; qrToken: string }[];
  return qr.find((t) => t.label === label)!;
}

const settings = (patch: object) => owner.call("PUT", "/storefront/settings", patch);

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("Storefront", { modules: ALL });
  off = await createHotel("NoChannels");
  owner = await login(srv.base, h.users.owner.email, h.outletId);
  cashier = await login(srv.base, h.users.cashier.email, h.outletId);
  slug = `sf-${Date.now().toString(36)}`;
  const first = await settings({ slug, qrOrdering: true, onlineOrdering: true });
  expect(first.status).toBe(200);
  // A new online page starts with phone OTP on; most tests below run without it.
  expect(first.body.settings.verifyPhoneOtp).toBe(true);
  expect((await settings({ verifyPhoneOtp: false })).status).toBe(200);
});
afterAll(() => srv.close());

describe("public menu", () => {
  it("lists available items, greys out out-of-stock ones and leaves hidden ones out", async () => {
    await db.menuItem.update({ where: { id: h.items.samosa }, data: { status: "OUT_OF_STOCK" } });
    const hidden = await db.menuItem.create({ data: { businessId: h.businessId, categoryId: (await db.menuItem.findUniqueOrThrow({ where: { id: h.items.chai } })).categoryId, name: "Secret", price: 100, status: "HIDDEN" } });
    const r = await pub("GET", `/public/o/${slug}`);
    expect(r.status).toBe(200);
    const items = r.body.items as { id: string; available: boolean; price: number }[];
    expect(items.find((i) => i.id === h.items.chai)).toMatchObject({ available: true, price: 1500 });
    expect(items.find((i) => i.id === h.items.samosa)).toMatchObject({ available: false });
    expect(items.find((i) => i.id === hidden.id)).toBeUndefined();
    // …and an out-of-stock item can't be ordered.
    const t = await table("SF-M1");
    expect((await pub("POST", `/public/t/${t.qrToken}/orders`, { items: [{ menuItemId: h.items.samosa, quantity: 1 }] })).status).toBe(400);
    await db.menuItem.update({ where: { id: h.items.samosa }, data: { status: "AVAILABLE" } });
  });

  it("refuses when the business has no CHANNELS module", async () => {
    await db.outlet.update({ where: { id: off.outletId }, data: { publicSlug: `${slug}-off`, storefront: { onlineOrdering: true, qrOrdering: true } } });
    expect((await pub("GET", `/public/o/${slug}-off`)).status).toBe(404);
    const o = await login(srv.base, off.users.owner.email, off.outletId);
    expect((await o.call("GET", "/storefront/settings")).status).toBe(403);
  });

  it("is view-only when online ordering is off, and gone when the menu is off too", async () => {
    await settings({ onlineOrdering: false });
    const r = await pub("GET", `/public/o/${slug}`);
    expect(r.status).toBe(200);
    expect(r.body.ordering).toBe(false);
    const order = { orderType: "TAKEAWAY", customerName: "Ravi", customerPhone: "9876543210", payment: "COUNTER", items: [{ menuItemId: h.items.chai, quantity: 1 }] };
    expect((await pub("POST", `/public/o/${slug}/orders`, order)).status).toBe(409);
    await settings({ menuView: false });
    expect((await pub("GET", `/public/o/${slug}`)).status).toBe(404);
    await settings({ onlineOrdering: true, menuView: true });
  });
});

describe("QR table ordering", () => {
  it("with confirmation on, an order waits; accepting it opens the tab and fires the KOT", async () => {
    const t = await table("SF-1");
    const page = await pub("GET", `/public/t/${t.qrToken}`);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ table: { label: "SF-1" }, ordering: true, needsConfirmation: true });

    const r = await pub("POST", `/public/t/${t.qrToken}/orders`, { items: [{ menuItemId: h.items.chai, quantity: 2, notes: "less sugar" }], customerName: "Asha" });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe("PENDING");
    expect(await db.kotTicket.count({ where: { outletId: h.outletId, session: { tableId: t.id } } })).toBe(0);
    expect((await pub("GET", `/public/t/${t.qrToken}/orders`)).body[0]).toMatchObject({ stage: "waiting" });

    const queue = (await cashier.call("GET", "/storefront/requests")).body as { id: string; tableLabel: string }[];
    expect(queue.find((q) => q.id === r.body.id)?.tableLabel).toBe("SF-1");
    const acc = await cashier.call("POST", `/storefront/requests/${r.body.id}/accept`);
    expect(acc.status).toBe(200);
    expect(acc.body.status).toBe("ACCEPTED");
    const session = await db.tableSession.findFirstOrThrow({ where: { tableId: t.id, status: "OPEN" }, include: { items: true, kots: true } });
    expect(session.items).toHaveLength(1);
    expect(session.items[0]).toMatchObject({ menuItemId: h.items.chai, quantity: 2 });
    expect(session.kots).toHaveLength(1);
    expect(session.customerName).toBe("Asha");
    expect((await pub("GET", `/public/t/${t.qrToken}/orders`)).body[0]).toMatchObject({ stage: "received" });
    // Accepting twice is refused.
    expect((await cashier.call("POST", `/storefront/requests/${r.body.id}/accept`)).status).toBe(409);

    // A rejected order never reaches the kitchen.
    const r2 = await pub("POST", `/public/t/${t.qrToken}/orders`, { items: [{ menuItemId: h.items.biryani, quantity: 1 }] });
    expect((await cashier.call("POST", `/storefront/requests/${r2.body.id}/reject`, { reason: "Kitchen closed" })).status).toBe(200);
    expect(await db.tableSessionItem.count({ where: { sessionId: session.id } })).toBe(1);
    expect((await pub("GET", `/public/t/${t.qrToken}/orders`)).body[0]).toMatchObject({ stage: "cancelled", rejectReason: "Kitchen closed" });
  });

  it("with confirmation off, the order goes straight to the kitchen on the table's tab", async () => {
    await settings({ qrNeedsConfirmation: false });
    const t = await table("SF-2");
    const r = await pub("POST", `/public/t/${t.qrToken}/orders`, { items: [{ menuItemId: h.items.biryani, quantity: 1 }] });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe("ACCEPTED");
    const session = await db.tableSession.findFirstOrThrow({ where: { tableId: t.id, status: "OPEN" }, include: { items: true, kots: true } });
    expect(session.items).toHaveLength(1);
    expect(session.kots).toHaveLength(1);
    await settings({ qrNeedsConfirmation: true });
  });

  it("rotating the token kills the old QR code", async () => {
    const t = await table("SF-3");
    expect((await pub("GET", `/public/t/${t.qrToken}`)).status).toBe(200);
    const rot = await owner.call("POST", `/storefront/tables/${t.id}/rotate`);
    expect(rot.status).toBe(200);
    expect(rot.body.qrToken).not.toBe(t.qrToken);
    expect((await pub("GET", `/public/t/${t.qrToken}`)).status).toBe(404);
    expect((await pub("GET", `/public/t/${rot.body.qrToken}`)).status).toBe(200);
  });

  it("call waiter notifies the outlet's staff", async () => {
    const t = await table("SF-4");
    expect((await pub("POST", `/public/t/${t.qrToken}/call`, { kind: "WAITER" })).status).toBe(201);
    expect((await pub("POST", `/public/t/${t.qrToken}/call`, { kind: "BILL" })).status).toBe(201);
    const notes = await db.notification.findMany({ where: { userId: h.users.cashier.id, kind: { in: ["table.call", "table.bill"] } } });
    expect(notes.map((n) => n.title).sort()).toEqual(["Table SF-4: bill please", "Table SF-4: guest is calling"]);
  });

  it("limits orders per table and phone", async () => {
    const t = await table("SF-5");
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await pub("POST", `/public/t/${t.qrToken}/orders`, { items: [{ menuItemId: h.items.chai, quantity: 1 }] })).status);
    expect(statuses.slice(0, 6).every((s) => s === 201)).toBe(true);
    expect(statuses[6]).toBe(429);
    // Too many items in one order.
    const t2 = await table("SF-6");
    expect((await pub("POST", `/public/t/${t2.qrToken}/orders`, { items: [{ menuItemId: h.items.chai, quantity: 21 }] })).status).toBe(400);
  });

  it("refuses orders when QR ordering is off or outside accepting hours", async () => {
    const t = await table("SF-7");
    await settings({ qrOrdering: false });
    expect((await pub("GET", `/public/t/${t.qrToken}`)).body.ordering).toBe(false);
    expect((await pub("POST", `/public/t/${t.qrToken}/orders`, { items: [{ menuItemId: h.items.chai, quantity: 1 }] })).status).toBe(409);
    // Closed window: 1 minute long, 12 hours from now (outlet time).
    const hh = (new Date().getUTCHours() + 5 + 12) % 24;
    await settings({ qrOrdering: true, acceptFrom: `${String(hh).padStart(2, "0")}:00`, acceptTo: `${String(hh).padStart(2, "0")}:01` });
    expect((await pub("POST", `/public/t/${t.qrToken}/orders`, { items: [{ menuItemId: h.items.chai, quantity: 1 }] })).status).toBe(409);
    await settings({ acceptFrom: null, acceptTo: null });
  });
});

describe("online ordering", () => {
  it("prices takeaway orders on the server (client prices ignored), channel ONLINE, KOT after accept", async () => {
    const r = await pub("POST", `/public/o/${slug}/orders`, {
      orderType: "TAKEAWAY",
      customerName: "Ravi",
      customerPhone: "9876543210",
      payment: "COUNTER",
      items: [{ menuItemId: h.items.biryani, quantity: 2, unitPrice: 1, price: 1 }],
      grandTotal: 1,
    });
    expect(r.status).toBe(201);
    const req = await db.channelRequest.findUniqueOrThrow({ where: { publicToken: r.body.token } });
    const order = await db.order.findUniqueOrThrow({ where: { id: req.orderId! }, include: { items: true, kots: true } });
    expect(order).toMatchObject({ channel: "ONLINE", orderType: "TAKEAWAY", customerPhone: "9876543210", subtotal: 32000 });
    expect(order.items[0].unitPrice).toBe(16000);
    expect(order.kots).toHaveLength(0);
    expect(req.status).toBe("PENDING");

    const view = await pub("GET", `/public/o/${slug}/orders/${r.body.token}`);
    expect(view.body).toMatchObject({ stage: "waiting", grandTotal: order.grandTotal, receiptUrl: null });

    expect((await cashier.call("POST", `/storefront/requests/${req.id}/accept`)).status).toBe(200);
    expect(await db.kotTicket.count({ where: { orderId: order.id } })).toBe(1);
    expect((await pub("GET", `/public/o/${slug}/orders/${r.body.token}`)).body.stage).toBe("received");

    // Paid → the confirmation page links the receipt.
    await cashier.call("POST", `/orders/${order.id}/payments`, { payments: [{ mode: "CASH", amount: order.grandTotal }] });
    expect((await pub("GET", `/public/o/${slug}/orders/${r.body.token}`)).body.receiptUrl).toMatch(/\/public\/receipts\//);
  });

  it("rejecting an online order cancels its bill with the reason", async () => {
    const r = await pub("POST", `/public/o/${slug}/orders`, { orderType: "TAKEAWAY", customerName: "Meena", customerPhone: "9876543211", payment: "COUNTER", items: [{ menuItemId: h.items.chai, quantity: 1 }] });
    const req = await db.channelRequest.findUniqueOrThrow({ where: { publicToken: r.body.token } });
    expect((await cashier.call("POST", `/storefront/requests/${req.id}/reject`, { reason: "Out of milk" })).status).toBe(200);
    const order = await db.order.findUniqueOrThrow({ where: { id: req.orderId! } });
    expect(order.status).toBe("CANCELLED");
    expect(order.cancelReason).toContain("Out of milk");
    expect((await pub("GET", `/public/o/${slug}/orders/${r.body.token}`)).body.stage).toBe("cancelled");
  });

  it("UPI prepaid creates a UPI QR for the bill; confirmation off fires the KOT at once", async () => {
    await settings({ upiPrepaid: true, onlineNeedsConfirmation: false });
    const r = await pub("POST", `/public/o/${slug}/orders`, { orderType: "TAKEAWAY", customerName: "Kiran", customerPhone: "9876543212", payment: "UPI", items: [{ menuItemId: h.items.chai, quantity: 1 }] });
    expect(r.status).toBe(201);
    const view = await pub("GET", `/public/o/${slug}/orders/${r.body.token}`);
    expect(view.body.upi.qrPayload).toMatch(/^upi:\/\/pay/);
    const req = await db.channelRequest.findUniqueOrThrow({ where: { publicToken: r.body.token } });
    expect(req.status).toBe("ACCEPTED");
    expect(await db.kotTicket.count({ where: { orderId: req.orderId! } })).toBe(1);
    // Pay at counter isn't offered for delivery, COD isn't for takeaway.
    expect((await pub("POST", `/public/o/${slug}/orders`, { orderType: "TAKEAWAY", customerName: "Kiran", customerPhone: "9876543212", payment: "COD", items: [{ menuItemId: h.items.chai, quantity: 1 }] })).status).toBe(400);
    await settings({ upiPrepaid: false, onlineNeedsConfirmation: true });
  });

  it("enforces the minimum order", async () => {
    await settings({ minOrder: 50000 });
    const r = await pub("POST", `/public/o/${slug}/orders`, { orderType: "TAKEAWAY", customerName: "Kiran", customerPhone: "9876543212", payment: "COUNTER", items: [{ menuItemId: h.items.chai, quantity: 1 }] });
    expect(r.status).toBe(400);
    await settings({ minOrder: 0 });
  });

  it("slugs are unique across hotels", async () => {
    const o = await login(srv.base, off.users.owner.email, off.outletId);
    expect(o).toBeTruthy();
    const other = await createHotel("SlugClash", { modules: ALL });
    const oc = await login(srv.base, other.users.owner.email, other.outletId);
    expect((await oc.call("PUT", "/storefront/settings", { slug })).status).toBe(409);
  });
});

describe("phone OTP for online orders", () => {
  beforeAll(() => {
    rotateIp = true;
  });
  const takeaway = (phone: string, phoneToken?: string) => ({ orderType: "TAKEAWAY", customerName: "Otp", customerPhone: phone, phoneToken, payment: "COUNTER", items: [{ menuItemId: h.items.chai, quantity: 1 }] });

  it("existing outlets keep OTP off (stored default false)", async () => {
    const other = await createHotel("OtpLegacy", { modules: ALL });
    await db.outlet.update({ where: { id: other.outletId }, data: { publicSlug: `${slug}-legacy`, storefront: { onlineOrdering: true } } });
    const oc = await login(srv.base, other.users.owner.email, other.outletId);
    const r = await oc.call("PUT", "/storefront/settings", { minOrder: 0 });
    expect(r.body.settings.verifyPhoneOtp).toBe(false);
    expect((await pub("GET", `/public/o/${slug}-legacy`)).body.verifyPhone).toBe(false);
  });

  it("refuses orders without a verified phone; request → cooldown → wrong code → right code → order", async () => {
    await settings({ verifyPhoneOtp: true });
    expect((await pub("GET", `/public/o/${slug}`)).body.verifyPhone).toBe(true);
    const phone = "9811100001";
    const refused = await pub("POST", `/public/o/${slug}/orders`, takeaway(phone));
    expect(refused.status).toBe(403);
    expect(refused.body.details.code).toBe("PHONE_NOT_VERIFIED");
    expect((await pub("POST", `/public/o/${slug}/orders`, takeaway(phone, "bogus.token"))).status).toBe(403);

    const req1 = await pub("POST", `/public/o/${slug}/otp/request`, { phone });
    expect(req1.status).toBe(200);
    expect(req1.body).toMatchObject({ ok: true, expiresIn: 300, cooldown: 30 });
    expect(req1.body.devCode).toMatch(/^\d{6}$/);
    // Hashed, never stored in clear, and not in the staff OTP table.
    const row = await db.customerOtp.findFirstOrThrow({ where: { outletId: h.outletId, phone } });
    expect(row.codeHash).not.toContain(req1.body.devCode);
    expect(await db.otpCode.count({ where: { phone } })).toBe(0);
    // 30-second cooldown.
    expect((await pub("POST", `/public/o/${slug}/otp/request`, { phone })).status).toBe(429);

    const wrong = req1.body.devCode === "000000" ? "111111" : "000000";
    const bad = await pub("POST", `/public/o/${slug}/otp/verify`, { phone, code: wrong });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toContain("4 tries left");
    const ok = await pub("POST", `/public/o/${slug}/otp/verify`, { phone, code: req1.body.devCode });
    expect(ok.status).toBe(200);
    expect(ok.body.phoneToken).toBeTruthy();
    // Single use.
    expect((await pub("POST", `/public/o/${slug}/otp/verify`, { phone, code: req1.body.devCode })).status).toBe(400);
    // The token works for this phone only.
    expect((await pub("POST", `/public/o/${slug}/orders`, takeaway("9811100002", ok.body.phoneToken))).status).toBe(403);
    // …and doesn't log anyone in to the staff app.
    expect((await pub("POST", "/auth/otp/verify", { phone, code: req1.body.devCode })).status).toBe(401);
    const placed = await pub("POST", `/public/o/${slug}/orders`, takeaway(phone, ok.body.phoneToken));
    expect(placed.status).toBe(201);
  });

  it("codes expire after 5 minutes and lock after 5 wrong tries", async () => {
    const phone = "9811100003";
    const r = await pub("POST", `/public/o/${slug}/otp/request`, { phone });
    await db.customerOtp.updateMany({ where: { outletId: h.outletId, phone }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await pub("POST", `/public/o/${slug}/otp/verify`, { phone, code: r.body.devCode });
    expect(expired.status).toBe(400);
    expect(expired.body.error).toContain("expired");

    // A fresh code (cooldown passed), then five wrong tries.
    await db.customerOtp.updateMany({ where: { outletId: h.outletId, phone }, data: { createdAt: new Date(Date.now() - 60_000) } });
    const r2 = await pub("POST", `/public/o/${slug}/otp/request`, { phone });
    expect(r2.status).toBe(200);
    const wrong = r2.body.devCode === "000000" ? "111111" : "000000";
    const errors: string[] = [];
    for (let i = 0; i < 5; i++) errors.push((await pub("POST", `/public/o/${slug}/otp/verify`, { phone, code: wrong })).body.error);
    expect(errors[4]).toContain("too many times");
    // Even the right code is refused now.
    expect((await pub("POST", `/public/o/${slug}/otp/verify`, { phone, code: r2.body.devCode })).status).toBe(400);
    await settings({ verifyPhoneOtp: false });
  });
});

// ---------------------------------------------------------------------------
// Automatic UPI refunds (fake Razorpay server)
// ---------------------------------------------------------------------------

describe("UPI refunds when an online order is rejected or cancelled", () => {
  let fake: http.Server;
  let fakeBase = "";
  const calls: { method: string; path: string; body: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  let refundReply: { status: number; body: object } = { status: 200, body: { id: "rfnd_TEST1", status: "processed" } };
  const saved = { base: env.RAZORPAY_BASE_URL };
  let qrSeq = 0;

  beforeAll(async () => {
    fake = http.createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        calls.push({ method: req.method!, path: req.url!, body: raw ? JSON.parse(raw) : null });
        res.setHeader("content-type", "application/json");
        if (req.url === "/v1/payments/qr_codes") return res.end(JSON.stringify({ id: `qr_TEST${++qrSeq}${Date.now()}`, image_url: "https://example.test/qr.png" }));
        if (/^\/v1\/payments\/pay_\w+\/refund$/.test(req.url!)) {
          res.statusCode = refundReply.status;
          return res.end(JSON.stringify(refundReply.body));
        }
        res.statusCode = 404;
        res.end("{}");
      });
    });
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
    fakeBase = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
    await settings({ upiPrepaid: true, onlineNeedsConfirmation: true });
  });
  afterAll(async () => {
    env.RAZORPAY_BASE_URL = saved.base;
    await owner.call("DELETE", "/admin/integrations/razorpay");
    await settings({ upiPrepaid: false, onlineNeedsConfirmation: true });
    await new Promise<void>((r) => fake.close(() => r()));
  });

  // Razorpay is the store's own account (Settings → Integrations; no platform keys any more),
  // and its events arrive on the store's own webhook URL, signed with the store's secret.
  const HOOK_SECRET = "whsec_fake_store";
  let hookPath = "";
  const useRazorpay = async () => {
    env.RAZORPAY_BASE_URL = fakeBase;
    const r = await owner.call("PUT", "/admin/integrations/razorpay", { keyId: "rzp_test_fakeStore1", keySecret: "fakesecret0123456789", webhookSecret: HOOK_SECRET });
    expect(r.status).toBe(200);
    hookPath = new URL(r.body.webhookUrl).pathname;
  };
  const noRazorpay = async () => {
    env.RAZORPAY_BASE_URL = fakeBase;
    expect((await owner.call("DELETE", "/admin/integrations/razorpay")).status).toBe(200);
  };

  async function webhook(event: object) {
    const body = JSON.stringify(event);
    const sig = crypto.createHmac("sha256", HOOK_SECRET).update(body).digest("hex");
    const r = await fetch(`${srv.base}${hookPath}`, { method: "POST", headers: { "content-type": "application/json", "x-razorpay-signature": sig }, body });
    expect(r.status).toBe(200);
    return r.json();
  }

  /** Place a UPI order and pay it through the (fake) Razorpay webhook. */
  async function paidUpiOrder(name: string, payId: string) {
    const r = await pub("POST", `/public/o/${slug}/orders`, { orderType: "TAKEAWAY", customerName: name, customerPhone: "9822200001", payment: "UPI", items: [{ menuItemId: h.items.biryani, quantity: 1 }] });
    expect(r.status).toBe(201);
    const req = await db.channelRequest.findUniqueOrThrow({ where: { publicToken: r.body.token } });
    const pay = await db.payment.findFirstOrThrow({ where: { orderId: req.orderId!, mode: "UPI", status: "PENDING" } });
    const order = await db.order.findUniqueOrThrow({ where: { id: req.orderId! } });
    await webhook({ event: "qr_code.credited", payload: { qr_code: { entity: { id: pay.gatewayRef } }, payment: { entity: { id: payId, amount: order.grandTotal } } } });
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PAID");
    return { token: r.body.token as string, req, order };
  }

  it("rejecting a UPI-paid order refunds it through Razorpay once, with a UPI credit note", async () => {
    await useRazorpay();
    const { token, req, order } = await paidUpiOrder("Refund Ravi", "pay_TESTREJ1");
    calls.length = 0;
    const rej = await cashier.call("POST", `/storefront/requests/${req.id}/reject`, { reason: "Kitchen closed" });
    expect(rej.status).toBe(200);
    const refunds = calls.filter((c) => c.path.endsWith("/refund"));
    expect(refunds).toHaveLength(1);
    expect(refunds[0]).toMatchObject({ method: "POST", path: "/v1/payments/pay_TESTREJ1/refund", body: { amount: order.grandTotal } });

    const after = await db.channelRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(after).toMatchObject({ status: "REJECTED", refundStatus: "PROCESSED", refundRef: "rfnd_TEST1", refundAmount: order.grandTotal });
    const cn = await db.creditNote.findFirstOrThrow({ where: { orderId: order.id } });
    expect(cn).toMatchObject({ refundMode: "UPI", amount: order.grandTotal, id: after.creditNoteId });
    // The bill stays as issued (paid, refunded in full) — never voided after a GST invoice.
    expect(await db.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ status: "PAID", refundedAmount: order.grandTotal });

    const view = await pub("GET", `/public/o/${slug}/orders/${token}`);
    expect(view.body).toMatchObject({ stage: "cancelled", refund: { status: "PROCESSED", amount: order.grandTotal } });
    const list = (await cashier.call("GET", "/storefront/requests?status=REJECTED")).body as { id: string; refund: { status: string } | null }[];
    expect(list.find((x) => x.id === req.id)?.refund?.status).toBe("PROCESSED");
    // A second reject does nothing (and doesn't refund again).
    expect((await cashier.call("POST", `/storefront/requests/${req.id}/reject`, { reason: "Again" })).status).toBe(409);
    expect(calls.filter((c) => c.path.endsWith("/refund"))).toHaveLength(1);
  });

  it("a refund Razorpay reports as failed later is flagged for the manager", async () => {
    await useRazorpay();
    refundReply = { status: 200, body: { id: "rfnd_TEST2", status: "pending" } };
    const { req } = await paidUpiOrder("Refund Pending", "pay_TESTREJ2");
    await cashier.call("POST", `/storefront/requests/${req.id}/reject`, { reason: "Too busy" });
    expect((await db.channelRequest.findUniqueOrThrow({ where: { id: req.id } })).refundStatus).toBe("PENDING");
    await webhook({ event: "refund.failed", payload: { refund: { entity: { id: "rfnd_TEST2", payment_id: "pay_TESTREJ2", amount: 1, status: "failed" } } } });
    expect((await db.channelRequest.findUniqueOrThrow({ where: { id: req.id } })).refundStatus).toBe("FAILED");
    expect(await db.notification.count({ where: { userId: h.users.owner.id, kind: "channel.refund", title: "UPI refund failed" } })).toBe(1);
    refundReply = { status: 200, body: { id: "rfnd_TEST1", status: "processed" } };
  });

  it("without Razorpay keys: refund pending — do it in the dashboard, manager notified, credit note still issued", async () => {
    await noRazorpay();
    calls.length = 0;
    const r = await pub("POST", `/public/o/${slug}/orders`, { orderType: "TAKEAWAY", customerName: "Dev Mode", customerPhone: "9822200002", payment: "UPI", items: [{ menuItemId: h.items.chai, quantity: 1 }] });
    const req = await db.channelRequest.findUniqueOrThrow({ where: { publicToken: r.body.token } });
    const pay = await db.payment.findFirstOrThrow({ where: { orderId: req.orderId!, mode: "UPI", status: "PENDING" } });
    expect(pay.gatewayRef).toMatch(/^mock_/);
    expect((await cashier.call("POST", `/orders/${req.orderId}/payments/${pay.id}/dev-simulate`)).body.paid).toBe(true);
    expect((await cashier.call("POST", `/storefront/requests/${req.id}/reject`, { reason: "Out of stock" })).status).toBe(200);
    expect(calls).toHaveLength(0);
    const after = await db.channelRequest.findUniqueOrThrow({ where: { id: req.id } });
    expect(after).toMatchObject({ refundStatus: "MANUAL", refundRef: null });
    expect(await db.creditNote.count({ where: { orderId: req.orderId!, refundMode: "UPI" } })).toBe(1);
    const note = await db.notification.findFirst({ where: { userId: h.users.owner.id, kind: "channel.refund", body: { contains: "Razorpay dashboard" } }, orderBy: { createdAt: "desc" } });
    expect(note?.title).toContain("by hand");
    expect((await pub("GET", `/public/o/${slug}/orders/${r.body.token}`)).body.refund.status).toBe("MANUAL");
  });

  it("cancelling an accepted order before the kitchen starts refunds it; once preparing it can't be cancelled", async () => {
    await useRazorpay();
    const { req, order } = await paidUpiOrder("Cancel Early", "pay_TESTCAN1");
    expect((await cashier.call("POST", `/storefront/requests/${req.id}/accept`)).status).toBe(200);
    expect(await db.kotTicket.count({ where: { orderId: order.id } })).toBe(1);
    // Needs order:cancel (a manager).
    const manager = await login(srv.base, h.users.manager.email, h.outletId);
    calls.length = 0;
    const c = await manager.call("POST", `/storefront/requests/${req.id}/cancel`, { reason: "Customer called to cancel" });
    expect(c.status).toBe(200);
    expect(c.body).toMatchObject({ status: "REJECTED", refundStatus: "PROCESSED" });
    expect(calls.filter((x) => x.path === "/v1/payments/pay_TESTCAN1/refund")).toHaveLength(1);
    expect(await db.kotTicket.count({ where: { orderId: order.id } })).toBe(0);

    const second = await paidUpiOrder("Cancel Late", "pay_TESTCAN2");
    await cashier.call("POST", `/storefront/requests/${second.req.id}/accept`);
    await db.kotTicket.updateMany({ where: { orderId: second.order.id }, data: { status: "PREPARING" } });
    calls.length = 0;
    expect((await manager.call("POST", `/storefront/requests/${second.req.id}/cancel`, { reason: "Customer called" })).status).toBe(409);
    expect(calls).toHaveLength(0);
  });

  it("an unpaid online order is voided as before (no refund)", async () => {
    await useRazorpay();
    calls.length = 0;
    const r = await pub("POST", `/public/o/${slug}/orders`, { orderType: "TAKEAWAY", customerName: "Unpaid", customerPhone: "9822200003", payment: "UPI", items: [{ menuItemId: h.items.chai, quantity: 1 }] });
    const req = await db.channelRequest.findUniqueOrThrow({ where: { publicToken: r.body.token } });
    await cashier.call("POST", `/storefront/requests/${req.id}/reject`, { reason: "Closed" });
    expect((await db.order.findUniqueOrThrow({ where: { id: req.orderId! } })).status).toBe("CANCELLED");
    expect((await db.channelRequest.findUniqueOrThrow({ where: { id: req.id } })).refundStatus).toBeNull();
    expect(calls.filter((c) => c.path.endsWith("/refund"))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Delivery map pin
// ---------------------------------------------------------------------------

describe("delivery address by map pin", () => {
  const OUTLET = { latitude: 13.0, longitude: 80.2 };
  let near: { id: string }, far: { id: string };

  beforeAll(async () => {
    await db.outlet.update({ where: { id: h.outletId }, data: { ...OUTLET, deliveryEnabled: true } });
    near = (await owner.call("POST", "/delivery/zones", { name: "Near", radiusKm: 3, fee: 2000, etaMinutes: 25 })).body;
    far = (await owner.call("POST", "/delivery/zones", { name: "Far", radiusKm: 6, fee: 5000, etaMinutes: 45 })).body;
    await settings({ delivery: true, cashOnDelivery: true });
  });
  afterAll(async () => {
    await settings({ delivery: false });
  });

  const order = (lat: number, lng: number, zoneId?: string) => ({
    orderType: "DELIVERY",
    customerName: "Pin",
    customerPhone: "9833300001",
    payment: "COD",
    items: [{ menuItemId: h.items.biryani, quantity: 1 }],
    delivery: { address: "12 Beach Road", latitude: lat, longitude: lng, zoneId },
  });

  it("quotes the zone and fee for a pin, and refuses one outside every zone", async () => {
    const page = await pub("GET", `/public/o/${slug}`);
    expect(page.body.location).toEqual({ lat: 13, lng: 80.2 });
    const inside = await pub("GET", `/public/o/${slug}/delivery-quote?lat=13.01&lng=80.2`);
    expect(inside.body).toMatchObject({ deliverable: true, zone: { id: near.id, fee: 2000, etaMinutes: 25 } });
    const outside = await pub("GET", `/public/o/${slug}/delivery-quote?lat=13.2&lng=80.2`);
    expect(outside.body.deliverable).toBe(false);
    expect(outside.body.message).toMatch(/don't deliver there.*within 6 km/);
  });

  it("the server picks the zone from the coordinates (client zone ignored) and refuses outside addresses", async () => {
    const bad = await pub("POST", `/public/o/${slug}/orders`, order(13.2, 80.2, near.id));
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/don't deliver there/);

    const ok = await pub("POST", `/public/o/${slug}/orders`, order(13.01, 80.2, far.id));
    expect(ok.status).toBe(201);
    const req = await db.channelRequest.findUniqueOrThrow({ where: { publicToken: ok.body.token } });
    const o = await db.order.findUniqueOrThrow({ where: { id: req.orderId! }, include: { delivery: true } });
    expect(o.delivery).toMatchObject({ zoneId: near.id, latitude: 13.01, longitude: 80.2 });
    expect(o.chargesBreakup).toEqual(expect.arrayContaining([expect.objectContaining({ label: "Delivery fee", amount: 2000 })]));
  });

  it("without the outlet's location it falls back to the chosen area", async () => {
    await db.outlet.update({ where: { id: h.outletId }, data: { latitude: null, longitude: null } });
    const q = await pub("GET", `/public/o/${slug}/delivery-quote?lat=13.01&lng=80.2`);
    expect(q.body).toMatchObject({ outletLocation: false, deliverable: false });
    expect((await pub("POST", `/public/o/${slug}/orders`, order(13.01, 80.2))).status).toBe(400);
    expect((await pub("POST", `/public/o/${slug}/orders`, order(13.01, 80.2, far.id))).status).toBe(201);
    await db.outlet.update({ where: { id: h.outletId }, data: OUTLET });
  });
});
