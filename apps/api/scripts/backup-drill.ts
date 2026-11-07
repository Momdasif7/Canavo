/**
 * Restore drill (Phase 1.7): proves a backup can be restored, and measures how long it takes.
 *   npm run backup:drill -w @canavo/api            # backup the configured DB, restore into <db>_drill, verify, drop
 *   npm run backup:drill -w @canavo/api -- --keep  # keep the drill database for inspection
 * DRILL_DATABASE_URL: use an existing empty database instead of creating one (managed hosts).
 * Writes a JSON report to <storage>/backups/drills/.
 */
import { execFileSync, execSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { createBackup, backupsDir } from "../src/services/backup";
import { platformPrisma } from "../src/db";

const keep = process.argv.includes("--keep");
const ms = (t0: number) => Math.round(performance.now() - t0);

/** Money checks that must agree between the live database and the restored copy. */
async function reconcile(db: PrismaClient, bypass: boolean) {
  return db.$transaction(async (tx) => {
    if (bypass) await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    const [orders] = await tx.$queryRaw<{ n: bigint; paid: bigint | null; open: bigint | null }[]>`
      SELECT count(*)::bigint AS n,
             sum(CASE WHEN status = 'PAID' THEN "grandTotal" END)::bigint AS paid,
             sum(CASE WHEN status = 'OPEN' THEN "grandTotal" END)::bigint AS open
      FROM "Order"`;
    const [payments] = await tx.$queryRaw<{ n: bigint; amount: bigint | null }[]>`
      SELECT count(*)::bigint AS n, sum(amount)::bigint AS amount FROM "Payment" WHERE status = 'SUCCESS'`;
    const [underpaid] = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT count(*)::bigint AS n FROM "Order" o
      WHERE o.status = 'PAID' AND o."grandTotal" > coalesce((SELECT sum(p.amount) FROM "Payment" p WHERE p."orderId" = o.id AND p.status = 'SUCCESS'), 0)`;
    const [stock] = await tx.$queryRaw<{ q: number | null }[]>`SELECT round(sum(quantity)::numeric, 3)::float AS q FROM "InventoryStock"`;
    return {
      orders: Number(orders!.n),
      paidTotalPaise: Number(orders!.paid ?? 0),
      openTotalPaise: Number(orders!.open ?? 0),
      successfulPayments: Number(payments!.n),
      paymentsPaise: Number(payments!.amount ?? 0),
      paidOrdersNotCoveredByPayments: Number(underpaid!.n),
      stockQuantitySum: stock!.q ?? 0,
    };
  });
}

async function main() {
  const t0 = performance.now();
  const source = new URL(process.env.DATABASE_URL!);
  const drillUrl = new URL(process.env.DRILL_DATABASE_URL ?? source.toString());
  if (!process.env.DRILL_DATABASE_URL) drillUrl.pathname = `${source.pathname}_drill`;
  const drillName = drillUrl.pathname.slice(1);
  if (drillUrl.toString() === source.toString()) throw new Error("The drill database must differ from the source database");

  console.info(`[drill] 1/4 backup of ${source.pathname.slice(1)}`);
  let t = performance.now();
  const backup = await createBackup("manual");
  const backupMs = ms(t);
  const sourceChecks = await reconcile(platformPrisma as unknown as PrismaClient, true);

  console.info(`[drill] 2/4 fresh database ${drillName}`);
  t = performance.now();
  if (!process.env.DRILL_DATABASE_URL) {
    const admin = new URL(source.toString());
    admin.pathname = "/postgres";
    admin.search = "";
    const a = new PrismaClient({ datasources: { db: { url: admin.toString() } } });
    await a.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${drillName}" WITH (FORCE)`);
    await a.$executeRawUnsafe(`CREATE DATABASE "${drillName}"`);
    await a.$disconnect();
  }
  execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: drillUrl.toString() } });
  const migrateMs = ms(t);

  console.info(`[drill] 3/4 restore ${backup.file}`);
  t = performance.now();
  const out = execFileSync("npx", ["tsx", path.join(__dirname, "backup-drill-restore.ts"), backup.file], {
    env: { ...process.env, DATABASE_URL: drillUrl.toString(), JOBS_MODE: "worker" },
    encoding: "utf8",
  });
  const restored = JSON.parse(out.trim().split("\n").pop()!) as { rows: number; counts: Record<string, number> };
  const restoreMs = ms(t);

  console.info("[drill] 4/4 verify");
  const drillDb = new PrismaClient({ datasources: { db: { url: drillUrl.toString() } } });
  const drillChecks = await reconcile(drillDb, true);
  await drillDb.$disconnect();
  const countMismatches = Object.entries(backup.counts).filter(([m, n]) => (restored.counts[m] ?? 0) !== n);
  const checksMatch = JSON.stringify(sourceChecks) === JSON.stringify(drillChecks);

  if (!keep && !process.env.DRILL_DATABASE_URL) {
    const admin = new URL(source.toString());
    admin.pathname = "/postgres";
    admin.search = "";
    const a = new PrismaClient({ datasources: { db: { url: admin.toString() } } });
    await a.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${drillName}" WITH (FORCE)`);
    await a.$disconnect();
  }

  const report = {
    at: new Date().toISOString(),
    backup: { file: backup.file, bytes: backup.size, rows: backup.rows, offsite: backup.offsite },
    restoredRows: restored.rows,
    countMismatches,
    sourceChecks,
    drillChecks,
    checksMatch,
    timingsMs: { backup: backupMs, migrate: migrateMs, restore: restoreMs, total: ms(t0) },
    passed: countMismatches.length === 0 && checksMatch,
  };
  const dir = path.join(backupsDir(), "drills");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `drill-${report.at.replace(/[:.]/g, "-")}.json`);
  await writeFile(file, JSON.stringify(report, null, 2));
  console.info(JSON.stringify(report, null, 2));
  console.info(`[drill] ${report.passed ? "PASSED" : "FAILED"} in ${report.timingsMs.total} ms — report ${file}`);
  if (!report.passed) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error("[drill] failed:", e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => platformPrisma.$disconnect());
