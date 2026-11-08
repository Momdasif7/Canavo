# QA Phase 15 — Manual testing pack (agent/man)

Documents only; no product code changed. Index: [manual/README.md](manual/README.md). Generator:
`node docs/qa/manual/build.mjs` (writes the xlsx / csv / case index / compatibility matrix; role permissions imported
from `packages/shared/src/rbac.ts`, pages from `nav.ts`, data from the seed).

## Included
| Item | File | Size |
|---|---|---|
| Test cases (xlsx + csv + index) | manual/MANUAL_TEST_CASES.* | 575 cases (338 P1), 35 modules, 13 roles; sheets Test Cases, Summary (formulas), Daily Log, Compatibility, Bug Log |
| UAT scripts + sign-off | manual/UAT_SCRIPTS.md | 9 roles, 81 steps |
| Exploratory charters | manual/EXPLORATORY_CHARTERS.md | 8 charters |
| Real-device checklist | manual/REAL_DEVICE_CHECKLIST.md | 32 checks × 6–7 devices |
| Payment checklist | manual/PAYMENT_CHECKLIST.md | 21 scenarios |
| Hardware checklist | manual/HARDWARE_CHECKLIST.md | 29 checks |
| Usability script | manual/USABILITY_TEST.md | 5 users, 11 tasks, SUS |
| Compatibility matrix | manual/COMPATIBILITY_MATRIX.md | 11 browser/OS rows × 6 sizes |
| Install / upgrade / rollback | manual/INSTALL_UPGRADE_ROLLBACK.md | 11 scenarios (links DEPLOYMENT.md + migration runbook) |
| Localization review | manual/LOCALIZATION_REVIEW.md | 16 checks |
| Chaos tests | manual/CHAOS_TESTS.md | 20 scenarios |
| Bug report examples | manual/BUG_REPORT_EXAMPLES.md | 3 (BUG-EX-01…03, illustrative) |

## Cases per module
Access & roles 308 (11 roles × 28 pages) · POS billing 23 · Online ordering 18 · Auth 17 · Delivery address mode 13 ·
Menu & bulk upload 12 · Payments 11 · Inventory 11 · Integrations 11 · Cinema seat ordering 11 · Bills & refunds 10 ·
Offers 10 · DPDP & consent 8 · Tables 8 · Platform 8 · Kitchen 7 · Reports & GST 7 · Settings & taxes 7 · Mobile app 7 ·
Delivery (manager) 6 · Delivery partner 6 · Attendance 6 · Staff 6 · Appearance 6 · Customers & khata 5 ·
WhatsApp templates 5 · Canteen 4 · Admin, audit & export 4 · Localization 4 · QR table ordering 3 ·
Cash drawer & gift cards 3 · Offline & resilience 3 · UI & usability 3 · Reservations 2 · Notifications 2.

New features covered: per-store integrations and WhatsApp templates (INT, WA), Swiggy-style online ordering (ONL),
delivery address-only mode (DAM), cinema seat ordering (CIN), DPDP export / erasure and consent flags (DPDP),
appearance / theme (APP), kitchen status on the bill (BILL-002/003).

## Not done / notes
- Nothing executed yet: this phase writes the pack; execution needs staging, real devices, printers and a Razorpay test account.
- The access matrix assumes all modules on (the demo business); with modules off, the pages of that module must be hidden.
- Bug examples are illustrative, not findings.
