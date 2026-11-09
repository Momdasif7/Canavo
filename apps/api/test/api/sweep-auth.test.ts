/**
 * QA Phase 6 — authentication sweep over EVERY endpoint (route inventory, not a hand list):
 * no token / garbage / tampered / expired / wrong-secret / stale tokenVersion / deactivated
 * user → 401 with the standard { error } body. The public surface is an explicit allowlist,
 * so a new unauthenticated route fails this test until someone decides it should be public.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import jwt from "jsonwebtoken";
import { createHotel, db, login, startServer, type Hotel } from "../integration/helpers";
import { fillParams, listRoutes } from "./routes";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel;

/** Endpoints that answer without a staff session (they have their own checks: signatures, tokens, OTP). */
const PUBLIC = new Set([
  "post /auth/login",
  "post /auth/otp/request",
  "post /auth/otp/verify",
  "post /auth/refresh",
  "post /auth/logout",
  // Browser checks whether it keeps cookies (no data)
  "post /auth/cookie-probe",
  // Second step of a 2FA login: needs the signed MFA ticket from the first step
  "post /auth/2fa/verify",
  // Forgot / reset password: always 200 for forgot (no account probing), reset needs the emailed token
  "post /auth/password/forgot",
  "post /auth/password/reset",
  // Uploaded images (menu photos, logos, selfies): unguessable names, 72 random bits
  "get /uploads/files/:name",
  "get /public/receipts/:token",
  "get /public/business-export/:token", // gap 8b: owners' final export, one-time token emailed to them
  "post /webhooks/razorpay",
  // Per-store Razorpay webhook: unguessable key + that store's signature
  "post /webhooks/razorpay/:businessKey",
  "post /channels/hub/:connectionId/webhook",
  "get /public/t/:token",
  "post /public/t/:token/orders",
  "get /public/t/:token/orders",
  "post /public/t/:token/call",
  // THEATRE: seat order UPI refresh, screen poster QR
  "post /public/t/:token/orders/:orderToken/upi",
  "get /public/s/:screenToken",
  "get /public/o/:slug",
  "post /public/o/:slug/otp/request",
  "post /public/o/:slug/otp/verify",
  "get /public/o/:slug/delivery-quote",
  "post /public/o/:slug/orders",
  "get /public/o/:slug/orders/:token",
  "post /public/o/:slug/orders/:token/upi",
]);

const routes = listRoutes();

async function hit(method: string, path: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${srv.base}${fillParams(path)}`, {
    method: method.toUpperCase(),
    headers: { "content-type": "application/json", ...headers },
    body: method === "get" || method === "delete" ? undefined : "{}",
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body };
}

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("Auth sweep");
});
afterAll(() => srv.close());

describe("authentication on every endpoint", () => {
  it("inventory sanity: the route list is complete enough to be meaningful", () => {
    expect(routes.length).toBeGreaterThan(350);
  });

  it("the unauthenticated surface is exactly the public allowlist", async () => {
    const open: string[] = [];
    for (const r of routes) {
      const res = await hit(r.method, r.path);
      if (res.status !== 401) open.push(`${r.method} ${r.path}`);
      else expect(res.body, `${r.method} ${r.path}`).toMatchObject({ error: expect.any(String) });
    }
    // Any route answering without a session must be on the allowlist…
    expect(open.filter((k) => !PUBLIC.has(k))).toEqual([]);
    // …and every allowlisted route must still exist.
    const all = new Set(routes.map((r) => `${r.method} ${r.path}`));
    expect([...PUBLIC].filter((k) => !all.has(k))).toEqual([]);
  });

  it("garbage, tampered, wrong-secret, expired, alg=none, stale and deactivated-user tokens are refused everywhere", async () => {
    const owner = await db.user.findUniqueOrThrow({ where: { id: h.users.owner.id } });
    const secret = process.env.JWT_ACCESS_SECRET!;
    const good = await login(srv.base, owner.email!, h.outletId);
    const [head, payload] = good.token.split(".");
    const claims = { sub: owner.id, role: owner.role, tv: owner.tokenVersion };
    const tokens: Record<string, string> = {
      garbage: "not-a-jwt",
      tampered: `${head}.${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, "base64url").toString()), role: "SUPER_ADMIN" })).toString("base64url")}.${good.token.split(".")[2]}`,
      wrongSecret: jwt.sign(claims, "x".repeat(48), { expiresIn: 600 }),
      expired: jwt.sign({ ...claims, iat: Math.floor(Date.now() / 1000) - 3600, exp: Math.floor(Date.now() / 1000) - 60 }, secret),
      algNone: `${Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url")}.${payload}.`,
      staleVersion: jwt.sign({ ...claims, tv: owner.tokenVersion - 1 }, secret, { expiresIn: 600 }),
      unknownUser: jwt.sign({ ...claims, sub: "cl0000000000000000000000" }, secret, { expiresIn: 600 }),
    };
    const secured = routes.filter((r) => !PUBLIC.has(`${r.method} ${r.path}`));
    // Every token on a spread of endpoints (one per router), and the forged-claims ones on all of them.
    const perMount = [...new Map(secured.map((r) => [r.mount, r])).values()];
    for (const [kind, token] of Object.entries(tokens)) {
      const targets = kind === "tampered" || kind === "algNone" ? secured : perMount;
      for (const r of targets) {
        const res = await hit(r.method, r.path, { authorization: `Bearer ${token}`, "x-outlet-id": h.outletId });
        expect(res.status, `${kind}: ${r.method} ${r.path}`).toBe(401);
      }
    }
    // A deactivated user's still-valid token stops working at once.
    await db.user.update({ where: { id: owner.id }, data: { status: "INACTIVE" } });
    try {
      for (const r of perMount) {
        const res = await hit(r.method, r.path, { authorization: `Bearer ${good.token}`, "x-outlet-id": h.outletId });
        expect(res.status, `deactivated: ${r.method} ${r.path}`).toBe(401);
      }
    } finally {
      await db.user.update({ where: { id: owner.id }, data: { status: "ACTIVE" } });
    }
  });
});
