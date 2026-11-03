/**
 * Integration helpers: in-process app, login, and a fixture factory that
 * creates extra tenants directly through the unfiltered Prisma client (the
 * platform onboarding API is exercised separately in its own tests).
 */
import http from "node:http";
import bcrypt from "bcryptjs";
import request from "supertest";
import type { Role } from "@canavo/shared";
import { createApp } from "../../src/app";
import { platformPrisma as db } from "../../src/db";

/**
 * ONE long-lived HTTP server per test file. `request(expressApp)` would start a new
 * server on a random port for every request; with Node's keep-alive global agent
 * and several test processes running in parallel, a stale keep-alive socket can be
 * re-established to a port that another process now owns — the request is then
 * answered by a different test process (seen in Phase 5 as impossible 200 {}
 * responses). supertest accepts a listening server directly.
 */
export const app = http.createServer(createApp()).listen(0, "127.0.0.1");
app.unref();
export const PASSWORD = "Canavo@123";
export { db };

/** Log in and return a supertest agent factory bound to the token (and outlet). */
export async function loginAs(email: string, outletId?: string) {
  const res = await request(app).post("/auth/login").send({ email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login ${email} → ${res.status} ${JSON.stringify(res.body)}`);
  const token = res.body.accessToken as string;
  const h = (r: request.Test) => {
    r.set("authorization", `Bearer ${token}`);
    if (outletId) r.set("x-outlet-id", outletId);
    return r;
  };
  return {
    token,
    get: (p: string) => h(request(app).get(p)),
    post: (p: string, body?: object) => h(request(app).post(p)).send(body),
    patch: (p: string, body?: object) => h(request(app).patch(p)).send(body),
    put: (p: string, body?: object) => h(request(app).put(p)).send(body),
    delete: (p: string) => h(request(app).delete(p)),
  };
}

let seq = 0;
const uniq = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;

/**
 * A second, fully separate business ("Tenant B") with one outlet and one user
 * per role. Phones/emails are unique per call so tests can create several.
 */
export async function createTenant(opts: { name?: string; modules?: string[]; status?: "ACTIVE" | "SUSPENDED" } = {}) {
  const tag = uniq();
  const passwordHash = await bcrypt.hash(PASSWORD, 4);
  const business = await db.business.create({
    data: {
      name: opts.name ?? `IT Tenant ${tag}`,
      status: opts.status ?? "ACTIVE",
      modules: opts.modules ?? ["BILLING", "KOT", "TABLES", "DELIVERY", "RESERVATIONS", "INVENTORY", "CUSTOMERS", "OFFERS", "ATTENDANCE", "REPORTS"],
    },
  });
  const outlet = await db.outlet.create({ data: { businessId: business.id, name: `IT Outlet ${tag}`, stateCode: "33" } });
  const roles: Role[] = ["BUSINESS_OWNER", "OUTLET_MANAGER", "CASHIER", "KITCHEN", "INVENTORY_MANAGER", "DELIVERY"];
  const users = {} as Record<Role, { id: string; email: string }>;
  for (const role of roles) {
    const email = `${role.toLowerCase()}.${tag}@it.canavo.test`;
    const u = await db.user.create({
      data: {
        businessId: business.id,
        name: `${role} ${tag}`,
        email,
        phone: `8${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`,
        role,
        passwordHash,
        outlets: role === "BUSINESS_OWNER" ? undefined : { create: { outletId: outlet.id } },
      },
    });
    users[role] = { id: u.id, email };
  }
  return { business, outlet, users };
}

/** The seeded demo tenant (T0). */
export async function demoTenant() {
  const owner = await db.user.findUniqueOrThrow({ where: { email: "owner@canavo.local" } });
  const outlet = await db.outlet.findFirstOrThrow({ where: { businessId: owner.businessId! }, orderBy: { createdAt: "asc" } });
  const manager = await db.user.findUniqueOrThrow({ where: { email: "manager@canavo.local" } });
  return { businessId: owner.businessId!, outlet, owner, manager };
}
