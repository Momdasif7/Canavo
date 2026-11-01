/** Phase 1.8 — request ids, error responses, metrics, health/ready. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { billingTestHooks } from "../../src/services/billing";
import { createHotel, login, startServer, type Hotel } from "./helpers";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel;
beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("Obs");
});
afterAll(() => srv.close());

describe("observability", () => {
  it("echoes a well-formed X-Request-Id and generates one otherwise", async () => {
    const mine = await fetch(`${srv.base}/health`, { headers: { "x-request-id": "req-abc-12345" } });
    expect(mine.headers.get("x-request-id")).toBe("req-abc-12345");
    const bad = await fetch(`${srv.base}/health`, { headers: { "x-request-id": "bad id with spaces" } });
    expect(bad.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("an unexpected error returns 500 with the request id and no stack trace", async () => {
    const cashier = await login(srv.base, h.users.cashier.email, h.outletId);
    billingTestHooks.beforeCommit = () => {
      throw new Error("db exploded at /secret/path");
    };
    const r = await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.chai, quantity: 1 }] }, { "x-request-id": "trace-me-123" });
    billingTestHooks.beforeCommit = undefined;
    expect(r.status).toBe(500);
    expect(r.body).toEqual({ error: "Internal server error", requestId: "trace-me-123" });
  });

  it("/metrics exposes request timings by route pattern (no ids in labels) and outbox gauges", async () => {
    const cashier = await login(srv.base, h.users.cashier.email, h.outletId);
    await cashier.call("GET", "/menu");
    const text = await (await fetch(`${srv.base}/metrics`)).text();
    expect(text).toContain("canavo_http_request_duration_seconds_bucket");
    expect(text).toMatch(/route="\/menu\/"|route="\/menu"/);
    expect(text).toContain("canavo_outbox_pending");
    expect(text).not.toMatch(/route="\/orders\/c[a-z0-9]{20,}/);
  });

  it("/health and /ready", async () => {
    expect((await fetch(`${srv.base}/health`)).status).toBe(200);
    expect(await (await fetch(`${srv.base}/ready`)).json()).toEqual({ ok: true, db: "up" });
  });
});
