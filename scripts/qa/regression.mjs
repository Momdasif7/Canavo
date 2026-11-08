#!/usr/bin/env node
/**
 * Regression pack runner (QA Phase 16). Selects automated suites by tag:
 *   npm run test:smoke-pack     @smoke      fast, no database (< 1 min): unit tests of shared + api
 *   npm run test:critical       @critical   money, tenant isolation (RLS), auth/security, data integrity
 *   npm run test:regression     @regression everything automated (unit + mobile jest + integration + API + DB)
 *   node scripts/qa/regression.mjs <tag> --list     print what would run
 * Integration / API / DB suites need Postgres (IT_DATABASE_URL / IT_APP_DATABASE_URL, see vitest.integration.config.ts).
 * The tag map below is the single source of truth; docs/qa/REGRESSION.md describes it.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** kind → how it runs. `files` are relative to the suite's working directory. */
export const PACKS = {
  smoke: [
    { kind: "shared-unit", files: [] }, // all of packages/shared/src/**/*.test.ts
    { kind: "api-unit", files: [] }, // all of apps/api/src/**/*.test.ts
  ],
  critical: [
    { kind: "shared-unit", files: ["src/gst.test.ts", "src/invoice.test.ts", "src/password.test.ts"] },
    {
      kind: "api-unit",
      files: ["src/lib/crypto.test.ts", "src/lib/cors.test.ts", "src/lib/demo-guard.test.ts", "src/lib/prod-mode.test.ts", "src/lib/observability.test.ts", "src/lib/shutdown.test.ts", "src/lib/safe-url.test.ts", "src/middleware/ip-whitelist.test.ts", "src/services/promotions.test.ts", "src/services/gstr1.test.ts"],
    },
    {
      kind: "integration",
      files: ["rls", "money-integrity", "idempotency", "tab-split-atomic", "gst-safeguards", "roles", "two-factor", "cookie-session", "outbox", "offline-series", "payments-extras", "support-access"].map((f) => `test/integration/${f}.test.ts`),
    },
    { kind: "api", files: ["auth", "security", "sweep-auth", "orders", "http-semantics", "platform"].map((f) => `test/api/${f}.test.ts`) },
    { kind: "db", files: ["tenant-integrity", "transactions", "reconciliation", "concurrency", "credit-note-rounding", "backup-restore"].map((f) => `test/db/${f}.test.ts`) },
  ],
  regression: [
    { kind: "shared-unit", files: [] },
    { kind: "api-unit", files: [] },
    { kind: "mobile-jest", files: [] },
    { kind: "integration", files: [] },
    { kind: "api", files: [] },
    { kind: "db", files: [] },
  ],
};

const one = (files) => (files.length === 1 ? files[0] : `{${files.join(",")}}`);
const RUNNERS = {
  "shared-unit": (f) => ({ cwd: "packages/shared", cmd: ["npx", "vitest", "run", ...f] }),
  "api-unit": (f) => ({ cwd: "apps/api", cmd: ["npx", "vitest", "run", ...f] }),
  "mobile-jest": () => ({ cwd: "apps/mobile", cmd: ["npx", "jest", "--ci"] }),
  integration: (f) => ({ cwd: "apps/api", cmd: ["npx", "vitest", "run", "-c", "vitest.integration.config.ts"], env: f.length ? { IT_INCLUDE: one(f) } : {} }),
  api: (f) => ({ cwd: "apps/api", cmd: ["npx", "vitest", "run", "-c", "vitest.integration.config.ts"], env: { IT_INCLUDE: f.length ? one(f) : "test/api/**/*.test.ts" } }),
  db: (f) => ({ cwd: "apps/api", cmd: ["node", "scripts/qa/run-db-tests.mjs", ...f] }),
};

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const tag = (process.argv[2] ?? "").replace(/^@/, "");
  const list = process.argv.includes("--list");
  if (!PACKS[tag]) {
    console.error(`usage: regression.mjs <${Object.keys(PACKS).join("|")}> [--list]`);
    process.exit(2);
  }
  const failed = [];
  for (const { kind, files } of PACKS[tag]) {
    const r = RUNNERS[kind](files);
    const label = `@${tag} ${kind}${files.length ? ` (${files.length} files)` : " (all)"}`;
    console.log(`\n▶ ${label}: ${Object.entries(r.env ?? {}).map(([k, v]) => `${k}=${v} `).join("")}${r.cmd.join(" ")}  [${r.cwd}]`);
    if (list) continue;
    const res = spawnSync(r.cmd[0], r.cmd.slice(1), { cwd: resolve(ROOT, r.cwd), stdio: "inherit", env: { ...process.env, ...r.env } });
    if (res.status !== 0) failed.push(label);
  }
  if (!list) {
    console.log(failed.length ? `\n✗ @${tag}: ${failed.length} suite(s) failed: ${failed.join("; ")}` : `\n✓ @${tag}: all suites passed`);
    process.exit(failed.length ? 1 : 0);
  }
}
