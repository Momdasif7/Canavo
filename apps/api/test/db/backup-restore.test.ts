/**
 * QA Phase 7 — platform backup & restore (src/services/backup.ts, /admin/backups).
 *
 * Runs against the integration database as the NON-superuser app role (RLS real):
 *  - backup → restore over a populated database: per-table counts and money/stock reconciliation identical
 *  - the app keeps working after a restore (sequences: OutboxEvent.seq)
 *  - backup → restore into a brand-new, freshly migrated database (as the app role): counts, sums,
 *    RLS policies (FORCE), enums and sequences all present
 *  - restore refuses: other migration set, truncated file, role without TRUNCATE — and changes nothing
 */
import { execFileSync, execSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { backupsDir, tableCounts } from "../../src/services/backup";
import { createHotel, createPlatformAdmin, db, login, startServer, type Client, type Hotel } from "../integration/helpers";

const OWNER_URL = process.env.IT_DATABASE_URL!;
const APP_URL = process.env.IT_APP_DATABASE_URL!;
const APP_ROLE = decodeURIComponent(new URL(APP_URL).username);
const SCRATCH_DB = `canavo_dbc_restore_${process.pid}`;
const withDb = (url: string, name: string) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};
const API_DIR = path.resolve(__dirname, "../..");

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel, h2: Hotel;
let admin: Client;
let owner: PrismaClient; // database owner (superuser in docker) — grants and migration bookkeeping only
const created: string[] = [];

type Recon = Awaited<ReturnType<typeof reconcile>>;
/** Money / stock figures that must survive a restore to the paisa. */
async function reconcile(client: PrismaClient) {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    const one = async (q: string) => Object.values(((await tx.$queryRawUnsafe(q)) as Record<string, unknown>[])[0]!).map((v) => (v == null ? 0 : Number(v)));
    const [orders, paid, open, cancelled] = await one(
      `SELECT count(*), sum(CASE WHEN status='PAID' THEN "grandTotal" END), sum(CASE WHEN status='OPEN' THEN "grandTotal" END), sum(CASE WHEN status='CANCELLED' THEN "grandTotal" END) FROM "Order"`,
    );
    const [payments, paymentsPaise] = await one(`SELECT count(*), sum(amount) FROM "Payment" WHERE status='SUCCESS'`);
    const [items, itemsPaise] = await one(`SELECT count(*), sum(total) FROM "OrderItem"`);
    const [khata, khataTxns] = await one(`SELECT sum("khataBalance"), (SELECT sum(CASE WHEN type='DEBIT' THEN amount ELSE -amount END) FROM "KhataTransaction") FROM "Customer"`);
    const [stock] = await one(`SELECT round(sum(quantity)::numeric, 3) FROM "InventoryStock"`);
    const [outboxMax] = await one(`SELECT max(seq) FROM "OutboxEvent"`);
    return { orders, paid, open, cancelled, payments, paymentsPaise, items, itemsPaise, khata, khataTxns, stock, outboxMax };
  });
}

/** RLS / enum / sequence facts of a database. */
async function catalog(client: PrismaClient) {
  const q = <T>(s: string) => client.$queryRawUnsafe<T[]>(s);
  return {
    policies: (await q<{ t: string; p: string }>(`SELECT tablename AS t, policyname AS p FROM pg_policies WHERE schemaname='public' ORDER BY 1,2`)).map((r) => `${r.t}.${r.p}`),
    forced: (await q<{ t: string }>(`SELECT relname AS t FROM pg_class WHERE relnamespace='public'::regnamespace AND relkind='r' AND relrowsecurity AND relforcerowsecurity ORDER BY 1`)).map((r) => r.t),
    enums: (await q<{ e: string }>(`SELECT t.typname || '.' || string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) AS e FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid GROUP BY t.typname ORDER BY 1`)).map((r) => r.e),
    functions: (await q<{ f: string }>(`SELECT proname AS f FROM pg_proc WHERE pronamespace='public'::regnamespace ORDER BY 1`)).map((r) => r.f),
  };
}

const counts = () => tableCounts();
const latestBackupFile = async () => {
  const r = await admin.call("POST", "/admin/backups", {});
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  created.push(r.body.file);
  return r.body as { file: string; rows: number; counts: Record<string, number> };
};

async function paidBill(c: Client, items: { menuItemId: string; quantity: number }[], mode = "CASH") {
  const o = await c.call("POST", "/orders", { orderType: "TAKEAWAY", items });
  expect(o.status, JSON.stringify(o.body)).toBe(201);
  const pay = await c.call("POST", `/orders/${o.body.id}/payments`, { payments: [{ mode, amount: o.body.grandTotal }] });
  expect(pay.status, JSON.stringify(pay.body)).toBe(200);
  return o.body as { id: string; grandTotal: number };
}

/** Realistic data in two hotels: paid / open / cancelled bills, khata, stock, outbox events. */
async function fillHotel(hotel: Hotel) {
  const cashier = await login(srv.base, hotel.users.cashier.email, hotel.outletId);
  const manager = await login(srv.base, hotel.users.manager.email, hotel.outletId);
  for (let i = 0; i < 4; i++) await paidBill(cashier, [{ menuItemId: hotel.items.chai, quantity: 1 + i }, { menuItemId: hotel.items.biryani, quantity: 1 }], i % 2 ? "UPI" : "CASH");
  const open = await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: hotel.items.samosa, quantity: 2 }] });
  expect(open.status).toBe(201);
  const toCancel = await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: hotel.items.samosa, quantity: 1 }] });
  expect((await manager.call("POST", `/orders/${toCancel.body.id}/cancel`, { reason: "qa void" })).status).toBe(200);
  const customer = await db.customer.create({ data: { businessId: hotel.businessId, name: "Khata Kumar", phone: `98${Date.now().toString().slice(-8)}`, khataBalance: 12_345 } });
  await db.khataTransaction.createMany({
    data: [
      { customerId: customer.id, outletId: hotel.outletId, type: "DEBIT", amount: 15_345, mode: "KHATA" },
      { customerId: customer.id, outletId: hotel.outletId, type: "CREDIT", amount: 3_000, mode: "UPI" },
    ],
  });
  const inv = await db.inventoryItem.create({ data: { businessId: hotel.businessId, name: "Rice", unit: "KG", costPerUnit: 11_000 } });
  await db.inventoryStock.create({ data: { outletId: hotel.outletId, inventoryItemId: inv.id, quantity: 12.375 } });
  // Its opening ledger row, so the stock reconciles (C01) when test/db runs the reconciliation checks afterwards.
  await db.inventoryTransaction.create({ data: { outletId: hotel.outletId, inventoryItemId: inv.id, type: "OPENING", quantity: 12.375, balanceAfter: 12.375 } });
}

beforeAll(async () => {
  srv = await startServer();
  owner = new PrismaClient({ datasources: { db: { url: OWNER_URL } } });
  h = await createHotel("Backup A", { gst: true });
  h2 = await createHotel("Backup B");
  const gst5 = await db.taxRate.findFirstOrThrow({ where: { businessId: h.businessId, cgst: 2.5, sgst: 2.5 } });
  await db.menuItem.updateMany({ where: { id: { in: Object.values(h.items) } }, data: { taxRateId: gst5.id } });
  admin = await login(srv.base, (await createPlatformAdmin()).email);
  await fillHotel(h);
  await fillHotel(h2);
  // Let the outbox publisher deliver what it can; undelivered rows must survive too.
  await new Promise((r) => setTimeout(r, 500));
}, 120_000);

afterAll(async () => {
  await srv?.close();
  for (const f of created) await unlink(path.join(backupsDir(), f)).catch(() => undefined);
  await owner?.$executeRawUnsafe(`REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM "${APP_ROLE}"`).catch(() => undefined);
  const admin = new PrismaClient({ datasources: { db: { url: withDb(OWNER_URL, "postgres") } } });
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`).catch(() => undefined);
  await admin.$disconnect();
  await owner?.$disconnect();
});

describe("restore refuses safely", () => {
  it("an app role without TRUNCATE gets a clear refusal and nothing changes", async () => {
    // The integration role (like a least-privilege production role) has only SELECT/INSERT/UPDATE/DELETE.
    await owner.$executeRawUnsafe(`REVOKE TRUNCATE ON ALL TABLES IN SCHEMA public FROM "${APP_ROLE}"`);
    const { file } = await latestBackupFile();
    const before = await counts();
    const r = await admin.call("POST", `/admin/backups/${file}/restore`, { confirm: "RESTORE" });
    expect(r.status, JSON.stringify(r.body)).toBe(409);
    expect(JSON.stringify(r.body)).toMatch(/TRUNCATE/);
    expect(await counts()).toEqual(before);
    // Restore needs TRUNCATE (docs/deployment/DEPLOYMENT.md): grant it for the rest of this file.
    await owner.$executeRawUnsafe(`GRANT TRUNCATE ON ALL TABLES IN SCHEMA public TO "${APP_ROLE}"`);
  });

  it("a backup taken on another migration set is refused (409) and nothing changes", async () => {
    const { file } = await latestBackupFile();
    await owner.$executeRawUnsafe(
      `INSERT INTO _prisma_migrations (id, checksum, migration_name, started_at, finished_at, applied_steps_count) VALUES ('qa-fake', 'x', '29991231000000_qa_future', now(), now(), 1)`,
    );
    try {
      const before = await counts();
      const r = await admin.call("POST", `/admin/backups/${file}/restore`, { confirm: "RESTORE" });
      expect(r.status).toBe(409);
      expect(JSON.stringify(r.body)).toMatch(/does not match/);
      expect(await counts()).toEqual(before);
    } finally {
      await owner.$executeRawUnsafe(`DELETE FROM _prisma_migrations WHERE id = 'qa-fake'`);
    }
  });

  it("a truncated file (no end marker) is refused and nothing changes", async () => {
    const { file } = await latestBackupFile();
    const lines = gunzipSync(await readFile(path.join(backupsDir(), file))).toString("utf8").trimEnd().split("\n");
    const cut = file.replace(/-(\d{6})\.ndjson\.gz$/, (_m, t: string) => `-${String((Number(t) + 1) % 1_000_000).padStart(6, "0")}.ndjson.gz`);
    await writeFile(path.join(backupsDir(), cut), gzipSync(lines.slice(0, Math.floor(lines.length / 2)).join("\n") + "\n"));
    created.push(cut);
    const before = await counts();
    const r = await admin.call("POST", `/admin/backups/${cut}/restore`, { confirm: "RESTORE" });
    expect(r.status).toBe(400);
    expect(JSON.stringify(r.body)).toMatch(/truncated/);
    expect(await counts()).toEqual(before);
  });
});

describe("backup → restore over a populated database", () => {
  let snapshot: { counts: Record<string, number>; recon: Recon; file: string };

  it("restores every table's row count and every money / stock total exactly", async () => {
    const b = await latestBackupFile();
    snapshot = { counts: await counts(), recon: await reconcile(db as unknown as PrismaClient), file: b.file };
    // backup.create is audited after the snapshot is written.
    expect({ ...b.counts, AuditLog: b.counts.AuditLog! + 1 }).toEqual(snapshot.counts);
    expect(snapshot.recon.orders).toBeGreaterThanOrEqual(12);
    expect(snapshot.recon.paid).toBeGreaterThan(0);
    expect(snapshot.recon.khata).toBeGreaterThanOrEqual(2 * 12_345); // other test/db files may have run first (shared DB)
    expect(snapshot.recon.outboxMax).toBeGreaterThan(0);

    // Change things after the backup: a new bill, a deleted customer, a stock move.
    const cashier = await login(srv.base, h.users.cashier.email, h.outletId);
    await paidBill(cashier, [{ menuItemId: h.items.biryani, quantity: 3 }]);
    await db.customer.deleteMany({ where: { businessId: h2.businessId, name: "Khata Kumar" } });
    await db.inventoryStock.updateMany({ where: { outletId: h.outletId }, data: { quantity: 1 } });
    expect(await reconcile(db as unknown as PrismaClient)).not.toEqual(snapshot.recon);

    const r = await admin.call("POST", `/admin/backups/${b.file}/restore`, { confirm: "RESTORE" });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.rows).toBe(b.rows);
    const after = await counts();
    expect({ ...after, AuditLog: after.AuditLog! - 1 }).toEqual({ ...snapshot.counts, AuditLog: snapshot.counts.AuditLog! - 1 }); // + backup.restore
    expect(await reconcile(db as unknown as PrismaClient)).toEqual(snapshot.recon);
  });

  it("the app keeps working after the restore: new bills (outbox events, invoice numbers) are written", async () => {
    const cashier = await login(srv.base, h.users.cashier.email, h.outletId);
    // Creating a bill writes outbox events in the same transaction: a stale sequence would collide here.
    for (let i = 0; i < 3; i++) await paidBill(cashier, [{ menuItemId: h.items.chai, quantity: 2 }]);
    const [{ seq }] = await db.$queryRawUnsafe<{ seq: bigint }[]>(`SELECT max(seq) AS seq FROM "OutboxEvent"`);
    expect(Number(seq)).toBeGreaterThan(snapshot.recon.outboxMax);
  });
});

describe("backup → restore into a new, empty database", () => {
  it("as the app role: identical counts and totals; RLS, enums, functions and sequences in place", async () => {
    const pg = new PrismaClient({ datasources: { db: { url: withDb(OWNER_URL, "postgres") } } });
    await pg.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE)`);
    await pg.$executeRawUnsafe(`CREATE DATABASE "${SCRATCH_DB}"`);
    await pg.$disconnect();
    execSync("npx prisma migrate deploy", { cwd: API_DIR, stdio: "pipe", env: { ...process.env, DATABASE_URL: withDb(OWNER_URL, SCRATCH_DB) } });
    const target = new PrismaClient({ datasources: { db: { url: withDb(OWNER_URL, SCRATCH_DB) } } });
    try {
      for (const g of [
        `GRANT CONNECT ON DATABASE "${SCRATCH_DB}" TO "${APP_ROLE}"`,
        `GRANT USAGE ON SCHEMA public TO "${APP_ROLE}"`,
        `GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public TO "${APP_ROLE}"`,
        `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO "${APP_ROLE}"`,
        `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO "${APP_ROLE}"`,
      ])
        await target.$executeRawUnsafe(g);

      const b = await latestBackupFile();
      const sourceCounts = await counts();
      const sourceRecon = await reconcile(db as unknown as PrismaClient);
      const out = execFileSync("npx", ["tsx", "scripts/backup-drill-restore.ts", b.file], {
        cwd: API_DIR,
        env: { ...process.env, DATABASE_URL: withDb(APP_URL, SCRATCH_DB), JOBS_MODE: "worker" },
        encoding: "utf8",
      });
      const restored = JSON.parse(out.trim().split("\n").pop()!) as { rows: number; counts: Record<string, number> };
      expect(restored.rows).toBe(b.rows);
      expect(restored.counts).toEqual(Object.fromEntries(Object.entries(b.counts).filter(([, n]) => n > 0)));
      expect({ ...b.counts, AuditLog: b.counts.AuditLog! + 1 }).toEqual(sourceCounts);
      expect(await reconcile(target)).toEqual(sourceRecon);
      expect(await catalog(target)).toEqual(await catalog(owner));

      // RLS still bites in the restored copy for the app role: no setting = no rows.
      const app = new PrismaClient({ datasources: { db: { url: withDb(APP_URL, SCRATCH_DB) } } });
      try {
        expect(await app.order.count()).toBe(0);
        expect(
          await app.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT set_config('app.business_id', ${h.businessId}, true)`;
            return tx.outlet.count();
          }),
        ).toBe(2);
        // Sequences moved past the restored rows: a new outbox event gets a fresh seq.
        const ev = await app.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
          return tx.outboxEvent.create({ data: { kind: "task", name: "qa.restore", payload: {} } });
        });
        expect(Number(ev.seq)).toBeGreaterThan(sourceRecon.outboxMax);
      } finally {
        await app.$disconnect();
      }
    } finally {
      await target.$disconnect();
    }
  }, 120_000);
});
