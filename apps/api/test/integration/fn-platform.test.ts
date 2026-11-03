/**
 * QA Phase 5 — Group A functional tests: Super Admin / platform console.
 * Onboarding, modules (dependencies, effective permissions, API gating),
 * suspend/reactivate, owner accounts & password reset, platform admins,
 * privacy (no hotel data for the super admin), platform audit log.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createTenant, db, demoTenant } from "./helpers";
import { raw, sessionFor, uniqPhone, uniqTag, type Agent } from "./fx-a";

let sa: Agent;
let demo: Awaited<ReturnType<typeof demoTenant>>;
beforeAll(async () => {
  sa = await sessionFor("admin@canavo.local");
  demo = await demoTenant();
});

const login = (email: string, password: string) => raw().post("/auth/login").send({ email, password });

function onboardBody(over: Record<string, unknown> = {}) {
  const tag = uniqTag();
  return {
    name: `Onboard ${tag}`,
    legalName: `Onboard Foods ${tag} Pvt Ltd`,
    phone: "080-1234567",
    email: `biz.${tag}@it.canavo.test`,
    modules: ["TABLES", "REPORTS"],
    owner: { name: "New Owner", phone: uniqPhone(), email: `Owner.${tag}@IT.canavo.test`, password: "OwnerPass@1" },
    outlet: { name: "Main Branch", address: "MG Road", stateCode: "29" },
    ...over,
  };
}

describe("Platform — onboarding a business", () => {
  it("IT-PLAT-001 SA onboards business + owner + outlet; dependencies auto-added (TABLES → BILLING); default tax slabs created @regression @critical", async () => {
    const body = onboardBody();
    const res = await sa.post("/platform/businesses", body);
    expect(res.status).toBe(201);
    expect(res.body.business.modules).toEqual(["BILLING", "TABLES", "REPORTS"]);
    expect(res.body.outlet).toMatchObject({ name: "Main Branch", stateCode: "29", gstEnabled: true });
    expect(res.body.owner).toMatchObject({ role: "BUSINESS_OWNER", email: body.owner.email.toLowerCase() });
    expect(JSON.stringify(res.body.owner)).not.toContain("passwordHash");
    const rates = await db.taxRate.findMany({ where: { businessId: res.body.business.id } });
    expect(rates.map((r) => r.name).sort()).toEqual(["GST 0% (Exempt)", "GST 12%", "GST 18%", "GST 28%", "GST 5%"]);
    expect(rates.filter((r) => r.isDefault)).toHaveLength(1);
    // the owner can log in with the chosen password; email case-insensitively
    const li = await login(body.owner.email, "OwnerPass@1");
    expect(li.status).toBe(200);
    const audit = await db.auditLog.findFirst({ where: { action: "platform.business.create", entityId: res.body.business.id } });
    expect(audit).not.toBeNull();
  });

  it("IT-PLAT-002 onboarding without an outlet is allowed (outlet null) @regression", async () => {
    const res = await sa.post("/platform/businesses", onboardBody({ outlet: undefined, modules: ["INVENTORY"] }));
    expect(res.status).toBe(201);
    expect(res.body.outlet).toBeNull();
    expect(res.body.business.modules).toEqual(["INVENTORY"]);
  });

  it("IT-PLAT-003 unknown module keys and an empty module list are rejected with 400 (never 500) @regression", async () => {
    expect((await sa.post("/platform/businesses", onboardBody({ modules: ["BILLING", "CASINO"] }))).status).toBe(400);
    expect((await sa.post("/platform/businesses", onboardBody({ modules: [] }))).status).toBe(400);
  });

  it("IT-PLAT-004 validation: short password, bad phone, bad state code → 400 @regression", async () => {
    const b = onboardBody();
    expect((await sa.post("/platform/businesses", { ...b, owner: { ...b.owner, password: "short" } })).status).toBe(400);
    expect((await sa.post("/platform/businesses", { ...b, owner: { ...b.owner, phone: "12345" } })).status).toBe(400);
    expect((await sa.post("/platform/businesses", { ...b, outlet: { name: "X1", stateCode: "9" } })).status).toBe(400);
    expect((await sa.post("/platform/businesses", { ...b, name: "A" })).status).toBe(400);
  });

  it("IT-PLAT-005 owner phone / email already registered → 409, no business row created @regression", async () => {
    const before = await db.business.count();
    const b1 = onboardBody();
    const r1 = await sa.post("/platform/businesses", { ...b1, owner: { ...b1.owner, phone: "9876500005" } });
    expect(r1.status).toBe(409);
    const b2 = onboardBody();
    const r2 = await sa.post("/platform/businesses", { ...b2, owner: { ...b2.owner, email: "OWNER@canavo.local" } });
    expect(r2.status).toBe(409);
    expect(await db.business.count()).toBe(before);
  });

  it("IT-PLAT-006 non-platform users cannot use the platform console (owner/manager/cashier → 403, anonymous → 401) @regression @critical", async () => {
    for (const email of ["owner@canavo.local", "manager@canavo.local", "cashier@canavo.local"]) {
      const s = await sessionFor(email);
      expect((await s.get("/platform/businesses")).status, email).toBe(403);
      expect((await s.post("/platform/businesses", onboardBody())).status, email).toBe(403);
    }
    expect((await raw().get("/platform/summary")).status).toBe(401);
  });
});

describe("Platform — privacy: account info only", () => {
  it("IT-PLAT-010 GET /platform/businesses returns account info only (no staff, bills, customers, Aadhaar, GSTIN) @regression @critical", async () => {
    const res = await sa.get("/platform/businesses");
    expect(res.status).toBe(200);
    const d = res.body.find((b: { id: string }) => b.id === demo.businessId);
    expect(d).toBeTruthy();
    expect(d.users).toBeUndefined();
    for (const k of ["orders", "customers", "staff", "aadhaarEnc", "passwordHash", "grandTotal", "gstin"]) expect(JSON.stringify(d)).not.toContain(`"${k}"`);
    // owners listed with contact only
    expect(d.owners.every((o: Record<string, unknown>) => Object.keys(o).sort().join() === "email,id,name,phone")).toBe(true);
    expect(d._count).toEqual({ outlets: expect.any(Number) });
  });

  it("IT-PLAT-011 GET /platform/businesses/:id: outlet names + owners; no staff (manager/cashier), no sales; 404 for unknown @regression @critical", async () => {
    const res = await sa.get(`/platform/businesses/${demo.businessId}`);
    expect(res.status).toBe(200);
    expect(res.body.owners.every((o: { id: string }) => o.id === demo.owner.id)).toBe(true);
    const text = JSON.stringify(res.body);
    for (const leak of ["manager@canavo.local", "cashier@canavo.local", "aadhaar", "passwordHash", "pinHash", "gstin", "upiVpa", "grandTotal"]) {
      expect(text, leak).not.toContain(leak);
    }
    expect(Object.keys(res.body.outlets[0]).sort()).toEqual(["address", "createdAt", "id", "name"]);
    expect((await sa.get("/platform/businesses/does-not-exist")).status).toBe(404);
  });

  it("IT-PLAT-012 search filters businesses by name (case-insensitive) @regression", async () => {
    const res = await sa.get("/platform/businesses?search=demo%20HOTEL");
    expect(res.status).toBe(200);
    expect(res.body.map((b: { id: string }) => b.id)).toContain(demo.businessId);
    const none = await sa.get(`/platform/businesses?search=zz-no-such-${uniqTag()}`);
    expect(none.body).toEqual([]);
  });

  it("IT-PLAT-013 Super Admin is refused every outlet-scoped hotel route even with X-Outlet-Id → 403 @regression @critical", async () => {
    const s = await sessionFor("admin@canavo.local", demo.outlet.id);
    for (const p of ["/staff", "/orders", "/outlets/current", "/menu", "/customers", "/reports/sales", "/tax-rates", "/outlets/current/shifts"]) {
      const r = await s.get(p);
      expect(r.status, p).toBe(403);
    }
    // without an outlet the SA also gets nothing
    expect((await sa.get("/outlets")).body).toEqual([]);
    expect((await sa.get("/tax-rates")).status).toBe(403);
  });

  it("IT-PLAT-014 Super Admin can't read or reveal staff Aadhaar, nor export a hotel's data @regression @critical", async () => {
    const mgr = await db.user.findUniqueOrThrow({ where: { email: "manager@canavo.local" } });
    expect((await sa.get(`/admin/staff/${mgr.id}/aadhaar?reveal=1`)).status).toBe(403);
    const s = await sessionFor("admin@canavo.local", demo.outlet.id);
    expect((await s.get(`/admin/staff/${mgr.id}/aadhaar?reveal=1`)).status).toBe(403);
    expect((await sa.get("/admin/export")).status).toBe(403);
  });

  it("IT-PLAT-015 Super Admin cannot create staff inside a business via /staff @regression @critical", async () => {
    const s = await sessionFor("admin@canavo.local", demo.outlet.id);
    const r = await s.post("/staff", { name: "Sneaky", phone: uniqPhone(), role: "CASHIER", outletIds: [demo.outlet.id] });
    expect(r.status).toBe(403);
  });
});

describe("Platform — modules switch effective permissions and API access", () => {
  it("IT-PLAT-020 disabling BILLING/KOT removes permissions from /auth/me and the API answers 403 @regression @critical", async () => {
    const t = await createTenant();
    const cashier = await sessionFor(t.users.CASHIER.id, t.outlet.id);
    expect((await cashier.get("/orders")).status).toBe(200);
    const res = await sa.patch(`/platform/businesses/${t.business.id}`, { modules: ["INVENTORY", "ATTENDANCE"] });
    expect(res.status).toBe(200);
    expect(res.body.modules).toEqual(["INVENTORY", "ATTENDANCE"]);
    const me = await cashier.get("/auth/me");
    expect(me.body.permissions).not.toContain("order:create");
    expect(me.body.permissions).not.toContain("bills:view");
    expect(me.body.permissions).toContain("menu:view"); // menu stays with INVENTORY
    const o = await cashier.get("/orders");
    expect(o.status).toBe(403);
    expect(o.body.error).toMatch(/not enabled/);
    const kitchen = await sessionFor(t.users.KITCHEN.id, t.outlet.id);
    expect((await kitchen.get("/kot")).status).toBe(403);
    // staff & settings are always on
    const owner = await sessionFor(t.users.BUSINESS_OWNER.id, t.outlet.id);
    expect((await owner.get("/staff")).status).toBe(200);
    expect((await owner.get("/outlets/current")).status).toBe(200);
  });

  it("IT-PLAT-021 re-enabling modules restores access; PATCH with TABLES alone adds BILLING @regression", async () => {
    const t = await createTenant({ modules: ["INVENTORY"] });
    const cashier = await sessionFor(t.users.CASHIER.id, t.outlet.id);
    expect((await cashier.get("/orders")).status).toBe(403);
    const res = await sa.patch(`/platform/businesses/${t.business.id}`, { modules: ["TABLES"] });
    expect(res.body.modules).toEqual(["BILLING", "TABLES"]);
    expect((await cashier.get("/orders")).status).toBe(200);
    expect((await cashier.get("/auth/me")).body.permissions).toContain("table:serve");
  });

  it("IT-PLAT-022 module-gated endpoints answer 403 per module (decision table) @regression @critical", async () => {
    const t = await createTenant({ modules: ["ATTENDANCE"] });
    const owner = await sessionFor(t.users.BUSINESS_OWNER.id, t.outlet.id);
    const table: Array<[string, string]> = [
      ["BILLING", "/orders"], ["INVENTORY", "/inventory/items"], ["CUSTOMERS", "/customers"],
      ["REPORTS", "/reports/sales"], ["OFFERS", "/offers/coupons"], ["RESERVATIONS", "/reservations"],
      ["DELIVERY", "/delivery/zones"], ["TABLES", "/tables"],
    ];
    for (const [mod, path] of table) {
      const r = await owner.get(path);
      expect(r.status, `${mod} ${path} → ${r.status}`).toBe(403);
    }
  });

  it("IT-PLAT-023 PATCH validation: empty modules, unknown status → 400; unknown business → 404 @regression", async () => {
    const t = await createTenant();
    expect((await sa.patch(`/platform/businesses/${t.business.id}`, { modules: [] })).status).toBe(400);
    expect((await sa.patch(`/platform/businesses/${t.business.id}`, { status: "DELETED" })).status).toBe(400);
    expect((await sa.patch(`/platform/businesses/nope-${uniqTag()}`, { name: "Whatever" })).status).toBe(404);
  });
});

describe("Platform — suspend / reactivate (state transitions)", () => {
  it("IT-PLAT-030 suspending signs everyone out (tokens 401, refresh 401) and blocks login; reactivating allows login again @regression @critical", async () => {
    const t = await createTenant();
    const owner = await sessionFor(t.users.BUSINESS_OWNER.id);
    const cashier = await sessionFor(t.users.CASHIER.id);
    const res = await sa.patch(`/platform/businesses/${t.business.id}`, { status: "SUSPENDED" });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("SUSPENDED");
    expect((await owner.get("/auth/me")).status).toBe(401);
    expect((await cashier.get("/auth/me")).status).toBe(401);
    expect((await raw().post("/auth/refresh").send({ refreshToken: cashier.refreshToken })).status).toBe(401);
    expect((await login(t.users.CASHIER.email, "Canavo@123")).status).toBe(403);
    const back = await sa.patch(`/platform/businesses/${t.business.id}`, { status: "ACTIVE" });
    expect(back.body.status).toBe("ACTIVE");
    expect((await login(t.users.CASHIER.email, "Canavo@123")).status).toBe(200);
  });

  it("IT-PLAT-031 suspend is audited as platform.business.update with the new status @regression", async () => {
    const t = await createTenant();
    await sa.patch(`/platform/businesses/${t.business.id}`, { status: "SUSPENDED" });
    const a = await db.auditLog.findFirstOrThrow({ where: { action: "platform.business.update", entityId: t.business.id } });
    expect(a.meta).toMatchObject({ status: "SUSPENDED" });
  });

  it("IT-PLAT-032 /platform/summary counts active and suspended businesses consistently @regression", async () => {
    const r = await sa.get("/platform/summary");
    expect(r.status).toBe(200);
    expect(r.body.activeBusinesses + r.body.suspendedBusinesses).toBe(r.body.businesses);
    expect(r.body.activeBusinesses).toBe(await db.business.count({ where: { status: "ACTIVE" } }));
  });
});

describe("Platform — owner accounts", () => {
  it("IT-PLAT-040 SA adds a second owner; owner can log in and sees all outlets @regression", async () => {
    const t = await createTenant();
    const email = `owner2.${uniqTag()}@it.canavo.test`;
    const res = await sa.post(`/platform/businesses/${t.business.id}/users`, { name: "Second Owner", phone: uniqPhone(), email, password: "Owner2Pass!" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email, status: "ACTIVE" });
    expect(res.body.passwordHash).toBeUndefined();
    const u = await db.user.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(u.role).toBe("BUSINESS_OWNER");
    expect(u.businessId).toBe(t.business.id);
    expect((await login(email, "Owner2Pass!")).status).toBe(200);
  });

  it("IT-PLAT-041 SA can only create OWNER accounts (role MANAGER/SUPER_ADMIN → 400); unknown business → 404; dup phone → 409 @regression @critical", async () => {
    const t = await createTenant();
    const base = { name: "Somebody", phone: uniqPhone(), password: "Password@1" };
    expect((await sa.post(`/platform/businesses/${t.business.id}/users`, { ...base, role: "OUTLET_MANAGER" })).status).toBe(400);
    expect((await sa.post(`/platform/businesses/${t.business.id}/users`, { ...base, role: "SUPER_ADMIN" })).status).toBe(400);
    expect((await sa.post(`/platform/businesses/nope-${uniqTag()}/users`, base)).status).toBe(404);
    expect((await sa.post(`/platform/businesses/${t.business.id}/users`, { ...base, phone: "9876500002" })).status).toBe(409);
  });

  it("IT-PLAT-042 reset owner password: old sessions die (access + refresh), old password fails, new works @regression @critical", async () => {
    const t = await createTenant();
    const old = await sessionFor(t.users.BUSINESS_OWNER.id);
    const res = await sa.post(`/platform/businesses/${t.business.id}/owners/${t.users.BUSINESS_OWNER.id}/reset-password`, { password: "BrandNew@99" });
    expect(res.status).toBe(200);
    expect((await old.get("/auth/me")).status).toBe(401);
    expect((await raw().post("/auth/refresh").send({ refreshToken: old.refreshToken })).status).toBe(401);
    expect((await login(t.users.BUSINESS_OWNER.email, "Canavo@123")).status).toBe(401);
    expect((await login(t.users.BUSINESS_OWNER.email, "BrandNew@99")).status).toBe(200);
    expect(await db.auditLog.count({ where: { action: "platform.owner.reset_password", entityId: t.users.BUSINESS_OWNER.id } })).toBe(1);
  });

  it("IT-PLAT-043 reset-password only targets owners of THAT business (manager id / other business → 404; short pw → 400) @regression @critical", async () => {
    const t = await createTenant();
    const other = await createTenant();
    const url = (b: string, u: string) => `/platform/businesses/${b}/owners/${u}/reset-password`;
    expect((await sa.post(url(t.business.id, t.users.OUTLET_MANAGER.id), { password: "BrandNew@99" })).status).toBe(404);
    expect((await sa.post(url(t.business.id, other.users.BUSINESS_OWNER.id), { password: "BrandNew@99" })).status).toBe(404);
    expect((await sa.post(url(t.business.id, t.users.BUSINESS_OWNER.id), { password: "1234567" })).status).toBe(400);
  });
});

describe("Platform — platform admins", () => {
  it("IT-PLAT-050 list admins (SUPER_ADMIN without business only); create admin who can log in and use the console @regression", async () => {
    const list = await sa.get("/platform/admins");
    expect(list.status).toBe(200);
    expect(list.body.map((a: { email: string }) => a.email)).toContain("admin@canavo.local");
    expect(list.body.every((a: { role: string }) => a.role === "SUPER_ADMIN")).toBe(true);
    const email = `sa.${uniqTag()}@it.canavo.test`;
    const res = await sa.post("/platform/admins", { name: "Second Admin", phone: uniqPhone(), email, password: "SuperPass@1" });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe("SUPER_ADMIN");
    const li = await login(email, "SuperPass@1");
    expect(li.status).toBe(200);
    expect((await sessionFor(email)).user.businessId).toBeNull();
  });

  it("IT-PLAT-051 create admin validation: email required, password ≥ 8, duplicate email → 409 @regression", async () => {
    expect((await sa.post("/platform/admins", { name: "No Mail", phone: uniqPhone(), password: "SuperPass@1" })).status).toBe(400);
    expect((await sa.post("/platform/admins", { name: "Short", phone: uniqPhone(), email: `s.${uniqTag()}@x.test`, password: "short" })).status).toBe(400);
    expect((await sa.post("/platform/admins", { name: "Dup", phone: uniqPhone(), email: "admin@canavo.local", password: "SuperPass@1" })).status).toBe(409);
  });

  it("IT-PLAT-052 an owner cannot create platform admins → 403 @regression @critical", async () => {
    const owner = await sessionFor("owner@canavo.local");
    expect((await owner.post("/platform/admins", { name: "Evil", phone: uniqPhone(), email: `e.${uniqTag()}@x.test`, password: "SuperPass@1" })).status).toBe(403);
  });
});

describe("Platform — audit log scoping", () => {
  it("IT-PLAT-060 SA audit log shows platform/backup/SA actions only — no hotel activity @regression @critical", async () => {
    // make sure hotel activity exists
    const t = await createTenant();
    const owner = await sessionFor(t.users.BUSINESS_OWNER.id, t.outlet.id);
    await owner.patch("/outlets/current", { name: "Renamed for audit" });
    await sa.patch(`/platform/businesses/${t.business.id}`, { notes: "audited" });
    const res = await sa.get("/admin/audit-logs?pageSize=200");
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBeGreaterThan(0);
    for (const it of res.body.items) {
      const ok = it.action.startsWith("platform.") || it.action.startsWith("backup.") || it.user?.role === "SUPER_ADMIN";
      expect(ok, it.action).toBe(true);
    }
    expect(res.body.items.some((i: { action: string }) => i.action === "outlet.update")).toBe(false);
  });

  it("IT-PLAT-061 an owner's audit log does not contain platform actions on their business @regression", async () => {
    const t = await createTenant();
    await sa.patch(`/platform/businesses/${t.business.id}`, { notes: "platform note" });
    const owner = await sessionFor(t.users.BUSINESS_OWNER.id, t.outlet.id);
    await owner.patch("/outlets/current", { name: "Owner audit outlet" });
    const res = await owner.get("/admin/audit-logs?pageSize=200");
    expect(res.status).toBe(200);
    const actions = res.body.items.map((i: { action: string }) => i.action);
    expect(actions).toContain("outlet.update");
    expect(actions.some((a: string) => a.startsWith("platform."))).toBe(false);
  });
});
