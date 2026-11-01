import type { ChannelPushStatus, OrderChannel } from "@canavo/shared";

/**
 * Phase 6.1 — one interface for every online channel we talk to (decision D3: a partner
 * hub first, e.g. UrbanPiper-style, which relays Zomato / Swiggy; direct integrations later).
 * Adapters only translate: they never touch our database. The channel service
 * (services/channels/service.ts) turns their normalized events into bills.
 */

/** One sellable menu entry as we publish it to a channel. Money in paise. */
export interface ChannelMenuItem {
  /** The id the channel knows this item by (ChannelItemMap, default = our menu item id) */
  externalId: string;
  name: string;
  description: string;
  category: string;
  price: number;
  foodType: string;
  available: boolean;
  variants: { externalId: string; name: string; price: number; available: boolean }[];
  addons: { externalId: string; name: string; price: number }[];
}

export interface ChannelOrderRef {
  /** The channel's own order id */
  channelOrderId: string;
  sourceChannel: OrderChannel;
}

export interface InboundItem {
  externalId: string;
  name?: string;
  quantity: number;
  /** What the channel charged per unit (for reconciliation only — we bill our menu price) */
  unitPrice?: number;
  variantExternalId?: string;
  addonExternalIds: string[];
  notes?: string;
}

export interface InboundNewOrder extends ChannelOrderRef {
  type: "NEW_ORDER";
  /** The id staff and riders know the order by when it differs from channelOrderId (e.g. the Zomato id behind a hub's own id) */
  displayId?: string;
  placedAt?: string;
  customer: { name?: string; phone?: string };
  items: InboundItem[];
  /** The channel's totals, paise */
  totals: { total: number; subtotal?: number; tax?: number; discount?: number };
  charges: { packaging?: number; delivery?: number };
  payment: { prepaid: boolean; mode?: string };
  /** CHANNEL = the aggregator's rider delivers; SELF = we deliver; PICKUP = the customer collects */
  fulfilment: "CHANNEL" | "SELF" | "PICKUP";
  delivery?: { address?: string; landmark?: string; latitude?: number; longitude?: number };
  notes?: string;
}

export interface InboundCancelled extends ChannelOrderRef {
  type: "ORDER_CANCELLED";
  reason?: string;
}

export interface InboundRiderStatus extends ChannelOrderRef {
  type: "RIDER_STATUS";
  status: "ASSIGNED" | "AT_STORE" | "PICKED_UP" | "DELIVERED";
  /** pickupCode = the OTP / code the rider shows at the counter; eta = ISO time or text like "8 min" */
  rider?: { name?: string; phone?: string; pickupCode?: string; eta?: string };
}

/** A webhook we understand but don't act on (e.g. a hub echoing a status we pushed). Answered 200. */
export interface InboundIgnored {
  type: "IGNORED";
  reason: string;
}

export type InboundEvent = InboundNewOrder | InboundCancelled | InboundRiderStatus | InboundIgnored;

/** Thrown by parseWebhook: bad signature (401) or a payload we can't read (400). */
export class WebhookError extends Error {
  constructor(
    public status: 400 | 401,
    message: string,
  ) {
    super(message);
  }
}

export interface ChannelAdapter {
  /** Cheap authenticated call to check the credentials (Settings → "Test connection") */
  ping(): Promise<void>;
  /** Publish the full menu with current prices and availability */
  pushMenu(items: ChannelMenuItem[]): Promise<void>;
  /** Take / stop taking orders on every channel of the store */
  setStoreOpen(open: boolean): Promise<void>;
  /** Tell the channel we accepted an order (same as updateStatus ACCEPTED) */
  acknowledge(order: ChannelOrderRef): Promise<void>;
  updateStatus(order: ChannelOrderRef, status: ChannelPushStatus, reason?: string): Promise<void>;
  /** Mark items in / out of stock without a full menu push (external item ids) */
  setItemsAvailable(externalIds: string[], available: boolean): Promise<void>;
  /** Verify the signature and normalize a webhook body; throws WebhookError */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): InboundEvent;
}
