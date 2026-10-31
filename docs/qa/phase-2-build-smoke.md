# Phase 2: Build health, smoke and sanity (in progress, paused)

Paused on 2026-10-31 at the product owner's request, to implement five product changes first (see "Interruption" below). These items are still to do before Phase 2 is complete: the UI smoke suite (Playwright) and the SANITY checklist.

## Build health (clean clone of `qa/full-testing`)

| Step | Result | Time |
|---|---|---|
| `npm ci` (root workspaces) | ✅ | 18 s |
| `npm run build -w @canavo/shared` | ✅ | 3 s |
| `npm run typecheck` (shared, api, web) | ✅ | 54 s |
| `npm test` | ❌ → ✅ after BUG-001 fix: 28 shared + 91 API tests | 5 s |
| `npm run lint` | ❌ → ✅ after BUG-002 fix: 0 errors, 3 warnings (react-hooks/exhaustive-deps → Phase 3) | 1 s |
| `npm run build` (web production build) | ✅ | 23 s |
| Mobile `npm ci` + `tsc --noEmit` | ✅ | 9 s + 8 s |
| Mobile `expo export --platform android` | ✅ 4.89 MB Hermes bundle | 27 s |
| `prisma migrate deploy` on an empty DB | ✅ 11 migrations (now 13) | — |
| Seed on empty DB, and again (idempotency) | ✅ both; the second run skips (1 business, 7 users, 22 items, 1,660 orders unchanged) | 4 s |
| API Docker image build + production-mode run | ✅ `/ready` 200, migrations on start, refuses to start without `DATA_ENCRYPTION_KEY` | 3 min 22 s |

## Smoke suite (API), `npm run test:smoke -w @canavo/api`

17 checks in about 1 s against a running stack (`SMOKE_API_URL`, default `http://localhost:4000`). It covers:
- health;
- login for all 7 roles, and that each role's permissions are correct;
- the kitchen socket connecting;
- a cashier bill whose KOT is pushed live to the kitchen and appears in the kitchen list;
- cash payment → PAID;
- the owner's sales report loads, and inventory is refused it;
- the Super Admin is refused hotel data;
- logout revokes the refresh token.

The bill it creates is cancelled afterwards. Result: **17/17 pass**.

## Defects found

BUG-001 and BUG-002 are fixed and verified; see [BUGS.csv](BUGS.csv).

## Observations for later phases

- Logout revokes refresh tokens only; an access token stays valid until it expires (Phase 8: decide on short TTL vs. a deny-list).
- `/docs` (Swagger UI) is served in production mode (Phase 8/16).
- A bill can be cancelled after it is paid (Phase 8 business-logic review: refunds, stock and loyalty reversal).

## Interruption: product changes implemented on this branch (2026-10-31)

| # | Change | Verified by |
|---|---|---|
| 1 | Bills: date presets, custom range, Previous/Next day, payment mode / order type / status filters, summary per mode, Load more, Excel export, URL-kept filters | live API checks (10), BUG-004 checks, browser run |
| 2 | WhatsApp per hotel: Meta Cloud API / WATI / none, encrypted tokens, templates per purpose, test send, automatic delivery updates, staff alerts, click-to-chat fallback | 13 unit tests (mock Meta/WATI server), live checks against a mock provider |
| 3 | Hotel logo + name in the sidebar, business label removed from the top bar (platform console keeps CANAVO) | browser run |
| 4 | Automatic out of stock from ingredient stock, auto back on restock, manager notifications, offline bills still accepted | 8 unit tests, 11 live checks |
| 5 | Separate deployment: Vercel (web) + Render (API) + managed Postgres; `/ready`, CORS wildcards, trust-proxy env, prod seed guard, `create-admin` script, deployment guide | Docker build + prod-mode container run, CORS unit tests |

Defects found while doing these: BUG-003 (owner audit log), BUG-004 (failed UPI counted as collected, caught before release) and BUG-005 (WhatsApp token echoed in provider errors). All are fixed with failing-first tests.
