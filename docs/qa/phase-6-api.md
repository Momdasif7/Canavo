# Phase 6: API testing

Branch `qa/full-testing`, started from the latest product code (`feat/market-leader`). Phases 3 to 5 were skipped at the product owner's request; Phase 6 was run next.

## Result

| Suite | Command | Result |
|---|---|---|
| API suite (new) | `npm run test:api -w @canavo/api` | **711 passed, 1 skipped** (22 files, about 2 min) |
| Integration (existing) | `npm run test:integration -w @canavo/api` | 207 / 207 |
| Unit | `npm test` | shared 51, api 156 |
| Smoke (running stack) | `npm run test:smoke -w @canavo/api` | 17 / 17 |
| Typecheck and lint | api, web | clean |

**43 defects found (BUG-006 to BUG-048): 42 fixed and verified, 1 open.**

| Severity | Found | Fixed |
|---|---|---|
| P0 (money wrong, data leak, security) | 8 | 8 |
| P1 (feature broken) | 11 | 11 |
| P2 | 20 | 19 |
| P3 | 4 | 4 |

Every fix has a test that failed before the fix and passes after it. The full list is in [BUGS.csv](BUGS.csv).

## What the suite covers

All tests run the real app against PostgreSQL with row-level security on. The app connects as a non-superuser role, so the security policies really apply.

### Sweeps over every endpoint
These read the route list from the real routers (`test/api/routes.ts`): about 390 endpoints. A new endpoint is covered automatically.

- **Authentication** (`sweep-auth.test.ts`):
  - With no token, every endpoint must answer 401, except a reviewed allowlist of 24 public routes.
  - These tokens are refused everywhere: garbage, tampered claims, `alg=none`, expired, wrong secret, stale token version, unknown user, deactivated user.
- **Robustness** (`sweep-robustness.test.ts`): no 5xx and a standard JSON error body for:
  - hostile bodies: wrong types, SQL/XSS strings, huge values, prototype pollution, deep nesting, NUL bytes;
  - malformed JSON;
  - hostile query strings and hostile path parameters.

  The bodies are sent as owner, cashier and Super Admin.
- **OpenAPI contract** (`openapi-contract.test.ts`):
  - Every served endpoint is documented, and nothing documented is gone. 124 endpoints were added and one stale entry removed.
  - Every named request schema exists.
  - The committed docs must match the code.
- **HTTP behaviour** (`http-semantics.test.ts`):
  - CORS: allowed origin, look-alike origins, preflight, credentials.
  - Over 1 MB → 413. Unknown routes and methods → 404 JSON. HEAD.
  - Headers: security headers, `X-Request-Id`, rate-limit headers, `Cache-Control: no-store`.

### Per module
Each endpoint was tested on:
- status codes and response shape, including that no secret fields are returned;
- every role against the permission table, the module switched off, another hotel's ids, an outlet the user isn't assigned to, and Super Admin;
- input validation, including mass assignment, unicode, oversized, negative and float values;
- pagination and date ranges at IST day boundaries;
- idempotency and double submits.

| Area | File(s) | Tests | Codes | Authz | Validation | Pagination / dates | Idempotency / races |
|---|---|---|---|---|---|---|---|
| Auth (login, OTP, refresh, 2FA, password, sessions, preferences) | auth | 58 | ✅ | ✅ | ✅ | n.a. | ✅ refresh replay |
| Staff, custom roles, outlets, shifts | staff | 62 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Attendance and leave | attendance | 48 | ✅ | ✅ | ✅ | ✅ | — |
| Admin (settings, brand, audit log, Aadhaar, WhatsApp, backups) | admin | 36 | ✅ | ✅ | ✅ | ✅ | — |
| Platform and support access | platform | 24 | ✅ | ✅ | ✅ | n.a. | ✅ |
| Uploads and notifications | uploads-notifications | 39 | ✅ | ✅ | ✅ magic bytes, 5 MB, SVG, polyglot, traversal | ✅ | — |
| Orders, payments, cancel, refunds, receipts | orders | 114 | ✅ | ✅ | ✅ | ✅ | ✅ money races |
| Tables, tabs, KOT | tables-kot | 37 | ✅ | ✅ | ✅ | — | ✅ |
| Reservations and pre-orders | reservations | 34 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Delivery and COD cash ledger | delivery | 23 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Cash shifts, gift cards, settlements | cash-gift-settlements | 40 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Menu, tax rates, Excel import | menu | 28 | ✅ | ✅ | ✅ formula cells, internal image URLs | — | — |
| Inventory (47 endpoints) | inventory | 23 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Customers, loyalty, khata, offers | crm | 23 | ✅ | ✅ | ✅ | ✅ | ✅ |
| Reports and exports | reports | 10 | ✅ xlsx / pdf | ✅ | ✅ | ✅ 366-day cap | — |
| Canteen (accounts, members, wallets, meals, subscriptions) | canteen | 33 | ✅ | ✅ | ✅ | ✅ | ✅ no wallet overdraw |
| Channels, packing board, hub webhook | channels | 21 (1 skipped) | ✅ | ✅ | ✅ | ✅ | ✅ replays |
| Storefront, QR / online ordering, OTP, receipts, Razorpay webhook | storefront | 36 | ✅ | ✅ | ✅ price and quantity tampering | n.a. | ✅ OTP brute force, webhook replays |

## Most important fixes

- **Money races (P0).** These all happened when two requests reached the same bill at the same moment:
  - two tills collected the same bill;
  - a double-tapped cancel voided the bill twice and refunded the gift card twice;
  - two full refunds went through;
  - a refund and a cancel both went through;
  - a door collection and a counter payment both went through.

  Payments, cancels, refunds and delivery collections now lock the bill and re-check it first.
- **Other races (P1):**
  - double cash settle and double shift close;
  - two open tabs on one table;
  - a table double-booked;
  - a refresh token rotating twice (P0).
- **Tenant isolation:**
  - a menu item could point at another hotel's category (P0);
  - offers accepted other hotels' outlets;
  - a manager could read attendance for outlets they don't run;
  - a manager could remove staff from other outlets.
- **Public storefront:** the OTP lock could be bypassed by sending guesses in parallel (P0).
- **Robustness:** many 500s became 400s:
  - NUL bytes;
  - numbers too large for the database;
  - impossible dates;
  - bad timezones;
  - malformed uploads.
- **Other:**
  - Excel exports now escape formula-looking text.
  - Image URLs to internal addresses are refused.
  - Signed-in responses are never cached.
  - Saving the floor layout no longer always fails.

## API documentation

`npm run docs:api -w @canavo/api` writes:
- [docs/api/openapi.json](../api/openapi.json): 387 operations, with 117 request schemas generated from the code;
- [docs/api/canavo.postman_collection.json](../api/canavo.postman_collection.json): one folder per area, with `{{baseUrl}}`, `{{accessToken}}` and `{{outletId}}` variables.

## Open item and decisions for the product owner

1. **BUG-048 (open, P2 security): channel hub address.** A manager can set the hub address to an internal address. The "test connection" button then shows part of that server's reply. Fixing it needs a decision: allow only known hub hosts, or block private and loopback addresses (which also blocks the local fake hub used in development).
2. **Khata limit across two bills at once:** not locked per customer, so two simultaneous khata payments for the same customer could together go over the limit. Not yet tested.
3. **Voiding a cash-paid bill** doesn't change the cash shift's expected cash. What should the rule be?
4. **Accountants can upload settlement files**, which mark payments as settled. This follows the permission table (`report:view`). Should they be allowed to?
5. **Behaviour change from the BUG-009 fix (refresh race):** if an app sends two refreshes at once, the second is treated as a stolen token and that session is ended. This is the same as an ordinary token replay.
6. **Contract changes for app developers:**
   - A duplicate customer phone now returns 409, not 400.
   - Report, inventory and attendance dates must be real dates between 2000 and 2099.

## Noted, not changed (low risk)

- **Account probing:** login reveals "locked" or "suspended" before checking the password, and OTP request answers differently for a locked number and an unknown one (P3).
- **Unbounded values:**
  - inventory reports have no date-range cap;
  - stock adjustments accept very large quantities;
  - money inside offer settings has no upper limit.
- **Status codes:**
  - deleting a category that still has items returns 400, where 409 would be more accurate;
  - an already-reviewed leave returns 400 rather than 409.
- **Small parsing issues:**
  - `POST /orders/:id/cod` treats the string `"false"` as turning COD on;
  - settlements don't reject `from` after `to`.
- **Uploads:** uploaded images, including attendance selfies, are served without login. Their names carry 72 random bits.
- **Deployment:** the per-IP rate limits trust `X-Forwarded-For` from the gateway. Production traffic must always come through the proxy.
- **Flaky test:** `offline-series.test.ts` failed once and passed in four later runs. Its cause will be looked at in Phase 9 (concurrency).

## Not verified, and why

- Real Razorpay, UrbanPiper, WhatsApp and SMS traffic: no real credentials. Signed fake payloads and the fake hub were used instead.
- Backup restore end to end: it rewrites the whole database. Only access control and input checks were tested.
- Rate limits across several API instances: the limiter keeps its counts in memory, per process.

## How to run

```
npm run test:api -w @canavo/api          # needs Docker Postgres (npm run db:up)
npm run docs:api -w @canavo/api          # regenerate docs/api after changing routes or schemas
```
