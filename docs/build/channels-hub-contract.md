# Channel hub contract (Phase 6.1)

CANAVO takes Zomato / Swiggy / other app orders through an **order hub** (decision D3: a partner hub first, such as UrbanPiper; direct integrations later). This page is the contract our generic `HubAdapter` (`apps/api/src/services/channels/hub.ts`) speaks. To plug in a real hub, either configure the hub to match it, or write a thin adapter that implements `ChannelAdapter` (`services/channels/adapter.ts`) and maps the hub's own API onto the same normalized events.

A local fake hub (`services/channels/fake-hub.ts`) implements this contract for tests and local development. We never use real credentials in code or tests.

## Per-outlet configuration (Settings → Channels)

| Field | Meaning |
| --- | --- |
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
- `food_ready`: when the kitchen marks the last KOT of the order ready.
- `dispatched`: staff tap "Handed to rider" (Settings → Channels → Recent channel orders), or call `POST /channels/orders/:orderId/status`.
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
- **Order type**: the bill is a **TAKEAWAY**, because the aggregator's rider collects it. No CANAVO delivery record is created, and our delivery partners are never auto-assigned. `fulfilment: self` orders are also takeaway bills, with the address in the bill notes; routing them to our delivery board is a later step.
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

`status` is one of `assigned`, `at_store`, `picked_up`, `delivered`. CANAVO records it and shows it on Settings → Channels.

## Mapping a real hub later

- **Different paths or field names**: write a new `ChannelAdapter` (for example `UrbanPiperAdapter`). The service, the outbox task, the UI and the tests stay the same.
- **Different signature scheme** (timestamped HMAC, a token header): handled inside the adapter's `parseWebhook`.
- **Manual accept**: if the hub needs one, add a per-connection "auto-accept" switch and an Accept button. Today, orders are accepted on receipt.
