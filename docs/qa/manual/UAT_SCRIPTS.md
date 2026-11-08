# UAT scripts — a day in the life, per role

Business users run these on the **staging** build with the demo data (Demo Hotel → outlet "CANAVO Canteen").
Every demo login uses the password `Canavo@123`; staff PIN `1234`. Do the steps in order; each takes the time shown.
Write anything odd in the Notes column, even if the step "passed". Raise a bug with
[BUG_REPORT_TEMPLATE](../templates/BUG_REPORT_TEMPLATE.md) for every Fail.

**Accept** = every step Pass, or Fail only on P3 cosmetic items that the product owner accepts in writing.

Logins: owner@ · manager@ · cashier@ · kitchen@ · inventory@ · delivery@ · waiter@ · accountant@ · auditor@canavo.local
(business) · admin@canavo.local (Super Admin) · support@canavo.local (platform support).

---

## 1. Owner — Omkar (owner@canavo.local) · ~60 min

| # | Time | Step | Expected | Pass/Fail | Notes |
|---|---|---|---|---|---|
| 1 | 08:00 | Sign in on a laptop | Dashboard: yesterday's sales, top items, payment split | | |
| 2 | 08:05 | Reports → Sales → yesterday; download Excel and PDF | Same total in screen, Excel and PDF; ₹ in lakh grouping | | |
| 3 | 08:10 | Reports → All outlets | One row per outlet, total = sum | | |
| 4 | 08:15 | Settings → Integrations: check Razorpay, Email, SMS, WhatsApp cards | Each shows Connected / Not connected; secrets only as ••••last4 | | |
| 5 | 08:20 | Settings → WhatsApp templates → Send test (receipt) to your phone | Message arrives | | |
| 6 | 08:25 | Offers → create coupon `OWNER10` 10 % max ₹50, today only | Saved; cashier can apply it today | | |
| 7 | 08:30 | Menu → change Veg Thali price ₹110 → ₹120 | POS and online page show ₹120 within a minute | | |
| 8 | 08:35 | Staff → add a cashier "Pooja" (phone 9845099020) | Pooja can sign in | | |
| 9 | 08:40 | Customers → Neha Agarwal → Download data, then Erase | Export file only has Neha; after erase, name/phone masked, old bills kept | | |
| 10 | 08:45 | Account → Appearance → Business brand accent → pick a colour | Staff and online page use it | | |
| 11 | 08:50 | Admin → Audit log: find steps 6–10 | Each entry with your name and IST time | | |
| 12 | 08:55 | Admin → Export data | File has no passwords, PINs, keys | | |
| 13 | 21:30 | Dashboard after close | Day's sales match the cashier's cash-drawer close + UPI | | |

## 2. Manager — Manoj (manager@canavo.local) · ~60 min

| # | Time | Step | Expected | Pass/Fail | Notes |
|---|---|---|---|---|---|
| 1 | 07:00 | Sign in; check Attendance for the morning shift | Who clocked in, who is late (after 07:10) | | |
| 2 | 07:10 | Menu → mark Kulfi out of stock | SOLD OUT online; greyed on POS | | |
| 3 | 07:20 | Menu → Import: download template, add 3 items, upload, confirm | Preview first, then 3 new items | | |
| 4 | 09:00 | Approve a 60 % discount at the cashier's POS with your PIN | Approved; audit entry | | |
| 5 | 11:00 | Delivery → Zones & settings → switch to **Address only**; fee ₹30, min ₹150, areas 560034, Koramangala | Saved; online page shows flat fee, no map | | |
| 6 | 11:15 | Delivery board: watch an order auto-assign to Deepak | Assigned; waiting queue when he is at the limit (2) | | |
| 7 | 13:00 | Bills → cancel a bill with reason | Credit note; stock back; audit | | |
| 8 | 15:00 | Approve Ravi's leave request | Calendar updated | | |
| 9 | 16:00 | Inventory → Recipes → Veg Thali food cost | Cost and margin visible | | |
| 10 | 17:00 | Settings → Integrations | Status only, no edit fields (owner-only) | | |
| 11 | 22:00 | Reports → day close; switch delivery back to Map pin | Report matches Bills; zones unchanged | | |

## 3. Cashier — Kavya (cashier@canavo.local) · ~45 min, peak simulation

| # | Time | Step | Expected | Pass/Fail | Notes |
|---|---|---|---|---|---|
| 1 | 07:00 | Clock in on the mobile app at the outlet (PIN 1234) | Clocked in; on time | | |
| 2 | 07:02 | Cash drawer → open shift with ₹2,000 | Shift open | | |
| 3 | 07:05 | Bill 2 Masala Chai + 1 Samosa, cash ₹100 | Total ₹60, change ₹40, receipt prints | | |
| 4 | 07:10 | Bill Veg Thali + Mango Lassi, UPI QR | QR for ₹160; paid (auto with Razorpay test keys, else tap Received) | | |
| 5 | 07:15 | 5-item order, split Cash ₹100 + UPI rest | Two payments sum to total | | |
| 6 | 07:20 | Attach Priya (9845010001); redeem 100 points | Points discount applied; balance lower | | |
| 7 | 07:25 | Khata bill for Vikram (9845010004) ₹110 | Khata ₹750 | | |
| 8 | 07:30 | Apply WELCOME50 on a ₹250 bill for a new customer | −₹50 | | |
| 9 | 07:35 | POS delivery order, address mode: PIN 560034 | Chip "we deliver · ₹30"; fee line on bill | | |
| 10 | 07:40 | Open the bill drawer for an order still cooking | Kitchen status per item, updates live | | |
| 11 | 07:45 | Accept an online order in Online orders; mark ready | Customer tracker moves | | |
| 12 | 14:55 | Close the cash drawer; count cash | Difference ₹0 (or explained) | | |
| 13 | 15:00 | Clock out | Hours recorded | | |

## 4. Kitchen — Ravi (kitchen@canavo.local) · ~30 min

| # | Step | Expected | Pass/Fail | Notes |
|---|---|---|---|---|
| 1 | Sign in on the kitchen tablet / TV | Kitchen display opens | | |
| 2 | Cashier bills Veg Fried Rice + Masala Chai | Two tickets (kitchen + BEVERAGE) within 3 s, with sound | | |
| 3 | Start → Ready on each | Cashier sees "Ready" on the bill drawer | | |
| 4 | Ticket with note "less sugar" | Note visible in bold under the item | | |
| 5 | Unplug the network 1 min while 2 orders are billed; plug back | Offline badge, then both tickets appear without refresh | | |
| 6 | Reprint a KOT | Marked REPRINT | | |
| 7 | Inventory → Stock (view only) | Can see stock, cannot edit | | |
| 8 | My attendance → request leave | Request sent | | |

## 5. Inventory — Isha (inventory@canavo.local) · ~40 min

| # | Step | Expected | Pass/Fail | Notes |
|---|---|---|---|---|
| 1 | Sign in | Inventory → Stock opens | | |
| 2 | Find Milk by scanning barcode 8901262010016 | Milk (toned) found | | |
| 3 | Purchases → Nandini Milk Distributors, Milk 20 L @ ₹58 | Stock +20 L, average cost updated | | |
| 4 | Audit: count Onions 18 kg (system 20) | Variance −2 kg | | |
| 5 | Check low-stock list | Items below reorder level flagged | | |
| 6 | Transfer 5 kg rice to the second outlet (if any) | Both sides updated | | |
| 7 | Try /reports and /pos | "This page isn't available for your role" | | |

## 6. Delivery partner — Deepak (delivery@canavo.local) · ~45 min, mobile app outdoors

| # | Step | Expected | Pass/Fail | Notes |
|---|---|---|---|---|
| 1 | Sign in on the phone, allow location (precise), clock in at the outlet | On duty | | |
| 2 | Cashier creates a COD delivery ₹245 | Push + card in My deliveries | | |
| 3 | Navigate (address mode: opens Google Maps search with PIN) | Correct place | | |
| 4 | Picked up → Delivered; collect ₹245 | Customer tracker "Delivered"; COD balance ₹245 | | |
| 5 | Ride back; enter the outlet area | Board shows "back at outlet"; next order auto-assigned | | |
| 6 | Cash handover → manager receives ₹245 | Balance ₹0 | | |
| 7 | History / Dashboard | Own runs only | | |
| 8 | Clock out (from anywhere) | Allowed | | |

## 7. Super Admin — Asha (admin@canavo.local) · ~30 min

| # | Step | Expected | Pass/Fail | Notes |
|---|---|---|---|---|
| 1 | Sign in | Platform console; no hotel POS/bills/customers | | |
| 2 | Onboard "UAT Dhaba" with owner uat.owner@example.com, modules Billing + KOT + Channels | Owner can sign in; only those screens | | |
| 3 | Open Demo Hotel | Account info and counts only, no sales or staff names | | |
| 4 | Turn Inventory off for UAT Dhaba | Owner's Inventory menu disappears | | |
| 5 | Suspend UAT Dhaba | Its users signed out and refused | | |
| 6 | Activate again; reset owner password | Old sessions end; new password works | | |
| 7 | Admin → Backups → create | Listed; no download | | |
| 8 | Audit log | Platform actions only | | |

## 8. Waiter — Wasim (waiter@canavo.local) · ~30 min

| # | Step | Expected | Pass/Fail | Notes |
|---|---|---|---|---|
| 1 | Sign in on a phone | Tables opens | | |
| 2 | Open T3 for 2 guests; add 2 Masala Chai + Onion Pakoda; Send | KOT on KDS; tab ₹70 | | |
| 3 | Add Gulab Jamun later | Only the new item sent | | |
| 4 | Move T3 → P1 | Tab moves | | |
| 5 | Guest at T1 scans the table QR and orders; taps Call waiter | Order on T1; notification to you | | |
| 6 | Ask the cashier to bill P1 (you cannot take money) | No Pay button for you; /pos not available | | |
| 7 | Create a reservation for 4 at 20:00 | Listed | | |

## 9. Cinema runner (waiter@canavo.local on the Runner board) · ~30 min around one interval

Preconditions: owner created Screen 1 (rows F–G, 1–12), a show starting now − 30 min with the interval in 20 min.

| # | Step | Expected | Pass/Fail | Notes |
|---|---|---|---|---|
| 1 | Open Cinema → Runner board | Screen tabs with counts, "Interval in mm:ss" | | |
| 2 | 3 guests scan seats F3, F12, G1 and order "at interval", one "to seat now", one "counter" | Cards grouped by row, sorted by seat; counter token in large type | | |
| 3 | Deliver the "to seat now" order | Marked delivered; guest page updates within ~8 s | | |
| 4 | At the interval: deliver all interval orders, row by row | Each card cleared; nothing lost | | |
| 5 | A guest's UPI did not auto-confirm: cashier taps UPI received | Paid | | |
| 6 | After orders-close time, a guest tries to order | Page says ordering closed | | |

---

## Sign-off (one table per role)

| Role | Tester name | Date | Build / SHA | Steps passed / total | Open bugs (IDs) | Accept? (Y/N) | Signature |
|---|---|---|---|---|---|---|---|
| Owner | | | | / 13 | | | |
| Manager | | | | / 11 | | | |
| Cashier | | | | / 13 | | | |
| Kitchen | | | | / 8 | | | |
| Inventory | | | | / 7 | | | |
| Delivery partner | | | | / 8 | | | |
| Super Admin | | | | / 8 | | | |
| Waiter | | | | / 7 | | | |
| Cinema runner | | | | / 6 | | | |

**Product owner final UAT sign-off:** Name __________ Date ______ Decision: Accept / Accept with conditions / Reject
