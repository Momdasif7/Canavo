/**
 * Integration test database: apply migrations (non-destructive) and run the
 * idempotent seed once per run. Tests create their own uniquely named tenants,
 * so the database never needs to be wiped between runs (CI starts from an
 * empty service database). Refuses any database whose name doesn't look like a
 * test database, so a mis-set DATABASE_URL can't touch dev or production data.
 */
import { execSync } from "node:child_process";
import path from "node:path";

export default function setup() {
  const url = process.env.DATABASE_URL ?? "";
  const db = new URL(url).pathname.replace(/^\//, "");
  if (!/(_it|_test)(_\w+)?$/.test(db)) {
    throw new Error(`Refusing to use database "${db}" — integration tests need a *_it or *_test database (IT_DATABASE_URL).`);
  }
  const cwd = path.join(__dirname, "../..");
  const env = { ...process.env };
  execSync("npx prisma migrate deploy", { cwd, env, stdio: "pipe" });
  execSync("npx tsx prisma/seed.ts", { cwd, env, stdio: "pipe" });
}
