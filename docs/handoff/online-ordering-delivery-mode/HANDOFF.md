# HANDOFF — `wip/online-ordering-delivery-mode` (Requests 4 + 5)

> **Status: WORK IN PROGRESS (≈ 85–90 %).** The features are built and committed; the remaining work is verification and polish. Don't merge into `feat/market-leader` until the "Still to do" list is done.
> Branched from `feat/market-leader` @ `cba9527`. Handed over 2026-11-07.

## The requests

4. **Online ordering page `/o/<store>` redesigned in Swiggy/Zomato style.** Store banner (info line, open/closed with next opening, delivery time and fee), veg-only toggle, search, sticky category tabs with scroll-spy, item cards (photo, veg/non-veg/egg mark, ADD that becomes a − 1 + stepper; items with sizes/add-ons open a customisation sheet), a floating cart bar ("2 items | ₹340 · View cart"), and a cart & checkout sheet. Live tracking (`/o/<slug>/order/<token>`) is kept and restyled. Mobile-first (360 px), good on desktop, using the store's brand colour. No fake rating: real data only.
5. **Delivery with or without a map (store setting).**
   - **MAP** = today's behaviour (pin, zones, distance fees, partner tracking).
   - **ADDRESS** = the customer types an address + landmark (+ PIN). The store sets a **flat fee** (+ optional min order and ETA) and an optional list of **allowed areas / PIN codes**. No map anywhere: storefront, POS, delivery board, partner screens. Delivery staff get an **"Open in Google Maps"** link built from the typed address.

## Decisions already made

- The setting is **per outlet**, stored in the existing `Setting` table (key in `apps/api/src/services/delivery-location.ts`). **No database migration.** It defaults to **MAP**, so existing stores behave as before.
- Only **owner / manager** can change it; everyone who handles deliveries can read it.
- In ADDRESS mode, coordinates and zones sent by a client are **ignored** (never stored); orders outside the allowed list get a clear **400**.
- Aggregator orders aren't refused and get no fee from us.
- Partner "back at outlet" GPS detection is unchanged; it doesn't depend on the customer address mode.

## Done (3 commits; typecheck ✅; unit tests ✅ 61 shared + 160 api)

| Commit | What |
|---|---|
| `a466eac` | Delivery location mode setting (MAP / ADDRESS): API, server-side enforcement for POS and online orders, quotes, tests (`apps/api/test/api/delivery-mode.test.ts`), shared logic + 10 unit tests (`packages/shared/src/delivery-mode.ts`) |
| `45bdeb3` | Delivery-area settings tab (`components/delivery/DeliveryAreaTab.tsx`); POS delivery cart and delivery screens (`DeliveryBoard`, `MyDeliveries`) in ADDRESS mode with the Google Maps link |
| `2574da4` | `/o/<slug>` redesign: `components/storefront/online/` (`StoreBanner`, `OnlineMenu`, `BottomSheet`, `Checkout`), tracking page restyle, `lib/storefront.ts` |
| WIP commit (handover) | Small fixes found in the final visual check: category tab resets correctly when the menu filter changes; banner overlap on phones |

API tests written in `delivery-mode.test.ts`: defaults to MAP; read/write roles; per outlet; POS MAP pin → zone fee, no pin/no zone refused, far pin refused; quote and public page show zones in MAP; online order with pin gets zone fee; POS ADDRESS allowed PIN → flat fee, ETA, no coordinates kept; area chosen or written in the address allowed; outside list → 400, min order enforced, bad PIN → 400; aggregator orders; staff quote in ADDRESS mode; public page has no map + flat fee info; online order ADDRESS rules; auto-assignment still works; board/partner data carry the address + Google Maps link and COD works; switching back to MAP restores zones and pins.

## Still to do

1. **Run the API tests green on this branch** (they need a fresh test DB, see "How to run"): `test/api/delivery-mode.test.ts`, and the existing delivery / orders / storefront suites under `test/api` and `test/integration/storefront.test.ts`. Fix anything red.
2. **Visual check** at 360 px and desktop, as a customer on `/o/<slug>` and as cashier/manager/delivery on POS and the delivery board, in **both** modes: ADDRESS mode must show no map anywhere; MAP mode must be unchanged. Check the brand colour, closed store, out-of-stock items, sizes/add-ons sheet, min order, OTP and payment modes.
3. `npm run lint` and `npm run build -w @canavo/web` (the web build wasn't run after the last commit).
4. Optional: a small Playwright storefront test (add → stepper → cart bar → checkout opens; veg toggle filters; ADDRESS mode shows no map). Playwright is set up on `wip/ui-back-links-duplicates`.

## How to run

```bash
npm ci && npm run build -w @canavo/shared
npm run typecheck && npm test
# API tests recreate their DB each run — use your own DB name (run in apps/api):
IT_DATABASE_URL="postgresql://canavo:canavo@localhost:5433/canavo_it_dm?schema=public" \
IT_APP_DATABASE_URL="postgresql://canavo_app_it:canavo_app_it@localhost:5433/canavo_it_dm?schema=public" \
IT_INCLUDE="test/api/delivery-mode.test.ts" npx vitest run -c vitest.integration.config.ts
```

## Merge notes

- Also touched by `wip/store-integrations`: `routes/storefront-public.ts`, `services/storefront.ts`, `openapi-extra.ts`, `docs/api/*`. Also touched by `wip/ui-back-links-duplicates`: `components/storefront/OnlineOrderingSettings.tsx` (Share kit). Expect small conflicts there. Regenerate `docs/api/*` after merging (`npm run docs:api -w @canavo/api`) instead of hand-merging them.
