# Phase 5: Canteen and institutional (new module)

| | |
|---|---|
| Branch | `feat/market-leader`: foundation (`6707543`, `5351175`) plus two agents in parallel (`agent/accounts`, `agent/slots`), merged and verified |
| Date | 2026-11-01 |
| Tests | Unit **187** (shared 43, API 144) · Integration **148** on real Postgres as a non-superuser · Smoke **17** · Browser check: all 7 canteen screens · typecheck (API, web, mobile) and lint clean |

## Summary

There's a new **Canteen & institutional** module, switched on per business by the Super Admin. It requires Billing and Customers. **Hotels without it see no change.**

What it covers:
- **Corporate accounts and members:**
  - Companies with GSTIN, credit limit and a meals-per-day limit.
  - Employee members with employee code, department and RFID/QR card; CSV import.
- **Subsidies and quotas:**
  - The company pays a percentage or a ₹ amount per meal, capped per meal and per day, for one slot or all slots.
  - The company's share is recorded as a `CORPORATE` payment and billed monthly. The employee pays the rest.
  - Meal quotas per member per day.
- **Statements:** per company and period, downloadable (Excel/PDF), frozen when raised, marked paid.
- **Wallets and cards:**
  - Member wallets topped up at the counter. Top-ups are prepaid money owed to members, not sales; cash top-ups count in the cash drawer.
  - New payment modes `WALLET` and `MEAL_TOKEN`.
  - A "Scan card" field on the POS (USB RFID readers type the card number) shows wallet balance, quota left and the subsidy that will apply.
  - Prepaid meal tokens.
- **Meal slots:**
  - Breakfast, lunch and so on, each with its own menu and prices. Items on no slot sell all day.
  - The POS shows only what sells in the slot open now.
- **Next-day pre-orders:** with a cutoff time on the previous day; managers can override.
- **Production plan:** per slot and item, pre-orders plus meal plans, expected walk-ins (average of the last 4 same weekdays), and ingredients needed against current stock. Printable and downloadable.
- **Meal plans (subscriptions):**
  - Paid upfront on one normal bill, so GST is charged once.
  - Each day's meal becomes a zero-value pre-order at the slot's cutoff (job every 5 minutes), and the kitchen gets the KOT.
  - Pause and skip a day; cancelling refunds undelivered meals by credit note.
- **Canteen report:** by company and by department (meals, gross, company share, employee share, wallet spend, tokens), plus total wallet/token balances owed.

## Migrations

| Migration | Change |
|---|---|
| `…_canteen_meal_slots` | `MealSlot` (+ RLS) |
| `…_order_meal_slot` | `Order.mealSlotId` |
| `20261101173443_canteen_accounts_wallets` | Corporate accounts, subsidy rules, member fields, wallets, meal tokens, statements: 6 tables, all with forced RLS. `PaymentMode` += `CORPORATE`, `WALLET`, `MEAL_TOKEN`. |
| `20261101173653_canteen_slot_menus_subscriptions` | Slot menus, meal plans, plan skips and the related tables (4, forced RLS). `Order.servedAt`. |

I verified that the migrations applied in order produce exactly the merged schema (empty diff).

**Rollback:**
- Switch the module off for a business; this is instant.
- To drop the tables, first export the statements and wallet ledgers, because they are money records.
- Enum values can't be dropped; unused they are harmless.

## Integration notes

- **Two routers on `/canteen`:** the meal-slots router handles only its own sub-paths and is mounted first.
- **Navigation:** both agents created a "Canteen" nav group; merged into one.
- **Schema merge:** a model was left unclosed; fixed.
- **Foundation bug (mine):** the foundation commit was missing a permission label, so shared didn't build. Both agents caught it.
- **Print fix:** the slots agent added a print rule (`.print-sheet`). Before it, the page-wide print rule hid everything, so the cash-drawer Z-report likely printed blank.

## Decisions (please confirm)

1. **GST on subsidies:** the bill goes to the employee at full price with GST, and the company's share is a payment on that bill. The monthly statement is a statement of payments, not a separate tax invoice. If a company needs a B2B tax invoice for its share, the bill must be split. That's a change we can make.
2. **Wallet top-ups, meal tokens and meal-plan purchases:**
   - Wallet top-ups and tokens are prepaid money owed to members, like gift cards: no GST when sold, and GST on the meal bill.
   - Meal plans are different: they're sold on a normal GST bill upfront, and each day's meal is a zero-value bill.
3. **Meal tokens:** a token pays up to its value. If the meal costs less, the difference isn't refunded.
4. **Meal-plan refunds:** skipped or paused meal-plan days are refunded only when the plan is cancelled, not automatically at the end.
5. **Slot prices** replace the item price within the slot. Items with sizes keep their size prices.
6. **Canteen pre-orders** work with the Canteen module alone; the Reservations module isn't required.
7. **Meal counting:** every non-cancelled bill with the member on it counts towards the quota. Reports group by the member's current company and department.

## Not done yet

- A manager override for a used-up quota.
- Canteen screens in the mobile app.
- Self-service booking by employees.
- Automatic month-end statements (raised by hand today).
- "Production plan" in scheduled report emails. It needs canteen access, not report access.
- The canteen integration tests use the real clock, so they can fail if run between 23:30 and midnight IST, near the cutoffs.

## Could not verify

- Real RFID readers. The USB keyboard-mode flow is supported; check with your reader model.
- CA review of the subsidy and wallet GST treatment.
