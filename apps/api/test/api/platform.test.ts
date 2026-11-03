/**
 * QA Phase 6 — /platform (Super Admin console; PLATFORM_SUPPORT read-only) and
 * /support-access (owner side). Contract, privacy (account info only), validation,
 * mass assignment, idempotency, cross-tenant.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotel, startServer, type Hotel } from "../integration/helpers";
import { addUser, cast, createPlatformAdmin, db, expectAuthz, expectNoSecrets, HUGE, NASTY, signIn, uniqPhone, type Cast, type Session } from "./kit-auth";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel, other: Hotel;
let c: Cast;
let admin: Session, support: Session, owner: Session, otherOwner: Session;

beforeAll(async () => {
  srv = await startServer();
  [h, other] = [await createHotel("Platform API"), await createHotel("Platform Other")];
  c = await cast(srv.base, h);
  owner = c.clients.BUSINESS_OWNER;
  otherOwner = await signIn(srv.base, other.users.owner.email, other.outletId);
  admin = await signIn(srv.base, (await createPlatformAdmin()).email);
  support = await signIn(srv.base, (await addUser(null, "PLATFORM_SUPPORT")).email);
});
afterAll(() => srv.close());

const newBusiness = (over: Record<string, unknown> = {}) => ({
  name: "Saravana Bhavan ☕",
  modules: ["BILLING"],
  owner: { name: "Owner One", phone: uniqPhone(), email: `owner.${Date.now()}.${Math.random().toString(36).slice(2)}@it.local` },
  outlet: { name: "Main", stateCode: "33" },
  ...over,
});

describe("authorization", () => {
  const READS = ["/platform/summary", "/platform/businesses", "/platform/support-grants", "/platform/admins"];
  const WRITES: [string, string][] = [
    ["POST", "/platform/businesses"],
    ["PATCH", "/platform/businesses/cl0000000000000000000000"],
    ["POST", "/platform/businesses/cl0000000000000000000000/users"],
    ["POST", "/platform/admins"],
    ["POST", "/platform/businesses/cl0000000000000000000000/owners/cl0000000000000000000000/reset-link"],
    ["POST", "/platform/businesses/cl0000000000000000000000/owners/cl0000000000000000000000/reset-2fa"],
  ];

  it("every hotel role (owner included) → 403 on every platform route", async () => {
    for (const p of READS) await expectAuthz(c, "GET", p, []);
    for (const [m, p] of WRITES) await expectAuthz(c, m, p, [], {});
    await expectAuthz(c, "GET", `/platform/businesses/${h.businessId}`, []);
  });

  it("platform support reads everything, writes nothing (403 before validation)", async () => {
    for (const p of READS) expect((await support.call("GET", p)).status, p).toBe(200);
    for (const [m, p] of WRITES) expect((await support.call(m, p, {})).status, `${m} ${p}`).toBe(403);
  });

  it("the super admin: reads 200; writes reach validation (400 / 404, not 403)", async () => {
    for (const p of READS) expect((await admin.call("GET", p)).status, p).toBe(200);
    for (const [m, p] of WRITES) expect([400, 404], `${m} ${p}`).toContain((await admin.call(m, p, {})).status);
  });
});

describe("businesses", () => {
  it("POST: 201 with business, outlet, owner (no secrets); mass-assigned status/features/id ignored", async () => {
    const body = newBusiness({ status: "SUSPENDED", features: { REQUIRE_2FA: true }, id: "cl4444444444444444444444", owner: { name: NASTY.tamil, phone: uniqPhone(), email: `Mixed.${Date.now()}@IT.local`, role: "SUPER_ADMIN" } });
    const r = await admin.call("POST", "/platform/businesses", body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expectNoSecrets(r.body);
    expect(r.body.business).toMatchObject({ name: "Saravana Bhavan ☕", status: "ACTIVE", modules: ["BILLING"] });
    expect(r.body.business.id).not.toBe("cl4444444444444444444444");
    expect(r.body.owner).toMatchObject({ role: "BUSINESS_OWNER", name: NASTY.tamil, email: (body.owner as { email: string }).email.toLowerCase() });
    const row = await db.user.findUniqueOrThrow({ where: { id: r.body.owner.id } });
    expect(row.passwordHash).toBeNull(); // the owner sets it from the invite link
    expect(r.body.outlet).toMatchObject({ businessId: r.body.business.id, stateCode: "33" });
  });

  it.each([
    ["no modules", { modules: [] }],
    ["unknown module", { modules: ["CASINO"] }],
    ["1-char name", { name: "A" }],
    ["10k name", { name: HUGE }],
    ["bad owner phone", { owner: { name: "Own Er", phone: "123" } }],
    ["no owner", { owner: undefined }],
    ["bad state code", { outlet: { name: "Main", stateCode: "TN" } }],
    ["notes too long", { notes: HUGE }],
    ["bad email", { email: "nope" }],
  ])("POST 400 on %s (nothing created)", async (_n, over) => {
    const before = await db.business.count();
    expect((await admin.call("POST", "/platform/businesses", newBusiness(over))).status).toBe(400);
    expect(await db.business.count()).toBe(before);
  });

  it("POST 409 when the owner's phone or email is already registered (nothing created)", async () => {
    const existing = await db.user.findUniqueOrThrow({ where: { id: h.users.cashier.id } });
    const before = await db.business.count();
    expect((await admin.call("POST", "/platform/businesses", newBusiness({ owner: { name: "Dup Phone", phone: existing.phone } }))).status).toBe(409);
    expect((await admin.call("POST", "/platform/businesses", newBusiness({ owner: { name: "Dup Mail", phone: uniqPhone(), email: existing.email!.toUpperCase() } }))).status).toBe(409);
    expect(await db.business.count()).toBe(before);
  });

  it("GET list / detail: account information only — no hotel staff, bills or secrets; search is inert text", async () => {
    const list = await admin.call("GET", "/platform/businesses");
    expectNoSecrets(list.body);
    const mine = list.body.find((b: { id: string }) => b.id === h.businessId);
    expect(mine.owners.map((o: { id: string }) => o.id)).toEqual([h.users.owner.id]);
    expect(mine).not.toHaveProperty("users");
    const d = await admin.call("GET", `/platform/businesses/${h.businessId}`);
    expect(d.status).toBe(200);
    expectNoSecrets(d.body);
    const text = JSON.stringify(d.body);
    for (const id of [h.users.cashier.id, h.users.manager.id]) expect(text).not.toContain(id);
    expect(d.body).not.toHaveProperty("orders");
    expect(Object.keys(d.body.owners[0]).sort()).toEqual(["createdAt", "email", "id", "name", "phone", "status", "totpEnabledAt"]);
    expect((await admin.call("GET", "/platform/businesses/cl0000000000000000000000")).status).toBe(404);
    for (const q of [NASTY.sql, "%", "_", NASTY.xss]) {
      const r = await admin.call("GET", `/platform/businesses?search=${encodeURIComponent(q)}`);
      expect(r.status, q).toBe(200);
    }
  });

  it("PATCH: 404 unknown, 400 invalid; suspending signs the hotel out at once; reactivating lets them back in", async () => {
    const b = await createHotel("Patch me");
    const o = await signIn(srv.base, b.users.owner.email, b.outletId);
    expect((await admin.call("PATCH", "/platform/businesses/cl0000000000000000000000", { name: "Ghost" })).status).toBe(404);
    for (const body of [{ status: "DELETED" }, { modules: [] }, { features: { NOT_A_FLAG: true } }, { features: { REQUIRE_2FA: "yes" } }, { name: "" }])
      expect((await admin.call("PATCH", `/platform/businesses/${b.businessId}`, body)).status, JSON.stringify(body)).toBe(400);
    const s = await admin.call("PATCH", `/platform/businesses/${b.businessId}`, { status: "SUSPENDED", id: "cl5555555555555555555555" });
    expect(s.status).toBe(200);
    expect(s.body).toMatchObject({ id: b.businessId, status: "SUSPENDED" });
    expect((await o.call("GET", "/auth/me")).status).toBe(401);
    expect((await admin.call("PATCH", `/platform/businesses/${b.businessId}`, { status: "ACTIVE" })).status).toBe(200);
    expect((await signIn(srv.base, b.users.owner.email, b.outletId).then((x) => x.call("GET", "/auth/me"))).status).toBe(200);
  });

  it("POST /:id/users creates owners only (role in body can't escalate); 404 unknown business; 409 duplicate", async () => {
    expect((await admin.call("POST", `/platform/businesses/${h.businessId}/users`, { name: "Promoted", phone: uniqPhone(), role: "SUPER_ADMIN" })).status).toBe(400);
    expect((await admin.call("POST", `/platform/businesses/${h.businessId}/users`, { name: "Manager", phone: uniqPhone(), role: "OUTLET_MANAGER" })).status).toBe(400);
    expect((await admin.call("POST", "/platform/businesses/cl0000000000000000000000/users", { name: "Ghost", phone: uniqPhone() })).status).toBe(404);
    const r = await admin.call("POST", `/platform/businesses/${h.businessId}/users`, { name: "Second Owner", phone: uniqPhone() });
    expect(r.status).toBe(201);
    expectNoSecrets(r.body);
    expect((await db.user.findUniqueOrThrow({ where: { id: r.body.id } })).role).toBe("BUSINESS_OWNER");
    const existing = await db.user.findUniqueOrThrow({ where: { id: h.users.cashier.id } });
    expect((await admin.call("POST", `/platform/businesses/${h.businessId}/users`, { name: "Dup", phone: existing.phone })).status).toBe(409);
  });

  it("owner reset-link / reset-2fa: 404 for a non-owner, another business's owner or unknown ids", async () => {
    for (const [biz, uid] of [
      [h.businessId, h.users.cashier.id],
      [h.businessId, other.users.owner.id],
      [h.businessId, "cl0000000000000000000000"],
    ])
      for (const action of ["reset-link", "reset-2fa"]) expect((await admin.call("POST", `/platform/businesses/${biz}/owners/${uid}/${action}`)).status, `${action} ${uid}`).toBe(404);
    const ok = await admin.call("POST", `/platform/businesses/${h.businessId}/owners/${h.users.owner.id}/reset-link`);
    expect(ok.status).toBe(200);
    expect(ok.body).toHaveProperty("channel");
  });
});

describe("platform admins", () => {
  it("POST: 201 (no password hash back); 400 on weak password / hotel role / missing email; 409 duplicate", async () => {
    const email = `pa.${Date.now()}@it.local`;
    const r = await admin.call("POST", "/platform/admins", { name: "Support Two", phone: uniqPhone(), email, password: "Filter-Coffee-2026", role: "PLATFORM_SUPPORT" });
    expect(r.status).toBe(201);
    expectNoSecrets(r.body);
    expect(r.body).toMatchObject({ role: "PLATFORM_SUPPORT", email });
    for (const body of [
      { name: "Weak", phone: uniqPhone(), email: `w.${Date.now()}@it.local`, password: "123" },
      { name: "Owner", phone: uniqPhone(), email: `o.${Date.now()}@it.local`, password: "Filter-Coffee-2026", role: "BUSINESS_OWNER" },
      { name: "No mail", phone: uniqPhone(), password: "Filter-Coffee-2026" },
    ])
      expect((await admin.call("POST", "/platform/admins", body)).status, JSON.stringify(body)).toBe(400);
    expect((await admin.call("POST", "/platform/admins", { name: "Dup", phone: uniqPhone(), email, password: "Filter-Coffee-2026" })).status).toBe(409);
    const list = await admin.call("GET", "/platform/admins");
    expectNoSecrets(list.body);
    expect(list.body.every((u: { role: string }) => ["SUPER_ADMIN", "PLATFORM_SUPPORT"].includes(u.role))).toBe(true);
  });

  it("summary counts are integers", async () => {
    const s = await admin.call("GET", "/platform/summary");
    for (const v of Object.values(s.body)) expect(Number.isInteger(v)).toBe(true);
  });
});

describe("/support-access (owner side)", () => {
  it("only the owner (outlet:manage) — every other hotel role 403; the platform admin 403", async () => {
    await expectAuthz(c, "GET", "/support-access", ["BUSINESS_OWNER"]);
    await expectAuthz(c, "POST", "/support-access", ["BUSINESS_OWNER"], {});
    expect((await admin.call("GET", "/support-access")).status).toBe(403);
  });

  it("POST: 201 contract; 400 on bad hours / reason; businessId in the body ignored", async () => {
    for (const body of [{}, { hours: 0 }, { hours: 73 }, { hours: 1.5 }, { hours: "4" }, { hours: 4, reason: HUGE }, { hours: null }])
      expect((await owner.call("POST", "/support-access", body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    const r = await owner.call("POST", "/support-access", { hours: 2, reason: NASTY.xss, businessId: other.businessId });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ businessId: h.businessId, grantedById: h.users.owner.id, reason: NASTY.xss, revokedAt: null });
    expect(new Date(r.body.expiresAt).getTime() - Date.now()).toBeGreaterThan(119 * 60_000);
    // a new grant replaces the old one: only one active
    const r2 = await owner.call("POST", "/support-access", { hours: 1 });
    const list = await owner.call("GET", "/support-access");
    expect(list.body.filter((g: { active: boolean }) => g.active).map((g: { id: string }) => g.id)).toEqual([r2.body.id]);
    expect(list.body[0]).toMatchObject({ views: expect.any(Number), lastViewedAt: null });
  });

  it("revoke / activity: 404 unknown and for another hotel's grant; revoking twice 400", async () => {
    const g = (await owner.call("POST", "/support-access", { hours: 1 })).body;
    expect((await otherOwner.call("POST", `/support-access/${g.id}/revoke`)).status).toBe(404);
    expect((await otherOwner.call("GET", `/support-access/${g.id}/activity`)).status).toBe(404);
    expect((await owner.call("POST", "/support-access/cl0000000000000000000000/revoke")).status).toBe(404);
    expect((await owner.call("GET", "/support-access/cl0000000000000000000000/activity")).status).toBe(404);
    const act = await owner.call("GET", `/support-access/${g.id}/activity`);
    expect(act.status).toBe(200);
    expect(act.body).toEqual([]);
    expect((await owner.call("POST", `/support-access/${g.id}/revoke`)).status).toBe(200);
    expect((await owner.call("POST", `/support-access/${g.id}/revoke`)).status).toBe(400);
    expect((await otherOwner.call("GET", "/support-access")).body.map((x: { id: string }) => x.id)).not.toContain(g.id);
  });

  it("idempotency: the same grant request twice (same key) creates one grant", async () => {
    const key = `grant-${Date.now()}`;
    const a = await owner.call("POST", "/support-access", { hours: 3 }, { "idempotency-key": key });
    await new Promise((r) => setTimeout(r, 100));
    const b = await owner.call("POST", "/support-access", { hours: 3 }, { "idempotency-key": key });
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(b.body.id).toBe(a.body.id);
    expect(await db.supportGrant.count({ where: { id: a.body.id } })).toBe(1);
  });
});
