/**
 * Group-A functional-test fixtures (auth / platform / staff / outlets / tax).
 *
 * `/auth/login` and `/auth/otp` share an in-memory 50-per-15-min IP limiter, so
 * tests that are NOT about login get their session by minting it directly with
 * the app's own `issueSession` (same JWT secret, same tokenVersion, same refresh
 * family logic) instead of calling `/auth/login`.
 */
import request from "supertest";
import { app, db } from "./helpers";
import { issueSession } from "../../src/lib/tokens";
import { verhoeffValid } from "../../src/lib/crypto";

export type Agent = ReturnType<typeof agentFromToken>;

export function agentFromToken(token: string, outletId?: string) {
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

/** Session for a user without hitting the rate-limited /auth/login. */
export async function sessionFor(userIdOrEmail: string, outletId?: string) {
  const user = await db.user.findFirstOrThrow({ where: { OR: [{ id: userIdOrEmail }, { email: userIdOrEmail }] } });
  const s = await issueSession(user);
  return { ...agentFromToken(s.accessToken, outletId), refreshToken: s.refreshToken, user };
}

export const raw = () => request(app);

let n = 0;
/** Unique valid Indian mobile number (starts with 7). */
export function uniqPhone() {
  n++;
  return `7${String((Date.now() % 1e6) * 1000 + (n % 1000)).padStart(9, "0").slice(-9)}`;
}
export const uniqTag = () => `${Date.now().toString(36)}${(n++).toString(36)}`;

/** A category + one AVAILABLE menu item (price in paise) for the tenant, optionally linked to a tax rate. */
export async function makeItem(businessId: string, opts: { price?: number; gstRate?: number; taxRateId?: string | null } = {}) {
  const cat = await db.menuCategory.create({ data: { businessId, name: `Cat ${uniqTag()}` } });
  return db.menuItem.create({
    data: {
      businessId,
      categoryId: cat.id,
      name: `Item ${uniqTag()}`,
      price: opts.price ?? 10_000,
      gstRate: opts.gstRate ?? 5,
      taxRateId: opts.taxRateId ?? null,
    },
  });
}

/** A Verhoeff-valid 12-digit Aadhaar-format number (synthetic). */
export function verhoeffAadhaar(prefix11: string) {
  for (let k = 0; k < 10; k++) if (verhoeffValid(prefix11 + k)) return prefix11 + k;
  throw new Error("no check digit");
}
