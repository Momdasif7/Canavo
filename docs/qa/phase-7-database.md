# Phase 7: Database testing

Branch `qa/full-testing`. The work ran as five parallel streams; each wrote a detailed section in [phase-7/](phase-7/):
- [dba.md](phase-7/dba.md): schema and tenant integrity
- [dbb.md](phase-7/dbb.md): indexes, query plans, connection pool
- [dbc.md](phase-7/dbc.md): migrations, seed, backup and restore
- [dbd.md](phase-7/dbd.md): reconciliation and transactions
- [dbe.md](phase-7/dbe.md): follow-up fixes

This page is the summary. The work was done without stopping for decisions, so where a choice was needed, the best-practice option was taken and recorded below.

## Result

| Suite | Command | Result |
|---|---|---|
| Database suites (new) | `npm run test:db -w @canavo/api` | **68 passed** (10 files; each runs on a freshly recreated database) |
| API suite | `npm run test:api -w @canavo/api` | 717 / 717 |
| Integration | `npm run test:integration -w @canavo/api` | 207 / 207 |
| Unit | `npm test` | shared 51, api 160 |
| Smoke (running app) | `npm run test:smoke -w @canavo/api` | 17 / 17 |
| Schema diff after all migrations | `prisma migrate diff` | empty |
| Post-deploy check on the dev database | `scripts/qa/post-deploy-verify.sql` | clean |

**33 defects found (BUG-052 to BUG-084), all fixed and verified:**

| Severity | Count |
|---|---|
| P0 | 2 |
| P1 | 5 |
| P2 | 19 |
| P3 | 7 |

Each fix has a test that failed first. The full list is in [BUGS.csv](BUGS.csv).

## What was checked

| Area | How | Outcome |
|---|---|---|
| **Schema review** | 83 tables, 90 foreign keys, uniqueness rules, NOT NULL, enums, cascades, float columns, timestamp types, read from the real catalog | All tables have primary keys. No money is stored as float (tax rates and stock quantities are). One "open table session per table" rule added. |
| **CHECK constraints** | **43 database guards**: money parts not negative, refunds no more than the bill, quantities and prices, wallet / points / gift-card / token balances, coupon counts, cash amounts, khata balance not negative, gift card no more than its loaded value, tax rate no more than 100% | Added without a table scan, then validated in a second migration (no write blocking). Existing data pre-checked: 0 violations. A violation now returns 409, not 500. |
| **Tenant integrity** | [sql/tenant-integrity.sql](sql/tenant-integrity.sql): **340 checks generated from the catalog**: every row reaches a business, no orphans, no link into another hotel or outlet, including JSON and array references | 0 rows after a three-hotel workload through the API. 8 kinds of planted bad link are each caught. 0 rows on the dev database (read-only). |
| **Reconciliation** | [sql/reconciliation.sql](sql/reconciliation.sql): 45 queries. Bills vs payments and refunds; stock vs ledger; delivery cash; loyalty, khata, gift-card and wallet ledgers; invoice and credit-note series with no gaps or duplicates; shift cash; KOT and tab consistency | Empty after a heavy parallel mixed day. 16 planted kinds of damage are each caught. Dev database: see "Dev database findings". |
| **Transactions and isolation** | Failures injected mid-transaction; real deadlock paths; 50 bills at once; parallel stock, points, khata and gift-card use | Nothing partial persists. Invoice numbers 1–50 with no gaps. Deadlocks are retried automatically, then a clean 409. |
| **Indexes and query plans** | 300k bills, 1.05M order lines, 305k payments and more; 72 endpoints run as the security-enforced app role; 46 plans before and after ([phase-7/query-plans/](phase-7/query-plans/)) | 4 concurrent indexes added, e.g. staff report over a year 4.7 s → 94 ms. Nothing sorts to disk. |
| **Connection pool** | Pool exhausted, connections killed mid-traffic, two businesses interleaved over shared connections | 503 with `Retry-After` instead of 500; immediate recovery; **0 rows ever crossed between businesses** (400 HTTP requests and 300 client tasks). |
| **Migrations** | All migrations (55 when tested; 66 now) from empty; from every earlier state; re-run; upgrade with real seeded data from an old release; recovery from a failed migration | Identical schemas every time. No row lost on upgrade. Lock risks listed, plus a runbook: [phase-7/migration-runbook.md](phase-7/migration-runbook.md). |
| **Seed** | Run twice; production guard; realism | Second run changes nothing. No demo logins in production. 31 days of history, 4 GST rates, all 11 roles. |
| **Backup and restore** | App backup restored over a populated database and into an empty one; `pg_dump` / `pg_restore`; refusals | All 82 tables have identical row counts, and the money and stock totals match to the paisa. Security policies, enums, sequences and grants survive. A mismatched or truncated backup is refused. |
| **Soft delete and audit log** | Deactivated items, staff, stock items, vendors, members | Still shown in history, left out of new work. The audit log grows about 2.5 rows per bill; see recommendations. |

## Most important fixes

- **Money:**
  - Confirming a UPI QR on a bill already paid in cash recorded it twice (P0).
  - Khata could be settled twice at once.
  - Loyalty points could go negative.
  - A gift-card refund went to the wrong card.
  - Khata could go negative after a void or a credit note.
  - Payments and cash movements racing the shift close were missing from the Z-report. The close now runs in one transaction with the shift locked.
- **Data loss:**
  - Merging two tables into each other at the same moment closed both tabs with their food (P0).
  - A menu item that was only on an open tab was deleted, so the tab couldn't be billed.
  - Re-enrolment wiped canteen card data (Phase 6, re-verified).
- **Kitchen:** duplicate KOT numbers. There is now one numbering helper for bills, table rounds and online orders, with a per-outlet lock, based on the highest number used today.
- **Scale:** reports over a year of bills returned 500 (database parameter limit). Customer and staff screens were slow.
- **Resilience:**
  - Database outages returned 500 instead of 503.
  - Stale connections failed requests after a database restart.
  - Deadlocks returned 500. They are now retried up to 3 times.
- **Operations:**
  - A platform restore broke billing (sequence reset).
  - Restore was impossible for a least-privilege role.
  - `pg_dump` failed because of a security helper function; it is now schema-qualified.
  - The seed failed on managed databases.
  - An empty "Demo Hotel" was put into every fresh production database. It is now removed when unused; dev databases that use it keep it.

## Decisions taken (best practice)

1. **Khata has no "advance" balance.** Money a customer already settled goes back by cash or UPI through a credit note, never as negative khata. Voiding a settled khata bill is refused; the cashier refunds it instead.
2. **Deadlocks** are retried automatically, rerunning the whole transaction up to 3 times with short random waits. This applies only to transactions with no outside side effects before commit.
3. **The shift close** locks the shift and builds the Z-report in the same transaction. Money still being saved is waited for; money arriving afterwards goes to the next shift.
4. **Gift-card refunds** give each card back what it paid on that bill, most recently used card first, never above its loaded value.
5. **Database guards** were added only for limits that every code path already respects, so they act as a backstop and never block normal work.
6. **Status filters (R1).** Postgres can't use an index for `status = …` filters on security-enforced tables. The chosen approach keeps such queries limited to a time window (as the kitchen display now is) rather than marking database functions as safe, which managed Postgres services don't allow. Changing statuses from enums to text is noted for later if needed.
7. **`test:db`** runs each whole-database suite on a freshly recreated database, so results don't depend on file order.

## Dev database findings (read-only)

- **Tenant integrity:** 340 of 340 checks returned 0.
- **Reconciliation:** 0, except:
  - **B08:** 2 demo-seed purchases with no payment rows. The seed is fixed; the existing rows are left as they are.
  - **F01:** 4 closed shifts with no figures. They are leftovers from QA browser-check setup (opened and reset a minute apart on 1 Nov, with no close in the audit log), not an app defect. The check flags them correctly.
- **All Phase 7 migrations applied:** 66 migrations in total, 77 security policies.

## Recommendations (not done in this phase)

- **Foreign keys** for 113 references that aren't enforced, or run the tenant-integrity SQL nightly or in CI.
- **Cascades:** change cascades that could delete financial history (order → payments, credit notes; customer → ledgers) to RESTRICT. No app path does this today.
- **App database role settings:** pin the database timezone to UTC (the outbox compares with the database's `now()`), set `jit = off`, set statement and lock timeouts, and set `connection_limit` / `pool_timeout` explicitly in production.
- **Audit log:** keep about 13 months live and archive older months; default the audit screen to a date range; cap the page count. A customer erasure (anonymise) flow is needed for DPDP requests.
- **Faster security checks:** copy `outletId` onto order lines and payments so their security check is cheaper. Give bill search a default date window.
- **Restore:** it runs as one long transaction (about 3,500 rows/s, so a 15-minute limit reaches about 3M rows). Add maintenance mode or a COPY-based restore before data grows. The platform backup doesn't include the background-job schema.
- **Shift lock coverage:** gift-card cash sales, wallet and token cash, delivery handovers and online-channel voids should also take the shift lock. Extend the deadlock retry to customers, delivery, canteen, storefront and channels.
- **Invoice numbers:** outlets sharing one GSTIN with the default "INV" prefix issue identical invoice numbers. Use a per-outlet prefix.
- **Release checklist:** add `scripts/qa/post-deploy-verify.sql` and `scripts/qa/migrations-check.sh`.

## Not verified, and why

- Lock timings on production-sized tables, provider point-in-time recovery, restore from the off-site copy, and restore under live traffic: no production-like environment.
- Production hardware and connection poolers (PgBouncer): local Docker only.
- Deadlock retry under real HTTP traffic: the fixed code paths can no longer be deadlocked on demand. Retry is proven with a forced database deadlock.

## How to run

```
npm run test:db -w @canavo/api                  # needs Docker Postgres
psql "$DATABASE_URL" -c "BEGIN READ ONLY" -c "SELECT set_config('app.bypass_rls','on',true)" \
  -f docs/qa/sql/reconciliation.sql -c "ROLLBACK"           # books check on any database
psql "$DATABASE_URL" -f apps/api/scripts/qa/post-deploy-verify.sql   # after every deploy
```
