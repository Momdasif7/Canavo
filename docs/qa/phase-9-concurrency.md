# Phase 9: Concurrency, resilience, data integrity

New suite `apps/api/test/db/concurrency.test.ts` (17 tests, real PostgreSQL with RLS, parallel HTTP requests). It covers the gaps left by Phases 6–7, which already covered same-clientId sync, invoice numbers, payment races, rollback, killed connections, deadlock retry and the jobs test.

## Result

| Suite | Result |
|---|---|
| `concurrency.test.ts` | 17 / 17 (3 consecutive runs); 8 failed on the code before the fixes |
| Integration (full) | 207 / 207 (31 files) |
| API (`test:api`) | 792 / 792 |
| Database (`test:db`) | 11 / 11 files |
| `offline-series.test.ts` ×10 | 10 / 10 |
| `jobs.test.ts` ×5 under load | 5 / 5 (concurrency suite running in parallel 4×) |
| tsc api + web, web lint | clean (lint: only old warnings) |

**9 defects (cc-1 … cc-9), all fixed.** P1 4, P2 5.

## Checks

| # | Check | Outcome |
|---|---|---|
| 1 | Two tills sell the last unit (negative stock allowed) | Sound: both bills stand, stock −1, `balanceAfter` 0 / −1 (no lost update), ledger sum = stock. Item 86'd mid-race: every bill is sold and deducted, or refused with nothing moved. After the 86, bills are refused. |
| 2 | Partner at the dispatch limit: manual ×2 + billing auto-assign + sweep at once | **cc-1** fixed: never above the limit (4 rounds). |
| 3 | Coupon at its limit, 5 bills at once | Total limit was sound (conditional UPDATE). **cc-2** fixed: per-customer limit. |
| 4 | Tab: two splits / split + round + void / last payment + round / close + round | Two splits were already safe (conditional item update, 1 × 201 + 1 × 400). **cc-3** and **cc-4** fixed. |
| 5 | Two KDS screens PATCH one KOT; two stations mark an aggregator order ready | **cc-5**, **cc-6** fixed. |
| 6 | Socket events only after commit | All `emitToOutlet` calls in write paths are after commit or go through the outbox. An AST scan of `src` found no emit inside a `$transaction` / `retryTransaction` callback. **cc-7**: a tab round's `kot:new` was emitted directly after commit, so a crash in between lost it. It now goes through the outbox, in the round's own transaction. |
| 7 | Socket dropped, then reconnected | The outbox retries undelivered rows, but rows emitted while a client is offline are not replayed to it. Kitchen, theatre board and notifications already reloaded on `connect`. **cc-9**: tables, tab panel, bills, delivery board / partner run / my deliveries, online-orders board, storefront requests, reservations and the POS menu / offers did not reload, and stayed stale for up to 60 s (or until the next event). They now reload on (re)connect. Test: a disconnected screen misses `kot:new`, and its refetch after reconnect shows the ticket. |
| 8 | Job killed / retried mid-run | **cc-8** fixed (scheduled report email). Theatre unpaid-expiry was already idempotent (it claims the request row). |
| 9 | Flaky tests | `offline-series` passed 10 / 10 alone and in the full suite. No cause was reproducible. `jobs.test` passed 5 / 5 while the concurrency suite ran in parallel. |

## Defects

| ID | Sev | Area | Defect | Fix |
|---|---|---|---|---|
| cc-1 | P1 | Delivery | The availability check ran outside any lock: manual assign, billing auto-assign and the waiting-orders sweep at once gave a partner 3 orders with a limit of 2 (or an order while on a run). | `lockAndCheckPartner` locks the partner row (`FOR NO KEY UPDATE`) and re-checks in the assignment's transaction (manual, at billing, the sweep). A manager's confirmed force still works. |
| cc-2 | P2 | Coupons | The per-customer limit was counted before the transaction: 5 bills for one customer at once all redeemed a once-per-customer coupon. | The redemption is re-counted after the coupon row is locked by the `usedCount` UPDATE. |
| cc-3 | P1 | Tables | Close + a new round: the close counted "0 unbilled" and committed, the round landed on the CLOSED tab, was fired to the kitchen and never billed. The same applied to paying the last bill (auto-close) + a round. | Tab lock: rounds, void, bill and close lock the session row and re-check it is open. The close re-counts under the lock, and the paid-hook auto-close locks it too. |
| cc-4 | P2 | Tables | A void racing a split could delete an item the split had just billed (checked outside the transaction). | Void under the tab lock, `deleteMany … billedOrderId: null`, 409 otherwise. |
| cc-5 | P2 | KOT | Two screens tapping READY each read the old status outside the transaction: 4 taps gave 4 duplicate "ready" alerts per person. Conflicting taps left a stale `servedAt` on a READY ticket. | The PATCH locks the ticket and computes stage times from the fresh row, in `retryTransaction`. |
| cc-6 | P1 | Channels | Two stations marking an aggregator order's KOTs READY at once: each saw the other as not ready, so FOOD_READY was never pushed. | `onKotReady` locks the order row before counting. |
| cc-7 | P2 | Realtime | A tab round's `kot:new` / kitchen alert was sent after commit outside the outbox (lost on a crash in between). | Moved into the outbox in the round's transaction. |
| cc-8 | P1 | Jobs | Scheduled report email: a pg-boss re-run that overlapped the first run (dead or hung runner past expiry, or a second worker) sent the email twice. | The job claims the day (conditional `lastSentAt` update) before sending, and gives the claim back if the send fails, so the retry sends it once. |
| cc-9 | P2 | Web | Screens stale after a reconnect (check 7). | `useSocketEvent("connect", reload)` on 11 screens. |

## Not verified

- A real pg-boss runner killed with SIGKILL, then expiry: `expireInSeconds` is ≥ 120 s and supervision runs on pg-boss's own interval, which is too slow for the suite. Covered instead by simulating the overlapping re-run and the failed send against the real job function. Exactly-once is impossible with SMTP: a crash between the send and the commit of `lastSentAt` was already claimed, so it is at-most-once for the day.
- Socket replay (missed events by sequence number): not built. Screens refetch on reconnect instead.
- Multi-instance (Redis adapter) emits under load: covered by `redis-adapter.test.ts` only.
