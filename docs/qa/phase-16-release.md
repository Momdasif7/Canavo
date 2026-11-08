# QA Phase 16a — regression, release & production readiness

Branch `agent/rel`, 2026-11-09. Verdict and full tables: [PRODUCTION_READINESS.md](PRODUCTION_READINESS.md).

## Done

| Item | Result |
|---|---|
| Regression pack | Tag map + runner `scripts/qa/regression.mjs`; `npm run test:smoke-pack` / `test:critical` / `test:regression`; [REGRESSION.md](REGRESSION.md). @smoke and @critical run green |
| CI | `.github/workflows/ci.yml`: build-test (lint, typecheck, unit, build), mobile (tsc + jest), integration (Postgres + Redis: integration, test:api, test:db), e2e-web (playwright installed in `$RUNNER_TEMP`, never a repo dependency; visual excluded on Linux), k6-smoke, security (gitleaks full history + semgrep). actionlint (docker): clean. Not pushed, never run on GitHub |
| k6 smoke | New `apps/api/perf/k6/smoke.js` (5 VUs × 30 s). Local run on a seeded scratch DB: 202/202 checks, p95 29 ms, 0 errors |
| Graceful shutdown | **Fix:** `src/lib/shutdown.ts`. SIGTERM now flags draining (`/ready` → 503), stops accepting, closes idle keep-alives, disconnects Socket.io clients, drains ≤ 10 s, then outbox → pg-boss → Redis → Prisma (each isolated), exit 0. Before: open WebSockets held `server.close()` for the full 10 s timeout and `/ready` stayed 200. Test `src/lib/shutdown.test.ts` (2 tests); live SIGTERM → exit ~1 s |
| Production config | Reviewed: zod fail-fast, `/health` `/ready`, request-id JSON logs, Sentry hook (documented, no dependency), rate limits, TRUST_PROXY, CORS, demo-user guard all present. Added pool settings to `.env.production.example` (`connection_limit=10&pool_timeout=10`) |
| Ops docs | `docs/ops/`: monitoring + alerts + pool sizing, logging/retention/Sentry, backup/restore + RPO ≤ 5 min (PITR) / RTO ≤ 1 h, deploy / rollback / incident runbooks, uploads → object storage, audit-log retention |
| RTM | `tools/rtm_status.py` fills RTM.csv/RTM.md: 92 requirements automated-pass, 493 manual case links, 0 executed |

## Test runs (`canavo_it_rel`)

| Suite | Result |
|---|---|
| Unit shared / api | 79 / 173 pass |
| Integration | 227 pass, 1 skipped (Redis not running locally) |
| `test:api` | 809 pass (29 files) |
| `test:db` | 85 pass (11 files) |
| Coverage (v8, installed in a scratch dir, not in the repo) | shared 50.6 % lines; api unit-only 13.1 %; api integration + API suites 88.9 % lines / 83.1 % branches |
| tsc api + web, `next lint` | clean (pre-existing warnings only) |

## Defects

rel-1 → BUG-147 (P2, ops): graceful shutdown waited for the 10 s drain timeout whenever a socket was connected,
and `/ready` did not report draining, so the load balancer kept routing requests to a stopping instance. Fixed + tested.

## Verdict

**GO for staging / pilot. NO-GO for general production** until the 338 manual P1 cases and the device, hardware
and payment checklists are executed by people. BUGS.csv: 147 logged (BUG-147 = rel-1), 0 open.

## Not verified

- CI on GitHub (no push). The first PR run may need tuning: E2E timings on Linux runners, and the semgrep `latest` image.
- Mobile jest in this worktree (no `apps/mobile/node_modules`). The count of 60 is from Phase 12. CI runs it.
- Web E2E not re-run (the API change is shutdown-only). Its counts are from Phase 11.
