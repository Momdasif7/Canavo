/**
 * QA Phase 13 — N+1 / slow-query scan. Boots the API in-process with Prisma query logging and calls the
 * hot endpoints one at a time, printing per endpoint: statements issued (BEGIN/COMMIT/set_config excluded),
 * total DB ms, slowest statement, and the most repeated statement shape (an N+1 shows as a high repeat count).
 *
 *   DATABASE_URL="postgresql://canavo_app_it:canavo_app_it@localhost:5433/canavo_perf?schema=public" \
 *   npx tsx perf/n1-scan.ts            # (perf/seed.sql dataset; ONLY=<regex> to filter)
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

Object.assign(process.env, {
  NODE_ENV: "test",
  PRISMA_QUERY_LOG: "1",
  JWT_ACCESS_SECRET: "perf-access-0123456789abcdef0123456789abcdef",
  JWT_REFRESH_SECRET: "perf-refresh-0123456789abcdef0123456789abcde",
  RECEIPT_LINK_SECRET: "perf-receipt-0123456789abcdef0123456789abcd",
  DATA_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
});

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const year = `from=${ymd(new Date(Date.now() - 365 * 86_400_000))}&to=${ymd(new Date())}&groupBy=month`;

type Q = { query: string; duration: number };

async function main() {
  const { rawPrisma } = await import("../src/db");
  const { createApp } = await import("../src/app");
  let log: Q[] = [];
  (rawPrisma as unknown as { $on: (e: "query", cb: (q: Q) => void) => void }).$on("query", (q) => log.push({ query: q.query, duration: Number(q.duration) }));
  const server = http.createServer(createApp());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const token = async (email: string) => {
    const r = await fetch(`${base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "Perf@12345" }) });
    return ((await r.json()) as { accessToken: string }).accessToken;
  };
  const cashier = await token("u1_2@perf.local");
  const owner = await token("u1_1@perf.local");
  const kitchen = await token("u1_9@perf.local");
  const call = async (method: string, path: string, tok: string | null, body?: unknown) => {
    const r = await fetch(`${base}${path}`, {
      method,
      headers: { ...(tok && { authorization: `Bearer ${tok}`, "x-outlet-id": "out1" }), ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, json: (await r.json().catch(() => null)) as Record<string, unknown> | null };
  };
  const menu = await call("GET", "/menu", cashier);
  const items = (menu.json!.items as { id: string }[]).slice(0, 5);
  let orderId = "";
  let grand = 0;
  const steps: [string, () => Promise<{ status: number; json: Record<string, unknown> | null }>][] = [
    ["GET /auth/me", () => call("GET", "/auth/me", cashier)],
    ["GET /menu", () => call("GET", "/menu", cashier)],
    ["POST /orders (5 lines)", async () => {
      const r = await call("POST", "/orders", cashier, { orderType: "TAKEAWAY", items: items.map((i) => ({ menuItemId: i.id, quantity: 2 })) });
      orderId = String(r.json?.id);
      grand = Number(r.json?.grandTotal);
      return r;
    }],
    ["POST /orders/:id/payments", () => call("POST", `/orders/${orderId}/payments`, cashier, { payments: [{ mode: "UPI", amount: grand }] })],
    ["GET /orders/:id", () => call("GET", `/orders/${orderId}`, cashier)],
    ["GET /orders?limit=50", () => call("GET", "/orders?limit=50", owner)],
    ["GET /kot", () => call("GET", "/kot", kitchen)],
    ["GET /public/o/hotel-1", () => call("GET", "/public/o/hotel-1", null)],
    ["GET /tables/floor", () => call("GET", "/tables/floor", cashier)],
    ["GET /notifications", () => call("GET", "/notifications", cashier)],
    ["GET /reports/owner-summary", () => call("GET", "/reports/owner-summary", owner)],
    ...["sales", "items", "categories", "gst", "profit", "staff", "customers", "peak-hours"].map(
      (k) => [`GET /reports/${k} 1y`, () => call("GET", `/reports/${k}?${year}`, owner)] as [string, () => Promise<{ status: number; json: Record<string, unknown> | null }>],
    ),
  ];
  const only = process.env.ONLY ? new RegExp(process.env.ONLY) : undefined;
  console.log("endpoint\tstatus\twall_ms\tstatements\tdb_ms\tmax_stmt_ms\ttop_repeat");
  for (const [name, fn] of steps) {
    if (only && !only.test(name)) continue;
    log = [];
    const t = performance.now();
    const r = await fn();
    const wall = performance.now() - t;
    await new Promise((res) => setTimeout(res, 50)); // trailing fire-and-forget writes (audit, outbox)
    const real = log.filter((q) => !/^(BEGIN|COMMIT|ROLLBACK)/.test(q.query) && !q.query.includes("set_config('app.business_id'"));
    const shapes = new Map<string, number>();
    for (const q of real) {
      const shape = q.query.replace(/\$\d+/g, "?").replace(/\(\?(,\s*\?)+\)/g, "(?…)").slice(0, 140);
      shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
    }
    const [topShape, topN] = [...shapes.entries()].sort((a, b) => b[1] - a[1])[0] ?? ["", 0];
    const slow = real.reduce((m, q) => (q.duration > m.duration ? q : m), { query: "", duration: 0 });
    console.log(`${name}\t${r.status}\t${wall.toFixed(0)}\t${real.length}\t${real.reduce((s, q) => s + q.duration, 0)}\t${slow.duration}\t${topN}× ${topShape.slice(0, 110)}`);
    if (process.env.VERBOSE) for (const q of real) console.log(`   ${q.duration}ms ${q.query.slice(0, 200)}`);
  }
  server.close();
  process.exit(0);
}

void main();
