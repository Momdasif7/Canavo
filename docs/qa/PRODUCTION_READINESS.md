# CANAVO — production readiness (QA Phase 16)

As of 2026-11-09, branch `agent/rel` (on top of `feat/market-leader` @ 5ba504f).

## Verdict

**GO for staging / pilot (a few friendly hotels, with the on-call runbooks below).
NO-GO for general production until the 338 manual P1 cases (and the real-device, hardware and payment checklists)
have been executed by people and pass.**

Every automated gate is green and no P0/P1 defect is open. Nothing on the human side has been executed yet:
the manual pack was written in Phase 15 but has no recorded results. Real Razorpay, WhatsApp, SMS and printer
traffic, real Android devices and provider PITR were never exercised (no credentials or hardware).

## Exit criteria

| # | Criterion | Target | Actual | Met |
|---|---|---|---|---|
| 1 | Open P0 / P1 defects (`BUGS.csv`) | 0 | 0 open (147 logged: 13 P0, 38 P1, 73 P2, 23 P3, all **Verified**) | ✅ |
| 2 | Open P2 defects | none blocking | 0 open | ✅ |
| 3 | Automated suites | all green | unit, integration, API, DB, @critical green on 2026-11-09 (counts below) | ✅ |
| 4 | Coverage, `packages/shared` (unit) | ≥ 70 % lines on business rules | 50.6 % lines / 87.2 % branches / 73.5 % functions (79 unit tests; the uncovered half is mostly static data tables and the CRM/theatre helpers exercised through the API suites) | ⚠️ |
| 5 | Coverage, `apps/api` | ≥ 60 % lines (unit + integration + API) | unit only: 13.1 % lines; **integration + API suites: 88.9 % lines / 83.1 % branches / 88.7 % functions** (v8, 1,016 tests) | ✅ |
| 6 | Manual P1 cases (`manual/MANUAL_TEST_CASES.csv`) | 100 % executed, 0 P1 fails | **0 / 338 executed** | ❌ |
| 7 | Real-device / hardware / payment checklists | done on target devices | not executed | ❌ |
| 8 | Performance (Phase 13) | lunch-rush p95 bill < 500 ms, soak without leaks | met (lunch rush, soak 35 min); menu-load ❌ on the laptop only (CPU-bound) | ✅ / ⚠️ |
| 9 | Security scans | 0 findings | gitleaks 0, semgrep 0, ZAP active 119 checks pass; 20 dependency advisories accepted (major upgrades) | ✅ |
| 10 | Backup + restore drill | restore proven | `docs/qa/phase-7/dbc.md` drill pass; provider PITR + off-site restore not run | ⚠️ |
| 11 | CI on every PR | build, lint, typecheck, unit, integration/API/DB, E2E, security, k6 smoke | `.github/workflows/ci.yml` (actionlint clean; first GitHub run still to happen) | ✅ |
| 12 | Ops readiness | runbooks, alerts, RPO/RTO | `docs/ops/` | ✅ |
| 13 | Production config | fail-fast, health/ready, graceful shutdown, logs, limits | reviewed below | ✅ |

## Production configuration review

| Item | State |
|---|---|
| Env validation | zod schema in `apps/api/src/env.ts`, exits on invalid env; production refuses placeholder / equal secrets, missing `DATA_ENCRYPTION_KEY`, localhost URLs, `CORS_ORIGINS=*`, trust-all `TRUST_PROXY`, no email/SMS channel |
| `/health`, `/ready` | `/health` = process up; `/ready` = DB `SELECT 1`, **and now 503 while draining** (Phase 16) |
| Graceful shutdown | **Phase 16 fix:** `src/lib/shutdown.ts` — SIGTERM → `/ready` 503, stop accepting, idle keep-alives closed, Socket.io clients disconnected (an open WebSocket previously held `server.close()` for the full 10 s), drain ≤ 10 s then cut, then outbox → pg-boss → Redis → Prisma, each isolated, exit 0. Test `src/lib/shutdown.test.ts`; live run: SIGTERM → exit in ~1 s |
| Logs | pino JSON in production, `X-Request-Id` in/out, redaction of secrets + personal data, no query strings / receipt tokens in URLs |
| Error tracking | `setErrorReporter` hook, Sentry-ready without a dependency; how to enable with `SENTRY_DSN`: `docs/ops/LOGGING.md` |
| Metrics | `/metrics` (Prometheus; Bearer `METRICS_TOKEN` required in production): HTTP histogram, errors, job runs, outbox pending/dead, process |
| Rate limits | login / OTP / storefront / integrations per IP (express-rate-limit, **in memory per instance**: with N instances the limit is N×) |
| `TRUST_PROXY` | default loopback + private ranges; trust-all refused in production |
| CORS | explicit origin list (wildcard subdomains allowed per entry), credentials on |
| DB pool | not set by default → **set** `?connection_limit=10&pool_timeout=10` (now in `.env.production.example`; sizing rule in `docs/ops/MONITORING.md`); pool timeout answers 503 + Retry-After |
| Demo users | `assertNoDemoLogins` refuses to start in production while demo logins are active; seed refuses `NODE_ENV=production` |
| Log retention | 30 days hot / 1 year archive recommended (`docs/ops/LOGGING.md`); audit log 13 months live, archive ≥ 8 years (`docs/ops/AUDIT_LOG_RETENTION.md`) |

## Summary table

Counts from the repo on 2026-11-09. "Executed / Passed" = last run (this phase unless noted). Bugs = `BUGS.csv` by the phase
that found them (147 total incl. BUG-147 from this phase; all Fixed + Verified, 0 open).

| Test type | Cases written | Automated | Manual | Executed | Passed | Failed | Bugs found | Fixed | Open |
|---|---|---|---|---|---|---|---|---|---|
| Unit — `packages/shared` | 79 | 79 | 0 | 79 | 79 | 0 | 2 (Phase 2 build) | 2 | 0 |
| Unit — `apps/api` | 173 | 173 | 0 | 173 | 173 | 0 | (incl. above) | — | — |
| Unit — mobile (jest) | 60 | 60 | 0 | 60 (Phase 12) | 60 | 0 | 6 (Phase 12 mobile) | 6 | 0 |
| Integration (real Postgres, RLS) | 228 | 228 | 0 | 228 | 227 | 0 (1 skipped: Redis not running locally; CI has Redis) | 9 (Phase 9 concurrency) + 6 (Phase 10 realtime) | 15 | 0 |
| API (`test:api`) | 809 | 809 | 0 | 809 | 809 | 0 | 46 (Phase 6 + follow-up) | 46 | 0 |
| Database (`test:db`) | 85 | 85 | 0 | 85 | 85 | 0 | 33 (Phase 7) | 33 | 0 |
| Live-stack smoke | 10 tests / 17 checks | 10 | 0 | 10 (Phase 2) | 10 | 0 | — | — | — |
| Web E2E (journeys, browsers, network, visual, a11y, robust) | 156 checks | 156 | 0 | 156 (Phase 11) | 156 | 0 | 10 (Phase 11) | 10 | 0 |
| Performance (k6) | 9 scripts | 9 | 0 | 9 (Phase 13; smoke this phase) | 8 | 1 (menu-load p95 on laptop, CPU-bound) | 5 (Phase 13) | 5 | 0 |
| Security (gitleaks, semgrep, ZAP, deps) | 4 scans + 119 ZAP checks | 4 | 0 | 4 (Phase 8) | 4 | 0 | 15 (Phase 8) | 15 | 0 |
| Compliance (GST / DPDP) | in unit + API suites | yes | 0 | yes (Phase 14) | yes | 0 | 11 (Phase 14) | 11 | 0 |
| Manual cases (`MANUAL_TEST_CASES.csv`) | 575 (338 P1, 227 P2, 10 P3) | 0 | 575 | **0** | 0 | 0 | — | — | — |
| Manual checklists (device 32, hardware 29, l10n 16, payment, UAT, chaos, exploratory) | see `phase-15-manual.md` | 0 | all | **0** | 0 | 0 | — | — | — |
| Ops / release (Phase 16) | 2 shutdown tests (counted in api unit) | — | — | — | — | — | 1 (BUG-147) | 1 | 0 |
| Owner requests (not from a test phase) | — | — | — | — | — | — | 3 | 3 | 0 |
| **Total** | **1,444 automated + 575 manual** (+ 156 E2E checks) | **1,444** | **575** | **1,444 automated, 0 manual** | | **0 automated regressions** | **147** (13 P0, 38 P1) | **147** | **0** |

Automated total = 79 + 173 + 60 + 228 + 809 + 85 + 10 tests (E2E checks, k6 and scans counted separately).

## Open risks (from Phase 6–15 recommendations; none is a failing test)

| Risk | Source | Mitigation / owner decision |
|---|---|---|
| Manual, device, hardware and payment checks not executed | Phase 15 | Execute P1 pack before general release (this verdict) |
| Real Razorpay / WhatsApp / SMS / UrbanPiper / Expo push never exercised | Phase 6, 10 | Pilot with real credentials on staging |
| Provider PITR and off-site (S3) restore not drilled | Phase 7 dbc | Drill on staging before go-live; RPO/RTO in `docs/ops/BACKUP_RESTORE.md` |
| Platform restore = one long transaction (≈ 3.5k rows/s, 15 min cap) | Phase 7 dbb/dbc | Maintenance mode or COPY-based restore before data grows |
| Rate limits per process (memory) | Phase 6 | Redis store when scaling past one API instance |
| 113 soft references without FKs; financial cascades | Phase 7 dba | Nightly tenant-integrity + reconciliation SQL; RESTRICT migration |
| Audit log growth, no retention job | Phase 7 dbd | `docs/ops/AUDIT_LOG_RETENTION.md` (partition + archive) |
| Uploads on local disk / served without login (72-bit names) | Phase 6 | `docs/ops/UPLOADS_STORAGE.md` (object storage) |
| Next 14 / Expo 51 / zod 3 / Prisma 6 advisories; CSP `unsafe-inline` | Phase 8 | Major upgrades as separate tasks |
| Lockout answer reveals existing accounts (423 vs 401) | Phase 6, 8 | Align answers (P3) |
| Delivery partners / kitchen sockets receive more customer data than needed | Phase 10 | Narrow event payloads |
| GST: B2B / e-invoicing (IRN) not built; same invoice numbers under one GSTIN with prefix "INV" | Phase 7, 14 | Product decision before onboarding > ₹5 cr turnover / multi-outlet GSTINs |
| Brand orange contrast (WCAG) | Phase 11 | Brand decision |
| Menu-load p95 on a laptop | Phase 13 | Re-measure on production-size hardware |
| CI workflow never run on GitHub yet | Phase 16 | First PR run; visual baselines excluded on Linux |

## Release notes — QA programme (Phases 1–16)

- **Phase 1–2:** test strategy, RTM (92 requirements), build health; unit tests run in a clean clone.
- **Phase 6 (API):** suite over every route, auth sweep, OpenAPI contract; 46 defects incl. 8 P0 (OTP lock bypass, tenant leaks).
- **Phase 7 (database):** RLS, constraints, backup/restore drill, reconciliation SQL, tenant-integrity (340 checks), indexes; 33 defects.
- **Phase 8 (security):** gitleaks, semgrep, ZAP, log redaction, trust-proxy hardening; 15 defects.
- **Phase 9–10:** concurrency (locks, deadlock retry) and realtime (socket session checks); 15 defects.
- **Phase 11–12:** web UI journeys, browsers, a11y, network, visual; mobile jest; 16 defects incl. one P0 (duplicate bill id).
- **Phase 13:** k6 load, stress, spike, soak on 1M bills; 5 defects (report sums, async hashing, caches, tx timeouts).
- **Phase 14:** GST / DPDP compliance; 11 defects.
- **Phase 15:** 575 manual cases + UAT, device, hardware, payment, chaos, localisation checklists (not executed).
- **Phase 16:** regression tags + runner (`docs/qa/REGRESSION.md`), full CI pipeline, graceful shutdown with Socket.io
  drain + `/ready` draining, DB pool settings, ops docs, this report.

## Runbooks

[Ops index](../ops/README.md) · [Deploy](../ops/RUNBOOK_DEPLOY.md) · [Rollback](../ops/RUNBOOK_ROLLBACK.md) ·
[Incident](../ops/RUNBOOK_INCIDENT.md) · [Monitoring](../ops/MONITORING.md) · [Backup/restore](../ops/BACKUP_RESTORE.md) ·
[Migrations](phase-7/migration-runbook.md)
