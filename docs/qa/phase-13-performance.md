# QA Phase 13: performance, load, stress, soak

Agent perf, branch `agent/perf`, 2026-11-08. How to rerun everything: [`apps/api/perf/README.md`](../../apps/api/perf/README.md).
**Setup:** throwaway DB `canavo_perf` (`perf/seed.sql`): 50 hotels, 1,000 staff, 6,000 menu items, 200k customers, **1M bills over a year**,
3.5M bill lines, 970k payments, 800k KOTs, 500k audit rows (2.2 GB). API `NODE_ENV=production` on :4200, one process, pool 20,
app role without RLS bypass, jobs embedded. k6 (`grafana/k6` in docker) on the **same 10-core laptop**. Docker Postgres 16 shared with ~15
other agents' databases (shared_buffers 128 MB). Load average was 15–17 during the big runs, so these are floor numbers, not capacity numbers.

## Results vs targets (after fixes unless marked)

| Scenario | Load | Result | Target |
|---|---|---|---|
| Lunch rush (`lunch-rush.js`, 5 min) | 50 cashiers each creating + paying a bill every 2–4 s, 50 KDS polling every 3 s, 5 online-menu views/s | bill create **p95 91 ms**, pay 61 ms, KDS 48 ms, online menu 179 ms, **0 / 20,766 errors** | ✅ < 500 ms, < 0.1 % |
| Lunch-rush start, before perf-2 | 100 devices log in at once | login p95 3.4 s; menu first load p95 **2.8 s** (event loop held by bcrypt) | ❌ → fixed |
| Login storm (`login-storm.js`, 30/s for 1 min) | 1,700 logins, bcrypt cost 10 | before: p95 **10.6 s, 17.6 % failed**. After perf-2: **p95 64 ms, 0 failed**. Ceiling ≈ 58 logins/s per process | ✅ |
| 1-year reports, single call, outlet 1 (84k bills, 294k lines) | idle, `perf/n1-scan.ts` | sales 3.7 → **1.3 s**, items 3.6 → **1.2 s**, categories 4.0 → **1.0 s**, profit 5.7 → **1.0 s**; gst 0.7, customers 0.4, peak-hours 0.4, staff 0.2 s | ✅ < 3 s |
| Reports during the rush (`reports.js`, 3 min) | 10 owners opening 1-year reports back to back + 50 cashiers | 3 runs: report p95 2.2 / 3.2 / 3.8 s, bill create p95 **0.86 / 1.8 / 1.5 s**, 0 errors. Bills slow down because the DB and CPU are saturated; capping concurrent reports at 4 didn't help (tried, then reverted). See R6 | ❌ bills / ≈ reports |
| Menu load (`menu-load.js`, 2 min) | 100 POS devices loading the menu every 0.5 s + 20 online views/s (≈ 130–157 req/s) | menu p95 0.5–0.8 s, online page p95 1.2–1.6 s, 0 errors. Every core was busy (API 355 %, Postgres 97 %, k6 95 %): this is the laptop's limit, not a query problem. At lunch-rush load the online page is 179 ms | ❌ on this box |
| Bulk menu upload (`menu-import.js`) | 20 owners × 500-row CSV, applied twice | avg 7.8 s, p95 **12.5 s**, 0 errors (one statement per row in a single transaction; perf-R2) | ❌ 10 s |
| **Stress** (`stress.js`) | cashiers 50 → 700 in 90 s steps, 1 s think time, + 50 KDS | **breaking point ≈ 240 cashiers busy at once** (≈ 100 req/s, 45 bills/s): p95 went over 2 s and the run stopped. **0 errors** up to there. RSS ≤ 414 MB, DB connections ≤ 30 (pool 20 + pg-boss) | n/a |
| **Spike** (`spike.js`) | 50 → 400 cashiers in 10 s, held 1 min | **0 / 22,098 errors**; p95 4.3 s during the spike, median 174 ms; event-loop lag and socket handles back to baseline within one sample after the spike | no errors ✅ |
| **Soak** (`soak.js`, 35 min) | busy day: 50 cashiers, 50 KDS, 2 online views/s, 2 owners running 1-year reports | 82,586 requests, **1 failed** (k6 docker `dial: i/o timeout`, client side; no API error logged). bill p95 280 ms, pay 156 ms, KDS 204 ms, online 246 ms, 1-year report 2.6 s | ✅ |

## Soak findings (35 min; 8-hour procedure in the README)

No leak seen. Sampled every 30 s (`perf/soak-watch.sh`): **RSS** swung between 260 and 560 MB with GC and had no upward trend
(436 MB at minute 4, 361 at minute 35). **Heap** used stayed in 85–260 MB. **DB connections** were 26–31 the whole time (pool 20 + pg-boss 10),
with 0–6 active. **Socket handles** were flat at ~120 under load and back to **7** one minute after the run. **Event-loop lag** p99 was 21–52 ms
(the integration suites were running on the same machine for part of the soak) and back to 11 ms afterwards. Open fds were flat at about 216 and
back to 103 afterwards.

## N+1 and slow queries (Prisma query log, `PRISMA_QUERY_LOG=1` + `perf/n1-scan.ts`)

- No N+1 on the hot paths. Statements per request: bill create 39 (4 outbox inserts, no per-line loop), pay 32, `/menu` 10, `/kot` 6, `/orders?limit=50` 11, online page 14.
- The slow ones were **reports that loaded every bill line into Node** (294k rows on a busy year, then summed in JS) and the sales report's
  per-bill payment load in 3 chunks. That cost 2–4 s of Prisma row decoding per report (perf-1).
- The online menu did a 30-day best-seller sum over all lines **on every customer view** (138 ms of its 181 ms; perf-3).
- No new index needed: plans use the Phase 7 indexes. What is left is row-level-security cost (the OrderItem/Payment policy checks the parent
  bill once per row: 294k index probes for a year of items, Phase 7 R2) and I/O with a 128 MB buffer cache on a 2.2 GB database.
- Pay re-reads the bill 4 times, and the customers report runs 9 chunked loyalty sums (bind-variable cap). Both are small; left as is.

## Web (production build of this worktree, `next start` on :3290 → API :4200; Lighthouse 12.2.1 mobile, throttled)

| Page | Perf | A11y | Best pr. | FCP | LCP | TBT | First-load JS |
|---|---|---|---|---|---|---|---|
| `/login` | 94 | 95 | 100 | 0.9 s | 3.0 s | 0 ms | 198 kB |
| `/pos` (signed-out shell) | 86 | 95 | 100 | 0.9 s | 4.3 s | 0 ms | 239 kB |
| `/o/hotel-1` online ordering (120 items) | 82 | 96 | 100 | 1.1 s | 3.6 s | 350 ms | 172 kB |

Largest routes (`next build`): `/delivery/dashboard` 295 kB, `/reports/*` 271–274 kB (recharts), `/dashboard` 265 → **166 kB** (perf-5),
`/pos` 239 kB, `/tables` 233 kB; shared by all 88 kB. The online page's menu JSON comes uncompressed from the API (25 KB, 23 KB could be saved).

## Fixes

| ID | Fix | Effect |
|---|---|---|
| perf-1 | `reports.ts`: sales payment modes, items / categories and profit are summed in PostgreSQL (`groupBy` / `aggregate`) instead of loading every bill and line. Profit's recipe estimate = all paid lines − lines of bills that have stock movements (same formula, summed). Test `test/api/report-aggregates.test.ts` recomputes every figure row by row; it passes on the old code and on the new code | 1-year reports 3.6–5.7 s → 1.0–1.3 s |
| perf-2 | `lib/bcrypt-pool.ts`: bcrypt compare / hash run on up to 4 worker threads (`BCRYPT_THREADS`), with an in-process fallback. Used by login, PIN, staff, platform and password links | login storm p95 10.6 s → 64 ms, errors 17.6 % → 0; logins no longer stall bills |
| perf-3 | `storefront.ts`: best sellers cached per outlet for 10 min (not in tests) | removes the 138 ms query from every online-menu view |
| perf-5 | web `/dashboard`: hourly chart (recharts) loaded with `next/dynamic` | first-load JS 265 → 166 kB |
| tooling | `PRISMA_QUERY_LOG=1` query events (off by default), `perf/n1-scan.ts`, `perf/seed.sql`, `perf/k6/*.js`, `perf/soak-watch.sh`, `perf/api.env` | |

**Recommendations, not fixed:** R1 compress API responses (gzip at the proxy or in Express: `/orders?limit=50` is 143 KB, `/kot` 119 KB per poll,
menu 25 KB). R2 bulk menu import: `createMany` for new rows instead of one statement per row. R3 load recharts lazily on `/reports/*` too
(about 100 kB per page). R4 production Postgres: set shared_buffers to ~25 % of RAM. 128 MB means the year-long reports read from disk.
R5 under heavy CPU load, 30 bills at once on **one** outlet can make the invoice-counter transaction exceed Prisma's 5 s interactive
timeout (9 × 500 in `test/db/transactions.test.ts` while the soak was running; passes on a quiet machine). Consider a longer
timeout or taking the counter as late as possible. R6 heavy reports slow bills on the same database (bill p95 0.9–1.8 s with 10 owners running 1-year reports back to back): run reports on a read replica, or pre-aggregate daily totals.

## Not verified

Mobile cold start: needs a real device (simulators don't give representative numbers). 8-hour soak: 35 min only; the steps are in the README.
More than one API process with Redis. Production-sized Postgres on its own host. k6 on separate hardware (it used about a core here).
Lighthouse on a signed-in POS with a real menu (the signed-out shell was measured; the JS it loads is the same). Kitchen display over sockets
under load (the 200-socket test is in Phase 10).

**Regression (canavo_it_perf):** `tsc` clean for api and web. `test:api` 809/809. Integration 227/228 and `test:db` 10/11 files while the soak was
loading the machine: the misses were the 200-socket latency bound (2.3 s vs 2 s) and R5. Both files pass when re-run alone (21/21, 15/15).
