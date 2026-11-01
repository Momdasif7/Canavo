# ADR 0002: Background jobs on pg-boss, with a separate worker

| | |
|---|---|
| Status | Accepted (Phase 1.2, 2026-11-01) |
| Decision refs | D4 (pg-boss), D12 (separate worker + in-process switch) |

## Context

Before Phase 1, the 13 scheduled jobs ran on `setInterval` inside the API, with an in-memory "no overlap" flag. Two API instances would run every job twice (two auto-assigns, two report emails). There were no retries and no record of failures.

## Decision

Use **pg-boss 10** with its queue in Postgres (schema `pgboss`). This adds no new infrastructure.

**Per job** (`registerJob(name, everyMs, fn)` in the `jobs-*.ts` files):
- One queue per job, policy `stately`: at most one job queued and one active.
- `retryLimit 2` with exponential backoff, then a dead-letter queue `<name>.dead`, kept 14 days.

**Ticking.** Every `everyMs`, each process calls `send(name, {}, { singletonKey, singletonSeconds: window })`. Any number of processes can tick, but **one job is created per time window**. This is what removes double execution.

**Where jobs run** is set by `JOBS_MODE`:

| Value | Behaviour |
|---|---|
| `embedded` (default) | The API process ticks and works. Fine for one small server and for local development. |
| `worker` | The API runs no jobs. `node dist/worker.js` (Render service `canavo-worker`) does. |

Running several workers or API instances is safe in either mode.

**Monitoring.** The Prometheus counter `canavo_job_runs_total{job,result}` counts runs, and errors go to the error-report hook.

## Alternatives

**BullMQ on Redis.** Mature, but Redis would become required infrastructure, with its own persistence and backups. Redis stays optional: it's only for the Socket.io adapter (ADR 0003 notes).

## Consequences

- Job state lives in the same database, so pg-boss tables are part of database backups and PITR. The app's NDJSON backup covers only Prisma models, which is fine because jobs are re-created by ticking.
- A Render Background Worker is an extra paid service. For a single small server, use `JOBS_MODE=embedded` and remove the worker from `render.yaml`.
- The worker has its own disk, so daily backups land there. They reach the API through the off-site store (see DEPLOYMENT.md §6).
- **Rollback:** set `JOBS_MODE=embedded` on the API and stop the worker. The `pgboss` schema can be dropped with `DROP SCHEMA pgboss CASCADE` once no process is running.
