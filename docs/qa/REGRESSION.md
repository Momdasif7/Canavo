# Regression pack (QA Phase 16)

Automated suites are grouped by tag. The tag map lives in one place, `scripts/qa/regression.mjs` (`PACKS`); this page
explains it. `node scripts/qa/regression.mjs <tag> --list` prints the exact commands without running them.

| Tag | Command | When | What runs | Needs | Time (laptop) |
|---|---|---|---|---|---|
| **@smoke** | `npm run test:smoke-pack` | every commit, pre-push | all unit tests: `packages/shared` (79) + `apps/api/src/**/*.test.ts` (173) | nothing | < 30 s |
| **@critical** | `npm run test:critical` | every PR, before every deploy | money, tax, tenant isolation, auth, security, data integrity (list below) | Postgres (`IT_DATABASE_URL`, `IT_APP_DATABASE_URL`) | ~5 min |
| **@regression** | `npm run test:regression` | release candidate, nightly | everything automated: unit + mobile jest + integration + API + DB suites | Postgres (+ `IT_REDIS_URL` for the Redis adapter test) | ~15 min |

Outside the Node runner (separate tools, all in CI — `.github/workflows/ci.yml`):

| Tag | Suite | Command |
|---|---|---|
| @regression | Web E2E journeys / browsers / network / a11y / robust (plain `playwright`, installed in a temp dir, never a repo dependency) | `PW_PATH=… node apps/web/scripts/qa/e2e/run.cjs` (see its README) |
| @regression | Web visual baselines (macOS Chrome only) | `SUITES=visual node apps/web/scripts/qa/e2e/run.cjs` — local only |
| @smoke | Live-stack smoke (17 checks, self-cleaning; post-deploy) | `SMOKE_API_URL=https://… npm run test:smoke -w @canavo/api` |
| @smoke | k6 smoke (5 VUs × 30 s, p95 < 500 ms, errors < 1 %) | `docker run … grafana/k6 run apps/api/perf/k6/smoke.js` |
| @critical | Secret scan (gitleaks, tree + history), SAST (semgrep) | `npm run security:secrets`, `npm run security:sast` |
| — | Load / stress / soak (Phase 13, not per PR) | `apps/api/perf/README.md` |

## @critical contents

| Suite | Files |
|---|---|
| shared unit | `gst`, `invoice`, `password` |
| api unit | `crypto`, `cors`, `demo-guard`, `prod-mode`, `observability`, `shutdown`, `safe-url`, `ip-whitelist`, `promotions`, `gstr1` |
| integration | `rls`, `money-integrity`, `idempotency`, `tab-split-atomic`, `gst-safeguards`, `roles`, `two-factor`, `cookie-session`, `outbox`, `offline-series`, `payments-extras`, `support-access` |
| API (`test/api`) | `auth`, `security`, `sweep-auth`, `orders`, `http-semantics`, `platform` |
| DB (`test/db`, fresh DB per file) | `tenant-integrity`, `transactions`, `reconciliation`, `concurrency`, `credit-note-rounding`, `backup-restore` |

Last run (2026-11-09, `canavo_it_rel`): **@smoke green**, **@critical green** (all 5 groups).

## Rules

- A new test file joins @regression automatically (whole directories run). Add it to @critical in `PACKS` when it
  guards money, tax, tenant isolation, auth or data loss.
- A P0/P1 bug fix ships with a test in @critical.
- Manual P1 cases (`docs/qa/manual/MANUAL_TEST_CASES.csv`, Priority = P1) are the human regression pack before a
  production release.
