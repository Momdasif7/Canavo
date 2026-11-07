import crypto from "node:crypto";
import { hubErrorMessage, hubFetch } from "../../lib/safe-url";
import { z } from "zod";
import type { ChannelPushStatus, OrderChannel } from "@canavo/shared";
import { WebhookError, type ChannelAdapter, type ChannelMenuItem, type ChannelOrderRef, type InboundEvent, type InboundNewOrder, type InboundRiderStatus } from "./adapter";
import { sourceChannelOf } from "./hub";

/**
 * UrbanPiper-style hub adapter (provider "URBANPIPER").
 *
 * Written from UrbanPiper's widely known public API shapes WITHOUT their docs or a sandbox:
 * every path, header and field name lives in this one file and the uncertain ones are marked
 * TODO(verify-at-onboarding). The mapping is documented in docs/build/channels-hub-contract.md
 * ("UrbanPiper mapping — verify at onboarding"). Check each marker against the docs UrbanPiper
 * hands over at onboarding, then remove it.
 *
 * Concepts:
 *  - Order relay webhook ("order_placed")  → NEW_ORDER
 *  - Order status webhook (new_state)      → ORDER_CANCELLED (others are echoes → IGNORED)
 *  - Rider status webhook (delivery_info)  → RIDER_STATUS
 *  - Order status update endpoint          ← ACCEPTED / FOOD_READY / DISPATCHED / DELIVERED / CANCELLED
 *  - Store toggle ("location" action)      ← setStoreOpen
 *  - Catalogue (inventory) push            ← pushMenu
 *  - Item stock toggle                     ← setItemsAvailable
 * Money: UrbanPiper sends and takes rupees (decimals); we use paise.
 */

export interface UrbanPiperConfig {
  /** e.g. https://pos-int.urbanpiper.com (staging) — TODO(verify-at-onboarding) */
  baseUrl: string;
  /** Our outlet's location ref id at UrbanPiper ("location_ref_id") */
  storeId: string;
  /** "<username>:<api key>" as given by UrbanPiper; sent as `Authorization: apikey <username>:<api key>` */
  apiKey: string;
  /** Shared secret UrbanPiper is configured to send in WEBHOOK_SECRET_HEADER with every webhook */
  webhookSecret: string;
  timeoutMs?: number;
}

// TODO(verify-at-onboarding): UrbanPiper webhooks are not HMAC-signed in the public docs; webhook
// configs allow custom headers, so we ask them to send our secret in this header.
export const UP_WEBHOOK_SECRET_HEADER = "x-canavo-webhook-secret";

// TODO(verify-at-onboarding): aggregator names UrbanPiper uses in `platforms` / `ext_platforms`.
export const UP_PLATFORMS = ["zomato", "swiggy"];

/** Endpoints (relative to baseUrl). TODO(verify-at-onboarding): every path below. */
export const UP_PATHS = {
  ping: (store: string) => `/external/api/v1/stores/?location_ref_id=${encodeURIComponent(store)}`,
  catalogue: (store: string) => `/external/api/v1/inventory/locations/${encodeURIComponent(store)}/`,
  storeToggle: () => `/hub/api/v1/location/`,
  itemToggle: () => `/hub/api/v1/items/`,
  orderStatus: (orderId: string) => `/external/api/v1/orders/${encodeURIComponent(orderId)}/status/`,
};

/** Our push statuses → UrbanPiper `new_status`. TODO(verify-at-onboarding): exact casing / spelling. */
export const UP_STATUS: Record<ChannelPushStatus, string> = {
  ACCEPTED: "Acknowledged",
  FOOD_READY: "Food Ready",
  DISPATCHED: "Dispatched",
  DELIVERED: "Completed",
  CANCELLED: "Cancelled",
};

/** UrbanPiper rider `current_state` → ours. TODO(verify-at-onboarding): full list of states. */
const UP_RIDER_STATE: Record<string, InboundRiderStatus["status"]> = {
  assigned: "ASSIGNED",
  "reached-store": "AT_STORE",
  "at-store": "AT_STORE",
  "picked-up": "PICKED_UP",
  "out-for-delivery": "PICKED_UP",
  dispatched: "PICKED_UP",
  delivered: "DELIVERED",
  completed: "DELIVERED",
};

/** Our food type → UrbanPiper `food_type` ("1" veg, "2" non-veg, "3" egg). TODO(verify-at-onboarding) */
const UP_FOOD_TYPE: Record<string, string> = { VEG: "1", NON_VEG: "2", EGG: "3" };

/** Variant / add-on option ref ids carry a prefix so an inbound option maps back to the right kind. */
const VARIANT_PREFIX = "V-";
const ADDON_PREFIX = "A-";

export const toPaise = (rupees: number | string | null | undefined) => Math.max(0, Math.round(Number(rupees ?? 0) * 100)) || 0;
const toRupees = (paise: number) => Math.round(paise) / 100;
const slug = (s: string) =>
  s
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "menu";

// ---------------------------------------------------------------------------
// Inbound shapes (lenient: unknown fields pass through, money may be string or number)
// ---------------------------------------------------------------------------

const money = z.union([z.number(), z.string()]).optional();
const str = z.union([z.string(), z.number()]).transform(String);

const upOrderSchema = z.object({
  order: z.object({
    details: z.object({
      id: str,
      /** TODO(verify-at-onboarding): `channel` vs ext_platforms[0].name as the source aggregator */
      channel: z.string().optional(),
      order_type: z.string().optional(),
      created: z.union([z.number(), z.string()]).optional(),
      instructions: z.string().nullish(),
      order_total: money,
      order_subtotal: money,
      total_taxes: money,
      discount: money,
      total_charges: money,
      charges: z.array(z.object({ title: z.string().optional(), value: money })).default([]),
      ext_platforms: z
        .array(z.object({ name: z.string().optional(), id: str.optional(), delivery_type: z.string().optional(), kind: z.string().optional() }))
        .default([]),
    }),
    items: z
      .array(
        z.object({
          merchant_id: str,
          title: z.string().optional(),
          quantity: z.number().int().min(1).max(999),
          price: money,
          instructions: z.string().nullish(),
          options_to_add: z.array(z.object({ merchant_id: str, title: z.string().optional(), price: money })).default([]),
        }),
      )
      .min(1)
      .max(100),
    payment: z.array(z.object({ option: z.string(), amount: money })).default([]),
    store: z.object({ merchant_ref_id: str.optional() }).optional(),
  }),
  customer: z
    .object({
      name: z.string().optional(),
      phone: z.string().optional(),
      address: z
        .object({
          line_1: z.string().nullish(),
          line_2: z.string().nullish(),
          landmark: z.string().nullish(),
          sub_locality: z.string().nullish(),
          city: z.string().nullish(),
          pin: str.nullish(),
          latitude: z.union([z.number(), z.string()]).nullish(),
          longitude: z.union([z.number(), z.string()]).nullish(),
        })
        .nullish(),
    })
    .default({}),
});

const upStatusSchema = z.object({ order_id: str, new_state: z.string(), message: z.string().nullish() });

const upRiderSchema = z.object({
  order_id: str,
  additional_info: z.object({ external_channel: z.object({ name: z.string().optional(), order_id: str.optional() }).optional() }).optional(),
  delivery_info: z.object({
    current_state: z.string(),
    delivery_person_details: z.object({ name: z.string().nullish(), phone: z.string().nullish() }).nullish(),
    // TODO(verify-at-onboarding): where the rider's pickup OTP and ETA come (if at all).
    otp: str.nullish(),
    eta: z.union([z.string(), z.number()]).nullish(),
  }),
});

/** Prepaid unless every payment line is cash / COD. TODO(verify-at-onboarding): payment option names. */
const isPrepaid = (payments: { option: string }[]) => !payments.length || payments.some((p) => !/^(cash|cod|cash_on_delivery)$/i.test(p.option));

/** Epoch ms or a date string → ISO; undefined when unreadable. */
function isoOf(v: number | string | undefined) {
  if (v === undefined) return undefined;
  const d = new Date(Number(v) || String(v));
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function normalizeOrder(body: z.infer<typeof upOrderSchema>): InboundNewOrder {
  const d = body.order.details;
  const ext = d.ext_platforms[0];
  const sourceChannel: OrderChannel = sourceChannelOf(ext?.name ?? d.channel ?? "other");
  const pickup = /pickup|takeaway/i.test(d.order_type ?? "");
  const self = /self/i.test(ext?.delivery_type ?? "");
  const charge = (re: RegExp) => d.charges.filter((c) => re.test(c.title ?? "")).reduce((s, c) => s + toPaise(c.value), 0) || undefined;
  const a = body.customer.address;
  const address = a ? [a.line_1, a.line_2, a.sub_locality, a.city, a.pin].filter(Boolean).join(", ") : undefined;
  const coord = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v));
  return {
    type: "NEW_ORDER",
    // UrbanPiper's own order id: status updates and later webhooks use it.
    channelOrderId: d.id,
    displayId: ext?.id && ext.id !== d.id ? ext.id : undefined,
    sourceChannel,
    placedAt: isoOf(d.created),
    customer: { name: body.customer.name, phone: body.customer.phone },
    items: body.order.items.map((i) => {
      const variant = i.options_to_add.find((o) => o.merchant_id.startsWith(VARIANT_PREFIX));
      return {
        externalId: i.merchant_id,
        name: i.title,
        quantity: i.quantity,
        unitPrice: i.price !== undefined ? toPaise(i.price) : undefined,
        variantExternalId: variant?.merchant_id.slice(VARIANT_PREFIX.length),
        addonExternalIds: i.options_to_add.filter((o) => o !== variant).map((o) => (o.merchant_id.startsWith(ADDON_PREFIX) ? o.merchant_id.slice(ADDON_PREFIX.length) : o.merchant_id)),
        notes: i.instructions ?? undefined,
      };
    }),
    totals: {
      total: toPaise(d.order_total),
      subtotal: d.order_subtotal !== undefined ? toPaise(d.order_subtotal) : undefined,
      tax: d.total_taxes !== undefined ? toPaise(d.total_taxes) : undefined,
      discount: d.discount !== undefined ? toPaise(d.discount) : undefined,
    },
    charges: { packaging: charge(/packag/i), delivery: charge(/deliver/i) },
    payment: { prepaid: isPrepaid(body.order.payment), mode: body.order.payment[0]?.option },
    fulfilment: pickup ? "PICKUP" : self ? "SELF" : "CHANNEL",
    delivery: address ? { address: address.slice(0, 500), landmark: a?.landmark ?? undefined, latitude: coord(a?.latitude), longitude: coord(a?.longitude) } : undefined,
    notes: d.instructions ?? undefined,
  };
}

/** Normalize a verified UrbanPiper webhook body (exported for tests). */
export function normalizeUrbanPiperEvent(body: unknown): InboundEvent {
  const b = (body ?? {}) as Record<string, unknown>;
  const fail = (e: z.ZodError) => new WebhookError(400, `Unreadable webhook: ${e.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  if (b.order && typeof b.order === "object" && "details" in (b.order as object)) {
    const p = upOrderSchema.safeParse(body);
    if (!p.success) throw fail(p.error);
    return normalizeOrder(p.data);
  }
  if (b.delivery_info) {
    const p = upRiderSchema.safeParse(body);
    if (!p.success) throw fail(p.error);
    const state = UP_RIDER_STATE[p.data.delivery_info.current_state.trim().toLowerCase()];
    if (!state) return { type: "IGNORED", reason: `rider state ${p.data.delivery_info.current_state}` };
    const person = p.data.delivery_info.delivery_person_details;
    const eta = p.data.delivery_info.eta;
    return {
      type: "RIDER_STATUS",
      channelOrderId: p.data.order_id,
      sourceChannel: sourceChannelOf(p.data.additional_info?.external_channel?.name ?? "other"),
      status: state,
      rider: {
        name: person?.name ?? undefined,
        phone: person?.phone ?? undefined,
        pickupCode: p.data.delivery_info.otp ?? undefined,
        eta: eta === null || eta === undefined ? undefined : typeof eta === "number" ? `${eta} min` : eta,
      },
    };
  }
  if (b.new_state !== undefined) {
    const p = upStatusSchema.safeParse(body);
    if (!p.success) throw fail(p.error);
    // Only a cancellation needs action; other states echo what we pushed.
    if (!/cancel/i.test(p.data.new_state)) return { type: "IGNORED", reason: `order state ${p.data.new_state}` };
    // TODO(verify-at-onboarding): status webhooks may not name the aggregator; we look the order up by UrbanPiper id
    // across channels (the service falls back to the id alone when sourceChannel is OTHER).
    return { type: "ORDER_CANCELLED", channelOrderId: p.data.order_id, sourceChannel: "OTHER", reason: p.data.message ?? undefined };
  }
  throw new WebhookError(400, "Unreadable webhook: not an order, order status or rider status event");
}

/** UrbanPiper catalogue body for our menu. TODO(verify-at-onboarding): field names, option price semantics. */
export function urbanPiperCatalogue(items: ChannelMenuItem[]) {
  const categories = [...new Set(items.map((i) => i.category))].map((name) => ({ ref_id: slug(name), name, active: true }));
  const optionGroups: Record<string, unknown>[] = [];
  const options: Record<string, unknown>[] = [];
  for (const i of items) {
    if (i.variants.length) {
      const ref = `VG-${i.externalId}`;
      optionGroups.push({ ref_id: ref, title: "Size", min_selectable: 1, max_selectable: 1, active: true, item_ref_ids: [i.externalId] });
      // Our sizes have their own price; UrbanPiper options add to the item price.
      for (const v of i.variants) options.push({ ref_id: `${VARIANT_PREFIX}${v.externalId}`, title: v.name, price: toRupees(Math.max(0, v.price - i.price)), available: v.available, opt_grp_ref_ids: [ref] });
    }
    if (i.addons.length) {
      const ref = `AG-${i.externalId}`;
      optionGroups.push({ ref_id: ref, title: "Add-ons", min_selectable: 0, max_selectable: i.addons.length, active: true, item_ref_ids: [i.externalId] });
      for (const a of i.addons) options.push({ ref_id: `${ADDON_PREFIX}${a.externalId}`, title: a.name, price: toRupees(a.price), available: i.available, opt_grp_ref_ids: [ref] });
    }
  }
  return {
    flush_items: false,
    categories,
    items: items.map((i) => ({
      ref_id: i.externalId,
      title: i.name,
      description: i.description,
      price: toRupees(i.price),
      food_type: UP_FOOD_TYPE[i.foodType] ?? "1",
      category_ref_ids: [slug(i.category)],
      available: i.available,
      current_stock: i.available ? -1 : 0,
      sold_at_store: true,
    })),
    option_groups: optionGroups,
    options,
  };
}

export class UrbanPiperAdapter implements ChannelAdapter {
  constructor(private cfg: UrbanPiperConfig) {}

  private async call(method: string, path: string, body?: unknown) {
    const url = `${this.cfg.baseUrl.replace(/\/+$/, "")}${path}`;
    let res: Response;
    try {
      res = await hubFetch(url, {
        method,
        headers: { authorization: `apikey ${this.cfg.apiKey}`, ...(body !== undefined && { "content-type": "application/json" }) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 10_000),
      });
    } catch (e) {
      throw new Error(`UrbanPiper not reachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) {
      // Only the hub's own JSON message, never its raw body (QA BUG-048).
      const msg = await hubErrorMessage(res);
      throw new Error(`UrbanPiper said ${res.status}${msg ? `: ${msg}` : ""}`);
    }
  }

  ping() {
    return this.call("GET", UP_PATHS.ping(this.cfg.storeId));
  }

  pushMenu(items: ChannelMenuItem[]) {
    return this.call("POST", UP_PATHS.catalogue(this.cfg.storeId), urbanPiperCatalogue(items));
  }

  setStoreOpen(open: boolean) {
    return this.call("POST", UP_PATHS.storeToggle(), { location_ref_id: this.cfg.storeId, platforms: UP_PLATFORMS, action: open ? "enable" : "disable" });
  }

  setItemsAvailable(externalIds: string[], available: boolean) {
    return this.call("POST", UP_PATHS.itemToggle(), { location_ref_id: this.cfg.storeId, platforms: UP_PLATFORMS, item_ref_ids: externalIds, action: available ? "enable" : "disable" });
  }

  acknowledge(order: ChannelOrderRef) {
    return this.updateStatus(order, "ACCEPTED");
  }

  updateStatus(order: ChannelOrderRef, status: ChannelPushStatus, reason?: string) {
    return this.call("PUT", UP_PATHS.orderStatus(order.channelOrderId), { new_status: UP_STATUS[status], message: reason ?? UP_STATUS[status] });
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): InboundEvent {
    const h = headers[UP_WEBHOOK_SECRET_HEADER];
    const got = Buffer.from((Array.isArray(h) ? h[0] : h)?.trim() ?? "");
    const want = Buffer.from(this.cfg.webhookSecret);
    if (!this.cfg.webhookSecret || got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw new WebhookError(401, "Bad webhook secret");
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new WebhookError(400, "Body is not JSON");
    }
    return normalizeUrbanPiperEvent(body);
  }
}
