# CANAVO manual testing pack (QA Phase 15)

Everything a tester who is not a developer needs to test CANAVO by hand: web app, Expo mobile app, customer pages,
payments and hardware. Use it on **staging** with the demo data.

**Demo logins** (password `Canavo@123`, staff PIN `1234`): owner@ · manager@ · cashier@ · kitchen@ · inventory@ ·
delivery@ · waiter@ · accountant@ · auditor@canavo.local; Super Admin admin@canavo.local; platform support
support@canavo.local. Business "Demo Hotel", outlet "CANAVO Canteen" (Bengaluru, GSTIN 29ABCDE1234F1ZW, prices include
5 % GST). Seed: `apps/api/prisma/seed*.ts`.

| # | Document | What it is |
|---|---|---|
| 1 | [MANUAL_TEST_CASES.xlsx](MANUAL_TEST_CASES.xlsx) · [.csv](MANUAL_TEST_CASES.csv) · [index](MANUAL_TEST_CASES.md) | 575 cases, 35 modules, every role (incl. a role × page access matrix generated from `rbac.ts`). Sheets: **Test Cases** (Status drop-down), **Summary** (planned / executed / passed / failed / blocked per module and role, formulas), **Daily Log** (per tester per day), **Compatibility**, **Bug Log** |
| 2 | [UAT_SCRIPTS.md](UAT_SCRIPTS.md) | "Day in the life" for Owner, Manager, Cashier, Kitchen, Inventory, Delivery partner, Super Admin, Waiter, Cinema runner, with sign-off tables |
| 3 | [EXPLORATORY_CHARTERS.md](EXPLORATORY_CHARTERS.md) | 8 session-based charters (60–90 min) + session sheet |
| 4 | [REAL_DEVICE_CHECKLIST.md](REAL_DEVICE_CHECKLIST.md) | Android low/mid/high, Android 10–14, iOS 17/18, tablet; GPS, geofence, push, BT printers, camera, network, battery, orientation |
| 5 | [PAYMENT_CHECKLIST.md](PAYMENT_CHECKLIST.md) | Razorpay test mode, real UPI app, per-store keys, split, refund, failed / pending, webhook delay |
| 6 | [HARDWARE_CHECKLIST.md](HARDWARE_CHECKLIST.md) | Thermal printer faults, cash drawer, barcode scanner, KDS wall display |
| 7 | [USABILITY_TEST.md](USABILITY_TEST.md) | 5 users, 11 timed tasks, error rate, SUS, observation notes |
| 8 | [COMPATIBILITY_MATRIX.md](COMPATIBILITY_MATRIX.md) | Browsers × OS × screen sizes (generated) |
| 9 | [INSTALL_UPGRADE_ROLLBACK.md](INSTALL_UPGRADE_ROLLBACK.md) | Fresh deploy, upgrade with live data, rollback, restore, DNS/SSL, env misconfig — links to DEPLOYMENT.md and the migration runbook |
| 10 | [LOCALIZATION_REVIEW.md](LOCALIZATION_REVIEW.md) | Long names, Indic scripts, special characters, lakh/crore, receipt wrapping |
| 11 | [CHAOS_TESTS.md](CHAOS_TESTS.md) | Network pulled mid-payment, power off mid-bill, same user on two devices, wrong clock … |
| 12 | [BUG_REPORT_EXAMPLES.md](BUG_REPORT_EXAMPLES.md) | 3 worked bug reports (template format); tracker = Summary + Daily Log sheets |

## How to run a test cycle
1. Copy `MANUAL_TEST_CASES.xlsx` per cycle (e.g. `cycle-1-<date>.xlsx`); don't commit filled copies over the template.
2. Testers filter **Test Cases** by Module / Role, fill Actual result, Status, Bug ID, Tester, Date, Device/Browser.
3. Each tester adds one **Daily Log** row per day. The **Summary** sheet updates itself.
4. Every Fail gets a bug in [BUGS.csv](../BUGS.csv) using the [template](../templates/BUG_REPORT_TEMPLATE.md).
5. Order: P1 cases → UAT scripts → device / payment / hardware checklists → charters → usability.
6. Exit: 100 % of P1 executed, no open P0/P1 bugs, ≥ 95 % pass, all UAT tables signed.

## Regenerating
`node docs/qa/manual/build.mjs` (Node 22.6+; uses `exceljs` from the root `node_modules` and imports
`packages/shared/src/rbac.ts`). It rewrites the xlsx, csv, case index and compatibility matrix. Edit cases in
`build.mjs`, not in the generated files. If a page is added to `apps/web/components/layout/nav.ts`, add it to `PAGES`.

Related: [RTM](../RTM.md) · [Test strategy](../TEST_STRATEGY.md) · [Phase 11 web UI](../phase-11-web-ui.md) (not-run list) ·
[Phase 12 mobile](../phase-12-mobile.md) (device list) · [Phase 14 compliance](../phase-14-compliance.md) ·
feature write-ups [rqa integrations](../../build/requests-rqa.md), [rqb online ordering + address mode](../../build/requests-rqb.md),
[theatre web](../../build/theatre-web.md).
