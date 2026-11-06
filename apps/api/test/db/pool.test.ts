/**
 * QA Phase 7 (dbb) — the Prisma connection pool under stress, as the non-superuser app role:
 *  1. pool exhausted by slow requests → the overflow gets a quick, clean 503 (no hang, no stack),
 *     and the API serves normally once the slow work is done;
 *  2. every API backend connection killed mid-traffic (pg_terminate_backend: failover / idle-kill)
 *     → failures are clean, and the API reconnects and serves the next requests;
 *  3. the tenant setting (set_config('app.business_id', …, true)) never survives on a pooled
 *     connection: two hotels interleaved at high concurrency over a 2–3 connection pool never see
 *     each other's rows — through the HTTP API and directly on the tenant client.
 * Child API instances get their own pool via DATABASE_URL ?connection_limit=&pool_timeout=.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHotel, db, login, type Hotel } from "../integration/helpers";

const APP_DB = process.env.IT_APP_DATABASE_URL!;
const OWNER_DB = process.env.IT_DATABASE_URL!;
const owner = new PrismaClient({ datasources: { db: { url: OWNER_DB } } }); // superuser: locks, pg_terminate_backend
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const withParams = (url: string, p: Record<string, string | number>) => {
  const u = new URL(url);
  for (const [k, v] of Object.entries(p)) u.searchParams.set(k, String(v));
  return u.toString();
};

interface ChildApi {
  base: string;
  stop: () => Promise<void>;
}
const children: ChildApi[] = [];

/** Start the real API in a child process with its own (small) Prisma pool. */
async function spawnApi(pool: Record<string, number>): Promise<ChildApi> {
  const child: ChildProcessWithoutNullStreams = spawn("npx", ["tsx", path.join(__dirname, "pool-server.ts")], {
    env: { ...process.env, DATABASE_URL: withParams(APP_DB, pool), LOG_LEVEL: "fatal" },
    stdio: "pipe",
  });
  const port = await new Promise<number>((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => reject(new Error(`child API did not start: ${buf.slice(-500)}`)), 60_000);
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString();
      const m = /\{"port":(\d+)\}/.exec(buf);
      if (m) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
      if (buf.length > 100_000) buf = buf.slice(-10_000);
    });
    child.stderr.on("data", (d: Buffer) => (buf += d.toString()));
    child.on("exit", (code) => reject(new Error(`child API exited ${code}: ${buf.slice(-500)}`)));
  });
  const api: ChildApi = {
    base: `http://127.0.0.1:${port}`,
    stop: async () => {
      if (child.exitCode !== null) return;
      const gone = new Promise((r) => child.once("exit", r));
      child.stdin.end();
      child.kill("SIGTERM");
      await Promise.race([gone, sleep(5000)]);
    },
  };
  children.push(api);
  return api;
}

/** A response is "clean" when it is JSON without any stack trace or driver internals. */
function expectClean(r: { status: number; body: unknown }) {
  const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
  expect(text).not.toMatch(/\bat \w+.*\(|node_modules|PrismaClient|prisma\.\w+\(\)|invocation/);
  expect(typeof r.body).toBe("object");
}

let A: Hotel, B: Hotel;
const ORDERS_PER_HOTEL = 12;

/** Bills for one outlet straight in SQL (the app role with bypass, like a migration). */
async function seedOrders(h: Hotel, tag: string) {
  await db.$executeRawUnsafe(`
    INSERT INTO "Order"(id, "outletId", "cashierId", "invoiceNumber", "documentType", "orderType", status, subtotal, discount,
      "taxableValue", "serviceCharge", cgst, sgst, igst, "roundOff", "grandTotal", "taxBreakup", "createdAt", "updatedAt", "customerName")
    SELECT '${tag}-' || g, '${h.outletId}', '${h.users.cashier.id}', '${tag}-' || g, 'BILL', 'TAKEAWAY', 'PAID', 1000, 0, 1000, 0, 0, 0, 0, 0, 1000,
      '[]'::jsonb, now() - (g || ' minutes')::interval, now(), '${tag}'
    FROM generate_series(1, ${ORDERS_PER_HOTEL}) g`);
}

beforeAll(async () => {
  [A, B] = [await createHotel("PoolA"), await createHotel("PoolB")];
  await seedOrders(A, `pa${Date.now()}`);
  await seedOrders(B, `pb${Date.now()}`);
}, 120_000);

afterAll(async () => {
  await Promise.all(children.map((c) => c.stop()));
  await owner.$disconnect();
});

describe("pool exhaustion (connection_limit=2, pool_timeout=2s)", () => {
  it("overflow requests fail fast with a clean 503 + Retry-After, the held ones finish, then the API serves normally", async () => {
    const api = await spawnApi({ connection_limit: 2, pool_timeout: 2 });
    const c = await login(api.base, A.users.owner.email, A.outletId);
    expect((await c.call("GET", "/orders?limit=5")).status).toBe(200);

    // Slow requests: bills are locked by another session, so every /orders call holds its connection.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const lock = owner.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`LOCK TABLE "Order" IN ACCESS EXCLUSIVE MODE`);
        locked();
        await held;
      },
      { timeout: 120_000, maxWait: 10_000 },
    );
    await isLocked;

    const t0 = Date.now();
    const done: { status: number; body: unknown; ms: number }[] = [];
    const calls = Array.from({ length: 8 }, () =>
      c.call("GET", "/orders?limit=5").then((r) => {
        const x = { status: r.status, body: r.body, ms: Date.now() - t0, retryAfter: r.headers.get("retry-after") };
        done.push(x);
        return x;
      }),
    );
    // The overflow must not queue forever: within pool_timeout (+ slack) they come back.
    const deadline = Date.now() + 15_000;
    while (done.length < 6 && Date.now() < deadline) await sleep(100);
    expect(done.length, "requests waiting for a pooled connection must time out, not hang").toBeGreaterThanOrEqual(6);
    for (const r of done) {
      expect(r.status).toBe(503);
      expectClean(r);
      expect(r.ms).toBeLessThan(15_000);
    }
    expect((done[0] as { retryAfter?: string | null }).retryAfter).toBeTruthy();

    release();
    await lock;
    const all = await Promise.all(calls);
    expect(all.filter((r) => r.status === 200).length).toBe(2); // the two that held the pool finish once the lock is gone
    // Recovery: a burst within the pool size is served normally.
    const after = await Promise.all(Array.from({ length: 6 }, () => c.call("GET", "/orders?limit=5")));
    expect(after.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(after[0]!.body).toHaveLength(5);
  }, 90_000);
});

describe("backend connections killed mid-traffic (pg_terminate_backend)", () => {
  it("reads are served straight through a kill (stale connections retried); a write hit by it gets a clean 503", async () => {
    const api = await spawnApi({ connection_limit: 4, pool_timeout: 5 });
    const c = await login(api.base, A.users.owner.email, A.outletId);
    let killed = 0;
    const killer = async () => {
      const rows = await owner.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(pg_terminate_backend(pid))::bigint AS n FROM pg_stat_activity
         WHERE datname = current_database() AND usename = $1 AND pid <> pg_backend_pid()`,
        decodeURIComponent(new URL(APP_DB).username),
      );
      killed += Number(rows[0]!.n);
    };
    // 4 parallel clients x 15 rounds; every app-role backend of this database is killed before rounds 5 and 10.
    const statuses: number[] = [];
    for (let round = 0; round < 15; round++) {
      if (round === 5 || round === 10) await killer();
      const rs = await Promise.all(Array.from({ length: 4 }, () => c.call("GET", "/orders?limit=5")));
      for (const r of rs) {
        statuses.push(r.status);
        if (r.status !== 200) expectClean(r);
      }
    }
    expect(killed).toBeGreaterThanOrEqual(8);
    expect(statuses).toEqual(Array(60).fill(200));
    // Straight after a kill, the very next request (sequential) is served.
    await killer();
    const next = await c.call("GET", "/orders?limit=5");
    expect(next.status).toBe(200);
    expect(next.body).toHaveLength(5);
    // A write whose connection was killed is not retried blindly: clean 503 + Retry-After, or served.
    // (Bills go to outlet 2 so the tenant tests below still see exactly ORDERS_PER_HOTEL in outlet 1.)
    const c2 = await login(api.base, A.users.owner.email, A.outlet2Id);
    await killer();
    const w = await c2.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: A.items.chai, quantity: 1 }] });
    expect([201, 503]).toContain(w.status);
    expectClean(w);
    if (w.status === 503) expect(w.headers.get("retry-after")).toBeTruthy();
    // ...and the API is fully back.
    const again = await c2.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: A.items.chai, quantity: 1 }] });
    expect(again.status, JSON.stringify(again.body)).toBe(201);
  }, 120_000);
});

describe("tenant setting never leaks across pooled connections", () => {
  it("HTTP: two hotels interleaved, 400 requests at concurrency 40 over a 3-connection pool — no cross-tenant row", async () => {
    const api = await spawnApi({ connection_limit: 3, pool_timeout: 20 });
    const ca = await login(api.base, A.users.owner.email, A.outletId);
    const cb = await login(api.base, B.users.owner.email, B.outletId);
    const outletsOf = (h: Hotel) => new Set([h.outletId, h.outlet2Id]);
    const menuOf = (h: Hotel) => new Set(Object.values(h.items));
    const jobs: (() => Promise<void>)[] = [];
    let checked = 0;
    for (let i = 0; i < 400; i++) {
      const [c, h] = i % 2 ? [cb, B] : [ca, A];
      const kind = i % 4 < 2 ? "orders" : "menu";
      jobs.push(async () => {
        const r = await c.call("GET", kind === "orders" ? "/orders?limit=200" : "/menu");
        expect(r.status, JSON.stringify(r.body).slice(0, 200)).toBe(200);
        if (kind === "orders") {
          expect(r.body).toHaveLength(ORDERS_PER_HOTEL);
          for (const o of r.body as { outletId: string }[]) expect(outletsOf(h).has(o.outletId)).toBe(true);
        } else {
          const ids = (r.body as { items: { id: string }[] }).items.map((x) => x.id);
          expect(ids.length).toBe(3);
          for (const id of ids) expect(menuOf(h).has(id)).toBe(true);
        }
        checked++;
      });
    }
    const queue = [...jobs];
    await Promise.all(Array.from({ length: 40 }, async () => {
      while (queue.length) await queue.shift()!();
    }));
    expect(checked).toBe(400);
  }, 120_000);

  it("tenant client: set_config is transaction-local — interleaved contexts, rollbacks and raw queries never inherit another hotel's setting", async () => {
    // A fresh copy of src/db with a 2-connection pool, so every connection is reused many times.
    vi.resetModules();
    const prev = process.env.DATABASE_URL;
    process.env.DATABASE_URL = withParams(APP_DB, { connection_limit: 2, pool_timeout: 30 });
    const { prisma, rawPrisma } = await import("../../src/db");
    const { runWithTenant } = await import("../../src/lib/tenant");
    process.env.DATABASE_URL = prev;
    try {
      type Row = { b: string | null; bypass: string | null; outlets: string[] | null };
      const probe = () =>
        prisma.$queryRaw<Row[]>`SELECT current_setting('app.business_id', true) AS b, current_setting('app.bypass_rls', true) AS bypass,
          (SELECT array_agg(DISTINCT "outletId") FROM "Order") AS outlets`;
      const billsOf = async (h: Hotel) => db.order.count({ where: { outlet: { businessId: h.businessId } } });
      const expected = new Map([[A.businessId, await billsOf(A)], [B.businessId, await billsOf(B)]]);
      const tasks: Promise<void>[] = [];
      for (let i = 0; i < 300; i++) {
        const h = i % 3 === 0 ? A : i % 3 === 1 ? B : null;
        tasks.push(
          (async () => {
            if (!h) {
              // a request with a context but no hotel (e.g. a platform admin): fail closed, sees no bills
              const [r] = await runWithTenant({ platform: true }, probe);
              expect(r!.b ?? "").toBe("");
              expect(r!.bypass).toBe("off");
              expect(r!.outlets).toBeNull();
              return;
            }
            const mine = new Set([h.outletId, h.outlet2Id]);
            await runWithTenant({ businessId: h.businessId }, async () => {
              const [r] = await probe();
              expect(r!.b).toBe(h.businessId);
              expect(r!.bypass).toBe("off");
              for (const o of r!.outlets ?? []) expect(mine.has(o)).toBe(true);
              // model query (batch [set_config, query])
              const orders = await prisma.order.findMany({ select: { outletId: true } });
              expect(orders.length).toBe(expected.get(h.businessId));
              for (const o of orders) expect(mine.has(o.outletId)).toBe(true);
              // interactive transaction that fails half-way: its setting must die with the rollback
              if (i % 7 === 0) {
                await expect(
                  prisma.$transaction(async (tx) => {
                    await tx.order.count();
                    throw new Error("boom");
                  }),
                ).rejects.toThrow("boom");
              }
            });
          })(),
        );
      }
      await Promise.all(tasks);
      // After all that, no pooled connection carries a tenant: raw (no set_config) sees nothing and no setting.
      const leftovers = await Promise.all(
        Array.from({ length: 10 }, () =>
          rawPrisma.$queryRaw<{ b: string | null; n: bigint }[]>`SELECT current_setting('app.business_id', true) AS b, (SELECT count(*) FROM "Order")::bigint AS n`,
        ),
      );
      for (const [r] of leftovers) {
        expect(r!.b ?? "").toBe("");
        expect(Number(r!.n)).toBe(0);
      }
    } finally {
      await rawPrisma.$disconnect();
    }
  }, 120_000);
});
