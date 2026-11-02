# Phase 3 — Static analysis & code review: report

| | |
|---|---|
| Date | 2026-11-02 |
| Branch | `qa/full-testing` |
| Status | ✅ Complete. **12 defects found** (2 × P0, 6 × P1, 3 × P2, 1 × P3): **11 fixed and verified** with failing-first tests, **1 deferred** for a design decision (BUG-013). 4 decisions are needed from you (§6). |

## 1. Summary

| Check | Tool / method | Result |
|---|---|---|
| Route guard audit (every endpoint) | New **route inventory** that walks the live Express router stack (not a regex): `apps/api/test/static/route-inventory.ts` | **254 endpoints.** 10 public (all reviewed, justified). 216 have a permission or platform guard. 28 rely on handler-level checks (all reviewed by hand). Now enforced by `route-guards.test.ts`: a new unguarded route fails CI. Full table in [ROUTE_GUARDS.md](ROUTE_GUARDS.md). |
| Tenant / IDOR code review | Manual review + 2 parallel read-only review sub-agents covering all 20 routers and their services; every claim was re-verified and reproduced by me before logging | **2 cross-business reads (P0)**, 2 foreign-ID links, 3 cross-outlet / approval-chain defects |
| Raw SQL audit | All 4 `$queryRaw` / `$executeRaw*` sites | ✅ No injection. All are tagged templates or use DMMF identifiers. Tenant context is sound (see §4.1). |
| ESLint strict (type-aware) | `typescript-eslint` 8 `strict-type-checked` + `eslint-plugin-regexp` | One-off measurement: api 765 errors / 53 warnings, shared 18 errors, mostly style (`!` assertions 366, template typing 166). The **correctness** rules found BUG-006, BUG-014 and BUG-016. A committed gate is now in place (§5). |
| tsc stricter flags | One-off per flag | §4.6. `noFallthroughCasesInSwitch` and `noImplicitOverride` are now **on** (0 errors). Test files are now typechecked (were excluded). |
| ReDoS | `regexp/no-super-linear-backtracking` + timing | **BUG-006** (user-reachable, 63 s per 200 k-char cell). One non-reachable instance in gstr1 also replaced with a linear scan. |
| Unhandled promise rejections / missing await | `no-floating-promises`, `no-misused-promises`, a new static guard | **BUG-014**: 4 fire-and-forget calls could crash the process. |
| PII / secrets in logs | grep + review | **BUG-015** (OTP in prod logs when SMS is misconfigured), plus 2 P3 items |
| Timezone misuse | grep for server-local date APIs + unit suites under 4 server TZs | Business-day logic consistently uses outlet-TZ helpers. Unit suites pass identically under UTC, New York, Kiritimati (UTC+14) and Kolkata. 2 × P3. |
| Hardcoded secrets | **gitleaks** 8.28 over full git history | 2 hits, both benign test fixtures |
| Circular deps | **madge** 8 | shared 0, web 0, mobile 0. api 5 (low, §4.6) |
| Dead code / unused deps | **knip** 5 | 0 unused runtime deps. 58 unused exports + 45 types (P3; mostly test seams) |
| Dependency audit | `npm audit` + reachability triage | §4.4. Patched body-parser and multer. Disabled the unused Next image optimizer. **Next 14 → 15.5+ upgrade needs approval.** |
| Licences | Lockfile licence fields (license-checker crashes on this npm/Node) | Production deps are permissive, except `react-leaflet` (**Hippocratic-2.1**, needs legal review). MPL-2.0 is build-time only (mobile). |
| Lockfile integrity | **lockfile-lint** (https, npm registry, integrity) | ✅ root and mobile both clean |

**Regression status after the fixes:** unit + static **132/132** (shared 28, api 104), integration **18/18** (new), smoke **24/24**, `npm run lint` 3/3 tasks with 0 errors, `npm run typecheck` 5/5, `npm run build` 3/3.

## 2. Defects (failing test first → fix → green)

| ID | Sev | Module | Defect | Test(s) | Status |
|---|---|---|---|---|---|
| **BUG-005** | **P0** | Attendance | `GET /attendance/calendar?userId=` returned **any business's** staff attendance and leave reasons | ISO-ATT-001..005 | ✅ Verified |
| **BUG-007** | **P0** | Inventory | `GET /inventory/recipes` returned **every business's** recipes with ingredient cost (`where: {}` on an unscoped model) | ISO-INV-001/002 | ✅ Verified |
| BUG-006 | P1 | Menu import | **ReDoS**: the Sizes/Ingredients parser is O(n²). One 5 MB upload freezes the API for all tenants (200 k chars = **63 s**) | SEC-IMP-001, PBT-IMP-001 | ✅ Verified |
| BUG-008 | P1 | Menu | Items/categories accepted another business's `categoryId` / `parentId` | ISO-MENU-001..004 | ✅ Verified |
| BUG-009 | P1 | Staff | Staff accepted another outlet's or business's `shiftId` | ISO-STF-001..003 | ✅ Verified |
| BUG-010 | P1 | Attendance | Manual attendance at outlet A **overwrote** the clock-in at outlet B (payroll) | CON-ATT-001 | ✅ Verified |
| BUG-013 | P1 | Real-time | Socket outlet room sends **every event to every role**. A delivery partner receives other customers' phone and address. | probe §3.3 | ⏸ **Deferred, needs approval** |
| BUG-014 | P1 | API platform | 4 `void promise` calls without `.catch` → an unhandled rejection **terminates the API** | SA-ASYNC-001/002 | ✅ Verified |
| BUG-011 | P2 | Attendance | A manager could approve a **peer manager's** leave | CON-LV-001/002 | ✅ Verified |
| BUG-012 | P2 | Staff | A manager editing staff outlets silently removed outlets they don't manage | CON-STF-001 | ✅ Verified |
| BUG-015 | P2 | Auth | OTP + phone written to **production** logs when SMS isn't configured | SEC-LOG-001/002 | ✅ Verified |
| BUG-016 | P3 | Menu import | Excel error cells imported as the text `[object Object]` | UT-IMP-002 | ✅ Verified |

## 3. Evidence

### 3.1 Tenant / outlet isolation (BUG-005, 007–012)

New **integration harness** (`npm run test:integration -w @canavo/api`): Supertest against the in-process app on a real PostgreSQL DB `canavo_it`. It runs `migrate deploy` and the idempotent seed once per run, and a **fixture factory** creates fully separate tenants with one user per role. Setup refuses any database not named `*_it` / `*_test`.

> `prisma migrate reset` is blocked by Prisma when an AI agent runs it, unless you explicitly consent. I did **not** bypass that guard. The harness doesn't need resets: every test creates uniquely named tenants, so reruns don't collide, and CI starts from an empty service DB.

Before the fixes (excerpt):
```
× ISO-ATT-001 a manager of another business gets 403/404 and no records
  → expected '{"month":"2026-10","userId":"cmvzdvdr…' not to contain 'VICTIM-SECRET'
× ISO-INV-001 GET /inventory/recipes never returns another business's recipes
  → expected '[{"id":"cmvzdv5nj005tye1ukt2gzlcq","m…' not to contain 'VICTIM-SECRET-BATTER'
× ISO-MENU-002 PATCH /menu/items/:id with a foreign categoryId is rejected  → expected [ 400, 404 ] to include 200
× ISO-STF-001 PATCH /staff/:id with a foreign shiftId is rejected          → expected [ 400, 404 ] to include 200
× CON-ATT-001 marking ABSENT at outlet 1 does not overwrite the clock-in at outlet 2 → expected 'ABSENT' to be 'PRESENT'
× CON-LV-001 a manager cannot approve a peer manager's leave               → expected 200 to be 403
× CON-STF-001 … keeps the outlet 2 assignment                              → expected [ 'cmvz…' ] to deeply equal [ 'cmvz…', …(1) ]
```
After: `Tests 18 passed (18)`, with the positive controls (own manager, own staff, own shift, own category) still green.

**Root cause, shared by all of these:** `db.ts` auto-scopes only 11 models and only in `where` / `data.businessId`. A foreign key written into `data` (categoryId, parentId, shiftId), or any read on an unscoped model (Recipe, StaffAttendance, LeaveRequest), relies on the handler. **Recommendation (needs approval, §6):** extend the extension so it scopes the unscoped models through their parent relation, instead of patching handler by handler.

### 3.2 ReDoS (BUG-006)

```
regex on "a" + N spaces + "=":   1k 2 ms · 2k 8 ms · 4k 26 ms · 8k 101 ms · 32k 1,687 ms · 64k 6,768 ms
× SEC-IMP-001 is linear-time on a hostile 200k-character cell  → expected 63342.85 to be less than 200
✓ after the fix: 3 passed, incl. PBT-IMP-001 (5,000 random inputs identical to the old regex)
```

### 3.3 Socket broadcast to all roles (BUG-013, not fixed)

The probe (`socket.io-client`, QA API :4100) connects as `delivery@canavo.local`, then the cashier creates a COD delivery order that is **not** assigned to that partner:
```
delivery socket connected: true
events received by DELIVERY partner:
   kot:new 513 bytes
   order:created 67 bytes
   order:paid 67 bytes
   delivery:updated 713 bytes <contains customer phone> <contains address>
```
`realtime.ts` puts every user assigned to the outlet into `outlet:<id>`, and 55 `emitToOutlet` calls broadcast there. **Proposed design:** permission-scoped rooms (e.g. `outlet:<id>:pos`, `:kitchen`, `:delivery-mgmt`, `:inventory`), joined from the user's effective permissions at handshake. Partners get delivery events only for their own orders via `emitToUser`. This touches about 55 emit sites, so **I'm asking before implementing.** The handshake also skips the `status`/business-suspended checks. That is defense in depth only: deactivation and suspension already bump `tokenVersion`, which the socket checks.

### 3.4 Crash on unhandled rejection (BUG-014)

```
× SA-ASYNC-002 every `void <call>` is caught or is a safe alert helper
  + "jobs-service.ts:67 void notify(…)"   + "jobs-service.ts:90 void notify(…)"
  + "routes/delivery.ts:768 void cashBalance(…)"   + "routes/public.ts:79 void runForOutlet(…)"
```
Fix: `.catch` at each site, plus a process-level `unhandledRejection` logger as a backstop. The guard test stays in the suite.

### 3.5 OTP in production logs (BUG-015)

`× SEC-LOG-001 … → expected '[sms:dev] OTP for 9876543210: 482913' not to contain '482913'` → fixed; production now logs only a configuration error.

### 3.6 Excel error cells (BUG-016)

Found by `@typescript-eslint/no-base-to-string`. `{ error: "#N/A" }` and `{ formula, result: { error } }` fell through to `String(obj)`.

## 4. Findings not (yet) fixed — with severity

### 4.1 Raw SQL audit (all 4 sites)

| Site | Injection | Tenant | Verdict |
|---|---|---|---|
| `customers.ts:198` visit heatmap `$queryRaw` | Tagged template, all values bound | `customerId` comes from a tenant-scoped customer lookup | ✅ |
| `backup.ts:100` `_prisma_migrations` | No input | Platform-level by design | ✅ |
| `backup.ts:244` `$executeRawUnsafe TRUNCATE` | Identifiers come from Prisma DMMF (not user input) | Whole-DB restore, Super Admin only | ✅ (by design; restore drill in Phase 7) |
| `promotions.ts:341` atomic coupon `usedCount` | Tagged template | `couponId` comes from a scoped coupon lookup; the conditional UPDATE is race-safe | ✅ (concurrency proof in Phase 9) |

### 4.2 Security / privacy findings

| ID | Sev | Finding | Where | Plan |
|---|---|---|---|---|
| SA-PLAT-01 | **P1 (design)** | Super Admin can **take over an owner account**: reset-password and create-owner let the Super Admin **choose** the password, then log in as the owner and see everything. This conflicts with "Super Admin can't open any hotel". It is only audited. | `platform.ts:151-181` | Needs your decision (§6): a one-time reset link/OTP sent to the owner, plus a notification to the owner |
| SA-CFG-01 | P2 | `publicApiUrl()` trusts a client `X-Forwarded-Host`, so a host header can be injected into WhatsApp receipt and image links | `lib/http.ts:52` | Phase 8: trust only via `trust proxy`, or use an allow-list |
| SA-CFG-02 | P3 | Swagger UI `/docs` and `/openapi.json` are public in production | `app.ts:39-40` | Phase 16 config |
| SA-CFG-03 | P3 | P2002 handler returns `err.meta` (constraint/field names) | `lib/http.ts:35` | Phase 6 error-format work |
| SA-CFG-04 | P3 | API Docker image runs as root and ships the dev deps | `apps/api/Dockerfile` | Phase 16 |
| SA-LOG-01 | P3 | CRM job logs customer phone + coupon link every day | `jobs-crm.ts:147` | Phase 8 PII-in-logs |
| SA-LOG-02 | P3 | `morgan combined` logs full URLs, incl. `?phone=` lookups and `search=` | `app.ts:36` | Phase 8: redact query strings |
| SA-NTF-01 | P3 | `POST /notifications/devices` re-assigns an existing Expo token to the caller (push redirect if the token is known) | `notifications.ts:67` | Phase 8 |
| SA-RT-01 | P3 | Socket handshake doesn't check user/business status (covered by `tokenVersion`) | `realtime.ts:16` | With BUG-013 |
| SA-INV-02 | P3 | Dead `SUPER_ADMIN` branch in transfer access checks (0 such users exist) would bypass outlet checks if one ever existed | `inventory.ts:112,922` | Remove in Phase 8 |
| SA-DEL-01 | P3 | Partner activity/timeline attendance isn't outlet-filtered (shows clock-ins at other outlets) | `delivery.ts:507,591` | Phase 8 |
| SA-INV-01 / SA-CRM-01 | ? | Inventory item shows stock at **all** outlets; coupon/customer detail show redemptions and orders from **all** outlets of the business | `inventory.ts:171`, `offers.ts:205`, `customers.ts:173` | **Question for you (§6):** business-wide by design? |

### 4.3 Correctness / hygiene

| ID | Sev | Finding |
|---|---|---|
| SA-TZ-01 | P3 | Partner-cash alert dedupes on the **UTC** date (`alerts.ts:104`), so the "once a day" window rolls over at 05:30 IST |
| SA-TZ-02 | P3 | Loyalty expiry cutoff uses server-local `setMonth` (`jobs-crm.ts:161`), so it can be off by hours near month ends |
| SA-WEB-01 | P3 | `Scanner.tsx:146` cleanup reads `videoRef.current` late, so the camera may stay on after the scanner closes (verify in Phase 11) |
| SA-DOC-01 | P3 | README "Delivery agents can't record payments" contradicts `/delivery/:id/collect` and `/upi-qr`, which let assigned partners record payments |
| SA-DEAD-01 | P3 | 58 unused exports, 45 unused exported types (knip). `scripts/gateway.mjs` is gitignored yet referenced by the README |
| SA-CIRC-01 | P3 | api circular imports: `openapi.ts ↔ openapi-*.ts` (4) and `db.ts ↔ lib/tenant.ts` (runtime-safe through a lazy `import()`) |
| SA-LINT-01 | P3 | 22 remaining lint warnings (unused vars/imports, capture groups); web has 3 `exhaustive-deps` warnings |

### 4.4 Dependencies

| ID | Sev | Package | Status |
|---|---|---|---|
| SA-DEP-01 | **P1** | `next@14.2.35` (EOL line): 25 advisories, including unauthenticated **RCE via the Image Optimization API (SVG/AVIF)**, SSRF, cache poisoning and RSC DoS. Fixed only in ≥ 15.5.24/15.5.28. | **Mitigated:** the app uses no `next/image`, Server Actions, middleware or rewrites. I disabled the optimizer (`images.unoptimized`), and `/_next/image` now returns 404 where an active optimizer returns 400. **The upgrade to Next 15.5.x is a major change and needs approval.** |
| SA-DEP-02 | P2 | `zod@3` (memory exhaustion on oversized collections) | Low reachability (1 MB JSON cap). The fix is zod 4 (major, used everywhere). Recommend after Phase 6. |
| SA-DEP-03 | ✅ | `body-parser` 2.3 → **2.4.0**, `multer` 2.4 → **2.5.0** (DoS) | Patched (non-breaking); all suites green |
| SA-DEP-04 | P3 | Dev-only criticals: `vitest`/`tinypool`/`vite`, `glob`, `prisma` CLI chain | Not shipped; upgrade vitest 3 → 4 in Phase 4 |
| SA-DEP-05 | P2 | Mobile: 1 critical / 24 high | Triage in Phase 12 (Expo 51 pins many) |
| SA-LIC-01 | P3 | `react-leaflet` / `@react-leaflet/core`: **Hippocratic-2.1** (ethical-use licence, not OSI-approved) | Legal review, or swap for plain `leaflet` (BSD-2) |

Production-only audit after the patches: 1 critical (`next`, mitigated), 5 high, 11 moderate.

### 4.5 Route-guard inventory highlights

- Every non-public route is behind `authenticate` (SA-RT-001 ✅).
- Every `/platform/*` route is behind `requirePlatformAdmin` (SA-RT-004 ✅).
- The 28 handler-authorized routes were each read and justified in `HANDLER_AUTHZ` (e.g. delivery actions check `delivery:manage` or the assigned agent; notifications filter by `userId`).

### 4.6 tsc stricter flags (errors if enabled)

| Flag | shared | api | web | Recommendation |
|---|---|---|---|---|
| `noFallthroughCasesInSwitch` | 0 | 0 | 0 | **Enabled** |
| `noImplicitOverride` | 0 | 0 | 0 | **Enabled** |
| `noUnusedLocals` | 0 | 6 | 1 | Enable after the P3 cleanup |
| `noImplicitReturns` | 0 | 20 | 0 | Enable (Express `return res.json` pattern) |
| `noPropertyAccessFromIndexSignature` | 0 | 81 | 40 | Optional |
| `noUncheckedIndexedAccess` | 36 | 115 | 110 | **Recommended for money code first** (shared); incremental |
| `exactOptionalPropertyTypes` | 4 | 225 | 82 | Not worth it now |

## 5. Tooling added (now part of the repo)

| What | Where | Runs in |
|---|---|---|
| Type-aware ESLint for Node packages: errors for floating/misused promises, `await-thenable`, `no-base-to-string`, super-linear regex, invisible characters | `.eslintrc.node.cjs`, `apps/api/.eslintrc.cjs`, `packages/shared/.eslintrc.cjs`; `lint` scripts | `npm run lint` |
| Tests, seeds and configs are now typechecked | `tsconfig.lint.json` (api, shared); `typecheck` scripts | `npm run typecheck` |
| Route inventory + guard policy test | `apps/api/test/static/route-*.ts` → [ROUTE_GUARDS.md](ROUTE_GUARDS.md) | `npm test` |
| Fire-and-forget crash guard | `apps/api/test/static/fire-and-forget.test.ts` | `npm test` |
| Integration harness + fixture factory | `apps/api/vitest.integration.config.ts`, `test/integration/*` | `npm run test:integration -w @canavo/api` |
| `fast-check`, `supertest` | api devDeps | — |

## 6. Decisions needed from you

| # | Decision | My recommendation |
|---|---|---|
| D-1 | **BUG-013** socket rooms per permission (≈55 emit sites) | Implement now (P1 PII leak to delivery/kitchen/inventory staff) |
| D-2 | **SA-PLAT-01** Super Admin chooses the owner's password. This contradicts the privacy promise but matches the documented "Super Admin resets Owner passwords". | Replace with a one-time reset link/OTP to the owner, plus a notification. This **changes a documented rule**, so it needs your OK. |
| D-3 | **SA-DEP-01** Next 14 → 15.5.x (major) | Do it before release. The image optimizer is disabled meanwhile. |
| D-4 | Tenant-scoping design: extend `db.ts` to scope the unscoped models via their parent relation (a refactor of the isolation layer) vs. keep per-handler checks plus the Phase 8 matrix | Extend `db.ts` (defense in depth); the Phase 8 matrix verifies it either way |
| D-5 | SA-INV-01 / SA-CRM-01: should item stock, coupon redemptions and customer history be visible across **all outlets** of a business to a manager of one outlet? | Your call (business rule) |
| — | **BUG-003** (from Phase 2) is still waiting: logout should end (a) all devices, (b) this device only [recommended], or (c) accept and shorten the TTL | |

## 7. RTM delta

Pass 19 → **24**, Partial 15 → **23**, Fail 3 → **4** (TEN-007/DEL-011 now Fail on BUG-013; AUTH-011 still Fail on BUG-003; TAB-005 known gap). Requirements with ≥ 1 passing test: **47 / 200**.

## 8. Could not verify in this phase

- `prisma migrate reset` (blocked for AI agents without your explicit consent). Not needed; the harness is non-destructive.
- `license-checker` crashes on npm 11 / Node 26 workspaces. The licence data was read from the lockfile instead (same source).
- Runtime confirmation of SA-WEB-01 (camera) needs a browser with a camera: Phase 11 / manual.
