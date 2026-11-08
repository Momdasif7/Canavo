# Product requests — rqb: online ordering page redesign + delivery with or without map

Branch `agent/rqb` · migration `20261107130000_delivery_address_mode`

Product owner's words: *"Design the Online order page very well, exactly like a Swiggy / Zomato view"* and
*"Add an option of delivery with or without map in the hotel side"*.

## 1. Online ordering page redesign (`/o/<slug>`, also the QR table page `/t/<token>`)

Mobile-first, works at 390 px, and on desktop shows two panes (menu on the left, a sticky cart on the right).
No new dependencies: phosphor icons, Tailwind and the existing `Dialog` (a bottom sheet on phones) are used.

| Area | What changed |
|---|---|
| Hero | Brand gradient band, logo, outlet name, address, **Open now / Closed** pill and the hours, a **Pickup / Delivery** toggle, chips for ETA, delivery fee, minimum order and "pickup only / delivery only", and an **offers strip** listing the outlet's live offers (from the offers engine; these are applied automatically to the bill). |
| Brand colour | Customer pages now use the **business brand accent** (`Business.brand.accent`), which `outletBrand().accent` sends. `<BrandStyle>` sets the `--primary-*` CSS vars, and they override the signed-in user's cached accent. |
| Menu | Sticky search with a clear button, a **Veg only** switch and horizontally scrolling **category tabs that follow the scroll** (IntersectionObserver; the active tab scrolls into view). A "Recommended" section (bestsellers) comes first. |
| Item cards | Photo on the right with the **ADD button over its bottom edge**. ADD turns into a **− qty +** stepper. The card shows the veg / non-veg / egg mark, name, price ("from" when there are variants), a 2-line description with **more / less**, a **★ Bestseller** badge, and "Customisable". Unavailable items are greyed out with the reason and a **SOLD OUT** chip. When ordering is closed the card says "Ordering closed". |
| Bestsellers | New `bestsellerIds()` returns the outlet's top items over the last 30 days of paid orders, counting only items with at least 5 sold. Both public pages return it as `bestsellers`. |
| Customisation | Bottom sheet with the photo, a required size choice (radio), optional add-ons (checkboxes), and a stepper plus **Add item · ₹** button. |
| Cart bar | Floating pill on phones: "**N ITEMS ADDED · ₹total — View cart ›**". It is hidden on desktop, where the right-hand cart column replaces it. |
| Checkout | A 3-step sheet with a step indicator and a back arrow. **Cart**: lines with steppers and cooking notes, a note for the restaurant, and **bill details** (item total, packaging, delivery fee, GST estimate or "included", an offers line, to pay). **Details**: contact, the **phone OTP** step when the outlet requires it, the **delivery address** (map pin, area picker, or the new address-only form) and the time slot. **Payment**: big option cards (counter / COD / UPI), a summary with "Change", the bill, and **Place order**. Each step shows the first thing blocking it, such as a minimum order shortfall or an area outside delivery. |
| Order placed | Animated check, a headline that follows the status, and a **vertical live tracker**. Pickup steps: placed → accepted → preparing → ready. Delivery steps: placed → accepted → preparing → out for delivery → delivered (the last two come from the delivery status). The UPI QR, receipt and bill breakdown remain, plus Back to menu and Call buttons. The existing polling still runs. |
| States | Skeleton loader shaped like the page, empty search ("No dishes match · Clear filters"), empty cart, closed store (red pill plus the warning "we take orders 15:00–17:00"), and sold-out items. |
| QR table page | Uses the same hero, menu, cart bar and desktop cart column. Call waiter / Ask for bill now sit in the hero, and order status shows as pills. |

All APIs and behaviour are unchanged: quote, OTP, orders, UPI, polling, cart in `localStorage`, saved
customer details (the PIN code is now saved too). `apps/api/test/api/storefront.test.ts` passes.

## 2. Delivery with or without map (outlet setting)

**Setting** (Delivery → **Zones & settings** → "Delivery address"):
- **Map pin (zones & distance fees)**: the default and exactly today's behaviour.
- **Address only (no map)**: the customer or cashier types the address lines, landmark and **PIN code**. There is no map and no location prompt. The outlet sets a **flat delivery fee**, an optional **minimum order**, a **delivery time** and an optional **allowed-areas list** (6-digit PIN codes and/or area names). Orders outside the list are refused with a clear message, for example *"Sorry, we don't deliver to PIN code 600040 — we deliver to 600017, 600020, T Nagar, Adyar"*.

**Who:** the owner and the manager can change it (`delivery:manage` + `settings:outlet`, the same rule as zones).
The cashier can read it, because the POS needs it. Everyone else gets 403, and so does a business without the DELIVERY module.

**Where it is stored (decision):** new `Outlet` columns, next to the other outlet delivery settings
(`deliveryEnabled`, `maxDeliveriesPerPartner`): `deliveryAddressMode` (enum `MAP|ADDRESS`, default `MAP`),
`deliveryFlatFee`, `deliveryMinOrder`, `deliveryAreas text[]`, `deliveryEtaMinutes`, plus `Delivery.pincode`.
I did not put it in the `storefront` JSON because the setting also governs POS delivery orders, not only the
online page. The migration adds CHECK constraints: fee 0–₹10,000, minimum order 0–₹1,00,000, ETA 5–300 minutes.

**Area matching** is in `@canavo/shared` as `deliveryAreaAllowed` and runs on both client and server. A PIN-code
entry must equal the PIN code exactly. An area-name entry matches the area the customer picked, or whole words in
the typed address ("T. Nagar" matches "T Nagar"; "Anna Nagar" does not; "Kadyar" does not match "Adyar").

**API**
- `GET/PUT /delivery/settings`, body `deliverySettingsUpdateSchema`. Changes are audited as `delivery.settings` and emit `outlet:updated`.
- `GET /public/o/:slug` adds `deliveryMode`, `deliveryFlat {fee,minOrder,etaMinutes,areas}`, `offers` and `bestsellers`. In address mode, `zones` is `[]` and `location` is `null`.
- `GET /public/o/:slug/delivery-quote`: address mode accepts `?pincode&area&address` and returns `{mode:"ADDRESS", deliverable, fee, minOrder, etaMinutes, message}`. Map mode is unchanged and still needs `lat`/`lng`; the response now also carries `mode`, `fee`, `etaMinutes` and `minOrder`.
- `GET /delivery/quote` (POS): address mode returns `addressMode:"ADDRESS"`, the flat fee and the PIN check (`?pincode`).
- `POST /public/o/:slug/orders` and `POST /orders` in address mode: the PIN code is required and checked against the allowed areas, the delivery minimum is enforced, the bill gets a "Delivery fee" line with the flat fee, and coordinates and zone are ignored (never stored). The chosen area is appended to the address. Aggregator and offline bills stay lenient, as with zones.

**Staff screens**
- Web delivery board: the card shows the typed address with "· PIN …" and an **Open in Google Maps** link (a search for address + landmark + PIN) instead of "Show on map".
- Web partner "My deliveries": PIN code, **Open in Google Maps**, and Navigate (directions to the typed address).
- Mobile partner app (`DeliveryCard`): already hid the mini-map without coordinates. It now shows the PIN code, and Navigate searches address + landmark + PIN.
- POS (web): in address mode, the map picker and zone picker are replaced by a **PIN code** field. A chip shows "PIN 600017 · we deliver · Fee ₹30 · ~35 min · Min order", or the refusal. The local bill shows the flat fee.
- POS (mobile app, `CartExtras`): the same change, with a PIN code field instead of "Pick on map / My location / zones".
- Settings → Online ordering: the Delivery toggle description names the current mode and where to change it.

## How to use
1. As owner or manager, open Delivery → Zones & settings → choose **Address only (no map)**. Set the fee, minimum, time and areas (type `600017, T Nagar` and press Enter), then Save.
2. The online page shows "₹30 delivery · 35 min · Min order ₹150". At checkout the customer sees the address form with a live "We deliver here" or refusal message.
3. Switch back to **Map pin** at any time. Zones are kept and come back unchanged.

## Tests
- New `apps/api/test/api/delivery-address-mode.test.ts` (12 tests):
  - role matrix: GET is owner, manager and cashier; PUT is owner and manager; module off, the wrong outlet and super admin are refused
  - validation and deduplication
  - per-outlet isolation and audit
  - map mode unchanged: public page, quote, order with the zone fee, POS
  - address mode: public page, quote (allowed / refused / bad PIN), online order with the flat fee in the bill, typed address + PIN stored and no pin stored, refusals (outside the areas, no PIN, below the minimum; nothing is created), POS order (PIN required, area checked, flat fee, coordinates dropped), no-areas / no-fee case, switching back to map
- New unit test `packages/shared/src/delivery-address.test.ts` (5 tests) covering area matching, the refusal text, the schema and the maps link.
- `storefront.test.ts` passes. One ordering fix: in map mode the "missing pin" 400 still comes before the "delivery off" 409.
- OpenAPI docs regenerated (`npm run docs:api`).
- Full results are listed in the final summary: `tsc` (api, web), lint, unit tests, the full integration suite, test:api and test:db.

## Screenshots — `docs/build/screens/online-ordering/`
Phone 390×844 (`phone-*`) and desktop 1366×900 (`desktop-*`):
- `00-skeleton`, `01-hero-menu`, `02-delivery-toggle-chips`, `03-sticky-tabs-scroll`, `04-veg-only`, `05-search-empty`
- `06-add-stepper-cartbar`, `07-customise-sheet`, `08-cart-sheet` / `08-two-pane-cart`, `09-cart-bill-details`
- `10-details-otp`, `11-otp-code`, `12-delivery-map-pin`, `13-payment`, `14-order-placed-tracker`, `15-tracker-live-refresh`
- `16-closed-store`, `17-sold-out-item`
- Address-only mode: `address-{phone,desktop}-01-hero-flat-fee`, `02-address-fields`, `03-area-refused`, `04-area-accepted`, `05-payment-flat-fee`, `06-order-placed`
- Staff: `staff-desktop-delivery-settings-{map,address}`, `staff-*-delivery-board-*`, `staff-desktop-delivery-board-address-card`, `staff-phone-partner-delivery-address`, `staff-*-pos-delivery-{map,address}`
- QR table page: `table-qr-{phone,desktop}-menu`, `table-qr-phone-cart`

The demo food photos are generated SVG placeholders in the scratch database only; nothing in the repo.

## Not verified / notes for merge
- **Migration:** `20261107130000_delivery_address_mode` (enum, five `Outlet` columns, `Delivery.pincode`, three CHECKs). Run `prisma migrate deploy` and `prisma generate`, and rebuild `@canavo/shared` (it has a new `delivery-address.ts`). No new env vars.
- **Mobile app** (`apps/mobile`): it is type-checked against the main checkout's old `@canavo/shared`, so `pincode` on the order input shows as a type error until the shared build is merged. Separately, the mobile `tsconfig` `ignoreDeprecations: "6.0"` already fails with the installed TS 5.x; that was there before this change. Not run on a device.
- **Offline POS bills** in address mode: the local estimate has no quote, so the flat fee shows up only when the server prices the bill. Zones already behave this way.
- **Leaflet map tiles** load from OpenStreetMap; the screenshot run had network access.
- The live tracker's "out for delivery" step was not captured in a screenshot, because the demo delivery had no partner on duty. The logic is covered by the status mapping.
- The bill in the cart is an estimate (GST computed from item rates when prices exclude tax; offers show "at checkout"). The order screen shows the server's final bill.
