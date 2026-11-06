# Database migration runbook (deploy · verify · recover)

Prisma has **no down migrations**: every migration is forward-only. Recovery is either a **forward fix**
(a new migration) or a **restore** to the pre-deploy backup. This runbook is what QA Phase 7 verified on
55 migrations (2026-11-06, Postgres 16, Prisma 6.19.3); the scripts it names are in `apps/api/scripts/qa/`.

## 1. Before the deploy

1. **Read the new migrations.** For each `migration.sql` in the release, check the lock-risk table in
   [dbc.md](dbc.md#migration-lock-risk). Red flags: `SET DATA TYPE`, `UPDATE`/`DELETE` without a `WHERE` on a
   big table, `CREATE INDEX` without `CONCURRENTLY` on Order / OrderItem / Payment / KotTicket / AuditLog /
   InventoryTransaction, `ADD CONSTRAINT … FOREIGN KEY` on an existing big table without `NOT VALID`.
2. **Rehearse on a copy.** Restore last night's backup (or the provider's branch/fork) into a staging database and run
   `npx prisma migrate deploy` there. Time it. If one migration takes more than a few seconds, plan a quiet window.
3. **Drift check** (must print an empty migration):
   `npx prisma migrate diff --from-url "$STAGING_URL" --to-schema-datamodel prisma/schema.prisma --script`
4. **Take a backup right before deploying** — this is your only "down migration":
   - Provider snapshot / PITR marker (Render → canavo-db → Recovery; Neon branch; RDS snapshot). Note the time.
   - And a platform backup: Admin → Backups → *Create* (or wait for the daily one). It records the applied migration
     list, so it can only be restored onto the same migration state (see §4).
   - `pg_dump` only if you connect as a superuser (or a role with `BYPASSRLS`): as a normal table owner it fails on
     `FORCE ROW LEVEL SECURITY` (see dbc.md, defect dbc-3).
5. **Pin lock waits** for the deploy session so a migration fails fast instead of queueing every POS write behind it:
   add `&options=-c%20lock_timeout%3D5s` to the `DATABASE_URL` of the `migrate deploy` step (Prisma's engine
   ignores `PGOPTIONS`). Verified in QA: with a table held locked, deploy failed after the timeout with
   `55P03 canceling statement due to lock timeout`, the migration left nothing behind, and after
   `prisma migrate resolve --rolled-back <name>` the next deploy applied it.

## 2. Deploy

```
cd apps/api
DATABASE_URL=<direct, non-pooled URL> npx prisma migrate deploy
```

- Deploy the **database first, then the API/worker** (all migrations so far are additive, so the old code keeps
  working on the new schema). Never deploy code that needs a column before its migration has run.
- Use the **direct** connection (not PgBouncer in transaction mode): advisory locks and `CREATE INDEX CONCURRENTLY`
  need a session.
- Concurrency: `migrate deploy` takes an advisory lock, so two instances starting together are safe; one waits.
- Re-running `migrate deploy` is a no-op ("No pending migrations to apply"; schema dump unchanged — verified).

## 3. Verify (right after the deploy)

```
psql "$DATABASE_URL" -f apps/api/scripts/qa/post-deploy-verify.sql
npx prisma migrate status            # "Database schema is up to date!"
```

`post-deploy-verify.sql` lists only problems: failed/rolled-back migrations, **INVALID indexes**, business
tables without FORCE RLS, RLS helper functions without a pinned `search_path`, and whether the connected role
bypasses RLS / lacks the grants the platform restore needs. Then run the API smoke suite against staging, open
the POS, take one bill and check the bill list and daily report.

## 4. Recover

| Situation | What to do |
|---|---|
| **A migration failed** (`migrate deploy` exits non-zero, `_prisma_migrations` row with `finished_at` NULL) | Each file runs in one transaction, so a failed SQL migration left **nothing** behind (except `CONCURRENTLY`, below). Fix the cause (data, lock timeout), then `npx prisma migrate resolve --rolled-back <name>` and deploy again. If the fix needs different SQL, ship a **new** migration; never edit an applied one (checksum). |
| **A `CREATE INDEX CONCURRENTLY` migration failed** (e.g. duplicate keys for the unique `Order_outletId_channel_channelOrderId_key`) | Postgres leaves an **INVALID index** with that name, and the migration's `IF NOT EXISTS` then **skips it on retry**: the index is never built and a unique index is **not enforced** (reproduced in QA). Before retrying: `DROP INDEX CONCURRENTLY IF EXISTS "<name>";` fix the data, `migrate resolve --rolled-back <name>`, deploy, and check §3 item 2 is empty. |
| **Deploy succeeded but the new code is broken** | Roll the API/worker back (Render → Rollback). Additive migrations stay: the old code ignores new columns/tables. Fix forward. |
| **A migration changed data wrongly** (bad backfill) | Forward fix: a new migration that repairs the rows (guarded `WHERE`, idempotent, `set_config('app.bypass_rls','on',false)` … `set_config('app.bypass_rls','',false)` if the role is not a superuser — see `20261101124850_aadhaar_minimisation`). If data was destroyed, restore (next row). |
| **Data loss / corruption** | Restore the pre-deploy backup into a **new** database: provider PITR to the noted time, or (empty DB) `npx prisma migrate deploy` to the backup's migration state + Admin → Backups → Restore. Then deploy migrations forward again. An old `pg_dump` restored into an empty DB is rolled forward with `migrate deploy` (verified: counts equal). |
| **Platform restore refused** | "Backup schema does not match": the backup was taken on another migration list; restore it into a DB migrated to exactly that list (check out that release, `migrate deploy`), then deploy forward. "role can't restore": grant TRUNCATE + sequence UPDATE to the app role (DEPLOYMENT.md §1). Truncated file: nothing changed; pick another backup. |

### Writing a forward fix

- One concern per migration; generate it with `prisma migrate diff --from-migrations … --to-schema-datamodel … --shadow-database-url …` and re-run the diff afterwards (must be empty).
- Big tables: indexes in their **own** file with `CREATE INDEX CONCURRENTLY IF NOT EXISTS` (one statement per file);
  foreign keys as `ADD CONSTRAINT … NOT VALID` then `VALIDATE CONSTRAINT` in a later file; type changes as
  new column → batched backfill → switch code → drop old column (several releases).
- New columns: nullable, or `NOT NULL DEFAULT <constant>` (metadata-only on PG 11+). Never a volatile default
  (`now()`, `gen_random_uuid()`) on a big table: it rewrites the table.
- New business tables need `ENABLE` + `FORCE ROW LEVEL SECURITY` and a `tenant_isolation` policy in the same migration.
- Use unique timestamps (two migrations share `20261102090000`; harmless today because they are independent, but
  their order is decided only by the name).

## 5. Scripts

| Script | What it does |
|---|---|
| `scripts/qa/migrations-check.sh` | Empty DB → all migrations; drift vs `schema.prisma`; idempotent re-deploy; for every k = 0…N a DB at migration k then the rest, `pg_dump --schema-only` compared with the from-scratch DB. |
| `scripts/qa/seed-upgrade-check.sh` | Seed production guard, seed idempotency and realism, old-release seed + upgrade (row counts before/after), `pg_dump`/`pg_restore` round trips (superuser and non-superuser owner), seed as a non-superuser owner. |
| `scripts/qa/post-deploy-verify.sql` | §3 checks. |
| `npm run backup:drill -w @canavo/api` | Platform backup → restore into a scratch DB → counts and money totals compared (monthly). |
| `npm run test:db -w @canavo/api` | Backup/restore integration tests (test/db/backup-restore.test.ts). |
