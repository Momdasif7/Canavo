/**
 * QA Phase 5 — Group A functional tests: Staff creation chain ("Who creates
 * whom"), self-edit rules, forced logout, duplicates, PIN/field validation,
 * GET /staff scoping, and Aadhaar (owner/manager scope, masking, audit).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createTenant, db } from "./helpers";
import { raw, sessionFor, uniqPhone, uniqTag, verhoeffAadhaar, type Agent } from "./fx-a";

type Tenant = Awaited<ReturnType<typeof createTenant>>;
let t: Tenant;
let o2: { id: string };
let owner: Agent;
let mgr: Agent;

/** Tenant with a second outlet the manager does NOT manage, plus a cashier only at outlet 2. */
async function twoOutletTenant() {
  const tt = await createTenant({ name: "Staff tenant" });
  const out2 = await db.outlet.create({ data: { businessId: tt.business.id, name: "Outlet Two", stateCode: "33" } });
  const c2 = await db.user.create({
    data: { businessId: tt.business.id, name: "Cashier at two", phone: uniqPhone(), role: "CASHIER", outlets: { create: { outletId: out2.id } } },
  });
  return { tt, out2, c2 };
}
let cashierAt2: { id: string };

beforeAll(async () => {
  const x = await twoOutletTenant();
  t = x.tt;
  o2 = x.out2;
  cashierAt2 = x.c2;
  owner = await sessionFor(t.users.BUSINESS_OWNER.id, t.outlet.id);
  mgr = await sessionFor(t.users.OUTLET_MANAGER.id, t.outlet.id);
});

const newStaff = (role: string, over: Record<string, unknown> = {}) => ({
  name: `${role} ${uniqTag()}`,
  phone: uniqPhone(),
  role,
  outletIds: [t.outlet.id],
  ...over,
});

describe("Staff — who creates whom (decision table)", () => {
  it("IT-STF-001 owner creates a manager; response has no password/PIN hash; audited @regression @critical", async () => {
    const res = await owner.post("/staff", newStaff("OUTLET_MANAGER", { email: `M.${uniqTag()}@IT.test`, password: "Manager@123", pin: "4321" }));
    expect(res.status).toBe(201);
    expect(res.body.role).toBe("OUTLET_MANAGER");
    expect(res.body.email).toBe(res.body.email.toLowerCase());
    const text = JSON.stringify(res.body);
    for (const k of ["passwordHash", "pinHash", "aadhaarEnc", "Manager@123", "4321"]) expect(text).not.toContain(k);
    const row = await db.user.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.businessId).toBe(t.business.id);
    expect(row.pinHash).toMatch(/^\$2/);
    expect(await db.auditLog.count({ where: { action: "staff.create", entityId: res.body.id } })).toBe(1);
  });

  it.each(["CASHIER", "KITCHEN", "DELIVERY", "INVENTORY_MANAGER"])("IT-STF-002 owner creates %s @regression", async (role) => {
    const res = await owner.post("/staff", newStaff(role));
    expect(res.status).toBe(201);
    expect(res.body.outlets).toEqual([{ outletId: t.outlet.id }]);
  });

  it("IT-STF-003 owner cannot create another owner or a super admin → 403 @regression @critical", async () => {
    expect((await owner.post("/staff", newStaff("BUSINESS_OWNER", { outletIds: [] }))).status).toBe(403);
    expect((await owner.post("/staff", newStaff("SUPER_ADMIN", { outletIds: [] }))).status).toBe(403);
  });

  it.each(["CASHIER", "KITCHEN", "DELIVERY", "INVENTORY_MANAGER"])("IT-STF-004 manager creates %s in own outlet @regression", async (role) => {
    expect((await mgr.post("/staff", newStaff(role))).status).toBe(201);
  });

  it("IT-STF-005 manager cannot create managers, owners or super admins → 403 @regression @critical", async () => {
    for (const role of ["OUTLET_MANAGER", "BUSINESS_OWNER", "SUPER_ADMIN"]) {
      const r = await mgr.post("/staff", newStaff(role));
      expect(r.status, role).toBe(403);
    }
  });

  it("IT-STF-006 manager cannot assign staff to an outlet they don't manage (body or header) → 403 @regression @critical", async () => {
    expect((await mgr.post("/staff", newStaff("CASHIER", { outletIds: [o2.id] }))).status).toBe(403);
    expect((await mgr.post("/staff", newStaff("CASHIER", { outletIds: [t.outlet.id, o2.id] }))).status).toBe(403);
    const mgrAt2 = await sessionFor(t.users.OUTLET_MANAGER.id, o2.id);
    expect((await mgrAt2.post("/staff", newStaff("CASHIER", { outletIds: [o2.id] }))).status).toBe(403);
  });

  it("IT-STF-007 cashier / kitchen / inventory / delivery cannot create staff → 403 @regression @critical", async () => {
    for (const role of ["CASHIER", "KITCHEN", "INVENTORY_MANAGER", "DELIVERY"] as const) {
      const s = await sessionFor(t.users[role].id, t.outlet.id);
      expect((await s.post("/staff", newStaff("CASHIER"))).status, role).toBe(403);
    }
  });

  it("IT-STF-008 an owner cannot assign staff to another business's outlet → 403 @regression @critical", async () => {
    const other = await createTenant();
    expect((await owner.post("/staff", newStaff("CASHIER", { outletIds: [other.outlet.id] }))).status).toBe(403);
  });
});

describe("Staff — editing rules & forced logout", () => {
  it("IT-STF-010 manager cannot promote a cashier to manager → 403; owner can, and the promotion forces logout @regression @critical", async () => {
    const c = await owner.post("/staff", newStaff("CASHIER"));
    const victim = await sessionFor(c.body.id, t.outlet.id);
    expect((await mgr.patch(`/staff/${c.body.id}`, { role: "OUTLET_MANAGER" })).status).toBe(403);
    expect((await victim.get("/auth/me")).status).toBe(200);
    const up = await owner.patch(`/staff/${c.body.id}`, { role: "OUTLET_MANAGER" });
    expect(up.status).toBe(200);
    expect(up.body.role).toBe("OUTLET_MANAGER");
    expect((await victim.get("/auth/me")).status).toBe(401);
    expect((await raw().post("/auth/refresh").send({ refreshToken: victim.refreshToken })).status).toBe(401);
    const a = await db.auditLog.findFirstOrThrow({ where: { action: "staff.update", entityId: c.body.id } });
    expect(a.meta).toMatchObject({ forcedLogout: true });
  });

  it("IT-STF-011 nobody can change their own role, status or outlets; own name is fine @regression @critical", async () => {
    const self = t.users.OUTLET_MANAGER.id;
    expect((await mgr.patch(`/staff/${self}`, { status: "INACTIVE" })).status).toBe(403);
    expect((await mgr.patch(`/staff/${self}`, { outletIds: [t.outlet.id] })).status).toBe(403);
    expect((await mgr.patch(`/staff/${self}`, { role: "CASHIER" })).status).toBe(403);
    expect((await owner.patch(`/staff/${t.users.BUSINESS_OWNER.id}`, { status: "INACTIVE" })).status).toBe(403);
    const ok = await mgr.patch(`/staff/${self}`, { name: "Manager Renamed" });
    expect(ok.status).toBe(200);
    expect(ok.body.name).toBe("Manager Renamed");
  });

  it("IT-STF-012 deactivating a staff member kills their sessions and refuses login @regression @critical", async () => {
    const c = await owner.post("/staff", newStaff("KITCHEN", { email: `k.${uniqTag()}@it.test`, password: "Kitchen@123" }));
    const s = await sessionFor(c.body.id, t.outlet.id);
    const res = await mgr.patch(`/staff/${c.body.id}`, { status: "INACTIVE" });
    expect(res.status).toBe(200);
    expect((await s.get("/auth/me")).status).toBe(401);
    const li = await raw().post("/auth/login").send({ email: c.body.email, password: "Kitchen@123" });
    expect(li.status).toBe(401);
  });

  it("IT-STF-013 created staff can log in with the password set by the creator @regression", async () => {
    const email = `c.${uniqTag()}@it.test`;
    await mgr.post("/staff", newStaff("CASHIER", { email, password: "Cashier@123" }));
    expect((await raw().post("/auth/login").send({ email, password: "Cashier@123" })).status).toBe(200);
  });

  it("IT-STF-014 manager cannot edit a peer manager (403), the owner (404) or staff only at another outlet (404) @regression @critical", async () => {
    const peer = await owner.post("/staff", newStaff("OUTLET_MANAGER"));
    expect((await mgr.patch(`/staff/${peer.body.id}`, { name: "Hacked" })).status).toBe(403);
    expect((await mgr.patch(`/staff/${t.users.BUSINESS_OWNER.id}`, { name: "Hacked" })).status).toBe(404);
    expect((await mgr.patch(`/staff/${cashierAt2.id}`, { name: "Hacked" })).status).toBe(404);
  });

  it("IT-STF-015 an owner cannot edit staff of another business → 404 @regression @critical", async () => {
    const other = await createTenant();
    expect((await owner.patch(`/staff/${other.users.CASHIER.id}`, { name: "Hacked" })).status).toBe(404);
    expect((await db.user.findUniqueOrThrow({ where: { id: other.users.CASHIER.id } })).name).not.toBe("Hacked");
  });

  it("IT-STF-016 editing name only does not force logout @regression", async () => {
    const c = await owner.post("/staff", newStaff("DELIVERY"));
    const s = await sessionFor(c.body.id);
    await mgr.patch(`/staff/${c.body.id}`, { name: "Delivery Renamed" });
    expect((await s.get("/auth/me")).status).toBe(200);
  });

  it("IT-STF-017 BUG-009 regression: a shift from another business is refused (400) on create and update @regression @critical", async () => {
    const other = await createTenant();
    const foreignShift = await db.shift.create({ data: { outletId: other.outlet.id, name: "Foreign", startTime: "09:00", endTime: "17:00" } });
    expect((await owner.post("/staff", newStaff("CASHIER", { shiftId: foreignShift.id }))).status).toBe(400);
    expect((await owner.patch(`/staff/${t.users.CASHIER.id}`, { shiftId: foreignShift.id })).status).toBe(400);
  });

  it("IT-STF-018 owner setting outletIds replaces assignments (owner controls every outlet) @regression", async () => {
    const c = await owner.post("/staff", newStaff("CASHIER"));
    const res = await owner.patch(`/staff/${c.body.id}`, { outletIds: [o2.id] });
    expect(res.status).toBe(200);
    expect(res.body.outlets).toEqual([{ outletId: o2.id }]);
  });
});

describe("Staff — duplicates and field validation (BVA)", () => {
  it("IT-STF-020 duplicate phone → 409; duplicate email in different case → 409 @regression", async () => {
    const email = `dup.${uniqTag()}@it.test`;
    const first = await owner.post("/staff", newStaff("CASHIER", { email }));
    expect(first.status).toBe(201);
    expect((await owner.post("/staff", newStaff("CASHIER", { phone: first.body.phone }))).status).toBe(409);
    expect((await owner.post("/staff", newStaff("CASHIER", { email: email.toUpperCase() }))).status).toBe(409);
    // also across businesses (logins are global)
    expect((await owner.post("/staff", newStaff("CASHIER", { phone: "9876500002" }))).status).toBe(409);
  });

  it("IT-STF-021 changing phone to one already used → 409 (not 500) @regression", async () => {
    const a = await owner.post("/staff", newStaff("CASHIER"));
    const b = await owner.post("/staff", newStaff("CASHIER"));
    expect((await owner.patch(`/staff/${b.body.id}`, { phone: a.body.phone })).status).toBe(409);
  });

  it.each([
    ["123", 400], ["1234", 201], ["12345", 201], ["123456", 201], ["1234567", 400], ["12a4", 400], ["", 400],
  ] as const)("IT-STF-022 PIN %j → %i (4–6 digits) @regression", async (pin, status) => {
    expect((await owner.post("/staff", newStaff("KITCHEN", { pin }))).status).toBe(status);
  });

  it("IT-STF-023 invalid payloads → 400: no outlet for staff, bad phone, short password, negative/fractional salary, unknown role, bad email @regression", async () => {
    const bad = [
      newStaff("CASHIER", { outletIds: [] }),
      newStaff("CASHIER", { phone: "12345" }),
      newStaff("CASHIER", { password: "short" }),
      newStaff("CASHIER", { salaryAmount: -1 }),
      newStaff("CASHIER", { salaryAmount: 10.5 }),
      newStaff("WAITER"),
      newStaff("CASHIER", { email: "nope" }),
      newStaff("CASHIER", { name: "A" }),
    ];
    for (const b of bad) expect((await owner.post("/staff", b)).status, JSON.stringify(b)).toBe(400);
  });

  it("IT-STF-024 unknown outlet id in outletIds → 403 (not 500) @regression", async () => {
    expect((await owner.post("/staff", newStaff("CASHIER", { outletIds: ["no-such-outlet"] }))).status).toBe(403);
  });
});

describe("Staff — listing scope", () => {
  it("IT-STF-030 manager GET /staff sees only staff of the current outlet; never another outlet's staff @regression @critical", async () => {
    const res = await mgr.get("/staff");
    expect(res.status).toBe(200);
    const ids = res.body.map((u: { id: string }) => u.id);
    expect(ids).toContain(t.users.CASHIER.id);
    expect(ids).not.toContain(cashierAt2.id);
    expect(ids).not.toContain(t.users.BUSINESS_OWNER.id);
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|pinHash|aadhaarEnc/);
    // scope=business is ignored for managers
    const wide = await mgr.get("/staff?scope=business");
    expect(wide.body.map((u: { id: string }) => u.id)).not.toContain(cashierAt2.id);
  });

  it("IT-STF-031 owner scope=business lists every account incl. owners and both outlets; never other businesses @regression @critical", async () => {
    const other = await createTenant();
    const res = await owner.get("/staff?scope=business");
    const ids = res.body.map((u: { id: string }) => u.id);
    expect(ids).toEqual(expect.arrayContaining([t.users.BUSINESS_OWNER.id, cashierAt2.id, t.users.CASHIER.id]));
    expect(ids).not.toContain(other.users.CASHIER.id);
  });

  it("IT-STF-032 manager with X-Outlet-Id of an unmanaged outlet → 403; cashier GET /staff → 403 @regression @critical", async () => {
    expect((await (await sessionFor(t.users.OUTLET_MANAGER.id, o2.id)).get("/staff")).status).toBe(403);
    expect((await (await sessionFor(t.users.CASHIER.id, t.outlet.id)).get("/staff")).status).toBe(403);
  });

  it("IT-STF-033 staff performance returns a stable shape for the default 30 days @regression", async () => {
    const r = await mgr.get(`/staff/${t.users.CASHIER.id}/performance`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ days: 30, billsRaised: 0, salesValue: 0, itemsSold: 0, attendancePercent: 0 });
  });

  // BUG-CANDIDATE-A4: `days` is not validated: Number("abc") = NaN flows into
  // addDays()/Math.round(). Expected 400 (or the 30-day default). Actual: 500
  // Internal server error.
  it.fails("IT-STF-034 performance ?days=abc must be rejected or defaulted, not 500 (BUG-CANDIDATE-A4) @regression", async () => {
    const r = await mgr.get(`/staff/${t.users.CASHIER.id}/performance?days=abc`);
    expect(r.status).toBeLessThan(500);
  });

  // BUG-CANDIDATE-A5: days=0 / negative are accepted and divide by zero.
  // Expected 400 or a clamp to ≥1. Actual: 200 with attendancePercent null/garbage.
  it.fails("IT-STF-035 performance ?days=0 must be rejected or clamped (BUG-CANDIDATE-A5) @regression", async () => {
    const r = await mgr.get(`/staff/${t.users.CASHIER.id}/performance?days=0`);
    if (r.status === 200) {
      expect(r.body.days).toBeGreaterThanOrEqual(1);
      expect(Number.isFinite(r.body.attendancePercent)).toBe(true);
    } else expect(r.status).toBe(400);
  });
});

describe("Staff — Aadhaar (encrypted PII)", () => {
  const AAD = verhoeffAadhaar("23456789012");
  const AAD2 = verhoeffAadhaar("98765432101");

  it("IT-STF-040 owner sets Aadhaar → masked response, encrypted at rest, audit has last4 only @regression @critical", async () => {
    const res = await owner.patch(`/admin/staff/${t.users.CASHIER.id}/aadhaar`, { aadhaar: `${AAD.slice(0, 4)} ${AAD.slice(4, 8)}-${AAD.slice(8)}` });
    expect(res.status).toBe(200);
    expect(res.body.aadhaar).toBe(`XXXX-XXXX-${AAD.slice(-4)}`);
    const row = await db.user.findUniqueOrThrow({ where: { id: t.users.CASHIER.id } });
    expect(row.aadhaarEnc).toMatch(/^v1:/);
    expect(row.aadhaarEnc).not.toContain(AAD);
    const a = await db.auditLog.findFirstOrThrow({ where: { action: "staff.aadhaar_set", entityId: t.users.CASHIER.id } });
    expect(JSON.stringify(a.meta)).not.toContain(AAD);
  });

  it("IT-STF-041 Aadhaar validation: bad checksum, leading 0/1, 11 digits → 400 @regression", async () => {
    const bad = AAD.slice(0, 11) + String((Number(AAD[11]) + 1) % 10);
    for (const v of [bad, "123456789012", "012345678901", "23456789012"]) {
      expect((await owner.patch(`/admin/staff/${t.users.KITCHEN.id}/aadhaar`, { aadhaar: v })).status, v).toBe(400);
    }
  });

  it("IT-STF-042 GET is masked by default (audited as view); ?reveal=1 returns the number and is audited as reveal @regression @critical", async () => {
    await owner.patch(`/admin/staff/${t.users.DELIVERY.id}/aadhaar`, { aadhaar: AAD2 });
    const masked = await owner.get(`/admin/staff/${t.users.DELIVERY.id}/aadhaar`);
    expect(masked.body).toMatchObject({ aadhaar: `XXXX-XXXX-${AAD2.slice(-4)}`, revealed: false });
    const before = await db.auditLog.count({ where: { action: "staff.aadhaar_reveal", entityId: t.users.DELIVERY.id } });
    const shown = await owner.get(`/admin/staff/${t.users.DELIVERY.id}/aadhaar?reveal=1`);
    expect(shown.body).toMatchObject({ aadhaar: AAD2, revealed: true });
    expect(await db.auditLog.count({ where: { action: "staff.aadhaar_reveal", entityId: t.users.DELIVERY.id } })).toBe(before + 1);
    const none = await owner.get(`/admin/staff/${t.users.INVENTORY_MANAGER.id}/aadhaar`);
    expect(none.body).toEqual({ userId: t.users.INVENTORY_MANAGER.id, aadhaar: null });
  });

  it("IT-STF-043 owner may reveal a manager's Aadhaar (anyone in the business) @regression", async () => {
    await owner.patch(`/admin/staff/${t.users.OUTLET_MANAGER.id}/aadhaar`, { aadhaar: AAD });
    const r = await owner.get(`/admin/staff/${t.users.OUTLET_MANAGER.id}/aadhaar?reveal=true`);
    expect(r.status).toBe(200);
    expect(r.body.aadhaar).toBe(AAD);
  });

  it("IT-STF-044 manager: own-outlet staff below → 200; self → 200; peer manager / owner / other-outlet staff → 404 @regression @critical", async () => {
    await owner.patch(`/admin/staff/${cashierAt2.id}/aadhaar`, { aadhaar: AAD });
    const peer = await owner.post("/staff", newStaff("OUTLET_MANAGER"));
    await owner.patch(`/admin/staff/${peer.body.id}/aadhaar`, { aadhaar: AAD });
    expect((await mgr.get(`/admin/staff/${t.users.CASHIER.id}/aadhaar?reveal=1`)).status).toBe(200);
    expect((await mgr.get(`/admin/staff/${t.users.OUTLET_MANAGER.id}/aadhaar`)).status).toBe(200);
    expect((await mgr.get(`/admin/staff/${peer.body.id}/aadhaar?reveal=1`)).status).toBe(404);
    expect((await mgr.get(`/admin/staff/${t.users.BUSINESS_OWNER.id}/aadhaar?reveal=1`)).status).toBe(404);
    expect((await mgr.get(`/admin/staff/${cashierAt2.id}/aadhaar?reveal=1`)).status).toBe(404);
    expect((await mgr.patch(`/admin/staff/${cashierAt2.id}/aadhaar`, { aadhaar: AAD })).status).toBe(404);
  });

  it("IT-STF-045 cashier → 403; another business's owner → 404 @regression @critical", async () => {
    const c = await sessionFor(t.users.CASHIER.id, t.outlet.id);
    expect((await c.get(`/admin/staff/${t.users.KITCHEN.id}/aadhaar`)).status).toBe(403);
    const other = await createTenant();
    const otherOwner = await sessionFor(other.users.BUSINESS_OWNER.id);
    expect((await otherOwner.get(`/admin/staff/${t.users.CASHIER.id}/aadhaar?reveal=1`)).status).toBe(404);
  });

  // BUG-CANDIDATE-A6: the Aadhaar routes don't resolve an outlet, so their audit
  // rows are written with outletId = null, while GET /admin/audit-logs for
  // business users only returns rows whose outletId is one of their outlets.
  // Expected (README "Every reveal is audited"): the owner can see the reveal in
  // the audit log. Actual: the reveal row exists in the DB but the owner's audit
  // log never returns it (same for staff.aadhaar_set / _view).
  it.fails("IT-STF-046 the owner can see Aadhaar reveals in their audit log (BUG-CANDIDATE-A6) @regression @critical", async () => {
    await owner.patch(`/admin/staff/${t.users.KITCHEN.id}/aadhaar`, { aadhaar: AAD2 });
    await owner.get(`/admin/staff/${t.users.KITCHEN.id}/aadhaar?reveal=1`);
    expect(await db.auditLog.count({ where: { action: "staff.aadhaar_reveal", entityId: t.users.KITCHEN.id } })).toBeGreaterThan(0);
    const log = await owner.get("/admin/audit-logs?action=staff.aadhaar_reveal&pageSize=200");
    expect(log.status).toBe(200);
    expect(log.body.items.map((i: { entityId: string }) => i.entityId)).toContain(t.users.KITCHEN.id);
  });

  it("IT-STF-047 the Super Admin's audit log never shows Aadhaar reveals @regression @critical", async () => {
    await owner.get(`/admin/staff/${t.users.CASHIER.id}/aadhaar?reveal=1`);
    const sa = await sessionFor("admin@canavo.local");
    const log = await sa.get("/admin/audit-logs?action=staff.aadhaar*&pageSize=200");
    expect(log.status).toBe(200);
    expect(log.body.items).toEqual([]);
  });
});
