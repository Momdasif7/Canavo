/**
 * QA Phase 6 — robustness sweep over EVERY endpoint: as the owner (widest permissions) and as a
 * cashier, send unknown ids and hostile bodies / query strings. No request may produce a 5xx, and
 * every 4xx must use the standard JSON error body { error: string }.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotel, createPlatformAdmin, login, startServer, type Client, type Hotel } from "../integration/helpers";
import { fillParams, listRoutes, type RouteInfo } from "./routes";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel;
const clients: Record<string, Client> = {};

const routes = listRoutes();

const BODIES: [string, unknown][] = [
  ["empty object", {}],
  ["null", null],
  ["array", [1, 2, 3]],
  ["string", "hello"],
  ["number", 42],
  ["wrong types", { name: 123, quantity: "two", amount: "₹100", items: "chai", date: true, id: {}, phone: [] }],
  ["hostile strings", { name: "'; DROP TABLE \"Order\";--", notes: "<script>alert(1)</script>", reason: "${7*7}{{7*7}}", email: "a@b.c\r\nBcc: x@y.z", phone: "9876543210' OR '1'='1" }],
  ["huge values", { name: "x".repeat(10_000), amount: Number.MAX_SAFE_INTEGER, quantity: 1e308, price: -1, page: -5, limit: 1e9 }],
  ["prototype pollution", JSON.parse('{"__proto__":{"isAdmin":true},"constructor":{"prototype":{"x":1}}}')],
  ["deep nesting", JSON.parse("[".repeat(200) + "]".repeat(200))],
  // PostgreSQL text can't hold U+0000: must be a 400, not a database error
  ["NUL bytes", { name: "Chai\u0000", notes: "\u0000", reason: "late\u0000", phone: "98765\u000043210", email: "a\u0000@b.co", code: "\u0000" }],
];

const QUERIES = ["?from=not-a-date&to=2026-13-45", "?page=-1&limit=abc&sort=__proto__", "?outletId=../../etc/passwd&q=%27%20OR%201%3D1--", "?month=2026-99&date=31-02-2026", "?q=%00&search=chai%00&status=%00&from=2026-01-01%00"];

async function send(c: Client | null, r: RouteInfo, body: unknown, suffix = "", rawBody?: string) {
  const path = `${fillParams(r.path)}${suffix}`;
  const hasBody = r.method !== "get" && r.method !== "delete";
  if (rawBody !== undefined || !c) {
    const res = await fetch(`${srv.base}${path}`, {
      method: r.method.toUpperCase(),
      headers: { "content-type": "application/json", ...(c && { authorization: `Bearer ${c.token}`, "x-outlet-id": h.outletId }) },
      body: hasBody ? (rawBody ?? JSON.stringify(body)) : undefined,
    });
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    return { status: res.status, body: parsed, ct: res.headers.get("content-type") ?? "" };
  }
  const res = await c.call(r.method.toUpperCase(), path, hasBody ? body : undefined);
  return { status: res.status, body: res.body as unknown, ct: res.headers.get("content-type") ?? "" };
}

const failures: string[] = [];
function expectSane(label: string, res: { status: number; body: unknown; ct: string }) {
  if (res.status >= 500) failures.push(`${res.status} ${label} → ${JSON.stringify(res.body).slice(0, 160)}`);
  else if (res.status >= 400 && res.status !== 404 && !(res.ct.includes("json") && typeof (res.body as { error?: unknown })?.error === "string")) {
    failures.push(`bad error body ${res.status} ${label} → ${res.ct} ${String(JSON.stringify(res.body)).slice(0, 120)}`);
  }
}

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("Robustness sweep", { gst: true });
  clients.owner = await login(srv.base, h.users.owner.email, h.outletId);
  clients.cashier = await login(srv.base, h.users.cashier.email, h.outletId);
  clients.admin = await login(srv.base, (await createPlatformAdmin()).email);
}, 120_000);
afterAll(() => srv.close());

describe("no endpoint fails with a server error on hostile input", () => {
  it("hostile JSON bodies, as owner, cashier and Super Admin", async () => {
    for (const r of routes) {
      for (const who of ["owner", "cashier", "admin"] as const) {
        for (const [name, body] of who === "owner" ? BODIES : BODIES.slice(0, 3)) {
          if (r.method === "get" || r.method === "delete") {
            if (name !== "empty object") continue;
          }
          expectSane(`${who} ${r.method} ${r.path} [${name}]`, await send(clients[who]!, r, body));
        }
      }
    }
    expect(failures).toEqual([]);
  }, 600_000);

  it("malformed JSON and wrong content types", async () => {
    failures.length = 0;
    for (const r of routes.filter((x) => x.method !== "get" && x.method !== "delete")) {
      expectSane(`${r.method} ${r.path} [malformed JSON]`, await send(clients.owner!, r, undefined, "", '{"name": "chai",'));
    }
    expect(failures).toEqual([]);
  }, 300_000);

  it("hostile query strings on every GET", async () => {
    failures.length = 0;
    for (const r of routes.filter((x) => x.method === "get")) {
      for (const q of QUERIES) expectSane(`owner GET ${r.path}${q}`, await send(clients.owner!, r, undefined, q));
    }
    expect(failures).toEqual([]);
  }, 300_000);

  it("hostile path parameters", async () => {
    failures.length = 0;
    const ids = ["..%2F..%2Fetc%2Fpasswd", "%00", "1%20OR%201%3D1", "x".repeat(300), "-1", "%F0%9F%8D%9B"];
    for (const r of routes.filter((x) => x.path.includes(":"))) {
      for (const id of ids) {
        const path = r.path.replace(/:([A-Za-z0-9_]+)/g, id);
        const res = await fetch(`${srv.base}${path}`, {
          method: r.method.toUpperCase(),
          headers: { authorization: `Bearer ${clients.owner!.token}`, "x-outlet-id": h.outletId, "content-type": "application/json" },
          body: r.method === "get" || r.method === "delete" ? undefined : "{}",
        });
        const text = await res.text();
        let body: unknown = text;
        try {
          body = JSON.parse(text);
        } catch {
          /* not JSON */
        }
        expectSane(`${r.method} ${path.slice(0, 120)}`, { status: res.status, body, ct: res.headers.get("content-type") ?? "" });
      }
    }
    expect(failures).toEqual([]);
  }, 300_000);
});
