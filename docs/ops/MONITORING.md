# Monitoring and alerts

## Endpoints
| Endpoint | Use |
|---|---|
| `GET /health` | Liveness: process is up (no DB call). Not logged. |
| `GET /ready` | Readiness: `SELECT 1` on the database → `200 {ok:true,db:"up"}` or `503 {db:"down"}`. Render `healthCheckPath`. |
| `GET /metrics` | Prometheus text. In production it answers only with `Authorization: Bearer $METRICS_TOKEN` (16+ chars), otherwise 404. |

## Metrics exposed (`apps/api/src/lib/observability.ts`, `app.ts`)
- `canavo_http_request_duration_seconds{method,route,status}` histogram (route = matched pattern, bounded cardinality)
- `canavo_errors_total{kind}` — `request`, `unhandledRejection`, `uncaughtException`, job errors
- `canavo_job_runs_total{job,result}` — background job runs (worker process)
- `canavo_outbox_pending`, `canavo_outbox_dead` — realtime outbox backlog / dead-lettered events (−1 = query failed)
- Node defaults with prefix `canavo_`: `canavo_process_resident_memory_bytes`, `canavo_nodejs_heap_size_used_bytes`,
  `canavo_nodejs_eventloop_lag_p99_seconds`, `canavo_process_cpu_seconds_total`, …

The worker has no HTTP port: watch its job counters through logs (`[job:*]` lines) or scrape the API (same DB).

## Alert list (starting thresholds — tune after 2 weeks of pilot data)
| # | Alert | Condition | Sev |
|---|---|---|---|
| A1 | API not ready | `/ready` non-200 for 2 min (external uptime probe) | P1 |
| A2 | 5xx rate | `sum(rate(..._count{status=~"5.."}[5m])) / sum(rate(..._count[5m])) > 2 %` for 5 min | P1 |
| A3 | p95 latency | `histogram_quantile(0.95, …) > 1 s` for 10 min (Phase 13 soak: bill p95 280 ms; p95 > 2 s at ≈240 busy cashiers per instance) | P2 |
| A4 | Billing latency | p95 of `route="/orders"` POST > 1.5 s for 5 min | P1 |
| A5 | Outbox backlog | `canavo_outbox_pending > 500` for 5 min (KDS / POS live updates delayed) | P2 |
| A6 | Outbox dead letters | `increase(canavo_outbox_dead[1h]) > 0` | P2 |
| A7 | Job failures | `increase(canavo_job_runs_total{result="error"}[1h]) > 3`, or `daily-backup` error once | P2 |
| A8 | Event-loop lag | `canavo_nodejs_eventloop_lag_p99_seconds > 0.2` for 5 min | P2 |
| A9 | Memory | RSS > 80 % of instance memory for 10 min, or heap used growing 6 h straight (Phase 13 soak: RSS 260–560 MB with GC, heap 85–260 MB, no trend) | P2 |
| A10 | Crashes | `increase(canavo_errors_total{kind="uncaughtException"}[10m]) > 0` / container restarts > 2 in 15 min | P1 |
| A11 | DB pool waits | 503 responses with `Retry-After` (P2024 pool timeout) > 1 % of requests, or DB connections > 80 % of `max_connections` | P1 |
| A12 | Backup age | newest backup (Admin → Backups or S3 listing) older than 26 h | P1 |
| A13 | Disk | Render disk (`/repo/apps/api/storage`, 5 GB) or DB storage > 80 % | P2 |
| A14 | Reconciliation | nightly read-only run of `docs/qa/sql/reconciliation.sql`: any `@check` row | P1 |
| A15 | Auth abuse | 429 rate on `/auth/*` > 50/min (credential stuffing) | P3 |

## DB pool sizing
Prisma's default pool is `num_cpus × 2 + 1` per process, and none is set today (QA Phase 7 dbb R5). Set it explicitly:

```
DATABASE_URL=postgresql://user:pass@host:5432/canavo?schema=public&connection_limit=10&pool_timeout=10
```

- `connection_limit` per process. Budget: `(API instances × limit) + (workers × limit) + pg-boss (~10 per process
  running jobs) + migrations/admin (5) ≤ max_connections × 0.8`. Render basic-256mb allows ~100 → e.g. 1 API × 20 +
  1 worker × 10 + pg-boss 10 + 5 = 45.
- `pool_timeout` (s): how long a request waits for a connection; on timeout the API answers **503 + Retry-After**
  (dbb-4), not 500. 10 s is a sane production value; Phase 13 ran pool 20 (+10 pg-boss) with ≤ 31 connections in use.
- Behind PgBouncer (transaction mode) add `pgbouncer=true`, and run `prisma migrate deploy` on the **direct** URL.
- Stale connections after a failover are retried for reads (dbb-5); writes fail with a clean 503.
