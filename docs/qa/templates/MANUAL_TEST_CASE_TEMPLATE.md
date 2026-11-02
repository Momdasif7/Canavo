# Manual test case template

> Write each case so a **non-developer** (a cashier, a restaurant manager, a junior tester) can run it without help.
> One case = one behaviour. Use exact data values, not "some item".
> The spreadsheet version of this template is [`manual_test_case_template.csv`](manual_test_case_template.csv) (same columns, import into Excel / Google Sheets).

## Columns

| Column | What to write | Example |
|---|---|---|
| **TC ID** | `MTC-<AREA>-NNN` (areas as in RTM: AUTH, BIL, KOT, TAB, DEL, INV, CRM, OFF, ATT, REP, …) | MTC-BIL-014 |
| **Module** | Business module | Billing |
| **Role** | Who performs it | Cashier |
| **Priority** | Critical / High / Medium / Low | Critical |
| **Type** | functional / negative / boundary / UI / usability | boundary |
| **Requirement** | RTM Req ID(s) covered | BIL-004, GST-006 |
| **Preconditions** | State before step 1 | Logged in as cashier@saravana-test; outlet "Chennai"; shift open |
| **Test data** | Exact values | Masala Dosa ×2 (₹80 each, 5 % GST incl.), Filter Coffee ×1 (₹30) |
| **Steps** | Numbered, one action each, using the on-screen labels | 1. Tap **POS** 2. Tap *Masala Dosa* twice 3. … |
| **Expected result** | Observable outcome with exact values | Bill total shows **₹190.00**; CGST ₹4.52, SGST ₹4.52; Pay button enabled |
| **Actual result** | Filled by tester | |
| **Status** | Pass / Fail / Blocked / NA | |
| **Bug ID** | If Fail: BUG-NNN | |
| **Tester** | Name | |
| **Date** | YYYY-MM-DD | |
| **Device/Browser** | e.g. "Chrome 131, Windows 11, 1366×768" or "Redmi 9A, Android 11" | |

## Writing rules

1. **Steps use the words on screen.** Bold the button names: "Tap **Pay**", not "submit the form".
2. **The expected result is checkable.** Use exact amounts, messages and states. Avoid "works correctly".
3. **No hidden setup.** Everything needed is in the Preconditions or Test data, or links to a setup case (`Setup: MTC-MENU-001`).
4. **Negative cases say what must NOT happen**, for example "Bill is **not** created; message *Payment exceeds balance* is shown".
5. **Money is shown in rupees with 2 decimals** as the app displays it (₹1,23,456.00, using Indian grouping).
6. **Blocked ≠ Fail.** Mark *Blocked* when you could not reach the step (environment down, prerequisite bug) and write the reason in *Actual result*.
7. **Evidence on Fail.** Attach a screenshot or photo (receipts) and note the bill or invoice number.

## Example

| Field | Value |
|---|---|
| TC ID | MTC-BIL-014 |
| Module | Billing |
| Role | Cashier |
| Priority | Critical |
| Type | negative |
| Requirement | BIL-004 |
| Preconditions | Logged in as cashier; a takeaway bill of ₹190.00 is open and unpaid |
| Test data | Cash ₹100.00 + UPI ₹100.00 |
| Steps | 1. Open the bill and tap **Pay**. 2. Choose **Split**. 3. Enter Cash **100**. 4. Add UPI **100**. 5. Tap **Confirm payment**. |
| Expected result | Payment is **refused** with the message "Payment ₹200.00 exceeds balance ₹190.00". The bill stays **Open** and no payment is recorded. |
| Actual result | |
| Status | |
| Bug ID | |
| Tester | |
| Date | |
| Device/Browser | |
