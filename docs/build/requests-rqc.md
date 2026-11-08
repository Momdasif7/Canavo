# Product requests — rqc: Table QR back button, Share kit copy button, duplicate-button sweep

Branch `agent/rqc`. Web-only change: no API, schema or migration changes, nothing to do at merge besides the usual merge.

Product owner's words: *"Add back button in the Table QR codes page"* and *"In Share kit there are 2 same buttons
'Copy message' — remove one, and also check for duplicate buttons in all the pages and remove one and keep only one."*

## 1. Table QR codes: back button

- `PageHeader` has a new optional `back={{ href, label }}` prop. It draws the same "← Parent" link that Khata, Loyalty
  and customer detail already wrote by hand: small, muted, above the title, 44 px tap height, `print:hidden`.
  Printing was already limited to `.print-sheet`, and `print:hidden` also stops the link taking up space.
- `/tables/qr-codes` now uses `back={{ href: "/tables", label: "Tables" }}`.
- Back links carry `data-nav="back"` (PageHeader plus the six hand-written ones), so the sweep knows they are deliberate.
- I did not move the existing hand-written back links onto the new prop, to keep the diff small. Moving them later is
  a mechanical change.

Screens: `screens/duplicates/qr-codes-before-{desktop,phone}.png` → `qr-codes-after-{desktop,phone}.png`.

## 2. Share kit: one copy button

On screen, the Share kit had **"Copy"** next to the link and **"Copy message"** under it. Both used the same outline
style and the same copy icon. The "message" was only `Order from <outlet> online: <link>`, which is the link with a
prefix, and the green WhatsApp button next to it already sends that exact message. A browser check found one
"Copy message" in the DOM, so the "two same buttons" were these two look-alike copy buttons.

- Kept: **Copy link** (renamed from "Copy") next to the URL field. It is the one people need for an Instagram bio or
  Google profile.
- Removed: **Copy message**. The WhatsApp button covers sending the message.
- File: `components/storefront/OnlineOrderingSettings.tsx`, 2 small hunks in the Share kit card only. The settings
  form above it is untouched, so a delivery-mode setting can still go in there.

Screens: `share-kit-before-*.png` → `share-kit-after-*.png`.

## 3. Duplicate-button sweep

### How it was run
Scratch stack: API on :4130 against `canavo_rqc_dev` (migrate deploy + seed, with the demo business's modules
extended by CANTEEN and CHANNELS so every page can open), and `next dev` on :3230. The script
`apps/web/scripts/qa/duplicate-buttons.cjs` logs in as **owner, manager, cashier, kitchen, waiter, delivery,
inventory, accountant, auditor, admin (super admin) and support**, all of them from the seed. For each role it:

- crawls every section in that role's sidebar, plus every tab and sub-page link inside those sections and the
  static sub-pages (`/tables/qr-codes`, `/customers/loyalty`, all reports, account pages and so on);
- opens one detail page for customers, stock audits and platform businesses;
- opens common dialogs: the bill drawer, the POS cart and payment flow, add customer and add staff;
- does all of this at **1366×900 and 390×844**.

On each page it collects the visible buttons, links, tabs and menu items (an open modal limits the scan to the modal).
It flags four things:

| Check | Meaning |
|---|---|
| `same-name` | The same accessible name twice in one region (main, nav, dialog…), when the repeat is not explained by repeated items (table rows, list items, card grids with the same structure). Pagination and steppers are ignored. |
| `same-href` | Two links to the same place in one region with different labels. |
| `cross-region` | The same destination in two regions at once, e.g. section tabs at the top **and** phone bottom tabs. The desktop sidebar and `data-nav="back"` links are left out. |
| `look-alike` | A bare verb next to the same verb with an object in one card ("Copy" + "Copy message"). |

Each flagged control is outlined in the screenshot. The run writes `report.json`, `report.md` and `shots/`. I reviewed
every flag against the screenshot and the code. I also searched the source for the same button label appearing twice
in one file (`>Label</Button|Link>`), because empty states only show on empty data and the seed has data on most pages.

Re-run:
```
PW_PATH=/path/to/node_modules/playwright BASE_URL=http://localhost:3230 OUT_DIR=/tmp/dup \
  node apps/web/scripts/qa/duplicate-buttons.cjs        # ROLES=owner,cashier  VIEWPORTS=phone  ROUTES=/pos,/bills
```
Playwright is not a repo dependency. `data-dup-ok` on an element marks a reviewed, intentional repeat.

### Results — page × duplicate × fix

| Page | Duplicate found | Viewports / roles | Fix (kept → removed) |
|---|---|---|---|
| Settings → Online ordering → Share kit | "Copy" and "Copy message", identical look-alike buttons | all | Kept **Copy link**; removed **Copy message** (the WhatsApp button sends that message) |
| Delivery partner → My deliveries | **Clock in** in the duty bar and **Clock in** in the yellow off-duty banner, both visible | delivery, desktop + phone | Kept the duty bar button (it shows on every partner page); the banner keeps its text, now "Clock in above to start your shift…" |
| Delivery partner portal (all 4 pages), phone | Section tabs at the top (**My deliveries / Cash handover / Dashboard / History**) **and** the same four as bottom tabs | delivery, phone | Kept the bottom tabs (thumb reach, built for partners); the top tab row is hidden below `md` for the group shown as bottom tabs (`AppShell` → `CategoryTabs bottomTabsGroup`). Desktop unchanged |
| Customers | Header **Khata** button and the **Khata** section tab, both visible | owner, manager, cashier, waiter | Kept the tab (always there, in the same place as every other section); removed the header button |
| Inventory → Stock audits (empty) | Header **Start audit** and empty-state **Start audit** | owner, manager, inventory | Kept the header button; empty state now says "Use Start audit above…" |
| Inventory → Stock (empty) | Header **Add item** and empty-state **Add item** | code review (empty data) | Same: header kept, empty state points to it |
| Inventory → Vendors (empty) | **Add vendor** ×2 | code review | Same |
| Inventory → Purchases (empty) | **New purchase** ×2 | code review | Same |
| Customers (empty) | **Add customer** ×2 | code review | Same |
| Tables → open tab with nothing ordered | Header **Add items** and **Add items** in the empty "Nothing ordered yet" box | code review | Header kept; box says "Use Add items above to start the order." |

### Flags reviewed and left as they are (legitimate)

| Page | Flag | Why it stays |
|---|---|---|
| Kitchen display | Print KOT / Start / "Mark KOT n as …" ×N | One set per ticket card (per-row actions). The improved sweep no longer flags them |
| Settings → Outlet & devices | **Save** ×2 | Two separate forms: Outlet profile and Money controls. Each Save belongs to its own card |
| Admin → System settings | **Save** and **Defaults** ×4–5 | One pair per settings card, each saving its own section. Also outside this agent's scope (another agent owns admin system settings) |
| Settings → Outlet: "GST & Taxes →" | Same place as the GST & Taxes tab | A pointer from inside the card that explains where GSTIN moved |
| Reports → GST: "GSTR-1 →" | Same place as the GSTR-1 report tab | A pointer from the summary to the filing export |
| Delivery → My deliveries / Dashboard stat tiles | Tiles link to Dashboard / Cash handover | Clickable stat tiles that drill down, not buttons |
| Khata, Loyalty, customer detail, audit detail, platform business pages, Table QR codes | "← Parent" back link and the parent's tab both visible | Back links are what the product owner asked for (Table QR codes request). Tagged `data-nav="back"` |
| Platform admins | **Add admin** in the header and in the dialog footer | Opening the dialog and submitting it are different steps; the dialog is modal |
| Bills | **Cancel bill** in the drawer and in its confirm dialog | Same reason |
| Platform console | "All businesses →" in the Newest businesses card and the Businesses tab | A "see all" link at the foot of a preview list |

### Numbers
- **Before** (original code, first version of the checks): 502 page scans (11 roles × 2 viewports, deduplicated by
  page) and 23 flagged pages. Later checks (look-alike, cross-region) plus code review found the rest: **10 true
  duplicates in total, all fixed** (table above).
- **After** (final script on the fixed code): 502 page scans and **17 flagged pages, all of them the legitimate
  repeats listed above.** That is Settings Save ×2 and the GST & Taxes pointer, the Reports → GST "GSTR-1" pointer,
  admin system settings cards, delivery stat tiles, and the platform "All businesses →" link. Expect these 17 when
  re-running. To bring a re-run to zero, put `data-dup-ok` on those elements.

Screens (`docs/build/screens/duplicates/`): `*-before-*` / `*-after-*` for qr-codes, share-kit, delivery, audits;
`customers-khata-before-phone.png` / `customers-khata-after-*`; examples of legitimate repeats:
`settings-two-saves-legit-desktop.png`, `admin-settings-per-card-legit-desktop.png`, `kitchen-per-ticket-legit-desktop.png`.

## Files
- `apps/web/components/layout/PageHeader.tsx`: `back` prop
- `apps/web/app/(app)/tables/qr-codes/page.tsx`: back to Tables
- `apps/web/components/storefront/OnlineOrderingSettings.tsx`: Copy link only
- `apps/web/components/delivery/partner/duty.tsx`: banner without the second Clock in
- `apps/web/components/layout/AppShell.tsx`: top tabs hidden on phones when the same group is the bottom tab bar
- `apps/web/app/(app)/customers/page.tsx`: header Khata button removed; empty-state Add customer removed
- `apps/web/app/(app)/inventory/{page,audits/page,vendors/page,purchases/page}.tsx`: empty-state CTAs removed
- `apps/web/components/tables/TabPanel.tsx`: empty-state Add items removed
- 6 back links: `data-nav="back"` attribute only
- `apps/web/scripts/qa/duplicate-buttons.cjs`: the sweep

## Tests
- `npx tsc --noEmit -p apps/web` and `-p apps/api`: clean. `npm run lint`: 0 errors (3 old warnings in
  MenuTargetPicker and Scanner, files I did not touch). `npm test`: shared 51/51, api 160/160.
- Integration suite on `canavo_it_rqc`: 206 passed, 1 skipped. test:api: 717/717.
- test:db: **4 of 10 files fail, and the cause is outside this branch** (this branch changes no API, DB or test code):
  - `reconciliation.test.ts` tries to corrupt a gift card's balance above its loaded value inside a rolled-back
    transaction. The Phase 7 CHECK constraint `GiftCard_balance_le_initial_check` now rejects that write, so the test
    needs a different way to corrupt the data. This already happens at base commit 9184870.
  - `soft-delete-audit`, `tenant-integrity` and `transactions` fail with "column `deliveryAddressMode` does not exist".
    The worktree's symlinked Prisma client comes from the main checkout, which another agent regenerated with a new
    Outlet column. The worktree's migrations don't have that column yet. Re-run after that branch merges.

## Not verified
- Empty-state removals for Stock, Vendors, Purchases, Customers and the empty table tab were checked by code review
  only: the seed has data on those pages. Only Stock audits had an empty-state duplicate in the sweep.
- The online-ordering customer pages (`/o`, `/t`) were left out on purpose (another agent is redesigning them), and
  so were Settings → WhatsApp / Integrations and admin system settings, apart from reading them.
- The mobile app (`apps/mobile`) was not swept.
