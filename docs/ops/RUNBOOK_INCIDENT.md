# Runbook: incident response

## Severity
| Sev | Meaning | Examples | Response |
|---|---|---|---|
| SEV1 | Outlets cannot bill, money wrong, data leak across businesses, data loss | API down, `/ready` 503, payments double-counted, tenant sees another's bills | Page on-call now; updates every 30 min; fix or rollback within 1 h |
| SEV2 | Major feature broken, workaround exists | KDS not live, reports failing, online orders not arriving, backup job failing | Within 1 h in business hours; updates every 2 h |
| SEV3 | Minor / single outlet | one printer, slow report | Next business day |

## First 15 minutes
1. **Acknowledge** the alert; one person is incident lead (decides), one investigates. Open an incident channel/note.
2. **Scope:** all outlets or one? Since when? Did a deploy happen (Render deploy list, Vercel)? → if yes and it fits,
   [roll back](RUNBOOK_ROLLBACK.md) first, investigate later.
3. **Look:** `/ready`; Render metrics (CPU, memory, restarts); `/metrics` (5xx rate, p95, `canavo_outbox_pending`);
   logs filtered by `level>=50`, or by the `X-Request-Id` a user reports.
4. **Communicate:** status note to affected outlet owners (in-app / WhatsApp / email): what's affected, workaround
   (POS offline mode keeps billing; bills sync later), next update time. The Super Admin never sees store data — use
   support access only with the owner's consent.

## Common incidents
| Symptom | Likely cause | Action |
|---|---|---|
| `/ready` 503, all requests 503 with `Retry-After` | DB down / pool exhausted (P2024) / failover | Provider status; DB connections vs `max_connections`; long-running queries (`pg_stat_activity`, kill blockers); if pool too small, raise `connection_limit` ([MONITORING.md](MONITORING.md#db-pool-sizing)). Reads auto-retry stale connections after failover. |
| API restarts in a loop, log "REDIS_URL is set but Redis is unreachable" | Redis down: the API **exits by design** rather than run with split realtime | Restore Redis, or (single instance only) unset `REDIS_URL` and redeploy. |
| API exits at start "Refusing to start in production" / "Invalid environment configuration" | Env fail-fast (bad secret, localhost URL, CORS `*`, demo logins present) | Fix the env var named in the log; never use `SKIP_PROD_CONFIG_CHECK` in production. |
| KDS / POS not updating live, `canavo_outbox_pending` rising | Outbox publisher stalled, Redis adapter issue, API overloaded | Check API logs `[outbox]`; restart API instance (outbox rows survive, delivered after restart); dead letters: `canavo_outbox_dead`. |
| Scheduled reports / backups / alerts not happening | Worker down or jobs failing | canavo-worker logs `[job:*]`; restart worker; pg-boss double-run is safe. |
| Many 429 on `/auth/*` | Credential stuffing, or many staff behind one NAT IP (50 req / 15 min / IP on login) | Check source IPs; if legitimate shared IP, verify `TRUST_PROXY` gives real client IPs; block abusive IPs at the edge. |
| Slow everything at peak, p95 > 2 s | Capacity (≈240 busy cashiers per instance in Phase 13) or heavy 1-year reports | Scale API (needs `REDIS_URL` for >1 instance), larger DB plan; ask owners to run long reports off-peak. |
| Bills fail after a platform restore | sequences behind (fixed dbc-1) | Run `post-deploy-verify.sql`; report a bug. |
| Suspected data leak / breach | — | SEV1. Preserve logs, rotate secrets (JWT secrets → everyone logged out), notify per DPDP / CERT-In (6 h) obligations. |

## Deploys and restarts are safe
On SIGTERM the API stops accepting connections, drains in-flight requests (max 10 s), closes Socket.io, stops the outbox
publisher and pg-boss and disconnects Prisma; clients reconnect. Idempotency keys make retried bills safe.

## Closing
Resolve when metrics are normal for 30 min. Within 3 business days write a blameless post-mortem: timeline, impact
(outlets, minutes, bills), root cause, what went well, action items (each with owner + date, a regression test for code bugs).
