# Channel hub contract (Phase 6.1)

CANAVO takes Zomato / Swiggy / other app orders through an **order hub** (decision D3: a partner hub first, such as UrbanPiper; direct integrations later). This page is the contract our generic `HubAdapter` (`apps/api/src/services/channels/hub.ts`) speaks. To plug in a real hub, either configure the hub to match it, or write a thin adapter that implements `ChannelAdapter` (`services/channels/adapter.ts`) and maps the hub's own API onto the same normalized events.

A local fake hub (`services/channels/fake-hub.ts`) implements this contract for tests and local development. We never use real credentials in code or tests.

## Per-outlet configuration (Settings → Channels)

| Field | Meaning |
| --- | --- |
| Provider | `HUB` (this contract) or `URBANPIPER` (see "UrbanPiper mapping" below). One connection per outlet. |
| Hub address (`baseUrl`) | Root of the hub's API, e.g. `https://api.hub.example` |
| Store id (`externalStoreId`) | This outlet's id at the hub |
| API key | Sent on every call from CANAVO to the hub (stored encrypted, AES-256-GCM) |
| Webhook secret | Shared secret the hub signs webhooks with (stored encrypted) |
| Commission % per source | Estimate only, for the sales report's "Channels" section |
| Webhook address | Shown on the page: `POST {CANAVO API}/channels/hub/{connectionId}/webhook` |

## CANAVO → hub (REST/JSON)

Every request carries `x-api-key: <API key>` and `content-type: application/json`. Any 2xx counts as success. For any other status, CANAVO shows `message` (or `error`) from the JSON body. Calls time out after 10 seconds.

| Purpose | Call | Body |
| --- | --- | --- |
| Test connection | `GET /v1/stores/{storeId}/ping` | none |
| Publish menu | `PUT /v1/stores/{storeId}/menu` | `{ items: MenuItem[] }` (the full menu, replacing the old one) |
| Store open / closed | `PUT /v1/stores/{storeId}/status` | `{ open: boolean }` |
| Order status | `POST /v1/orders/{channelOrderId}/status` | `{ storeId, channel, status, reason? }` |
| Item stock on / off | `PUT /v1/stores/{storeId}/items/availability` | `{ externalIds: string[], available: boolean }` (adapter method `setItemsAvailable`; not called automatically yet) |

`MenuItem` (money in paise):

```json
{
  "externalId": "ckx…",        // our menu item id, or the custom id from the item mapping
  "name": "Paneer Tikka", "description": "", "category": "Starters",
  "price": 24000, "foodType": "VEG",
  "available": true,            // false: manually out of stock, or auto stock-out (AUTO_STOCK_OUT)
  "variants": [{ "externalId": "<variant id>", "name": "Half", "price": 14000, "available": true }],
  "addons":   [{ "externalId": "<addon id>", "name": "Extra cheese", "price": 3000 }]
}
```

Hidden items are left out of the menu. Prices include outlet price overrides.

Order `status` values (lowercase): `accepted`, `food_ready`, `dispatched` (handed to the rider), `delivered`, `cancelled` (with `reason`). `channel` is the source in lowercase (`zomato`, `swiggy`, `ondc`, `other`).

Status updates go through the transactional outbox. They are sent at least once and retried with backoff. After 8 failed tries an update is dead-lettered: it shows on Settings → Channels with a "Try again" button. The hub must treat a repeated status as harmless.

When CANAVO sends each status:

- `accepted`: as soon as the order is billed (KOTs fired). Orders are accepted automatically.
- `food_ready`: when staff tap **Packed** on the Online orders board, or the kitchen marks the last KOT of the order ready, whichever comes first. It is sent **once** (`ChannelOrder.foodReadyQueuedAt` guards both paths).
- `dispatched`: staff tap **Handed to rider** on the Online orders board (`POST /channels/board/:orderId/handover`, reason `Handed to <rider name>`), or call `POST /channels/orders/:orderId/status`. Handing over an order that was never packed sends `food_ready` first.
- `cancelled`: staff cancel the bill in CANAVO.

## Hub → CANAVO (webhooks)

`POST /channels/hub/{connectionId}/webhook`, with the JSON body signed as:

```
x-hub-signature: sha256=<hex HMAC-SHA256(raw request body, webhook secret)>
```

CANAVO checks the signature with a timing-safe comparison on the exact raw bytes. The hub should retry until it gets a 2xx. Every event can be repeated safely.

### `order.new`

```json
{
  "event": "order.new",
  "order": {
    "id": "Z-123456", "channel": "zomato",
    "placedAt": "2026-11-01T12:30:00Z",
    "customer": { "name": "Asha", "phone": "+91 98400 12345" },
    "items": [
      { "externalId": "<menu id or mapped id>", "name": "Paneer Tikka", "quantity": 2, "unitPrice": 24000,
        "variantExternalId": "<variant id or name>", "addonExternalIds": ["<addon id or name>"], "notes": "less spicy" }
    ],
    "totals": { "total": 52500, "subtotal": 48000, "tax": 2400, "discount": 0 },
    "charges": { "packaging": 2000, "delivery": 0 },
    "payment": { "prepaid": true, "mode": "online" },
    "fulfilment": "channel",                       // channel (their rider) | self (we deliver) | pickup
    "delivery": { "address": "…", "landmark": "…", "latitude": 13.0, "longitude": 80.2 },
    "notes": "Ring the bell"
  }
}
```

| Response | When |
| --- | --- |
| `200 { ok: true, orderId, invoiceNumber, duplicate: false, totalMismatch? }` | Billed |
| `200 { ok: true, duplicate: true, orderId }` | Already billed (a retry) |
| `401 { error: "BAD_SIGNATURE" }` | Signature missing or wrong |
| `400 { error: "BAD_PAYLOAD", message }` | Body is unreadable |
| `404 { error: "UNKNOWN_CONNECTION" }` | Wrong connection id in the URL |
| `403 { error: "CHANNELS_OFF" }` | The business doesn't have the Channels module |
| `409 { error: "CHANNEL_OFF" \| "STORE_CLOSED" }` | Connection switched off / store closed |
| `422 { error: "UNKNOWN_ITEM", message, unknown: [...] }` | An item, size or add-on id is unknown |
| `422 { error: "REJECTED", message }` | Our billing refused it (out of stock, outside serving hours, …) |

The hub should reject the order on the app when it gets a `4xx` (except `401`, which means its own configuration is wrong). Refused orders are logged on Settings → Channels with the reason. A later retry of a refused order is tried again, in case the menu has been fixed since.

How a new order is billed:

- **Prices**: CANAVO bills its own menu prices and GST, with a normal invoice number and KOTs. The app's `totals.total` is stored next to our total. If they differ by more than ₹1, the order is flagged "Differs" for reconciliation. Packaging, delivery charges and app-funded discounts are kept in the stored payload; they are not added to our bill.
- **Order type**: the bill is a **TAKEAWAY**, because the aggregator's rider collects it. No CANAVO delivery record is created, and our delivery partners are never auto-assigned.
- **We deliver** (`fulfilment: self`): if the business has the DELIVERY module and the order has an address (5+ characters) and a valid Indian mobile, the bill is a **DELIVERY** order with a Delivery record (source `AGGREGATOR`, address, landmark, lat/lng). It shows on our Delivery board and is auto-assigned like any delivery. Zone rules don't refuse it (the app already accepted the address) and no zone delivery fee is added. Not prepaid → Cash on Delivery. Otherwise (no DELIVERY module, no address or phone) it stays a takeaway with the address in the notes.
- **Payment**: if `payment.prepaid` is true, the bill gets a successful payment with mode `ONLINE` ("Paid online") for our total, and is marked paid. Otherwise it stays unpaid for staff to settle.
- **Customer**: the name, and the phone if it is a valid Indian mobile (apps often mask numbers).
- **Item ids**: matched through the item mapping first, then as our own menu item id. An item published under a custom id can only be ordered by that id. Sizes and add-ons match our id or their name (case-insensitive).
- **Who placed it**: the per-business "Online orders" system account, so reports and the audit log keep these orders apart from cashiers.

### `order.cancelled`

```json
{ "event": "order.cancelled", "order": { "id": "Z-123456", "channel": "zomato" }, "reason": "Customer cancelled" }
```

CANAVO voids the bill as a system cancel, with the reason `Cancelled on Zomato: Customer cancelled`. Stock is restored and loyalty is reversed. Nothing is pushed back to the hub. A bill that already has refunds is not voided: it is flagged for staff instead. Unknown orders return `200 { ignored }`.

### `rider.status`

```json
{ "event": "rider.status", "order": { "id": "Z-123456", "channel": "zomato" }, "status": "at_store", "rider": { "name": "Ravi", "phone": "…" } }
```

```json
{ "rider": { "name": "Ravi", "phone": "…", "pickupCode": "4821", "eta": "8 min" } }
```

`status` is one of `assigned`, `at_store`, `picked_up`, `delivered`. `rider.pickupCode` (the OTP the rider shows) and `rider.eta` (ISO time or text) are optional. CANAVO merges rider details across updates (a later update without a name keeps the earlier name), shows them on the Online orders board and the packing slip, and emits `channel:board`. `picked_up` / `delivered` mark the order handed over without pushing `dispatched` back.

## Online orders board (packing and handover)

Aggregator and own online-page orders arrive billed. Staff then pack them and hand them over on **Billing & orders → Online orders** (web) or the mobile app.

| Route (module CHANNELS; `order:create`, `kot:view` or `channel:manage`) | Result |
| --- | --- |
| `GET /channels/board` | `{ orders: ChannelBoardOrder[] }`: today's orders (outlet timezone) from ZOMATO, SWIGGY, ONDC, OTHER and ONLINE, newest first, plus orders from the last 7 days that were not handed over or cancelled |
| `POST /channels/board/:orderId/packed` | the updated order. `409` if cancelled or already handed over. Packing twice is harmless. |
| `POST /channels/board/:orderId/handover` `{ riderName? }` | the updated order. `409` if cancelled or already handed over. |
| `GET /channels/board/:orderId/slip` | packing slip: a board order plus `outletName`, `printedAt`, `amountDue`. The customer's first name only. |
| `GET /channels/board/:orderId/print?paper=58\|80` | `{ text }`: bill, KOTs and slip as one plain-text print job (auto-print) |
| `GET/PUT /channels/board/settings` | `{ autoPrint }` (only `channel:manage` can change it) |

The `ChannelBoardOrder` type is in `@canavo/shared`. Stage is worked out in this order: `CANCELLED` (bill voided), then `HANDED_OVER` (handover recorded, or our partner picked it up), `PACKED`, `PREPARING` (the kitchen marked a KOT Preparing or Ready), `NEW`. Without a kitchen display, orders go from NEW straight to Packed. For orders we deliver, `weDeliver` is true, `rider` is our assigned partner, and handover means our partner picked it up. Every change (new order, stage change, rider update, cancellation) emits the socket event `channel:board` `{ orderId, stage }` to the outlet room.

**Auto-print**: this is the outlet setting "Print bill and KOT automatically when a channel order arrives". A web browser with the board open prints each new order (`channel:board` with stage NEW) through `window.print`. Each device can switch off "This device prints". Browsers show a print dialog every time. For hands-free printing, run the counter browser in kiosk-printing mode (Chrome `--kiosk-printing`) with the thermal printer as the default printer.

## UrbanPiper mapping — verify at onboarding

`UrbanPiperAdapter` (`apps/api/src/services/channels/urbanpiper.ts`, provider `URBANPIPER`) was written from UrbanPiper's widely known public API shapes, **without their docs, a sandbox or credentials**. Every path and field is in that one file. The uncertain ones are marked `TODO(verify-at-onboarding)`. Tests run it against the local fake server only (`urbanpiper.test.ts`, and the integration test "UrbanPiper provider").

| Our concept | UrbanPiper (assumed) |
| --- | --- |
| Auth on our calls | `Authorization: apikey <username>:<api key>`. The settings "API key" field holds `username:api-key`. |
| Webhook auth | UrbanPiper webhooks aren't HMAC-signed in the public docs. We ask them to send the webhook secret in a custom header, `x-canavo-webhook-secret`, and compare it in constant time. |
| Test connection | `GET /external/api/v1/stores/?location_ref_id={storeId}` |
| Menu push (`pushMenu`) | `POST /external/api/v1/inventory/locations/{storeId}/` with `{ flush_items: false, categories[{ref_id,name,active}], items[{ref_id,title,description,price (₹),food_type "1"/"2"/"3",category_ref_ids,available,current_stock -1/0,sold_at_store}], option_groups[...], options[...] }`. Sizes become a "Size" option group with option ref `V-<variant id>`, priced as the difference from the item price. Add-ons become an "Add-ons" group with ref `A-<addon id>`. |
| Store open / closed | `POST /hub/api/v1/location/` `{ location_ref_id, platforms: ["zomato","swiggy"], action: "enable" \| "disable" }` |
| Item stock toggle | `POST /hub/api/v1/items/` `{ location_ref_id, platforms, item_ref_ids, action }` |
| Status push | `PUT /external/api/v1/orders/{UrbanPiper order id}/status/` `{ new_status, message }`, with ACCEPTED→`Acknowledged`, FOOD_READY→`Food Ready`, DISPATCHED→`Dispatched`, DELIVERED→`Completed`, CANCELLED→`Cancelled` |
| Order relay webhook (`order_placed`) | Body with `order.details` → NEW_ORDER. `channelOrderId` = UrbanPiper `details.id` (used for status pushes). `displayId` = `ext_platforms[0].id` (the Zomato / Swiggy id, shown on the board and slip). Source = `ext_platforms[0].name` (else `details.channel`). `delivery_type: self` → SELF. `order_type: pickup` → PICKUP. Money in rupees → paise. `payment[].option` cash/cod → not prepaid. Customer address `line_1, line_2, sub_locality, city, pin`, plus `latitude`/`longitude`. |
| Order status webhook | `{ order_id, new_state, message }`: a state matching `cancel` → ORDER_CANCELLED (looked up by UrbanPiper id). Other states echo our pushes and are answered `200 { ignored }`. |
| Rider status webhook | `{ order_id, delivery_info: { current_state, delivery_person_details: { name, phone }, otp?, eta? } }`. `assigned` → ASSIGNED, `at-store`/`reached-store` → AT_STORE, `picked-up`/`out-for-delivery`/`dispatched` → PICKED_UP, `delivered`/`completed` → DELIVERED. Other states are ignored. Where the pickup OTP and ETA come from is unverified. |

At onboarding: replace each `TODO(verify-at-onboarding)` with the documented value, run `urbanpiper.test.ts` against recorded real payloads, then switch the outlet's provider to UrbanPiper on Settings → Channels.

## Mapping a real hub later

- **Different paths or field names**: write a new `ChannelAdapter` (as `UrbanPiperAdapter` does) and choose it by `ChannelConnection.provider` in `adapterFor`. The service, the outbox task, the UI and the tests stay the same. Events an adapter understands but doesn't act on return `{ type: "IGNORED" }` and are answered with 200.
- **Different signature scheme** (timestamped HMAC, a token header): handled inside the adapter's `parseWebhook`.
- **Manual accept**: if the hub needs one, add a per-connection "auto-accept" switch and an Accept button. Today, orders are accepted on receipt.
