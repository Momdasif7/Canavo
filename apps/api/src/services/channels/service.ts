import { Prisma, type ChannelConnection, type ChannelOrder } from "@prisma/client";
import { ORDER_CHANNEL_LABELS, type ChannelPushStatus, type OrderCreateInput } from "@canavo/shared";
import { platformPrisma, prisma } from "../../db";
import { HttpError } from "../../lib/http";
import { outboxTask } from "../../lib/outbox";
import { featureOn, moduleEnabled, runForOutlet } from "../../lib/tenant";
import { emitToOutlet } from "../../realtime";
import { alertOrderCancelled } from "../alerts";
import { getOrder, settleIfPaid } from "../billing";
import { channelRequest, createChannelOrder } from "../channel-orders";
import { cancelOrderInTx } from "../order-cancel";
import { encryptSecret, decryptSecret } from "../whatsapp";
import { WebhookError, type ChannelAdapter, type ChannelMenuItem, type InboundCancelled, type InboundNewOrder, type InboundRiderStatus } from "./adapter";
import { emitBoardChange, recordRiderPickup } from "./board";
import { HubAdapter } from "./hub";
import { UrbanPiperAdapter } from "./urbanpiper";

/**
 * Phase 6.1 — online channels through a partner hub.
 *
 * Inbound (webhook): a hub order becomes a normal bill via createChannelOrder (our menu
 * prices, our GST, invoice number, KOTs) under the "Online orders" system account. The
 * channel's own payload and total are kept on ChannelOrder for reconciliation.
 * Decision: aggregator orders are TAKEAWAY bills — the aggregator's rider collects them,
 * so no Delivery record is created and our delivery partners are never auto-assigned.
 * Exception: when the hub says the restaurant delivers (fulfilment SELF) and the business
 * has DELIVERY, the bill is a DELIVERY order with a Delivery record (our delivery board,
 * auto-assignment) — see newOrder.
 *
 * Outbound: status changes (accepted, food ready, cancelled …) go through the outbox
 * (task "channel.pushStatus"), so they survive crashes and retry with backoff; what
 * still fails shows on Settings → Channels.
 */

/** Our channel total vs. the channel's may differ by rounding; more than this is flagged. */
const MISMATCH_TOLERANCE = 100;

export const PUSH_TASK = "channel.pushStatus";

export const adapterFor = (conn: ChannelConnection): ChannelAdapter => {
  const cfg = {
    baseUrl: conn.baseUrl,
    storeId: conn.externalStoreId,
    apiKey: decryptSecret(conn.apiKeyEnc ?? undefined),
    webhookSecret: decryptSecret(conn.webhookSecretEnc ?? undefined),
  };
  return conn.provider === "URBANPIPER" ? new UrbanPiperAdapter(cfg) : new HubAdapter(cfg);
};

/** For the settings screen: never the secrets themselves. */
export function presentConnection(conn: ChannelConnection) {
  const { apiKeyEnc, webhookSecretEnc, ...rest } = conn;
  const tail = (enc: string | null) => {
    const plain = decryptSecret(enc ?? undefined);
    return plain ? `••••${plain.slice(-4)}` : null;
  };
  return { ...rest, apiKey: tail(apiKeyEnc), webhookSecret: tail(webhookSecretEnc) };
}

export const encrypt = encryptSecret;

/** Record the last problem with a connection (shown on Settings → Channels). */
async function noteError(connectionId: string, error: string | null) {
  await platformPrisma.channelConnection.update({ where: { id: connectionId }, data: error ? { lastError: error.slice(0, 500), lastErrorAt: new Date() } : { lastError: null, lastErrorAt: null } });
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

/**
 * The outlet's menu as channels see it: hidden items left out, out-of-stock (manual or
 * AUTO_STOCK_OUT) published as unavailable, outlet price overrides applied.
 * Call inside the outlet's tenant context.
 */
export async function buildChannelMenu(outletId: string): Promise<ChannelMenuItem[]> {
  const [items, maps] = await Promise.all([
    prisma.menuItem.findMany({
      include: { category: { select: { name: true } }, variants: true, addons: true, overrides: { where: { outletId } } },
      orderBy: [{ category: { name: "asc" } }, { name: "asc" }],
    }),
    prisma.channelItemMap.findMany({ where: { outletId } }),
  ]);
  const ext = new Map(maps.map((m) => [m.menuItemId, m.externalId]));
  const autoStock = featureOn("AUTO_STOCK_OUT");
  return items.flatMap((item) => {
    const o = item.overrides[0];
    const status = o?.status ?? item.status;
    if (status === "HIDDEN") return [];
    const available = status === "AVAILABLE" && !(autoStock && o?.stockOut);
    return [
      {
        externalId: ext.get(item.id) ?? item.id,
        name: item.name,
        description: item.description,
        category: item.category.name,
        price: o?.price ?? item.price,
        foodType: item.foodType,
        available,
        variants: item.variants.map((v) => ({ externalId: v.id, name: v.name, price: v.price, available: available && !(autoStock && o?.stockOutVariantIds.includes(v.id)) })),
        addons: item.addons.map((a) => ({ externalId: a.id, name: a.name, price: a.price })),
      },
    ];
  });
}

/** Push the current menu now. Records the sync time or the error. */
export async function syncMenu(conn: ChannelConnection) {
  const items = await buildChannelMenu(conn.outletId);
  try {
    await adapterFor(conn).pushMenu(items);
  } catch (e) {
    await noteError(conn.id, `Menu sync failed: ${(e as Error).message}`);
    throw new HttpError(502, `Menu sync failed: ${(e as Error).message}`);
  }
  await platformPrisma.channelConnection.update({ where: { id: conn.id }, data: { lastMenuSyncAt: new Date(), lastError: null, lastErrorAt: null } });
  return { items: items.length, unavailable: items.filter((i) => !i.available).length };
}

export async function setStoreOpen(conn: ChannelConnection, open: boolean) {
  try {
    await adapterFor(conn).setStoreOpen(open);
  } catch (e) {
    await noteError(conn.id, `Could not ${open ? "open" : "close"} the store: ${(e as Error).message}`);
    throw new HttpError(502, `Could not ${open ? "open" : "close"} the store: ${(e as Error).message}`);
  }
  return platformPrisma.channelConnection.update({ where: { id: conn.id }, data: { storeOpen: open, lastError: null, lastErrorAt: null } });
}

// ---------------------------------------------------------------------------
// Inbound webhooks
// ---------------------------------------------------------------------------

export interface WebhookResult {
  status: number;
  body: Record<string, unknown>;
}

const reject = (status: number, error: string, message: string, extra: Record<string, unknown> = {}): WebhookResult => ({ status, body: { ok: false, error, message, ...extra } });

/** Verify, normalize and act on one hub webhook. Idempotent: hubs retry until they get a 2xx. */
export async function handleHubWebhook(connectionId: string, rawBody: Buffer, headers: Record<string, string | string[] | undefined>, ip?: string): Promise<WebhookResult> {
  const conn = await platformPrisma.channelConnection.findUnique({ where: { id: connectionId } });
  if (!conn) return reject(404, "UNKNOWN_CONNECTION", "No such channel connection");
  let event;
  try {
    event = adapterFor(conn).parseWebhook(rawBody, headers);
  } catch (e) {
    if (e instanceof WebhookError) return reject(e.status, e.status === 401 ? "BAD_SIGNATURE" : "BAD_PAYLOAD", e.message);
    throw e;
  }
  return runForOutlet(conn.outletId, async () => {
    if (!moduleEnabled("CHANNELS")) return reject(403, "CHANNELS_OFF", "Online channels are not enabled for this business");
    if (event.type === "IGNORED") return { status: 200, body: { ok: true, ignored: event.reason } };
    if (event.type === "NEW_ORDER") return newOrder(conn, event, ip);
    if (event.type === "ORDER_CANCELLED") return channelCancelled(conn, event);
    return riderStatus(conn, event);
  });
}

const validCoord = (v: number | undefined, max: number) => (v !== undefined && Number.isFinite(v) && Math.abs(v) <= max ? v : undefined);

const phoneOf = (raw?: string) => {
  const p = raw?.replace(/[\s-]/g, "").replace(/^(\+?91|0)/, "");
  return p && /^[6-9]\d{9}$/.test(p) ? p : undefined;
};

async function logOrder(conn: ChannelConnection, e: InboundNewOrder, data: Partial<Pick<ChannelOrder, "status" | "orderId" | "error" | "ourTotal" | "mismatch">>, tx: Prisma.TransactionClient | typeof prisma = prisma) {
  const key = { outletId_sourceChannel_channelOrderId: { outletId: conn.outletId, sourceChannel: e.sourceChannel, channelOrderId: e.channelOrderId } };
  const row = { status: "REJECTED", error: null, ...data, connectionId: conn.id, channelTotal: e.totals.total, payload: e as unknown as Prisma.InputJsonValue };
  return tx.channelOrder.upsert({ where: key, create: { outletId: conn.outletId, sourceChannel: e.sourceChannel, channelOrderId: e.channelOrderId, ...row }, update: row });
}

async function newOrder(conn: ChannelConnection, e: InboundNewOrder, ip?: string): Promise<WebhookResult> {
  const label = ORDER_CHANNEL_LABELS[e.sourceChannel];
  const existing = await prisma.channelOrder.findUnique({
    where: { outletId_sourceChannel_channelOrderId: { outletId: conn.outletId, sourceChannel: e.sourceChannel, channelOrderId: e.channelOrderId } },
  });
  // A retry of an order we already took: same answer, nothing new. (A rejected one is tried again — the menu may be fixed.)
  if (existing?.orderId) return { status: 200, body: { ok: true, duplicate: true, orderId: existing.orderId } };

  const fail = async (status: number, error: string, message: string, extra: Record<string, unknown> = {}) => {
    await logOrder(conn, e, { status: "REJECTED", error: message });
    await noteError(conn.id, `${label} order ${e.channelOrderId} rejected: ${message}`);
    console.warn(`[channels] ${label} order ${e.channelOrderId} rejected: ${message}`);
    emitToOutlet(conn.outletId, "channel:order", { channelOrderId: e.channelOrderId, sourceChannel: e.sourceChannel, status: "REJECTED" });
    return reject(status, error, message, extra);
  };
  if (!conn.enabled) return fail(409, "CHANNEL_OFF", "This store's channel connection is switched off");
  if (!conn.storeOpen) return fail(409, "STORE_CLOSED", "The store is closed for online orders");

  // External ids → our menu: the item map first, else our own id (the default we publish).
  const maps = await prisma.channelItemMap.findMany({ where: { outletId: conn.outletId } });
  const byExt = new Map(maps.map((m) => [m.externalId, m.menuItemId]));
  const remapped = new Set(maps.map((m) => m.menuItemId));
  const candidates = [...new Set(e.items.map((i) => byExt.get(i.externalId) ?? i.externalId))];
  const menu = await prisma.menuItem.findMany({ where: { id: { in: candidates } }, include: { variants: true, addons: true } });
  const byId = new Map(menu.map((m) => [m.id, m]));
  const unknown: string[] = [];
  const items: OrderCreateInput["items"] = [];
  for (const line of e.items) {
    const mapped = byExt.get(line.externalId);
    // An item published under a custom id is only reachable by that id.
    const item = byId.get(mapped ?? (remapped.has(line.externalId) ? "" : line.externalId));
    if (!item) {
      unknown.push(`${line.name ? `${line.name} ` : ""}(${line.externalId})`);
      continue;
    }
    const pick = <T extends { id: string; name: string }>(list: T[], key: string) => list.find((x) => x.id === key) ?? list.find((x) => x.name.toLowerCase() === key.trim().toLowerCase());
    const variant = line.variantExternalId ? pick(item.variants, line.variantExternalId) : undefined;
    if (line.variantExternalId && !variant) unknown.push(`size ${line.variantExternalId} of ${item.name}`);
    const addonIds: string[] = [];
    for (const a of line.addonExternalIds) {
      const addon = pick(item.addons, a);
      if (addon) addonIds.push(addon.id);
      else unknown.push(`add-on ${a} of ${item.name}`);
    }
    items.push({ menuItemId: item.id, variantId: variant?.id, addonIds, quantity: line.quantity, notes: line.notes });
  }
  if (unknown.length) return fail(422, "UNKNOWN_ITEM", `Unknown item(s): ${unknown.join(", ")}`, { unknown });

  // "We deliver" (self-delivery) → a DELIVERY bill on our delivery board when the business has DELIVERY
  // and the hub gave an address and a phone we can call; otherwise a takeaway with the address in the notes.
  const phone = phoneOf(e.customer.phone);
  const address = e.delivery?.address?.trim();
  const weDeliver = e.fulfilment === "SELF" && moduleEnabled("DELIVERY") && Boolean(phone) && (address?.length ?? 0) >= 5;
  const where = e.fulfilment === "PICKUP" ? "customer pickup" : e.fulfilment === "SELF" ? `we deliver${address && !weDeliver ? ` to ${address}` : ""}` : `${label} rider pickup`;
  const shownId = e.displayId ?? e.channelOrderId;
  const input: OrderCreateInput = {
    orderType: weDeliver ? "DELIVERY" : "TAKEAWAY",
    interState: false,
    customerName: e.customer.name?.slice(0, 100) || (weDeliver ? "Customer" : undefined),
    customerPhone: phone,
    items,
    notes: [`${label} #${shownId} · ${where}`, e.notes].filter(Boolean).join(" · ").slice(0, 300),
    ...(weDeliver && {
      delivery: {
        address: address!.slice(0, 500),
        landmark: e.delivery?.landmark?.slice(0, 200),
        latitude: validCoord(e.delivery?.latitude, 90),
        longitude: validCoord(e.delivery?.longitude, 180),
        source: "AGGREGATOR" as const,
        // Not prepaid on the app: our partner collects at the door.
        cod: !e.payment.prepaid,
      },
    }),
  };

  let result;
  try {
    result = await prisma.$transaction(
      async (tx) => {
        const created = await createChannelOrder(conn.outletId, e.sourceChannel, input, { channelOrderId: e.channelOrderId, tx, ip });
        const order = created.order;
        if (created.duplicate) return { order, effects: created.effects, duplicate: true };
        // Aggregators collect the money and settle with the hotel later: the bill is paid now.
        if (e.payment.prepaid) {
          await tx.payment.create({
            data: { orderId: order.id, mode: "ONLINE", amount: order.grandTotal, reference: `${label} ${e.channelOrderId}`.slice(0, 100), status: "SUCCESS", confirmedAt: new Date() },
          });
          await settleIfPaid(order.id, tx);
        }
        const mismatch = Math.abs(e.totals.total - order.grandTotal) > MISMATCH_TOLERANCE;
        const row = await logOrder(conn, e, { status: "ACCEPTED", orderId: order.id, ourTotal: order.grandTotal, mismatch, error: null }, tx);
        await outboxTask(tx, PUSH_TASK, { channelOrderRowId: row.id, connectionId: conn.id, status: "ACCEPTED" satisfies ChannelPushStatus });
        return { order, effects: created.effects, duplicate: false, mismatch };
      },
      { timeout: 20_000 },
    );
  } catch (err) {
    // Two deliveries of the same order racing: the loser sees the unique index — answer like a retry.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const dup = await prisma.order.findFirst({ where: { outletId: conn.outletId, channel: e.sourceChannel, channelOrderId: e.channelOrderId }, select: { id: true } });
      if (dup) return { status: 200, body: { ok: true, duplicate: true, orderId: dup.id } };
    }
    // Our billing refused it (item unavailable, out of stock, outside serving hours …): tell the hub why.
    if (err instanceof HttpError && err.status < 500) return fail(422, "REJECTED", err.message);
    throw err;
  }
  result.effects(); // includes the channel:board "new order" event
  if (!result.duplicate) {
    emitToOutlet(conn.outletId, "channel:order", { orderId: result.order.id, channelOrderId: e.channelOrderId, sourceChannel: e.sourceChannel, status: "ACCEPTED" });
    if (result.order.status === "PAID") emitToOutlet(conn.outletId, "order:paid", { id: result.order.id, invoiceNumber: result.order.invoiceNumber });
  }
  return { status: 200, body: { ok: true, duplicate: result.duplicate, orderId: result.order.id, invoiceNumber: result.order.invoiceNumber, ...(result.mismatch && { totalMismatch: true }) } };
}

async function findChannelOrder(conn: ChannelConnection, e: { sourceChannel: string; channelOrderId: string }) {
  const exact = await prisma.channelOrder.findUnique({
    where: { outletId_sourceChannel_channelOrderId: { outletId: conn.outletId, sourceChannel: e.sourceChannel, channelOrderId: e.channelOrderId } },
  });
  // Some hubs' status / rider webhooks don't name the aggregator: the hub's own order id is enough.
  return exact ?? prisma.channelOrder.findFirst({ where: { outletId: conn.outletId, connectionId: conn.id, channelOrderId: e.channelOrderId }, orderBy: { createdAt: "desc" } });
}

/** The customer / channel cancelled: void our bill (no push back — the channel already knows). */
async function channelCancelled(conn: ChannelConnection, e: InboundCancelled): Promise<WebhookResult> {
  const row = await findChannelOrder(conn, e);
  if (!row) return { status: 200, body: { ok: true, ignored: "unknown order" } };
  if (row.status === "CANCELLED" || !row.orderId) {
    await prisma.channelOrder.update({ where: { id: row.id }, data: { status: row.orderId ? "CANCELLED" : row.status } });
    return { status: 200, body: { ok: true, duplicate: true } };
  }
  const order = await getOrder(row.orderId, conn.outletId);
  const reason = `Cancelled on ${ORDER_CHANNEL_LABELS[e.sourceChannel]}${e.reason ? `: ${e.reason}` : ""}`.slice(0, 200);
  const req = await channelRequest(conn.outletId);
  if (order.status !== "CANCELLED") {
    if (order.refundedAmount > 0) {
      await prisma.channelOrder.update({ where: { id: row.id }, data: { status: "CANCELLED", error: "Bill has refunds — cancel it by hand" } });
      return { status: 200, body: { ok: true, warning: "bill has refunds; staff must settle it" } };
    }
    await prisma.$transaction(async (tx) => {
      await cancelOrderInTx(tx, req, order, reason, { source: e.sourceChannel });
      await tx.channelOrder.update({ where: { id: row.id }, data: { status: "CANCELLED" } });
    });
    emitToOutlet(conn.outletId, "order:cancelled", { id: order.id });
    void alertOrderCancelled(conn.outletId, order.id, req.user!, reason);
  } else {
    await prisma.channelOrder.update({ where: { id: row.id }, data: { status: "CANCELLED" } });
  }
  emitToOutlet(conn.outletId, "channel:order", { orderId: order.id, channelOrderId: e.channelOrderId, sourceChannel: e.sourceChannel, status: "CANCELLED" });
  return { status: 200, body: { ok: true, orderId: order.id } };
}

async function riderStatus(conn: ChannelConnection, e: InboundRiderStatus): Promise<WebhookResult> {
  const row = await findChannelOrder(conn, e);
  if (!row) return { status: 200, body: { ok: true, ignored: "unknown order" } };
  // Later updates often leave out what earlier ones said (name, code): merge.
  const given = Object.fromEntries(Object.entries(e.rider ?? {}).filter(([, v]) => typeof v === "string" && v.trim()));
  const rider = { ...((row.rider ?? {}) as Record<string, unknown>), ...given };
  await prisma.$transaction(async (tx) => {
    await tx.channelOrder.update({ where: { id: row.id }, data: { riderStatus: e.status, rider: rider as Prisma.InputJsonValue } });
    if (row.orderId) {
      // The channel's rider took it: handed over (no DISPATCHED push — the channel told us).
      if (e.status === "PICKED_UP" || e.status === "DELIVERED") await recordRiderPickup(tx, conn.outletId, row.orderId, typeof rider.name === "string" ? rider.name.slice(0, 100) : undefined);
      await emitBoardChange(conn.outletId, row.orderId, tx);
    }
  });
  emitToOutlet(conn.outletId, "channel:rider", { orderId: row.orderId, channelOrderId: e.channelOrderId, status: e.status, rider });
  return { status: 200, body: { ok: true } };
}

// ---------------------------------------------------------------------------
// Outbound status (outbox)
// ---------------------------------------------------------------------------

/**
 * Inside the caller's transaction: tell the channel about a status change of our bill
 * once it commits. No-op for orders that didn't come from a channel hub.
 */
export async function queueChannelStatus(tx: Prisma.TransactionClient, orderId: string, status: ChannelPushStatus, reason?: string) {
  if (!moduleEnabled("CHANNELS")) return false;
  const row = await tx.channelOrder.findFirst({ where: { orderId, status: { not: "REJECTED" } } });
  if (!row) return false;
  // "Food ready" goes out once, whether the kitchen (all KOTs ready) or the packer said it first.
  if (status === "FOOD_READY") {
    const { count } = await tx.channelOrder.updateMany({ where: { id: row.id, foodReadyQueuedAt: null }, data: { foodReadyQueuedAt: new Date() } });
    if (!count) return true;
  }
  await outboxTask(tx, PUSH_TASK, { channelOrderRowId: row.id, connectionId: row.connectionId, status, ...(reason && { reason }) });
  return true;
}

/** Kitchen marked a KOT ready: once every KOT of the order is ready, the food is ready for the rider. */
export async function onKotReady(tx: Prisma.TransactionClient, orderId: string) {
  if (!moduleEnabled("CHANNELS")) return;
  const kots = await tx.kotTicket.findMany({ where: { orderId }, select: { status: true } });
  if (kots.length && kots.every((k) => k.status === "READY" || k.status === "SERVED")) await queueChannelStatus(tx, orderId, "FOOD_READY");
}

export interface PushPayload {
  channelOrderRowId: string;
  connectionId: string;
  status: ChannelPushStatus;
  reason?: string;
}

/** Outbox task: push one status to the hub. Throws on failure so the outbox retries (then dead-letters). */
export async function pushStatusTask({ channelOrderRowId, connectionId, status, reason }: PushPayload) {
  const [row, conn] = await Promise.all([
    prisma.channelOrder.findUnique({ where: { id: channelOrderRowId } }),
    prisma.channelConnection.findUnique({ where: { id: connectionId } }),
  ]);
  if (!row || !conn) return;
  // Don't tell the channel "food ready" about an order it already cancelled.
  if (row.status === "CANCELLED" && status !== "CANCELLED") return;
  try {
    await adapterFor(conn).updateStatus({ channelOrderId: row.channelOrderId, sourceChannel: row.sourceChannel as InboundNewOrder["sourceChannel"] }, status, reason);
  } catch (e) {
    const msg = `Could not send "${status}" for ${ORDER_CHANNEL_LABELS[row.sourceChannel as InboundNewOrder["sourceChannel"]] ?? row.sourceChannel} #${row.channelOrderId}: ${(e as Error).message}`;
    await prisma.channelOrder.update({ where: { id: row.id }, data: { pushError: msg.slice(0, 500) } });
    await noteError(conn.id, msg);
    throw e;
  }
  await prisma.channelOrder.update({ where: { id: row.id }, data: { pushedStatus: status, pushError: null } });
}

/** Status pushes that gave up (dead-lettered in the outbox) for a connection. */
export function failedPushes(businessId: string, connectionId: string) {
  return platformPrisma.outboxEvent.findMany({
    where: { businessId, name: PUSH_TASK, failedAt: { not: null }, payload: { path: ["connectionId"], equals: connectionId } },
    select: { seq: true, payload: true, lastError: true, failedAt: true, attempts: true },
    orderBy: { seq: "desc" },
    take: 50,
  });
}

/** Put dead-lettered pushes back in the queue (Settings → Channels → "Retry"). */
export async function retryFailedPushes(businessId: string, connectionId: string) {
  const { count } = await platformPrisma.outboxEvent.updateMany({
    where: { businessId, name: PUSH_TASK, failedAt: { not: null }, payload: { path: ["connectionId"], equals: connectionId } },
    data: { failedAt: null, attempts: 0, availableAt: new Date() },
  });
  return count;
}
