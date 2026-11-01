import crypto from "node:crypto";
import { z } from "zod";
import type { ChannelPushStatus, OrderChannel } from "@canavo/shared";
import { WebhookError, type ChannelAdapter, type ChannelMenuItem, type ChannelOrderRef, type InboundEvent } from "./adapter";

/**
 * Generic partner-hub adapter (REST/JSON out, HMAC-signed webhooks in).
 * The contract is documented in docs/build/channels-hub-contract.md — a real hub
 * (UrbanPiper etc.) is mapped onto it later, either by a thin adapter of its own
 * or by the hub's configurable webhooks.
 */

export interface HubConfig {
  baseUrl: string;
  storeId: string;
  apiKey: string;
  webhookSecret: string;
  /** Per-call timeout (ms) */
  timeoutMs?: number;
}

export const HUB_SIGNATURE_HEADER = "x-hub-signature";

/** `sha256=<hex HMAC-SHA256(rawBody, secret)>` — what the hub sends (and what tests sign with). */
export const signHubBody = (rawBody: Buffer | string, secret: string) => `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`;

export function verifyHubSignature(rawBody: Buffer, header: string | undefined, secret: string): boolean {
  if (!secret || !header) return false;
  const a = Buffer.from(signHubBody(rawBody, secret));
  const b = Buffer.from(header.trim());
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Hub channel names → our ORDER_CHANNELS. Anything we don't know is OTHER. */
export function sourceChannelOf(name: string): OrderChannel {
  const n = name.trim().toLowerCase();
  if (n === "zomato") return "ZOMATO";
  if (n === "swiggy") return "SWIGGY";
  if (n === "ondc") return "ONDC";
  return "OTHER";
}

const paise = z.number().int().min(0);
const ref = z.object({ id: z.string().trim().min(1).max(100), channel: z.string().trim().min(1).max(40) });
const webhookSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("order.new"),
    order: ref.extend({
      placedAt: z.string().max(40).optional(),
      customer: z.object({ name: z.string().max(100).optional(), phone: z.string().max(20).optional() }).default({}),
      items: z
        .array(
          z.object({
            externalId: z.string().trim().min(1).max(100),
            name: z.string().max(200).optional(),
            quantity: z.number().int().min(1).max(999),
            unitPrice: paise.optional(),
            variantExternalId: z.string().max(100).optional(),
            addonExternalIds: z.array(z.string().max(100)).max(30).default([]),
            notes: z.string().max(200).optional(),
          }),
        )
        .min(1)
        .max(100),
      totals: z.object({ total: paise, subtotal: paise.optional(), tax: paise.optional(), discount: paise.optional() }),
      charges: z.object({ packaging: paise.optional(), delivery: paise.optional() }).default({}),
      payment: z.object({ prepaid: z.boolean(), mode: z.string().max(40).optional() }),
      fulfilment: z.enum(["channel", "self", "pickup"]).default("channel"),
      delivery: z
        .object({
          address: z.string().max(500).optional(),
          landmark: z.string().max(200).optional(),
          latitude: z.number().optional(),
          longitude: z.number().optional(),
        })
        .optional(),
      notes: z.string().max(300).optional(),
    }),
  }),
  z.object({ event: z.literal("order.cancelled"), order: ref, reason: z.string().max(200).optional() }),
  z.object({
    event: z.literal("rider.status"),
    order: ref,
    status: z.enum(["assigned", "at_store", "picked_up", "delivered"]),
    rider: z
      .object({ name: z.string().max(100).optional(), phone: z.string().max(20).optional(), pickupCode: z.string().max(20).optional(), eta: z.string().max(40).optional() })
      .optional(),
  }),
]);

/** Normalize a verified hub webhook body (exported for tests and the mock). */
export function normalizeHubEvent(body: unknown): InboundEvent {
  const parsed = webhookSchema.safeParse(body);
  if (!parsed.success) throw new WebhookError(400, `Unreadable webhook: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  const e = parsed.data;
  const base = { channelOrderId: e.order.id, sourceChannel: sourceChannelOf(e.order.channel) };
  if (e.event === "order.cancelled") return { ...base, type: "ORDER_CANCELLED", reason: e.reason };
  if (e.event === "rider.status") return { ...base, type: "RIDER_STATUS", status: e.status.toUpperCase() as "ASSIGNED", rider: e.rider };
  const o = e.order;
  return {
    ...base,
    type: "NEW_ORDER",
    placedAt: o.placedAt,
    customer: o.customer,
    items: o.items,
    totals: o.totals,
    charges: o.charges,
    payment: o.payment,
    fulfilment: o.fulfilment.toUpperCase() as "CHANNEL",
    delivery: o.delivery,
    notes: o.notes,
  };
}

export class HubAdapter implements ChannelAdapter {
  constructor(private cfg: HubConfig) {}

  private async call(method: string, path: string, body?: unknown) {
    const url = `${this.cfg.baseUrl.replace(/\/+$/, "")}/v1${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { "x-api-key": this.cfg.apiKey, ...(body !== undefined && { "content-type": "application/json" }) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 10_000),
      });
    } catch (e) {
      throw new Error(`Hub not reachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let msg = text.slice(0, 200);
      try {
        const j = JSON.parse(text) as { message?: string; error?: string };
        msg = j.message ?? j.error ?? msg;
      } catch {
        /* plain text */
      }
      throw new Error(`Hub said ${res.status}${msg ? `: ${msg}` : ""}`);
    }
  }

  private store = () => `/stores/${encodeURIComponent(this.cfg.storeId)}`;

  ping() {
    return this.call("GET", `${this.store()}/ping`);
  }

  pushMenu(items: ChannelMenuItem[]) {
    return this.call("PUT", `${this.store()}/menu`, { items });
  }

  setStoreOpen(open: boolean) {
    return this.call("PUT", `${this.store()}/status`, { open });
  }

  setItemsAvailable(externalIds: string[], available: boolean) {
    return this.call("PUT", `${this.store()}/items/availability`, { externalIds, available });
  }

  acknowledge(order: ChannelOrderRef) {
    return this.updateStatus(order, "ACCEPTED");
  }

  updateStatus(order: ChannelOrderRef, status: ChannelPushStatus, reason?: string) {
    return this.call("POST", `/orders/${encodeURIComponent(order.channelOrderId)}/status`, {
      storeId: this.cfg.storeId,
      channel: order.sourceChannel.toLowerCase(),
      status: status.toLowerCase(),
      ...(reason && { reason }),
    });
  }

  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): InboundEvent {
    const sig = headers[HUB_SIGNATURE_HEADER];
    if (!verifyHubSignature(rawBody, Array.isArray(sig) ? sig[0] : sig, this.cfg.webhookSecret)) throw new WebhookError(401, "Bad signature");
    let body: unknown;
    try {
      body = JSON.parse(rawBody.toString("utf8"));
    } catch {
      throw new WebhookError(400, "Body is not JSON");
    }
    return normalizeHubEvent(body);
  }
}
