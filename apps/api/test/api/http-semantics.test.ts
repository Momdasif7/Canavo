/**
 * QA Phase 6 — HTTP semantics: CORS (allowed / refused origins, credentials, preflight), body size
 * limit, unknown routes and methods, caching headers on signed-in data, security headers, request ids,
 * rate-limit headers and content types.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotel, login, startServer, type Client, type Hotel } from "../integration/helpers";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel;
let owner: Client;
const ALLOWED = "http://localhost:3000"; // CORS_ORIGINS in vitest.integration.config.ts

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("HTTP semantics");
  owner = await login(srv.base, h.users.owner.email, h.outletId);
});
afterAll(() => srv.close());

const authed = (extra: Record<string, string> = {}) => ({ authorization: `Bearer ${owner.token}`, "x-outlet-id": h.outletId, ...extra });

describe("CORS", () => {
  it("preflight from an allowed origin: allowed with credentials, custom headers listed", async () => {
    const r = await fetch(`${srv.base}/orders`, {
      method: "OPTIONS",
      headers: { origin: ALLOWED, "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type,x-outlet-id,idempotency-key" },
    });
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe(ALLOWED);
    expect(r.headers.get("access-control-allow-credentials")).toBe("true");
    expect(r.headers.get("access-control-allow-methods")).toMatch(/POST/);
  });

  it("other origins (incl. look-alikes and null) get no CORS grant", async () => {
    for (const origin of ["https://evil.example", "http://localhost:3000.evil.example", "http://localhost:30000", "null"]) {
      const r = await fetch(`${srv.base}/auth/me`, { headers: { origin, ...authed() } });
      expect(r.headers.get("access-control-allow-origin"), origin).toBeNull();
    }
  });

  it("Content-Disposition is exposed for downloads", async () => {
    const r = await fetch(`${srv.base}/health`, { headers: { origin: ALLOWED } });
    expect(r.headers.get("access-control-expose-headers")).toMatch(/content-disposition/i);
  });
});

describe("request handling", () => {
  it("bodies over 1 MB → 413 JSON, not a crash", async () => {
    const r = await fetch(`${srv.base}/orders`, { method: "POST", headers: authed({ "content-type": "application/json" }), body: JSON.stringify({ notes: "x".repeat(1_100_000) }) });
    expect(r.status).toBe(413);
    expect(await r.json()).toMatchObject({ error: expect.any(String) });
  });

  it("unknown routes and unsupported methods → 404 JSON", async () => {
    for (const [method, path] of [["GET", "/nope"], ["PUT", "/health"], ["DELETE", "/orders"], ["PATCH", "/auth/login"]] as const) {
      const r = await fetch(`${srv.base}${path}`, { method, headers: authed() });
      expect(r.status, `${method} ${path}`).toBe(404);
      expect(r.headers.get("content-type")).toMatch(/application\/json/);
      expect(await r.json()).toMatchObject({ error: expect.any(String) });
    }
  });

  it("HEAD works on GET routes; JSON responses say utf-8", async () => {
    const head = await fetch(`${srv.base}/health`, { method: "HEAD" });
    expect(head.status).toBe(200);
    const r = await fetch(`${srv.base}/auth/me`, { headers: authed() });
    expect(r.headers.get("content-type")).toBe("application/json; charset=utf-8");
  });

  it("a non-JSON content type on a JSON endpoint is a 400, not a 500", async () => {
    const r = await fetch(`${srv.base}/orders`, { method: "POST", headers: authed({ "content-type": "text/plain" }), body: "orderType=TAKEAWAY" });
    expect(r.status).toBe(400);
  });
});

describe("headers", () => {
  it("signed-in data is never stored by browsers or proxies (Cache-Control: no-store)", async () => {
    for (const path of ["/auth/me", "/orders", "/customers", "/staff"]) {
      const r = await fetch(`${srv.base}${path}`, { headers: authed() });
      expect(r.status, path).toBe(200);
      expect(r.headers.get("cache-control"), path).toMatch(/no-store/);
    }
  });

  it("errors are not cacheable either", async () => {
    const r = await fetch(`${srv.base}/auth/me`);
    expect(r.status).toBe(401);
    expect(r.headers.get("cache-control")).toMatch(/no-store/);
  });

  it("security headers (helmet) are present", async () => {
    const r = await fetch(`${srv.base}/health`);
    expect(r.headers.get("x-content-type-options")).toBe("nosniff");
    expect(r.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(r.headers.get("strict-transport-security")).toMatch(/max-age=\d+/);
    expect(r.headers.get("content-security-policy")).toMatch(/default-src 'self'/);
    expect(r.headers.get("x-powered-by")).toBeNull();
  });

  it("X-Request-Id: a well-formed one is echoed, a hostile one replaced", async () => {
    const ok = await fetch(`${srv.base}/health`, { headers: { "x-request-id": "abc-123_DEF" } });
    expect(ok.headers.get("x-request-id")).toBe("abc-123_DEF");
    const bad = await fetch(`${srv.base}/health`, { headers: { "x-request-id": "x".repeat(500) } });
    expect(bad.headers.get("x-request-id")).not.toBe("x".repeat(500));
  });

  it("login answers carry the standard rate-limit headers", async () => {
    const r = await fetch(`${srv.base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "nobody@it.local", password: "wrong-password-1" }) });
    expect(r.status).toBe(401);
    expect(r.headers.get("ratelimit-policy")).toMatch(/q=\d+/);
  });
});
