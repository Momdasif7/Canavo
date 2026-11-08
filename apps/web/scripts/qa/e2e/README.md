# Web UI journeys (QA Phase 11)

Browser automation for the web app with the plain `playwright` library. **Playwright, axe-core, pngjs and
pixelmatch are not repo dependencies** (product-owner decision — do not add `@playwright/test` or any
Playwright package). Install them in a scratch folder:

```sh
mkdir -p /tmp/pw && cd /tmp/pw && npm i playwright axe-core pngjs pixelmatch@5
npx playwright install chromium firefox webkit
```

## Environment

Run against a scratch API + web, never production data (journeys create businesses, bills, staff):

```sh
# scratch DB: migrate deploy + seed, then enable the demo modules and the online page
psql … -c "update \"Business\" set modules = modules || '{CANTEEN,CHANNELS,THEATRE}' where id='biz_demo'"
psql … -c "update \"Outlet\" set \"publicSlug\"='demo', storefront='{\"onlineOrdering\":true,\"qrOrdering\":true,\"onlineNeedsConfirmation\":false}'"
# API on 4180 (CORS_ORIGINS=http://localhost:3280), web as a production build on 3280:
NEXT_DIST_DIR=.next-ui NEXT_PUBLIC_API_URL=http://localhost:4180 npx next build && NEXT_DIST_DIR=.next-ui npx next start -p 3280
```

## Run

```sh
PW_PATH=/tmp/pw/node_modules/playwright OUT_DIR=/tmp/e2e-out node apps/web/scripts/qa/e2e/run.cjs
SUITES=journeys,robust …                       # a subset
ONLY=chain,cinema … node …/journeys.cjs         # part of one suite
UPDATE_BASELINES=1 … node …/visual.cjs          # rewrite the visual baselines
```

Env: `BASE_URL` (default http://localhost:3280), `API_URL` (http://localhost:4180), `SLUG` (online page,
`demo`), `PASSWORD` (Canavo@123), `CHROME_CHANNEL` (`chrome`; "" = bundled Chromium), `HEADED=1`,
`AXE_PATH` / `PNGJS_PATH` / `PIXELMATCH_PATH` (default: next to `PW_PATH`).

| Suite | What |
|---|---|
| `journeys.cjs` | super admin onboards a business → owner adds a menu item + staff → cashier bills → kitchen KOT → payment → owner Bills/Reports; delivery partner day; inventory day; waiter table tab; cinema seat order → runner board. Double-clicks on Create / Collect / Send to kitchen / Pay by UPI must not duplicate. |
| `browsers.cjs` | Chromium / Firefox / WebKit: cashier bill + online order. Chromium viewports 360, 768, 1024, 1440, 1280×800: POS, Bills, KDS, online page, payment dialog (no horizontal scroll, main control visible). |
| `network.cjs` | slow 3G (CDP), offline → online (two queued bills sync exactly once, also after a reconnect flap + reload), API 502 / 500 / aborted requests shown as friendly messages. |
| `visual.cjs` | POS, KDS, receipt vs `baselines/*.png` (pixelmatch, ≤ 1 % of pixels). Baselines: Chrome, macOS, 1280×800, light. |
| `a11y.cjs` | keyboard billing + dialog focus trap / Escape / focus return; axe-core (WCAG 2.1 AA) on login, online page, POS, Bills, KDS in light + dark. |
| `robust.cjs` | refresh / Back mid-bill, refresh with payment open, double-click Charge, identical next bill, two tabs, token expiry (silent refresh) and session loss (re-login keeps the cart), empty + validation states. |

Every suite fails on console errors, page errors, API 5xx and 403s seen by the browser (expected 4xx such as
validation or geofence answers are not errors). Output: `OUT_DIR/<suite>.json`, `fail-*.png` for failed
steps, `viewports/`, `visual/` (current + diff), `a11y-report.json`.

The API's per-IP login limit (50 / 15 min) is avoided by sending a per-context `X-Forwarded-For` on
`/auth/*` calls — this works only because the API trusts loopback proxies (local runs only).
