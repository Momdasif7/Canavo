/**
 * Phase 7 (dbb) — drive the real API against the large perf dataset (test/db/perf-seed.sql) so the
 * PostgreSQL server log (log_min_duration_statement / auto_explain on that database only) records
 * every statement the hot endpoints issue, with RLS on (the app connects as a non-superuser).
 *
 *   DATABASE_URL=postgresql://canavo_app_it:canavo_app_it@localhost:5433/canavo_dbb_perf?schema=public \
 *   npx tsx test/db/perf-capture.ts [label]
 *
 * Prints status + wall time per endpoint (the timing table in docs/qa/phase-7/dbb.md).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

Object.assign(process.env, {
  NODE_ENV: "test",
  JWT_ACCESS_SECRET: "it-access-secret-0123456789abcdef0123456789",
  JWT_REFRESH_SECRET: "it-refresh-secret-0123456789abcdef012345678",
  RECEIPT_LINK_SECRET: "it-receipt-secret-0123456789abcdef01234567",
  DATA_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
  CORS_ORIGINS: "http://localhost:3000",
});

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => ymd(new Date(Date.now() - n * 86_400_000));
const today = daysAgo(0);
const month = daysAgo(31).slice(0, 7);

export const ENDPOINTS: string[] = [
  // bills
  `/orders?limit=50`,
  `/orders?from=${today}&to=${today}&limit=50`,
  `/orders?from=${daysAgo(30)}&to=${today}&status=PAID&limit=50`,
  `/orders?from=${daysAgo(30)}&to=${today}&paymentMode=UPI&limit=50`,
  `/orders?search=INV-1234&limit=50`,
  `/orders?search=98765&from=${daysAgo(90)}&to=${today}&limit=50`,
  `/orders?limit=50&offset=5000`,
  `/orders/summary?from=${today}&to=${today}`,
  `/orders/summary?from=${daysAgo(30)}&to=${today}`,
  `/orders/summary?from=${daysAgo(365)}&to=${today}`,
  `/orders/ord1001`,
  // reports
  ...["sales", "items", "categories", "peak-hours", "gst", "profit", "staff", "customers", "inventory", "delivery"].map(
    (k) => `/reports/${k}?from=${daysAgo(30)}&to=${today}`,
  ),
  // a full year on a busy outlet (~36k bills): relation loads must stay under PostgreSQL's 32,767 bind-variable cap
  ...["sales", "items", "categories", "peak-hours", "gst", "profit", "staff", "customers", "inventory", "delivery"].map(
    (k) => `/reports/${k}?from=${daysAgo(365)}&to=${today}&groupBy=month`,
  ),
  `/reports/gstr1?month=${month}`,
  `/reports/daily?date=${daysAgo(1)}`,
  `/reports/outlets/overview`,
  `/reports/owner-summary`,
  // service floor
  `/kot`,
  `/delivery`,
  `/delivery/partners/activity`,
  `/channels/board`,
  `/channels/orders`,
  `/tables/floor`,
  `/storefront/requests`,
  `/cash-shifts`,
  // inventory
  `/inventory/items`,
  `/inventory/transactions`,
  `/inventory/transactions?itemId=inv1_7`,
  `/inventory/alerts`,
  `/inventory/reports/consumption?from=${daysAgo(30)}&to=${today}`,
  `/inventory/reports/movement?from=${daysAgo(30)}&to=${today}`,
  `/inventory/reports/valuation`,
  // customers
  `/customers?search=Customer%201234`,
  `/customers?search=81234`,
  `/customers`,
  `/customers/lookup?phone=8000012345`,
  `/customers/cus12345`,
  `/customers/khata/outstanding`,
  // audit, notifications, staff
  `/admin/audit-logs`,
  `/admin/audit-logs?entity=Order&userId=usr1_2`,
  `/admin/audit-logs?action=order.*&outletId=out1&from=${daysAgo(7)}&to=${today}`,
  `/notifications`,
  `/attendance/calendar?month=${today.slice(0, 7)}`,
  `/attendance?from=${daysAgo(30)}&to=${today}`,
  `/attendance/register?month=${today.slice(0, 7)}`,
  `/staff`,
  `/staff/usr1_2/performance?from=${daysAgo(30)}&to=${today}`,
  `/canteen/members/lookup?q=8000012345`,
];

async function main() {
  const label = process.argv[2] ?? "run";
  const { createApp } = await import("../../src/app");
  const server = http.createServer(createApp());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${base}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "owner1@perf.local", password: "Perf@12345" }),
  });
  if (login.status !== 200) throw new Error(`login ${login.status} ${await login.text()}`);
  const { accessToken } = (await login.json()) as { accessToken: string };
  const rows: string[] = [];
  const only = process.env.ONLY ? new RegExp(process.env.ONLY) : undefined;
  for (const path of ENDPOINTS.filter((p) => !only || only.test(p))) {
    const call = async () => {
      const t = performance.now();
      const r = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${accessToken}`, "x-outlet-id": "out1" } });
      const body = await r.text();
      return { status: r.status, ms: performance.now() - t, size: body.length, body };
    };
    await call(); // warm
    const runs = [await call(), await call(), await call()];
    const ms = runs.map((x) => x.ms).sort((a, b) => a - b)[1]!;
    const r = runs[0]!;
    rows.push(`${label}\t${path}\t${r.status}\t${ms.toFixed(1)}\t${r.size}${r.status >= 400 ? `\t${r.body.slice(0, 160)}` : ""}`);
    console.log(rows.at(-1));
  }
  server.close();
  process.exit(0);
}

void main();
