# QA Phase 7 — dbb: indexes, query plans, RLS cost, connection pool

Agent dbb, branch `agent/dbb`, 2026-11-06. PostgreSQL 16.15 (docker, shared_buffers 128 MB, work_mem 4 MB,
max_connections 100), Prisma 6.19.3. Every plan and every API call ran as the **non-superuser app role**
(`canavo_app_it`) with `app.business_id` set, so row-level security was on as it is in production.

## What was checked, how

| Area | How |
|---|---|
| Dataset | `canavo_dbb_perf`, migrated with `prisma migrate deploy`, filled by `apps/api/test/db/perf-seed.sql` (generate_series): 3 businesses, 10 outlets, 200 staff, 600 menu items, **300k orders over 400 days, 1.05M order lines, 305k payments, 240k KOTs, 60k deliveries, 200k inventory transactions, 300k audit logs, 60k customers, 100k notifications, 68k attendance rows**. `VACUUM ANALYZE` after. Outlet 1 (the one measured) has ~36k bills/year (~90/day). |
| Real SQL | `apps/api/test/db/perf-capture.ts` boots the real API against that DB and calls 72 hot endpoints (bills list/filters/search/summary, all 12 reports for 30 days **and** 365 days, GSTR-1, daily, outlets overview, owner summary, KDS, delivery board, partner activity, channel board/orders, floor, storefront requests, cash shifts, inventory items/ledger/alerts/reports, customers list/search/lookup/detail/khata, audit log, notifications, attendance calendar/list/register, staff, staff performance, canteen lookup). `log_min_duration_statement = 0` on that database only captured 179 distinct statements with their parameters. |
| Plans | 46 statements (top 36 by server time + the KDS / delivery board / attendance / notifications / audit / channel / canteen / khata ones) re-run as `EXPLAIN (ANALYZE, BUFFERS, SETTINGS)` inside `BEGIN; set_config(...)`, median of 3, before and after the new indexes. Trimmed plans: [`query-plans/`](query-plans/) (one file per statement: SQL, params, before plan, after plan). |
| Indexes | `pg_stat_user_indexes` after the capture (scans per index), duplicates by prefix, enum columns in indexes vs. RLS. |
| RLS cost | Same counts as the app role vs. a superuser; policy variants tried on the perf DB only (reverted). |
| Pool | `apps/api/test/db/pool.test.ts`: child API processes with `?connection_limit=&pool_timeout=` in `DATABASE_URL`; table lock to make requests slow; `pg_terminate_backend` on the test DB's app-role backends; two hotels interleaved at high concurrency. |

Run: `npm run test:db -w @canavo/api` (with the IT_* env of the brief). Re-create the perf DB:
`createdb canavo_dbb_perf && DATABASE_URL=… npx prisma migrate deploy && psql -f test/db/perf-seed.sql`, grant the app role,
then `DATABASE_URL=<app role> npx tsx test/db/perf-capture.ts`.

## Results

### Indexes added (one CONCURRENTLY migration each, `migrate diff` empty afterwards)

| Migration | Index | Hot path | Before → after (plan, ms) |
|---|---|---|---|
| `20261106180000_idx_order_outlet_cancelled_at` | `Order(outletId, cancelledAt)` | voids in a period: daily close, exceptions report, outlets overview (20 calls per capture) | 12.1 → 0.4 and 12.7 → 0.35 (scanned all 36k bills of the outlet for one day) |
| `20261106180100_idx_kot_outlet_release_at` | `KotTicket(outletId, releaseAt)` | kitchen display (polled): "recent tickets OR released pre-orders" now a BitmapOr of two small index scans | 8.0 → 1.0 (filtered all 29k tickets of the outlet) |
| `20261106180200_idx_attendance_outlet_clock_out` | `StaffAttendance(outletId, clockOutAt)` | who is clocked in now (outlets overview, reminders, partner list) | 2.2 → 0.08 (whole attendance history) |
| `20261106180300_idx_order_cashier_created` | `Order(cashierId, createdAt)` | staff report "anyone who billed here" (per-staff EXISTS), staff performance; also indexes the `cashierId` FK | **4,681 → 94** (year), endpoint 3.3 s → 0.13 s |

All four scale with history, not with the day: without them the cost grows every day the outlet trades.

### Endpoint timings (wall clock, median of 3 after a warm-up, outlet 1 = 36k bills/yr)

| Endpoint | Before | After | |
|---|---|---|---|
| `GET /reports/sales` 365 days | **500** (bind-variable cap) | 200, 0.62–0.67 s | dbb-1 |
| `GET /reports/customers` 365 days | **500** (bind-variable cap) | 200, 0.22–0.32 s | dbb-1 |
| `GET /reports/canteen` > 32,767 bills | **500** (same pattern, test only) | 200 | dbb-1 |
| `GET /reports/staff` 365 days | 3.3 s | 0.13 s | dbb-3 |
| `GET /customers/:id` | 428 ms | 21–29 ms | dbb-2 |
| `GET /kot` | 19.6 ms | 13.5 ms | index |
| `GET /reports/daily` | 31 ms | 20 ms | index |
| `GET /orders` (list, filters) | 14–20 ms | same | OK |
| `GET /orders?search=…` | 30–34 ms | same | R6 |
| `GET /orders/summary` 365 days | 137 ms | 127–243 ms (noise) | R2 |
| `GET /reports/{items,categories}` 365 days | 0.94 s / 1.34 s | 0.56–0.64 s / 0.62–0.81 s | R2 |
| `GET /reports/profit` 365 days | 1.34 s | 1.72–1.75 s (noise) | R2 |
| everything else in the capture (49 endpoints) | ≤ 60 ms | ≤ 60 ms | OK |

Timings share one docker Postgres with ~15 other agents' databases, so ±50 % noise between runs is normal; plan
row counts and buffers are the reliable signal. `test/db/perf-capture.ts` reproduces the table.

### Query plans (46 statements; full list with plans in `query-plans/`)

No sort spilled to disk (all `quicksort`/`top-N heapsort` in memory, largest 2.6 MB). Seq scans on big tables only
appear (a) inside the RLS policy of child tables (Order scanned as the "parent" of OrderItem/Payment — R2), (b) the
customer-detail `_count` query (removed, dbb-2), (c) the staff report (index added, dbb-3), (d) `Delivery` for a
COD filter that matched no row in the data (not verified with real COD volume).

| # | Statement | calls | before ms | after ms | note |
|---|---|---|---|---|---|
| 000 | customer detail: recent bills `_count.items` | 4 | 398 | (removed) | Prisma counts a relation by GROUP BY over the whole OrderItem table, then RLS hash of all tenant orders — dbb-2 |
| 001/002 | GST / GSTR-1 order-line relation load (`orderId IN (…2.7k)`) | 8 | 108 / 104 | 106 / 124 | RLS: hashed seq scan of the tenant's 180k orders per statement — R2 |
| 003 | bills summary, payments by mode, 365 d | 12 | 135 | 180 | whole outlet + per-row RLS probe — R2 |
| 004 | bills search (ILIKE) | 4 | 22 | 22 | not leakproof → no index under RLS — R6 |
| 005 | sales report payments relation load | 4 | 80 | 103 | R2 |
| 007 | **KDS list** | 4 | 8.0 | **1.0** | new index |
| 008/010 | audit log page `count(*)` | 8 | 40 / 30 | 50 / 31 | 150k rows counted per page — R7 |
| 012/027 | **voids in a day** | 24 | 12.1 / 12.7 | **0.4 / 0.35** | new index |
| 013/014 | customers search | 16 | 16 / 14 | 17 / 16 | R6 |
| 017 | open bills count (`status = 'OPEN'`) | 20 | 19.6 | 19–40 (cache) | enum `=` not leakproof → status can't be an index condition — R1 |
| 026 | customers list (lastVisitAt DESC NULLS LAST) | 4 | 19 | 17 | top-N over all customers — R9 |
| 031 | **clocked in now** | 20 | 2.2 | **0.08** | new index |
| 900 | **staff report users (year)** | 4 | 4,681 | **94** | new index |
| others (30) | bills list/filters, reports, ledger, delivery board, notifications, attendance, audit page, channel, storefront, khata, canteen | | 0.05–30 | same | index scans on (outletId, createdAt) / (userId, createdAt) / (businessId, createdAt) as intended |

### Index usage and duplicates (after the capture)

* Used as designed: `Order(outletId, createdAt)` (312 scans), `Order_pkey` (5.1M probes — the RLS parent lookups),
  `OrderItem(orderId)`, `Payment(orderId)`, `Customer(businessId, phone)`, `Notification(userId, createdAt)`,
  `AuditLog(businessId, createdAt)`, `StaffAttendance(userId, workDate)`.
* **Enum columns in composite indexes are dead weight under RLS** (R1): `Order(outletId, status, createdAt)` (22 MB, 2 scans,
  both used only as an `outletId` prefix), `KotTicket(outletId, status)`, `Delivery(outletId, status)`,
  `Delivery(agentId, status)`, `TableSession(outletId, status)`, `CashShift(outletId, status)`… The planner can't put
  `status = …` into the index condition because `enum_eq` is not LEAKPROOF; it filters on the heap instead.
* Redundant prefixes: `Customer(businessId)`, `Coupon(businessId)`, `InventoryItem(businessId)` are prefixes of the
  `@@unique([businessId, …])` indexes. Small tables; not dropped (decision with R1).
* 0 scans in the capture but needed by other paths: `AuditLog(outletId, createdAt)` (managers), `AuditLog(entity, entityId)`,
  `InventoryTransaction(refType, refId)` (sale reversal), `Payment(corporateAccountId, createdAt)` (canteen statements, 12 MB of
  mostly NULLs — fine), `KotTicket(sessionId)`.

### RLS policy cost

| Measure (biz1, 180k of 300k orders) | superuser (no RLS) | app role (RLS) |
|---|---|---|
| `count(*) FROM "Order"` | 4.8 ms | 27 ms |
| `count(*) FROM "Order" WHERE outletId = …` | 1.1 ms | 2.9 ms |
| `count(*) FROM "OrderItem"` | 11 ms | **170 ms** |
| `count(*) … WHERE outletId = … AND status = 'OPEN'` | **0.055 ms** (index cond) | **16 ms** (heap filter) |

* `canavo_outlets()` is wrapped in `(SELECT …)` → one InitPlan per statement ✓. `outletId = ANY($0)` and the app's own
  `businessId = $n` / `outletId = $n` filters are leakproof `texteq` → index conditions ✓.
* `canavo_rls_bypass()` / `canavo_business()` are inlined to `current_setting(...)` and evaluated per row (STABLE). Measured
  cost is small (Order count 27 ms vs 22–26 ms with `(SELECT canavo_rls_bypass())`), and hoisting it made the child
  policies **5× worse** (OrderItem count 170 → 875 ms: the planner lost the hashed subplan). Keep the policies as they are.
* The real cost is the **child-table policy** `EXISTS (SELECT 1 FROM "Order" parent WHERE parent.id = …)` on OrderItem /
  Payment: any statement touching more than a few thousand lines builds a hash of *all the tenant's orders* (seq scan
  of Order, ~75–100 ms at 180k orders, growing with history) — R2.
* JIT: the policy subplans inflate plan costs past `jit_above_cost`; JIT then adds 10–165 ms (customer detail: 165 ms of
  JIT). With `jit = off` the same statements ran 10–25 % faster — R3.

### Connection pool (`test/db/pool.test.ts`, 4 tests)

| Test | Result |
|---|---|
| Pool exhausted (`connection_limit=2, pool_timeout=2`), 8 slow parallel requests (bills table locked) | 6 overflow requests return within ~2 s — **503 + `Retry-After`, JSON, no stack** (was **500**, dbb-4); the 2 holding requests finish 200 once the lock is released; then 6 parallel requests all 200. No hang. |
| All app-role backends killed (`pg_terminate_backend`) twice during 60 requests (4 parallel), then again before a single request, then before a write | **60/60 reads 200**, the next request after a kill 200, the write 201 (was: every stale pooled connection failed one request — 4 × 500 per kill, dbb-5). |
| HTTP tenant isolation: hotels A and B interleaved, 400 requests at concurrency 40 over a **3-connection** pool (bills list + menu) | **0 cross-tenant rows**; every response exactly the caller's 12 bills / 3 items. |
| Tenant client directly (fresh `src/db` with a **2-connection** pool): 300 interleaved tasks — hotel A, hotel B, platform context; raw `current_setting`, model queries, interactive transactions that throw | `app.business_id` always the caller's (empty for platform, `bypass_rls=off`), only own outlets visible, rollbacks don't leak; afterwards 10 raw queries without set_config see **no setting and 0 orders** (fail closed). **No leak.** |

## Defects (provisional IDs)

| ID | Sev | Area | Title | Repro | Expected / actual | Test | Fixed |
|---|---|---|---|---|---|---|---|
| dbb-1 | P1 | Reports | Sales, customers and canteen reports 500 when the range holds > 32,767 bills | Outlet with ~90 bills/day: `GET /reports/sales?from=<1 year ago>&to=<today>` | 200 / **500** "too many bind variables in prepared statement" — Prisma sends a filtered relation load (`payments where status`) and `in: orderIds` / `in: ids` as one `IN ($1…$n)` | `test/db/large-ranges.test.ts` (33,000 bills) | Yes: payments loaded unfiltered and filtered in code; id lists queried in 10k slices (`inChunks`) |
| dbb-2 | P2 | Customers | Customer detail took 0.43 s and grows with the whole order-line table | `GET /customers/:id` on 1M order lines | ~20 ms / 428 ms — Prisma's `_count: { items }` is `LEFT JOIN (SELECT orderId, count(*) FROM "OrderItem" GROUP BY orderId)` over every line, plus the RLS parent hash | `large-ranges.test.ts` (item counts kept) + plan `query-plans/000-*` | Yes: load the 10 bills' line ids and count them; same response shape |
| dbb-3 | P2 | Reports | Staff report over a year took 3.3 s (4.7 s plan) | `GET /reports/staff?from=<1 year ago>` | < 0.2 s / 3.3 s — per-staff `EXISTS` on `Order(cashierId, createdAt)` had no index → 80 seq scans | plan `query-plans/900-*` | Yes: index migration |
| dbb-4 | P2 | API errors | Database unavailable (pool timeout P2024, connection killed P1017) answered 500 "Internal server error" | Exhaust the pool / kill backends | retryable **503 + Retry-After** / 500 | `test/db/pool.test.ts` | Yes: `isDatabaseUnavailable` in `lib/http.ts` (still reported to error tracking) |
| dbb-5 | P2 | DB client | After the database closed pooled connections (failover, restart, idle kill) each stale connection failed one request | Kill backends, then 4 requests → 4 × 500 (pool of 21 on a 10-core box → up to 21 failures) | served / failed | `test/db/pool.test.ts` | Yes: model **reads** retried (≤ 10, immediate) on P1017; writes not retried (clean 503) |

## Recommendations (no failing behaviour; not changed)

* **R1 (decision needed) — enum equality under RLS.** `enum_eq`/`enum_ne` are not LEAKPROOF, so with row-level security on,
  `status = …` / `type = …` / `mode = …` filters are never index conditions (open-bill count 16–20 ms vs 0.06 ms; it scans the
  outlet's whole history and grows daily). Measured on the perf DB: `ALTER FUNCTION enum_eq(anyenum, anyenum) LEAKPROOF` (+ `enum_ne`)
  makes it 0.4 ms. It needs a superuser (not possible on most managed PostgreSQL) and isn't kept by `pg_dump`. Alternatives: text
  columns + CHECK for hot status columns, or keep time-bounded queries (as the KDS now is). Until decided, the `(…, status, …)`
  indexes only work as `outletId` prefixes.
* **R2 — child-table RLS.** OrderItem/Payment policies look up the parent Order; above a few thousand rows Postgres hashes every
  order of the tenant (75–100 ms at 180k orders, linear in history). Denormalise `outletId` onto OrderItem and Payment (policy
  `outletId = ANY((SELECT canavo_outlets()))`, index `(outletId, …)`) — a planned data migration, before tenants reach millions of lines.
* **R3 — `ALTER ROLE <app role> SET jit = off`** (or raise `jit_above_cost`): 10–25 % faster on the heavy statements, up to 165 ms saved.
* **R4 — statement/lock timeouts for the app role** (`statement_timeout` ≈ 30 s, `lock_timeout` ≈ 5 s): a request blocked on a lock
  holds its pooled connection indefinitely (seen in the pool test until the lock was released).
* **R5 — set `connection_limit` and `pool_timeout` explicitly in production `DATABASE_URL`** (none is set; Prisma defaults to
  2 × CPUs + 1 per process). Sum over API instances + worker must stay under `max_connections` (100 here).
* **R6 — free-text search** (`ILIKE '%…%'` on bills, customers, canteen employee code) can't use an index under RLS (not leakproof;
  a trigram index wouldn't be used either). Bills search scans the outlet's whole history (22 ms at 36k bills): default the search
  to a date window (e.g. 90 days) in UI/API; customer lookup by exact phone already uses the unique index.
* **R7 — audit log page** runs `count(*)` over the business's whole log per page (40 ms at 150k rows, linear): cap the count
  (e.g. "10,000+") or count only when filters are set.
* **R8 — reports over a year** (`profit` 1.7 s, `categories`/`items` 0.6–0.8 s) are bound by R2 and by loading every line into
  Node; fine as on-demand reports, but candidates for SQL aggregation if they become dashboards.
* **R9 — customers list** sorts all customers by `lastVisitAt DESC NULLS LAST` (19 ms at 30k): Prisma can't declare NULLS LAST in
  an index; revisit beyond ~200k customers per business.
* **R10 — redundant indexes** `Customer(businessId)`, `Coupon(businessId)`, `InventoryItem(businessId)` (prefix of a unique) can be
  dropped; decide together with R1 for the enum ones.

## Not verified, and why

* Production hardware / managed Postgres / pgbouncer: local shared docker only; timings are relative.
* COD-heavy delivery data: the seed has no COD deliveries, so the COD summary plan (seq scan on Delivery, 6 ms) isn't representative.
* Partial indexes (e.g. `WHERE status = 'OPEN'`): Prisma 6 can't declare them; a hand-written one would be dropped by the next `migrate diff`.
* Prisma engine edge seen outside the API: a bare client whose 2 idle connections (that had just run `pg_sleep`) were killed kept
  returning P1017 for ~15 s before reconnecting. Through the API (with the dbb-5 retry) every pattern tried recovered at once; if it
  happens, callers get a clean 503 + Retry-After.
* Write-path load (bill creation throughput under contention) — out of this scope.

Perf database `canavo_dbb_perf` was dropped after the run (re-create with the seed script).
