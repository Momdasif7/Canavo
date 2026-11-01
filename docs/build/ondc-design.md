# ONDC: CANAVO as a seller app for F&B (Phase 6.2 design)

Status: **design only, no code**. Purpose: decide how CANAVO hotels and canteens can sell food on ONDC (Open Network for Digital Commerce) without a separate integration per buyer app (Paytm, PhonePe Pincode, Magicpin, Ola …).

## 1. Role and shape

ONDC is a network running the **Beckn protocol**. Buyer apps (BAP) find and order. Seller apps (BPP) publish catalogs and fulfil orders. The **gateway** fans out searches, and the **registry** holds every participant's keys and endpoints.

CANAVO would join as an **inventory seller-side platform (BPP, "MSN" model)**: one CANAVO subscriber hosts many sellers (our hotels' outlets). Each outlet is a *provider* in our catalog, and each kitchen/outlet is a *location*.

```
Buyer app (BAP) ──search──▶ ONDC gateway ──search──▶ CANAVO BPP (/ondc/search)
       ◀─────────────────────── on_search (catalog of every opted-in outlet) ──┘
BAP ── select / init / confirm / status / cancel / update / track ──▶ CANAVO BPP
BAP ◀── on_select / on_init / on_confirm / on_status / … (asynchronous callbacks) ── CANAVO
```

Every Beckn call is **asynchronous**. We reply `ACK` (or `NACK`) at once, then send the `on_*` callback to the BAP's `bap_uri` within the timeout set by the network (`context.ttl`, usually PT30S).

## 2. Flows mapped to CANAVO

| Beckn API | What CANAVO does | Existing piece reused |
| --- | --- | --- |
| `search` (city / intent / item / category, sometimes radius) | Build the catalog of every outlet that opted in, is open and serves the area. Full catalog on incremental refresh, filtered on targeted searches. | `buildChannelMenu(outletId)`: availability, AUTO_STOCK_OUT, hidden items, outlet price overrides |
| `on_search` | `bpp/providers[]` (outlet), `locations`, `categories`, `items` (with `@ondc/org/…` tags: veg/non-veg, time to prepare, returnable=false, cancellable), customization groups (sizes and add-ons as ONDC "customizations") | Menu, `ItemVariant`, `ItemAddon` |
| `select` | Quote: our prices + GST + packaging + delivery charge, with per-item availability. Out of stock → item quantity 0 plus an error code. | `computeBill` (dry run, no invoice); availability checks from `createOrder` |
| `init` | Buyer and delivery address, billing details. Return payment terms (who collects: BAP or BPP), settlement details and the cancellation terms. | Outlet GSTIN / bank settings (new settlement fields) |
| `confirm` | Create the order: **createChannelOrder(outletId, "ONDC", …)**, idempotent on the ONDC order id. KOTs fire, and the payment is recorded (mode `ONLINE` when the BAP collected). | Phase 6 foundation + Phase 6.1 ChannelOrder log |
| `on_confirm` | Order `Accepted` (or `Created` and accepted later), with a fulfillment id and state | Outbox |
| `status` / `on_status` | Map our states: Accepted → `Packed` (KOT ready) → `Order-picked-up` / `Out-for-delivery` → `Order-delivered`, or `Cancelled`. Send `on_status` unsolicited on every change. | `queueChannelStatus` + KOT ready hook (same triggers as the hub) |
| `cancel` / `on_cancel` | Buyer cancels with an ONDC reason code. We void the bill if the kitchen hasn't started, or apply the cancellation terms (a charge after preparation). Seller-side cancels use seller reason codes (e.g. 002 item out of stock). | `cancelOrderInTx` (the system cancel used for hub cancellations) |
| `update` / `on_update` | Part-cancel (an item became unavailable after confirm), and return/refund flows (for F&B mostly "not delivered" or "wrong item" → refund) | Credit notes (Phase 3.1) |
| `track` / `on_track` | Tracking URL or GPS from the logistics provider (or from our own delivery partner) | Delivery module locations (self-delivery) |
| `support` / `on_support` | Outlet phone / email for the order | Outlet profile |
| `rating` | Store ratings for the outlet / order (optional) | CRM feedback |

**Logistics.** For F&B, the seller usually picks a logistics service provider (LSP) through ONDC logistics (CANAVO acting as a logistics BAP: `search` → `on_search` quotes from LSPs → `confirm`), or delivers itself. Phase A: self-delivery only (our Delivery module, which then *does* create a Delivery record, unlike aggregator orders). Phase C: ONDC logistics.

## 3. Catalog mapping

| ONDC | CANAVO |
| --- | --- |
| Provider (`id`, `descriptor`, `time.schedule`, `fulfillments`) | Outlet (name, logo, opening hours, open/closed toggle from Settings → Channels) |
| Location (`gps`, `address`, `circle` serviceability radius) | Outlet latitude/longitude, delivery radius (Delivery module zones) |
| Category | MenuCategory (with ONDC F&B domain category codes, e.g. "Continental", "North Indian", via a mapping table) |
| Item (`id`, `descriptor`, `price`, `quantity.available`, `category_id`, `tags`) | MenuItem (external id = item id, or `ChannelItemMap`); `quantity.available.count` = 99 when available, 0 when out of stock |
| Customization groups / items (`parent_item_id`, `tags: type=customization`) | Sizes (one-of, required) and add-ons (any-of, optional) |
| Veg / non-veg / egg tag | `FoodType` |
| Item timing (`time.range`) | `availableFrom` / `availableTo` |
| Statutory info (FSSAI licence no.) | New outlet field `fssaiLicence` (mandatory for F&B on ONDC) |

Catalog freshness: send a full `on_search` on the gateway's incremental-refresh pull, and push changes (stock-outs, price changes, store closed) through incremental `on_search`. Use the same trigger points as the hub's menu sync, plus the `menu.availabilityNotify` outbox task that AUTO_STOCK_OUT already fires.

## 4. Registry, subscriber onboarding, signing

1. **Register** on the ONDC portal as a seller-side network participant: legal entity, GST, a domain (e.g. `ondc.canavo.in`), and a subscriber id = that domain. Environments: staging → pre-prod → prod, each with its own registry and keys.
2. **Keys**: generate an **ed25519 signing key pair** (signing Beckn requests) and an **X25519 encryption key pair** (registry challenge). The public keys and a `unique_key_id` go into the registry entry. Private keys live in the secrets store (KMS/Vault), never in the database, and are rotated with overlapping validity (`valid_from` / `valid_until`).
3. **Site verification**: host `ondc-site-verification.html` with a signed request id at the subscriber domain.
4. **on_subscribe**: the registry sends a challenge encrypted to our X25519 key, and our `/on_subscribe` endpoint returns it decrypted.
5. **Signing every request**: build the BLAKE-512 digest of the raw body, then a signing string `(created) (expires) digest`. Sign it with ed25519 and send it in the `Authorization` header: `Signature keyId="{subscriber_id}|{unique_key_id}|ed25519",algorithm="ed25519",created=…,expires=…,headers="(created) (expires) digest",signature="…"`. The gateway adds its own `X-Gateway-Authorization`.
6. **Verifying incoming requests**: parse the header, look up the sender's public key through the registry `/lookup` (cache it with a TTL, and refresh on failure), check the digest, signature and the created/expires window. Otherwise reply `NACK` with a 401. This is the same idea as `verifyHubSignature`, with asymmetric keys and a key lookup.

## 5. Settlement and reconciliation

- **Who collects**: usually the BAP (buyer app) collects the payment and settles with the seller app through the network's settlement rails (RSF, the reconciliation and settlement framework). The BAP finder fee and our seller-platform commission are declared in `init` / `on_init` (`@ondc/org/buyer_app_finder_fee_amount`, `@ondc/org/settlement_details`).
- **In CANAVO**: the bill is paid with mode `ONLINE`. A new `Settlement` import (the Phase 3.8 settlement reconciliation already matches card payments by reference) matches the RSF settlement report to ONDC orders by order id. Finder fee and withholding (TCS under GST §52, TDS under IT §194-O) are recorded per order. The sales report "Channels" section then shows actuals instead of the estimated commission.
- **GST**: an e-commerce operator collects TCS. Our invoice stays the seller's own tax invoice (same as today). Restaurant services through an ECO fall under §9(5) (the ECO pays the 5% GST). **Open question: whether the BAP or the seller platform is the ECO for §9(5) in each case. Needs a CA's opinion before go-live.**

## 6. IGM (Issue & Grievance Management)

ONDC requires every participant to handle issues through the IGM APIs (`issue`, `on_issue`, `issue_status`, `on_issue_status`) with defined SLAs (response within 1 hour, resolution within 24 hours for F&B), and to name a grievance officer.

- New table `ChannelIssue {outletId, channel, orderId, category (ITEM / FULFILLMENT / PAYMENT), subCategory code, description, images, status OPEN|PROCESSING|RESOLVED|CLOSED, resolution (refund / replacement / no-action), timeline}`.
- Staff UI: an "Issues" tab under Settings → Channels (later its own screen), with SLA timers, and an escalation notification to the manager (Phase 4 notifications).
- Resolution "refund" creates a credit note (Phase 3.1) and reports the refund amount in `on_issue`.
- Cascade: if logistics (LSP) caused the issue, we raise our own IGM `issue` to the LSP as the logistics BAP.

## 7. What the ChannelAdapter gives us

| Reused as-is | Needs extending |
| --- | --- |
| `createChannelOrder` (pricing, GST, invoice, KOTs, idempotency on channelOrderId), `ChannelOrder` log (payload, totals, mismatch), `ONLINE` payment mode, channel badges, bills filter, sales-by-channel report | ONDC is **request/response with callbacks**, not "hub pushes order, we push status". An `OndcAdapter` keeps `updateStatus` (→ unsolicited `on_status`), `setStoreOpen` / `pushMenu` (→ incremental `on_search`) and `parseWebhook` (→ verify the Beckn signature and normalize `confirm` / `cancel`) |
| Outbox task for outbound calls (retries, dead-letter, visible errors) | New synchronous-ish steps with no counterpart in the hub flow: `search` / `select` / `init` (quotes without creating a bill), so add a `quote(outlet, items, address)` to the service, not the adapter |
| KOT ready → status, staff cancel → status, channel cancel → system cancel | ONDC cancellation reason codes and cancellation terms (charges after preparation) |
| Store open/closed, menu availability builder | Serviceability (radius / pincode), FSSAI, ONDC category codes, time-to-prepare tags |

The `ChannelAdapter` interface stays the contract for "push to channel". ONDC adds a **`BecknGateway` layer** in front: routes `/ondc/{action}`, signature verification, ACK/NACK, callback dispatch through the outbox. It calls the same channel service.

## 8. Phases

| Phase | Scope | Exit criteria |
| --- | --- | --- |
| A — staging, self-delivery | Registry onboarding (staging), signing and lookup, `search` / `select` / `init` / `confirm` / `status` / `cancel` for one pilot outlet, self-delivery with our Delivery module, BAP-collected payment, manual settlement entry | Pass the ONDC pre-prod log verification (the network's flow-by-flow log checks) for F&B |
| B — production pilot | Prod keys, IGM APIs and screen, RSF settlement import, `update` (part-cancel / refund), incremental catalog push on stock-outs, monitoring (ACK rate, callback latency) | 2 to 3 outlets live; issue SLA met for 4 weeks |
| C — scale | ONDC logistics (LSP search / confirm / track), ratings, multi-outlet providers, offers on ONDC (`offers` in the catalog) mapped to Offers & Coupons | Self-serve opt-in per outlet from Settings → Channels |

## 9. Open questions

1. Which network model: a pure seller-side platform (we are the BPP for many sellers), or do we also need to be a "seller node" for each hotel legally? It affects the contract with ONDC and with each hotel.
2. GST §9(5) / TCS responsibility in the BAP-collects model. Needs a CA's opinion.
3. Do we accept BPP-collected payments (a CANAVO payment gateway account for each hotel) or only BAP-collected? BAP-collected is simpler: no money flows through us.
4. Pricing on ONDC: same as the menu (our default for aggregators), or a separate "online price list"? A price list would also help Zomato / Swiggy, where hotels often charge more.
5. Packaging charges: do we model them per item (needed by ONDC quotes) instead of per order?
6. Logistics: is self-delivery enough for the hotels we serve (small radius), or is LSP integration required to be attractive?
7. Operations: who answers IGM within 1 hour at night? Hotel staff via notifications, or a CANAVO support desk?
8. Key custody: a cloud KMS per environment. Who can rotate keys, and how do we handle a compromised key (registry update plus overlap window)?
