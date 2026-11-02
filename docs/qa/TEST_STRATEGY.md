# CANAVO — Test Strategy

| | |
|---|---|
| Document | `docs/qa/TEST_STRATEGY.md` |
| Version | 1.0 (Phase 1) — 2026-11-02 |
| Branch | `qa/full-testing` (from `main` @ `008952a`) |
| Owner | QA programme (Principal QA Architect / SDET) |
| Companion docs | [RTM.csv](RTM.csv) · [BUGS.csv](BUGS.csv) · [UNVERIFIABLE.md](UNVERIFIABLE.md) · [templates/](templates/) · phase reports `PHASE-NN.md` |

---

## 1. Purpose

CANAVO is a multi-tenant SaaS POS for Indian canteens, hotels and restaurants. One installation serves many businesses, handles money (integer paise, GST) and holds personal data (customer phones, staff Aadhaar). This strategy sets out how we show, with evidence, that the system:

1. **Never mixes tenants.** Business A can never read or change business B's data, and the Super Admin can never read any hotel's data.
2. **Never gets money wrong.** Every bill, tax line, payment, refund, khata and loyalty balance reconciles to the paise.
3. **Never loses or duplicates data**, including offline sync, concurrent writes, crashes and restore from backup.
4. **Does what the spec says** for each of the 7 roles × 10 modules.
5. **Is operable in production** with health checks, safe configuration, backups, monitoring and rollback.

The programme ends with a GO/NO-GO verdict in `PRODUCTION_READINESS.md`.

## 2. System under test (as-built, verified 2026-11-02)

| Component | Tech | Notes relevant to testing |
|---|---|---|
| `packages/shared` | TS, zod 3 | `computeBill` (gst.ts), invoice numbering, `rbac.ts` (7 roles × 32 permissions), `modules.ts` (10 modules + dependencies), receipt/ESC-POS formatter, all request schemas. Pure functions, so ideal for unit, property and mutation testing. |
| `apps/api` | Node ≥20 (CI 22), Express 5, Prisma 6.19, PostgreSQL 16, Socket.io 4, zod | **≈242 HTTP endpoints** across 20 routers. Tenant isolation comes from a Prisma extension (`db.ts`) that auto-filters **11 business-scoped models**. All other models (Order, Payment, KotTicket, Table*, Delivery, Reservation, Inventory stock/transactions, Purchase, Loyalty/Khata ledgers, CouponRedemption, Notification, …) rely on per-route `outletId` filters. In-process cron jobs (single instance only). |
| `apps/web` | Next.js 14.2 App Router, React 18, IndexedDB offline queue, PWA | 60+ routes. Before this programme it had no ESLint config and no tests. |
| `apps/mobile` | Expo SDK 51, RN 0.74, expo-router, SecureStore, SQLite offline queue, BT ESC/POS | **Not an npm workspace.** It has its own lockfile and uses `@canavo/shared` via `file:`. It has no tests. |
| Infra | Docker (API), Render blueprint (API + managed PG + disk), Vercel (web), EAS (mobile), GitHub Actions CI | Backups and uploads live on the Render persistent disk. |

Domain constants: money = integer paise; business timezone = `Asia/Kolkata`; invoice number ≤ 16 chars and financial-year based (`INV-2026-00234`); one offer per bill.

## 3. Scope

### 3.1 In scope

- All 10 modules: Billing, Kitchen (KOT), Tables, Delivery, Reservations/Pre-orders, Inventory, Customers/Loyalty/Khata, Offers/Coupons, Attendance/Leave, Reports. Also the always-on areas: Auth, Staff, Outlets, Settings/GST, Menu and bulk upload, Notifications, Admin (audit, backups, export, IP whitelist), Platform console.
- All 7 roles: SUPER_ADMIN, BUSINESS_OWNER, OUTLET_MANAGER, CASHIER, KITCHEN, INVENTORY_MANAGER, DELIVERY. Each is tested with every module on and off.
- API (REST + Socket.io), database (schema, migrations, integrity, backup/restore), web app, mobile app (logic and build; device behaviour as manual tests), background jobs, integrations through their **documented dev fallbacks**.
- Non-functional areas: security (OWASP API/Web Top 10, tenant isolation), performance/load/soak, resilience, accessibility, compatibility, compliance (GST, DPDP, Aadhaar handling), operability.

### 3.2 Out of scope (with reason)

| Item | Reason / substitute |
|---|---|
| Real MSG91, Razorpay, WATI, Cloudinary, SMTP, Expo/FCM/APNs calls | Ground rule 2: no real third-party credentials. We test against the dev fallbacks (devCode OTP, mock UPI QR + `/dev-simulate`, `wa.me` links, local uploads, outbox files) and verify webhook signatures with locally generated secrets. Real-gateway checks go into the manual PAYMENT checklist. |
| Production infrastructure (Render, Vercel, DNS/TLS certs, managed PG backups) | We have no access. We use a production-like Docker environment locally and write manual runbooks. |
| App Store / Play Store submission | Needs developer accounts. Covered by a manual checklist. |
| Legal sign-off on GST / DPDP / UIDAI | QA flags gaps against published rules. Legal and CA review stays with the business. |
| Load beyond the Phase 13 targets on a laptop | Results are relative. Absolute capacity needs a staging environment of production size. |
| Third-party library internals | Covered only through dependency audit (CVE/licence). |

## 4. Test levels

| Level | What | Where | Runner |
|---|---|---|---|
| L1 Static | tsc strict, ESLint (strict + security + promise rules), dead code / unused deps / circular deps, raw-SQL audit, route-guard audit, secrets scan, SAST | all workspaces | tsc, ESLint, knip, madge, depcheck, gitleaks, semgrep |
| L2 Unit | Pure logic: computeBill, offer engine, rbac, modules, invoice/FY, geo, weighted-average cost, delivery assignment, loyalty tiers, time/TZ helpers | `packages/shared`, `apps/api/src/services` | Vitest + fast-check + Stryker |
| L3 Integration (API + DB) | Each route against a real Postgres: validation, guards, tenant filters, transactions, side-effects (stock, ledger, audit, notifications, socket emits) | `apps/api/test/integration` | Vitest + Supertest, PG 16 in Docker, one DB per worker |
| L4 Contract | Response schemas vs OpenAPI generated from zod, error-format consistency | `docs/api`, `apps/api/test/contract` | Vitest, Newman (Postman collection) |
| L5 System / E2E | Role journeys through the real web UI against a real API + DB | `apps/web/e2e` | Playwright (Chromium, Firefox, WebKit) |
| L6 Non-functional | Load/stress/spike/soak, security DAST, accessibility, visual regression | `tests/k6`, ZAP, axe, Playwright snapshots | k6, OWASP ZAP, axe-core |
| L7 Acceptance | UAT per role, exploratory charters, real-device/hardware/payment checklists | `docs/qa/manual` | Humans, using the templates |

## 5. Test types and techniques

| Type | Technique(s) | Phase |
|---|---|---|
| Smoke | Critical path per role, < 15 min | 2 |
| Sanity | Post-deploy read-only checks + targeted manual checklist | 2 |
| Static analysis / code review | Lint rules, guard audit, raw-SQL audit, TZ/await/PII review | 3 |
| Unit | Equivalence partitioning, boundary values, decision tables (rbac × modules), property-based (fast-check), mutation (Stryker) | 4 |
| Functional | EP, BVA, decision tables, state transitions (order, KOT, delivery, reservation, leave, purchase, audit, transfer), error guessing | 5 |
| API | Status codes, schema contracts, validation fuzzing (types, unicode, oversized, injection), auth matrix, idempotency, pagination, HTTP semantics | 6 |
| Database | Constraints, tenant FK chains, EXPLAIN ANALYZE, migration up/forward-fix, reconciliation SQL, isolation, backup/restore | 7 |
| Security | Tenant/IDOR matrix, privilege escalation, OWASP API/Web Top 10, uploads, SSRF, webhooks, business-logic abuse, SAST/DAST/secrets/CVE | 8 |
| Concurrency & resilience | Parallel races, failure injection (DB kill, throw after insert, socket drop, restart), job double-run | 9 |
| Real-time | Socket auth, room scoping, reconnect/resync, fan-out of 200 KDS | 10 |
| UI E2E, cross-browser, visual, a11y | Playwright journeys, viewport matrix, network throttling, axe | 11 |
| Mobile | tsc, Jest/RNTL, offline queue logic, Maestro if feasible, device checks as manual | 12 |
| Performance | Load, stress, spike, 8 h soak, N+1 detection, Lighthouse, bundle size | 13 |
| Compliance | Hand-calculated GST oracles, GSTR-1 reconciliation, IST logic, DPDP review | 14 |
| Manual | 400+ manual cases, UAT, exploratory charters, device/payment/hardware/usability/compat/l10n/chaos | 15 |
| Regression | Tagged `@smoke` `@regression` `@critical`, CI on every PR | 16 |

## 6. Environments

| Env | Purpose | Composition | Data | Notes |
|---|---|---|---|---|
| **E1 Local dev** | Developer and QA authoring, unit, integration | Node 20/22 (local box has Node 26; CI uses 22), `docker compose` PG16 on :5433, API on :4100 (QA) / :4000 (dev), web :3000 | `canavo_qa` DB (seed + QA fixtures), `canavo_test_*` per-worker DBs, `canavo_shadow` for migration diff | QA never touches the developer's `canavo` DB. Env vars are set from the documented `.env.example` dev fallbacks; `.env` files are never read. |
| **E2 Staging-like (Docker)** | E2E, security DAST, load, resilience, backup/restore | `apps/api/Dockerfile` image (`NODE_ENV=production`), PG16 container, `next build && next start`, single-port gateway. Runs **twice: `TZ=UTC` and `TZ=America/New_York`** to flush timezone bugs. | Perf dataset: 50 hotels, ~1M orders (generated SQL); QA fixtures | Kill/restart containers for chaos tests; `tc`/toxiproxy for latency. |
| **E3 Production-like** | Release rehearsal, config validation, runbook drills | E2 plus: real `DATA_ENCRYPTION_KEY`, strong JWT secrets, `CORS_ORIGINS` locked, **no demo seed**, HTTPS via local reverse proxy, managed-PG-like settings (connection limit), 1 API instance | Production-shaped, synthetic only (no real customer data) | Used for the Phase 16 GO/NO-GO checks. |
| **CI** | Every PR | GitHub Actions: PG16 service, Node 22 | Ephemeral | Expanded in Phase 16 (lint, integration, Playwright, security scans, k6 smoke). |
| **Devices** | Manual | Android 10–14 (2 GB / mid / high), iOS ×2, tablet, thermal printers 58/80 mm, KDS wall display | Staging | See `manual/REAL_DEVICE_CHECKLIST`. |

## 7. Test data strategy

### 7.1 Principles

- **Synthetic only.** No production data in any test environment. If a production snapshot is ever needed, it must first be masked (phones, names, Aadhaar, GSTIN).
- **Build through the API (fixture factory)** wherever possible, so data passes the same validation and side-effects as real use. Direct SQL is used only for bulk perf data and for deliberately corrupt rows in negative DB tests.
- **Deterministic and isolated.** Each integration worker gets its own database, and each test builds the data it asserts on. Shared seed data is read-only for tests.
- **Idempotent.** Re-running seed or fixtures must not duplicate data (seed idempotency already verified in Phase 2).
- **Demo credentials (`*@canavo.local` / `Canavo@123`) must never exist in production.** Phase 8 and 16 verify this.

### 7.2 Tenants (QA fixture set, built in Phase 5)

| Tenant | Profile | Outlets | Modules | GST set-up | Purpose |
|---|---|---|---|---|---|
| **T0 Demo Hotel** | Existing seed (`biz_demo`) | as seeded | all | registered | Smoke, reports vs 30-day history (1,747 orders) |
| **T1 "Chai Kadai"** | Small no-GST shop | 1 | BILLING, KOT only | **GST off** (plain bill, menu price, no GSTIN) | GST-off bills, module-off refusals, offline billing, minimal-staff role chain |
| **T2 "Saravana Bhavan Test"** | GST-registered restaurant | 2 (Chennai TN; Bengaluru KA for IGST/inter-state cases) | all 10 | Regular: 0/5/12/18/28 % rates, cess, named extra tax (VAT), prices incl. and excl. tax per outlet | Full functional matrix, every role, offers, delivery, inventory, tables |
| **T3 "Campus Canteens"** | Composition dealer, multi-outlet | 3 | BILLING, KOT, INVENTORY, DELIVERY, ATTENDANCE, REPORTS | **Composition** (Bill of Supply, no tax collected) | Bill of Supply wording, inter-outlet transfers, multi-outlet reports, cross-outlet isolation |
| **T4 "Suspended Co."** | Suspended business | 1 | all | n/a | Suspended-hotel login and token refusal |

**Users:** every tenant gets one user per role it supports, plus extra users for edge cases: two cashiers (concurrency), two delivery partners (dispatch limit), a manager assigned to only one of T2's outlets (cross-outlet IDOR), a locked user, a user with an old `tokenVersion`, and staff with and without Aadhaar.

### 7.3 Edge-case menu (per tenant)

- Names in Tamil (`மசாலா தோசை`), Hindi (`पनीर टिक्का`), emoji (`🍵 Masala Chai`), 100-char names, names starting `= + - @` (CSV-injection probe), names containing `<script>` (XSS probe).
- Prices: ₹0.00, ₹0.01 (1 paise), ₹0.50 (rounding boundary), ₹99,999.99, plus an item at a max-qty (999) line to drive huge totals.
- Structure: items with 0, 1 and 10 sizes; 0 and 20 add-ons; outlet price override; outlet unavailable override; time-slot items (breakfast 07:00–11:00 IST); sub-categories 2 levels deep; mixed-rate cart (0 + 5 + 18 + 28 %+cess in one bill).
- Recipes: items with a multi-ingredient recipe, a size-override recipe, an ingredient with low stock (to drive negative stock), and different units (g, kg, ml, l, pcs).
- Offers: one of each OfferType (COMBO, HAPPY_HOUR, BUY_X_GET_Y, ITEM_DISCOUNT, BILL_DISCOUNT) and coupon type (FLAT, PERCENT). Equal-saving pairs drive the tie-break rules, plus expired offers, offers at their usage limit, and happy hours straddling midnight IST.

### 7.4 Volume data (Phase 13)

50 hotels, 1–5 outlets each, ~1,000,000 orders over 13 months (crossing a 31 Mar → 1 Apr FY boundary), a realistic hour-of-day distribution (lunch and dinner peaks), 5 % cancellations, a mix of payment modes and a delivery share. Generated by a committed SQL/TS generator, never by hand.

## 8. Entry and exit criteria

### 8.1 Entry criteria (per phase / per test cycle)

| # | Criterion |
|---|---|
| EN-1 | Build is green on the branch under test: `npm ci`, shared build, typecheck, unit tests. |
| EN-2 | Smoke suite passes on the target environment (`npm run test:smoke`). |
| EN-3 | Migrations apply cleanly to an empty DB with no schema drift (`prisma migrate diff` exit 0). |
| EN-4 | Test data for the phase is available and reproducible (seed + fixtures). |
| EN-5 | Previous phase report is written and committed, and the user has said "continue". |

### 8.2 Exit criteria (release — evaluated in Phase 16)

| # | Criterion | Target |
|---|---|---|
| EX-1 | Open P0 defects | **0** |
| EX-2 | Open P1 defects | **0** (or explicitly waived by the product owner in writing) |
| EX-3 | Unit coverage | `packages/shared` ≈ 100 % branches; services ≥ 85 % lines/branches |
| EX-4 | Mutation score (shared) | ≥ 80 %, with every surviving mutant justified |
| EX-5 | Tenant-isolation matrix | 100 % of routes × roles × cross-tenant/cross-outlet IDs pass |
| EX-6 | RTM | Every requirement has ≥ 1 executed test; 100 % of P0/P1-risk requirements pass |
| EX-7 | Critical manual cases | 100 % executed, 100 % passed (or failure has a waived bug) |
| EX-8 | Performance | p95 bill create < 500 ms; menu load < 300 ms; 1-year report < 3 s; error rate < 0.1 % at target load; no leak over 8 h soak |
| EX-9 | Security | No open High/Critical (CVSS ≥ 7) finding; runtime dependencies have no reachable critical/high CVE |
| EX-10 | Reconciliation SQL | All reconciliation queries return zero discrepancies on seed, perf and restored-backup data |
| EX-11 | Ops | /health and /ready, graceful shutdown, backup/restore drill evidence, rollback runbook rehearsed |

### 8.3 Suspension / resumption

Testing in an area is suspended if the smoke suite fails, a P0 blocks the main flow, or the environment is unstable (> 2 infrastructure failures per hour). It resumes when the blocker is fixed and smoke is green again.

## 9. Risk register

Scored as Impact (1–5) × Likelihood (1–5). Likelihood comes from what was **observed in the code on 2026-11-02**, not assumed. The register is re-scored at the end of every phase.

| ID | Risk | I | L | Score | Evidence / reasoning | Mitigation (tests) | Phase |
|---|---|---|---|---|---|---|---|
| R-01 | **Cross-tenant / cross-outlet read or write** on models that are not auto-scoped (Order, Payment, KotTicket, DiningTable, TableSession, Reservation, Delivery, InventoryStock/Transaction, Purchase, StockAudit/Transfer, Loyalty/Khata txns, CouponRedemption, Notification, Setting…) | 5 | 3 | **15** | `db.ts` auto-filters only 11 models; everything else depends on each of ~242 handlers remembering `outletId`. | Full route × role × foreign-ID matrix; static guard audit | 3, 8 |
| R-02 | **Foreign IDs smuggled into writes**: e.g. an order line pointing at business B's menuItemId/variantId/addonId, a transfer to another business's outlet, a recipe using B's ingredient, a coupon from B | 5 | 3 | **15** | Nested `connect`/raw IDs in bodies are not covered by the extension's `where` injection. | Cross-tenant FK SQL checks; API negative tests | 7, 8 |
| R-03 | **Payment race / overpayment**: balance check runs *before* the transaction | 5 | 3 | **15** | `orders.ts` `/payments` reads the balance outside `$transaction`. | Parallel payment tests | 9 |
| R-04 | **Tab split not atomic** (known) → partial bills, double-billed items | 4 | 4 | **16** | README "Known limitations". | Failing test, then fix | 9 |
| R-05 | Coupon / loyalty / khata over-redemption under concurrency | 4 | 3 | **12** | Usage limits and balances checked in app code. | Race tests; reconciliation SQL | 9 |
| R-06 | **Money computation error** (GST split, cess, composition, round-off, discount ordering, extra charges) | 5 | 2 | **10** | 28 existing unit tests; no property/mutation tests. | BVA, property-based, mutation, hand oracles | 4, 14 |
| R-07 | Invoice number gaps/duplicates across concurrency and FY rollover | 4 | 3 | **12** | InvoiceCounter table; FY in IST. | Concurrent create; 31 Mar 23:59 → 1 Apr 00:00 IST tests | 4, 9 |
| R-08 | **Timezone misuse** (server TZ ≠ IST) in business day, reports, FY, happy hours, shifts | 4 | 3 | **12** | Many `new Date()` uses; helpers exist in `lib/time.ts`. | Run suites under `TZ=UTC` and `TZ=America/New_York` | 3, 4, 14 |
| R-09 | Access token still valid after logout / password reset (≤ 15 min) | 3 | 5 | **15** | **Observed** (BUG-003): `/auth/me` returns 200 with the access token after `/auth/logout`. | Phase 8 design decision | 8 |
| R-10 | Super Admin reaching hotel data (X-Business-Id / X-Outlet-Id, platform endpoints, audit log, backup download) | 5 | 2 | **10** | Guards exist; smoke SMK-020 passes on `/orders`. | Full SA matrix | 8 |
| R-11 | Socket.io room scoping: joining another outlet/business room | 5 | 2 | **10** | 38-line `realtime.ts`, to be reviewed. | Socket auth/room tests | 10 |
| R-12 | Upload abuse: SVG/polyglot, path traversal, SSRF via bulk-upload image URL, zip/xlsx bombs | 4 | 3 | **12** | multer + exceljs; local storage fallback served by API. | Upload test pack | 8 |
| R-13 | Brute force on OTP / staff PIN / clock-in PIN | 4 | 3 | **12** | IP limiter only on `/login` and `/otp` (50 per 15 min); account lockout after 5. | Brute-force tests per factor | 8 |
| R-14 | **Vulnerable dependencies**: root 3 critical / 11 high (next, body-parser, multer, zod at runtime); mobile 1 critical / 24 high | 4 | 3 | **12** | `npm audit` 2026-11-02. | Reachability triage, upgrades | 3, 8 |
| R-15 | PII leakage (Aadhaar, phone) in logs, errors, exports, emails | 5 | 2 | **10** | AES-GCM implemented; morgan logs URLs (query strings may hold phones). | Log scraping, export inspection | 8, 14 |
| R-16 | Demo users / weak secrets in production | 5 | 2 | **10** | Seed creates `Canavo@123` users; Render generates JWT secrets. | Prod-config checks | 8, 16 |
| R-17 | Background jobs run twice if > 1 API instance (known) | 4 | 3 | **12** | README: run a single instance. | Two-instance test | 9, 16 |
| R-18 | KDS misses or shows stale KOTs (socket drop, sleep) | 4 | 3 | **12** | 15 s resync implemented. | Reconnect/resync tests | 10, 11 |
| R-19 | Reports disagree with raw data (cancellations, refunds, partial payments, IST day boundary) | 4 | 3 | **12** | `reports.ts` is 1,416 lines with no tests beyond export formatting. | Report vs SQL oracles | 5, 7 |
| R-20 | Performance at scale: reports and lists on 1M orders, missing composite indexes | 4 | 3 | **12** | Indexes not yet reviewed. | EXPLAIN ANALYZE, k6 | 7, 13 |
| R-21 | Offline sync duplicates or loses bills (web IndexedDB, mobile SQLite) | 5 | 2 | **10** | `clientOrderId` idempotency verified once in smoke (SMK-031). | Replay, partial-failure, cross-device tests | 5, 9, 12 |
| R-22 | Inventory drift: recipe deduction / restore on cancel / weighted-average cost / Float quantities | 3 | 3 | **9** | Quantities and rates are `Float` in the schema. | Unit + reconciliation SQL | 4, 7 |
| R-23 | Delivery dispatch limit / on-a-run lock bypass under concurrency | 3 | 3 | **9** | Checked in app code. | Race tests | 9 |
| R-24 | Backups not restorable (local disk on Render; untested restore) | 5 | 2 | **10** | `backup.ts` custom implementation. | Backup/restore drill | 7, 16 |
| R-25 | GST compliance gaps: GSTR-1 lacks B2B/B2CL/credit notes; coupon GST treatment; e-invoice threshold | 3 | 4 | **12** | README "Known limitations". | Compliance review, design proposals | 14, 16 |
| R-26 | DPDP Act gaps (consent, deletion/export of customer data, retention) | 4 | 3 | **12** | No consent capture seen yet. | Privacy review | 14 |
| R-27 | **Build/tooling hygiene**: no lint on api/shared/mobile, test files excluded from `tsc`, mobile outside workspaces, a build artifact committed | 2 | 5 | **10** | **Observed** in Phase 2 (BUG-001/002). | Phase 3 static analysis | 2, 3 |
| R-28 | Mobile token storage / deep-link hijack | 4 | 2 | **8** | SecureStore is a dependency; usage not yet verified. | Code review + device tests | 8, 12 |
| R-29 | Webhook replay / forged Razorpay callbacks | 4 | 2 | **8** | Raw-body signature verification present. | Signature/replay tests | 8 |

Top five by score: **R-04, R-01, R-02, R-03, R-09**.

## 10. Defect management

### 10.1 Severity (impact) — as agreed

| Sev | Definition | Examples |
|---|---|---|
| **P0** | Data leak, wrong money, data loss, security breach | Cross-tenant read; GST wrong; paid bill lost on sync; auth bypass |
| **P1** | Feature broken, no reasonable workaround | Cannot split payment; KOT never reaches kitchen; report 500s |
| **P2** | UX / degraded behaviour, workaround exists; build/tooling defects | Confusing error; test suite not hermetic; slow but working |
| **P3** | Cosmetic | Alignment, typo, colour |

### 10.2 Lifecycle

```
New ──► Triaged ──► In Progress ──► Fixed ──► Verified ──► Closed
  │        │             ▲             │
  │        ├─► Deferred ──┘ (needs product approval / design change)
  │        └─► Rejected (not a bug / duplicate / works as specified)
  └──────────────────────────────── Reopened ◄── (verification fails)
```

Rules:
1. **Every fix starts with a failing automated test** that reproduces the defect. The bug record links the test ID. The fix is verified by the same test going green, with the evidence captured in the phase report.
2. A change to a **documented business rule** (README / spec) or a **large refactor** goes to *Deferred – awaiting approval* until the product owner (the user) approves.
3. P0/P1 fixes are implemented after approval where the spec requires it (Phase 16 rules). P2 design items get a proposal first.
4. The defect log is `docs/qa/BUGS.csv` (one row per bug, ID `BUG-NNN`, never reused). The template is `templates/BUG_REPORT_TEMPLATE.md`.

## 11. Tooling

| Need | Tool | Status / notes |
|---|---|---|
| Unit / integration runner | **Vitest 3** | Present in shared and api. Separate configs: unit (`vitest.config.ts`), smoke (`vitest.smoke.config.ts`), integration (Phase 5). |
| HTTP API tests | **Supertest** (in-process app) + `fetch` for black-box smoke | Supertest added in Phase 5/6. |
| Property-based | **fast-check** | Phase 4 |
| Mutation | **Stryker** (vitest runner) | Phase 4, on `packages/shared` |
| Coverage | `@vitest/coverage-v8` | Phase 4 |
| API contract / collection | zod → OpenAPI (`zod-to-openapi`), **Postman/Newman** | Phase 6, in `docs/api` |
| E2E / visual / a11y | **Playwright** + `@axe-core/playwright` | Phase 11 |
| Mobile | `tsc`, **Jest + React Native Testing Library**; Maestro if feasible | Phase 12 |
| Load | **k6** | Phase 13 |
| DAST | **OWASP ZAP** baseline (Docker) | Phase 8 |
| SAST | **semgrep** (Docker), ESLint security plugins | Phase 3/8 |
| Secrets | **gitleaks** (Docker) | Phase 3/8 |
| Dependencies | `npm audit`, `osv-scanner`, `license-checker` (Snyk-style without an account) | Phase 3 |
| Static structure | `knip` (dead code / unused deps), `madge` (circular deps) | Phase 3 |
| DB | `psql`, `EXPLAIN (ANALYZE, BUFFERS)`, `pg_dump`/`pg_restore`, Prisma query logging (N+1) | Phase 7, 13 |
| Manual pack | Markdown + CSV/XLSX (generated) | Phase 15 |

## 12. Requirements Traceability Matrix (RTM)

**Source of truth:** [`docs/qa/RTM.csv`](RTM.csv). It is a CSV so it can be filtered in a spreadsheet and diffed in git.

| Column | Meaning |
|---|---|
| `Req ID` | `<AREA>-NNN`, stable, never reused |
| `Module` | Business module / area |
| `Requirement / business rule` | Atomic, testable statement taken from README + programme brief |
| `Source` | README section or brief section |
| `Risk` | Linked risk-register ID(s) |
| `Level` | Unit / API / DB / E2E / Manual / Perf / Sec |
| `Test case IDs` | Automated IDs (e.g. `SMK-030`, `UT-GST-012`) and manual IDs (`MTC-BIL-005`) |
| `Mode` | Automated / Manual / Both |
| `Status` | Not started / Planned / In progress / Pass / Fail / Blocked / N/A |
| `Notes` | Bug IDs, gaps |

Area codes: AUTH, PLAT, TEN, RBAC, MOD, OUT, STF, MENU, IMP, BIL, GST, OFF, KOT, TAB, RES, DEL, INV, CRM, ATT, REP, NTF, ADM, OFL, RT, SEC, PRV, NFR, OPS.

The skeleton holds **every rule found in the README and the programme brief** (200 rows at v1.0). Each phase fills in test IDs and status. Coverage is reported per phase as *requirements with ≥ 1 passing test ÷ total*.

## 13. Test case ID conventions

| Prefix | Suite |
|---|---|
| `SMK-NNN` | Smoke (automated) |
| `SAN-NNN` | Sanity checklist (post-deploy) |
| `UT-<AREA>-NNN` | Unit |
| `PBT-<AREA>-NNN` | Property-based |
| `IT-<AREA>-NNN` | API/integration |
| `DB-NNN` | Database |
| `SEC-NNN` / `ISO-NNN` | Security / isolation matrix |
| `CON-NNN` | Concurrency / resilience |
| `RT-NNN` | Real-time |
| `E2E-NNN` | Playwright |
| `MOB-NNN` | Mobile automated |
| `PERF-NNN` | k6 |
| `MTC-<AREA>-NNN` | Manual test case |
| `UAT-<ROLE>-NN` | UAT script step |

Automated tests carry tags in their titles: `@smoke`, `@regression`, `@critical`.

## 14. Deliverables and reporting

- After every phase: `docs/qa/PHASE-NN.md` (what ran, results, evidence, defects, RTM delta, what could not be verified), a commit on `qa/full-testing`, then **stop and wait for "continue"**.
- Living documents: `RTM.csv`, `BUGS.csv`, `UNVERIFIABLE.md`, this strategy (risk register re-scored).
- Final: `PRODUCTION_READINESS.md` with the GO/NO-GO verdict and the summary table (Test type | Cases written | Automated | Manual | Executed | Passed | Failed | Bugs found | Fixed | Open).

## 15. Assumptions and constraints

1. The README is the functional specification. Where code and README disagree, the README is treated as intended behaviour and the mismatch is logged as a defect, unless the user decides otherwise.
2. Test machine: macOS (Darwin 25.6), Node 26.10 locally. CI pins Node 22 and `engines` says ≥ 20, so Phase 16 adds an engines/CI matrix check on Node 20 and 22.
3. QA uses only the `canavo_qa`, `canavo_test_*` and `canavo_shadow` databases. The developer `canavo` DB and all `.env` files are never read or modified.
4. Time-sensitive tests use injected clocks (fake timers) or explicit IST timestamps. They never depend on the wall clock of the run.
