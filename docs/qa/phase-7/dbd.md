# QA Phase 7 — Database testing: data reconciliation, transactions & isolation, soft delete, audit log (agent dbd)

Branch `agent/dbd`. No migrations added (scope rule) — schema changes that would help are listed under recommendations.

## What was checked, and how

| Area | How | Where |
|---|---|---|
| Reconciliation SQL | 45 queries (40 `@check` must be empty, 5 `@warn` allowed by a business rule), each commented with the invariant it proves | `docs/qa/sql/reconciliation.sql` |
| Reconciliation under load | One hotel with every module + canteen, gift cards, offline invoice series and "cash shift required", driven through a busy day over the real API (RLS on, app role): 40 bills at once, split / tip / khata / card / UPI payments in parallel, double-collection races, loyalty earn + parallel redemption + manual adjust, coupon with a usage limit, 3 gift cards (4 bills racing for one card), voids of open / cash / khata / gift-card / wallet / meal-token bills (double-tapped), item refund with restock, value refunds to cash (raced), khata, gift card, wallet, khata settlements, 4 COD deliveries (one completed twice at once, one cancelled), handover + edit + settle raced, canteen wallet top-ups / meal tokens / 4 bills racing for one wallet, purchases (received, received-then-cancelled, part paid), wastage in parallel with sales, transfer received / dispatched / cancelled, stock audit with sales during the count, manual adjustment, offline sync with a device series flushed twice at once (incl. a skipped number and a bill without a device number), two running tabs merged and billed, pay-in / pay-out and shift close. Then every query must be empty and no request may have answered 5xx | `apps/api/test/db/reconciliation.test.ts` |
| The queries catch what they claim | 16 different corruptions made inside a transaction that is rolled back (grand total, extra payment, refunded amount, deleted khata row, points, gift card / wallet balance, coupon count, stock, invoice counter gap, cash shift, duplicate KOT) — each must be reported by its query; after rollback the books are clean again | same file |
| Rollback on failure | Test-only hook `billingTestHooks.beforeCommit` throws after the order, its lines, KOTs, stock deduction, points / coupon use, audit row and outbox events are written; split payment whose 2nd tender is refused (gift card short, khata over limit); refund refused inside its transaction; tab bill in 2 groups failing on the 2nd | `apps/api/test/db/transactions.test.ts` |
| Deadlocks | Real paths that lock the same rows in opposite order at the same moment: wastage `[rice, oil]` vs `[oil, rice]` ×10 pairs; purchases received / transfers dispatched with opposite line order plus sales of those ingredients; merging table A into B while B is merged into A; one customer's bills paid on khata / voided / settled / points adjusted at once (bill → customer locks) | same file |
| Counters under parallel writes | 50 bills at once on an outlet's first day (invoice numbers unique, 1..50, counter = 50); KOT numbers with counter bills + tab rounds at once; 5 bills redeeming all of one customer's points; 3 loyalty deductions at once; 30 sales at once vs. recipe stock; whole khata settled 3× at once; UPI QR confirmed after / while the bill is paid in cash | same file |
| Soft delete | Sold menu item → hidden (bill, receipt, item report still show it; POS refuses it); item only on an open tab; staff deactivated (logged out, can't log in, still named on bills, still in staff list with status, not offered as waiter / delivery partner); inventory item & vendor deactivated (ledger, purchase, includeInactive list keep them; active list and stock audit don't); blocked customer, inactive canteen member | `apps/api/test/db/soft-delete-audit.test.ts` |
| Audit log growth | Rows per action for a 20-bill sample day, average row size, indexes, any trimming | same file |
| Dev DB `canavo` | The reconciliation queries once, as counts, in `BEGIN READ ONLY` + `set_config('app.bypass_rls','on',true)` (the one permitted dev read) | below |

Run: `npm run test:db -w @canavo/api` (new script; needs `IT_DATABASE_URL` / `IT_APP_DATABASE_URL` like `test:api`).

## Results

| Suite | Result |
|---|---|
| `test/db` (3 files) | 24 / 24 pass (7 of the transaction tests and 2 soft-delete tests failed before the fixes; the reconciliation run failed on 4 defects before the fixes) |
| Reconciliation after the busy day | 40 checks empty, 0 × 5xx; warnings: E04 offline-series gap = 1 (the deliberately skipped device number), others 0 |
| Corruption detection | 16 / 16 corruptions caught by their queries |
| Existing integration suite (`test/integration`) on `canavo_it_dbd` | 31 files, 207 / 207 pass |
| `npm run test:api` on `canavo_it_dbd` | 23 files, 717 / 717 pass |
| API unit tests | 20 files, 160 / 160 pass |
| `npx tsc --noEmit -p apps/api` | clean |

### Dev DB `canavo` (read-only, counts)

Run with the file as it was at that moment (43 queries; F01 was then the single "recomputes" check). Every query 0 rows except:

| Query | Rows | Reading |
|---|---|---|
| B08 purchase paid amount = payments | 2 | Demo seed (`prisma/seed-inventory.ts`) wrote `paidAmount` on paid purchases without a `PurchasePayment` row. Seed fixed (dbd-11); existing dev rows unchanged. |
| F01 (old) closed shift expected cash = recomputed | 4 | Most likely shifts closed before the expected-cash formula changed (BUG-050 added "cash returned on voided bills"; tips / canteen top-ups were added in earlier phases) — the Z-report is frozen at close. Not verified row by row (only one dev read allowed). F01 is now split: **F01** internal arithmetic of the frozen Z-report (any formula version), **F02** recompute for shifts closed with today's formula, **F03** (warn) older-formula shifts that differ. Re-running the file once on dev will say which it is. |

No invoice gaps / duplicates, no overpaid bill, every stored balance (points, khata, gift cards, wallets, meal tokens, stock) equals its ledger on the dev data.

### Audit log

- 20 bills (some split, 1 void, 1 refund, khata settle, shift open/close) wrote **50 rows** (order.create 20, payment.collect 25 — one per payment call, cancel 1, refund 1, settle 1, shift 2): **≈ 2.5 rows per bill**, average **≈ 270 bytes** per row (+ 4 indexes: pkey, `(businessId, createdAt)`, `(outletId, createdAt)`, `(entity, entityId)`).
- Every row carries `businessId` (tenant filter) and is written in the same transaction as the change (verified: a failed bill leaves no audit row).
- **Nothing ever deletes or archives audit rows** (no job, no retention setting).
- Estimate: 1,000 bills/day/outlet → ~2,500 rows/day → ~0.9 M rows ≈ 250 MB heap (+ ~150 MB indexes) per outlet per year.

## Defects (provisional IDs)

| ID | Title | Sev | Area | Repro | Expected vs actual | Test | Fixed |
|---|---|---|---|---|---|---|---|
| dbd-1 | Two tills billing the same **new** customer phone at once: one bill refused `409 Already exists` | P1 | Billing / Customers | 40 parallel `POST /orders` sharing 6 new phones | All bills saved, one customer · 2 bills lost with 409 (find-then-create race in `findOrCreateCustomer`; the tenant filter turns Prisma's upsert into find + create) | reconciliation.test.ts step 1 | Yes — `INSERT … ON CONFLICT DO NOTHING` (createMany skipDuplicates) then read (`services/promotions.ts`) |
| dbd-2 | Inventory writes with several lines deadlock → **500** | P1 | Inventory | Wastage `[A,B]` and `[B,A]` at once (also purchase receive / cancel, transfer dispatch / receive, audit complete) | No 500 · `40P01 deadlock detected` → 500 | transactions.test.ts "deadlocks" (2 tests) | Yes — every multi-line stock write locks rows in item-id order (`inItemOrder`), like billing already did; any remaining deadlock / serialization failure answers **409 `TRY_AGAIN`** ("nothing was saved, try again") instead of 500 (`lib/http.ts`) |
| dbd-3 | Same offline bill synced twice at once: 2nd reported **failed** with the raw Prisma error text | P2 | Offline sync | `POST /orders/sync` same batch twice in parallel | Both `ok`, 2nd `duplicate: true` · `ok:false, error:"Invalid tx.order.create() … Unique constraint failed"` (internal detail leaked, device keeps it queued) | reconciliation.test.ts step 11 | Yes — unique-key loser returns the existing bill as a duplicate (`services/billing.ts`) |
| dbd-4 | **Duplicate KOT numbers** when counter bills, tab rounds or online orders are fired at the same moment | P2 | KOT | 8 bills + 8 tab rounds at once | Unique per outlet per day · same number printed on up to 8 tickets (count + 1 without a lock); an offline bill synced later was numbered from its own past day | transactions.test.ts "KOT numbers…", query G02 | Yes — `lastKotNumberToday`: per-outlet advisory lock until commit, day = ticket's own day; used by billing, tabs, storefront |
| dbd-5 | Merging table A into B while B is merged into A: **both succeed, both tabs closed with their items** | P0 (data loss) | Tables | Two `POST /tables/sessions/:id/merge` crosswise at once | One merge, the other 409 · both 200; tables "occupied" with no open tab, items unbillable (G05) | transactions.test.ts "merging table A into B…" | Yes — both tabs locked in id order and re-read inside the merge transaction (`routes/tables.ts`) |
| dbd-6 | Two loyalty deductions at once take points **below zero** | P2 | Loyalty | 3× `POST /customers/:id/loyalty/adjust {points:-all}` at once | One 200, others 400 · 200 ×3, points = −2× balance | transactions.test.ts | Yes — compare-and-set update (`routes/customers.ts`) |
| dbd-7 | Settling the whole khata twice at once **collects it twice** (balance negative) | P1 (money) | Khata | 3× `POST /customers/:id/khata/settle {amount: balance}` at once | One 200 · 200 ×3, 3 CREDIT rows, cash drawer expects 3× | transactions.test.ts | Yes — compare-and-set update |
| dbd-8 | Confirming a UPI QR after (or while) the bill was paid in cash **pays the bill twice** | P0 (money) | Payments / Delivery | `POST /orders/:id/upi-qr`, pay CASH, then `POST /orders/:id/payments/:pid/confirm` (same for the partner's `/delivery/:id/upi-qr/:pid/confirm`) | 409 "no longer needed" · second SUCCESS payment, Σ payments = 2 × grand total (A01/A02) | transactions.test.ts | Yes — `assertConfirmable`: bill locked, payment still pending, bill still open, amount ≤ due. The Razorpay webhook (money really arrived) is unchanged |
| dbd-9 | Menu item never billed but on an **open tab** (or a meal plan) was hard-deleted → tab can't be billed | P2 | Menu / Tables | Add item to a tab, `DELETE /menu/items/:id`, bill the tab | Item hidden, tab billable · row deleted, billing fails "Unknown menu item" | soft-delete-audit.test.ts | Yes — hidden when on an open tab or a meal plan |
| dbd-10 | Deleting / hiding a menu item wasn't audited | P3 | Menu / Audit | `DELETE /menu/items/:id` | Audit row · none | soft-delete-audit.test.ts | Yes — `menu.item.delete` / `menu.item.delete.hidden` |
| dbd-11 | Demo seed: paid purchases without payment rows (dev DB B08 = 2) | P3 | Seed data | `npm run db:seed`, run B08 | paidAmount = Σ payments · 2 purchases differ | reconciliation B08 on dev | Yes (seed only) |

## Recommendations (no failing behaviour seen in tests)

1. **Constraints as a second line of defence** (needs migrations — for the migration owner): `CHECK` `Customer.points >= 0`, `walletBalance >= 0`, `GiftCard.balance >= 0`, `MealTokenAccount.balance/value >= 0`, `Order.refundedAmount BETWEEN 0 AND "grandTotal"`, `Purchase."paidAmount" <= total`; a unique KOT number per outlet per day (needs a stored `kotDay` column); partial unique index "one OPEN `TableSession` per `tableId`".
2. **Deadlock retry**: residual deadlocks now return 409 `TRY_AGAIN`; a bounded automatic retry (2–3×) of P2034 / 40P01 / 40001 in the RLS `$transaction` wrapper (`db.ts`) would hide them from staff. Keep callbacks side-effect free (they already use the outbox).
3. **Cash shift close** computes the Z-report outside a transaction; a payment committing between the summary query and the close update is missing from the frozen figure (F02 would show it). Compute the summary and close in one transaction and take the window end inside it.
4. **Pending UPI QRs** stay `PENDING` after the bill is paid another way — mark them `FAILED` when the bill settles (now harmless after dbd-8, but they clutter the payment list).
5. **Delivery `cashSettledAt`** is re-allocated only on handovers; after a partner in credit collects again the flag lags (D02 checks only the dangerous direction). Re-allocate after door collections too.
6. **Same invoice number under one GSTIN** (E06): outlets sharing a GSTIN with the default prefix "INV" issue identical numbers. Require a distinct prefix per outlet when GSTINs match.
7. **Audit log**: (a) retention — keep ~13 months hot, then move older months to an archive table / object storage (monthly partitions on `createdAt` make this a cheap `DETACH`); keep archives ≥ 8 years (GST record-keeping horizon); (b) the audit screen counts the whole business on every page with no default date range — default to the last 30 days or use an estimate; (c) add `(businessId, userId, createdAt)` for the user filter; (d) gift card codes (bearer value) appear in plain text in `gift_card.issue` meta and the gift card list — mask to the last 4.
8. **Customers can't be removed** (only blocked) — a DPDP erasure path (anonymise name / phone, keep bills) is missing.
9. Run `docs/qa/sql/reconciliation.sql` nightly (read-only, counts only) and alert on any `@check` row.

## Not verified, and why

- Dev DB detail behind B08 / F01 counts — only one read-only pass was allowed; causes above are inferred from code and seed.
- Recipe deduction amount per bill vs. the recipe (recipes can change after the sale; the ledger is the source of truth, so C01 checks stock = ledger and C03 one deduction per bill/item).
- Corporate statements, channel (aggregator) orders and meal-subscription upfront bills are covered only by the generic checks (A01–A06), not driven in the workload.
- Long-duration load / pool exhaustion (another Phase 7 scope).
- Note for the coordinator: early in this run a shared scratchpad helper script (`rt.sh`, rewritten by agent dba) made one of my test runs execute `test/db/tenant-integrity.test.ts` against `canavo_it_dba` (its global setup recreated that DB). If dba saw an unexpected reset around 23:08 IST, that was the cause; my later runs used my own script and `canavo_it_dbd` only.
