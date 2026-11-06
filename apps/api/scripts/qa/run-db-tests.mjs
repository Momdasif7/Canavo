/**
 * npm run test:db — the database suites (QA Phase 7) look at the WHOLE database: backup/restore
 * truncates and restores every table, reconciliation and tenant-integrity scan every row. So each
 * file gets a freshly recreated database (one vitest run per file; global setup recreates it).
 *   npm run test:db                       all files
 *   npm run test:db -- test/db/pool.test.ts   one file
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const files = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync("test/db").filter((f) => f.endsWith(".test.ts")).sort().map((f) => `test/db/${f}`);
const failed = [];
for (const file of files) {
  console.log(`\n▶ ${file}`);
  const r = spawnSync("npx", ["vitest", "run", "-c", "vitest.integration.config.ts"], { stdio: "inherit", env: { ...process.env, IT_INCLUDE: file } });
  if (r.status !== 0) failed.push(file);
}
console.log(failed.length ? `\n✗ ${failed.length} of ${files.length} file(s) failed: ${failed.join(", ")}` : `\n✓ all ${files.length} database test files passed`);
process.exit(failed.length ? 1 : 0);
