/**
 * QA Phase 6 — shared bits for the canteen / channels / storefront API suites:
 * one client per business role (incl. waiter / accountant / auditor, which createHotel
 * doesn't make), anonymous calls, and a data-driven authorization check.
 */
import bcrypt from "bcryptjs";
import type { Role } from "@prisma/client";
import { expect } from "vitest";
import { PASSWORD, createPlatformAdmin, db, login, type Client, type Hotel } from "../integration/helpers";

export const ROLE_KEYS = ["owner", "manager", "cashier", "kitchen", "inventory", "delivery", "waiter", "accountant", "auditor"] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

const EXTRA: Record<"waiter" | "accountant" | "auditor", Role> = { waiter: "WAITER", accountant: "ACCOUNTANT", auditor: "AUDITOR" };

let seq = 0;
/** A fresh valid Indian mobile number. */
export const mobile = () => `9${String(Date.now() % 1e5).padStart(5, "0")}${String(seq++ % 1e4).padStart(4, "0")}`;

/** Log in every role of the hotel on outlet 1 (waiter / accountant / auditor are created here). */
export async function roleClients(base: string, h: Hotel): Promise<Record<RoleKey, Client>> {
  const pw = await bcrypt.hash(PASSWORD, 4);
  const out = {} as Record<RoleKey, Client>;
  for (const [key, role] of Object.entries(EXTRA)) {
    const email = `${key}.${h.businessId}@it.local`;
    await db.user.create({ data: { businessId: h.businessId, role, name: `${key} user`, email, phone: mobile(), passwordHash: pw, outlets: { create: [{ outletId: h.outletId }] } } });
    out[key as RoleKey] = await login(base, email, h.outletId);
  }
  for (const key of ["owner", "manager", "cashier", "kitchen", "inventory", "delivery"] as const) out[key] = await login(base, h.users[key].email, h.outletId);
  return out;
}

/** Super Admin client sending an outlet header (it must still get no hotel data). */
export async function superAdmin(base: string, outletId: string) {
  const a = await createPlatformAdmin();
  return login(base, a.email, outletId);
}

export interface Endpoint {
  method: string;
  path: string;
  body?: unknown;
  /** Roles that pass authorization; everyone else must get 403. */
  allowed: readonly RoleKey[];
}

/**
 * Every role against every endpoint: refused roles get 403 with the standard error body;
 * allowed roles get past authorization (any non-401/403/5xx answer — bodies may be
 * deliberately invalid so nothing is written).
 */
export async function checkAuthz(clients: Record<RoleKey, Client>, endpoints: Endpoint[]) {
  const problems: string[] = [];
  for (const ep of endpoints) {
    for (const role of ROLE_KEYS) {
      const r = await clients[role].call(ep.method, ep.path, ep.body);
      const ok = ep.allowed.includes(role) ? r.status !== 401 && r.status !== 403 && r.status < 500 : r.status === 403 && typeof (r.body as { error?: unknown })?.error === "string";
      if (!ok) problems.push(`${role} ${ep.method} ${ep.path} → ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
    }
  }
  expect(problems).toEqual([]);
}

/** Every endpoint answers `status` for this client (module off, foreign outlet, super admin…). */
export async function expectAll(c: Client, endpoints: { method: string; path: string; body?: unknown }[], status: number | number[]) {
  const want = [status].flat();
  const bad: string[] = [];
  for (const ep of endpoints) {
    const r = await c.call(ep.method, ep.path, ep.body);
    if (!want.includes(r.status)) bad.push(`${ep.method} ${ep.path} → ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  }
  expect(bad).toEqual([]);
}

/** Things no response may ever contain. */
export function expectNoSecrets(body: unknown) {
  const s = JSON.stringify(body ?? null);
  for (const k of ["passwordHash", "pinHash", "refreshToken", "tokenVersion", "totpSecret", "apiKeyEnc", "webhookSecretEnc", "codeHash", "aadhaarNumber"]) expect(s).not.toContain(`"${k}"`);
}

/** Integer paise (never floats / strings). */
export function expectPaise(...values: unknown[]) {
  for (const v of values) expect(Number.isInteger(v), `not integer paise: ${String(v)}`).toBe(true);
}

/** Payloads that must be stored as inert text. */
export const NASTY = {
  xss: `<script>alert("x")</script><img src=x onerror=alert(1)>`,
  sql: `Robert'); DROP TABLE "Customer";--`,
  tamil: "தமிழ் உணவகம் 🍛",
  hindi: "हिंदी कैंटीन ☕",
};

/** Bodies with wrong values for a numeric field: each must be refused with 400. */
export const badInts = (key: string, base: object, { min = 0 }: { min?: number } = {}) => [
  { ...base, [key]: min - 1 },
  { ...base, [key]: min + 0.5 },
  { ...base, [key]: String(min + 1) },
  { ...base, [key]: null },
  { ...base, [key]: 1e12 },
];
