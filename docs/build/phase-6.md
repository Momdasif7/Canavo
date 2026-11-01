# Phase 6: Sales channels

| | |
|---|---|
| Branch | `feat/market-leader`: foundation (`d1c2343`, `70469f4`) plus two agents in parallel (`agent/channels`, `agent/storefront`), merged and verified |
| Date | 2026-11-01 |
| Decision applied | **D3: partner hub first** (one integration relays Zomato / Swiggy). Built against a local fake hub; there are no real credentials. |
| Tests | Unit **192** (shared 43, API 149) · Integration **179** · Smoke **17** · Browser: online page, QR page (phone size), Settings → Online ordering / Channels, Tables → QR codes |

## Summary

There's a new **Online orders & channels** module, switched on per business. **Hotels without it see no change.**

Every order now records its **channel**: POS, QR, ONLINE, ZOMATO, SWIGGY, ONDC or OTHER. Orders that no staff member placed are created through the normal billing path, so server prices, GST, invoice numbers, KOTs and live updates all apply. They're recorded under a per-business "Online orders" system account and are idempotent per channel order id.

## What was built

| # | Item | What changed |
|---|---|---|
| 6.1 | Aggregators + ChannelAdapter | `ChannelAdapter` interface, a generic **hub adapter** (HMAC-signed webhooks) and a fake hub for tests and local dev. **Incoming orders:** `POST /channels/hub/:connectionId/webhook` checks the signature and bills at our prices; prepaid orders are paid with the new mode `ONLINE`. The channel's total and payload are kept for reconciliation, and a gap over ₹1 is flagged. Unknown or unavailable items and a closed store are refused back to the hub. Channel cancellations cancel our bill, and repeated webhooks never create a second bill. **Status back to the hub, via the outbox (retried):** accepted, food ready (last KOT ready), handed to rider, cancelled; failed pushes are shown with "Try again". **Settings → Channels:** connection (masked secrets, test), store open/closed, "Sync menu now" (out-of-stock marked), item mapping, commission % per app, recent channel orders. Channel badge on bills and kitchen; bills filter by channel; Channels section with estimated commission in the sales report. Hub contract: `docs/build/channels-hub-contract.md`. |
| 6.2 | ONDC | Design only: `docs/build/ondc-design.md` covers Beckn flows, catalog mapping, registry and signing, settlement, IGM, reuse of the adapter, phases and open questions. |
| 6.3 | QR table ordering | Unguessable QR token per table, rotatable (the old code stops working); printable QR sheet. **Public `/t/<token>`:** branding, menu (out-of-stock greyed), cart, notes; orders go onto the table's running tab with KOTs. Call waiter / Ask for bill notify staff, and the guest can follow order status. **"QR orders need staff confirmation"** (default ON): orders wait for Accept/Reject on POS and Tables. Rate limits, quantity caps, accepting hours. |
| 6.4 | Online page, WhatsApp link, digital menu | **Public `/o/<slug>`:** takeaway, or delivery with zones when the outlet has delivery. ASAP or pickup time. Pay at counter, cash on delivery, or UPI prepaid via the existing Razorpay QR. Status page with the receipt link. View-only digital menu when ordering is off. **Settings → Online ordering:** toggles, hours, minimum order, web address, share kit (link, printable poster, WhatsApp "Order now" link). |

## Migrations

| Migration | Change |
|---|---|
| `20261101223420_order_channel` | `Order.channel` (default POS), `Order.channelOrderId` |
| `20261101223619_idx_order_channel_order_id` | Unique (outlet, channel, channelOrderId), built **CONCURRENTLY** in its own migration |
| `20261101224637_channels_hub` | `ChannelConnection`, `ChannelItemMap`, `ChannelOrder` (forced RLS); `PaymentMode` += `ONLINE` |
| `20261101224653_storefront_qr_ordering` | `DiningTable.qrToken`, `Outlet.publicSlug`, `Outlet.storefront`, `ChannelRequest` (forced RLS) |

The migrations in order produce exactly the merged schema (verified: empty diff).

**Rollback:** switch the module off for a business; this is instant. Then drop the four tables and columns. Enum values stay (harmless unused).

## Integration notes

- **Cancel logic:** both agents moved bill cancellation into a shared function. I kept one, `services/order-cancel.ts` `cancelOrderInTx`, used by staff voids, channel cancellations and rejected online orders.
- **Settings:** the two settings pages and both routers are kept; the schema models were joined correctly after the merge.

## Decisions (please confirm)

1. **Aggregator orders are takeaway bills.** The aggregator's rider delivers, so no delivery record is created and none of our partners are assigned. Routing "we deliver" hub orders to our delivery board is left for later.
2. **Channel orders are accepted automatically** on arrival. There's no manual accept switch for aggregators.
3. **Totals:** we bill at our menu prices. The channel's total is kept only to check for differences.
4. **"Paid online"** can't be chosen for counter bills.
5. **QR orders join the table's running tab.** The final tab bill shows channel POS; the QR origin is kept on the request record.
6. **Online orders that need confirmation** become an open bill straight away with KOTs held. Rejecting one cancels the bill, and a UPI payment already made must be refunded by hand for now.
7. **Confirmation defaults on** for both QR and online orders. Customer phone numbers aren't verified (no OTP yet).

## Not done yet

- A real hub adapter (e.g. UrbanPiper) and direct Zomato/Swiggy APIs. They need vendor onboarding and credentials.
- OTP for online orders.
- Automatic UPI refunds when an online order is rejected.
- A map pin for delivery addresses (customers choose a zone).
- Mobile screens.
- API documentation (OpenAPI) for the new routes.

## Could not verify

Real hub, aggregator and ONDC sandboxes, which need vendor onboarding (as planned in Phase 0).

## Follow-up: packing and handover for aggregator orders (`agent/aggflow`)

The owner asked for this: "Swiggy / Zomato / any delivery partner's order is directly billed and packed for delivery."

- **Online orders board.** It's under Billing & orders → Online orders, for people with `channel:manage` or `order:create` when CHANNELS is on. Columns are New, Preparing, Packed and Handed over. It updates live through `channel:board`. Each card has Packed, Handed to rider (with the rider's name), a packing slip print, and rider details (name, phone, pickup code, ETA, at the store). The API (`/channels/board…`) is documented in `channels-hub-contract.md`. The mobile app uses the same API.
- **Packed** sends `food_ready` once, shared with the KOT-ready hook. **Handed to rider** sends `dispatched`. When the rider's `picked_up` update arrives, the order is marked handed over without pushing anything back.
- **Auto-print.** The setting is on Settings → Channels and on the board. A counter browser with the board open prints the bill, KOTs and packing slip of each new order through `window.print`. Each device can opt out.
- **"We deliver" hub orders** become DELIVERY bills on our Delivery board, with auto-assignment, when the business has DELIVERY. Otherwise they stay a takeaway with the address in the notes. This replaces decision 1's "later" note.
- **UrbanPiper adapter** (provider `URBANPIPER`, picked on Settings → Channels). It was written without their docs, so it must be checked at onboarding. See "UrbanPiper mapping — verify at onboarding".
- **OpenAPI** entries for all Phase 6 routes are in `src/openapi-channels.ts`.

Migrations: `20261102090000_order_handover` adds `OrderHandover` (forced RLS) and `ChannelOrder.foodReadyQueuedAt`. `20261102090100_idx_order_outlet_channel_created` adds an index on Order (outlet, channel, createdAt), built CONCURRENTLY.

Decisions to confirm:
1. **PREPARING** means the kitchen tapped Preparing or Ready on a KOT. A KOT that was only printed (RECEIVED) still shows as NEW.
2. The board carries over orders from the **last 7 days** that weren't handed over.
3. "We deliver" orders need a **valid phone and an address**, or they fall back to takeaway. Zone rules and the zone fee don't apply to them.
4. For UrbanPiper, `channelOrderId` is UrbanPiper's own order id. The Zomato / Swiggy id is shown on the board and slip.
