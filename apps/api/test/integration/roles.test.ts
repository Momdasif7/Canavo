/** Phase 4.1 + 4.2 — waiter, accountant, auditor, custom roles and platform support. */
import bcrypt from "bcryptjs";
import type { Role } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currentStep, totpAt } from "../../src/lib/totp";
import { createHotel, db, login, PASSWORD, startServer, type Client, type Hotel } from "./helpers";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel;
let owner: Client, manager: Client;
let n = 0;

/** Another account in the hotel's main outlet (or a platform account when role is a platform role). */
async function addUser(role: Role, opts: { businessId?: string | null; customRoleId?: string } = {}) {
  const email = `${role.toLowerCase()}.${Date.now()}.${n++}@it.local`;
  const platform = role === "PLATFORM_SUPPORT" || role === "SUPER_ADMIN";
  const u = await db.user.create({
    data: {
      businessId: platform ? null : (opts.businessId ?? h.businessId),
      role,
      name: `${role} ${n}`,
      email,
      phone: `9${String(Date.now()).slice(-7)}${String(n).padStart(2, "0")}`,
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      customRoleId: opts.customRoleId,
      ...(!platform && { outlets: { create: [{ outletId: h.outletId }] } }),
    },
  });
  return { id: u.id, email };
}

const month = new Date().toISOString().slice(0, 7);

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("Roles");
  owner = await login(srv.base, h.users.owner.email, h.outletId);
  manager = await login(srv.base, h.users.manager.email, h.outletId);
});
afterAll(() => srv.close());

describe("waiter / captain", () => {
  let waiter: Client;
  let waiterId: string;
  let tableId: string;

  beforeAll(async () => {
    const w = await addUser("WAITER");
    waiterId = w.id;
    waiter = await login(srv.base, w.email, h.outletId);
    tableId = (await db.diningTable.create({ data: { outletId: h.outletId, label: `W${n}` } })).id;
  });

  it("opens a table, adds items and a KOT goes to the kitchen; the tab is theirs", async () => {
    const open = await waiter.call("POST", `/tables/${tableId}/open`, { guests: 2 });
    expect(open.status, JSON.stringify(open.body)).toBe(201);
    const session = await db.tableSession.findFirstOrThrow({ where: { tableId, status: "OPEN" } });
    expect(session.waiterId).toBe(waiterId);

    const add = await waiter.call("POST", `/tables/sessions/${session.id}/items`, { items: [{ menuItemId: h.items.chai, quantity: 2 }] });
    expect(add.status, JSON.stringify(add.body)).toBe(201);
    expect(add.body.kots.length).toBeGreaterThan(0);
    expect(await db.kotTicket.count({ where: { sessionId: session.id } })).toBeGreaterThan(0);
    expect((await waiter.call("GET", "/kot")).status).toBe(200);

    // Billing and money stay with the cashier / manager.
    expect((await waiter.call("POST", `/tables/sessions/${session.id}/bill`, { mode: "FULL" })).status).toBe(403);
    const me = (await waiter.call("GET", "/auth/me")).body;
    expect(me.permissions).toContain("table:serve");
    expect(me.permissions).not.toContain("payment:collect");
  });

  it("can't take payments, see the bills list or reports", async () => {
    const order = await manager.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.samosa, quantity: 1 }] });
    expect(order.status).toBe(201);
    expect((await waiter.call("POST", `/orders/${order.body.id}/payments`, { payments: [{ mode: "CASH", amount: order.body.grandTotal }] })).status).toBe(403);
    expect((await waiter.call("GET", "/orders")).status).toBe(403);
    expect((await waiter.call("GET", `/reports/daily`)).status).toBe(403);
    expect((await waiter.call("GET", `/reports/gstr1?month=${month}`)).status).toBe(403);
  });

  it("managers can add waiters", async () => {
    const r = await manager.call("POST", "/staff", { name: "New Waiter", phone: "9811122233", role: "WAITER", outletIds: [h.outletId] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
  });
});

describe("accountant", () => {
  let acc: Client;
  beforeAll(async () => {
    acc = await login(srv.base, (await addUser("ACCOUNTANT")).email, h.outletId);
  });

  it("sees reports (incl. GSTR-1), bills and stock", async () => {
    expect((await acc.call("GET", "/reports/daily")).status).toBe(200);
    expect((await acc.call("GET", `/reports/gstr1?month=${month}`)).status).toBe(200);
    expect((await acc.call("GET", "/orders")).status).toBe(200);
  });

  it("can't bill, refund, void or manage staff", async () => {
    expect((await acc.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.chai, quantity: 1 }] })).status).toBe(403);
    const order = await manager.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.chai, quantity: 1 }] });
    await manager.call("POST", `/orders/${order.body.id}/payments`, { payments: [{ mode: "CASH", amount: order.body.grandTotal }] });
    expect((await acc.call("POST", `/orders/${order.body.id}/refunds`, { reason: "QUALITY", refundMode: "CASH", amount: 100 })).status).toBe(403);
    expect((await acc.call("POST", `/orders/${order.body.id}/cancel`, { reason: "test" })).status).toBe(403);
    expect((await acc.call("POST", "/staff", { name: "X Person", phone: "9822233344", role: "CASHIER", outletIds: [h.outletId] })).status).toBe(403);
  });

  it("only the owner adds accountants and auditors, not managers", async () => {
    expect((await manager.call("POST", "/staff", { name: "Acc Two", phone: "9833344455", role: "ACCOUNTANT", outletIds: [h.outletId] })).status).toBe(403);
    expect((await owner.call("POST", "/staff", { name: "Acc Two", phone: "9833344455", role: "ACCOUNTANT", outletIds: [h.outletId] })).status).toBe(201);
  });
});

describe("auditor", () => {
  let aud: Client;
  beforeAll(async () => {
    aud = await login(srv.base, (await addUser("AUDITOR")).email, h.outletId);
  });

  it("reads reports, bills, the audit log and staff", async () => {
    expect((await aud.call("GET", "/reports/daily")).status).toBe(200);
    expect((await aud.call("GET", "/orders")).status).toBe(200);
    expect((await aud.call("GET", "/admin/audit-logs")).status).not.toBe(403);
    expect((await aud.call("GET", "/staff")).status).toBe(200);
  });

  it("every write is refused, whatever the route", async () => {
    const writes: [string, string, unknown][] = [
      ["POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.chai, quantity: 1 }] }],
      ["POST", "/staff", { name: "Y Person", phone: "9844455566", role: "CASHIER", outletIds: [h.outletId] }],
      ["PATCH", "/outlets/current", { name: "Renamed" }],
      ["POST", "/settlements", {}],
      ["DELETE", `/staff/roles/x`, undefined],
      ["POST", "/attendance/clock-in", { latitude: 13, longitude: 80.2 }],
    ];
    for (const [method, path, body] of writes) {
      const r = await aud.call(method, path, body);
      expect(r.status, `${method} ${path}`).toBe(403);
    }
    const r = await aud.call("POST", "/orders", { orderType: "TAKEAWAY", items: [] });
    expect(r.body.error).toMatch(/read-only/);
    // Signing out still works.
    expect((await aud.call("POST", "/auth/logout", {})).status).toBeLessThan(400);
  });
});

describe("custom roles", () => {
  let roleId: string;

  it("only the owner creates them, and a custom role can't add a permission", async () => {
    const managerPerms = ["report:view", "bills:view", "order:view", "order:create", "payment:collect", "staff:view", "table:serve", "kot:view", "menu:view"];
    expect((await manager.call("POST", "/staff/roles", { name: "No refunds", baseRole: "OUTLET_MANAGER", permissions: managerPerms })).status).toBe(403);
    // Base role CASHIER doesn't have report:view → refused.
    const bad = await owner.call("POST", "/staff/roles", { name: "Cashier plus", baseRole: "CASHIER", permissions: ["order:create", "report:view"] });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/only remove/);
    const r = await owner.call("POST", "/staff/roles", { name: "Manager without refunds", baseRole: "OUTLET_MANAGER", permissions: managerPerms });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    roleId = r.body.id;
    const list = await manager.call("GET", "/staff/roles");
    expect(list.body.map((x: { id: string }) => x.id)).toContain(roleId);
  });

  it("removes the permission everywhere: /auth/me, guards and refunds", async () => {
    const u = await addUser("OUTLET_MANAGER", { customRoleId: roleId });
    const c = await login(srv.base, u.email, h.outletId);
    const me = (await c.call("GET", "/auth/me")).body;
    expect(me.role).toBe("OUTLET_MANAGER");
    expect(me.customRole).toMatchObject({ id: roleId, name: "Manager without refunds" });
    expect(me.permissions).not.toContain("order:cancel");
    expect(me.permissions).not.toContain("staff:manage");
    expect(me.permissions).toContain("report:view");

    const order = await c.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.chai, quantity: 1 }] });
    expect(order.status).toBe(201);
    expect((await c.call("POST", `/orders/${order.body.id}/payments`, { payments: [{ mode: "CASH", amount: order.body.grandTotal }] })).status).toBe(200);
    expect((await c.call("POST", `/orders/${order.body.id}/refunds`, { reason: "QUALITY", refundMode: "CASH", amount: 100 })).status).toBe(403);
    expect((await c.call("POST", "/staff", { name: "Z Person", phone: "9855566677", role: "CASHIER", outletIds: [h.outletId] })).status).toBe(403);
    expect((await c.call("GET", "/reports/daily")).status).toBe(200);
  });

  it("can be given to staff only when based on their role; in-use roles can't be deleted", async () => {
    const cashierRole = await owner.call("POST", "/staff/roles", { name: "Cashier no tables", baseRole: "CASHIER", permissions: ["order:create", "payment:collect", "menu:view"] });
    expect(cashierRole.status).toBe(201);
    // A CASHIER-based role on a manager: refused.
    expect((await owner.call("PATCH", `/staff/${h.users.manager.id}`, { customRoleId: cashierRole.body.id })).status).toBe(400);
    expect((await owner.call("PATCH", `/staff/${h.users.cashier.id}`, { customRoleId: cashierRole.body.id })).status).toBe(200);
    expect((await owner.call("DELETE", `/staff/roles/${cashierRole.body.id}`)).status).toBe(409);
    // Changing their role drops the custom role built on the old one.
    expect((await owner.call("PATCH", `/staff/${h.users.cashier.id}`, { role: "WAITER" })).status).toBe(200);
    expect((await db.user.findUniqueOrThrow({ where: { id: h.users.cashier.id } })).customRoleId).toBeNull();
    expect((await owner.call("DELETE", `/staff/roles/${cashierRole.body.id}`)).status).toBe(204);
  });

  it("another business can't see or use them", async () => {
    const other = await createHotel("RolesOther");
    const otherOwner = await login(srv.base, other.users.owner.email, other.outletId);
    expect((await otherOwner.call("GET", "/staff/roles")).body).toEqual([]);
    expect((await otherOwner.call("PATCH", `/staff/${other.users.manager.id}`, { customRoleId: roleId })).status).toBe(400);
  });
});

describe("platform support", () => {
  let support: Client;
  let superAdmin: Client;

  beforeAll(async () => {
    support = await login(srv.base, (await addUser("PLATFORM_SUPPORT")).email);
    superAdmin = await login(srv.base, (await addUser("SUPER_ADMIN")).email);
  });

  it("reads the platform console", async () => {
    expect((await support.call("GET", "/platform/summary")).status).toBe(200);
    const list = await support.call("GET", "/platform/businesses");
    expect(list.status).toBe(200);
    expect((await support.call("GET", `/platform/businesses/${h.businessId}`)).status).toBe(200);
    const me = (await support.call("GET", "/auth/me")).body;
    expect(me.platformAdmin).toBe(true);
    expect(me.platformRole).toBe("PLATFORM_SUPPORT");
    expect(me.permissions).toEqual(["platform:view"]);
  });

  it("changes nothing: businesses, feature flags, owners, admins, backups", async () => {
    expect((await support.call("POST", "/platform/businesses", { name: "Nope", owner: { name: "Nope Owner", phone: "9866677788" } })).status).toBe(403);
    expect((await support.call("PATCH", `/platform/businesses/${h.businessId}`, { status: "SUSPENDED" })).status).toBe(403);
    expect((await support.call("PATCH", `/platform/businesses/${h.businessId}`, { features: { APPROVAL_PINS: true } })).status).toBe(403);
    expect((await support.call("POST", `/platform/businesses/${h.businessId}/owners/${h.users.owner.id}/reset-link`, {})).status).toBe(403);
    expect((await support.call("POST", `/platform/businesses/${h.businessId}/owners/${h.users.owner.id}/reset-2fa`, {})).status).toBe(403);
    expect((await support.call("POST", "/platform/admins", { name: "Sneaky", phone: "9877788899", email: "sneaky@it.local", password: "Sneaky@12345", role: "SUPER_ADMIN" })).status).toBe(403);
    expect((await support.call("GET", "/admin/backups")).status).toBe(403);
    expect((await support.call("POST", "/admin/backups", {})).status).toBe(403);
    // Still can't open a hotel's data without a grant.
    expect((await support.call("GET", "/orders", undefined, { "x-outlet-id": h.outletId })).status).toBe(403);
  });

  it("opens an owner-granted support view (read-only, with their own two-step login)", async () => {
    const asSupport = (path: string, method = "GET", body?: unknown) => support.call(method, path, body, { "x-support-business": h.businessId, "x-outlet-id": h.outletId });
    expect((await asSupport("/orders")).status).toBe(403);
    expect((await owner.call("POST", "/support-access", { hours: 2, reason: "Help" })).status).toBe(201);
    const noTotp = await asSupport("/orders");
    expect(noTotp.status).toBe(403);
    expect(noTotp.body.error).toMatch(/two-step login/);
    const setup = await support.call("POST", "/auth/2fa/setup");
    expect((await support.call("POST", "/auth/2fa/enable", { code: totpAt(setup.body.secret, currentStep()) })).status).toBe(200);
    expect((await asSupport("/orders")).status).toBe(200);
    expect((await asSupport("/orders", "POST", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.chai, quantity: 1 }] })).status).toBe(403);
  });

  it("the super admin creates support users from Platform → Admins", async () => {
    const r = await superAdmin.call("POST", "/platform/admins", { name: "Support Two", phone: "9888899900", email: `support2.${Date.now()}@it.local`, password: "Support@12345", role: "PLATFORM_SUPPORT" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.role).toBe("PLATFORM_SUPPORT");
    const admins = (await superAdmin.call("GET", "/platform/admins")).body as { role: string }[];
    expect(admins.some((a) => a.role === "PLATFORM_SUPPORT")).toBe(true);
    // Owners can't create platform accounts.
    expect((await owner.call("POST", "/staff", { name: "Plat Form", phone: "9899900011", role: "PLATFORM_SUPPORT", outletIds: [h.outletId] })).status).toBe(403);
  });
});
