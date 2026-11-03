/**
 * QA Phase 6 — shared helpers for the per-module API suites (menu, inventory, CRM, reports):
 * a hotel with an account for EVERY business role, an RBAC matrix runner driven by the
 * real permission table, and small assertion helpers (no secrets, integer money, 400 not 500).
 */
import bcrypt from "bcryptjs";
import { expect } from "vitest";
import type { Role as PrismaRole } from "@prisma/client";
import { canWith, permissionEnabled, normalizeModules, type Permission, type Role } from "@canavo/shared";
import { createHotel, createPlatformAdmin, db, login, PASSWORD, type Client, type Hotel } from "../integration/helpers";

export const BUSINESS_ROLES = [
  "BUSINESS_OWNER",
  "OUTLET_MANAGER",
  "CASHIER",
  "KITCHEN",
  "DELIVERY",
  "INVENTORY_MANAGER",
  "WAITER",
  "ACCOUNTANT",
  "AUDITOR",
] as const satisfies readonly Role[];
export type BizRole = (typeof BUSINESS_ROLES)[number];

export interface World {
  h: Hotel;
  /** A logged-in client per business role, acting in outlet 1 */
  as: Record<BizRole, Client>;
  /** Owner acting in outlet 2 */
  owner2: Client;
  /** Manager of outlet 1 sending x-outlet-id of outlet 2 (not assigned) */
  managerAtOutlet2: Client;
  /** Owner of a second, unrelated hotel */
  other: { h: Hotel; owner: Client };
  /** Platform super admin (no business) */
  admin: Client;
  base: string;
}

let n = 0;
async function addUser(h: Hotel, role: PrismaRole) {
  const email = `${role.toLowerCase()}.${Date.now().toString(36)}.${n++}@it.local`;
  const u = await db.user.create({
    data: {
      businessId: h.businessId,
      role,
      name: `${role} ${n}`,
      email,
      phone: `8${String(Date.now()).slice(-7)}${String(n % 100).padStart(2, "0")}`,
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      outlets: { create: [{ outletId: h.outletId }] },
    },
  });
  return { id: u.id, email };
}

export async function world(base: string, name: string, modules?: string[]): Promise<World> {
  const h = await createHotel(name, modules ? { modules } : {});
  const extra = { waiter: await addUser(h, "WAITER"), accountant: await addUser(h, "ACCOUNTANT"), auditor: await addUser(h, "AUDITOR") };
  const l = (email: string) => login(base, email, h.outletId);
  const as = {
    BUSINESS_OWNER: await l(h.users.owner.email),
    OUTLET_MANAGER: await l(h.users.manager.email),
    CASHIER: await l(h.users.cashier.email),
    KITCHEN: await l(h.users.kitchen.email),
    DELIVERY: await l(h.users.delivery.email),
    INVENTORY_MANAGER: await l(h.users.inventory.email),
    WAITER: await l(extra.waiter.email),
    ACCOUNTANT: await l(extra.accountant.email),
    AUDITOR: await l(extra.auditor.email),
  };
  const oh = await createHotel(`${name} other`);
  return {
    h,
    as,
    owner2: await login(base, h.users.owner.email, h.outlet2Id),
    managerAtOutlet2: await login(base, h.users.manager.email, h.outlet2Id),
    other: { h: oh, owner: await login(base, oh.users.owner.email, oh.outletId) },
    admin: await login(base, (await createPlatformAdmin()).email),
    base,
  };
}

/** Would the role pass `perms` (all of them, or any when `any`)? Auditors never write. */
export function allowed(role: BizRole, method: string, perms: Permission[], opts: { any?: boolean; roles?: BizRole[] } = {}) {
  if (role === "AUDITOR" && method !== "GET") return false;
  if (opts.roles && !opts.roles.includes(role)) return false;
  const ok = (p: Permission) => canWith(role, p, null) && permissionEnabled(p, normalizeModules(["BILLING", "KOT", "TABLES", "DELIVERY", "RESERVATIONS", "INVENTORY", "CUSTOMERS", "OFFERS", "ATTENDANCE", "REPORTS"]));
  return opts.any ? perms.some(ok) : perms.every(ok);
}

export interface Ep {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  perms: Permission[];
  body?: unknown;
  any?: boolean;
  roles?: BizRole[];
}

/**
 * For every endpoint × every business role: a role without the permission gets 403;
 * a role with it never gets 403 (it may get 400/404 for the placeholder ids).
 */
export async function rbacMatrix(w: World, eps: Ep[]) {
  const wrong: string[] = [];
  for (const ep of eps) {
    for (const role of BUSINESS_ROLES) {
      const r = await w.as[role].call(ep.method, ep.path, ep.body ?? (ep.method === "GET" || ep.method === "DELETE" ? undefined : {}));
      const ok = allowed(role, ep.method, ep.perms, ep);
      if (r.status >= 500) wrong.push(`${role} ${ep.method} ${ep.path} → ${r.status} ${JSON.stringify(r.body)}`);
      else if (ok && r.status === 403) wrong.push(`${role} ${ep.method} ${ep.path} → 403 but has ${ep.perms.join("|")}: ${JSON.stringify(r.body)}`);
      else if (!ok && r.status !== 403) wrong.push(`${role} ${ep.method} ${ep.path} → ${r.status}, expected 403`);
    }
  }
  expect(wrong).toEqual([]);
}

/** Tenant / outlet / platform isolation: each foreign caller gets 403/404 and never a 2xx. */
export async function isolation(w: World, eps: { method: Ep["method"]; path: string; body?: unknown }[]) {
  const wrong: string[] = [];
  for (const ep of eps) {
    const body = ep.body ?? (ep.method === "GET" || ep.method === "DELETE" ? undefined : {});
    for (const [who, c, codes] of [
      ["other-tenant owner", w.other.owner, [400, 403, 404]],
      ["manager @ unassigned outlet", w.managerAtOutlet2, [403]],
      ["super admin", w.admin, [400, 403]],
    ] as const) {
      const r = await c.call(ep.method, ep.path, body);
      if (!(codes as readonly number[]).includes(r.status)) wrong.push(`${who} ${ep.method} ${ep.path} → ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    }
  }
  expect(wrong).toEqual([]);
}

const SECRET_KEYS = /^(passwordHash|pinHash|refreshToken|tokenHash|totpSecret|aadhaar|aadhaarNumber|apiKey|secret)$/i;
/** No secret-looking keys anywhere in a response body. */
export function noSecrets(body: unknown) {
  const found: string[] = [];
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) {
      if (SECRET_KEYS.test(k)) found.push(`${path}.${k}`);
      walk(x, `${path}.${k}`);
    }
  };
  walk(body, "$");
  expect(found).toEqual([]);
}

/** Every listed key is an integer (paise). */
export function intMoney(obj: Record<string, unknown>, keys: string[]) {
  for (const k of keys) expect(Number.isInteger(obj[k]), `${k}=${String(obj[k])} should be integer paise`).toBe(true);
}

/** Send each bad body; every one must be 400 (never 500, never 2xx). */
export async function rejects(c: Client, method: Ep["method"], path: string, bodies: unknown[]) {
  const wrong: string[] = [];
  for (const b of bodies) {
    const r = await c.call(method, path, b);
    if (r.status !== 400) wrong.push(`${JSON.stringify(b).slice(0, 120)} → ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  }
  expect(wrong).toEqual([]);
}

/** Same for query strings on a GET. */
export async function rejectsQuery(c: Client, path: string, queries: string[]) {
  const wrong: string[] = [];
  for (const q of queries) {
    const r = await c.call("GET", `${path}?${q}`);
    if (r.status !== 400) wrong.push(`?${q} → ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
  }
  expect(wrong).toEqual([]);
}

export const LONG = "x".repeat(10_000);
export const NAMES = ["மசாலா தோசை", "मसाला चाय", "Chai ☕🔥", "Robert'); DROP TABLE \"MenuItem\";--", "<script>alert(1)</script>", "O'Brien & Sons"];
export const GHOST = "cl0000000000000000000000";

/** Fetch a raw response (exports). */
export async function raw(base: string, c: Client, path: string, outletId: string) {
  return fetch(`${base}${path}`, { headers: { authorization: `Bearer ${c.token}`, "x-outlet-id": outletId } });
}

export { db, login, PASSWORD };
