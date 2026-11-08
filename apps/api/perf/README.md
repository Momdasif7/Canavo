# CANAVO load tests (QA Phase 13)

k6 scenarios against a production-like API on a SaaS-sized dataset. Results: `docs/qa/phase-13-performance.md`.

## 1. Dataset (throwaway database)

```sh
cd apps/api
createdb -h localhost -p 5433 -U canavo canavo_perf
DATABASE_URL=postgresql://canavo:canavo@localhost:5433/canavo_perf npx prisma migrate deploy
psql -h localhost -p 5433 -U canavo -d canavo_perf -v ON_ERROR_STOP=1 -f perf/seed.sql      # ~2 min
psql -h localhost -p 5433 -U canavo -d canavo_perf -c "SET max_parallel_maintenance_workers=0" -c "VACUUM ANALYZE"
# app role (non-superuser, so row-level security is real) — same grants as test/integration/global-setup.ts
```

50 hotels (`out1`…`out50`, outlet 1 busiest ≈ 84k bills/yr), 1,000 staff, 6,000 menu items, 200k customers,
1M orders over 365 days, 3.5M order lines, 970k payments, 800k KOTs, 500k audit rows (2.2 GB).
Logins: `u<outlet>_<n>@perf.local` / `Perf@12345` (n=1 owner, 2–8 cashier, 9–14 kitchen, 15–20 delivery).
Online page: `/public/o/hotel-<n>`.

## 2. API

```sh
cd apps/api && (set -a; . perf/api.env; set +a; npx tsx src/index.ts)    # NODE_ENV=production, port 4200, pool 20
```

## 3. Scenarios (`perf/k6/`, run with docker)

```sh
cd apps/api/perf/k6
docker run --rm -v "$PWD":/s -w /s grafana/k6 run lunch-rush.js            # BASE_URL defaults to http://host.docker.internal:4200
```

| Script | What | Target (threshold) |
|---|---|---|
| `lunch-rush.js` | 50 cashiers create + pay bills (one every 2–4 s), 50 kitchen screens poll `/kot` every 3 s, 5 online-menu views/s | p95 bill create < 500 ms, errors < 0.1 % |
| `menu-load.js` | 100 POS devices loading the menu + 20 online-menu views/s | p95 < 300 ms |
| `reports.js` | 10 owners of the busiest hotels open 1-year reports during the lunch rush | p95 < 3 s |
| `login-storm.js` | ramp to `PEAK`/s logins (default 30) for a minute (bcrypt cost 10) | p95 < 1 s |
| `menu-import.js` | 20 owners upload a 500-row CSV menu with `?apply=1`, twice | p95 < 10 s |
| `stress.js` | cashiers 50 → 700 (`MAX_VUS`) in 90 s steps; aborts at p95 > 2 s or errors > 1 % | breaking point |
| `spike.js` | 50 → 400 (`SPIKE`) cashiers in 10 s, 1 min, back to 50 | recovery |
| `soak.js` | busy-day mix for `DURATION` (default 40m) | leaks |

Each virtual device sends its own `X-Forwarded-For` (the API trusts loopback / private proxies, as behind a
load balancer); without it all traffic is one IP and the per-IP login limit (50 / 15 min) is what you measure.

## 4. Soak (8 hours)

```sh
API_PID=$(pgrep -f "tsx src/index.ts") METRICS_TOKEN=perf-metrics-token-0123456789 INTERVAL=60 perf/soak-watch.sh > soak.csv &
docker run --rm -v "$PWD/perf/k6":/s -w /s -e DURATION=8h grafana/k6 run --summary-export /s/soak-summary.json soak.js
```

Pass: RSS / heap flat after warm-up (no upward trend over hours), DB connections ≤ pool size (20 + pg-boss 10),
event-loop lag p99 < 50 ms, socket handles return to baseline after the run, k6 thresholds green. Access tokens
expire after 15 min; the scripts log in again every 12 min.

## 5. N+1 / slow queries

```sh
DATABASE_URL="postgresql://canavo_app_it:canavo_app_it@localhost:5433/canavo_perf?schema=public" npx tsx perf/n1-scan.ts   # VERBOSE=1, ONLY=<regex>
```

`PRISMA_QUERY_LOG=1` makes the Prisma client emit query events (off by default). The scan prints per endpoint
the statement count, DB time, slowest statement and the most repeated statement shape.
