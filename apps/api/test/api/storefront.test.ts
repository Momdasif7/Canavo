/**
 * QA Phase 6 — /storefront (staff side: settings, table QR codes, incoming requests) and the
 * public customer routes: /public/t/:token (QR table ordering), /public/o/:slug (online ordering
 * with phone OTP), /public/receipts/:token (signed link) and POST /webhooks/razorpay.
 * Authorization, tenant isolation, price / quantity tampering, enumeration, OTP brute force /
 * replay / rate limits, signature checks, replay and idempotency of webhooks.
 */
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { env } from "../../src/env";
import { receiptToken } from "../../src/routes/orders";
import { signPhoneToken } from "../../src/services/storefront-otp";
import { createHotel, db, login, startServer, type Client, type Hotel } from "../integration/helpers";
import { NASTY, checkAuthz, expectAll, expectNoSecrets, expectPaise, mobile, roleClients, superAdmin, type Endpoint, type RoleKey } from "./commerce-kit";

const MODULES = ["BILLING", "KOT", "TABLES", "DELIVERY", "CUSTOMERS", "REPORTS", "CHANNELS"];
const ID = "cl0000000000000000000000";
const HOOK_SECRET = "whsec_qa_storefront";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel, other: Hotel;
let c: Record<RoleKey, Client>;
let owner: Client, manager: Client, cashier: Client, otherOwner: Client;
let slug: string, otherSlug: string;
let qr: { id: string; qrToken: string }, otherQr: { id: string; qrToken: string };
let requestId: string;
const savedHook = env.RAZORPAY_WEBHOOK_SECRET;

let ipSeq = 0;
const nextIp = () => `10.77.${Math.floor(++ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;

/** Anonymous customer call; a new client address each time unless `ip` is given. */
async function pub<T = any>(method: string, path: string, body?: unknown, ip: string = nextIp(), headers: Record<string, string> = {}): Promise<{ status: number; body: T; headers: Headers }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const r = await fetch(`${srv.base}${path}`, {
    method,
    headers: { "x-forwarded-for": ip, ...(body !== undefined && { "content-type": "application/json" }), ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: unknown = text;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  return { status: r.status, body: parsed as T, headers: r.headers };
}

async function makeTable(cl: Client, label: string) {
  expect((await cl.call("POST", "/tables", { label, capacity: 4 })).status).toBe(201);
  return ((await cl.call("GET", "/storefront/tables")).body as { id: string; label: string; qrToken: string }[]).find((t) => t.label === label)!;
}

const online = (extra: object = {}) => ({ orderType: "TAKEAWAY", customerName: "Ravi", customerPhone: "9876543210", payment: "COUNTER", items: [{ menuItemId: h.items.chai, quantity: 1 }], ...extra });

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("QA Storefront", { modules: MODULES });
  other = await createHotel("QA Storefront B", { modules: MODULES });
  c = await roleClients(srv.base, h);
  ({ owner, manager, cashier } = c);
  otherOwner = await login(srv.base, other.users.owner.email, other.outletId);
  slug = `qa-sf-${Date.now().toString(36)}`;
  otherSlug = `${slug}-b`;
  expect((await owner.call("PUT", "/storefront/settings", { slug, qrOrdering: true, onlineOrdering: true, verifyPhoneOtp: false, upiPrepaid: true })).status).toBe(200);
  expect((await otherOwner.call("PUT", "/storefront/settings", { slug: otherSlug, qrOrdering: true, onlineOrdering: true, verifyPhoneOtp: true })).status).toBe(200);
  qr = await makeTable(owner, "QA-T1");
  otherQr = await makeTable(otherOwner, "QB-T1");
  const r = await pub("POST", `/public/t/${qr.qrToken}/orders`, { items: [{ menuItemId: h.items.chai, quantity: 1 }] });
  expect(r.status).toBe(201);
  requestId = r.body.id;
});
afterAll(async () => {
  env.RAZORPAY_WEBHOOK_SECRET = savedHook;
  await srv.close();
});

const MANAGE: RoleKey[] = ["owner", "manager"];
const HANDLE: RoleKey[] = ["owner", "manager", "cashier", "waiter"];

const endpoints = (): Endpoint[] => [
  { method: "GET", path: "/storefront/settings", allowed: MANAGE },
  { method: "PUT", path: "/storefront/settings", body: { minOrder: -1 }, allowed: MANAGE },
  { method: "GET", path: "/storefront/tables", allowed: MANAGE },
  { method: "POST", path: `/storefront/tables/${ID}/rotate`, allowed: MANAGE },
  { method: "GET", path: "/storefront/requests", allowed: HANDLE },
  { method: "POST", path: `/storefront/requests/${ID}/accept`, allowed: HANDLE },
  { method: "POST", path: `/storefront/requests/${requestId}/reject`, body: { reason: "x" }, allowed: HANDLE },
  { method: "POST", path: `/storefront/requests/${requestId}/cancel`, body: { reason: "x" }, allowed: MANAGE },
];

describe("staff side: authorization", () => {
  it("every role × every /storefront endpoint: allowed roles pass, the rest get 403", async () => {
    await checkAuthz(c, endpoints());
  });

  it("module off, foreign outlet, super admin: refused everywhere", async () => {
    const off = await createHotel("QA No Storefront");
    await expectAll(await login(srv.base, off.users.owner.email, off.outletId), endpoints(), 403);
    await expectAll(await login(srv.base, h.users.manager.email, h.outlet2Id), endpoints(), 403);
    await expectAll(await superAdmin(srv.base, h.outletId), endpoints(), 403);
  });

  it("cross-tenant: another hotel can't see / accept / reject / rotate this hotel's requests and tables", async () => {
    for (const [m, p, b] of [
      ["POST", `/storefront/requests/${requestId}/accept`],
      ["POST", `/storefront/requests/${requestId}/reject`, { reason: "hijacked" }],
      ["POST", `/storefront/requests/${requestId}/cancel`, { reason: "hijacked" }],
      ["POST", `/storefront/tables/${qr.id}/rotate`],
    ] as const) {
      expect((await otherOwner.call(m, p, b)).status, p).toBe(404);
    }
    expect(((await otherOwner.call("GET", "/storefront/requests")).body as { id: string }[]).map((r) => r.id)).not.toContain(requestId);
    expect(((await otherOwner.call("GET", "/storefront/tables")).body as { id: string }[]).map((t) => t.id)).not.toContain(qr.id);
    expect((await db.channelRequest.findUniqueOrThrow({ where: { id: requestId } })).status).toBe("PENDING");
    expect((await db.diningTable.findUniqueOrThrow({ where: { id: qr.id } })).qrToken).toBe(qr.qrToken);
    // Outlet 2 of the same hotel doesn't see outlet 1's queue either.
    expect(((await owner.call("GET", "/storefront/requests", undefined, { "x-outlet-id": h.outlet2Id })).body as { id: string }[]).map((r) => r.id)).not.toContain(requestId);
    expect((await owner.call("POST", `/storefront/requests/${requestId}/accept`, undefined, { "x-outlet-id": h.outlet2Id })).status).toBe(404);
  });
});

describe("staff side: settings, tables, requests", () => {
  it("settings shape; invalid patches → 400 with nothing saved; taken / bad slugs refused", async () => {
    const g = await manager.call("GET", "/storefront/settings");
    expect(g.status).toBe(200);
    expect(g.body).toMatchObject({ slug, settings: { qrOrdering: true, onlineOrdering: true } });
    expectPaise(g.body.settings.minOrder);
    const before = await db.outlet.findUniqueOrThrow({ where: { id: h.outletId }, select: { storefront: true, publicSlug: true } });
    const bad = [
      { minOrder: -1 },
      { minOrder: 10.5 },
      { minOrder: 10_000_001 },
      { minOrder: "100" },
      { acceptFrom: "25:00" },
      { acceptFrom: "9:00" },
      { qrOrdering: "yes" },
      { slug: "a" },
      { slug: "-bad-" },
      { slug: "has space" },
      { slug: "x".repeat(41) },
      { slug: NASTY.tamil },
      { slug: "a/../b" },
    ];
    for (const b of bad) expect((await manager.call("PUT", "/storefront/settings", b)).status, JSON.stringify(b)).toBe(400);
    expect((await manager.call("PUT", "/storefront/settings", { slug: otherSlug })).status).toBe(409);
    expect(await db.outlet.findUniqueOrThrow({ where: { id: h.outletId }, select: { storefront: true, publicSlug: true } })).toEqual(before);
    // Unknown keys are dropped, not stored in the settings JSON.
    expect((await manager.call("PUT", "/storefront/settings", { minOrder: 0, businessId: other.businessId, evil: "<x>" })).status).toBe(200);
    expect(JSON.stringify((await db.outlet.findUniqueOrThrow({ where: { id: h.outletId } })).storefront)).not.toMatch(/evil|businessId/);
    // Online ordering needs a web address.
    expect((await owner.call("PUT", "/storefront/settings", { onlineOrdering: true }, { "x-outlet-id": h.outlet2Id })).status).toBe(409);
  });

  it("tables list every active table with a token; rotate → new token, old one dead; unknown → 404", async () => {
    const t = await makeTable(owner, "QA-ROT");
    const r = await manager.call("POST", `/storefront/tables/${t.id}/rotate`);
    expect(r.status).toBe(200);
    expect(r.body.qrToken).not.toBe(t.qrToken);
    expect(r.body.qrToken).toMatch(/^[A-Za-z0-9_-]{24}$/);
    expect((await pub("GET", `/public/t/${t.qrToken}`)).status).toBe(404);
    expect((await pub("GET", `/public/t/${r.body.qrToken}`)).status).toBe(200);
    expect((await manager.call("POST", `/storefront/tables/${ID}/rotate`)).status).toBe(404);
  });

  it("requests list: status filter, contract; accept → 409 the second time; reject reason validated", async () => {
    const l = await cashier.call("GET", "/storefront/requests");
    expect(l.status).toBe(200);
    const row = (l.body as { id: string; total: number; tableLabel: string }[]).find((r) => r.id === requestId)!;
    expect(row).toMatchObject({ channel: "QR", status: "PENDING", tableLabel: "QA-T1" });
    expectPaise(row.total);
    expect((await cashier.call("GET", "/storefront/requests?status=BOGUS")).status).toBe(200); // unknown status = pending list
    const x = (await pub("POST", `/public/t/${qr.qrToken}/orders`, { items: [{ menuItemId: h.items.samosa, quantity: 1 }] })).body.id;
    for (const b of [{}, { reason: "x" }, { reason: "x".repeat(201) }, { reason: 5 }]) expect((await cashier.call("POST", `/storefront/requests/${x}/reject`, b)).status).toBe(400);
    expect((await cashier.call("POST", `/storefront/requests/${x}/reject`, { reason: NASTY.xss })).body.rejectReason).toBe(NASTY.xss);
    expect((await cashier.call("POST", `/storefront/requests/${x}/accept`)).status).toBe(409);
    expect((await cashier.call("POST", `/storefront/requests/${x}/reject`, { reason: "again" })).status).toBe(409);
    // Concurrent accepts: exactly one wins.
    const y = (await pub("POST", `/public/t/${qr.qrToken}/orders`, { items: [{ menuItemId: h.items.samosa, quantity: 1 }] })).body.id;
    const rs = await Promise.all([1, 2, 3].map(() => cashier.call("POST", `/storefront/requests/${y}/accept`)));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 409, 409]);
    // Cancel is for accepted online orders only.
    expect((await manager.call("POST", `/storefront/requests/${y}/cancel`, { reason: "not online" })).status).toBe(400);
    expect((await manager.call("POST", `/storefront/requests/${ID}/cancel`, { reason: "unknown" })).status).toBe(404);
  });
});

describe("public QR table ordering", () => {
  it("unknown / malformed / enumerated tokens → 404 with the same answer", async () => {
    const tokens = [crypto.randomBytes(18).toString("base64url"), "short", "x".repeat(65), "' OR 1=1 --", `${qr.qrToken.slice(0, -1)}A`, qr.qrToken.toUpperCase()];
    for (const t of tokens) {
      for (const [m, p, b] of [["GET", ""], ["GET", "/orders"], ["POST", "/orders", { items: [{ menuItemId: h.items.chai, quantity: 1 }] }], ["POST", "/call", { kind: "WAITER" }]] as const) {
        const r = await pub(m, `/public/t/${encodeURIComponent(t)}${p}`, b);
        expect(r.status, `${t} ${m} ${p}`).toBe(404);
        expect(r.body).toEqual({ error: "Table not found" });
      }
    }
  });

  it("page shape has no internal ids / secrets", async () => {
    const r = await pub("GET", `/public/t/${qr.qrToken}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ table: { label: "QA-T1" }, ordering: true });
    expectNoSecrets(r.body);
    const s = JSON.stringify(r.body);
    for (const leak of [h.businessId, h.outletId, qr.id, "upiVpa", "gstin\":\"", "storefront"]) expect(s).not.toContain(leak);
  });

  it("prices / totals / status in the body are ignored; the request is priced from the menu", async () => {
    const r = await pub("POST", `/public/t/${qr.qrToken}/orders`, {
      items: [{ menuItemId: h.items.biryani, quantity: 2, price: 1, unitPrice: 1, discount: 16000 }],
      total: 1,
      status: "ACCEPTED",
      outletId: other.outletId,
      tableId: otherQr.id,
      customerName: NASTY.tamil,
    });
    expect(r.status).toBe(201);
    expect(Object.keys(r.body).sort()).toEqual(["id", "status"]);
    expect(r.body.status).toBe("PENDING");
    const req = await db.channelRequest.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(req).toMatchObject({ total: 32000, outletId: h.outletId, tableId: qr.id, customerName: NASTY.tamil, status: "PENDING" });
  });

  it("quantity / line / shape abuse → 400 and nothing written", async () => {
    const before = await db.channelRequest.count({ where: { outletId: h.outletId } });
    const line = (q: unknown, id = h.items.chai) => ({ menuItemId: id, quantity: q });
    const bad = [
      {},
      { items: [] },
      { items: [line(0)] },
      { items: [line(-1)] },
      { items: [line(1.5)] },
      { items: [line(21)] },
      { items: [line("2")] },
      { items: [line(1e9)] },
      { items: Array.from({ length: 4 }, () => line(20)) }, // 80 > 60 in total
      { items: Array.from({ length: 26 }, () => line(1)) },
      { items: [line(1, other.items.chai)] },
      { items: [line(1, ID)] },
      { items: [{ ...line(1), addonIds: Array.from({ length: 11 }, () => "a") }] },
      { items: [line(1)], customerPhone: "12345" },
      { items: [line(1)], customerName: "x".repeat(61) },
      { items: [line(1)], notes: "x".repeat(201) },
      { items: [{ ...line(1), variantId: ID }] },
    ];
    for (const b of bad) expect((await pub("POST", `/public/t/${qr.qrToken}/orders`, b)).status, JSON.stringify(b).slice(0, 100)).toBe(400);
    expect((await pub("POST", `/public/t/${qr.qrToken}/orders`, "{bad json")).status).toBe(400);
    expect(await db.channelRequest.count({ where: { outletId: h.outletId } })).toBe(before);
  });

  it("another hotel's table token orders only from that hotel's menu", async () => {
    expect((await pub("POST", `/public/t/${otherQr.qrToken}/orders`, { items: [{ menuItemId: h.items.chai, quantity: 1 }] })).status).toBe(400);
    const r = await pub("POST", `/public/t/${otherQr.qrToken}/orders`, { items: [{ menuItemId: other.items.chai, quantity: 1 }] });
    expect(r.status).toBe(201);
    expect((await db.channelRequest.findUniqueOrThrow({ where: { id: r.body.id } })).outletId).toBe(other.outletId);
  });

  it("table order list shows this table's orders only, without phone numbers", async () => {
    await pub("POST", `/public/t/${qr.qrToken}/orders`, { items: [{ menuItemId: h.items.chai, quantity: 1 }], customerPhone: "9811122233", customerName: "Private" });
    const r = await pub("GET", `/public/t/${qr.qrToken}/orders`);
    expect(r.status).toBe(200);
    expect(JSON.stringify(r.body)).not.toContain("9811122233");
    for (const o of r.body) expectPaise(o.total);
    const theirs = (await pub("GET", `/public/t/${otherQr.qrToken}/orders`)).body as { id: string }[];
    expect(theirs.map((o) => o.id)).not.toContain(requestId);
  });

  it("call waiter: bad kind → 400; per-table limit → 429", async () => {
    for (const b of [{}, { kind: "MANAGER" }, { kind: null }]) expect((await pub("POST", `/public/t/${qr.qrToken}/call`, b)).status).toBe(400);
    const ip = nextIp();
    const t = await makeTable(owner, "QA-CALL");
    const codes = [];
    for (let i = 0; i < 5; i++) codes.push((await pub("POST", `/public/t/${t.qrToken}/call`, { kind: "WAITER" }, ip)).status);
    expect(codes).toEqual([201, 201, 201, 201, 429]);
  });

  it("order limit per table and phone: 6 accepted in 10 minutes, then 429; refused orders don't count", async () => {
    const t = await makeTable(owner, "QA-LIM");
    const ip = nextIp();
    for (let i = 0; i < 3; i++) expect((await pub("POST", `/public/t/${t.qrToken}/orders`, { items: [] }, ip)).status).toBe(400);
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await pub("POST", `/public/t/${t.qrToken}/orders`, { items: [{ menuItemId: h.items.chai, quantity: 1 }] }, ip)).status);
    expect(codes).toEqual([201, 201, 201, 201, 201, 201, 429]);
  });
});

describe("public online ordering", () => {
  it("unknown / malformed / other-case slugs → 404; the page has no secrets", async () => {
    for (const s of ["no-such-outlet-qa", "ab", slug.toUpperCase(), `${slug}%00`, "..%2F..%2Fetc", "x".repeat(41)]) {
      // A NUL byte is refused before routing (400, BUG-006); everything else is a plain 404.
      const refused = s.includes("%00") ? 400 : 404;
      expect((await pub("GET", `/public/o/${s}`)).status, s).toBe(refused);
      expect((await pub("POST", `/public/o/${s}/orders`, online())).status, s).toBe(refused);
    }
    const r = await pub("GET", `/public/o/${slug}`);
    expect(r.status).toBe(200);
    expectNoSecrets(r.body);
    for (const leak of [h.businessId, h.outletId]) expect(JSON.stringify(r.body)).not.toContain(leak);
  });

  it("price tampering ignored; order view has server totals and no phone number", async () => {
    const r = await pub("POST", `/public/o/${slug}/orders`, online({ items: [{ menuItemId: h.items.biryani, quantity: 1, unitPrice: 1, discount: 99999 }], grandTotal: 1, discount: 99999, status: "PAID" }));
    expect(r.status).toBe(201);
    expect(Object.keys(r.body)).toEqual(["token"]);
    const v = await pub("GET", `/public/o/${slug}/orders/${r.body.token}`);
    expect(v.status).toBe(200);
    expect(v.body).toMatchObject({ status: "OPEN", subtotal: 16000, discount: 0, receiptUrl: null });
    expectPaise(v.body.grandTotal, v.body.balance, v.body.tax);
    expect(JSON.stringify(v.body)).not.toContain("9876543210");
    expectNoSecrets(v.body);
  });

  it("bad online orders → 400 and nothing written", async () => {
    const before = await db.order.count({ where: { outletId: h.outletId } });
    const bad = [
      online({ orderType: "DINE_IN" }),
      online({ customerName: "" }),
      online({ customerName: "x" }),
      online({ customerPhone: "123" }),
      online({ customerPhone: undefined }),
      online({ payment: "CASH" }),
      online({ payment: "COD" }), // COD is for delivery
      online({ orderType: "DELIVERY", payment: "COD" }), // delivery off
      online({ pickupAt: "tomorrow" }),
      online({ pickupAt: new Date(Date.now() - 3600_000).toISOString() }),
      online({ pickupAt: new Date(Date.now() + 3 * 86400_000).toISOString() }),
      online({ items: [{ menuItemId: h.items.chai, quantity: 21 }] }),
      online({ items: [{ menuItemId: other.items.chai, quantity: 1 }] }),
      online({ phoneToken: "x".repeat(401) }),
      online({ notes: "x".repeat(201) }),
    ];
    for (const b of bad) expect((await pub("POST", `/public/o/${slug}/orders`, b)).status, JSON.stringify(b).slice(0, 160)).toBe(400);
    expect(await db.order.count({ where: { outletId: h.outletId } })).toBe(before);
  });

  it("order tokens are bound to their outlet and channel; random tokens → 404", async () => {
    const t = (await pub("POST", `/public/o/${slug}/orders`, online())).body.token as string;
    expect((await pub("GET", `/public/o/${otherSlug}/orders/${t}`)).status).toBe(404);
    expect((await pub("POST", `/public/o/${otherSlug}/orders/${t}/upi`)).status).toBe(404);
    const qrPublic = (await db.channelRequest.findUniqueOrThrow({ where: { id: requestId } })).publicToken!;
    expect((await pub("GET", `/public/o/${slug}/orders/${qrPublic}`)).status).toBe(404);
    for (const x of [crypto.randomBytes(18).toString("base64url"), "short", "' OR 1=1"]) expect((await pub("GET", `/public/o/${slug}/orders/${encodeURIComponent(x)}`)).status).toBe(404);
    // A counter-paid order has no UPI QR to refresh.
    expect((await pub("POST", `/public/o/${slug}/orders/${t}/upi`)).status).toBe(409);
  });

  it("delivery quote: bad coordinates → 400; delivery off → 409", async () => {
    for (const q of ["", "?lat=91&lng=80", "?lat=13&lng=181", "?lat=abc&lng=80", "?lat=13"]) expect((await pub("GET", `/public/o/${slug}/delivery-quote${q}`)).status, q).toBe(400);
    expect((await pub("GET", `/public/o/${slug}/delivery-quote?lat=13&lng=80`)).status).toBe(409);
  });

  it("online order limit per page and address: 5 in 10 minutes, then 429", async () => {
    const ip = nextIp();
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await pub("POST", `/public/o/${slug}/orders`, online(), ip)).status);
    expect(codes).toEqual([201, 201, 201, 201, 201, 429]);
  });
});

describe("phone OTP", () => {
  // The other hotel's page has OTP on.
  const otpReq = (phone: string, ip?: string, s = otherSlug) => pub("POST", `/public/o/${s}/otp/request`, { phone }, ip);
  const otpVerify = (phone: string, code: string, ip?: string, s = otherSlug) => pub("POST", `/public/o/${s}/otp/verify`, { phone, code }, ip);
  const order = (phone: string, phoneToken?: string) => pub("POST", `/public/o/${otherSlug}/orders`, { ...online(), customerPhone: phone, items: [{ menuItemId: other.items.chai, quantity: 1 }], phoneToken });

  it("request: bad phones → 400; response never has the code hash; cooldown → 429", async () => {
    for (const p of ["", "123", "5876543210", "98765432101", "+919876543210"]) expect((await otpReq(p)).status, p).toBe(400);
    const phone = mobile();
    const r = await otpReq(phone);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, expiresIn: 300, cooldown: 30 });
    expectNoSecrets(r.body);
    expect((await otpReq(phone)).status).toBe(429);
  });

  it("per-phone limit across outlets / addresses: the 6th request in 15 minutes → 429 'Too many requests'", async () => {
    const phone = mobile();
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push(await otpReq(phone, nextIp(), i % 2 ? slug : otherSlug));
    expect(codes.slice(0, 2).map((r) => r.status)).toEqual([200, 200]);
    expect(codes[5].status).toBe(429);
    expect(codes[5].body.error).toMatch(/Too many requests/);
  });

  it("verify: wrong code counts down; right code once only (replay refused); other outlet's code refused", async () => {
    const phone = mobile();
    const { devCode } = (await otpReq(phone)).body;
    expect(devCode).toMatch(/^\d{6}$/);
    for (const code of ["", "12345", "1234567", "abcdef", " 12 34 "]) expect((await otpVerify(phone, code)).status).toBe(400);
    const wrong = devCode === "000000" ? "000001" : "000000";
    expect((await otpVerify(phone, wrong)).body.error).toMatch(/4 tries left/);
    expect((await otpVerify(phone, devCode, undefined, slug)).status).toBe(400); // code is per outlet
    const ok = await otpVerify(phone, devCode);
    expect(ok.status).toBe(200);
    expect(ok.body.phoneToken).toEqual(expect.any(String));
    expect((await otpVerify(phone, devCode)).status).toBe(400);
    // The token works for this phone on this outlet only.
    expect((await order(phone, ok.body.phoneToken)).status).toBe(201);
    expect((await order(mobile(), ok.body.phoneToken)).status).toBe(403);
    const onA = await pub("POST", `/public/o/${slug}/orders`, online({ customerPhone: phone, phoneToken: ok.body.phoneToken }));
    expect(onA.status).toBe(201); // outlet A has OTP off: the token is simply not needed there
  });

  it("forged / tampered / expired / cross-outlet phone tokens → 403 PHONE_NOT_VERIFIED", async () => {
    const phone = mobile();
    const good = signPhoneToken(other.outletId, phone);
    const [body, sig] = good.split(".");
    const forgedBody = Buffer.from(`${other.outletId}.${mobile()}.${Math.floor(Date.now() / 1000) + 999}`).toString("base64url");
    const tokens = [
      undefined,
      "",
      "garbage",
      `${body}.${sig.slice(0, -2)}AA`,
      `${forgedBody}.${sig}`,
      signPhoneToken(h.outletId, phone),
      signPhoneToken(other.outletId, phone, -10),
      `${body}`,
    ];
    for (const t of tokens) {
      const r = await order(phone, t);
      expect(r.status, String(t)).toBe(403);
      expect(r.body.details?.code).toBe("PHONE_NOT_VERIFIED");
    }
    expect((await order(phone, good)).status).toBe(201);
  });

  it("brute force: 5 wrong codes lock the code — even when the guesses arrive all at once", async () => {
    const phone = mobile();
    const { devCode } = (await otpReq(phone)).body;
    const wrong = Array.from({ length: 15 }, (_, i) => String((Number(devCode) + 1 + i) % 1_000_000).padStart(6, "0"));
    const rs = await Promise.all(wrong.map((code) => otpVerify(phone, code)));
    expect(rs.every((r) => r.status === 400)).toBe(true);
    // The right code must not work after more than 5 wrong guesses.
    expect((await otpVerify(phone, devCode)).status).toBe(400);
    const otp = await db.customerOtp.findFirstOrThrow({ where: { phone }, orderBy: { createdAt: "desc" } });
    expect(otp.consumed).toBe(true);
  });

  it("verify limit per address: the 21st check in 15 minutes → 429", async () => {
    const ip = nextIp();
    const phone = mobile();
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await otpVerify(phone, "123456", ip)).status;
    expect(last).toBe(429);
  });

  it("OTP request refused while online ordering is off", async () => {
    await otherOwner.call("PUT", "/storefront/settings", { onlineOrdering: false });
    try {
      expect((await otpReq(mobile())).status).toBe(409);
    } finally {
      await otherOwner.call("PUT", "/storefront/settings", { onlineOrdering: true });
    }
  });
});

describe("signed receipt link", () => {
  let orderId: string;
  beforeAll(async () => {
    const o = (await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.chai, quantity: 1 }] })).body;
    orderId = o.id;
  });

  it("a valid link → PDF", async () => {
    const r = await fetch(`${srv.base}/public/receipts/${receiptToken(orderId)}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/application\/pdf/);
    expect((await r.arrayBuffer()).byteLength).toBeGreaterThan(500);
  });

  it("tampered / wrong-secret / expired / alg=none / unknown-order / garbage links → 404, never the PDF", async () => {
    const good = receiptToken(orderId);
    const [hd, , sg] = good.split(".");
    const otherPayload = Buffer.from(JSON.stringify({ oid: ID, exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url");
    const tokens = [
      `${good.slice(0, -3)}abc`,
      `${hd}.${otherPayload}.${sg}`,
      jwt.sign({ oid: orderId }, "some-other-secret-0123456789abcdef0123"),
      jwt.sign({ oid: orderId }, env.JWT_ACCESS_SECRET),
      jwt.sign({ oid: orderId, exp: Math.floor(Date.now() / 1000) - 60 }, env.RECEIPT_LINK_SECRET),
      `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify({ oid: orderId })).toString("base64url")}.`,
      jwt.sign({ oid: ID }, env.RECEIPT_LINK_SECRET),
      jwt.sign({ oid: { not: "x" } }, env.RECEIPT_LINK_SECRET),
      jwt.sign({ nothing: true }, env.RECEIPT_LINK_SECRET),
      "garbage",
      "' OR 1=1 --",
    ];
    for (const t of tokens) {
      const r = await fetch(`${srv.base}/public/receipts/${encodeURIComponent(t)}`);
      expect(r.status, t.slice(0, 60)).toBe(404);
      expect(r.headers.get("content-type")).toMatch(/json/);
    }
  });
});

describe("Razorpay webhook", () => {
  const sign = (raw: string, secret = HOOK_SECRET) => crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const hook = (raw: string, headers: Record<string, string>) => fetch(`${srv.base}/webhooks/razorpay`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: raw }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const credited = (qrId: string, amount: number, payId = `pay_QA${crypto.randomBytes(4).toString("hex")}`) => JSON.stringify({ event: "qr_code.credited", payload: { qr_code: { entity: { id: qrId } }, payment: { entity: { id: payId, amount, contact: "+919800011122" } } } });

  async function upiOrder(phone = mobile()) {
    const r = await pub("POST", `/public/o/${slug}/orders`, online({ payment: "UPI", customerPhone: phone, items: [{ menuItemId: h.items.biryani, quantity: 1 }] }));
    expect(r.status).toBe(201);
    const req = await db.channelRequest.findUniqueOrThrow({ where: { publicToken: r.body.token } });
    const pay = await db.payment.findFirstOrThrow({ where: { orderId: req.orderId!, mode: "UPI", status: "PENDING" } });
    const order = await db.order.findUniqueOrThrow({ where: { id: req.orderId! } });
    return { token: r.body.token as string, pay, order };
  }

  beforeAll(() => {
    env.RAZORPAY_WEBHOOK_SECRET = HOOK_SECRET;
  });

  it("no secret configured → every call refused (401)", async () => {
    env.RAZORPAY_WEBHOOK_SECRET = undefined;
    try {
      const raw = credited("qr_x", 100);
      expect((await hook(raw, { "x-razorpay-signature": sign(raw) })).status).toBe(401);
    } finally {
      env.RAZORPAY_WEBHOOK_SECRET = HOOK_SECRET;
    }
  });

  it("missing / wrong / body-swapped signatures → 401 and the payment stays pending", async () => {
    const { pay } = await upiOrder();
    const raw = credited(pay.gatewayRef!, 99999);
    for (const hd of [{} as Record<string, string>, { "x-razorpay-signature": "" }, { "x-razorpay-signature": sign(raw, "wrong") }, { "x-razorpay-signature": sign(raw).toUpperCase() }, { "x-razorpay-signature": sign(credited(pay.gatewayRef!, 1)) }]) {
      const r = await hook(raw, hd);
      expect(r.status).toBe(401);
      expect(r.body.error).toBe("Bad signature");
    }
    expect((await db.payment.findUniqueOrThrow({ where: { id: pay.id } })).status).toBe("PENDING");
  });

  it("signed but unreadable bodies / wrong content type → 4xx, never 500", async () => {
    for (const raw of ["not json", "", "{\"event\":"]) {
      const r = await hook(raw, { "x-razorpay-signature": sign(raw) });
      expect(r.status, raw).toBe(400);
    }
    const raw = credited("qr_x", 100);
    const r = await fetch(`${srv.base}/webhooks/razorpay`, { method: "POST", headers: { "content-type": "text/plain", "x-razorpay-signature": sign(raw) }, body: raw });
    expect(r.status).toBeLessThan(500);
    expect(r.status).toBeGreaterThanOrEqual(400);
  });

  it("unknown events / QR codes / missing payloads are acknowledged and ignored", async () => {
    for (const [raw, ignored] of [
      [JSON.stringify({ event: "payment.captured", payload: {} }), "payment.captured"],
      [credited("qr_unknown_qa", 100), "unknown qr"],
      [JSON.stringify({ event: "qr_code.credited", payload: {} }), "missing payload"],
      [JSON.stringify({ event: "refund.processed", payload: {} }), "missing payload"],
      [JSON.stringify({ event: "refund.processed", payload: { refund: { entity: { id: "rfnd_none" } } } }), "unknown refund"],
    ] as const) {
      const r = await hook(raw, { "x-razorpay-signature": sign(raw) });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ignored });
    }
  });

  it("paid in full → order PAID once; a replay is a no-op", async () => {
    const { pay, order, token } = await upiOrder();
    const raw = credited(pay.gatewayRef!, order.grandTotal);
    expect((await hook(raw, { "x-razorpay-signature": sign(raw) })).body).toEqual({ ok: true });
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PAID");
    expect((await hook(raw, { "x-razorpay-signature": sign(raw) })).body).toEqual({ ok: true, duplicate: true });
    expect(await db.auditLog.count({ where: { action: "payment.webhook", entityId: pay.id } })).toBe(1);
    // The customer's page now links a signed receipt that opens.
    const v = await pub("GET", `/public/o/${slug}/orders/${token}`);
    expect(v.body.receiptUrl).toMatch(/\/public\/receipts\//);
    const rec = await fetch(`${srv.base}/public/receipts/${v.body.receiptUrl.split("/public/receipts/")[1]}`);
    expect(rec.status).toBe(200);
  });

  it("concurrent deliveries of the same credit are processed once (one audit row, loyalty earned once)", async () => {
    const phone = mobile();
    const { pay, order } = await upiOrder(phone);
    const raw = credited(pay.gatewayRef!, order.grandTotal, "pay_QACONC1");
    const rs = await Promise.all(Array.from({ length: 6 }, () => hook(raw, { "x-razorpay-signature": sign(raw) })));
    expect(rs.every((r) => r.status === 200)).toBe(true);
    expect(rs.filter((r) => r.body.duplicate !== true)).toHaveLength(1);
    expect(await db.auditLog.count({ where: { action: "payment.webhook", entityId: pay.id } })).toBe(1);
    const customer = await db.customer.findFirstOrThrow({ where: { businessId: h.businessId, phone } });
    expect(customer.visitCount).toBe(1);
    expect(customer.totalSpend).toBe(order.grandTotal);
    expect(await db.loyaltyTransaction.count({ where: { orderId: order.id, type: "EARN" } })).toBeLessThanOrEqual(1);
  });

  it("a short credit doesn't settle the bill; the balance stays due", async () => {
    const { pay, order, token } = await upiOrder();
    const raw = credited(pay.gatewayRef!, order.grandTotal - 100);
    expect((await hook(raw, { "x-razorpay-signature": sign(raw) })).status).toBe(200);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("OPEN");
    const v = await pub("GET", `/public/o/${slug}/orders/${token}`);
    expect(v.body).toMatchObject({ status: "OPEN", balance: 100, receiptUrl: null });
  });
});
