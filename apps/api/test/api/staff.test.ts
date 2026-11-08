/**
 * QA Phase 6 — /staff (staff, custom roles, performance) and /outlets (outlets, current
 * outlet settings, shifts): contract, role ladder (no escalation through the body),
 * cross-tenant / cross-outlet, validation, idempotency.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotel, startServer, type Hotel } from "../integration/helpers";
import { addUser, allowedRoles, cast, createPlatformAdmin, db, expectAuthz, expectNoSecrets, HOTEL_ROLES, HUGE, NASTY, signIn, uniqPhone, type Cast, type Session } from "./kit-auth";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel, other: Hotel;
let c: Cast;
let owner: Session, manager: Session, otherOwner: Session;

beforeAll(async () => {
  srv = await startServer();
  [h, other] = [await createHotel("Staff API"), await createHotel("Staff Other")];
  c = await cast(srv.base, h);
  owner = c.clients.BUSINESS_OWNER;
  manager = c.clients.OUTLET_MANAGER;
  otherOwner = await signIn(srv.base, other.users.owner.email, other.outletId);
});
afterAll(() => srv.close());

const newStaff = (over: Record<string, unknown> = {}) => ({ name: "New Cashier", phone: uniqPhone(), role: "CASHIER", outletIds: [h.outletId], ...over });

describe("authorization matrix (rbac table)", () => {
  it.each([
    ["GET", "/staff", ["staff:view"]],
    ["GET", "/staff/roles", null],
    ["POST", "/staff/roles", ["outlet:manage"]],
    ["POST", "/staff", ["staff:manage"]],
    ["GET", "/outlets", []],
    ["GET", "/outlets/current", []],
    ["POST", "/outlets", ["outlet:manage"]],
    ["PATCH", "/outlets/current", ["settings:outlet"]],
    ["GET", "/outlets/current/shifts", []],
    ["POST", "/outlets/current/shifts", ["staff:manage"]],
  ] as const)("%s %s", async (method, path, perms) => {
    // GET /staff/roles: staff:manage OR outlet:manage
    const allowed = perms === null ? (["BUSINESS_OWNER", "OUTLET_MANAGER"] as const) : allowedRoles([...perms], method);
    await expectAuthz(c, method, path, allowed, method === "GET" ? undefined : {});
  });

  it("per-staff routes: staff:view to read, staff:manage to change", async () => {
    const target = c.ids.CASHIER;
    await expectAuthz(c, "GET", `/staff/${target}/performance`, allowedRoles(["staff:view"], "GET"));
    await expectAuthz(c, "PATCH", `/staff/${c.ids.KITCHEN}`, allowedRoles(["staff:manage"], "PATCH"), {});
  });

  it("the platform admin can't list, create or edit any hotel's staff or outlets", async () => {
    const admin = await signIn(srv.base, (await createPlatformAdmin()).email);
    for (const [m, p, b] of [
      ["GET", "/staff"],
      ["POST", "/staff", newStaff()],
      ["PATCH", `/staff/${c.ids.CASHIER}`, { name: "Hacked" }],
      ["GET", "/outlets/current"],
      ["PATCH", "/outlets/current", { name: "Hacked" }],
    ] as const) {
      const r = await admin.call(m, p, b, { "x-outlet-id": h.outletId, "x-business-id": h.businessId });
      expect(r.status, `${m} ${p}`).toBe(403);
    }
    const list = await admin.call("GET", "/outlets");
    expect(list.body).toEqual([]);
  });
});

describe("GET /staff", () => {
  it("contract: public fields only — no password/PIN hashes, Aadhaar or TOTP secret", async () => {
    await db.user.update({ where: { id: c.ids.CASHIER }, data: { pinHash: "$2a$04$abcdefghijklmnopqrstuuJ0123456789012345678901234567", aadhaarLast4: "4321" } });
    const r = await owner.call("GET", "/staff");
    expect(r.status).toBe(200);
    expectNoSecrets(r.body);
    expect(JSON.stringify(r.body)).not.toMatch(/aadhaar|pin|4321/i);
    const row = r.body.find((u: { id: string }) => u.id === c.ids.CASHIER);
    expect(Object.keys(row).sort()).toEqual(["createdAt", "customRoleId", "email", "id", "name", "outlets", "phone", "photoUrl", "role", "salaryAmount", "salaryType", "shiftId", "status", "totpEnabledAt"]);
    expect(Number.isInteger(row.salaryAmount)).toBe(true);
  });

  it("outlet-scoped by default; ?scope=business only widens it for the owner", async () => {
    const o2 = await addUser(h, "CASHIER", [h.outlet2Id]);
    const ids = (r: { body: { id: string }[] }) => r.body.map((u) => u.id);
    expect(ids(await owner.call("GET", "/staff"))).not.toContain(o2.id);
    expect(ids(await owner.call("GET", "/staff?scope=business"))).toContain(o2.id);
    expect(ids(await owner.call("GET", "/staff?scope=business"))).toContain(c.ids.BUSINESS_OWNER);
    expect(ids(await manager.call("GET", "/staff?scope=business"))).not.toContain(o2.id);
  });

  it("cross-outlet: a manager of outlet 1 using outlet 2's header → 403", async () => {
    expect((await manager.call("GET", "/staff", undefined, { "x-outlet-id": h.outlet2Id })).status).toBe(403);
  });

  it("cross-tenant: another hotel's owner never sees this hotel's staff (header → 403)", async () => {
    expect((await otherOwner.call("GET", "/staff", undefined, { "x-outlet-id": h.outletId })).status).toBe(403);
    const mine = await otherOwner.call("GET", "/staff?scope=business");
    expect(mine.body.map((u: { id: string }) => u.id)).not.toContain(c.ids.CASHIER);
  });
});

describe("POST /staff", () => {
  it("201 contract; PIN and password are stored hashed and never returned", async () => {
    const r = await owner.call("POST", "/staff", newStaff({ pin: "4821", password: "Masala-Dosa-2026", email: "New.Cashier.X@It.Local" }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expectNoSecrets(r.body);
    expect(r.body).toMatchObject({ role: "CASHIER", status: "ACTIVE", email: "new.cashier.x@it.local", salaryType: "MONTHLY", salaryAmount: 0, outlets: [{ outletId: h.outletId }] });
    expect(JSON.stringify(r.body)).not.toContain("4821");
    const row = await db.user.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(row.pinHash).toMatch(/^\$2[aby]\$/);
    expect(row.businessId).toBe(h.businessId);
  });

  it.each([
    ["missing name", { name: undefined }],
    ["1-char name", { name: "A" }],
    ["10k name", { name: HUGE }],
    ["bad phone", { phone: "12345" }],
    ["bad email", { email: "nope" }],
    ["weak password", { password: "123" }],
    ["3-digit pin", { pin: "123" }],
    ["letters pin", { pin: "abcd" }],
    ["unknown role", { role: "GOD" }],
    ["no outlets for a cashier", { outletIds: [] }],
    ["outletIds not an array", { outletIds: "x" }],
    ["negative salary", { salaryAmount: -100 }],
    ["float salary (paise)", { salaryAmount: 100.5 }],
    ["string salary", { salaryAmount: "1000" }],
    ["bad salaryType", { salaryType: "HOURLY" }],
    ["null name", { name: null }],
  ])("400 on %s (nothing written)", async (_n, over) => {
    const body = newStaff(over);
    const before = await db.user.count({ where: { businessId: h.businessId } });
    const r = await owner.call("POST", "/staff", body);
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(await db.user.count({ where: { businessId: h.businessId } })).toBe(before);
  });

  it("huge salary (beyond a 32-bit integer) is 400, never 500", async () => {
    const r = await owner.call("POST", "/staff", newStaff({ salaryAmount: 1e12 }));
    expect(r.status, JSON.stringify(r.body)).toBe(400);
  });

  it("an unknown or another outlet's shiftId is 400, never 500 / a dangling link", async () => {
    expect((await owner.call("POST", "/staff", newStaff({ shiftId: "cl0000000000000000000000" }))).status).toBe(400);
    const theirShift = await db.shift.create({ data: { outletId: other.outletId, name: "Theirs", startTime: "09:00", endTime: "17:00" } });
    expect((await owner.call("POST", "/staff", newStaff({ shiftId: theirShift.id }))).status).toBe(400);
    const mine = await db.shift.create({ data: { outletId: h.outletId, name: "Morning", startTime: "06:00", endTime: "14:00" } });
    expect((await owner.call("POST", "/staff", newStaff({ shiftId: mine.id }))).status).toBe(201);
  });

  it("mass assignment: businessId / status / id / tokenVersion / failedLogins in the body are ignored", async () => {
    const r = await owner.call("POST", "/staff", newStaff({ businessId: other.businessId, status: "SUSPENDED", id: "cl1111111111111111111111", tokenVersion: 99, pinHash: "x", passwordHash: "x", aadhaarLast4: "9999" }));
    expect(r.status).toBe(201);
    const row = await db.user.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(row).toMatchObject({ businessId: h.businessId, status: "ACTIVE", tokenVersion: 0, pinHash: null, passwordHash: null, aadhaarLast4: null });
    expect(row.id).not.toBe("cl1111111111111111111111");
  });

  it("unicode, emoji and hostile names round-trip intact as inert text", async () => {
    for (const name of Object.values(NASTY)) {
      const r = await owner.call("POST", "/staff", newStaff({ name }));
      expect(r.status, name).toBe(201);
      expect(r.body.name).toBe(name);
      expect((await owner.call("GET", "/staff")).body.find((u: { id: string }) => u.id === r.body.id).name).toBe(name);
    }
  });

  it("409 on a duplicate phone or email (not 500)", async () => {
    const first = newStaff({ email: `dup.${Date.now()}@it.local` });
    expect((await owner.call("POST", "/staff", first)).status).toBe(201);
    expect((await owner.call("POST", "/staff", newStaff({ phone: first.phone }))).status).toBe(409);
    expect((await owner.call("POST", "/staff", newStaff({ email: (first.email as string).toUpperCase() }))).status).toBe(409);
  });

  it("duplicate outletIds don't 500", async () => {
    const r = await owner.call("POST", "/staff", newStaff({ outletIds: [h.outletId, h.outletId] }));
    expect(r.status).toBeLessThan(500);
  });

  describe("role ladder — nobody creates or edits an account at or above their own rank", () => {
    it.each([
      ["OUTLET_MANAGER", ["BUSINESS_OWNER", "OUTLET_MANAGER", "ACCOUNTANT", "AUDITOR", "SUPER_ADMIN", "PLATFORM_SUPPORT"], ["CASHIER", "KITCHEN", "DELIVERY", "INVENTORY_MANAGER", "WAITER"]],
      ["BUSINESS_OWNER", ["BUSINESS_OWNER", "SUPER_ADMIN", "PLATFORM_SUPPORT"], ["OUTLET_MANAGER", "ACCOUNTANT", "AUDITOR", "CASHIER", "WAITER"]],
    ] as const)("%s", async (actor, refused, allowed) => {
      const me = actor === "BUSINESS_OWNER" ? owner : manager;
      for (const role of refused) {
        const r = await me.call("POST", "/staff", newStaff({ role, outletIds: [h.outletId] }));
        expect(r.status, `${actor} → ${role}`).toBe(403);
      }
      for (const role of allowed) {
        const r = await me.call("POST", "/staff", newStaff({ role }));
        expect(r.status, `${actor} → ${role}: ${JSON.stringify(r.body)}`).toBe(201);
        expect(r.body.role).toBe(role);
      }
    });

    it("a manager can't promote a cashier, edit the owner or another manager, or change their own role/status/outlets", async () => {
      const cashier = (await manager.call("POST", "/staff", newStaff())).body.id;
      expect((await manager.call("PATCH", `/staff/${cashier}`, { role: "OUTLET_MANAGER" })).status).toBe(403);
      expect((await manager.call("PATCH", `/staff/${cashier}`, { role: "BUSINESS_OWNER" })).status).toBe(403);
      expect((await manager.call("PATCH", `/staff/${c.ids.BUSINESS_OWNER}`, { name: "Owned" })).status).toBe(404);
      const m2 = await addUser(h, "OUTLET_MANAGER");
      expect((await manager.call("PATCH", `/staff/${m2.id}`, { name: "Other manager" })).status).toBe(403);
      expect((await manager.call("PATCH", `/staff/${m2.id}`, { password: "Masala-Dosa-2026" })).status).toBe(403);
      for (const body of [{ role: "BUSINESS_OWNER" }, { role: "OUTLET_MANAGER" }, { status: "ACTIVE" }, { outletIds: [h.outletId] }, { customRoleId: null }])
        expect((await manager.call("PATCH", `/staff/${c.ids.OUTLET_MANAGER}`, body)).status, JSON.stringify(body)).toBe(403);
      expect((await db.user.findUniqueOrThrow({ where: { id: c.ids.OUTLET_MANAGER } })).role).toBe("OUTLET_MANAGER");
      // …but may change their own name
      expect((await manager.call("PATCH", `/staff/${c.ids.OUTLET_MANAGER}`, { name: "Manager Renamed" })).status).toBe(200);
    });

    it("the owner can't change their own role or another owner", async () => {
      expect((await owner.call("PATCH", `/staff/${c.ids.BUSINESS_OWNER}`, { role: "SUPER_ADMIN" })).status).toBe(403);
      const o2 = await addUser(h, "BUSINESS_OWNER");
      expect((await owner.call("PATCH", `/staff/${o2.id}`, { status: "INACTIVE" })).status).toBe(403);
    });

    it("a manager can only assign their own outlets", async () => {
      expect((await manager.call("POST", "/staff", newStaff({ outletIds: [h.outlet2Id] }))).status).toBe(403);
      expect((await manager.call("POST", "/staff", newStaff({ outletIds: [other.outletId] }))).status).toBe(403);
      expect((await owner.call("POST", "/staff", newStaff({ outletIds: [other.outletId] }))).status).toBe(403);
    });
  });
});

describe("PATCH /staff/:id", () => {
  it("200; role change or deactivation signs the person out at once", async () => {
    const u = await addUser(h, "CASHIER");
    const s = await signIn(srv.base, u.email, h.outletId);
    const r = await owner.call("PATCH", `/staff/${u.id}`, { role: "WAITER" });
    expect(r.status).toBe(200);
    expectNoSecrets(r.body);
    expect(r.body.role).toBe("WAITER");
    expect((await s.call("GET", "/auth/me")).status).toBe(401);
  });

  it("400 on invalid fields, 404 for an unknown id or another hotel's staff member", async () => {
    for (const body of [{ name: "" }, { status: "DELETED" }, { salaryAmount: -1 }, { phone: "1" }, { pin: "12" }, { role: null }])
      expect((await owner.call("PATCH", `/staff/${c.ids.KITCHEN}`, body)).status, JSON.stringify(body)).toBe(400);
    expect((await owner.call("PATCH", "/staff/cl0000000000000000000000", { name: "Ghost" })).status).toBe(404);
    expect((await otherOwner.call("PATCH", `/staff/${c.ids.KITCHEN}`, { name: "Stolen" })).status).toBe(404);
    expect((await db.user.findUniqueOrThrow({ where: { id: c.ids.KITCHEN } })).name).not.toBe("Stolen");
  });

  it("a manager changing outlets can't remove someone from an outlet they don't run", async () => {
    const both = await addUser(h, "CASHIER", [h.outletId, h.outlet2Id]);
    const r = await manager.call("PATCH", `/staff/${both.id}`, { outletIds: [h.outletId] });
    expect(r.status).toBe(200);
    const outlets = (await db.userOutlet.findMany({ where: { userId: both.id } })).map((o) => o.outletId).sort();
    expect(outlets).toEqual([h.outletId, h.outlet2Id].sort());
    // the owner can
    expect((await owner.call("PATCH", `/staff/${both.id}`, { outletIds: [h.outletId] })).status).toBe(200);
    expect((await db.userOutlet.findMany({ where: { userId: both.id } })).map((o) => o.outletId)).toEqual([h.outletId]);
  });

  it("a manager can't edit staff of an outlet they don't run", async () => {
    const o2 = await addUser(h, "CASHIER", [h.outlet2Id]);
    expect((await manager.call("PATCH", `/staff/${o2.id}`, { name: "x y" })).status).toBe(404);
  });

  it("reset-link and reset-2fa: 404 for unknown/foreign, 403 on yourself (2FA) or above you", async () => {
    expect((await owner.call("POST", "/staff/cl0000000000000000000000/reset-link")).status).toBe(404);
    expect((await otherOwner.call("POST", `/staff/${c.ids.CASHIER}/reset-link`)).status).toBe(404);
    const link = await owner.call("POST", `/staff/${c.ids.CASHIER}/reset-link`);
    expect(link.status).toBe(200);
    expect(link.body).toHaveProperty("channel");
    expect((await owner.call("POST", `/staff/${c.ids.BUSINESS_OWNER}/reset-2fa`)).status).toBe(403);
    expect((await manager.call("POST", `/staff/${c.ids.OUTLET_MANAGER}/reset-2fa`)).status).toBe(403);
    const victim = await addUser(h, "DELIVERY");
    expect((await owner.call("POST", `/staff/${victim.id}/reset-2fa`)).status).toBe(200);
  });
});

describe("GET /staff/:id/performance", () => {
  it("200 with integer money/count fields; 404 unknown / foreign", async () => {
    const r = await owner.call("GET", `/staff/${c.ids.CASHIER}/performance?days=7`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ days: 7, billsRaised: 0, salesValue: 0, itemsSold: 0 });
    for (const k of ["salesValue", "billsRaised", "attendancePercent", "overtimeMinutes"]) expect(Number.isInteger(r.body[k]), k).toBe(true);
    expect((await owner.call("GET", "/staff/cl0000000000000000000000/performance")).status).toBe(404);
    expect((await otherOwner.call("GET", `/staff/${c.ids.CASHIER}/performance`)).status).toBe(404);
  });

  it.each(["abc", "0", "-5", "1.5", "99999"])("?days=%s is 400 or clamped — never 500 / NaN", async (days) => {
    const r = await owner.call("GET", `/staff/${c.ids.CASHIER}/performance?days=${days}`);
    expect(r.status, JSON.stringify(r.body)).not.toBe(500);
    if (r.status === 200) {
      expect(Number.isInteger(r.body.days) && r.body.days >= 1 && r.body.days <= 365).toBe(true);
      expect(Number.isInteger(r.body.attendancePercent)).toBe(true);
    } else expect(r.status).toBe(400);
  });
});

describe("custom roles", () => {
  it("201 contract, 400 on bad input, 404 unknown, cross-tenant invisible", async () => {
    const r = await owner.call("POST", "/staff/roles", { name: "Senior cashier ☕", baseRole: "CASHIER", permissions: ["order:create", "order:view"] });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ name: "Senior cashier ☕", baseRole: "CASHIER", businessId: h.businessId });
    for (const body of [
      {},
      { name: "X", baseRole: "CASHIER", permissions: [] },
      { name: "Boss", baseRole: "BUSINESS_OWNER", permissions: [] },
      { name: "Boss", baseRole: "CASHIER", permissions: ["platform:manage"] },
      { name: "Boss", baseRole: "CASHIER", permissions: ["staff:manage"] },
      { name: HUGE, baseRole: "CASHIER", permissions: [] },
    ])
      expect((await owner.call("POST", "/staff/roles", body)).status, JSON.stringify(body).slice(0, 80)).toBe(400);
    expect((await owner.call("PATCH", "/staff/roles/cl0000000000000000000000", { name: "Nope" })).status).toBe(404);
    expect((await owner.call("DELETE", "/staff/roles/cl0000000000000000000000")).status).toBe(404);
    expect((await otherOwner.call("PATCH", `/staff/roles/${r.body.id}`, { name: "Stolen" })).status).toBe(404);
    expect((await otherOwner.call("DELETE", `/staff/roles/${r.body.id}`)).status).toBe(404);
    expect((await otherOwner.call("GET", "/staff/roles")).body.map((x: { id: string }) => x.id)).not.toContain(r.body.id);
    // A custom role from another hotel can't be given to staff
    expect((await otherOwner.call("POST", "/staff", { name: "Cross", phone: uniqPhone(), role: "CASHIER", outletIds: [other.outletId], customRoleId: r.body.id })).status).toBe(400);
    expect((await owner.call("DELETE", `/staff/roles/${r.body.id}`)).status).toBe(204);
  });
});

describe("idempotency", () => {
  it("POST /staff with the same Idempotency-Key twice creates one account and replays the response", async () => {
    const body = newStaff();
    const key = `staff-${Date.now()}`;
    const a = await owner.call("POST", "/staff", body, { "idempotency-key": key });
    expect(a.status).toBe(201);
    await new Promise((r) => setTimeout(r, 100));
    const b = await owner.call("POST", "/staff", body, { "idempotency-key": key });
    expect(b.status).toBe(201);
    expect(b.headers.get("idempotent-replayed")).toBe("true");
    expect(b.body).toEqual(a.body);
    expect(await db.user.count({ where: { phone: body.phone } })).toBe(1);
    // same key, different body → 422
    expect((await owner.call("POST", "/staff", newStaff(), { "idempotency-key": key })).status).toBe(422);
  });
});

describe("/outlets", () => {
  it("GET: staff without settings:view get the basic fields only (no GSTIN, UPI, FSSAI)", async () => {
    await db.outlet.update({ where: { id: h.outletId }, data: { gstin: "33ABCDE1234F1Z7", upiVpa: "hotel@upi", fssai: "12345678901234" } });
    for (const role of HOTEL_ROLES) {
      const r = await c.clients[role].call("GET", "/outlets");
      expect(r.status, role).toBe(200);
      const o = r.body.find((x: { id: string }) => x.id === h.outletId);
      const sensitive = ["gstin", "upiVpa", "fssai", "invoicePrefix"].some((k) => k in o);
      const canSee = ["BUSINESS_OWNER", "OUTLET_MANAGER", "CASHIER"].includes(role);
      expect(sensitive, role).toBe(canSee);
      // managers etc. see only their own outlets; the owner both
      expect(r.body.map((x: { id: string }) => x.id).sort(), role).toEqual(role === "BUSINESS_OWNER" ? [h.outletId, h.outlet2Id].sort() : [h.outletId]);
    }
  });

  it("POST: 201, businessId comes from the session (smuggled one ignored); 400 on invalid fields", async () => {
    const r = await owner.call("POST", "/outlets", { name: "Third ☕ கடை", stateCode: "33", businessId: other.businessId, id: "cl2222222222222222222222" });
    expect(r.status).toBe(201);
    expect(r.body.businessId).toBe(h.businessId);
    expect(r.body.name).toBe("Third ☕ கடை");
    for (const body of [
      {},
      { name: "X", stateCode: "33" },
      { name: "Okay", stateCode: "3" },
      { name: "Okay", stateCode: "33", gstin: "BADGSTIN" },
      { name: "Okay", stateCode: "33", geofenceMeters: 5 },
      { name: "Okay", stateCode: "33", packagingCharge: 10.5 },
      { name: "Okay", stateCode: "33", packagingCharge: -1 },
      { name: "Okay", stateCode: "33", latitude: 91 },
      { name: HUGE, stateCode: "33" },
      { name: "Okay", stateCode: "33", gstEnabled: false, compositionScheme: true },
    ])
      expect((await owner.call("POST", "/outlets", body)).status, JSON.stringify(body).slice(0, 80)).toBe(400);
  });

  it("an invalid timezone is refused (400) — it would break every date screen of the outlet", async () => {
    expect((await owner.call("POST", "/outlets", { name: "Mars", stateCode: "33", timezone: "Mars/Olympus_Mons" })).status).toBe(400);
    const r = await manager.call("PATCH", "/outlets/current", { timezone: "Not/AZone" });
    expect(r.status).toBe(400);
    // and the outlet still works
    expect((await manager.call("GET", `/staff/${c.ids.CASHIER}/performance`)).status).toBe(200);
  });

  it("PATCH /current: billing fields need settings:billing, approval limit owner only; foreign outlet header 403", async () => {
    const ok = await manager.call("PATCH", "/outlets/current", { phone: "0442222333", address: NASTY.xss });
    expect(ok.status).toBe(200);
    expect(ok.body.address).toBe(NASTY.xss);
    expect((await manager.call("PATCH", "/outlets/current", { approvalDiscountPercent: 50 })).status).toBe(403);
    expect((await owner.call("PATCH", "/outlets/current", { approvalDiscountPercent: 50 })).status).toBe(200);
    expect((await manager.call("PATCH", "/outlets/current", { name: "x" })).status).toBe(400);
    expect((await manager.call("PATCH", "/outlets/current", { name: "Other" }, { "x-outlet-id": h.outlet2Id })).status).toBe(403);
    expect((await otherOwner.call("PATCH", "/outlets/current", { name: "Pwned" }, { "x-outlet-id": h.outletId })).status).toBe(403);
    // smuggled businessId / id are dropped
    const r = await owner.call("PATCH", "/outlets/current", { businessId: other.businessId, id: "cl3333333333333333333333" });
    expect(r.status).toBe(200);
    expect(r.body.businessId).toBe(h.businessId);
    expect(r.body.id).toBe(h.outletId);
  });

  it("shifts: 201 contract, 400 on bad times, delete is scoped to the outlet", async () => {
    const r = await manager.call("POST", "/outlets/current/shifts", { name: "Night ☾", startTime: "22:00", endTime: "06:00" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ outletId: h.outletId, graceMinutes: 10 });
    for (const body of [{}, { name: "x", startTime: "25:00", endTime: "06:00" }, { name: "x", startTime: "9:00", endTime: "17:00" }, { name: "", startTime: "09:00", endTime: "17:00" }, { name: "x", startTime: "09:00", endTime: "17:00", graceMinutes: 500 }, { name: "x", startTime: "09:00", endTime: "17:00", graceMinutes: 1.5 }])
      expect((await manager.call("POST", "/outlets/current/shifts", body)).status, JSON.stringify(body)).toBe(400);
    // another hotel's owner deleting it → 403 (header) / no-op (own outlet)
    expect((await otherOwner.call("DELETE", `/outlets/current/shifts/${r.body.id}`)).status).toBe(204);
    expect(await db.shift.findUnique({ where: { id: r.body.id } })).not.toBeNull();
    expect((await manager.call("DELETE", `/outlets/current/shifts/${r.body.id}`)).status).toBe(204);
    expect(await db.shift.findUnique({ where: { id: r.body.id } })).toBeNull();
  });
});
