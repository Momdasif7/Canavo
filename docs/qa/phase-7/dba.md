# QA Phase 7: schema review and tenant integrity (agent `dba`)

Branch `agent/dba`. Databases used: `canavo_it_dba` (tests), `canavo_shadow_dba` (diff), and two throwaway databases, `canavo_dba_cat` (empty migrated catalog) and `canavo_dba_seed` (fresh `prisma/seed.ts`). Both throwaway databases were dropped at the end. The dev database `canavo` was only read, inside `BEGIN READ ONLY` transactions with `default_transaction_read_only=on`; see section 3.

## 1. What was checked and how

| Area | How |
|---|---|
| PK / FK / unique / CHECK / RLS / types | Catalog queries (`pg_constraint`, `pg_indexes`, `pg_policies`, `information_schema`) on a freshly migrated DB, read alongside `schema.prisma`. |
| Value bounds for new CHECKs | Every write path for each candidate column was traced: zod schemas, services, jobs, seeds, offline sync, channel imports and credit notes. Only bounds that every path already respects were enforced. |
| Constraints vs existing data | `docs/qa/sql/constraint-precheck.sql` (read-only). Run against a fresh dev seed (1,677 orders) and the dev DB `canavo`; both returned 0 violations. The migrations were then deployed on the seed copy. |
| Tenant integrity | `apps/api/scripts/tenant-integrity.ts` generates `docs/qa/sql/tenant-integrity.sql` from the catalog. It produces **340 checks**: 79 chain, 104 orphan, 117 cross-business, 31 cross-outlet and 9 hand-written array / JSON / domain checks. See section 3. |
| Workload | `apps/api/test/db/tenant-integrity.test.ts`: three GST hotels trade in parallel through the API, plus a platform admin session. Afterwards every check must return 0 rows. |

## 2. Results

| Item | Result |
|---|---|
| Tables | 83. Every one has a PK. |
| FOREIGN KEYs | 90: 68 CASCADE, 14 SET NULL, 8 RESTRICT. |
| `*Id` columns with **no** FK ("soft" references) | **113**, e.g. `KotTicket.outletId`, `Delivery.outletId`, `Payment.giftCardId`, `GiftCard.businessId`, `CorporateAccount.businessId`, `StockTransfer.from/toOutletId`, `InventoryStock.outletId`, `MealSubscription.customerId`, `ChannelOrder.connectionId`. All are now covered by orphan / cross-tenant checks. |
| RLS | ENABLE + FORCE on every business table. Not on `Business`, `IdempotencyKey`, `OtpCode`, `OutboxEvent`, `Setting` or `_prisma_migrations` (see R6). |
| CHECK constraints before | 0 |
| CHECK constraints added | **40** (migration `20261106120000_check_constraints`, NOT VALID) and validated by `20261106120100_validate_check_constraints`. |
| Unique rules | Invoice number per outlet: `@@unique([outletId, invoiceNumber])`, and the number embeds the FY start year (`PREFIX-YYYY-NNNNN`), so it is unique per outlet and FY. Credit notes are unique the same way. One open cash shift per outlet: an existing partial index. Coupon and gift-card codes: unique per business, upper-cased before insert and lookup. Customer phone and card UID: unique per business. **One OPEN running tab per table: added** (`20261106120200_table_session_one_open`, partial unique index). |
| `prisma migrate diff` after the migrations | Empty migration. |
| Float columns | 30. Money is never Float. Rates and quantities are: see R3. |
| Timestamps | 149 × `timestamp(3) without time zone` and 0 × timestamptz (outside `_prisma_migrations`). See R4. |
| `tenant-integrity.sql` on the workload DB | **340 / 340 checks = 0**. The mutation test plants 8 kinds of cross-tenant and orphan link; all fire, then roll back. |
| `tenant-integrity.sql` on the dev DB `canavo` | 16 businesses, 22 outlets, 2,004 orders, 1,924 payments, 55/55 migrations applied. **340 / 340 checks = 0** (second run, see note). |
| `constraint-precheck.sql` on `canavo` | **41 / 41 = 0**. The new constraints will apply cleanly to the dev data. |

Note on the dev DB read: the first read-only run of the integrity SQL returned one non-zero check, `chain:RefreshToken.userId = 198`. In the same read-only transaction, all 198 turned out to be sessions of platform users, who have no business. That was a false positive in the generator: chains ending at a platform user, platform audit row or platform outbox event are now allowed. A regression guard was added: the test signs in a platform admin. The corrected SQL was run once more, read-only, and returned 340/340 = 0. So the dev DB was read twice, both times SELECT only.

## 3. Deliverables

- `docs/qa/sql/tenant-integrity.sql`: one read-only SELECT returning `(check, violations)`. It is generated, not edited by hand. Run it with:
  `BEGIN READ ONLY; SET LOCAL app.bypass_rls='on'; SET LOCAL jit=off; \i …; ROLLBACK;`
  `jit=off` matters: with JIT on, compiling the 340 subplans takes about 26 s; with it off the query runs in about 0.3 s.
- `apps/api/scripts/tenant-integrity.ts`: the generator.
  - **Owner path per table**, in order of preference: its own `businessId`, then a NOT NULL `outletId`, then a NOT NULL FK, then a NOT NULL soft reference, then a nullable `outletId`.
  - **Reference columns:** every real FK, plus every `*Id` / `*ById` text column (aliases for names like `fromOutletId`, `agentId`, `slotId`). Unmapped columns and unowned tables are listed in the file header; both lists are "none" today.
  - **Checks generated:**
    - `chain:` every row reaches an existing Business.
    - `orphan:` a soft reference points at a missing row.
    - `cross-business:` the referenced row belongs to another business.
    - `cross-outlet:` both sides carry `outletId` and they differ.
    - Hand-written: `Offer.outletIds[]`, `TableSession.mergedTableIds[]`, `ChannelRequest.kotIds[]`, add-on and variant ids belonging to the line's own item, `Reservation.preOrderItems[]` and `ChannelRequest.items[]` menu ids, `Setting.scope`, platform roles ⇔ null business, custom role base role, the KOT order/session pair, the MealTokenTxn account/customer pair, and `StockTransfer` from ≠ to.
  - `--check` reports a stale SQL file.
- `docs/qa/sql/constraint-precheck.sql`: rows that would break the new constraints (all must be 0 before `migrate deploy`).
- `apps/api/test/db/tenant-integrity.test.ts` (8 tests):
  - The SQL file is fresh against the migrated catalog.
  - The workload wrote rows in every area.
  - 340 checks = 0.
  - Mutation test: the checks fire on planted links.
  - CHECKs reject negative wallet / points / gift card / coupon counts, negative bill money, zero quantity and refund > bill, while `roundOff` stays signed.
  - The one-open-tab index works.
  - A CHECK violation maps to 409.
- The workload exercises: staff; tax rate; menu with variants and add-ons; recipes; vendor; purchase received and paid; inter-outlet transfer; wastage; audit; customer with khata; offer; coupon; cash shift with movements and close; bills paid by split cash + UPI, khata, card and gift card; khata settle; partial credit note with restock; void; running tabs with two rounds, transfer, merge and bill; KOT status; reservation with pre-order, seated; delivery zone, order and partner assignment; canteen account with rule, member with wallet top-up and tokens, slot, pre-order, subscription and a wallet-paid bill.
- `npm run test:db` script added.
- `lib/http.ts`: SQLSTATE 23514 (check violation) now returns **409** and is reported. It was a bare 500.

### CHECKs added (40)

All are `>= 0` unless noted.

| Area | Constraints |
|---|---|
| Order and lines | Every money part of `Order`, and `refundedAmount <= grandTotal`. `OrderItem.quantity > 0`, money ≥ 0, `gstRate` ≥ 0. |
| Payments and refunds | `Payment.amount`, `tip`, `tokens > 0`. `CreditNote.amount`, `CouponRedemption.amount`, `KhataTransaction.amount`. |
| Counters | Invoice and credit-note counters. |
| Menu and tax | Menu, variant, add-on, override and slot prices. `TaxRate` %. `Outlet` service-charge % 0–100, packaging, approval % 0–100, `maxDeliveriesPerPartner >= 1`. |
| Customers and stored value | `Customer` wallet, points, khata limit, spend, visits. `GiftCard` balance and initial value. `MealTokenAccount`. `Coupon` value, usedCount, minOrder, maxDiscount. |
| Cash | `CashShift` float and counted cash. `CashMovement > 0`. `DeliveryCashHandover > 0`. |
| Purchases and inventory | `Purchase` money. `PurchasePayment > 0`. `PurchaseItem` values. `InventoryItem` cost and reorder levels. `StockAuditLine.countedQty`. |
| Canteen | `CorporateAccount.creditLimit`. `CorporateStatement.meals`. `MealSubscription`: price, `mealCount > 0`, `0 ≤ refundedMeals ≤ mealCount`. |
| Tables, reservations, delivery, channels, staff | `DiningTable.capacity > 0`. `TableSession.guests >= 1`. `TableSessionItem.quantity > 0`. `Reservation` party size, duration, advance. `DeliveryZone` fee, min order, radius > 0. `ChannelOrder` and `ChannelRequest` totals. `User.salaryAmount`. |

**Deliberately not constrained**, because code paths legitimately or currently write values outside these bounds:
- `Customer.khataBalance`, which can go negative (D3).
- `InventoryStock.quantity` / `balanceAfter`: negative stock is allowed by design.
- `CreditNote` tax columns: dba-1 is now fixed, but legacy rows should be checked first.
- `CorporateStatement.amount`, which can go negative (D5).
- The signed ledgers: Wallet, GiftCard, Loyalty and MealToken transactions.
- `Order.roundOff`, `CashShift.expectedCash` and `variance`.
- `Payment.amount > 0`: zero-total prepaid channel and meal-plan bills write 0.
- `Coupon.usageLimit >= usedCount`: PATCH allows lowering it.
- `GiftCard.balance <= initialValue`: broken by D2.
- `gstRate`, `igst` and PERCENT coupon `<= 100`: some paths are uncapped (D4, D6).

## 4. Defects

| ID | Title | Sev | Area | Repro | Expected / actual | Test | Fixed |
|---|---|---|---|---|---|---|---|
| dba-1 | Unit-by-unit refunds give a **negative CGST/SGST** on the last credit note | P2 (money: GST document) | `services/credit-notes.ts` | Bill 8 × ₹1.05 at 5% GST (CGST 20 paise) and refund 1 unit eight times. | Every credit-note column ≥ 0 and the notes sum to the line. Actual: `CNINV-2026-00008.cgst = −1`, because the 7 earlier notes each rounded 2.5 up to 3. | `test/db/credit-note-rounding.test.ts` | **Yes.** Earlier refunds now round the running total: `round(v·(done+q)/Q) − done`, clamped ≥ 0. The last refund still takes the remainder. |
| dba-2 | **Duplicate KOT numbers** at an outlet | P2 (kitchen calls the wrong order) | `billing.ts`, `routes/tables.ts`, `storefront.ts` | (a) Fire rounds on 6 tables at once and two KOTs get the same number. (b) Delete a KOT (rejected QR request / cancelled pre-order); the next bill re-uses a number. | Unique KOT numbers per outlet-day. Actual: `[12, 13]` repeated, and `12` re-used. The cause is a `count()+1` read without a lock. | `test/db/kot-numbering.test.ts` | **Yes.** New `services/kot-number.ts` takes `pg_advisory_xact_lock(hashtext('kot:'+outletId))` and uses `max(kotNumber)` instead of a count. All 3 call sites use it. |
| D2 | A **GIFT_CARD refund always goes to the bill's first card** | P2 (money) | `credit-notes.ts:139-144` | Pay one bill with two gift cards, then refund it in full to GIFT_CARD. | Each card gets back what it paid. Actual: card A gets both amounts, so its balance exceeds its initial value. | Code reading, not run | No. Report only; this is outside DB scope. |
| D3 | `Customer.khataBalance` can go negative | P2 (money) | `promotions.ts:540-550`, `credit-notes.ts:183-191`, `customers.ts:333-351` | Settle a khata bill, then void it: the void credits back the bill's khata debit again. A khata credit note is capped by what the bill put on khata, not by the current balance. Two concurrent settles both pass the check. | Balance ≥ 0. Actual: negative. | Code reading | No. A `khataBalance >= 0` CHECK is ready once this is fixed. |
| D4 | Birthday/anniversary job can create PERCENT coupons above 100 | P3 | `jobs-crm.ts:107-112`, `schemas-crm.ts:80` | Set `birthdayCouponValue` to 150. | Capped at 100, like the API's coupon create/PATCH. Actual: no cap. | Code reading | No. |
| D5 | `CorporateStatement.amount` can be negative | P3 | `services/canteen.ts:306-313` | Refunds are counted by credit-note date, so a period with refunds on earlier bills can go below 0. | ≥ 0, or carry the refund forward explicitly. | Code reading | No. |
| D6 | Effective `gstRate` / `igst` can exceed 100 | P3 | `tax-rates.ts:68-70,86,116` | cgst and sgst are each allowed up to 100; the effective rate is their sum. | Add a refine `cgst + sgst ≤ 100`. | Code reading | No. |

## 5. Recommendations (no failing behaviour today)

- **R1 Cascades into financial history.** These are all ON DELETE CASCADE:
  - `Payment`, `OrderItem`, `CreditNote`, `KotTicket`, `Delivery` and `OrderHandover` on `Order`.
  - `CreditNote`, `CashShift`, `ApprovalLog` and `ChannelOrder` on `Outlet`.
  - `KhataTransaction`, `WalletTxn`, `LoyaltyTransaction` and `MealTokenAccount` on `Customer`.
  - `GiftCardTxn` on `GiftCard`, `CashMovement` on `CashShift`, `PurchasePayment` on `Purchase`.
  - `InventoryTransaction` on `InventoryItem`, `StaffAttendance` on `User`, and `Outlet`, `User` and `Customer` on `Business`.

  No app path hard-deletes `Order`, `Customer`, `Outlet`, `User` or `Business` today; `MenuItem` delete is guarded by a count, and `OrderItem` is RESTRICT. But one stray `DELETE` (a script, a platform tool, a future "delete customer") would silently erase GST documents, payments and ledgers. Change these to RESTRICT, or soft-delete the parents. The orders are protected only by `Order.outletId` being RESTRICT. This is a separate FK migration, outside my scope.
- **R2 113 soft references without FOREIGN KEYs**, e.g. `KotTicket.outletId`, `Delivery.outletId`, `Payment.giftCardId`, `GiftCard.businessId`, `CorporateAccount.businessId`, `InventoryStock.outletId`, `StockTransfer.*OutletId`, `MealSubscription.customerId`, `ChannelOrder.connectionId`. Integrity is guaranteed only by app code, and now checked by `tenant-integrity.sql`. Add FKs (RESTRICT) where the parent is never hard-deleted. At minimum, run the integrity SQL nightly or in CI.
- **R3 Float for rates and quantities.** `MenuItem.gstRate`, `OrderItem.gstRate`, `TaxRate.cgst/sgst/igst/cess`, `Outlet.serviceChargePercent` and `PurchaseItem.taxRate` are percentages stored as double; money itself is always integer paise. 2.5 / 9 / 14 are exact in binary, but a rate like 0.1 or 1.1 can flip a `Math.round` at a .5 boundary. Inventory quantities (`InventoryStock.quantity`, transactions, recipes, transfers) are double too, kept tidy by `round3`, but they drift on long ledgers. Prefer `numeric(5,2)` (or integer basis points) for rates and `numeric(14,3)` for quantities.
- **R4 Timestamps without time zone.** Prisma writes UTC and also supplies `now()` itself. This was verified on a session set to Asia/Kolkata: `createdAt` was still stored in UTC. Report SQL converts correctly (`AT TIME ZONE 'UTC' AT TIME ZONE <outlet tz>`). The risk is raw SQL comparing these columns with `now()`, e.g. `lib/outbox.ts:86-89` (`availableAt <= now()` and lease `now() + …`). That is only correct while the DB session `TimeZone` is UTC. On a server or database set to IST, leased events would be hidden for 5.5 h and new ones would look 5.5 h late. Pin `ALTER DATABASE … SET timezone='UTC'` in provisioning, or write `(now() AT TIME ZONE 'UTC')`. Longer term, use `timestamptz`. Any ad-hoc BI query grouping by `createdAt::date` gets UTC days, not IST business days: the first 5.5 h of each IST day land in the previous day.
- **R5 `Order.clientOrderId` is globally unique.** A clientOrderId from another business gives a 409 (`/orders`) or a raw P2002 message (`/orders/sync`). That reveals that the UUID exists, though no data leaks. Prefer `@@unique([outletId, clientOrderId])`.
- **R6 `Setting` has no RLS.** It holds per-business and per-outlet rows (WhatsApp config, loyalty config, notification prefs, CRM run markers). Add a policy on `scope` (outlet or business id, or GLOBAL).
- **R7 Further unique rules to consider:**
  - One open attendance per user (`StaffAttendance(userId) WHERE clockOutAt IS NULL`).
  - One default `TaxRate` per business.
  - One EARN `LoyaltyTransaction` per order.
  - `MealTokenAccount(customerId, mealSlotId)`.

  0 violations exist today in the seed and workload data. The paths weren't traced deeply enough to enforce these safely.
- **R8 String-typed enums.** `ChannelRequest.status`, `ChannelOrder.status`, `Order.channel`, `Delivery.source`, `StaffAttendance.source`, `GiftCard.soldMode`, `KhataTransaction.mode`, `PurchasePayment.mode`, `ChannelConnection.provider` and `ReportSchedule.frequency` are free text. Use Prisma enums or `CHECK (… IN (…))`.
- **R9** Once dba-1, D3, D2 and D6 are fixed and legacy rows have been checked with the precheck pattern, add the remaining CHECKs: `CreditNote` taxes ≥ 0, `khataBalance >= 0`, `balance <= initialValue`, and `gstRate <= 100`.

## 6. Not verified

- D2–D6: confirmed by reading the code only, without failing tests. They are outside the DB scope and were left for the owners of those areas.
- Restoring an **old backup** (`backup.ts`, TRUNCATE + reload) into a DB with the new CHECKs was not exercised. Rows that break a CHECK would make the restore fail. The dev data passes the precheck, but older backups could still contain such rows.
- Production-size lock timing of `VALIDATE CONSTRAINT`: only the dev seed (~2k orders) was used.
- RLS policy correctness itself was not in this scope; it was covered in Phase 6.
- The full integration suite (31 files, 207 tests) and `npm run test:api` (23 files, 717 tests) passed on `canavo_it_dba`. Unit tests: 160 passed. `tsc --noEmit -p apps/api`: clean.
