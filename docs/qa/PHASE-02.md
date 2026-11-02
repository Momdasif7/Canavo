# Phase 2 — Build health, smoke & sanity: report

| | |
|---|---|
| Date | 2026-11-02 |
| Branch | `qa/full-testing` |
| Machine | macOS (Darwin 25.6), Node 26.10.0, npm 11.19.1, Docker 29.9 (PG 16-alpine) |
| Status | ✅ Complete — the build is green after 3 fixes; 1 defect deferred for a design decision |

## 1. Summary

| Step | Command | Before fixes | After fixes | Time |
|---|---|---|---|---|
| Clean install | `npm ci` (no `node_modules`, fresh checkout) | ✅ 481 packages | ✅ | 67 s |
| Build shared | `npm run build -w @canavo/shared` | ✅ | ✅ | 4 s |
| **Unit tests** | `npm test` (turbo: shared + api) | ❌ **api suite crashed** (BUG-001) | ✅ **119 / 119** (shared 28, api 91) | 9 s |
| Typecheck | `npm run typecheck` (shared, api, web) | ✅ | ✅ | 77 s |
| **Lint** | `npm run lint` | ❌ **interactive prompt, exit 1** (BUG-002) | ✅ 0 errors, 3 warnings | 2 s |
| Production build | `npm run build` (shared, api, web) | ✅ | ✅ | 26 s |
| Mobile install + typecheck | `cd apps/mobile && npm ci && npx tsc --noEmit` | ✅ | ✅ | — |
| Migrations from empty DB | `prisma migrate deploy` (11 migrations) | ✅ | ✅ | 3.5 s |
| Schema drift | `prisma migrate diff --from-migrations … --to-schema-datamodel … --exit-code` | ✅ "No difference detected" | ✅ | — |
| Seed | `npm run seed` | ✅ | ✅ | 8 s |
| Seed idempotency | `npm run seed` ×2, compare row counts | ✅ identical | ✅ | 1 s |
| API boot (dist) | `node dist/index.js` + `/health` | ✅ | ✅ | < 2 s |
| **Smoke suite** (new) | `npm run test:smoke` | — | ✅ **24 / 24** | **1.0 s** |
| Smoke read-only mode | `SMOKE_READONLY=1 npm run test:smoke` | — | ✅ 18 pass, 6 skipped | — |
| Dependency audit | `npm audit` (root, mobile) | ⚠️ see §4 | ⚠️ unchanged (Phase 3) | — |

## 2. Defects found and fixed in this phase

Full records are in [BUGS.csv](BUGS.csv). Every fix followed *reproduce → fix → re-run the same check*.

### 2.1 Overview

| ID | Sev | Title | Status |
|---|---|---|---|
| BUG-001 | P2 | API unit tests crash on a clean clone without `.env` | ✅ Verified |
| BUG-002 | P2 | `npm run lint` cannot run (no ESLint config; interactive prompt) | ✅ Verified |
| BUG-003 | P1 (provisional) | Access token still valid after logout | ⏸ Deferred — **needs your decision** |
| BUG-004 | P3 | Build artifact `tsconfig.tsbuildinfo` committed; every build dirties the tree | ✅ Verified |

### 2.2 BUG-001 — evidence

**Failing (before):**
```
@canavo/api:test:  FAIL  src/services/service-context.test.ts
@canavo/api:test: Error: process.exit unexpectedly called with "1"
@canavo/api:test:  ❯ src/env.ts:43:11
@canavo/api:test:  ❯ src/realtime.ts:3:1
@canavo/api:test:  Test Files  1 failed | 7 passed (8)
@canavo/api:test:       Tests  78 passed (78)        ← 13 tests in the crashed file never ran
```
Root cause: `service-context.ts` → `realtime.ts` → `env.ts`. At import time `env.ts` validates `process.env` and calls `process.exit(1)` when `DATABASE_URL`/JWT secrets are missing. CI passes only because the workflow injects those variables.

**Fix:** new `apps/api/vitest.config.ts` gives test-only dummy values **only for variables that are not already set**, so CI's real values still win. The DB URL points at port 1, so an accidental connection fails loudly.

**Passing (after),** with an empty environment (`env -i PATH=… HOME=… npx vitest run`):
```
 ✓ src/services/service-context.test.ts (13 tests)
 Test Files  8 passed (8)
      Tests  91 passed (91)
```

### 2.3 BUG-002 — evidence

**Failing (before):**
```
@canavo/web:lint: ? How would you like to configure ESLint? https://nextjs.org/docs/basic-features/eslint
@canavo/web:lint: ❯  Strict (recommended)
@canavo/web#lint:  ERROR  command … npm run lint exited (1)
```
**Fix:** `apps/web/.eslintrc.json` (`next/core-web-vitals`) and dev deps `eslint@8.57.1` + `eslint-config-next@14.2.35`, pinned to match Next 14.2.35.
**After:** exit 0, 0 errors, 3 × `react-hooks/exhaustive-deps` warnings, triaged in Phase 3.
**Still open (Phase 3):** `packages/shared`, `apps/api` and `apps/mobile` have **no lint script at all**, and lint is not run in CI.

### 2.4 BUG-003 — evidence (not fixed: design decision)

```
$ POST /auth/login  (cashier)          → 200 {accessToken: A, refreshToken: F}
$ POST /auth/logout {refreshToken: F}  → 204
$ GET  /auth/me  Authorization: Bearer A → 200   ← expected 401
```
Logout revokes only the refresh-token family. The 15-minute JWT stays usable, which matters on shared POS terminals. Options are listed in BUGS.csv; the recommendation is a per-session `sid` claim revoked on logout. **This changes auth behaviour, so I need your go-ahead** (the fix lands in Phase 8 together with the other auth tests).

### 2.5 BUG-004 — evidence

Before: `git ls-files | grep -c tsbuildinfo` → `1`; after any build, `git status` → ` M apps/web/tsconfig.tsbuildinfo`.
After: `git rm --cached apps/web/tsconfig.tsbuildinfo` and `*.tsbuildinfo` added to `.gitignore` → `0` tracked.

## 3. Smoke suite and sanity checklist (new)

- **Smoke:** [SMOKE_SUITE.md](SMOKE_SUITE.md), with code in `apps/api/test/smoke/smoke.test.ts`. It has 24 checks covering login for all 7 roles, the privacy wall for the Super Admin, menu, bill create (integer paise, rounded to rupee), idempotent resend, KOT on the KDS, KOT status flow, cash payment with change, receipt, reports, bill history, role walls (inventory/kitchen/delivery) and logout. It runs against any URL, has a read-only mode for post-deploy use, and enforces the 15-minute budget.
- **Sanity:** [SANITY_CHECKLIST.md](SANITY_CHECKLIST.md) has 26 checks in 5 sections: platform up, production config safety, core flow, privacy walls, mobile. It includes stop/rollback rules.
- Root scripts: `npm run test:smoke` (root and `@canavo/api`). The unit `npm test` does **not** pick up smoke (separate config).

Smoke run (QA instance on :4100, seeded `canavo_qa` DB):
```
 ✓ SMK-001 … ✓ SMK-080   Test Files 1 passed (1)   Tests 24 passed (24)   Duration 1.59s
 [smoke] finished in 1.0 s against http://localhost:4100
```

Smoke also confirmed one money calculation by hand. 2 × Badam Milk @ ₹35 (5 % GST, prices tax-inclusive) plus takeaway packaging ₹5 gives taxable ₹66.67 + ₹5.00, CGST ₹1.79 + SGST ₹1.79 and round-off −₹0.25, so the **grand total is ₹75.00**. The packaging is taxed at the line rate as the README specifies.

## 4. Dependency audit (snapshot; triage in Phase 3)

| Scope | Critical | High | Moderate | Low |
|---|---|---|---|---|
| Root workspaces | 3 | 11 | 27 | 0 |
| `apps/mobile` | 1 | 24 | 43 | 3 |

**Runtime-relevant** (deployed code paths): `next` 14.2.35 (critical: DoS via Image Optimizer / RSC deserialization), `body-parser` 2.0–2.3 (DoS, used by `express.json`), `multer` 2.0–2.4 (DoS), `zod` < 4.6.6 (memory exhaustion on oversized collections).
**Dev-only:** `vitest`/`tinypool`/`vite` (critical/high), `glob`, `eslint-config-next` chain, `prisma` CLI (`deepmerge-ts`).
Two of the high findings come from the ESLint dev-dependencies added for BUG-002. They are dev-only and do not ship.

## 5. Observations queued for Phase 3 (not yet classified as bugs)

| # | Observation | Where |
|---|---|---|
| O-1 | Test files are excluded from `tsc` (`"exclude": ["src/**/*.test.ts"]`), so test code is never typechecked | `apps/api/tsconfig.json`, `packages/shared/tsconfig.json` |
| O-2 | `env.ts` calls `process.exit` at import time, so any import graph touching it is untestable without env (root cause of BUG-001) | `apps/api/src/env.ts` |
| O-3 | Lint is absent from CI; `apps/mobile` is outside npm workspaces with its own lockfile; CI's mobile job runs `npm ci` twice | `.github/workflows/ci.yml`, root `package.json` |
| O-4 | `publicApiUrl()` trusts a client-supplied `X-Forwarded-Host`, a possible host-header injection into customer-facing receipt links | `apps/api/src/lib/http.ts:52` |
| O-5 | Swagger UI and `/openapi.json` are served in production | `apps/api/src/app.ts:39-40` |
| O-6 | Prisma P2002 handler returns `err.meta` to the client (leaks constraint/field names) | `apps/api/src/lib/http.ts:35` |
| O-7 | Seed creates only one business. Multi-tenant tests need fixture tenants T1–T4 (planned for Phase 5) | `apps/api/prisma/seed*.ts` |
| O-8 | `Float` columns for quantities and tax rates (inventory qty, `gstRate`, `cgst`/`sgst`/`igst`/`cess` on TaxRate); money columns are `Int` ✅ | `schema.prisma` |
| O-9 | The Dockerfile runs the API as root and copies the whole build stage (dev deps included) into the runtime image | `apps/api/Dockerfile` |
| O-10 | README says "99 unit tests"; actual count is 119 | `README.md` |

## 6. RTM delta

Requirements with at least one passing test: **34 of 200**. Of these, 19 pass and 15 are partial (existing unit suites or smoke covering part of the rule). **3 Fail:** AUTH-011 (BUG-003), SEC-008 (CVEs) and TAB-005 (known tab-split gap). 162 are not started; 1 is N/A (face-match clock-in is not implemented, by design).

## 7. Could not verify in this phase

- Behaviour with your local `apps/api/.env` / `apps/web/.env.local`: not read, per your global rule. QA used the documented `.env.example` fallbacks (UV-15).
- Node 20 and Node 22: the local machine runs Node 26 (UV-16). CI covers 22.
- The web UI part of smoke (Playwright) comes in Phase 11. Until then it is manual sanity items SAN-020 to SAN-026.

## 8. Files changed in this phase

```
.gitignore                                  + *.tsbuildinfo                     (BUG-004)
apps/web/tsconfig.tsbuildinfo               removed from git                    (BUG-004)
apps/api/vitest.config.ts                   new — hermetic unit test env        (BUG-001)
apps/web/.eslintrc.json                     new — next/core-web-vitals          (BUG-002)
apps/web/package.json, package-lock.json    + eslint, eslint-config-next (dev)  (BUG-002)
apps/api/test/smoke/smoke.test.ts           new — 24-check smoke suite
apps/api/vitest.smoke.config.ts             new
apps/api/package.json, package.json         + test:smoke scripts
docs/qa/*                                   strategy, RTM, bug log, templates, smoke/sanity docs, reports
```
