# QA Phase 7 — migrations, seed, backup & restore (agent dbc)

Scope: the 55 Prisma migrations, the demo seed, the platform backup/restore and `pg_dump`/`pg_restore`.
All runs on scratch databases `canavo_dbc_*` / `canavo_it_dbc` (Postgres 16 in Docker, Prisma 6.19.3), 2026-11-06.
No migrations were added (schema changes belong to other agents); defects that need one are reported with the SQL.
Deploy / verify / recover procedure: [migration-runbook.md](migration-runbook.md).

## What was checked and how

| Area | How | Result |
|---|---|---|
| Migrations from an empty DB | `scripts/qa/migrations-check.sh` | 55/55 applied in ~2 s |
| Final schema = `schema.prisma` | `prisma migrate diff --from-url <scratch> --to-schema-datamodel` | empty migration |
| Stepwise upgrade from every earlier state | for k = 0…55: DB at migration k (built incrementally, cloned by `CREATE DATABASE … TEMPLATE`), deploy the rest, normalised `pg_dump --schema-only` vs from-scratch; asserts k applied before and 55−k after | **56/56 identical** (rest-deploy total 94 s) |
| Re-running deploy | second `migrate deploy` | "No pending migrations", schema dump byte-identical |
| `CONCURRENTLY` migrations alone in their file | grep | 14/14 have exactly one statement |
| Data migrations re-run safety | review (`multi_business_tax`, `delivery_cash_handovers`, `menu_defaults`, `aadhaar_minimisation`) | each runs once in one transaction; `aadhaar_minimisation` (the only one after RLS) sets and resets `app.bypass_rls`, is a guarded idempotent `UPDATE … WHERE EXISTS` |
| Failed migration recovery | lock held on `Business`, deploy with `options=-c lock_timeout=2s` | failed fast (55P03), nothing left behind; after `rolled-back` the next deploy applied it |
| Lock risk per migration | review, table below | 4 high/medium historic migrations; recommendations |
| Upgrade **with data** | release `2c38f75` (12 migrations): its own seed (old client generated into a scratch folder) → 7,100 rows → deploy the other 43 migrations | **0 tables changed count**; orders 1,677 / paid ₹1,97,810.00 / payments / khata ₹1,890 / stock 617.5 unchanged; no drift; current seed then runs fine |
| Seed production guard | `NODE_ENV=production npm run seed` on an empty DB | refused (exit 1), 0 users, 0 outlets |
| Seed idempotency | seed twice on a fresh DB, exact `count(*)` of every table | after fix dbc-4: identical (7,149 rows, 33 tables) |
| Seed realism | SQL on the seeded DB | 1,703 orders over 31 days (span 29 d), PAID + CANCELLED, DINE_IN/TAKEAWAY/DELIVERY/PRE_ORDER, CASH/UPI/CARD; after fix dbc-6: GST 0/5/12/18 % on bill lines and all 11 roles |
| Seed as a non-superuser DB owner (Render/Neon) | role `NOSUPERUSER NOBYPASSRLS` owning the DB | failed before fix dbc-5, OK after (11 users, 1,703 orders) |
| App backup → restore over a populated DB | `test/db/backup-restore.test.ts` (API, app role, RLS real) | counts of all 82 tables identical, totals identical (orders, paid/open/cancelled, payments, line totals, khata balances and ledger, stock, outbox max seq) |
| App works after restore | 3 new bills after the restore | failed before fix dbc-1 (409 on `OutboxEvent.seq`), OK after |
| App backup → restore into a new empty DB | same test: fresh `migrate deploy`, restore as the **app role** | identical counts and totals; policies, FORCE-RLS tables, enums, functions identical to source; RLS still bites (no setting = 0 rows); new rows get fresh IDs |
| Restore refusals | same test | other migration set → 409; truncated file → 400; role without TRUNCATE → 409 with the grant to run; **nothing changed** in each case |
| Restore drill | `npm run backup:drill` on a seeded DB | PASSED: 7,149 rows, backup 0.3 s, restore 2.0 s, total 3.9 s, paid total equal to the paisa |
| `pg_dump`/`pg_restore` (superuser) | `scripts/qa/seed-upgrade-check.sh` §E | all table counts and totals equal; 77 policies, 77 FORCE-RLS tables, 43 enums, 4 functions, ACL hash, 55 migration rows equal |
| Old `pg_dump` → empty DB → `migrate deploy` | §E1 | counts equal the in-place upgraded DB |
| `pg_restore` as non-superuser owner | §E3 | OK, all rows |
| `pg_dump` as non-superuser owner | §E3 | **fails** — dbc-3 |

## Defects

| ID | Sev | Area | Title | Repro | Expected / actual | Test | Fixed |
|---|---|---|---|---|---|---|---|
| dbc-1 | P1 | backup | After a platform restore, every bill fails until the outbox sequence catches up | Restore any backup taken after outbox events existed, then create a bill | Bills work / `409 Already exists (OutboxEvent.seq)`: `TRUNCATE … RESTART IDENTITY` reset the sequence to 1 and the restored rows were inserted with their own `seq` | `backup-restore.test.ts` "the app keeps working after the restore" (fails on the old code with the owner role) | Yes: after the rows are inserted, every autoincrement sequence is `setval`'d past `max()` (`src/services/backup.ts`) |
| dbc-2 | P2 | backup | Platform restore impossible for a least-privilege app role (the documented Supabase/RDS setup and the integration role) | Connect as a role with `SELECT/INSERT/UPDATE/DELETE`; Admin → Backups → Restore | Restore, or a clear refusal / `500 permission denied for table`; with TRUNCATE granted still `500 must be owner of sequence OutboxEvent_seq_seq` (`RESTART IDENTITY` needs ownership) | "an app role without TRUNCATE gets a clear refusal…", "…into a new, empty database as the app role" | Yes: no `RESTART IDENTITY`; privilege pre-check → 409 naming the GRANTs, nothing changed; DEPLOYMENT.md §1 lists the grants |
| dbc-3 | P2 | migrations / RLS | `canavo_outlets()` reads `"Outlet"` by unqualified name with no pinned `search_path`: `pg_dump` (search_path '') cannot dump outlet-scoped tables | As a non-superuser DB owner (Render/Neon): `PGOPTIONS='-c app.bypass_rls=on' pg_dump --enable-row-security` | Full dump / `relation "Outlet" does not exist … SQL function "canavo_outlets" during inlining` (plain `pg_dump` fails earlier on FORCE RLS) | `seed-upgrade-check.sh` §E3 | **No — needs a migration** (not mine to add). Fix: `CREATE OR REPLACE FUNCTION canavo_outlets() RETURNS text[] LANGUAGE sql STABLE AS $$ SELECT coalesce(array_agg("id"), '{}') FROM public."Outlet" WHERE "businessId" = public.canavo_business() $$;` (or `ALTER FUNCTION canavo_outlets() SET search_path = public, pg_temp` — verified: the owner dump then contains every row). `post-deploy-verify.sql` check 4 flags it. Runtime is unaffected (the app's search_path is `public`). |
| dbc-4 | P3 | seed | Seed not idempotent after ~21:00 IST: duplicate demo reservation | `npm run seed` twice in the evening | Counts unchanged / `Reservation` 1 → 2 (the booking moves past midnight, outside the "today" window the check used) | `seed-upgrade-check.sh` §B | Yes (`prisma/seed-service.ts`: open-ended window on the demo booking's phone) |
| dbc-5 | P2 | seed | Demo seed fails on a non-superuser DB owner (Render/Neon), i.e. the `ALLOW_DEMO_SEED=1` demo-environment path | Seed a DB owned by a `NOSUPERUSER NOBYPASSRLS` role | Seeded / Prisma error in `seedBase` (FORCE RLS binds the owner: reads see nothing, inserts refused) | `seed-upgrade-check.sh` §F | Yes (`prisma/seed.ts`: the seed connects with `options=-c app.bypass_rls=on`, as the platform client does) |
| dbc-6 | P3 | seed | Seed realism: every bill line at 5 % GST; no demo logins for Waiter, Accountant, Auditor, Platform Support | §C queries | Variety / one rate, 7 of 11 roles | `seed-upgrade-check.sh` §C | Yes: 3 items at 18 % (water, HSN 2201), 12 % (namkeen, 2106), 0 % (tender coconut, 0801) on new seeds; `ensureDemoRoles()` adds the 4 logins idempotently (also to existing dev DBs; never in production — the guard runs first) |

## Migration lock risk

Everything not listed is **low**: new tables, nullable columns, `NOT NULL DEFAULT <constant>` (metadata-only on PG 11+),
enum `ADD VALUE`, indexes on small/new tables, or `CREATE INDEX CONCURRENTLY` alone in its file. All 55 are already
applied on every existing database; the table matters for any older production copy and as the pattern to follow.

| Migration | Risk | Why | Recommendation |
|---|---|---|---|
| `20261002175333_phase2_3` | Medium | Non-concurrent `Order_customerId_idx` (blocks Order writes during build); `Order_customerId_fkey`, `Order_tableSessionId_fkey`, `KotTicket_sessionId_fkey` added without `NOT VALID` (scan under SHARE ROW EXCLUSIVE) | Pattern for the future: index `CONCURRENTLY` in its own file; FK `NOT VALID` + `VALIDATE CONSTRAINT` later |
| `20261004124322_multi_business_tax` | **High** | `OrderItem."gstRate"` and `MenuItem."gstRate"` INTEGER → DOUBLE (full rewrite + index rebuild under ACCESS EXCLUSIVE); `UPDATE "AuditLog"` every row; non-concurrent `AuditLog_businessId_createdAt_idx`; 11 FKs validated in place; inserts the **"Demo Hotel" business (`biz_demo`, ACTIVE) and 5 tax rates into every database, production included** | Run only in a window on large data. Type changes: new column → batched backfill → switch → drop. Forward fix (recommendation R1) for the phantom hotel |
| `20261024142407_delivery_collections` | Medium | Non-concurrent `Payment_collectedById_idx` on Payment | Concurrent index in its own file |
| `20261024153110_delivery_cash_handovers` | Low–Med | Backfill `INSERT … SELECT` over Delivery ⋈ Payment (reads only) | Fine; batch if Delivery is large |
| `20261101111332…111343_idx_*` (12), `20261101223619`, `20261102090100` | Low (+ trap) | `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, one per file ✓. A failed build leaves an **INVALID** index; the retry's `IF NOT EXISTS` skips it — for the unique `Order_outletId_channel_channelOrderId_key` uniqueness is then **not enforced** (reproduced: duplicate insert accepted) | Runbook §4: `DROP INDEX CONCURRENTLY IF EXISTS` before retry; `post-deploy-verify.sql` check 2 |
| `20261101113736_row_level_security` | Medium | `ENABLE`/`FORCE ROW LEVEL SECURITY` + policies on 48 tables: ACCESS EXCLUSIVE briefly on each, including Order/Payment/OrderItem — can queue behind long transactions; helper function search_path (dbc-3) | `lock_timeout` on deploy (runbook §1.5) and retry |
| `20261101131939_credit_notes`, `20261102090000_order_handover` | Low–Med | New tables with FK → `Order` take SHARE ROW EXCLUSIVE on Order briefly; `Order` ADD `refundedAmount` NOT NULL DEFAULT 0 is metadata-only | `lock_timeout` |
| `20261101173443_canteen_accounts_wallets` | Medium | Non-concurrent `Payment_corporateAccountId_createdAt_idx` on Payment; 3 non-concurrent indexes + FK on Customer | Concurrent indexes in own files |
| `20261102090000_order_handover` / `20261102090000_storefront_otp_refunds` | Info | Same timestamp; order decided by name only (independent today) | Unique timestamps |

## Recommendations (no failing behaviour)

- **R1** Fresh databases (production included) contain an ACTIVE "Demo Hotel" (`biz_demo`) with 5 tax rates and no users,
  from `multi_business_tax`. Forward-fix migration: `DELETE FROM "Business" WHERE id = 'biz_demo' AND NOT EXISTS (SELECT 1 FROM "Outlet" WHERE "businessId" = 'biz_demo') AND NOT EXISTS (SELECT 1 FROM "User" WHERE "businessId" = 'biz_demo');` (the seed upserts it again for dev).
- **R2** The platform restore runs in one transaction with a 15-minute timeout and holds ACCESS EXCLUSIVE on every table
  throughout (the API queues). Measured ≈3,500 rows/s (7,149 rows in 2.0 s), so ~3 M rows hit the timeout. Before data
  grows: maintenance mode during a restore, configurable timeout, or a COPY-based restore.
- **R3** The platform backup covers the 82 Prisma tables only: not `_prisma_migrations` (by design — checked instead) and
  not the `pgboss` job schema. After a restore, queued/scheduled jobs are the current ones; document it in the restore dialog.
- **R4** `pg_dump` from a managed provider's normal owner role is impossible while FORCE RLS binds the owner (independent of
  dbc-3). Logical dumps need a superuser/`BYPASSRLS` role, or the dbc-3 fix plus `PGOPTIONS='-c app.bypass_rls=on' pg_dump --enable-row-security`. Rely on provider PITR + the platform backup (DEPLOYMENT.md §6 updated).
- **R5** Adopt `post-deploy-verify.sql` and `migrations-check.sh` in CI / the release checklist.

## Files

- `apps/api/src/services/backup.ts` — dbc-1, dbc-2 (sequence reset, no `RESTART IDENTITY`, privilege pre-check)
- `apps/api/prisma/seed.ts`, `apps/api/prisma/seed-service.ts` — dbc-4, dbc-5, dbc-6
- `apps/api/test/db/backup-restore.test.ts` (6 tests), `npm run test:db`
- `apps/api/scripts/qa/migrations-check.sh`, `seed-upgrade-check.sh`, `post-deploy-verify.sql`
- `docs/deployment/DEPLOYMENT.md` (restore grants, logical dumps), `docs/qa/phase-7/migration-runbook.md`

## Regression

On `canavo_it_dbc` after the fixes: `tsc --noEmit -p apps/api` clean; `npm run test:db` 6/6; integration suite 207/207
(31 files); `npm run test:api` 717/717 (23 files); `src/services` unit tests 124/124.

## Not verified

- Lock timings on production-sized tables (no large dataset here; risk table is from reading the SQL and Postgres lock rules).
- Provider PITR (Render/Neon) and the S3 off-site restore path end to end (off-site store has unit tests only).
- A platform restore under concurrent POS traffic.
- `pg_dump` as owner *with* the dbc-3 fix applied by migration (verified with a manual `ALTER FUNCTION` on a scratch DB only).
