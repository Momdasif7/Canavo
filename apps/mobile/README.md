# CANAVO mobile (Expo SDK 51)

The staff app: clock in/out with geofence, PIN and biometrics; POS billing that keeps working offline; kitchen KOT board; reports. Phase 2–3 adds waiter tables (running tabs, split bills), customer lookup / coupons / points with live server pricing, delivery and pre-orders, a delivery-agent mode with live location, inventory with barcode scanning and stock counts, customers & khata, and push notifications. Store steps: see [STORE_RELEASE.md](./STORE_RELEASE.md).

`apps/mobile` is a **standalone npm project**. It is not part of the root workspaces. It uses `packages/shared` through `"@canavo/shared": "file:../../packages/shared"`, and `metro.config.js` makes Metro follow that symlink.

## Setup

```bash
# 1. Build the shared package once (or whenever it changes)
npm run build -w @canavo/shared        # from the repo root

# 2. Install the app's own dependencies
cd apps/mobile
npm install
cp .env.example .env                    # then set EXPO_PUBLIC_API_URL
npm start                               # Expo Go / dev client
```

### `EXPO_PUBLIC_API_URL`

A phone cannot reach `localhost` on your computer, so pick the URL for your device:

| Device | URL |
| --- | --- |
| Physical phone (same Wi-Fi) | `http://<your LAN IP>:4000`. Find the IP with `ipconfig getifaddr en0` (macOS) or `ipconfig` (Windows). |
| Android emulator | `http://10.0.2.2:4000` |
| iOS simulator | `http://localhost:4000` |
| Shared via the single-port gateway / ngrok | `EXPO_PUBLIC_API_URL=https://<your-ngrok-domain>/api` — REST uses the `/api` base; the socket connects to the origin on the default `/socket.io` path. |

Allow port 4000 through the firewall. After you edit `.env`, restart Metro with `npx expo start -c`.

### Seed logins

- **OTP (dev):** in development the API returns the code, and the login screen shows it. Phones: `9876500002` (cashier), `9876500003` (kitchen), `9876500001` (manager), `9876500004` (delivery agent).
- **Email/password:** `cashier@canavo.local` / `Canavo@123`.
- **Staff PIN for clock-in:** `1234`.

## Bluetooth thermal printing needs a development build

Printing goes through `src/printing/`:

- `ThermalPrinter` is the interface.
- `bluetooth.ts` is the ESC/POS implementation. It uses `@vardrz/react-native-bluetooth-escpos-printer`, a maintained fork of `react-native-bluetooth-escpos-printer` with the same API. The original 0.0.5 still uses Gradle 3 and `compile`, and it breaks modern Android builds.

That module is native code, so **it is not available in Expo Go**. The app loads it lazily. When it is missing, receipts go to the **system print dialog** (`expo-print`) instead: the receipt text sits in a monospace `<pre>` at 58 or 80 mm width.

To print straight to a Bluetooth printer, build a dev client:

```bash
npx eas build --profile development --platform android
```

Then open **More → Printer settings**. Scan, connect, choose 58 or 80 mm paper, and run a test print. Bluetooth printing is Android-only. On iOS the system dialog is always used.

## Offline billing

- **Caching:** menu and outlet tax settings are cached in SQLite (`expo-sqlite`).
- **Queueing:** with no connection, Charge saves the bill locally with a `clientOrderId` (UUID) and `createdAt`. Only cash or card can be taken offline.
- **Syncing:** when NetInfo reports the device is back online, the queue is sent to `POST /orders/sync`. The counter payment is then recorded with `POST /orders/:id/payments`.
- **Status:** the banner at the top shows online/offline status and how many bills are waiting.

## Phase 2–3 features (where to find them)

| Feature | Who sees it | Where |
| --- | --- | --- |
| Tables & running tabs | `table:serve` | **Tables** tab → table → tab screen (add items with seat, void with `order:cancel`, move/merge, bill FULL / BY_SEAT / BY_ITEMS / EQUAL). Paying the last bill closes the tab on the server automatically. A reservation advance is offered as an `ADVANCE` payment on the first bill. |
| POS upgrades | `order:create` | Cart sheet: customer lookup (tier, points, khata, blocked), coupon, redeem points, live `POST /customers/preview-promotions` (falls back to local `computeBill` offline), offer chips, **Delivery** (address, "use my location" → zone/fee quote, agent) and **Pre-order** (date-time picker). Offline bills drop coupons/points; delivery and pre-orders need a connection. |
| Delivery partner portal | role DELIVERY (`delivery:own` without `delivery:manage`) | Tabs are exactly **Home / Deliveries / Cash / History / More**. **Home**: duty card with clock in/out (clock-in at the outlet; clock-out works from anywhere), **Cash in hand** (opens the Cash tab), COD to collect, active count, and a Today / Yesterday / This week / This month summary (deliveries, cash collected, already paid, avg time, distance, per-day bars). **Deliveries**: cards sorted by ETA, Call, Navigate, items, a big **Collect ₹X cash** badge (COD / unpaid) or **PAID**, live location while out, Report a problem, an "Off duty" banner (not blocking). No payment options: unpaid → **Cash collected & delivered** (confirm "Did you collect ₹X cash from …?"), paid → **Delivered**; both call `POST /delivery/:id/complete {cashCollected}` (409 → refresh), then a success screen. **Cash**: cash to hand over (`GET /delivery/mine/cash`), today collected / handed over, pending orders (oldest first), handover history; refreshes on `delivery:updated`. **History**: date chips, totals, how each order was paid. Uses only `/delivery/*` (request shapes in `src/delivery/portal.ts`). |
| Cash on Delivery | `payment:collect` | Online DELIVERY orders only. The payment screen has **Cash on Delivery (COD)** (`POST /orders/:id/cod`), and the cart's delivery details have a COD toggle (`delivery.cod: true`, button "Place COD order"). Both open the COD screen (`app/cod/[orderId].tsx`), where you can print or share the unpaid bill, undo COD ("Customer pays now instead") or start a new bill. Request specs are in `src/pos/cod.ts`. Offline delivery orders aren't offered COD. |
| Delivery board & partners | `delivery:manage` | More → Delivery board: assign / reassign agent, dispatch, COD badges, partner-reported **ISSUE** banners, and **Cash with partners** (to receive, today collected / received, pending orders, **Record cash received**). More → **Delivery partners**: cash to receive per partner, today collected / received / delivered; partner detail with Today / This week / This month, per-day duty, deliveries, cash collected / received / to receive, tap a day for its timeline, handover history with edit / delete (`/delivery/cash*`, `/delivery/partners/*`). |
| Bills & settings | `bills:view` / `settings:view` (owner, manager, cashier) | Receipt screen needs `bills:view`. More → Outlet info / Printer settings need `settings:view`. Kitchen, delivery and inventory staff see only personal items (notifications, attendance, profile, sign out). |
| Inventory | `inventory:view` (`inventory:manage` to change) | **Stock** tab (kitchen / inventory staff) or More → Inventory: low-stock list + live `inventory:low` alerts, barcode scan (expo-camera), adjust / wastage, stock count (audit), receive draft purchases. |
| Kitchen | `kot:view` | Table label for running tabs, PRE-ORDER badge, voided items struck through (`kot:void`). |
| Notifications | everyone | Bell on Home, badge on More. Push registers after login when `EAS_PROJECT_ID` is set (see STORE_RELEASE.md). The token is removed on logout. |
| Reports | `report:view` | 7-day sales trend; multi-outlet overview for managers/admins. |
| Customers | `customer:view` | More → Customers: search, profile, khata settle (`payment:collect`), WhatsApp reminder. |

Native modules added: `expo-camera`, `expo-notifications`, `expo-device`, `@react-native-community/datetimepicker`. All of them work in Expo Go on SDK 51, except that **remote push in Expo Go needs a projectId**. A dev build is recommended.

## Scripts

- `npm run typecheck`
- `npm run export:android` (production bundle; checks that Metro can resolve everything)
