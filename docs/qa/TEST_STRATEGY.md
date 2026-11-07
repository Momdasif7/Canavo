# CANAVO — Test Strategy

| | |
|---|---|
| Product | CANAVO, a multi-tenant SaaS POS for Indian canteens, hotels and restaurants |
| Codebase | Turborepo monorepo: `packages/shared`, `apps/api`, `apps/web`, `apps/mobile` (standalone Expo package) |
| Branch | `qa/full-testing` (baseline `008952a` on `main`) |
| Version | 1.0 |
| Owner | QA (Claude, acting as QA architect / SDET), reviewed by the product owner |

## 1. Objectives

1. Prove that money is always right. Bills, GST, offers, payments, khata, loyalty and COD cash all reconcile to the paisa.
2. Prove that hotels can never see each other's data. The Super Admin must not see hotel data, and every role sees only what its permissions allow.
3. Prove that billing never loses data. Nothing is lost under network loss, concurrency or crashes: no partial orders, duplicate bills or missed kitchen tickets.
4. Find and fix defects, each with a failing test first, and certify production readiness with an evidence-based GO/NO-GO.

## 2. Scope

### 2.1 In scope

| Area | Items |
|---|---|
| Shared package | `computeBill` (GST engine), rounding, `rbac.ts`, `modules.ts`, zod schemas, formatting |
| API (≈ 243 routes in 20 routers) | auth, platform, outlets, staff, menu + bulk import, tax rates, orders/billing, payments, kot, tables, reservations, delivery, inventory, customers/loyalty/khata, offers/coupons, attendance/leave, reports, notifications, uploads, admin (audit, backups, export, settings, Aadhaar), public receipt links, webhooks |
| Services and jobs | billing, promotions + offer engine, delivery dispatch, inventory deduction/costing, notify/alerts, backup/restore, menu import, report export, GSTR-1, scheduled jobs |
| Database | PostgreSQL schema, migrations, constraints, indexes, tenant integrity, reconciliation, backup/restore |
| Real-time | Socket.io auth, rooms, reconnect, kitchen display resync, notifications and push payloads |
| Web | All screens for every role, cross-browser, responsive, accessibility, visual regression of POS / KDS / receipt |
| Mobile | Typecheck, build, component logic, offline queue, permissions; real-device manual pack |
| Non-functional | Security (OWASP API/Web Top 10), performance/load/soak, resilience, compliance (GST, DPDP, UIDAI masking) |
| Documentation | RTM, defect log, manual test pack, runbooks, production readiness report |

### 2.2 Out of scope (and why)

| Item | Reason / substitute |
|---|---|
| Real third-party calls (MSG91, Razorpay live, WATI, Cloudinary, SMTP, Expo push service) | Ground rule: no real credentials. Use the documented dev fallbacks and mock servers; real-gateway checks are in the manual Payment checklist. |
| App-store review and publishing | Needs developer accounts. Covered by the manual Install runbook. |
| Physical hardware (thermal printers, cash drawer, barcode scanner, wall KDS) | Manual Hardware checklist only. |
| Penetration testing by an external firm | Out of mandate. ZAP/semgrep/gitleaks and the manual probing here are a substitute, not a replacement. |
| Legal sign-off on GST / DPDP | QA flags gaps. A CA or legal counsel confirms them. |

## 3. Test levels

| Level | What | Where | Tooling |
|---|---|---|---|
| L1 Unit | Pure functions: bill engine, offer engine, rbac, time/FY, costing, geofence, dispatch selection | `packages/shared/src/*.test.ts`, `apps/api/src/**/*.test.ts` | Vitest, fast-check, Stryker |
| L2 Component / integration | Services with a real Postgres (transactions, tenant filter, hooks) | `apps/api/test/integration/**` | Vitest + Docker Postgres (testcontainers-style, separate DB) |
| L3 API | HTTP contract, validation, auth, idempotency, error format | `apps/api/test/api/**` | Vitest + Supertest; Postman/Newman collection; OpenAPI from zod |
| L4 System / E2E | Role journeys through the real web app and gateway | `e2e/**` | Playwright (Chromium, Firefox, WebKit), axe-core |
| L5 Non-functional | Load, stress, soak, security scans, DB performance | `perf/**`, `security/**` | k6, OWASP ZAP baseline, semgrep, gitleaks, npm audit |
| L6 Acceptance | UAT per role, exploratory charters, real-device and hardware checks | `docs/qa/manual/**` | Human testers with the manual pack |

## 4. Test types and techniques

| Type | Technique / approach | Phase |
|---|---|---|
| Smoke | 15-minute suite: login per role, bill, KOT appears, report loads, logout | 2 |
| Sanity | Post-deploy checklist, 10 minutes, manual + scripted | 2 |
| Static analysis | tsc strict, ESLint strict, madge (cycles), knip/depcheck (dead code, unused deps), semgrep, raw-SQL audit, route guard audit | 3 |
| Unit | Equivalence partitioning, boundary value analysis, decision tables, property-based (fast-check), mutation (Stryker) | 4 |
| Functional | Per module × role; EP, BVA, decision tables, state transitions, error guessing | 5 |
| API / contract | Status codes, schemas, error format, validation fuzz, auth matrix, idempotency, HTTP semantics, rate limits | 6 |
| Database | Schema review, tenant integrity SQL, EXPLAIN ANALYZE, migrations up/forward-fix, reconciliation SQL, isolation, backup/restore | 7 |
| Security | Isolation matrix (route × role × module × tenant × outlet), OWASP Top 10, business-logic abuse, SAST/DAST/secrets/CVE | 8 |
| Concurrency / resilience | Parallel requests, failure injection, job double-execution | 9 |
| Real-time | Socket auth, room scoping, reconnect, resync, 200 KDS clients | 10 |
| UI / E2E | Journeys, cross-browser, viewports, network throttling, visual regression, a11y, double-submit, multi-tab | 11 |
| Mobile | tsc, build, unit/component, offline queue logic; manual real-device pack | 12 |
| Performance | Load (lunch rush), stress, spike, 8 h soak, N+1 detection, Lighthouse, bundle size | 13 |
| Compliance | GST hand calculations, GSTR-1 totals, Indian formats, DPDP / UIDAI review | 14 |
| Manual / exploratory / UAT / usability | Manual pack ≥ 400 cases, charters, SUS | 15 |
| Regression | Tagged `@smoke @regression @critical`, CI on every PR | 16 |

## 5. Environments

| Env | Purpose | Composition | Data |
|---|---|---|---|
| **LOCAL** (dev machine) | Development, unit, API, E2E during QA | Docker Postgres 16 on :5433, API :4000 (tsx), web :3100 behind gateway :8080/:3001 | Demo seed + QA fixtures |
| **TEST-DB** (ephemeral) | Integration, DB, concurrency, isolation tests | Separate database `canavo_test` on the same Postgres container, recreated per run with `prisma migrate deploy` | QA fixtures only (3 hotels below) |
| **STAGING-LIKE** (Docker) | Built artefacts: `apps/api/Dockerfile` image + `next build` + Postgres, `NODE_ENV=production` | docker compose profile `staging` (to be added in Phase 16) | QA fixtures + anonymised volume data |
| **PROD-LIKE** (perf) | Load, soak, DAST, backup/restore drills | Same images, resource-limited containers (2 vCPU / 4 GB API, Postgres 4 GB) | Synthetic: 50 hotels, ~1M orders |
| **REAL DEVICES** | Manual mobile, printing, GPS, push | Android 10–14 (2 GB / mid / high), 2 iOS versions, a tablet | Staging tenant |

Environment rules:
- Tests never point at the demo DB that the user browses, except the read-only smoke suite and explicit, self-cleaning smoke writes.
- Clock-dependent tests set `TZ` to both `UTC` and `Asia/Kolkata` and freeze time where needed (FY rollover, happy hours, IST day boundaries).

## 6. Test data strategy

### 6.1 Fixture hotels (created by a deterministic QA seed, `apps/api/test/fixtures/seed-qa.ts`)

| Hotel | Profile | Modules | Outlets | Purpose |
|---|---|---|---|---|
| **H1 "Chai Corner"** | Small shop, **GST not registered** | Billing, Kitchen, Attendance | 1 | GST-off bills (no tax lines), minimal modules, module gating |
| **H2 "Spice Route"** | **GST registered** (regular), prices exclusive, 0/5/12/18/28 % + cess + named extra tax items | All 10 modules | 2 (intra-state + one inter-state test case) | Full feature coverage, IGST, delivery, inventory, offers |
| **H3 "Annapurna Group"** | **Composition scheme**, prices inclusive, multi-outlet | Billing, Kitchen, Tables, Inventory, Customers, Reports | 3 | Bill of Supply, cross-outlet isolation, transfers, all-outlets report |

### 6.2 Users

Every hotel gets one user per role: Owner, Manager (per outlet), Cashier, Kitchen, Inventory, Delivery (2 partners in H2). Add one Super Admin, one suspended user, one user whose role changed (token version), and one Manager assigned to only one of H3's outlets. Passwords are generated and stored only in the fixture module.

### 6.3 Edge-case menu (H2)

These items exercise the edge cases:
- 0 % item; 5 / 12 / 18 / 28 % items; a 28 % + 12 % cess item; an item with a named extra tax (VAT 5 %).
- Item with sizes and add-ons; per-outlet price override; time-windowed item (07:00–11:30) and an overnight window (22:00–02:00).
- Out-of-stock and hidden items.
- 100-character name; Tamil / Hindi / emoji names (`மசாலா தோசை`, `मसाला चाय`, `🍵 Chai`).
- Price ₹0.01; price ₹99,999.99.
- Recipe with size override; recipe whose ingredient cost changes after purchases (weighted average).

### 6.4 Volume data (perf only)

A generator script (`perf/data/generate.ts`) creates 50 hotels, 120 outlets, 1M orders over 365 days with realistic hour-of-day curves (lunch/dinner peaks), 5 % cancellations, 30 % delivery, and loyalty/khata activity. It's run only in PROD-LIKE.

### 6.5 Rules

- Fixtures are idempotent: each run creates fresh businesses with a run tag and cleans up after itself.
- No production data is ever copied unanonymised (DPDP).
- Money in fixtures is in paise. Expected values are computed by hand in the test, not by calling `computeBill`.

## 7. Entry and exit criteria

### 7.1 Entry (per phase)

- The previous phase's report is committed in `docs/qa/` and approved ("continue").
- A clean install builds (`npm ci && npm run build`) and the DB migrates from empty.
- The test environment for the phase is up and reachable.

### 7.2 Exit (release)

| # | Criterion | Target |
|---|---|---|
| E1 | Open P0 defects | 0 |
| E2 | Open P1 defects | 0 (or explicitly waived by the product owner in writing) |
| E3 | Statement/branch coverage | `packages/shared` ≥ 95 % branch (goal 100 %); `apps/api/src/services` ≥ 85 % |
| E4 | Mutation score (shared) | ≥ 80 %, surviving mutants reviewed |
| E5 | Isolation matrix | 100 % pass (no cross-tenant / cross-role leak) |
| E6 | Reconciliation SQL | All checks return zero discrepancy on seed + after load test |
| E7 | Critical manual cases | 100 % executed, 100 % passed |
| E8 | Performance | p95 bill creation < 500 ms, menu < 300 ms, 1-year report < 3 s, error rate < 0.1 % at target load |
| E9 | Security | No High/Critical from ZAP baseline, semgrep, npm audit (prod deps), gitleaks |
| E10 | Accessibility | No axe "serious/critical" violations on POS, KDS, login, settings |
| E11 | CI | Pipeline green on the release commit: build, lint, typecheck, unit, integration, E2E smoke, security scans, k6 smoke |

### 7.3 Suspension / resumption

Testing of a module is suspended when a P0 blocks more than 30 % of its cases. It resumes once the fix is merged and the smoke suite is green.

## 8. Risk register (impact × likelihood, 1–5 each)

| ID | Risk | Impact | Likelihood | Score | Mitigation / tests |
|---|---|---|---|---|---|
| R1 | Cross-tenant data leak (IDOR, missing tenant filter, raw SQL) | 5 | 3 | **15** | Isolation matrix (Ph 8), raw-SQL audit (Ph 3), tenant integrity SQL (Ph 7) |
| R2 | Wrong bill amount / GST (rounding, mixed rates, composition, discounts) | 5 | 3 | **15** | Unit + property tests (Ph 4), GST hand-calculated bills (Ph 14) |
| R3 | Lost or duplicate orders in offline sync / retries | 5 | 3 | **15** | Idempotency tests (Ph 6, 9), offline chaos manual (Ph 15) |
| R4 | Super Admin or lower role reaches hotel data (privilege escalation) | 5 | 2 | 10 | Role matrix, mass-assignment tests (Ph 8) |
| R5 | Concurrency: over-redeemed coupons/points, invoice number collisions, stock races, double assignment | 4 | 3 | 12 | Parallel tests (Ph 9), DB constraints (Ph 7) |
| R6 | Kitchen misses tickets (socket drop, emit before commit) | 4 | 3 | 12 | Real-time tests (Ph 10), failure injection (Ph 9) |
| R7 | Tab split not atomic (known) | 4 | 3 | 12 | Failing test + fix (Ph 9) |
| R8 | Background jobs double-run with >1 API instance (known) | 4 | 3 | 12 | Job lock tests, design proposal (Ph 9, 16) |
| R9 | Aadhaar / PII exposure in logs, errors, exports | 5 | 2 | 10 | Log scrubbing tests, export tests (Ph 8, 14) |
| R10 | Brute force on login / OTP / PIN | 4 | 3 | 12 | Rate-limit + lockout tests (Ph 8) |
| R11 | SSRF / malicious uploads (bulk upload image URLs, file uploads) | 4 | 2 | 8 | Upload + SSRF tests (Ph 8) |
| R12 | CSV/Excel formula injection in exports and imports | 3 | 3 | 9 | Injection tests (Ph 8) |
| R13 | IST vs UTC day-boundary errors (reports, FY invoice numbers, happy hours) | 4 | 3 | 12 | TZ-parametrised unit tests (Ph 4), report-vs-SQL (Ph 5) |
| R14 | Inventory drift (deduction/restore mismatch, weighted-average errors) | 3 | 3 | 9 | Unit + reconciliation SQL (Ph 4, 7) |
| R15 | Delivery dispatch rules broken (overload, stuck "on a run") | 3 | 3 | 9 | Functional + concurrency (Ph 5, 9) |
| R16 | Performance collapse at lunch rush / heavy reports (N+1, missing indexes) | 4 | 3 | 12 | k6 + EXPLAIN (Ph 7, 13) |
| R17 | Migration failure on live data / long locks | 4 | 2 | 8 | Migration tests on seeded copy (Ph 7) |
| R18 | Demo credentials or debug routes present in production | 5 | 2 | 10 | Prod config checks (Ph 8, 16) |
| R19 | Mobile token stored insecurely | 4 | 2 | 8 | Mobile review (Ph 8, 12) |
| R20 | Backup unusable when needed | 5 | 2 | 10 | Restore drill (Ph 7, 16) |

The highest-scoring risks (R1–R3, then R5–R8, R10, R13, R16) receive testing effort first in every phase.

## 9. Defect management

### 9.1 Severity

| Sev | Definition | Examples | Fix SLA |
|---|---|---|---|
| **P0** | Data leak, money wrong, data loss, security breach | Cross-tenant read; wrong GST; lost order; auth bypass | Fix before any further phase |
| **P1** | Feature broken, no workaround | KOT not created; report crashes; can't save menu item | Fix within the phase |
| **P2** | UX problem or workaround exists | Confusing error; slow screen; misaligned layout that still works | Batch; ask before changing documented behaviour |
| **P3** | Cosmetic | Typos, spacing, colours | Batch |

Priority follows severity unless the product owner reorders.

### 9.2 Lifecycle

```
New → Triaged → In progress → Fixed (failing test now passes) → Verified (re-run + regression) → Closed
          ↘ Rejected (not a bug / by design, with reason)    ↘ Deferred (owner approval, logged in readiness report)
Verified → Reopened if regression fails
```

### 9.3 Rules

- IDs are `BUG-001` onward, in [`BUGS.csv`](BUGS.csv), with details per bug when needed in `docs/qa/bugs/BUG-xxx.md` (template: [`templates/BUG_REPORT_TEMPLATE.md`](templates/BUG_REPORT_TEMPLATE.md)).
- Every fix starts with a test that fails on the old code. The commit message references the bug ID.
- Changing a documented business rule needs product-owner approval first, as does any large refactor.

## 10. Tools

| Purpose | Tool | Status |
|---|---|---|
| Unit / integration / API | Vitest (+ Supertest) | Vitest present; Supertest to add |
| Property-based | fast-check | To add |
| Mutation | Stryker (vitest runner) | To add (shared) |
| Coverage | @vitest/coverage-v8 | To add |
| API collection / contract | Postman collection + Newman; OpenAPI generated from zod (`zod-to-openapi`) | To add (Ph 6) |
| E2E / visual / a11y | Playwright + @axe-core/playwright | Playwright to add as a dev dependency |
| Load | k6 | Install CLI (brew) in Ph 13 |
| DAST | OWASP ZAP baseline (Docker image) | Ph 8 |
| SAST / secrets / deps | semgrep, gitleaks, `npm audit`, license-checker | Ph 3 / 8 |
| Static | tsc strict, ESLint (typescript-eslint strict), madge, knip | Ph 3 |
| Mobile | tsc, Jest + RNTL (if feasible), Maestro (manual devices) | Ph 12 |
| CI | GitHub Actions (`.github/workflows/ci.yml`, to extend) | Exists (build/test/typecheck) |

## 11. Deliverables and reporting

- One report per phase: `docs/qa/phase-<n>-<name>.md` (what ran, results, defects, what couldn't be verified and why).
- Defect log [`BUGS.csv`](BUGS.csv). Requirements traceability matrix [`RTM.csv`](RTM.csv), summarised in [`RTM.md`](RTM.md).
- Templates in [`templates/`](templates/).
- The final deliverables are the manual pack (`manual/`), `PRODUCTION_READINESS.md` and the summary table.

## 12. Unverifiable items log (kept current in each phase report)

| Item | Why it can't be verified here | Substitute |
|---|---|---|
| Real UPI payment and Razorpay webhook timing | No real credentials (ground rule) | Signature/replay tests with a test secret; manual Payment checklist |
| Push delivery when the app is killed | Needs a real device + Expo push service | Payload/unit tests; manual real-device checklist |
| Bluetooth thermal printing, paper-out | Needs hardware | Text-layout unit tests; manual Hardware checklist |
| GPS accuracy indoors / geofence walk | Needs a device outdoors | Distance-maths unit tests; manual walk test |
| iOS build | No Apple developer account / macOS signing in CI | tsc + Android export; manual iOS checks |
| Legal confirmation of GST / DPDP readings | Needs CA / counsel | QA findings list for review |
