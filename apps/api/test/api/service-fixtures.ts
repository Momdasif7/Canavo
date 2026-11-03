/**
 * Shared fixtures for the QA Phase 6 money / service API tests (orders, KOT, tables,
 * reservations, delivery, cash shifts, settlements, gift cards).
 */
import bcrypt from "bcryptjs";
import type { Role } from "@prisma/client";
import { createHotel, createPlatformAdmin, db, login, PASSWORD, type Client, type Hotel } from "../integration/helpers";

export const ALL_ROLES = ["owner", "manager", "cashier", "kitchen", "inventory", "delivery", "waiter", "accountant", "auditor"] as const;
export type RoleKey = (typeof ALL_ROLES)[number];

export interface World {
  h: Hotel;
  /** One logged-in client per role, all on outlet 1 */
  as: Record<RoleKey, Client>;
  /** A second, unrelated hotel's owner (cross-tenant) */
  other: Hotel;
  otherOwner: Client;
  /** Hotel A's manager pointed at outlet 2 (not assigned there) */
  managerOutlet2: Client;
  admin: Client;
}

let n = 0;
async function addUser(h: Hotel, role: Role, key: string) {
  const email = `${key}.${Date.now().toString(36)}${n++}@it.local`;
  await db.user.create({
    data: {
      businessId: h.businessId,
      role,
      name: `${key} user`,
      email,
      phone: `8${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`,
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      outlets: { create: [{ outletId: h.outletId }] },
    },
  });
  return email;
}

export async function makeWorld(base: string, name: string, opts: { gst?: boolean; modules?: string[] } = {}): Promise<World> {
  const h = await createHotel(name, opts);
  const waiter = await addUser(h, "WAITER", "waiter");
  const accountant = await addUser(h, "ACCOUNTANT", "accountant");
  const auditor = await addUser(h, "AUDITOR", "auditor");
  const as = {} as Record<RoleKey, Client>;
  for (const k of ["owner", "manager", "cashier", "kitchen", "inventory", "delivery"] as const) as[k] = await login(base, h.users[k].email, h.outletId);
  as.waiter = await login(base, waiter, h.outletId);
  as.accountant = await login(base, accountant, h.outletId);
  as.auditor = await login(base, auditor, h.outletId);
  const other = await createHotel(`${name} other`);
  const otherOwner = await login(base, other.users.owner.email, other.outletId);
  const managerOutlet2 = await login(base, h.users.manager.email, h.outlet2Id);
  const adminUser = await createPlatformAdmin();
  const admin = await login(base, adminUser.email, h.outletId);
  return { h, as, other, otherOwner, managerOutlet2, admin };
}

export const setFeatures = (businessId: string, features: Record<string, boolean>) => db.business.update({ where: { id: businessId }, data: { features } });

/** Assert a JSON body carries no secrets anywhere (deep). */
export function assertNoSecrets(body: unknown) {
  const text = JSON.stringify(body ?? null);
  for (const k of ["passwordHash", "pinHash", "refreshToken", "totpSecret", "aadhaarNumber", "tokenVersion"]) {
    if (text.includes(`"${k}"`)) throw new Error(`response leaks ${k}`);
  }
}

/** Every money-ish field (paise) found in an object tree is an integer. */
const MONEY_KEYS = new Set([
  "subtotal", "discount", "taxableValue", "serviceCharge", "cgst", "sgst", "igst", "cess", "otherTaxes", "roundOff",
  "grandTotal", "amount", "unitPrice", "total", "refundedAmount", "balance", "amountPaid", "amountDue", "openingFloat",
  "expectedCash", "countedCash", "variance", "advancePaid", "initialValue", "tip", "promoDiscount", "extraCharges",
]);
export function assertIntegerMoney(body: unknown, path = "$"): void {
  if (Array.isArray(body)) return body.forEach((v, i) => assertIntegerMoney(v, `${path}[${i}]`));
  if (body && typeof body === "object") {
    for (const [k, v] of Object.entries(body)) {
      if (MONEY_KEYS.has(k) && typeof v === "number" && !Number.isInteger(v)) throw new Error(`${path}.${k} = ${v} is not integer paise`);
      assertIntegerMoney(v, `${path}.${k}`);
    }
  }
}

/** Expect `status` for each role in `allowed`, and 403 for the other roles. */
export async function roleMatrix(
  w: World,
  allowed: readonly RoleKey[],
  run: (c: Client, role: RoleKey) => Promise<{ status: number; body: unknown }>,
  okStatus: number | number[] = [200, 201],
) {
  const ok = [okStatus].flat();
  const bad: string[] = [];
  for (const role of ALL_ROLES) {
    const r = await run(w.as[role], role);
    if (allowed.includes(role) ? !ok.includes(r.status) : r.status !== 403) bad.push(`${role} → ${r.status} ${JSON.stringify(r.body).slice(0, 120)}`);
  }
  return bad;
}

export const LONG = "x".repeat(10_000);
export const UNICODE_NAME = "முருகன் मुरुगन் 🍛 Café";
export const SQLI = "'; DROP TABLE \"Order\"; --";
export const XSS = "<script>alert(1)</script>";

export type { Client, Hotel };
export { db };
