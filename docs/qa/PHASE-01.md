# Phase 1 — Test strategy & planning: report

| | |
|---|---|
| Date | 2026-11-02 |
| Branch | `qa/full-testing` |
| Status | ✅ Complete |

## Deliverables

| Deliverable | File |
|---|---|
| Test strategy (scope, levels, types, environments, test data, entry/exit criteria, risk register, defect lifecycle, tools) | [TEST_STRATEGY.md](TEST_STRATEGY.md) |
| Requirements traceability matrix — skeleton with **200 requirements** across 28 areas | [RTM.csv](RTM.csv) |
| Defect log | [BUGS.csv](BUGS.csv) |
| Bug report template | [templates/BUG_REPORT_TEMPLATE.md](templates/BUG_REPORT_TEMPLATE.md) |
| Manual test case template (Markdown + importable CSV) | [templates/MANUAL_TEST_CASE_TEMPLATE.md](templates/MANUAL_TEST_CASE_TEMPLATE.md), [templates/manual_test_case_template.csv](templates/manual_test_case_template.csv) |
| Log of items that cannot be verified | [UNVERIFIABLE.md](UNVERIFIABLE.md) |

## How the strategy was grounded

Every architecture claim in the strategy was checked against the code, not just the README:

- **Tenant isolation design** (`apps/api/src/db.ts`): a Prisma `$extends` query hook adds `businessId` to `where`/`data` for **only 11 models** (Outlet, User, MenuCategory, MenuItem, Customer, InventoryItem, Vendor, Offer, Coupon, TaxRate, AuditLog). Orders, payments, KOTs, tables, deliveries, stock, ledgers and notifications depend on each handler filtering by `outletId`. This is why **R-01/R-02 are top risks** and Phase 8 runs a full route × role × foreign-ID matrix.
- **Surface size:** about **242 HTTP endpoints** in 20 routers (inventory 47, delivery 31, tables 23, …). The API-testing and isolation phases are sized from this count.
- **Guards:** `authenticate` → `requireOutlet` → `requirePermission` (role ∩ module). Some routers apply guards at router level (e.g. `reports.ts` line 1173), so the Phase 3 guard audit must follow `router.use` order, not only per-route arguments.
- **Payment race:** `/orders/:id/payments` checks the balance *outside* the DB transaction, which became risk **R-03**.
- **Known gaps from the README** (tab split atomicity, single-instance jobs, GSTR-1 B2B/B2CL, foreground-only GPS, face match, coupon GST treatment) are in the RTM and the risk register, marked "known".

## Risk register — top 5 (full list in strategy §9)

| ID | Risk | Score |
|---|---|---|
| R-04 | Tab split not atomic (known) | 16 |
| R-01 | Cross-tenant / cross-outlet access on non-auto-scoped models | 15 |
| R-02 | Foreign IDs smuggled into writes | 15 |
| R-03 | Payment balance race / overpayment | 15 |
| R-09 | Access token valid after logout (**confirmed in Phase 2, BUG-003**) | 15 |

## Decisions taken (defaults; tell me if you want otherwise)

1. **RTM as CSV**, not Markdown, so it can be filtered in Excel and diffed in git.
2. **QA databases are separate** (`canavo_qa`, `canavo_test_*`, `canavo_shadow`) in the same Docker Postgres. Your `canavo` dev DB and every `.env` file stay untouched.
3. **QA fixture tenants T1–T4** (no-GST shop, GST restaurant ×2 outlets incl. inter-state, composition ×3 outlets, suspended business) will be built **through the API** in Phase 5, next to the existing demo seed (T0).
4. **Timezone flushing:** the staging-like suites run under both `TZ=UTC` and `TZ=America/New_York`.
5. **Severity P0 for "security"** is applied to real breaches. Hardening issues (e.g. BUG-003) get a provisional P1 until Phase 8 assigns a CVSS score.
