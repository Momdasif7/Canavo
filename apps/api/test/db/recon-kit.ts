/**
 * QA Phase 7 — run docs/qa/sql/reconciliation.sql against the integration database.
 * The file is split on its "-- @check" / "-- @warn" markers; each query runs in one
 * READ ONLY transaction with row-level security bypassed (owner connection).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

export interface Check {
  kind: "check" | "warn";
  id: string;
  slug: string;
  sql: string;
}

export const RECON_FILE = path.resolve(__dirname, "../../../../docs/qa/sql/reconciliation.sql");

export function loadChecks(file = RECON_FILE): Check[] {
  const text = readFileSync(file, "utf8");
  const parts = text.split(/^-- @(check|warn) /m).slice(1);
  const out: Check[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const kind = parts[i] as Check["kind"];
    const body = parts[i + 1];
    const [head, ...rest] = body.split("\n");
    const [id, slug] = head.trim().split(/\s+/);
    const sql = rest
      .filter((l) => !l.trim().startsWith("--"))
      .join("\n")
      .trim()
      .replace(/;\s*$/, "");
    if (sql.includes(";")) throw new Error(`${id}: more than one statement`);
    out.push({ kind, id, slug, sql });
  }
  return out;
}

const json = (v: unknown) => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? Number(x) : x)));

/** Owner (superuser) connection to the integration DB — never the app role. */
export function ownerClient() {
  return new PrismaClient({ datasources: { db: { url: process.env.IT_DATABASE_URL! } } });
}

type Raw = { $queryRawUnsafe: PrismaClient["$queryRawUnsafe"] };

/** Run the queries on an open transaction / client (no READ ONLY here). */
export async function runChecksOn(tx: Raw, checks = loadChecks()) {
  const results: { check: Check; rows: Record<string, unknown>[] }[] = [];
  await tx.$queryRawUnsafe("SELECT set_config('app.bypass_rls', 'on', true)");
  for (const check of checks) {
    try {
      results.push({ check, rows: json(await tx.$queryRawUnsafe(check.sql)) });
    } catch (e) {
      throw new Error(`${check.id} ${check.slug} failed to run: ${(e as Error).message.split("\n").slice(-1)[0]}`);
    }
  }
  return results;
}

/** Run every query read-only; returns the rows each one found. */
export async function runChecks(db: PrismaClient, checks = loadChecks()) {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      return runChecksOn(tx, checks);
    },
    { timeout: 120_000 },
  );
}

/** Failing @check queries as readable lines (empty = books are right). */
export function failures(results: Awaited<ReturnType<typeof runChecks>>) {
  return results.filter((r) => r.check.kind === "check" && r.rows.length).map((r) => `${r.check.id} ${r.check.slug}: ${r.rows.length} row(s) e.g. ${JSON.stringify(r.rows.slice(0, 3))}`);
}
