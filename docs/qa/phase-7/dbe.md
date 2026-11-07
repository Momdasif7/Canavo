# QA Phase 7 — Database follow-ups: stored-value bounds, transaction retry, Z-report atomicity (agent dbe)

Branch `agent/dbe`. No migrations (scope rule). This run fixes D2–D6 from `dba.md` and dbd recommendations 2 and 3.
Every fix started from a failing test in `apps/api/test/db/followups.test.ts`.

## What was checked, and how

| Area | How |
|---|---|
| D2 gift-card refunds | A bill paid by two cards (₹80 + ₹80), then: a full GIFT_CARD credit note; partial credit notes of 50 + 60 + 50.01 + 50; a void |
| D3 khata ≥ 0 | Void after the khata was settled; void of an unsettled khata bill; a KHATA credit note larger than what is still owed; settle-in-full racing a void (×4); 3 parallel settles in full (re-checks dbd-7) |
| D4 birthday coupon | `PUT /customers/loyalty/config` with PERCENT 150, and FLAT 5000 switched to PERCENT; a legacy stored config of 150 % run through the CRM daily job |
| D5 corporate statement | A canteen bill moved 10 days back, then refunded to the company today; a statement for today only, then one that covers the bill's day |
| D6 tax rate | POST / PATCH with CGST + SGST > 100, CGST + SGST + cess > 100, IGST + cess > 100, and exactly 100 |
| Deadlock retry | A real deadlock: two whole transactions lock 2 rows in opposite order with a barrier. Also: a P2034 thrown every time, and errors that are not conflicts |
| Shift close | A cash payment whose transaction is still open (test hook delays its commit by 600 ms) while the shift closes; a pay-in racing the close (×5) |
| Books | The reconciliation SQL (`docs/qa/sql/reconciliation.sql`) runs after the file and must come back empty |

Run: `npm run test:db -w @canavo/api` (with `IT_DATABASE_URL` / `IT_APP_DATABASE_URL`).

## Results

| Suite (on `canavo_it_dbe`) | Result |
|---|---|
| `test/db/followups.test.ts` | 17 / 17 pass. Before the fixes, 13 failed. The 4 that already passed: void with gift cards, void of an unsettled khata bill, 3 parallel settles, and "never retries other errors" |
| `test/db` (10 files) | 68 / 68 pass |
| Integration suite (`test/integration`) | 31 files, 207 / 207 pass |
| `npm run test:api` | 23 files, 717 / 717 pass |
| API unit tests | 20 files, 160 / 160 pass |
| `npx tsc --noEmit -p apps/api` | clean |

## Defects (provisional IDs)

| ID | Title | Sev | Area | Repro | Expected vs actual | Test | Fixed |
|---|---|---|---|---|---|---|---|
| dbe-1 (D2) | A GIFT_CARD refund always credits the bill's **first** card | P2 (money) | Gift cards / refunds | Pay ₹160 with cards A ₹80 + B ₹80, then refund ₹160 to GIFT_CARD | A ₹100 / B ₹100 expected. Actual: A ₹180 (above its ₹100 loaded value), B ₹20 | followups "D2" (2 tests) | Yes. `refundToGiftCards`: each card gets back what it paid on the bill, less what was already refunded to it (read from its own ledger), last card used first. `creditGiftCard` also refuses to go above `initialValue` (compare-and-set). A void already refunded per payment, so it was not affected; a regression test was added |
| dbe-2 (D3a) | Voiding a bill whose khata was already settled makes the khata **negative** | P2 (money) | Khata / void | Put a bill on khata, settle it in cash, then void it | Balance ≥ 0 expected. Actual: −₹160 | followups "D3" | Yes. The void reverses the khata with a compare-and-set (`balance ≥ net`). If the customer has paid part of it, the void is refused with **409**: "refund the bill instead (khata for the outstanding part, cash / UPI for the settled part)" |
| dbe-3 (D3b) | A KHATA credit note can take the balance **below zero** | P2 (money) | Khata / refunds | Bill ₹160 on khata, settle ₹100, then credit note ₹160 to KHATA | Capped at ₹60. Actual: −₹100 | followups "D3" | Yes. Compare-and-set. **400** "Only ₹60 is outstanding … refund the rest in cash / UPI" |
| dbe-4 (D3c) | Settling in full while the bill is voided at the same moment: **both succeed** | P2 (money) | Khata | Run `POST /khata/settle {amount: balance}` and `POST /orders/:id/cancel` together | One wins expected. Actual: both 200, balance −₹160 | followups "D3" race ×4 | Yes. Same compare-and-set on both sides. Parallel settles (dbd-7) verified still correct |
| dbe-5 (D4) | Birthday / anniversary job can make **PERCENT coupons above 100 %** | P3 | CRM | Save loyalty config PERCENT 150 (or switch FLAT 5000 to PERCENT), then run the daily job | ≤ 100 expected. Actual: a 150 % coupon | followups "D4" (2 tests) | Yes. `PUT /customers/loyalty/config` answers 400 above 100 %. The job clamps legacy configs to 100 |
| dbe-6 (D5) | A corporate statement can be raised with a **negative amount** | P3 | Canteen | Refunds to the company in a period are larger than that period's meals (refunds count on their own date) | Refused expected. Actual: statement amount −₹40 | followups "D5" | Yes. **400** on create, with the hint to widen the period or settle separately. The live preview (`GET …/statement`) still shows the true net. `PATCH` never changes `amount`, so it needed no guard |
| dbe-7 (D6) | A tax rate's **GST + cess can exceed 100 %** | P3 | Tax rates | `POST /tax-rates {cgst:60, sgst:60}`, or cess 92 on 18 % | 400 expected. Actual: 201 | followups "D6" | Yes. 400 if CGST + SGST + cess > 100 or IGST + cess > 100, on create and update |
| dbe-8 | A pay-in / pay-out racing the shift close **lands on the closed shift**, so it is missing from the frozen Z-report | P2 (money) | Cash shifts | Run `POST /cash-shifts/current/movements` and `/close` together | It is either in the Z-report or refused. Actual: a movement row on a closed shift, `payIns` 0 | followups "pay-in racing the close" | Yes. The movement share-locks the open shift and re-checks it inside its transaction; otherwise 409 "shift was just closed" |
| dbe-9 (dbd rec. 3) | A payment committing during the close is **missing from the Z-report** | P2 (money) | Cash shifts | A cash payment's transaction is still open while the shift closes | Counted expected. Actual: `counterCash` 0, while the payment's time is inside the window (F02 flags it) | followups "cash payment committing while the shift closes" | Yes. See hardening |

## Hardening

**Automatic retry of transaction conflicts.** New file `src/lib/tx-retry.ts`, which provides `withConflictRetry` and `retryTransaction`.

- It retries a **whole** interactive transaction when `isTransactionConflict` is true (P2034, 40P01, 40001).
- Up to **3 retries** (4 attempts), with jittered exponential backoff of about 10–30, 20–60 and 40–120 ms.
- After the last retry, the existing 409 `TRY_AGAIN` reaches the client.
- Other errors are never retried.

It is used in the hot write paths:

- order create (`billing.ts` `persist`; not when run inside a caller's transaction)
- payment collect, UPI confirm, COD, void (`orders.ts`)
- credit notes
- every inventory route transaction (stock adjust, recipes, purchases, receive / cancel / payments, wastage, audits, transfers)
- every tables transaction (open, rounds / KOT, item void, transfer, merge, bill, close, layout)
- cash shift pay-in / pay-out and close

Before applying it, each callback was checked:

- Nothing outside the DB happens inside a callback. Sockets, kitchen alerts and channel pushes are outbox rows in the same transaction, or run after commit.
- The approval PIN check reads outside the transaction. A failed check throws an error that is not retried.
- Three callbacks pushed into arrays declared outside them (purchase cancel `returned`, merge `touched` / `mergedSessions`, tab bill `effects`). They now reset those arrays at the start of each attempt.

**Shift close in one transaction.** `closeShift` now does all of its work in one transaction:

1. Lock the open shift row `FOR UPDATE`.
2. Take `closedAt`.
3. Build the Z-report through the same transaction.
4. Close the shift and write the audit row.

Every transaction that moves drawer money takes the shift row `FOR SHARE` after the bill lock (`lockOpenShift`): payment collect, UPI confirm, void and credit note. Pay-in / pay-out re-checks the shift as well. So:

- the close waits for money already in flight;
- money that arrives during the close waits, and lands after `closedAt` (in the next shift);
- under REQUIRE_CASH_SHIFT, cash is re-checked against the shift inside the transaction;
- a second close waits, then gets 409.

Lock order is always bill → shift. The close takes no bill locks, so no deadlock cycle is possible.

**Test-suite hygiene (no product change).** Running all of `test/db` in one pass failed, depending on file order. The dbd reconciliation checks run across the whole DB, and earlier files had left bare fixture rows. Changes:

- `pool.test.ts` and `large-ranges.test.ts` delete their synthetic bills in `afterAll`.
- `backup-restore.test.ts` writes the opening ledger row for its stock and no longer assumes an empty DB.
- `tenant-integrity.test.ts` restores the round-off it changes on purpose.

## Recommendations (no failing behaviour seen)

1. Other drawer-money writers don't yet take `lockOpenShift`: gift-card sales for cash, canteen wallet top-ups / meal tokens for cash, delivery cash handovers, and channel / storefront voids. One line each, in their transactions.
2. Now that D2 and D3 are fixed, the migration owner can add the pending CHECKs (dba R9): `"khataBalance" >= 0` and `GiftCard.balance <= "initialValue"`. Run the precheck on legacy rows first. Also a CHECK of `gstRate <= 100` / `cgst + sgst + cess <= 100` on `TaxRate`.
3. Consider using `retryTransaction` for the remaining `prisma.$transaction` call sites, after the same callback check: customers, delivery, canteen, storefront, channels.
4. Khata has no advance / credit balance. If the business wants "keep it on account" instead of a cash refund, that is a product decision and a new ledger concept, not a negative balance.

## Not verified, and why

- Retry under real production contention: the deadlock test forces one deadlock. The HTTP paths can't be deadlocked on demand any more (dbd-2 sorted the locks), so the wrapper is proven at the library level plus one real PostgreSQL deadlock.
- Legacy rows: no read of the dev DB was needed or done. Existing negative khata, over-loaded gift cards, >100 % tax rates or negative statements, if any, are untouched. The dba precheck SQL pattern finds them.
