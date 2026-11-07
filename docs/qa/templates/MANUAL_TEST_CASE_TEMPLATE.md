# Manual test case template

Write each case so that someone who has never seen the code can run it. Use real screen and button names exactly as they appear in the app.

## Fields

| Field | How to fill it |
|---|---|
| TC ID | `TC-<MODULE>-<NNN>`, e.g. `TC-BILL-014` |
| Module | Billing, Kitchen, Tables, Delivery, Reservations, Inventory, Customers, Offers, Attendance, Reports, Menu, Staff, Settings, Platform, Auth, Notifications |
| Role | The login used (Super Admin, Owner, Manager, Cashier, Kitchen, Inventory, Delivery) |
| Priority | Critical / High / Medium / Low |
| Type | Functional / Negative / Boundary / UI / Usability / Security / Compatibility |
| Requirement | RTM ID(s) |
| Preconditions | State needed before step 1 (hotel, settings, data, device) |
| Test data | Exact values to type or select |
| Steps | Numbered, one action each |
| Expected result | Observable outcome for the whole case; numbers exact |
| Actual result | Filled by the tester |
| Status | Pass / Fail / Blocked / NA |
| Bug ID | BUG-xxx when Fail |
| Tester | Name |
| Date | YYYY-MM-DD |
| Device / Browser | e.g. Chrome 130 / Windows 11 · Redmi 9A Android 11 |

## Example

| Field | Value |
|---|---|
| TC ID | TC-BILL-014 |
| Module | Billing |
| Role | Cashier |
| Priority | Critical |
| Type | Functional |
| Requirement | BILL-02, OFR-02 |
| Preconditions | Hotel "Chai Corner" (GST not registered). Offer "Buy 2 Samosa, get 1 Chai free" active. Logged in as cashier. |
| Test data | Samosa (2 pcs) ₹30 × 2, Masala Chai (Regular) ₹15 |
| Steps | 1. Open **Billing & orders → POS**. 2. Tap **Samosa (2 pcs)** twice. 3. Check the cart. 4. Tap **Charge**. 5. Choose **Cash**, enter ₹60, tap **Pay**. |
| Expected result | Step 3: Masala Chai is added automatically, marked **FREE**. The summary shows one offer line, "Buy 2 Samosa, get 1 Chai free −₹15.00", and no GST rows. Charge shows **₹60.00**. Step 5: bill saved and the receipt shows ₹60.00 with no tax lines. |
| Actual result | |
| Status | |
| Bug ID | |
| Tester | |
| Date | |
| Device / Browser | |
