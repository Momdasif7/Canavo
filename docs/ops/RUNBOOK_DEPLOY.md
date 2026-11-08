# Runbook: deploy a release

Owner: release manager on duty. Window: outside meal peaks (avoid 11:30–14:30 and 19:00–22:00 IST).

## Before
1. CI green on the release commit (`.github/workflows/ci.yml`: build, lint, typecheck, unit, integration, test:api,
   test:db, E2E, security scans, k6 smoke). `docs/qa/BUGS.csv` has no open P0/P1.
2. Read the release's migrations. Anything beyond additive (type change, non-concurrent index on Order / Payment /
   OrderItem / KotTicket / AuditLog, backfill) → follow [migration runbook §1](../qa/phase-7/migration-runbook.md) and
   schedule a window. Big-table indexes must be `CREATE INDEX CONCURRENTLY IF NOT EXISTS`, one per migration file.
3. Confirm a backup newer than 24 h exists (Admin → Backups or the S3 bucket) and PITR is on.
4. Note the currently deployed commit of web, API and worker (needed for rollback).
5. Deploy to **staging** first and run steps "Verify" there.

## Deploy (production)
1. **Database + API**: merge to `main` → Render auto-deploys canavo-api. The container runs
   `npx prisma migrate deploy && node dist/index.js` (advisory lock: several instances starting together are safe).
   For risky migrations run them first by hand on the **direct** (non-PgBouncer) URL:
   `cd apps/api && DATABASE_URL=<direct> npx prisma migrate deploy`.
2. **Worker**: canavo-worker deploys from the same commit. API and worker must run the same version.
3. **Web**: Vercel builds `main` → production.
4. Old instances get SIGTERM: they stop accepting connections, drain in-flight requests (up to 10 s), close sockets,
   stop the outbox publisher and pg-boss, and disconnect Prisma. POS clients reconnect their sockets automatically.

## Verify (10 min)
1. `curl -fsS https://<api>/ready` → `{"ok":true,"db":"up"}`; Render health check green.
2. `psql "$DATABASE_URL" -f apps/api/scripts/qa/post-deploy-verify.sql` lists no problems;
   `npx prisma migrate status` → "Database schema is up to date!".
3. Staging only: `SMOKE_API_URL=https://<staging-api> npm run test:smoke -w @canavo/api` (needs a test hotel; never
   run against production with demo logins — production refuses to start if demo logins exist).
4. Production manual check (DEPLOYMENT.md §5): log in as an owner, bill one item, kitchen screen shows **Live** and the
   ticket, cancel the bill, open Reports → Sales.
5. Watch for 30 min: 5xx rate, p95, `canavo_outbox_pending`, error logs (alerts A1–A11 in [MONITORING.md](MONITORING.md)).

If any step fails and a fix is not obvious within 15 min → [RUNBOOK_ROLLBACK.md](RUNBOOK_ROLLBACK.md).

## After
Record in the release log: commit, migrations applied, verify results, anything unusual. Update release notes.
