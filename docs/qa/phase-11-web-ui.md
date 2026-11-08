# QA Phase 11 — Web UI automation

Scripts: `apps/web/scripts/qa/e2e/*.cjs` (runner `node apps/web/scripts/qa/e2e/run.cjs`; see its README). They use
the plain `playwright` library, axe-core, pngjs and pixelmatch from a scratch install pointed to by `PW_PATH`. **No
Playwright package was added to the repo** (product-owner decision). Target: a production build of the web app
(`next build` + `next start`, port 3280) on API 4180 with scratch DB `canavo_ui_dev` (seed + CANTEEN/CHANNELS/THEATRE
enabled, online page `/o/demo`). Last run of each suite: **156/156 checks pass** (journeys 39, browsers 65, network 17,
visual 4, a11y 16 incl. 6 keyboard, robust 15).

## Journeys × browsers

| Journey | Chromium | Firefox | WebKit |
|---|---|---|---|
| Super admin onboards business → owner menu item + staff → cashier bill → KDS Start/Ready → payment → owner Bills/Reports | ✅ | — | — |
| Delivery partner day (PIN clock-in at the outlet, COD run to Delivered, cash page) | ✅ | — | — |
| Inventory day (5 pages, stock adjust with validation) | ✅ | — | — |
| Waiter table tab (open tab, add items, send KOT, floor shows Occupied) | ✅ | — | — |
| Cinema seat order (guest phone) → UPI step → runner board → Delivered | ✅ | — | — |
| Cashier bill (add, Charge, Exact, Collect, receipt) | ✅ | ✅ | ✅ |
| Online ordering (cart, details validation, place order, confirmation) | ✅ | ✅ | ✅ |
| Viewports 360 / 768 / 1024 / 1440 / 1280×800: POS (+payment dialog), Bills, KDS, online page | ✅ no horizontal scroll, main control visible | — | — |
| Slow 3G (CDP, warm JS cache): POS usable + bill paid | ✅ | — | — |
| Offline → online: 2 queued bills sync exactly once (also after a reconnect flap + reload) | ✅ | — | — |
| API 502 (HTML) / 500 / aborted request → friendly message, Retry, cart kept, offline fallback | ✅ | — | — |
| Robustness: refresh / Back mid-bill, refresh with payment open, double-click Charge, identical next bill, two tabs, token expiry, session loss → re-login keeps cart, empty + validation states | ✅ | — | — |

Double-click checks (one record each): Create business, Collect payment, Charge, Send to kitchen, Pay by UPI.
Zero console errors / page errors / API 5xx / 403s across all journeys. Visual baselines (`baselines/pos.png`,
`kds.png`, `receipt.png`; Chrome/macOS 1280×800 light; ≤1 % pixels) compare clean on re-run.

## Accessibility (axe-core WCAG 2.1 AA, login, online page, POS, Bills, KDS × light + dark)

| | Before | After |
|---|---|---|
| Serious/critical rule violations (excl. brand colour) | 18 (color-contrast, label-content-name-mismatch, scrollable-region-focusable) | **0** |
| Keyboard: focus trap in dialogs / Escape returns focus to the trigger | fail / fail | pass / pass |
| Brand orange #FF6B35 contrast nodes (2.83:1 vs white) | 25+ | 73 — open, product decision |

Earlier wide scan (21 pages, before fixes): 244 contrast nodes, 89 name-mismatch, 56 button-name (menu table
toggles without names), 4 scrollable regions — pages outside the timeboxed scope were not re-scanned.

## Defects (all fixed in apps/web unless noted)

| ID | Sev | Defect | Fix |
|---|---|---|---|
| ui-6 | **Critical** | POS reused the last bill's `clientOrderId` for an identical next cart: online the server's idempotency returned the earlier (paid) bill; offline the second queued bill was dropped at sync (cash taken, no bill) | `resetBill` clears the attempt id; journeys + robust check identical carts make 2 bills |
| ui-8 | High (a11y) | Dialogs had no focus trap; loading buttons were natively disabled, so focus fell to `<body>` and Escape could not return it | Tab/Shift+Tab trapped in the top dialog; `Button loading` = `aria-disabled` + `aria-busy`, clicks/submits swallowed (double-click guard kept) |
| ui-9 | High (a11y) | Contrast: header avatar initials, KDS late header (white on red-500 3.76:1), unavailable dishes at 60 % opacity on `/o`; names: bell "(4 unread)", account button, KDS ticket button; offers scroller not focusable | primary-700 on primary-50, red-600, no opacity on text, label-in-name fixes, `tabIndex`/region |
| ui-5 | Medium | Non-JSON 5xx showed "Request failed (502)"; API 500 showed "Internal server error" | Friendly text per status + support ref (request id) |
| ui-7 | Medium (a11y) | Toasts had no role (errors not announced assertively) | error → `role=alert`, others `status` |
| ui-2 | Medium (a11y) | Stock-adjust fields' aria-label hid the visible label ("Quantity to add (pkt)"); hints/errors not linked to fields | Removed overrides; Input/Select/Textarea get `aria-describedby` + `aria-invalid` |
| ui-4 | Low | Socket opened and killed at once on mount → WebKit/Firefox console errors | Connect on next tick (`autoConnect:false`) |
| ui-3 | Low (a11y) | Online-ordering dialog name "Back Payment" (Back button inside the heading) | `Dialog leading` slot outside `<h2>` |
| ui-1 | Low | Onboarding wizard error "Outlet stateCode: …" (schema key) | Human field words ("Outlet state code: …") |
| ui-10 | Low | Table tab: "Use Add items above" but the button is below | Copy fixed |

## Not verified / not run

- Brand orange contrast (73 nodes, white on #FF6B35 and orange text on white/tints): needs a product/brand decision
  (darker default accent or dark text on primary); counted as "brand" and excluded from the gate.
- Firefox/WebKit only for the cashier bill + online ordering (timebox); other journeys Chromium only.
- axe not re-run on pages outside login/online/POS/Bills/KDS (menu table toggles without names remain).
- Slow 3G measured with a warm JS cache (cold first load of the bundle not measured); no real device / touch POS.
- Visual baselines are OS/font specific (macOS Chrome); other CI hosts need their own (`UPDATE_BASELINES=1`).
- API untouched → integration / test:api / test:db not re-run. Env note: the shared Prisma client (main checkout) was
  ahead of this branch's migrations (`Customer.marketingOptIn`); the main migrations were deployed to the scratch DB.
