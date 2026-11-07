# Phase 1: Foundation and data safety

| | |
|---|---|
| Branch | `feat/market-leader` (commits `a154ce1` … this commit) |
| Date | 2026-11-01 |
| Decisions applied | D4 pg-boss · D10 RLS (with a deviation, §Decisions) · D11 feature flags · D12 separate worker · D14 `AUTO_STOCK_OUT` behind a flag, on for Demo Hotel only |
| Tests | Unit **156** (shared 28, API 128) · Integration **37** on real Postgres as a non-superuser role · Smoke **17** · typecheck and lint clean |

## Summary

All 8 Phase 1 items are done, plus the two additions you approved in Phase 0 (hot-path indexes and route-level delivery guards). The improvements:

- **Another hotel's data is now refused by the database itself.** Before, it depended on every query remembering its filter.
- **"Order not reaching the kitchen" can't be caused by a crash any more.** Kitchen tickets and live updates are written to an outbox inside the same transaction as the bill.
- **Background jobs can run in a separate worker** and never run twice, however many servers run.
- **Retries are safe.** A double-tapped Pay or a request retried on a bad network doesn't create a second payment or bill.
- **Splitting a tab is all-or-nothing.**
- **Backups go off-site,** and a scripted restore drill proves they restore correctly, with matching money totals.
- **Production has** structured logs with request ids, metrics, an error-report hook, and a refusal to start with unsafe settings.

**Behaviour change for existing hotels: none.** The only behaviour behind a flag is automatic out-of-stock, which is ON for Demo Hotel only.

## What was built

| # | Item | What changed | Main files | Proven by |
|---|---|---|---|---|
| 1.1 | Postgres RLS | 48 tables, `FORCE ROW LEVEL SECURITY`, policies by business, outlet membership or parent. Transaction-local settings on every query and transaction. Platform-admin requests fail closed. Explicit bypass client for cross-hotel work. [ADR 0001](adr/0001-row-level-security.md) | `src/db.ts`, `prisma/migrations/20261101113736_row_level_security` | `test/integration/rls.test.ts` (9 tests, including a coverage test that fails when a new table has no policy) |
| 1.2 | Job queue + worker | 13 jobs on pg-boss: stately queues, one job per time window, 2 retries with backoff, dead-letter queue. `JOBS_MODE=embedded\|worker`; `src/worker.ts`; Render worker service. [ADR 0002](adr/0002-pg-boss-job-queue.md) | `src/jobs.ts`, `src/jobs-all.ts`, `src/worker.ts`, `render.yaml` | `jobs.test.ts`: 2 API instances + 1 worker on one DB, each window runs once, never overlapping. Retry and dead-letter are pg-boss settings and were not tested end to end (could-not-verify list) |
| 1.3 | Transactional outbox | KOT, order, menu and delivery events plus push and alerts written in the same transaction. SKIP LOCKED publisher with lease, backoff and dead letter after 8 tries. The worker emits through the outbox. Replaced the `setTimeout` "after commit" hacks. [ADR 0003](adr/0003-transactional-outbox.md) | `src/lib/outbox.ts`, `src/outbox-tasks.ts`, `services/billing.ts`, `services/service-context.ts` | `outbox.test.ts`: a rollback sends nothing, a crash after commit is still delivered on restart, a failing task is retried with its error kept |
| 1.4 | Idempotency keys | `Idempotency-Key` on every authenticated mutation: per user, request hash, replay with `Idempotent-Replayed`, 422 if the key is reused with a different body, 409 while in flight, 5xx not stored, 24 h TTL. Web and mobile send a key per call. | `src/lib/idempotency.ts`, `middleware/auth.ts`, web/mobile `api` helpers | `idempotency.test.ts` |
| 1.5 | Socket.io Redis adapter | Behind `REDIS_URL`. Without it, the server stays single-instance. | `src/realtime.ts`, `src/index.ts` | `redis-adapter.test.ts`: an event emitted on instance A reaches a client on instance B |
| 1.6 | Atomic tab split | All split bills, item marks and KOT links run in one transaction. Effects run after commit. | `routes/tables.ts`, `services/billing.ts` | `tab-split-atomic.test.ts`, written failing first |
| 1.7 | Off-site backups + drill | S3-compatible store (AWS S3, R2, B2, MinIO) or directory store. Copy after every backup. The list merges off-site copies, and a restore fetches an off-site-only copy (the worker and API have separate disks). Restore drill script. | `services/backup-store.ts`, `services/backup.ts`, `scripts/backup-drill*.ts` | `backup-store.test.ts` (contract test on both adapters), `backup-offsite.test.ts`, the drill run below |
| 1.8 | Observability | pino JSON logs with redaction; `X-Request-Id`; 5xx responses carry the `requestId`; `reportError` hook (Sentry-ready); Prometheus `/metrics` (token in production) with job counters and outbox gauges; crash handlers; graceful drain; production config fail-fast. | `src/lib/observability.ts`, `src/env.ts`, `lib/http.ts`, `src/index.ts` | `observability.test.ts` (unit and integration) |
| + | Indexes | 12 hot-path indexes (`OrderItem`/`Payment`/`KotTicket` by order, outlet + date, and others), built `CONCURRENTLY`. | 12 migrations `20261101111332`…`343` | `EXPLAIN` checks; latency below |
| + | Delivery guards | Shared delivery routes now check "manager OR assigned partner" at route level (`requireAnyPermission`). The route matrix understands any-of guards. | `routes/delivery.ts`, `middleware/auth.ts`, `tools/route-matrix.mjs` | `delivery-guards.test.ts` |
| + | Feature flags | `Business.features`, a registry in shared, `featureOn()`, Super Admin switches, effective flags in `/auth/me`. [ADR 0004](adr/0004-feature-flags.md) · [FEATURE_FLAGS.md](FEATURE_FLAGS.md) | `packages/shared/src/features.ts`, `services/features.ts`, `routes/platform.ts` | `feature-flags.test.ts` |
| + | CI | Lint plus the integration suite with Postgres 16 and Redis services. | `.github/workflows/ci.yml` | (runs on push) |

## Migrations

All migrations are additive. The rollback for each is below; run them in reverse order. The indexes are built `CONCURRENTLY`, one per migration, so they don't lock tables in production.

| Migration | Change | Rollback |
|---|---|---|
| `20261101111332` … `20261101111343` (12) | `CREATE INDEX CONCURRENTLY IF NOT EXISTS` on: `Delivery(outletId,createdAt)`, `InventoryTransaction(outletId,createdAt)`, `KotTicket(orderId)`, `KotTicket(sessionId)`, `KotTicket(outletId,createdAt)`, `Notification(userId,createdAt)`, `Order(outletId,status,createdAt)`, `OrderItem(orderId)`, `OrderItem(menuItemId)`, `Payment(orderId)`, `Recipe(inventoryItemId)`, `TableSessionItem(sessionId)` | `DROP INDEX CONCURRENTLY IF EXISTS "<Table>_<cols>_idx";` (for example, `"OrderItem_orderId_idx"`) |
| `20261101111737_business_features` | `Business.features JSONB NOT NULL DEFAULT '{}'` | `ALTER TABLE "Business" DROP COLUMN "features";` |
| `20261101112247_idempotency_keys` | Table `IdempotencyKey` + 2 indexes | `DROP TABLE "IdempotencyKey";` |
| `20261101112820_outbox` | Table `OutboxEvent` + index | Drain first (`SELECT count(*) FROM "OutboxEvent" WHERE "deliveredAt" IS NULL AND "failedAt" IS NULL` should be 0), then `DROP TABLE "OutboxEvent";` |
| `20261101113736_row_level_security` | 4 functions, `ENABLE` + `FORCE` RLS and a `tenant_isolation` policy on 48 tables | Per table: `DROP POLICY IF EXISTS tenant_isolation ON "<T>"; ALTER TABLE "<T>" NO FORCE ROW LEVEL SECURITY; ALTER TABLE "<T>" DISABLE ROW LEVEL SECURITY;` then `DROP FUNCTION canavo_outlets(), canavo_business(), canavo_platform(), canavo_rls_bypass();` |
| (runtime) pg-boss | Schema `pgboss`, created by pg-boss at start | Stop every API instance and worker, then `DROP SCHEMA pgboss CASCADE;` |

After a SQL rollback, also mark the migration rolled back: `npx prisma migrate resolve --rolled-back <name>`.

## Measurements

| What | Result |
|---|---|
| Latency with RLS on (dev data, local) | `GET /menu` p95 **10 ms**; `POST /orders` p95 **35 ms** |
| Restore drill (`npm run backup:drill`) on dev data | 13,646 rows backed up, restored into a scratch DB and compared. **All tables matched; paid total ₹2,17,246.50 matched exactly.** About 4 s end to end. |
| RPO / RTO | App backup alone: RPO ≤ 24 h. With provider PITR: minutes (turn it on before going live). App restore: about 4 s per 14k rows plus redeploy. Details in [DEPLOYMENT.md §6](../deployment/DEPLOYMENT.md#6-backups-and-recovery). |
| Production image | Docker build runs, migrations apply on start, `/ready` is OK, smoke 17/17 |

## Bugs found and fixed during Phase 1

| Id | Severity | What | Fix |
|---|---|---|---|
| BUG-006 | P1 | Owners never joined the outlet socket rooms, so their screens didn't get live updates | `realtime.ts`: owners join any outlet of their own business |
| (P1-a) | P1 | Daily backup failed once the outbox existed: JSON can't serialise `BigInt` | BigInt replacer/reviver in the backup format. The drill caught it. |
| (P1-b) | P0 if shipped | Lazy Prisma promises were awaited outside the tenant context, so they ran without the tenant filter or RLS settings | `runWithTenant` awaits thenables inside the context. Covered by the RLS tests. |
| (P1-c) | P2 | An empty `REDIS_URL=`, `BACKUP_S3_ENDPOINT=` or `METRICS_TOKEN=` in `.env` stopped the API at start | Empty optional values now mean "not set" (`src/env.ts`) |
| (P1-d) | P3 | Off-site store paths for directories were missing their separator | Fixed in `DirectoryStore.location` |

## Decisions and deviations (please confirm)

1. **RLS policies use outlet membership, not new `businessId` columns (D10).** Same strictness, no backfill on the largest tables, and the latency above is fine. Adding the columns stays an option for Phase 9 if reports need it.
2. **RLS was enforced straight away,** skipping the "permissive + logging" step I proposed. The integration suite exercises every route family as a non-superuser role, and the dev API ran the whole smoke suite with policies in place.
3. **Production must use a non-superuser database role** (Render/Neon defaults are fine). The check query is in DEPLOYMENT.md §1. Locally the Docker user is a superuser, so the dev API is not RLS-enforced. The integration suite is.
4. **Off-site retention is the bucket's lifecycle rule.** The app prunes only its local disk, so a compromised server can't delete the off-site copies when the keys are write-only.

## Risks

| Risk | Mitigation |
|---|---|
| A future SQL data migration sees no rows because of RLS, and silently does nothing | ADR 0001 rule: start such migrations with `set_config('app.bypass_rls','on',true)` |
| Someone uses `platformPrisma` in hotel code, bypassing RLS | It's used only in platform, realtime auth, backups and jobs. The route matrix plus review catch new uses. A lint rule can follow in Phase 12. |
| A worker outage stops scheduled jobs (auto-assign, alerts, daily backup) | Render restarts it. Job failures show on `/metrics`. Fallback: `JOBS_MODE=embedded` on the API. |
| Outbox backlog if the API is down | Events wait in the table and are delivered when the API returns. A gauge shows the pending count. |
| Extra monthly cost (worker, disk, bucket) | Optional. A single small server can run `embedded` with no worker. |

## Could not verify (running list)

| Item | Why | Plan |
|---|---|---|
| Render worker and blueprint deploy, Render PITR | Need your Render account | `render.yaml` validated with a YAML parser; deploy checklist in DEPLOYMENT.md |
| Real S3 / R2 / B2 upload | No real credentials (rule 6) | Contract-tested against an S3 wire-protocol stand-in; first real backup on staging |
| Production DB role has no `BYPASSRLS` | Need the provider's DB | Check query in DEPLOYMENT.md §1 |
| pg-boss retry → dead-letter path | Configured (`retryLimit 2`, `deadLetter`), not exercised by a test | Add a failing-job integration test in Phase 12 (engineering quality) |
| Redis on Render Key Value | Need your account | Cross-instance test passes on Redis 7 locally |
| Real WhatsApp delivery, GPS, printers, aggregators, legal readings | Carried over from Phase 0 | See phase-0.md §8 |

## Next

Phase 2 (Security and accounts) starts on your "continue". It needs decisions D2 (Aadhaar storage), D13 (SMTP or SMS required in production) and D16 (httpOnly cookies with custom domains).
