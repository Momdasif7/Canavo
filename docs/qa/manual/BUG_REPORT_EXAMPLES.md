# Bug report examples (manual testing)

Three worked examples in the [BUG_REPORT_TEMPLATE](../templates/BUG_REPORT_TEMPLATE.md) format, showing the detail
expected from manual testers. **These are illustrative examples, not real defects** — IDs use the `BUG-EX-` prefix so they
are never confused with entries in [BUGS.csv](../BUGS.csv). Real bugs found in Phase 15 execution go into BUGS.csv and the
Bug Log sheet of MANUAL_TEST_CASES.xlsx.

---

# BUG-EX-01: 58 mm receipt cuts off the amount column for long item names

| Field | Value |
|---|---|
| ID | BUG-EX-01 |
| Severity | P2 UX |
| Priority | Medium |
| Module | POS billing / Receipts |
| Role(s) | Cashier |
| Environment | STAGING-LIKE; build `<sha>`; Android 12, Galaxy Tab A8; Bluetooth 58 mm printer (model, firmware) |
| Found by / date | Tester name, 2026-11-10 |
| Requirement | BILL-13 |
| Test case | TC-L10N-002, HARDWARE_CHECKLIST H4 |
| Status | New |

## Preconditions
- Demo Hotel / CANAVO Canteen; prices include GST; 58 mm printer selected in Settings → printer.
- Menu item "Special Hyderabadi Dum Chicken Biryani with Raita and Salan XL" ₹260 (added by manager).

## Steps to reproduce
1. Sign in on the mobile app as cashier@canavo.local / Canavo@123.
2. Add the long-named item ×1 and Masala Chai ×1.
3. Pay cash ₹300 and print.

## Expected result
Name wraps onto a second line inside the name column; qty and amount stay right-aligned on the first line (receipt
layout rule, BILL-13).

## Actual result
The name runs across the full width; the amount "260.00" is pushed to the next line at the left edge. Totals are correct.

## Evidence
- Photo of the printed receipt (attach). Same bill on 80 mm prints correctly.

## Impact
Every outlet with long item names on 58 mm printers; customers may misread amounts.

---

# BUG-EX-02: Online page accepts PIN 560035 although only 560034 is in the allowed areas

| Field | Value |
|---|---|
| ID | BUG-EX-02 |
| Severity | P1 feature broken (money: delivery outside area) |
| Priority | High |
| Module | Delivery address mode / Online ordering |
| Role(s) | Guest, Manager |
| Environment | STAGING-LIKE; build `<sha>`; Chrome 130 on Android 14 (Pixel 7) |
| Found by / date | Tester name, 2026-11-10 |
| Requirement | rqb delivery address mode |
| Test case | TC-DAM-004 |
| Status | New |

## Preconditions
- Manager set Delivery → Zones & settings → Address only; fee ₹30; min ₹150; areas `560034, Koramangala`.

## Steps to reproduce
1. Open the outlet's online ordering link in a private window; choose Delivery.
2. Add items worth ₹160; View cart → Next.
3. Address "12 Main Road, Ejipura", PIN `560035`.

## Expected result
Refusal: "Sorry, we don't deliver to PIN code 560035 — we deliver to 560034, Koramangala"; Place order disabled.

## Actual result
"We deliver here" shown; order placed with ₹30 fee.

## Evidence
- Screen recording; order number; network response of `/delivery-quote` (`deliverable: true`).

## Impact
Orders accepted outside the delivery area; riders sent too far or orders cancelled after payment.

---

# BUG-EX-03: Cashier still sees the POS for a minute after being changed to Waiter

| Field | Value |
|---|---|
| ID | BUG-EX-03 |
| Severity | P1 security (role change not enforced) |
| Priority | High |
| Module | Access & roles |
| Role(s) | Owner, Cashier |
| Environment | STAGING-LIKE; build `<sha>`; Chrome 130 Windows 11 (owner), Edge 130 Windows 10 (cashier) |
| Found by / date | Tester name, 2026-11-10 |
| Requirement | AUTH-05, RBAC-02 |
| Test case | CHAOS_TESTS X11 |
| Status | New |

## Preconditions
- Two browsers. A: owner@canavo.local. B: a cashier (Pooja) on the POS with an open cart.

## Steps to reproduce
1. In A: Staff → Pooja → Role = Waiter → Save (note the time).
2. In B: without refreshing, complete the bill: Pay → Cash → Confirm.

## Expected result
B is signed out (or the payment is refused with 401/403) as soon as the role changes (AUTH-05: token version).

## Actual result
Payment succeeds 40 s after the change; bill INV/… created by a user who is now a Waiter. After a refresh the POS
shows "This page isn't available for your role".

## Evidence
- Timestamps from both screens; audit log entries for the role change and the bill.

## Impact
A demoted / dismissed cashier can keep taking money for a short window.
