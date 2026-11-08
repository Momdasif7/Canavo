# QA Phase 14 — Compliance & domain correctness (agent/cmp)

Tests: `packages/shared/src/compliance.test.ts` (23, also run with TZ=UTC and TZ=America/New_York) and
`apps/api/test/api/compliance.test.ts` (14, also run with TZ=UTC and TZ=America/New_York). Migration
`20261109120000_customer_consent_erasure` (adds 5 columns to Customer; existing rows are opted out).

## Checks
| Area | Check | Result |
|---|---|---|
| GST maths | 0/5/12/18/28 % (+12 % cess) bills vs hand calculation; CGST+SGST vs IGST; inclusive prices; discount before tax; service charge, packaging taxed at line rate; round-off | Pass |
| Doc types | Composition → "BILL OF SUPPLY", Rule 49 declaration, no tax lines; GST off → plain "BILL" without GSTIN/HSN/tax | Pass |
| Rule 46 fields | Supplier name / legal name / address / GSTIN, number ≤16 unique per FY, IST date, HSN/SAC, taxable value, rate-wise tax | Pass after cmp-4 (place of supply, thermal HSN, signatory line) |
| Invoice / CN numbers | 16-character limit for every prefix and volume | Fail → cmp-1, cmp-2 fixed |
| GSTR-1 | B2CS = HSN = bill totals net of credit notes; doc summary counts cancelled invoices; CN series nature 5 | Pass |
| GSTIN | shape + state code + check character, state matches outlet | Fail → cmp-3 fixed (outlet, vendor, corporate account) |
| FSSAI | 14-digit field printed on all receipts (incl. plain bills) | Pass; warning when missing (cmp-11) |
| IST day | FY, receipt dates, daily report hour bucket under server TZ UTC / New York | Pass; one UTC date fixed (cmp-10) |
| ₹ format | lakh / crore grouping in web, receipts, PDF, reports, Excel | Fail → cmp-9 fixed |
| Phone | +91 / 0 prefix, 10 digits, 6–9 start | Fail → cmp-8 fixed |
| DPDP consent | Customer marketing / WhatsApp opt-in; promotional sends gated | Fail → cmp-5 fixed |
| DPDP rights | Customer data export, erasure keeping invoices masked; retention doc | Missing → cmp-6 built, `docs/legal/data-retention.md` |
| Aadhaar | LAST4 default, Verhoeff check, AES-256-GCM in FULL mode, masked `XXXX-XXXX-1234`, reveal audited, hidden from support view, consent text + version, delete endpoint | Pass (verified in code + existing tests) |
| Owner export | no passwords / PIN / token hashes / Aadhaar ciphertext / secrets | Fail → cmp-7 fixed |
| Backups | Super Admin cannot download (no route; create / restore only) | Pass |

## Defects
| ID | Sev | Title | Fix |
|---|---|---|---|
| cmp-1 | P1 | Refunds fail for outlets with a 4–5 character invoice prefix: "CNCANT-2026-00001" is 17 chars → throws | CN prefix = "CN" + 3 chars (`credit-notes.ts`) |
| cmp-2 | P1 | Billing stops at bill 100,000 in a FY with a 5-char prefix (17 chars) | Fallback to 2-digit FY `PREFX-26-100000` only on overflow; `parseInvoiceNumber` reads both |
| cmp-3 | P2 | GSTIN accepted with wrong check char / unknown state; GSTIN of another state than the outlet; any 2-digit state code | `gstinSchema` (checksum), `gstStateCode`, API 400 on state mismatch; web form same checks; fixtures fixed |
| cmp-4 | P2 | Receipts lacked place of supply (Rule 46(n)); thermal lacked HSN/SAC; no signatory/declaration | "Place of supply: 33-Tamil Nadu" (IGST bills: "Outside … (inter-state)"), `HSN/SAC:` line, PDF "For <legal name> / Authorised signatory", thermal "Computer-generated document" |
| cmp-5 | P1 | Birthday / anniversary promotional WhatsApp (with coupons) sent to every customer; no consent record | `marketingOptIn` + `whatsappOptIn` (+ `consentAt/Source`), default off; CRM job requires both; form toggles |
| cmp-6 | P1 | No data-principal flow | `GET /customers/:id/data-export`, `POST /customers/:id/anonymise` (owner, audited, refused while khata / wallet / open bill), web buttons |
| cmp-7 | P1 | Owner export contained ChannelConnection `apiKeyEnc` / `webhookSecretEnc` and push `DeviceToken`s | Redacted / excluded + generic `*Hash/*Enc/*Secret` column filter |
| cmp-8 | P3 | "+91 98765 43210" / "098765…" rejected everywhere | `indianPhone` normalises to 10 digits (Phase 6 tests that expected "+91…" → 400 now use a foreign prefix) |
| cmp-9 | P3 | Excel money `#,##0.00` (western), API messages "₹1234.50", dashboard ≥1 Cr shown as "150.0L" | Indian Excel format, `formatINR`, Cr tier |
| cmp-10 | P3 | Delivery cash alert "once a day" keyed on the UTC date | IST date |
| cmp-11 | P3 | Missing FSSAI number not flagged | Outlet save warns |

## Legal recommendations (not built)
- **B2B:** buyer GSTIN / state are not captured, so no B2B / B2CL / CDNR in GSTR-1 and IGST bills have no real place of
  supply (GSTR-1 warns). Add buyer GSTIN + state on the bill before selling to registered buyers.
- **E-invoicing:** businesses with aggregate turnover > ₹5 cr in any FY since 2017-18 must generate an IRN + QR (IRP) for
  every B2B invoice and credit note; B2C bills are exempt (B2C dynamic QR only above ₹500 cr). Show a turnover check /
  block B2B until IRN integration exists.
- **Restaurant 5 % rate:** restaurant service (SAC 996331) is 5 % without input tax credit (18 % with ITC only for restaurants
  in "specified premises": hotels with a room tariff above ₹7,500). Owners must not claim ITC on purchases; keep 18 % only for those cases.
- **HSN digits:** 6-digit SAC defaults satisfy both the ≤₹5 cr (4-digit) and >₹5 cr (6-digit) rules; keep menu HSN mandatory.
- **Signature:** emailed / downloaded PDFs would be stronger with a digital signature (Rule 46(q)).
- **Retention:** no automatic purge yet; delivery addresses after 3 years and audit-log WhatsApp links are candidates.
- **Storefront / QR orders:** add an opt-in checkbox so online customers can give consent themselves (`consentSource: STOREFRONT`).
- **Staff erasure:** Aadhaar delete exists; a full staff-profile erasure (after statutory payroll retention) is not built.
- **Aadhaar FULL mode:** UIDAI expects full numbers in an Aadhaar Data Vault; recommend keeping the LAST4 default.

## Not verified
Printed output on real thermal printers; GSTN offline-tool upload of the JSON; mobile app receipt rendering (uses the shared formatter).
