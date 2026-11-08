# Localization and content review

The UI is English; data (item, customer, outlet names, notes) can be in any Indian script. Money is INR with Indian
grouping; time is IST. Automated checks for ₹ grouping, phone and IST are in Phase 14
([phase-14-compliance.md](../phase-14-compliance.md)); this review covers what a person must look at.

## Test data
| Kind | Values |
|---|---|
| Long item name (60) | Special Hyderabadi Dum Chicken Biryani with Raita and Salan XL |
| Long customer name | Venkata Satya Sai Lakshmi Narasimha Subrahmanyam Chowdary |
| Long outlet / address | Sri Lakshmi Venkateshwara Pure Veg Udupi Refreshments, No. 1234/5, 17th Cross, 80 Feet Road, Koramangala 4th Block, Bengaluru 560034 |
| Hindi | मसाला चाय, समोसा (2 पीस), पनीर बटर मसाला |
| Kannada | ಮಸಾಲ ದೋಸೆ, ಫಿಲ್ಟರ್ ಕಾಫಿ |
| Tamil | இட்லி வடை, மசாலா தோசை |
| Telugu / Malayalam / Bengali / Gujarati | బిర్యానీ · ബിരിയാണി · বিরিয়ানি · ખમણ |
| Special characters | Rahul & Sons · O'Brien · "Chef's Special" · <b>bold</b> · 50% off · C++ · emoji 🍛🌶️ · ZWJ ‍ |
| Amounts | ₹0.50 · ₹999 · ₹1,000 · ₹99,999.99 · ₹1,00,000 · ₹12,34,567.89 · ₹1,23,45,678 (1.23 Cr) |
| Dates / times | 23:59 and 00:01 IST; 31-Mar → 01-Apr (FY change); 29-Feb-2028 |
| Phone | 9845010001 · +91 98450 10001 · 098450 10001 |

## Checklist
| # | Where | Check | Result |
|---|---|---|---|
| L1 | POS item card, cart line | Long and Indic names wrap / ellipsis, price never hidden | |
| L2 | Receipt 58 mm / 80 mm / PDF | Long names wrap under the name column; amounts aligned; Indic text prints or falls back legibly; ₹ prints | |
| L3 | KOT | Indic names large and readable; notes wrap | |
| L4 | Online ordering page, cinema seat page | Long names 2 lines with "more"; Indic fonts render on Android Go phones | |
| L5 | Search | Searching "चाय", "ದೋಸೆ" finds the items; English search unaffected | |
| L6 | Menu import | Indic names in Excel/CSV (UTF-8, with BOM) import without "????" | |
| L7 | Excel / PDF exports | Indic text survives; money uses lakh format `#,##,##0.00` | |
| L8 | Amounts everywhere | Dashboard, reports, bills, receipts, partner cash: lakh/crore grouping; "Cr" tier ≥ 1 crore; paise shown where needed | |
| L9 | Special characters | Shown literally in names, notes, WhatsApp previews, receipts — no HTML rendering, no broken CSV | |
| L10 | Dates | DD-MMM-YYYY or DD/MM/YYYY consistently; IST on receipts even if the browser is in another time zone | |
| L11 | Number input | Typing "1,200" or "1200.5" in price fields: accepted or clear message | |
| L12 | Copy / wording | Plain English, no developer terms ("409", "null", "undefined"), consistent names (Bill vs Invoice; Khata), Indian spelling | |
| L13 | Error messages | Every error tells the user what to do next | |
| L14 | Receipt legal text | "Tax Invoice" / "Bill of Supply" / "Bill" correct for GST mode; composition declaration wording | |
| L15 | WhatsApp / SMS | Templates render ₹ and names correctly on the customer's phone | |
| L16 | RTL / mixed | Urdu name (کباب) displays without breaking the line order | |

Reviewer: ________ Date: ______ Build: ______
