/**
 * QA Phase 6 — /canteen API: corporate accounts, subsidy rules, statements, members,
 * wallets (top-up / adjust / spend: never negative, no double spend), meal tokens,
 * meal slots and slot menus, pre-orders, production plan, meal subscriptions.
 * Status codes and contract, role × endpoint authorization, module gate, tenant / outlet
 * isolation, input validation (nothing written on a 400), pagination.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addDays, zonedParts } from "../../src/lib/time";
import { createHotel, db, login, startServer, type Client, type Hotel } from "../integration/helpers";
import { NASTY, badInts, checkAuthz, expectAll, expectNoSecrets, expectPaise, mobile, roleClients, superAdmin, type Endpoint, type RoleKey } from "./commerce-kit";

const MODULES = ["BILLING", "KOT", "CUSTOMERS", "INVENTORY", "REPORTS", "CANTEEN"];
const TZ = "Asia/Kolkata";
const today = () => zonedParts(new Date(), TZ).date;
const ID = "cl0000000000000000000000";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel, other: Hotel;
let c: Record<RoleKey, Client>;
let owner: Client, manager: Client, cashier: Client, otherOwner: Client;

// Fixtures made in beforeAll
let accountId: string, ruleId: string, statementId: string, memberId: string, slotId: string, subId: string, preorderId: string;
let otherAccountId: string, otherSlotId: string, otherMemberId: string;

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("QA Canteen", { modules: MODULES });
  other = await createHotel("QA Canteen B", { modules: MODULES });
  c = await roleClients(srv.base, h);
  ({ owner, manager, cashier } = c);
  otherOwner = await login(srv.base, other.users.owner.email, other.outletId);

  accountId = (await owner.call("POST", "/canteen/accounts", { name: "Fixture Corp" })).body.id;
  ruleId = (await owner.call("POST", `/canteen/accounts/${accountId}/rules`, { type: "PERCENT", value: 50 })).body.id;
  statementId = (await owner.call("POST", `/canteen/accounts/${accountId}/statements`, { from: "2020-01-01", to: "2020-01-31" })).body.id;
  memberId = (await owner.call("POST", "/canteen/members", { name: "Fixture Emp", phone: mobile(), corporateAccountId: accountId, cardUid: `FX${Date.now()}` })).body.id;
  // A slot that's nearly all day; pre-orders for tomorrow close 23:59 today.
  slotId = (await manager.call("POST", "/canteen/slots", { name: "All day", startTime: "00:00", endTime: "23:59", preorderCutoff: "23:59" })).body.slot.id;
  preorderId = (await cashier.call("POST", "/canteen/preorders", { date: addDays(today(), 1), slotId, items: [{ menuItemId: h.items.chai, quantity: 1 }] })).body.id;
  const cust = (await db.customer.create({ data: { businessId: h.businessId, phone: mobile(), name: "Plan Holder" } })).id;
  const sub = await manager.call("POST", "/canteen/subscriptions", {
    customerId: cust, slotId, menuItemId: h.items.chai, daysOfWeek: [0, 1, 2, 3, 4, 5, 6], startDate: addDays(today(), 1), endDate: addDays(today(), 5), paymentMode: "CASH",
  });
  expect(sub.status).toBe(201);
  subId = sub.body.id;
  expect([accountId, ruleId, statementId, memberId, slotId, preorderId].every(Boolean)).toBe(true);

  otherAccountId = (await otherOwner.call("POST", "/canteen/accounts", { name: "Other Corp" })).body.id;
  otherSlotId = (await otherOwner.call("POST", "/canteen/slots", { name: "Other", startTime: "08:00", endTime: "09:00" })).body.slot.id;
  otherMemberId = (await otherOwner.call("POST", "/canteen/members", { name: "Other Emp", phone: mobile() })).body.id;
});
afterAll(() => srv.close());

const MANAGE: RoleKey[] = ["owner", "manager"];
const COUNTER: RoleKey[] = ["owner", "manager", "cashier"];
const ORDER: RoleKey[] = ["owner", "manager", "cashier", "waiter"];

/** Every /canteen endpoint with deliberately invalid bodies (authorised roles get 4xx, never a write). */
const endpoints = (): Endpoint[] => [
  { method: "GET", path: "/canteen/accounts", allowed: MANAGE },
  { method: "POST", path: "/canteen/accounts", body: {}, allowed: MANAGE },
  { method: "PATCH", path: `/canteen/accounts/${accountId}`, body: { name: "" }, allowed: MANAGE },
  { method: "GET", path: "/canteen/rule-slots", allowed: MANAGE },
  { method: "GET", path: `/canteen/accounts/${accountId}/rules`, allowed: MANAGE },
  { method: "POST", path: `/canteen/accounts/${accountId}/rules`, body: {}, allowed: MANAGE },
  { method: "PATCH", path: `/canteen/rules/${ruleId}`, body: { type: "BOGUS" }, allowed: MANAGE },
  { method: "DELETE", path: `/canteen/rules/${ID}`, allowed: MANAGE },
  { method: "GET", path: `/canteen/accounts/${accountId}/statement?from=2020-01-01&to=2020-01-31`, allowed: MANAGE },
  { method: "GET", path: `/canteen/accounts/${accountId}/statements`, allowed: MANAGE },
  { method: "POST", path: `/canteen/accounts/${accountId}/statements`, body: {}, allowed: MANAGE },
  { method: "PATCH", path: `/canteen/statements/${statementId}`, body: { status: "BOGUS" }, allowed: MANAGE },
  { method: "GET", path: "/canteen/members", allowed: MANAGE },
  { method: "GET", path: "/canteen/members/lookup?q=nobody-here", allowed: ORDER },
  { method: "POST", path: "/canteen/members", body: {}, allowed: MANAGE },
  { method: "PATCH", path: `/canteen/members/${memberId}`, body: { phone: "1" }, allowed: MANAGE },
  { method: "POST", path: "/canteen/members/import", body: { rows: [] }, allowed: MANAGE },
  { method: "GET", path: `/canteen/members/${memberId}`, allowed: COUNTER },
  { method: "POST", path: `/canteen/members/${memberId}/topup`, body: { amount: 1 }, allowed: COUNTER },
  { method: "POST", path: `/canteen/members/${memberId}/wallet/adjust`, body: { amount: 0 }, allowed: MANAGE },
  { method: "POST", path: `/canteen/members/${memberId}/tokens`, body: { count: 0 }, allowed: COUNTER },
  { method: "GET", path: "/canteen/slots", allowed: ORDER },
  { method: "POST", path: "/canteen/slots", body: {}, allowed: MANAGE },
  { method: "PATCH", path: `/canteen/slots/${slotId}`, body: { startTime: "99:99" }, allowed: MANAGE },
  { method: "DELETE", path: `/canteen/slots/${ID}`, allowed: MANAGE },
  { method: "GET", path: `/canteen/slots/${slotId}/items`, allowed: ORDER },
  { method: "PUT", path: `/canteen/slots/${slotId}/items`, body: {}, allowed: MANAGE },
  { method: "POST", path: "/canteen/preorders", body: {}, allowed: ORDER },
  { method: "GET", path: "/canteen/preorders", allowed: ORDER },
  { method: "POST", path: `/canteen/preorders/${preorderId}/cancel`, body: { reason: "x" }, allowed: MANAGE },
  { method: "POST", path: `/canteen/preorders/${ID}/serve`, allowed: ORDER },
  { method: "GET", path: "/canteen/production", allowed: MANAGE },
  { method: "GET", path: "/canteen/subscriptions", allowed: MANAGE },
  { method: "GET", path: `/canteen/subscriptions/${subId}`, allowed: MANAGE },
  { method: "POST", path: "/canteen/subscriptions", body: {}, allowed: MANAGE },
  { method: "POST", path: `/canteen/subscriptions/${ID}/pause`, allowed: MANAGE },
  { method: "POST", path: `/canteen/subscriptions/${ID}/resume`, allowed: MANAGE },
  { method: "POST", path: `/canteen/subscriptions/${subId}/skips`, body: {}, allowed: MANAGE },
  { method: "DELETE", path: `/canteen/subscriptions/${ID}/skips/2030-01-01`, allowed: MANAGE },
  { method: "POST", path: `/canteen/subscriptions/${subId}/cancel`, body: {}, allowed: MANAGE },
];

describe("authorization", () => {
  it("every role × every /canteen endpoint: allowed roles pass, the rest get 403", async () => {
    await checkAuthz(c, endpoints());
  });

  it("module off: a business without CANTEEN is refused on every endpoint", async () => {
    const off = await createHotel("QA No Canteen", { modules: ["BILLING", "KOT", "CUSTOMERS"] });
    const o = await login(srv.base, off.users.owner.email, off.outletId);
    await expectAll(o, endpoints(), 403);
  });

  it("cross-outlet: a manager of outlet 1 acting on outlet 2 is refused; super admin gets no hotel data", async () => {
    const m2 = await login(srv.base, h.users.manager.email, h.outlet2Id);
    await expectAll(m2, endpoints(), 403);
    await expectAll(await superAdmin(srv.base, h.outletId), endpoints(), 403);
  });

  it("cross-tenant: another hotel's owner using this hotel's ids gets 404 / 400, never the data", async () => {
    const ids = [
      ["PATCH", `/canteen/accounts/${accountId}`, { name: "Hijacked" }],
      ["GET", `/canteen/accounts/${accountId}/rules`],
      ["POST", `/canteen/accounts/${accountId}/rules`, { type: "FLAT", value: 1 }],
      ["PATCH", `/canteen/rules/${ruleId}`, { value: 1 }],
      ["DELETE", `/canteen/rules/${ruleId}`],
      ["GET", `/canteen/accounts/${accountId}/statement?from=2020-01-01&to=2020-01-31`],
      ["GET", `/canteen/accounts/${accountId}/statements`],
      ["POST", `/canteen/accounts/${accountId}/statements`, { from: "2021-01-01", to: "2021-01-02" }],
      ["PATCH", `/canteen/statements/${statementId}`, { status: "PAID" }],
      ["PATCH", `/canteen/members/${memberId}`, { name: "Hijacked" }],
      ["GET", `/canteen/members/${memberId}`],
      ["POST", `/canteen/members/${memberId}/topup`, { amount: 5000, mode: "UPI" }],
      ["POST", `/canteen/members/${memberId}/wallet/adjust`, { amount: 5000, note: "steal" }],
      ["POST", `/canteen/members/${memberId}/tokens`, { count: 1, unitPrice: 1000, mode: "UPI" }],
      ["PATCH", `/canteen/slots/${slotId}`, { name: "Hijacked" }],
      ["DELETE", `/canteen/slots/${slotId}`],
      ["GET", `/canteen/slots/${slotId}/items`],
      ["PUT", `/canteen/slots/${slotId}/items`, { items: [] }],
      ["POST", `/canteen/preorders/${preorderId}/cancel`, { reason: "hijack" }],
      ["POST", `/canteen/preorders/${preorderId}/serve`],
      ["GET", `/canteen/subscriptions/${subId}`],
      ["POST", `/canteen/subscriptions/${subId}/pause`],
      ["POST", `/canteen/subscriptions/${subId}/skips`, { date: addDays(today(), 2) }],
      ["POST", `/canteen/subscriptions/${subId}/cancel`, { refundMode: "CASH" }],
    ] as const;
    const leaks: string[] = [];
    for (const [m, p, b] of ids) {
      const r = await otherOwner.call(m, p, b);
      if (r.status !== 404) leaks.push(`${m} ${p} → ${r.status}`);
    }
    expect(leaks).toEqual([]);
    // Lists show only the caller's own rows.
    const accs = (await otherOwner.call("GET", "/canteen/accounts")).body as { id: string }[];
    expect(accs.map((a) => a.id)).toEqual([otherAccountId]);
    expect((await otherOwner.call("GET", `/canteen/members/lookup?q=${memberId}`)).status).toBe(404);
    // Foreign ids in bodies are refused as unknown.
    expect((await otherOwner.call("POST", "/canteen/members", { name: "X", phone: mobile(), corporateAccountId: accountId })).status).toBe(400);
    expect((await otherOwner.call("POST", `/canteen/accounts/${otherAccountId}/rules`, { type: "FLAT", value: 100, mealSlotId: slotId })).status).toBe(400);
    expect((await otherOwner.call("PUT", `/canteen/slots/${otherSlotId}/items`, { items: [{ menuItemId: h.items.chai }] })).status).toBe(400);
    expect((await otherOwner.call("POST", "/canteen/preorders", { date: addDays(today(), 1), slotId, items: [{ menuItemId: other.items.chai, quantity: 1 }] })).status).toBe(404);
    // Nothing changed on this hotel's side.
    expect((await db.corporateAccount.findUniqueOrThrow({ where: { id: accountId } })).name).toBe("Fixture Corp");
    expect(await db.corporateSubsidyRule.count({ where: { id: ruleId } })).toBe(1);
    expect((await db.mealSubscription.findUniqueOrThrow({ where: { id: subId } })).status).toBe("ACTIVE");
    // …and this hotel can't reach the other's either.
    expect((await owner.call("GET", `/canteen/members/${otherMemberId}`)).status).toBe(404);
    expect((await manager.call("GET", `/canteen/slots/${otherSlotId}/items`)).status).toBe(404);
  });
});

describe("corporate accounts", () => {
  it("create → 201 with integer money, unicode / XSS / SQL stored as inert text, smuggled fields ignored", async () => {
    for (const name of [NASTY.tamil, NASTY.hindi, NASTY.xss, NASTY.sql]) {
      const r = await owner.call("POST", "/canteen/accounts", { name, businessId: other.businessId, id: "evil-id", createdAt: "2000-01-01T00:00:00Z" });
      expect(r.status).toBe(201);
      expect(r.body.name).toBe(name);
      expect(r.body.businessId).toBe(h.businessId);
      expect(r.body.id).not.toBe("evil-id");
      expectPaise(r.body.creditLimit);
    }
    const list = await owner.call("GET", "/canteen/accounts");
    expect(list.status).toBe(200);
    const row = (list.body as { name: string; outstanding: number; _count: { members: number } }[]).find((a) => a.name === NASTY.tamil)!;
    expectPaise(row.outstanding);
    expect(row._count.members).toBe(0);
    expect(await db.customer.count()).toBeGreaterThan(0); // the SQL payload dropped nothing
  });

  it("duplicate name → 409; GSTIN upper-cased; PATCH updates; unknown id → 404", async () => {
    expect((await owner.call("POST", "/canteen/accounts", { name: "Fixture Corp" })).status).toBe(409);
    const r = await owner.call("POST", "/canteen/accounts", { name: "GST Corp", gstin: "33aaaaa0000a1z5", creditLimit: 500000, dailyMealLimit: 2 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ gstin: "33AAAAA0000A1Z5", creditLimit: 500000, dailyMealLimit: 2, billingCycle: "MONTHLY", active: true });
    const p = await owner.call("PATCH", `/canteen/accounts/${r.body.id}`, { active: false, businessId: other.businessId });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ active: false, businessId: h.businessId });
    expect((await owner.call("PATCH", `/canteen/accounts/${ID}`, { active: false })).status).toBe(404);
    expect((await owner.call("PATCH", `/canteen/accounts/${r.body.id}`, { name: "Fixture Corp" })).status).toBe(409);
  });

  it("invalid bodies → 400 and nothing written", async () => {
    const before = await db.corporateAccount.count({ where: { businessId: h.businessId } });
    const bad = [
      {},
      { name: "" },
      { name: "x" },
      { name: null },
      { name: 42 },
      { name: "a".repeat(10_000) },
      { name: "Ok Corp", gstin: "NOTAGSTIN" },
      { name: "Ok Corp", contactEmail: "not-an-email" },
      { name: "Ok Corp", contactPhone: "12345" },
      { name: "Ok Corp", billingCycle: "DAILY" },
      { name: "Ok Corp", dailyMealLimit: 0 },
      { name: "Ok Corp", dailyMealLimit: 21 },
      { name: "Ok Corp", active: "yes" },
      ...badInts("creditLimit", { name: "Ok Corp" }),
    ];
    const got = [];
    for (const b of bad) got.push((await owner.call("POST", "/canteen/accounts", b)).status);
    expect(got).toEqual(bad.map(() => 400));
    expect(await db.corporateAccount.count({ where: { businessId: h.businessId } })).toBe(before);
    // Malformed JSON is a 400 too.
    const raw = await fetch(`${srv.base}/canteen/accounts`, { method: "POST", headers: { authorization: `Bearer ${owner.token}`, "x-outlet-id": h.outletId, "content-type": "application/json" }, body: "{name:" });
    expect(raw.status).toBe(400);
    for (const b of badInts("creditLimit", {})) expect((await owner.call("PATCH", `/canteen/accounts/${accountId}`, b)).status).toBe(400);
  });
});

describe("subsidy rules", () => {
  it("create / list / patch / delete with conflicts, unknown slot and bad values refused", async () => {
    const acc = (await owner.call("POST", "/canteen/accounts", { name: `Rules Corp ${Date.now()}` })).body.id as string;
    const r = await owner.call("POST", `/canteen/accounts/${acc}/rules`, { type: "FLAT", value: 3000, maxPerDay: 6000, mealSlotId: slotId, corporateAccountId: accountId });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ corporateAccountId: acc, mealSlotId: slotId, value: 3000 });
    expect((await owner.call("POST", `/canteen/accounts/${acc}/rules`, { type: "FLAT", value: 1, mealSlotId: slotId })).status).toBe(409);
    expect((await owner.call("POST", `/canteen/accounts/${acc}/rules`, { type: "FLAT", value: 1, mealSlotId: ID })).status).toBe(400);
    expect((await owner.call("POST", `/canteen/accounts/${ID}/rules`, { type: "FLAT", value: 1 })).status).toBe(404);
    const bad = [{ type: "PERCENT", value: 101 }, { type: "FLAT" }, { value: 10 }, { type: "FLAT", value: -1 }, { type: "FLAT", value: 1.5 }, { type: "FLAT", value: 10, slotMealLimit: 0 }, { type: "FLAT", value: 10, maxPerMeal: -5 }];
    for (const b of bad) expect((await owner.call("POST", `/canteen/accounts/${acc}/rules`, b)).status, JSON.stringify(b)).toBe(400);
    expect((await owner.call("GET", `/canteen/accounts/${acc}/rules`)).body).toHaveLength(1);

    const p = await owner.call("PATCH", `/canteen/rules/${r.body.id}`, { value: 2500, corporateAccountId: accountId, id: "x" });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ id: r.body.id, corporateAccountId: acc, value: 2500 });
    expect((await owner.call("PATCH", `/canteen/rules/${r.body.id}`, { type: "PERCENT", value: 500 })).status).toBe(400);
    expect((await owner.call("PATCH", `/canteen/rules/${ID}`, { value: 1 })).status).toBe(404);
    expect((await owner.call("DELETE", `/canteen/rules/${r.body.id}`)).status).toBe(204);
    expect((await owner.call("DELETE", `/canteen/rules/${r.body.id}`)).status).toBe(404);
  });

  it("huge paise values are refused with 400, not a server error", async () => {
    const acc = (await owner.call("POST", "/canteen/accounts", { name: `Huge Corp ${Date.now()}` })).body.id as string;
    for (const b of [{ type: "FLAT", value: 1e12 }, { type: "FLAT", value: 100, maxPerMeal: 1e12 }, { type: "FLAT", value: 100, maxPerDay: 2 ** 31 }]) {
      expect((await owner.call("POST", `/canteen/accounts/${acc}/rules`, b)).status, JSON.stringify(b)).toBe(400);
    }
    expect(await db.corporateSubsidyRule.count({ where: { corporateAccountId: acc } })).toBe(0);
  });

  it("rule-slots lists only this outlet's slots", async () => {
    const r = await owner.call("GET", "/canteen/rule-slots");
    expect(r.status).toBe(200);
    expect((r.body as { id: string }[]).map((s) => s.id)).toContain(slotId);
    expect((r.body as { id: string }[]).map((s) => s.id)).not.toContain(otherSlotId);
  });
});

describe("statements", () => {
  it("statement JSON / xlsx / pdf; bad dates and from > to → 400", async () => {
    const j = await owner.call("GET", `/canteen/accounts/${accountId}/statement?from=2020-01-01&to=2020-01-31`);
    expect(j.status).toBe(200);
    expect(j.body).toMatchObject({ account: { id: accountId }, from: "2020-01-01", to: "2020-01-31", rows: [], refunds: [] });
    expectPaise(j.body.totals.net, j.body.totals.employerShare, j.body.totals.billTotal);
    const x = await owner.call("GET", `/canteen/accounts/${accountId}/statement?from=2020-01-01&to=2020-01-31&format=xlsx`);
    expect(x.status).toBe(200);
    expect(x.headers.get("content-type")).toMatch(/spreadsheet/);
    const pdf = await owner.call("GET", `/canteen/accounts/${accountId}/statement?from=2020-01-01&to=2020-01-31&format=pdf`);
    expect(pdf.headers.get("content-type")).toMatch(/pdf/);
    for (const q of ["", "?from=2020-01-01", "?from=2020-02-01&to=2020-01-01", "?from=01-01-2020&to=2020-01-31", "?from=2020-01-01&to=2020-01-31&format=csv", "?from=2020-13-01&to=2020-13-31", "?from=2020-02-30&to=2020-02-31"]) {
      expect((await owner.call("GET", `/canteen/accounts/${accountId}/statement${q}`)).status, q).toBe(400);
    }
    expect((await owner.call("GET", `/canteen/accounts/${ID}/statement?from=2020-01-01&to=2020-01-31`)).status).toBe(404);
  });

  it("raise → 201 (frozen totals), overlap → 409, status PATCH, validation → 400", async () => {
    const s = await owner.call("POST", `/canteen/accounts/${accountId}/statements`, { from: "2020-03-01", to: "2020-03-31", invoiceRef: NASTY.hindi, amount: 999999, meals: 50, status: "PAID" });
    expect(s.status).toBe(201);
    expect(s.body).toMatchObject({ amount: 0, meals: 0, status: "INVOICED", invoiceRef: NASTY.hindi });
    expect((await owner.call("POST", `/canteen/accounts/${accountId}/statements`, { from: "2020-03-15", to: "2020-04-15" })).status).toBe(409);
    for (const b of [{}, { from: "2020-05-01" }, { from: "2020-05-02", to: "2020-05-01" }, { from: "2020-05-01", to: "2020-05-31", invoiceRef: "x".repeat(61) }, { from: "2020-13-01", to: "2020-13-02" }]) {
      expect((await owner.call("POST", `/canteen/accounts/${accountId}/statements`, b)).status, JSON.stringify(b)).toBe(400);
    }
    const list = (await owner.call("GET", `/canteen/accounts/${accountId}/statements`)).body as { id: string }[];
    expect(list.length).toBe(2);
    const paid = await owner.call("PATCH", `/canteen/statements/${s.body.id}`, { status: "PAID", amount: 1 });
    expect(paid.status).toBe(200);
    expect(paid.body.status).toBe("PAID");
    expect(paid.body.amount).toBe(0);
    expect(paid.body.paidAt).toBeTruthy();
    expect((await owner.call("PATCH", `/canteen/statements/${s.body.id}`, {})).status).toBe(400);
    expect((await owner.call("PATCH", `/canteen/statements/${ID}`, { status: "PAID" })).status).toBe(404);
  });
});

describe("members", () => {
  it("create 201 / re-enrol same phone 200 / card clash 409; wallet can't be set through the body", async () => {
    const phone = mobile();
    const r = await owner.call("POST", "/canteen/members", { name: NASTY.tamil, phone, cardUid: "qa-card-1", walletBalance: 999999, canteenMember: false, businessId: other.businessId });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ name: NASTY.tamil, phone, cardUid: "QA-CARD-1", walletBalance: 0, memberActive: true });
    expectNoSecrets(r.body);
    expect((await db.customer.findUniqueOrThrow({ where: { id: r.body.id } })).businessId).toBe(h.businessId);
    expect((await owner.call("POST", "/canteen/members", { name: "Clash", phone: mobile(), cardUid: "QA-CARD-1" })).status).toBe(409);
    // Re-enrolling the same phone updates the member and keeps what wasn't sent (the card).
    const again = await owner.call("POST", "/canteen/members", { name: "Renamed", phone, employeeCode: "E-9" });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ id: r.body.id, name: "Renamed", employeeCode: "E-9", cardUid: "QA-CARD-1" });
    const p = await owner.call("PATCH", `/canteen/members/${r.body.id}`, { walletBalance: 5_00_000, department: NASTY.xss });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ walletBalance: 0, department: NASTY.xss });
    expect((await owner.call("PATCH", `/canteen/members/${ID}`, { name: "x" })).status).toBe(404);
    // A plain customer (not a member) isn't reachable through the member routes.
    const plain = await db.customer.create({ data: { businessId: h.businessId, phone: mobile(), name: "Walk-in" } });
    expect((await owner.call("PATCH", `/canteen/members/${plain.id}`, { name: "x" })).status).toBe(404);
    expect((await cashier.call("GET", `/canteen/members/${plain.id}`)).status).toBe(404);
    expect((await cashier.call("POST", `/canteen/members/${plain.id}/topup`, { amount: 5000, mode: "UPI" })).status).toBe(404);
  });

  it("invalid member bodies → 400, nothing written", async () => {
    const before = await db.customer.count({ where: { businessId: h.businessId } });
    const bad = [
      {},
      { name: "X" },
      { name: "", phone: mobile() },
      { name: "X", phone: "12345" },
      { name: "X", phone: 9876543210 },
      { name: "a".repeat(10_000), phone: mobile() },
      { name: "X", phone: mobile(), cardUid: "bad card!" },
      { name: "X", phone: mobile(), cardUid: "A".repeat(65) },
      { name: "X", phone: mobile(), corporateAccountId: ID },
      { name: "X", phone: mobile(), memberActive: "no" },
    ];
    const got = [];
    for (const b of bad) got.push((await owner.call("POST", "/canteen/members", b)).status);
    expect(got).toEqual(bad.map(() => 400));
    expect(await db.customer.count({ where: { businessId: h.businessId } })).toBe(before);
  });

  it("list: pagination, search, account filter, limit caps, wallet liability in paise", async () => {
    const acc = (await owner.call("POST", "/canteen/accounts", { name: `Page Corp ${Date.now()}` })).body.id;
    for (let i = 0; i < 3; i++) await owner.call("POST", "/canteen/members", { name: `Pager ${i}`, phone: mobile(), corporateAccountId: acc });
    const p1 = await owner.call("GET", `/canteen/members?accountId=${acc}&limit=2&page=1`);
    expect(p1.status).toBe(200);
    expect(p1.body).toMatchObject({ total: 3, page: 1, limit: 2 });
    expect(p1.body.items).toHaveLength(2);
    expectPaise(p1.body.walletLiability);
    const p2 = await owner.call("GET", `/canteen/members?accountId=${acc}&limit=2&page=2`);
    expect(p2.body.items).toHaveLength(1);
    expect((await owner.call("GET", `/canteen/members?accountId=${acc}&page=9`)).body.items).toEqual([]);
    expect((await owner.call("GET", "/canteen/members?search=zz-no-such-member")).body).toMatchObject({ items: [], total: 0 });
    expect((await owner.call("GET", `/canteen/members?search=${encodeURIComponent(NASTY.sql)}`)).status).toBe(200);
    for (const q of ["limit=0", "limit=201", "limit=abc", "page=0", "page=-1", "limit=1.5", `search=${"a".repeat(101)}`]) {
      expect((await owner.call("GET", `/canteen/members?${q}`)).status, q).toBe(400);
    }
    expect((await owner.call("GET", "/canteen/members?limit=200")).status).toBe(200);
  });

  it("lookup by card / code / phone; unknown → 404; empty / long q → 400", async () => {
    const m = await db.customer.findUniqueOrThrow({ where: { id: memberId } });
    const r = await cashier.call("GET", `/canteen/members/lookup?q=${m.cardUid}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: memberId, account: { id: accountId } });
    expectPaise(r.body.walletBalance, r.body.subsidyUsedToday);
    expectNoSecrets(r.body);
    expect((await cashier.call("GET", `/canteen/members/lookup?q=${m.phone}`)).body.id).toBe(memberId);
    expect((await cashier.call("GET", "/canteen/members/lookup?q=NOPE-NOPE")).status).toBe(404);
    for (const q of ["", "?q=", `?q=${"x".repeat(65)}`]) expect((await cashier.call("GET", `/canteen/members/lookup${q}`)).status, q).toBe(400);
  });

  it("import: row errors reported, good rows saved; empty / >2000 rows / bad shape → 400", async () => {
    const r = await owner.call("POST", "/canteen/members/import", {
      corporateAccountId: accountId,
      rows: [{ name: "Imp A", phone: mobile() }, { name: "", phone: mobile() }, { name: "Imp C", phone: "123" }, { name: NASTY.hindi, phone: mobile(), cardUid: "imp-card" }],
    });
    expect(r.status).toBe(200);
    expect(r.body.created).toBe(2);
    expect(r.body.errors.map((e: { row: number }) => e.row)).toEqual([2, 3]);
    for (const b of [{ rows: [] }, {}, { rows: "x" }, { rows: [{ phone: mobile() }] }, { rows: Array.from({ length: 2001 }, () => ({ name: "x", phone: "9" })) }, { corporateAccountId: ID, rows: [{ name: "x", phone: mobile() }] }]) {
      expect((await owner.call("POST", "/canteen/members/import", b)).status).toBe(400);
    }
  });

  it("member detail: wallet ledger and tokens, no secrets", async () => {
    const r = await cashier.call("GET", `/canteen/members/${memberId}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: memberId, walletLedger: expect.any(Array), tokens: expect.any(Array) });
    expectNoSecrets(r.body);
    expect((await cashier.call("GET", `/canteen/members/${ID}`)).status).toBe(404);
  });
});

describe("wallets", () => {
  let w: string;
  beforeAll(async () => {
    w = (await owner.call("POST", "/canteen/members", { name: "Wallet Holder", phone: mobile() })).body.id;
  });
  const balance = async () => (await db.customer.findUniqueOrThrow({ where: { id: w } })).walletBalance;

  it("top-up 201 with ledger row; bad amounts / modes → 400 with no money moved", async () => {
    const r = await cashier.call("POST", `/canteen/members/${w}/topup`, { amount: 10000, mode: "UPI", reference: NASTY.tamil, customerId: memberId, outletId: h.outlet2Id });
    expect(r.status).toBe(201);
    expect(r.body.walletBalance).toBe(10000);
    expect(r.body.txn).toMatchObject({ customerId: w, outletId: h.outletId, type: "TOPUP", amount: 10000, mode: "UPI" });
    expectPaise(r.body.txn.amount);
    const bad = [{ amount: 999, mode: "UPI" }, { amount: 1_000_001, mode: "UPI" }, { amount: 1500.5, mode: "UPI" }, { amount: "5000", mode: "UPI" }, { amount: -5000, mode: "UPI" }, { amount: 5000, mode: "WALLET" }, { amount: 5000 }, { amount: null, mode: "UPI" }, { amount: 5000, mode: "UPI", reference: "x".repeat(101) }];
    for (const b of bad) expect((await cashier.call("POST", `/canteen/members/${w}/topup`, b)).status, JSON.stringify(b)).toBe(400);
    expect(await balance()).toBe(10000);
    expect(await db.walletTxn.count({ where: { customerId: w } })).toBe(1);
    expect((await cashier.call("POST", `/canteen/members/${ID}/topup`, { amount: 5000, mode: "UPI" })).status).toBe(404);
  });

  it("an inactive card can't be topped up or sold tokens", async () => {
    const m = (await owner.call("POST", "/canteen/members", { name: "Inactive", phone: mobile(), memberActive: false })).body.id;
    expect((await cashier.call("POST", `/canteen/members/${m}/topup`, { amount: 5000, mode: "UPI" })).status).toBe(400);
    expect((await cashier.call("POST", `/canteen/members/${m}/tokens`, { count: 1, unitPrice: 1000, mode: "UPI" })).status).toBe(400);
  });

  it("adjust: a deduction never takes the balance below zero; huge / zero / float amounts → 400", async () => {
    expect((await owner.call("POST", `/canteen/members/${w}/wallet/adjust`, { amount: -10001, note: "too much" })).status).toBe(400);
    expect(await balance()).toBe(10000);
    for (const b of [{ amount: 0, note: "zero" }, { amount: 1.5, note: "float" }, { amount: -100, note: "x" }, { amount: 100 }, { amount: "100", note: "str" }, { amount: 1e12, note: "huge" }, { amount: -1e12, note: "huge" }, { amount: 2 ** 31, note: "overflow" }]) {
      expect((await owner.call("POST", `/canteen/members/${w}/wallet/adjust`, b)).status, JSON.stringify(b)).toBe(400);
    }
    expect(await balance()).toBe(10000);
    const ok = await owner.call("POST", `/canteen/members/${w}/wallet/adjust`, { amount: -4000, note: "correction" });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ id: w, walletBalance: 6000 });
  });

  it("concurrent deductions can't overdraw (compare-and-set)", async () => {
    // 6000 left: of 8 parallel −2000 adjustments exactly 3 succeed.
    expect(await balance()).toBe(6000);
    const rs = await Promise.all(Array.from({ length: 8 }, () => owner.call("POST", `/canteen/members/${w}/wallet/adjust`, { amount: -2000, note: "race" })));
    expect(rs.filter((r) => r.status === 200)).toHaveLength(3);
    expect(rs.filter((r) => r.status === 400)).toHaveLength(5);
    expect(await balance()).toBe(0);
    const ledger = await db.walletTxn.aggregate({ where: { customerId: w }, _sum: { amount: true } });
    expect(ledger._sum.amount).toBe(0);
  });

  it("no double spend: two bills paid by wallet at once when the balance covers only one", async () => {
    await cashier.call("POST", `/canteen/members/${w}/topup`, { amount: 16000, mode: "UPI" });
    const bill = async () => (await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.biryani, quantity: 1 }], memberId: w })).body as { id: string; grandTotal: number };
    const [a, b] = [await bill(), await bill()];
    expect(a.grandTotal).toBe(16000);
    const rs = await Promise.all([a, b].map((o) => cashier.call("POST", `/orders/${o.id}/payments`, { payments: [{ mode: "WALLET", amount: 16000 }] })));
    expect(rs.map((r) => r.status).sort()).toEqual([200, 400]);
    expect(await balance()).toBe(0);
    const spent = await db.walletTxn.count({ where: { customerId: w, type: "SPEND" } });
    expect(spent).toBe(1);
  });
});

describe("meal tokens", () => {
  it("buy → 201 (value = count × price); bad counts / prices / slots → 400", async () => {
    const r = await cashier.call("POST", `/canteen/members/${memberId}/tokens`, { mealSlotId: slotId, count: 3, unitPrice: 4000, mode: "UPI", balance: 999, value: 1 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ balance: 3, value: 12000, mealSlotId: slotId });
    const bad = [
      { count: 0, unitPrice: 4000, mode: "UPI" },
      { count: 201, unitPrice: 4000, mode: "UPI" },
      { count: 1.5, unitPrice: 4000, mode: "UPI" },
      { count: 1, unitPrice: 99, mode: "UPI" },
      { count: 1, unitPrice: 500_001, mode: "UPI" },
      { count: 1, unitPrice: 4000, mode: "CORPORATE" },
      { count: 1, unitPrice: 4000, mode: "UPI", mealSlotId: ID },
      { count: 1, unitPrice: 4000, mode: "UPI", mealSlotId: otherSlotId },
    ];
    for (const b of bad) expect((await cashier.call("POST", `/canteen/members/${memberId}/tokens`, b)).status, JSON.stringify(b)).toBe(400);
    const acc = await db.mealTokenAccount.findFirstOrThrow({ where: { customerId: memberId, mealSlotId: slotId } });
    expect(acc).toMatchObject({ balance: 3, value: 12000 });
  });
});

describe("meal slots", () => {
  it("create / patch / delete; bad times → 400; unknown / other outlet's slot → 404", async () => {
    const r = await manager.call("POST", "/canteen/slots", { name: NASTY.tamil, startTime: "15:00", endTime: "16:00", outletId: h.outlet2Id });
    expect(r.status).toBe(201);
    expect(r.body.slot).toMatchObject({ name: NASTY.tamil, outletId: h.outletId, preorderCutoff: null, active: true });
    expect(Array.isArray(r.body.warnings)).toBe(true);
    const bad = [{}, { name: "X", startTime: "24:00", endTime: "01:00" }, { name: "X", startTime: "10:00", endTime: "10:00" }, { name: "", startTime: "10:00", endTime: "11:00" }, { name: "x".repeat(41), startTime: "10:00", endTime: "11:00" }, { name: "X", startTime: "10:00", endTime: "11:00", sortOrder: -1 }, { name: "X", startTime: "9:00", endTime: "11:00" }];
    for (const b of bad) expect((await manager.call("POST", "/canteen/slots", b)).status, JSON.stringify(b)).toBe(400);
    expect((await manager.call("PATCH", `/canteen/slots/${r.body.slot.id}`, { endTime: "15:00" })).status).toBe(400);
    expect((await manager.call("PATCH", `/canteen/slots/${r.body.slot.id}`, { sortOrder: 1000 })).status).toBe(400);
    const p = await manager.call("PATCH", `/canteen/slots/${r.body.slot.id}`, { name: "Tea", outletId: h.outlet2Id });
    expect(p.status).toBe(200);
    expect(p.body.slot).toMatchObject({ name: "Tea", outletId: h.outletId });
    expect((await manager.call("PATCH", `/canteen/slots/${ID}`, { name: "x" })).status).toBe(404);
    // Outlet 2's slot isn't visible from outlet 1.
    const s2 = (await owner.call("POST", "/canteen/slots", { name: "Outlet2", startTime: "08:00", endTime: "09:00" }, { "x-outlet-id": h.outlet2Id })).body.slot.id;
    expect((await owner.call("PATCH", `/canteen/slots/${s2}`, { name: "x" })).status).toBe(404);
    expect((await owner.call("DELETE", `/canteen/slots/${s2}`)).status).toBe(404);
    expect((await manager.call("GET", "/canteen/slots")).body.slots.map((s: { id: string }) => s.id)).not.toContain(s2);
    const d = await manager.call("DELETE", `/canteen/slots/${r.body.slot.id}`);
    expect(d.body).toEqual({ deleted: true, deactivated: false });
    expect((await manager.call("DELETE", `/canteen/slots/${r.body.slot.id}`)).status).toBe(404);
    // A slot with history is switched off, not deleted.
    expect((await manager.call("DELETE", `/canteen/slots/${slotId}`)).body).toEqual({ deleted: false, deactivated: true });
    await manager.call("PATCH", `/canteen/slots/${slotId}`, { active: true });
  });

  it("slot menu: replace, unknown / duplicate / foreign items and bad prices → 400", async () => {
    const r = await manager.call("PUT", `/canteen/slots/${slotId}/items`, { items: [{ menuItemId: h.items.chai, price: 1200 }, { menuItemId: h.items.samosa }] });
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(2);
    expectPaise(r.body.find((i: { menuItemId: string }) => i.menuItemId === h.items.chai).price);
    const bad = [{}, { items: "x" }, { items: [{ menuItemId: ID }] }, { items: [{ menuItemId: other.items.chai }] }, { items: [{ menuItemId: h.items.chai }, { menuItemId: h.items.chai }] }, { items: [{ menuItemId: h.items.chai, price: -1 }] }, { items: [{ menuItemId: h.items.chai, price: 10.5 }] }];
    for (const b of bad) expect((await manager.call("PUT", `/canteen/slots/${slotId}/items`, b)).status, JSON.stringify(b)).toBe(400);
    const items = await cashier.call("GET", `/canteen/slots/${slotId}/items`);
    expect(items.body).toHaveLength(2);
    expect((await manager.call("PUT", `/canteen/slots/${ID}/items`, { items: [] })).status).toBe(404);
    await manager.call("PUT", `/canteen/slots/${slotId}/items`, { items: [] });
  });
});

describe("pre-orders", () => {
  it("book → 201 PRE_ORDER with server prices; bad bodies → 400 (nothing written); unknown slot → 404", async () => {
    const r = await cashier.call("POST", "/canteen/preorders", { date: addDays(today(), 1), slotId, items: [{ menuItemId: h.items.samosa, quantity: 2, unitPrice: 1 }], customerName: NASTY.hindi, grandTotal: 1, status: "PAID" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ orderType: "PRE_ORDER", mealSlotId: slotId, status: "OPEN", customerName: NASTY.hindi });
    expect(r.body.grandTotal).toBe(6000);
    expectPaise(r.body.grandTotal);
    const before = await db.order.count({ where: { outletId: h.outletId } });
    const bad = [
      {},
      { date: addDays(today(), 1), slotId, items: [] },
      { date: "tomorrow", slotId, items: [{ menuItemId: h.items.chai, quantity: 1 }] },
      { date: addDays(today(), 1), slotId, items: [{ menuItemId: h.items.chai, quantity: 0 }] },
      { date: addDays(today(), 1), slotId, items: [{ menuItemId: h.items.chai, quantity: 1.5 }] },
      { date: addDays(today(), 1), slotId, items: [{ menuItemId: h.items.chai, quantity: 1000 }] },
      { date: addDays(today(), 1), slotId, items: [{ menuItemId: h.items.chai, quantity: 1 }], customerPhone: "123" },
      { date: addDays(today(), 1), slotId, items: [{ menuItemId: h.items.chai, quantity: 1 }], notes: "x".repeat(301) },
      { date: addDays(today(), -1), slotId, items: [{ menuItemId: h.items.chai, quantity: 1 }] },
      { date: "2026-13-45", slotId, items: [{ menuItemId: h.items.chai, quantity: 1 }] },
    ];
    for (const b of bad) expect((await cashier.call("POST", "/canteen/preorders", b)).status, JSON.stringify(b)).toBe(400);
    expect((await cashier.call("POST", "/canteen/preorders", { date: addDays(today(), 1), slotId: ID, items: [{ menuItemId: h.items.chai, quantity: 1 }] })).status).toBe(404);
    expect(await db.order.count({ where: { outletId: h.outletId } })).toBe(before);
  });

  it("list by date (IST), invalid dates → 400, foreign slot filter shows nothing", async () => {
    const r = await cashier.call("GET", `/canteen/preorders?date=${addDays(today(), 1)}`);
    expect(r.status).toBe(200);
    expect(r.body.date).toBe(addDays(today(), 1));
    const ids = (r.body.preorders as { id: string; grandTotal: number }[]).map((p) => p.id);
    expect(ids).toContain(preorderId);
    for (const p of r.body.preorders) expectPaise(p.grandTotal, p.amountPaid);
    expect((await cashier.call("GET", "/canteen/preorders?date=2001-01-01")).body.preorders).toEqual([]);
    expect((await cashier.call("GET", `/canteen/preorders?date=${addDays(today(), 1)}&slotId=${otherSlotId}`)).body.preorders).toEqual([]);
    for (const q of ["date=01-01-2026", "date=2026-1-1", "date=2026-13-45", "date=2026-02-30"]) expect((await cashier.call("GET", `/canteen/preorders?${q}`)).status, q).toBe(400);
  });

  it("cancel: short reason → 400, unknown → 404, twice → 409; serve: unknown → 404, unpaid → 409", async () => {
    const o = (await cashier.call("POST", "/canteen/preorders", { date: addDays(today(), 1), slotId, items: [{ menuItemId: h.items.chai, quantity: 1 }] })).body;
    expect((await manager.call("POST", `/canteen/preorders/${o.id}/serve`)).status).toBe(409);
    for (const b of [{}, { reason: "x" }, { reason: "x".repeat(201) }, { reason: "valid reason", refundMode: "BITCOIN" }]) expect((await manager.call("POST", `/canteen/preorders/${o.id}/cancel`, b)).status).toBe(400);
    expect((await manager.call("POST", `/canteen/preorders/${ID}/cancel`, { reason: "no such" })).status).toBe(404);
    const ok = await manager.call("POST", `/canteen/preorders/${o.id}/cancel`, { reason: "changed mind" });
    expect(ok.status).toBe(200);
    expect((await manager.call("POST", `/canteen/preorders/${o.id}/cancel`, { reason: "changed mind" })).status).toBe(409);
    expect((await cashier.call("POST", `/canteen/preorders/${ID}/serve`)).status).toBe(404);
    // A normal takeaway bill isn't a pre-order.
    const plain = (await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.chai, quantity: 1 }] })).body.id;
    expect((await manager.call("POST", `/canteen/preorders/${plain}/cancel`, { reason: "not a preorder" })).status).toBe(404);
  });
});

describe("production plan", () => {
  it("json / xlsx; invalid dates → 400", async () => {
    const r = await manager.call("GET", `/canteen/production?date=${addDays(today(), 1)}`);
    expect(r.status).toBe(200);
    expect(r.body.date).toBe(addDays(today(), 1));
    expect(Array.isArray(r.body.slots)).toBe(true);
    expect((await manager.call("GET", "/canteen/production?format=xlsx")).headers.get("content-type")).toMatch(/spreadsheet/);
    for (const q of ["date=x", "date=2026-13-45", "date=2026-02-30", "format=csv"]) expect((await manager.call("GET", `/canteen/production?${q}`)).status, q).toBe(400);
  });
});

describe("subscriptions", () => {
  it("list / detail; bad status → 400; unknown → 404", async () => {
    const l = await manager.call("GET", "/canteen/subscriptions?status=ACTIVE");
    expect(l.status).toBe(200);
    expect((l.body as { id: string }[]).map((s) => s.id)).toContain(subId);
    expect((await manager.call("GET", "/canteen/subscriptions?status=BOGUS")).status).toBe(400);
    const d = await manager.call("GET", `/canteen/subscriptions/${subId}`);
    expect(d.status).toBe(200);
    expect(d.body.id).toBe(subId);
    expectNoSecrets(d.body);
    expect((await manager.call("GET", `/canteen/subscriptions/${ID}`)).status).toBe(404);
  });

  it("create: invalid bodies → 400 and no bill written; price comes from the menu", async () => {
    const cust = (await db.customer.create({ data: { businessId: h.businessId, phone: mobile(), name: "Sub Val" } })).id;
    const base = { customerId: cust, slotId, menuItemId: h.items.chai, daysOfWeek: [0, 1, 2, 3, 4], startDate: addDays(today(), 1), endDate: addDays(today(), 10), paymentMode: "CASH" };
    const before = await db.order.count({ where: { outletId: h.outletId } });
    const bad = [
      {},
      { ...base, daysOfWeek: [] },
      { ...base, daysOfWeek: [7] },
      { ...base, startDate: addDays(today(), 5), endDate: addDays(today(), 1) },
      { ...base, startDate: addDays(today(), -3) },
      { ...base, paymentMode: "WALLET" },
      { ...base, pricePerMeal: -1 },
      { ...base, pricePerMeal: 10.5 },
      { ...base, customerId: ID },
      { ...base, customerId: otherMemberId },
      { ...base, menuItemId: other.items.chai },
      { ...base, startDate: "2026-13-01" },
      { ...base, endDate: addDays(today(), 4000) },
    ];
    for (const b of bad) {
      const r = await manager.call("POST", "/canteen/subscriptions", b);
      expect([400], JSON.stringify(b).slice(0, 200)).toContain(r.status);
    }
    expect((await manager.call("POST", "/canteen/subscriptions", { ...base, slotId: ID })).status).toBe(404);
    expect(await db.order.count({ where: { outletId: h.outletId } })).toBe(before);
  });

  it("pause / resume / skip / unskip / cancel lifecycle with conflicts", async () => {
    expect((await manager.call("POST", `/canteen/subscriptions/${subId}/pause`)).status).toBe(200);
    expect((await manager.call("POST", `/canteen/subscriptions/${subId}/pause`)).status).toBe(409);
    expect((await manager.call("POST", `/canteen/subscriptions/${subId}/resume`)).status).toBe(200);
    expect((await manager.call("POST", `/canteen/subscriptions/${subId}/resume`)).status).toBe(409);
    const day = addDays(today(), 3);
    for (const b of [{}, { date: "x" }, { date: "2026-13-45" }, { date: day, force: "yes" }]) expect((await manager.call("POST", `/canteen/subscriptions/${subId}/skips`, b)).status, JSON.stringify(b)).toBe(400);
    expect((await manager.call("POST", `/canteen/subscriptions/${subId}/skips`, { date: addDays(today(), 60) })).status).toBe(400);
    expect((await manager.call("POST", `/canteen/subscriptions/${subId}/skips`, { date: day })).status).toBe(200);
    expect((await manager.call("POST", `/canteen/subscriptions/${subId}/skips`, { date: day })).status).toBe(409);
    expect((await manager.call("DELETE", `/canteen/subscriptions/${subId}/skips/not-a-date`)).status).toBe(400);
    expect((await manager.call("DELETE", `/canteen/subscriptions/${subId}/skips/${day}`)).status).toBe(200);
    for (const b of [{}, { refundMode: "BITCOIN" }, { refundMode: "CASH", note: "x".repeat(301) }]) expect((await manager.call("POST", `/canteen/subscriptions/${subId}/cancel`, b)).status).toBe(400);
    const cancel = await manager.call("POST", `/canteen/subscriptions/${subId}/cancel`, { refundMode: "CASH", note: NASTY.tamil });
    expect(cancel.status).toBe(200);
    expect((await manager.call("POST", `/canteen/subscriptions/${subId}/cancel`, { refundMode: "CASH" })).status).toBe(409);
    expect((await manager.call("POST", `/canteen/subscriptions/${subId}/pause`)).status).toBe(409);
    expect((await manager.call("POST", `/canteen/subscriptions/${ID}/cancel`, { refundMode: "CASH" })).status).toBe(404);
  });
});

