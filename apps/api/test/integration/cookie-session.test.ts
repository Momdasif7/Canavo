/** Phase 2.7 (D16) — web sessions in httpOnly cookies with double-submit CSRF; storage mode unchanged. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotel, PASSWORD, startServer, type Hotel } from "./helpers";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel;

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("Cookies");
});
afterAll(() => srv.close());

/** Cookies from Set-Cookie headers (name → { value, attributes }). */
function cookiesOf(res: Response) {
  const out: Record<string, { value: string; attrs: string }> = {};
  for (const c of res.headers.getSetCookie()) {
    const [pair, ...attrs] = c.split(";");
    const i = pair!.indexOf("=");
    out[pair!.slice(0, i)] = { value: decodeURIComponent(pair!.slice(i + 1)), attrs: attrs.join(";").toLowerCase() };
  }
  return out;
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${srv.base}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

describe("cookie sessions", () => {
  it("storage mode (no header) is unchanged: refresh token in the body, no cookies", async () => {
    const r = await post("/auth/login", { email: h.users.cashier.email, password: PASSWORD });
    const body = await r.json();
    expect(body.refreshToken).toBeTruthy();
    expect(r.headers.getSetCookie()).toEqual([]);
  });

  it("cookie mode: httpOnly refresh cookie + readable CSRF cookie, no refresh token in the body", async () => {
    const r = await post("/auth/login", { email: h.users.cashier.email, password: PASSWORD }, { "x-session-mode": "cookie" });
    const body = await r.json();
    expect(body.refreshToken).toBeUndefined();
    expect(body).toMatchObject({ sessionMode: "cookie", accessToken: expect.any(String) });
    const c = cookiesOf(r);
    expect(c.canavo_rt!.attrs).toContain("httponly");
    expect(c.canavo_rt!.attrs).toContain("samesite=lax");
    expect(c.canavo_csrf!.attrs).not.toContain("httponly");

    const cookieHeader = `canavo_rt=${encodeURIComponent(c.canavo_rt!.value)}; canavo_csrf=${c.canavo_csrf!.value}`;
    // Refresh without the CSRF header is refused; with it, the cookie rotates.
    expect((await post("/auth/refresh", undefined as never, { cookie: cookieHeader })).status).toBe(403);
    expect((await post("/auth/refresh", undefined as never, { cookie: cookieHeader, "x-csrf-token": "wrong-token-of-same-size-xxxxxxx" })).status).toBe(403);
    const ok = await post("/auth/refresh", undefined as never, { cookie: cookieHeader, "x-csrf-token": c.canavo_csrf!.value });
    expect(ok.status).toBe(200);
    const okBody = await ok.json();
    expect(okBody.refreshToken).toBeUndefined();
    const rotated = cookiesOf(ok);
    expect(rotated.canavo_rt!.value).not.toBe(c.canavo_rt!.value);

    // The old cookie is now a reused token: refused (and the family revoked).
    expect((await post("/auth/refresh", undefined as never, { cookie: cookieHeader, "x-csrf-token": c.canavo_csrf!.value })).status).toBe(401);
  });

  it("logout through the cookie clears it and ends the session", async () => {
    const r = await post("/auth/login", { email: h.users.manager.email, password: PASSWORD }, { "x-session-mode": "cookie" });
    const c = cookiesOf(r);
    const cookieHeader = `canavo_rt=${encodeURIComponent(c.canavo_rt!.value)}; canavo_csrf=${c.canavo_csrf!.value}`;
    const out = await post("/auth/logout", undefined as never, { cookie: cookieHeader, "x-csrf-token": c.canavo_csrf!.value });
    expect(out.status).toBe(204);
    expect(cookiesOf(out).canavo_rt!.attrs).toMatch(/expires=thu, 01 jan 1970/);
    expect((await post("/auth/refresh", undefined as never, { cookie: cookieHeader, "x-csrf-token": c.canavo_csrf!.value })).status).toBe(401);
  });

  it("the probe sets a readable test cookie", async () => {
    const r = await post("/auth/cookie-probe", {});
    expect(cookiesOf(r).canavo_probe!.attrs).not.toContain("httponly");
  });

  it("CORS allows credentials for an allowed origin only", async () => {
    const res = await fetch(`${srv.base}/auth/refresh`, { method: "OPTIONS", headers: { origin: "http://localhost:3000", "access-control-request-method": "POST" } });
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000");
    const evil = await fetch(`${srv.base}/auth/refresh`, { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
  });
});
