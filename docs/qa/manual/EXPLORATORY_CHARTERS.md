# Exploratory test charters (session-based)

Each charter is one **time-boxed session (60–90 min)** by one tester, no script. Use the session sheet at the bottom.
Report: **charter · areas covered · bugs (IDs) · issues/questions · % time on test / bug / setup**. Debrief with the
QA lead within a day. Data: demo business (`*@canavo.local`, `Canavo@123`, staff PIN `1234`).

| # | Charter | Time | Role(s) | Setup |
|---|---|---|---|---|
| EC-1 | Billing under pressure | 90 | Cashier + Kitchen | 2 POS terminals (web + mobile), KDS on a TV, receipt printer |
| EC-2 | Offers combinations | 60 | Cashier, Manager | Seeded offers + coupons WELCOME50, FEST10; clock you can change (test machine) |
| EC-3 | Delivery edge cases | 90 | Cashier, Manager, Delivery | 2 partner phones, address mode and map mode |
| EC-4 | Offline chaos | 75 | Cashier (mobile + web), Kitchen | Router you can switch off; airplane mode |
| EC-5 | Permission probing | 90 | All 11 roles | Browser DevTools, two browsers |
| EC-6 | Menu bulk upload abuse | 60 | Manager | Template, Excel, LibreOffice, a text editor |
| EC-7 | Report cross-checking | 90 | Owner, Accountant | A day with ≥ 30 bills incl. cancels, refunds, khata, split |
| EC-8 | Cinema interval rush | 60 | Guests (5 phones), Runner, Kitchen | Screen with 24 seats, interval in 15 min |

## EC-1 Billing under pressure
**Mission:** explore POS speed and correctness when two cashiers bill 40 orders in 20 minutes, to find wrong totals,
duplicate bills, lost KOTs or UI freezes.
**Ideas:** 5-item orders with sizes and add-ons; edit qty while the cart recalculates; pay before the total settles;
double-tap Pay; hold/resume while a KOT prints; same customer on both terminals; receipt printer out of paper mid-rush;
one cashier cancels while the other reprints the same bill; check that every KOT reached the KDS (count them).
**Oracle:** Bills list count = bills made; KDS tickets = orders × stations; cash drawer expected cash correct.

## EC-2 Offers combinations
**Mission:** explore the "one offer per bill, best saving wins" rule to find bills where two offers stack, the smaller
one wins, or the shown saving differs from the receipt.
**Ideas:** happy-hour boundary 14:59:59 / 15:00 / 17:00; BxGy with 2, 3, 4 samosas and chai already in cart; combo + happy
hour on the same chai; coupon vs bill discount near ₹500; coupon min order exactly ₹200; loyalty points + manual
discount on top of an offer; remove an item after the offer applied; online page offers strip vs POS result; disable
an offer while a cart is open.
**Oracle:** hand-calculate each bill (GST inside the price, discount before tax).

## EC-3 Delivery edge cases
**Mission:** explore assignment, limits, address mode and COD to find stuck orders, overloaded partners or wrong fees.
**Ideas:** partner at limit 2 gets a 3rd; partner clocks out with a run open; partner GPS off; two managers assign the
same order; customer PIN on the boundary list (560034 vs 560035); area names with dots ("T. Nagar"), typos, suffixes;
switch Map ↔ Address with orders open; flat fee ₹0 and no areas; minimum order exactly met after removing an item;
COD collected short; cancel after "picked up".
**Oracle:** board, partner app and customer tracker all agree; COD balance equals collected minus handed over.

## EC-4 Offline chaos
**Mission:** explore offline billing to find lost, duplicated or mis-numbered bills.
**Ideas:** airplane mode mid-payment; kill the app with 3 pending bills; reconnect on a flaky hotspot; web POS with the
router off for 10 min then on; same order synced from two devices; clock skew of +2 h on the device; storage almost
full; sign out while bills are pending (should warn).
**Oracle:** each offline bill appears once on the server, totals unchanged, invoice numbers continuous per FY.

## EC-5 Permission probing
**Mission:** explore every role's reach beyond its menu to find data or actions it should not have.
**Ideas:** type URLs from another role's menu (see Access & roles cases); open a bill/customer/delivery link copied from a
higher role; replay a request from DevTools with a changed id; Super Admin trying any hotel URL; Platform support after
the owner revokes access; custom role with fewer permissions; module switched off while the user is signed in;
auditor trying any save button; cashier exporting reports via the API.
**Oracle:** rbac.ts / RTM RBAC-01…07; "This page isn't available for your role" or 403/404 — never data.

## EC-6 Menu bulk upload abuse
**Mission:** explore the Excel/CSV import to find crashes, partial imports, injection or silent data loss.
**Ideas:** blank rows in the middle; 10,000 rows; merged cells; hidden sheets; prices "₹1,200.00", "1.200,00", "12e3";
GST 5% as text; HSN with leading zero; duplicate names differing by case/space; Indic names; emoji; formulas
(`=1+1`, `=HYPERLINK`); CSV in UTF-16 / with BOM / semicolons; an xlsx renamed .csv; image URLs to private IPs and to a
20 MB image; upload twice; confirm after the session expired.
**Oracle:** preview = what is saved; nothing saved without Confirm; exports never execute formulas.

## EC-7 Report cross-checking
**Mission:** cross-check sales, GST, payments, items and stock reports against Bills to find mismatches.
**Ideas:** day with cancels, partial refunds, khata, split payments, gift cards, delivery fees, service charge, 0 % / 12 %
/ 18 % items; bills at 23:59 and 00:01 IST; GSTR-1 B2CS vs HSN summary vs bill totals; Excel vs PDF vs screen;
All outlets vs single outlet; inventory consumption vs recipes × qty sold.
**Oracle:** sums to the paisa; credit notes netted; IST day boundaries.

## EC-8 Cinema interval rush
**Mission:** explore seat ordering when 20 guests order in the last 5 minutes before the interval.
**Ideas:** two guests on the same seat QR; order after close time by keeping the page open; UPI left pending; phone screen
locked during payment; runner board with 3 screens; delete a showtime with orders; rotate the screen QR mid-show;
very low brightness / cheap phone; slow 3G in the hall.
**Oracle:** every paid order on the board and KDS with the right seat bar; nothing after close; no white flash.

## Session sheet
| Field | |
|---|---|
| Charter | |
| Tester / date / build | |
| Start – end (min) | |
| % test / bug investigation / setup | |
| Areas & data covered | |
| Bugs raised (IDs) | |
| Issues / questions for the product owner | |
| Follow-up charters suggested | |
