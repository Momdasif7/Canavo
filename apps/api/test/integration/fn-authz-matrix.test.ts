/**
 * Role × module authorization matrix (Phase 5), generated from the LIVE route
 * inventory (test/static/route-inventory.ts) — so new endpoints are covered
 * automatically.
 *
 *  AZ-ROLE: every role that lacks a route's required permission gets 403
 *           (guards run before handlers, so nothing is mutated).
 *  AZ-GET : every parameter-free GET answers < 500 and ≠ 403 for every role
 *           that HAS its permissions (no crashes on empty/default queries).
 *  AZ-MOD : for each module switched off, every route gated by that module
 *           (module guard or module-gated permission) is 403 for the owner.
 */
import request from "supertest";
import { beforeAll, describe, expect, it } from "vitest";
import { MODULES, normalizeModules, PERMISSION_MODULE, can, type ModuleKey, type Permission, type Role } from "@canavo/shared";
import { routeInventory, type RouteEntry } from "../static/route-inventory";
import { app, createTenant, db, demoTenant, PASSWORD } from "./helpers";

const ROLE_EMAIL: Record<Role, string> = {
  SUPER_ADMIN: "admin@canavo.local",
  BUSINESS_OWNER: "owner@canavo.local",
  OUTLET_MANAGER: "manager@canavo.local",
  CASHIER: "cashier@canavo.local",
  KITCHEN: "kitchen@canavo.local",
  INVENTORY_MANAGER: "inventory@canavo.local",
  DELIVERY: "delivery@canavo.local",
};
const ROLES = Object.keys(ROLE_EMAIL) as Role[];

let routes: RouteEntry[];
let outletId: string;
const tokens = {} as Record<Role, string>;

async function login(email: string) {
  const r = await request(app).post("/auth/login").send({ email, password: PASSWORD });
  if (r.status !== 200) throw new Error(`login ${email}: ${r.status}`);
  return r.body.accessToken as string;
}

function send(route: RouteEntry, token: string, outlet: string | null) {
  const path = route.path.replace(/:(\w+)/g, "zz-nonexistent-$1");
  let r = request(app)[route.method.toLowerCase() as "get"](path).set("authorization", `Bearer ${token}`);
  if (outlet) r = r.set("x-outlet-id", outlet);
  return route.method === "GET" || route.method === "DELETE" ? r : r.send({});
}

beforeAll(async () => {
  routes = (await routeInventory()).filter((r) => r.authenticate);
  outletId = (await demoTenant()).outlet.id;
  for (const role of ROLES) tokens[role] = await login(ROLE_EMAIL[role]);
}, 120_000);

describe("@critical @regression AZ-ROLE role lacking a permission → 403", () => {
  it("AZ-ROLE-001 every permission-guarded route refuses every role without that permission", async () => {
    const failures: string[] = [];
    let checked = 0;
    for (const route of routes.filter((r) => r.permissions.length)) {
      for (const role of ROLES) {
        if (route.permissions.every((p) => can(role, p as Permission))) continue;
        const res = await send(route, tokens[role], role === "SUPER_ADMIN" ? null : outletId);
        checked++;
        // A Super Admin without an outlet is stopped by requireOutlet (400 "X-Outlet-Id required") before
        // the permission check — still a refusal; AZ-ROLE-002 proves 403 when an outlet is supplied.
        const refused = res.status === 403 || (role === "SUPER_ADMIN" && route.outlet === "required" && res.status === 400);
        if (!refused) {
          const again = await send(route, tokens[role], role === "SUPER_ADMIN" ? null : outletId);
          const me = await request(app).get("/auth/me").set("authorization", `Bearer ${tokens[role]}`);
          failures.push(`${role} ${route.method} ${route.path} → ${res.status} ${JSON.stringify(res.body).slice(0, 100)} | retry ${again.status} | me=${me.body.role}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
    expect(failures).toEqual([]);
  }, 300_000);

  it("AZ-ROLE-002 the Super Admin is refused every outlet-scoped route even with an outlet header", async () => {
    const failures: string[] = [];
    for (const route of routes.filter((r) => r.outlet === "required")) {
      const res = await send(route, tokens.SUPER_ADMIN, outletId);
      if (res.status !== 403) failures.push(`${route.method} ${route.path} → ${res.status} ${JSON.stringify(res.body).slice(0, 160)}`);
    }
    expect(failures).toEqual([]);
  }, 300_000);
});

describe("@regression AZ-GET permitted roles never get 403/500 on parameter-free GETs", () => {
  it("AZ-GET-001 every list/report GET works for every role that holds its permissions", async () => {
    const failures: string[] = [];
    let checked = 0;
    for (const route of routes.filter((r) => r.method === "GET" && !r.path.includes(":"))) {
      for (const role of ROLES) {
        if (role === "SUPER_ADMIN" && route.outlet === "required") continue;
        if (!route.permissions.every((p) => can(role, p as Permission))) continue;
        if (route.platformAdmin && role !== "SUPER_ADMIN") continue;
        if (route.permissions.length === 0 && (route.custom.length || route.anonymous)) continue; // local/inline guards: covered by module suites
        const res = await send(route, tokens[role], role === "SUPER_ADMIN" ? null : outletId);
        checked++;
        // 400 is acceptable (required query params); 403/5xx are not.
        if (res.status >= 500 || res.status === 403) failures.push(`${role} GET ${route.path} → ${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
      }
    }
    expect(checked).toBeGreaterThan(150);
    expect(failures).toEqual([]);
  }, 300_000);
});

describe("@critical @regression AZ-MOD a disabled module's endpoints are refused", () => {
  it("AZ-MOD-001 for each module switched off, the owner gets 403 on every route gated by it", async () => {
    const t = await createTenant({ name: "Module matrix" });
    const ownerToken = await login(t.users.BUSINESS_OWNER.email);
    const failures: string[] = [];
    let checked = 0;
    for (const off of MODULES) {
      // Everything except `off` and the modules that depend on it
      const on = normalizeModules(MODULES.filter((m) => m !== off)).filter((m) => m !== off);
      const enabled = normalizeModules(on.filter((m) => !(normalizeModules([m]).includes(off) && m !== off)));
      await db.business.update({ where: { id: t.business.id }, data: { modules: enabled } });
      for (const route of routes) {
        const permOff = route.permissions.some((p) => {
          const m = PERMISSION_MODULE[p as Permission];
          return (m && !enabled.includes(m)) || ((p === "menu:view" || p === "menu:manage") && !enabled.includes("BILLING") && !enabled.includes("INVENTORY"));
        });
        const guardOff = route.modules.length > 0 && !route.modules.some((m) => enabled.includes(m as ModuleKey));
        if (!permOff && !guardOff) continue;
        if (!route.permissions.every((p) => can("BUSINESS_OWNER", p as Permission))) continue; // role 403 would mask module 403
        const res = await send(route, ownerToken, t.outlet.id);
        checked++;
        if (res.status !== 403) failures.push(`[${off} off] ${route.method} ${route.path} → ${res.status}`);
      }
    }
    expect(checked).toBeGreaterThan(150);
    expect(failures).toEqual([]);
  }, 600_000);
});
