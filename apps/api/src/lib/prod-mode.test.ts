/**
 * QA Phase 8 (sec1): what production mode switches off. The modules are loaded fresh with
 * NODE_ENV=production (env.ts reads it at import time).
 */
import type { Request, Response } from "express";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const saved = { ...process.env };
beforeAll(() => {
  vi.resetModules();
  Object.assign(process.env, { NODE_ENV: "production", SKIP_PROD_CONFIG_CHECK: "1" });
});
afterAll(() => {
  process.env = saved;
  vi.resetModules();
});

const paths = (router: { stack: { route?: { path: string } }[] }) => router.stack.map((l) => l.route?.path).filter(Boolean) as string[];

describe("production mode", () => {
  it("has no dev-simulate payment route", async () => {
    const { ordersRouter } = await import("../routes/orders");
    expect(paths(ordersRouter as never).some((p) => p.includes("dev-simulate"))).toBe(false);
  });

  it("an unexpected error answers with a request id only: no message, stack or SQL", async () => {
    const { errorHandler } = await import("./http");
    let sent: unknown;
    const res = { status: () => res, json: (b: unknown) => ((sent = b), res), setHeader: () => res } as unknown as Response;
    const err = new Error('relation "User" column phone=9876501234 failed');
    errorHandler(err, { id: "req-1", method: "GET", originalUrl: "/x" } as unknown as Request, res, () => {});
    expect(sent).toEqual({ error: "Internal server error", requestId: "req-1" });
  });

  it("session cookies are Secure, SameSite=Lax and the refresh cookie httpOnly", async () => {
    const { setSessionCookies } = await import("./session-cookies");
    const calls: [string, string, Record<string, unknown>][] = [];
    const res = { cookie: (n: string, v: string, o: Record<string, unknown>) => calls.push([n, v, o]) } as unknown as Response;
    setSessionCookies({ secure: false } as Request, res, "rt");
    expect(calls).toHaveLength(2);
    for (const [, , o] of calls) expect(o).toMatchObject({ secure: true, sameSite: "lax" });
    expect(calls.find(([n]) => n === "canavo_rt")![2].httpOnly).toBe(true);
  });
});
