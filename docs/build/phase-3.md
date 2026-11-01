# Phase 3: Money integrity

| | |
|---|---|
| Branch | `feat/market-leader` (commits `2ff871d` … this commit) |
| Date | 2026-11-01 |
| Decisions applied | D1 coupon/₹-discount GST: pre-tax default + outlet setting (as recommended) · D6 gift cards: closed-loop (as recommended) |
| Tests | Unit **171** (shared 34, API 137) · Integration **109** on real Postgres as a non-superuser · Smoke **17** · Browser check **8/8** · typecheck (API, web, mobile) and lint clean |

## Summary

All 8 Phase 3 items are done. Two of them already existed and were verified: 3.4 offline numbering (now improved) and 3.5 round-off.

- **Refunds are proper GST credit notes.** They have their own series and can cover some items and quantities or a value only. Tax is reversed exactly; the refund goes back by cash, UPI, card, khata or gift card; ingredients can go back into stock. They show in the daily report, the bills summary and GSTR-1.
- **Manager approval PINs:** voids, refunds, cash pay-outs and big discounts need a manager's PIN at the counter, and are then logged.
- **Exceptions report** lists voids, refunds, big discounts, approvals and KOT reprints in one place.
- **Cash drawer:** open with a counted float, record pay-ins and pay-outs, close with a count and get a **Z-report** with the difference.
- **0% GST warning** for items on GST-registered outlets.
- **D1 setting:** "₹50 off" can mean ₹50 off the total, incl. GST.
- **Offers:** the POS shows **why an offer won**, and offers can be marked **combinable**.
- **Payments:** card last 4 and approval code, **tips** kept separate from sales, **gift cards**, and **card/UPI settlement reconciliation**.
- **Offline invoice series:** offline bills on the mobile app can print their **final invoice number**.

**Behaviour changes for existing hotels: none by default.**
- New screens: Bills → Refund, Cash drawer, Reports → Exceptions and Settlements, Settings → Money controls.
- Everything that changes a rule is behind a flag that is OFF for every hotel: `APPROVAL_PINS`, `REQUIRE_CASH_SHIFT`, `GIFT_CARDS`, `OFFLINE_INVOICE_SERIES`.
- The new settings default to today's behaviour: ₹ discounts stay pre-tax, and offers stay one per bill.
- One visible change: a bill that has refunds can no longer be cancelled. Refund the rest instead, so the GST record stays consistent.

## What was built

| # | Item | What changed | Main files | Proven by |
|---|---|---|---|---|
| 3.1 | Refunds / credit notes | Credit note against a PAID bill: items/quantities (the last units take the exact remainder, so a full refund equals the bill total incl. round-off) or a value (tax reversed in the bill's proportions). Series `CN<prefix>-<FY>-00001` per outlet/FY (16-char limit). Refund mode cash/UPI/card, khata (CREDIT entry, capped at the khata part) or gift card (back onto the card). Optional restock by recipe, booked against the credit note. Reason codes. Bills page Refund dialog and credit-note list. Daily report "refunds" and "sales after refunds"; bills summary; GSTR-1 B2CS/HSN net of the month's B2C credit notes. | `services/credit-notes.ts`, `routes/orders.ts`, `routes/reports.ts`, `components/bills/RefundDialog.tsx` | `money-integrity.test.ts` (12, with real 5% GST) |
| 3.2 | Cash shifts / Z-report | One open shift per outlet (DB partial unique index). Opening float; pay-ins / pay-outs. Live X figures. Close with a note counter or total → frozen Z-report: bills, discounts, tax, voids, payments and refunds by mode. Expected cash = float + counter cash + cash tips + gift cards sold for cash + delivery cash handed over + pay-ins − pay-outs − cash refunds; shows the difference. `REQUIRE_CASH_SHIFT` blocks cash without an open shift (offline syncs exempt). | `services/cash-shifts.ts`, `routes/cash-shifts.ts`, `app/(app)/cash-drawer` | `cash-shifts.test.ts` (3), browser check |
| 3.3 | Approval PINs, thresholds, exceptions | `APPROVAL_PINS`: discount above the outlet limit (default 10%, owner-only setting), void, refund, cash pay-out → owner/manager PIN on the cashier's device (shared PIN lockout). Managers acting themselves are logged as self-approved. Offline bills logged as "not approved". Web dialog retries the request with the PIN. Exceptions report (also Excel/PDF and scheduled emails). | `services/approvals.ts`, `lib/pin.ts`, `components/providers/ApprovalProvider.tsx`, `routes/reports.ts` | `money-integrity.test.ts`, browser check |
| 3.4 | Offline invoice numbering | Existed: numbered at sync. **Improved** behind `OFFLINE_INVOICE_SERIES`: each device gets its own series (e.g. `INVA1`). The mobile app numbers offline bills itself and prints them as final. At sync the number is kept only if it belongs to that device's series and FY and isn't taken; otherwise the normal counter. | `services/offline-series.ts`, `apps/mobile/src/pos/offlineSeries.ts` | `offline-series.test.ts` (3) |
| 3.5 | Round-off | Exists (verified in Phase 0). Full refunds include it. | — | covered by 3.1 tests |
| 3.6 | 0% GST safeguard; coupon GST | Menu tax check lists items billed at 0% on GST-registered outlets (banner + item form warning). D1: per-discount `includesTax` in the shared `computeBill` (server bill, server preview and offline POS agree). When the outlet turns it on, it marks manual ₹ discounts, ₹-off coupons/offers and points. %-based savings are never converted. | `packages/shared/src/gst.ts`, `services/promotions.ts`, `routes/menu.ts`, `components/settings/MoneyControlsCard.tsx` | `gst.test.ts`, `gst-safeguards.test.ts` (4) |
| 3.7 | Why this offer won; combining | The preview returns every offer and coupon checked, with its saving alone and the reason it was or wasn't applied. POS "Why this offer?" panel. Per-offer "can combine": applies on top of the winner, only on items no other offer discounted. The real bill matches the preview. | `services/offer-engine.ts` (`rankOffers`), `services/promotions.ts`, `components/pos/CartPanel.tsx`, `components/crm/OfferForm.tsx` | `offers-combine.test.ts` (3) |
| 3.8 | Card ref, settlement, tips, gift cards | Card last 4 and approval code. Tips per payment (not sales, no GST; cash tips in the drawer; daily report). Gift cards (`GIFT_CARDS`, closed-loop): sell without GST, spend with compare-and-set, split with cash/UPI/card, refund back, cancelled bills restore the balance, block lost cards, outstanding liability shown. Settlement reconciliation: paste bank/acquirer rows; match by reference, then exact amount (incl. tip); pending list. | `services/gift-cards.ts`, `routes/gift-cards.ts`, `routes/settlements.ts`, `components/pos/PaymentDialog.tsx`, `app/(app)/gift-cards`, `app/(app)/reports/settlements` | `payments-extras.test.ts` (7), browser check |

## Migrations

All additive. Every new table has row-level security, and the RLS coverage test passes.

| Migration | Change | Rollback |
|---|---|---|
| `20261101131623_approvals` | enum `ApprovalAction`; `Outlet.approvalDiscountPercent` (default 10); table `ApprovalLog` | `DROP TABLE "ApprovalLog"; DROP TYPE "ApprovalAction"; ALTER TABLE "Outlet" DROP COLUMN "approvalDiscountPercent";` |
| `20261101131939_credit_notes` | `Order.refundedAmount`; enum `RefundReason`; tables `CreditNote`, `CreditNoteCounter` | `DROP TABLE "CreditNote", "CreditNoteCounter"; DROP TYPE "RefundReason"; ALTER TABLE "Order" DROP COLUMN "refundedAmount";` (first export credit notes: they are GST records) |
| `20261101162158_cash_shifts` | enums; tables `CashShift` (+ partial unique index on open shift), `CashMovement` | `DROP TABLE "CashMovement", "CashShift"; DROP TYPE "CashShiftStatus", "CashMovementType";` |
| `20261101162532_flat_discount_tax_mode` | `Outlet.flatDiscountsIncludeTax` (default false) | `ALTER TABLE "Outlet" DROP COLUMN "flatDiscountsIncludeTax";` |
| `20261101163312_offer_combinable` | `Offer.combinable` (default false) | `ALTER TABLE "Offer" DROP COLUMN "combinable";` |
| `20261101163737_payments_tips_giftcards` | `PaymentMode` += `GIFT_CARD`; `Payment.tip`, `cardLast4`, `authCode`, `giftCardId`, `settledAt`, `settlementRef`; tables `GiftCard`, `GiftCardTxn` | `DROP TABLE "GiftCardTxn", "GiftCard"; DROP TYPE "GiftCardTxnType"; ALTER TABLE "Payment" DROP COLUMN …;` An enum value can't be dropped in Postgres: leave `GIFT_CARD` in place (harmless when unused). |
| `20261101164501_offline_series` | table `OfflineSeries` | `DROP TABLE "OfflineSeries";` |

## Bugs found and fixed during Phase 3

| Id | Severity | What | Fix |
|---|---|---|---|
| (P3-a) | P1 | My first D1 version converted every flat bill discount to GST-inclusive. Offers and coupons hand `computeBill` their savings as pre-tax flat amounts, including savings worked out from a percentage, so those would have shrunk a second time. | Per-discount `includesTax`; regression test with % and ₹ coupons (before any release) |
| (P3-b) | P2 | Integration fixtures billed food at 0% (no tax rate, so the hotel default "exempt" applied), which made the refund tax checks trivially true | Fixtures use a real 5% rate; tests assert tax > 0 |
| (P3-c) | P2 | A paid bill could be cancelled after a partial refund, restoring stock and reversing twice | Cancel refused once a bill has refunds |

## Decisions (please confirm)

1. **D1:** ₹ discounts stay **pre-tax by default** (today's behaviour). Each outlet can switch to GST-inclusive under Settings → Money controls. Please confirm with your CA which your hotels should use.
2. **D6:** gift cards are **closed-loop**: usable only at the business that sold them, no cash-out, no transfers. Selling one is not a sale and carries no GST; the bill it's spent on carries the GST. Confirm with counsel if you plan open-loop cards later.
3. **With approvals on, cashiers can void and refund** when a manager types their PIN. Without approvals, only managers and owners can, as before.
4. **No cancel after a refund:** refund the rest instead, so the credit notes stay a complete record.
5. **The offline invoice series is on mobile only.** The web POS keeps provisional numbering offline. Most offline billing happens on the phone app; the web can follow in Phase 12.

## Risks

| Risk | Mitigation |
|---|---|
| Credit notes and GSTR-1: CDNR/CDNUR and the document-summary credit-note line aren't produced yet | B2C credit notes already net into B2CS/HSN (correct for unregistered buyers). B2B parts come with GSTIN capture (Phase 8.4). Noted in the GSTR-1 output. |
| A device reinstall restarts its offline count, and a number collides | Server falls back to the normal counter; the series refresh merges the server's last number back into the device |
| Approval PIN shared or seen at the counter | PINs are personal, locked after 5 wrong tries, and every approval is in the exceptions report |
| Gift card balances are a liability | Outstanding balance shown on the Gift cards page; blocking for lost cards |
| Settlement matching by amount alone can pick the wrong one of two equal payments on a day | Reference (approval code / UTR) is matched first; amount-only matches are labelled "amount" in the result |

## Could not verify (running list)

| Item | Why | Plan |
|---|---|---|
| Real acquirer / bank settlement file formats | Need your bank's files | The paste format accepts CSV/tab rows (date, amount, reference); adjust the parser to your bank's export |
| Mobile offline series on real phones (offline print) | Need devices | API and logic tested; device checklist (QA Phase 15) |
| CA review of credit-note layout and the D1 choice | Needs your CA | Listed in Decisions |
| Earlier items | Carried over | See phase-2.md |

## Next

Phase 4 (Roles and owner experience) starts on your "continue". It needs no new decision. It's the last phase of the pilot set (Phases 1–4).
