/**
 * Shared helpers for the QA Phase 6 API tests (identity, access, settings modules).
 * Sign-ins go through the real /auth/login, each from its own client IP (X-Forwarded-For
 * from loopback is trusted), so the login rate limiter (50 / 15 min per IP) never trips a
 * test by accident — the rate-limit tests pick their IP on purpose.
 */
import bcrypt from "bcryptjs";
import type { Role } from "@prisma/client";
import { expect } from "vitest";
import { canWith, type Permission } from "@canavo/shared";
import { createPlatformAdmin, db, PASSWORD, type Client, type Hotel } from "../integration/helpers";

let ipSeq = 1;
/** A fresh client IP (10.x.y.z) for X-Forwarded-For. */
export const freshIp = () => {
  const n = ipSeq++ + Math.floor(Math.random() * 1000) * 1000;
  return `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`;
};

export type Res<T = any> = { status: number; body: T; headers: Headers }; // eslint-disable-line @typescript-eslint/no-explicit-any

/** Any request (no token unless given). JSON bodies by default; `raw` sends the body as-is. */
export async function req<T = any>( // eslint-disable-line @typescript-eslint/no-explicit-any
  base: string,
  method: string,
  path: string,
  opts: { body?: unknown; raw?: BodyInit; headers?: Record<string, string>; ip?: string } = {},
): Promise<Res<T>> {
  const headers: Record<string, string> = { "x-forwarded-for": opts.ip ?? freshIp(), ...(opts.body !== undefined && { "content-type": "application/json" }), ...opts.headers };
  const res = await fetch(`${base}${path}`, { method, headers, body: opts.raw ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  return { status: res.status, body: body as T, headers: res.headers };
}

export interface Session extends Client {
  refreshToken: string;
}

/** Sign in through the API (fresh client IP) and return a client bound to an outlet. */
export async function signIn(base: string, email: string, outletId?: string, password = PASSWORD): Promise<Session> {
  const r = await req(base, "POST", "/auth/login", { body: { email, password } });
  if (r.status !== 200) throw new Error(`login ${email} → ${r.status} ${JSON.stringify(r.body)}`);
  const { accessToken, refreshToken } = r.body as { accessToken: string; refreshToken: string };
  return {
    token: accessToken,
    refreshToken,
    call: (method, path, body, headers = {}) =>
      req(base, method, path, { body, headers: { authorization: `Bearer ${accessToken}`, ...(outletId && { "x-outlet-id": outletId }), ...headers } }),
  };
}

let n = 0;
export const uniqPhone = () => `9${String(Date.now()).slice(-6)}${String(n++ % 1000).padStart(3, "0")}`;

/** Another account in a hotel (assigned to the given outlets), or a platform account. */
export async function addUser(h: Hotel | null, role: Role, outletIds: string[] = h ? [h.outletId] : []) {
  const email = `${role.toLowerCase()}.${Date.now().toString(36)}.${n++}@it.local`;
  const platform = role === "PLATFORM_SUPPORT" || role === "SUPER_ADMIN";
  const u = await db.user.create({
    data: {
      businessId: platform ? null : h!.businessId,
      role,
      name: `${role} ${n}`,
      email,
      phone: uniqPhone(),
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      ...(!platform && role !== "BUSINESS_OWNER" && { outlets: { create: outletIds.map((outletId) => ({ outletId })) } }),
    },
  });
  return { id: u.id, email };
}

/** Every hotel role we test with, in outlet 1. */
export const HOTEL_ROLES = ["BUSINESS_OWNER", "OUTLET_MANAGER", "CASHIER", "KITCHEN", "INVENTORY_MANAGER", "DELIVERY", "WAITER", "ACCOUNTANT", "AUDITOR"] as const;
export type HotelRole = (typeof HOTEL_ROLES)[number];

export interface Cast {
  clients: Record<HotelRole, Session>;
  ids: Record<HotelRole, string>;
}

/** One signed-in client per hotel role (owner/manager/… from createHotel, plus waiter/accountant/auditor). */
export async function cast(base: string, h: Hotel): Promise<Cast> {
  const extra = { WAITER: await addUser(h, "WAITER"), ACCOUNTANT: await addUser(h, "ACCOUNTANT"), AUDITOR: await addUser(h, "AUDITOR") };
  const accounts: Record<HotelRole, { id: string; email: string }> = {
    BUSINESS_OWNER: h.users.owner,
    OUTLET_MANAGER: h.users.manager,
    CASHIER: h.users.cashier,
    KITCHEN: h.users.kitchen,
    INVENTORY_MANAGER: h.users.inventory,
    DELIVERY: h.users.delivery,
    ...extra,
  };
  const clients = {} as Record<HotelRole, Session>;
  const ids = {} as Record<HotelRole, string>;
  for (const role of HOTEL_ROLES) {
    clients[role] = await signIn(base, accounts[role].email, h.outletId);
    ids[role] = accounts[role].id;
  }
  return { clients, ids };
}

/** Roles that pass requirePermission(...perms) (auditors are read-only on top). */
export const allowedRoles = (perms: Permission[], method: string): HotelRole[] =>
  HOTEL_ROLES.filter((r) => perms.every((p) => canWith(r, p)) && (r !== "AUDITOR" || method === "GET"));

/**
 * Authorization loop: allowed roles must NOT get 403; every other role must get exactly 403.
 * `body` may be a function so each call gets a fresh body (unique names etc.).
 */
export async function expectAuthz(c: Cast, method: string, path: string, allowed: readonly HotelRole[], body?: unknown | (() => unknown)) {
  const seen: Record<string, number> = {};
  for (const role of HOTEL_ROLES) {
    const r = await c.clients[role].call(method, path, typeof body === "function" ? (body as () => unknown)() : body);
    seen[role] = r.status;
  }
  const expected = Object.fromEntries(HOTEL_ROLES.map((r) => [r, allowed.includes(r) ? "allowed" : 403]));
  const actual = Object.fromEntries(HOTEL_ROLES.map((r) => [r, allowed.includes(r) ? (seen[r] === 403 ? 403 : "allowed") : seen[r]]));
  expect(actual, `${method} ${path} → ${JSON.stringify(seen)}`).toEqual(expected);
  for (const r of HOTEL_ROLES) expect(seen[r], `${method} ${path} as ${r}`).toBeLessThan(500);
}

/** Recursively assert no secret-looking keys appear in a response body. */
export function expectNoSecrets(body: unknown, where = "body") {
  const BAD = /^(passwordHash|pinHash|codeHash|tokenHash|totpSecret|totpSecretEnc|aadhaarEnc|refreshToken|accessTokenEnc|tokenEnc|secret)$/;
  const walk = (v: unknown, path: string) => {
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        expect(BAD.test(k), `${where}: secret field ${path}.${k}`).toBe(false);
        walk(x, `${path}.${k}`);
      }
    else if (typeof v === "string") expect(/^\$2[aby]\$\d\d\$/.test(v), `${where}: bcrypt hash at ${path}`).toBe(false);
  };
  walk(body, "$");
}

/** Hostile / odd strings every free-text field must store inertly or refuse with 400. */
export const NASTY = {
  sql: "Robert'); DROP TABLE \"User\";--",
  xss: '<script>alert("x")</script><img src=x onerror=alert(1)>',
  tamil: "முருகன் உணவகம்",
  hindi: "राम भोजनालय",
  emoji: "Chai ☕ 🍛 Café",
};
export const HUGE = "x".repeat(10_000);

export { createPlatformAdmin, db, PASSWORD };
