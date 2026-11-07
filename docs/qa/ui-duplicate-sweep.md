# UI duplicate-button sweep

**Scope:** every page of the signed-in app (`apps/web/app/(app)`) for every seeded role, at desktop (1440×900) and phone (390×844), plus the signed-out pages. The sweep looks for **duplicate buttons doing the same thing**: the same accessible name on two or more *visible* interactive elements on one page.

- Script: `apps/web/e2e/duplicate-buttons.spec.ts` (Playwright). Allowlist and roles: `apps/web/e2e/sweep-config.ts`. Report generator: `apps/web/e2e/sweep-report.ts`.
- Generated results (every page × role × viewport, the duplicates, allowlisted repeats and console errors): [ui-duplicate-sweep-results.md](./ui-duplicate-sweep-results.md).

## How to re-run

1. Start the stack on your own ports. The sweep only reads pages; it never clicks anything that changes data. For full coverage the business needs every module (the seed leaves out `CANTEEN` and `CHANNELS`), and the outlet needs a public slug so the Share kit renders. On a throwaway DB:
   ```sql
   UPDATE "Business" SET modules = modules || '{CANTEEN,CHANNELS}' WHERE id = 'biz_demo';
   UPDATE "Outlet" SET "publicSlug" = 'demo-canteen' WHERE "publicSlug" IS NULL;
   ```
2. `npx playwright install chromium` (once).
3. `SWEEP_BASE_URL=http://localhost:3302 SWEEP_STORE_SLUG=demo-canteen npm run test:e2e:sweep -w @canavo/web`
   - `SWEEP_ROLES=owner,cashier` limits the run to some roles (the keys are in `sweep-config.ts`; `public` means the signed-out pages). `SWEEP_WORKERS` sets parallelism (default 4).
   - Each role logs in once, so a full run uses 11 logins. The API's auth IP limiter allows 50 logins per 15 minutes.
   - The run fails if any duplicate is not covered by the allowlist. Run time is about 6 minutes with 4 workers.

## Method

- **Routes:** every `page.tsx` under `app/(app)`, plus every `href` in `components/layout/nav.ts` and `components/admin/nav.ts`. That gives 80 routes, including sub-pages such as `/tables/qr-codes`, `/customers/loyalty` and `/reports/*`. Dynamic pages (`/customers/[id]`, `/inventory/audits/[id]`, `/platform/businesses/[id]`) are resolved by following the first matching link on the parent page. Each role visits every route. A route the role can't open (the RouteGate "not available for your role" screen, the platform-console notice or the module-off state) is recorded as such and not inspected.
- **Elements:** `button`, `a[href]`, `[role=button|tab|menuitem|switch]` and `input[type=button|submit]`, counted only when **visible**. An element counts as visible when `checkVisibility()` passes (with opacity and CSS visibility checks), its box is at least 4×4 px, it sits horizontally inside the viewport (so off-canvas drawers are excluded) and it has no `aria-hidden` or `inert` ancestor. Responsive pairs where one copy is hidden at a breakpoint are therefore not counted.
- **Accessible name:** `aria-label`, then `aria-labelledby`, then inner text, then img `alt`, then `title`, then the wrapping `<label>` or `label[for]`. Elements with no name are counted separately as "unnamed".
- **Same action:** elements are grouped by name **and** action. A link's action is its destination (pathname); a button's action is "action". Same name with a different destination is not a duplicate. For example, the sidebar "Customers" (→ `/customers`) is not a duplicate of the Reports tab "Customers" (→ `/reports/customers`), and the sidebar "Delivery" link is not a duplicate of the POS "Delivery" order-type tab.
- **Console errors:** `console.error` and uncaught page errors are recorded for each page visit.

### Allowlist (legitimate repeats)

| Rule | Why it's legitimate |
|---|---|
| **Per-item**: elements in different `tr`, `li`, `[role=row\|listitem\|option\|gridcell]`, or in different items of a run of 3+ identical sibling cards | Each acts on its own row or card ("Edit" per staff row, "New code" per table QR card, "Restore" per backup, "Sign out" per device, Present/Absent/Leave per attendance row). |
| **Pagination**: Previous/Next/First/Last (page/day/week/month), page numbers, arrows | Stepping controls. |
| **Sidebar category + its first section tab**: exactly two links with the same destination, one in `nav[aria-label=Main]` and one in a `nav[aria-label="… sections"]` | The two-level navigation in `nav.ts` (`NAV_GROUPS`): the sidebar shows the category and the page shows its screens as tabs, so the first tab and the category point to the same screen. This is by design and not a repeated button. |
| `/settings`: "58 mm (2 inch)" and "80 mm (3 inch)" | Options of two different settings (Receipt paper and KOT paper). |
| `/settings`: "Save" ×2 | Outlet profile and Money controls are separate forms, and each card saves its own. |
| `/admin/settings`: "Save" and "Defaults" ×4–5 | One pair per system-settings section (notification channels, printer defaults, pre-order lead time, WhatsApp templates, IP whitelist). |

## Coverage

There are 11 roles (super admin, business owner, outlet manager, cashier, waiter, kitchen, inventory manager, delivery partner, accountant, auditor, platform support), 2 viewports and 80 routes, which gives **1,760 role × viewport × route combinations**, plus the signed-out pages (`/login`, `/forgot-password`, `/reset-password`, `/o/demo-canteen`) at both viewports. The per-role counts of pages rendered and inspected are in the [results](./ui-duplicate-sweep-results.md#coverage-pages-checked-per-role--viewport).

Not inspected:

- `/inventory/audits/[id]`: the seed has no stock audits.
- Dynamic pages whose parent the role can't open.
- `/t/[token]`: the table QR guest page needs a live QR token and belongs to the online-ordering workstream.
- Dialogs, menus and drawers that only open on click. The sweep inspects the page as it loads.

## Findings

### Share kit (Request 6a)

On **Settings → Online ordering → Share kit**, the user saw two copy buttons with the same copy icon:

- **Copy**, next to the link field, which copies the link.
- **Copy message**, next to the WhatsApp button, which copies `Order from <outlet> online: <link>`.

Both copy the same link. The "message" is that link with one sentence in front, and it is exactly the text the green **Share "Order now" on WhatsApp** button already sends. That made two controls for the same action: copy link, and share the WhatsApp message.

**Fix:** removed **Copy message** and renamed **Copy** to **Copy link**, so the one remaining copy button says what it copies. Change: `apps/web/components/storefront/OnlineOrderingSettings.tsx` around line 176. The Share kit now has Copy link, Share on WhatsApp and Print poster.

### Duplicates found and removed

| Page (roles) | Duplicate | Fix (file) |
|---|---|---|
| `/customers` (owner, manager, cashier, waiter; both viewports) | **Khata** twice: the "Khata" section tab and a "Khata" button-link in the page header, both going to `/customers/khata` | Removed the header link and kept the section tab. `app/(app)/customers/page.tsx` ~L55 |
| `/customers/khata` (same roles; both viewports) | **Customers** twice: the "Customers" section tab and a "← Customers" back link. Khata is itself a peer tab. | Removed the back link; the Customers tab is the way back. `app/(app)/customers/khata/page.tsx` ~L40 |
| `/settings` (owner, manager; both viewports) | **GST & Taxes** twice: the "GST & Taxes" settings tab and a "GST & Taxes →" button-link in the Billing & compliance block. Both have the same `settings:billing` gate. | Removed the inline link and kept the tab. The note now reads "…live under the GST & Taxes tab above". `app/(app)/settings/page.tsx` ~L187 |
| `/inventory/audits` (owner, manager, inventory; both viewports) | **Start audit** twice while there are no audits: the header button and the empty-state button | Removed the empty-state button and kept the header button, which is always there. The empty-state text points to it. `app/(app)/inventory/audits/page.tsx` ~L73 |
| `/customers/loyalty`, `/customers/[id]` (owner, manager, cashier, waiter) and `/platform/businesses/new`, `/platform/businesses/[id]` (super admin) | **Customers** / **Businesses**: a "← Customers" or "← Businesses" back link with the same name as the section tab | Kept as up-navigation from a sub-page (the pattern Request 3 asks for). Switched them to the shared `BackLink` (`components/layout/PageHeader.tsx`), which is announced as "Back to Customers" / "Back to Businesses" and has a focus ring. `customers/loyalty/page.tsx` ~L153, `customers/[id]/page.tsx` ~L243, `platform/businesses/new/page.tsx` ~L174, `platform/businesses/[id]/page.tsx` ~L59 |

The same applies to Request 3: `/tables/qr-codes` now has "← Tables" (accessible name "Back to Tables") under the Billing & orders section tabs, which include "Tables". It is kept on purpose, as the explicitly requested back button.

### Left (other workstreams), reported but not edited

These are in the delivery-partner portal, which another agent is changing. They are listed in `KNOWN_LEFT` in `sweep-config.ts` so the sweep reports them under "Left (known)" without failing.

| Page (role, viewport) | Duplicate | Suggested fix |
|---|---|---|
| `/delivery`, `/delivery/cash`, `/delivery/dashboard`, `/delivery/history` (delivery partner, **phone**) | **My deliveries / Cash handover / Dashboard / History** each appear twice: in the "My work sections" tabs at the top (`AppShell` `CategoryTabs`) and in the fixed bottom nav "Delivery partner" (`AppShell`, `md:hidden`) | Render `CategoryTabs` for the partner group only from `md` up (`hidden md:block`), so phone users keep the thumb-reachable bottom nav. |
| `/delivery` (delivery partner, both viewports, while off duty) | **Clock in** twice: the duty bar (`components/delivery/partner/duty.tsx`, `DutyBar`) and the `OffDutyBanner` on My deliveries | Keep the duty bar button. Make the banner text-only ("Clock in at the top to start your shift"), or hide the banner while the duty bar is shown. |

In the online-ordering page `/o/demo-canteen` and the WhatsApp settings, the sweep found **no duplicates**.

### Console errors

No `console.error` or uncaught page errors on any page visit in the production build (`next build` + `next start`) against the seeded data. See the results file for each run.

