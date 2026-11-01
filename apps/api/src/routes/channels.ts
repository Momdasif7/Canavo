import express, { Router } from "express";
import { z } from "zod";
import { CHANNEL_PUSH_STATUSES, channelConnectionSchema } from "@canavo/shared";
import { prisma } from "../db";
import { audit } from "../lib/audit";
import { badRequest, conflict, notFound, param, parse } from "../lib/http";
import { kickOutbox } from "../lib/outbox";
import { authenticate, requireModule, requireOutlet, requirePermission } from "../middleware/auth";
import {
  adapterFor,
  buildChannelMenu,
  encrypt,
  failedPushes,
  handleHubWebhook,
  presentConnection,
  queueChannelStatus,
  retryFailedPushes,
  setStoreOpen,
  syncMenu,
} from "../services/channels/service";

/**
 * Phase 6.1 — Settings → Channels (module CHANNELS, permission channel:manage):
 * the outlet's hub connection, store open/closed, menu sync, item mapping, channel orders.
 */
export const channelsRouter = Router();
channelsRouter.use(authenticate, requireOutlet, requireModule("CHANNELS"), requirePermission("channel:manage"));

const PROVIDER = "HUB";
const getConn = (outletId: string) => prisma.channelConnection.findUnique({ where: { outletId_provider: { outletId, provider: PROVIDER } } });
async function mustConn(outletId: string) {
  const conn = await getConn(outletId);
  if (!conn) throw notFound("Channel connection");
  return conn;
}

channelsRouter.get("/connection", async (req, res) => {
  const conn = await getConn(req.outletId!);
  if (!conn) return res.json({ connection: null, failed: [] });
  res.json({ connection: presentConnection(conn), failed: await failedPushes(req.businessId!, conn.id) });
});

channelsRouter.put("/connection", async (req, res) => {
  const input = parse(channelConnectionSchema, req.body);
  const existing = await getConn(req.outletId!);
  if (!existing && (!input.apiKey || !input.webhookSecret)) throw badRequest("Enter the hub's API key and webhook secret");
  const data = {
    enabled: input.enabled,
    baseUrl: input.baseUrl,
    externalStoreId: input.externalStoreId,
    commission: input.commission,
    ...(input.apiKey && { apiKeyEnc: encrypt(input.apiKey) }),
    ...(input.webhookSecret && { webhookSecretEnc: encrypt(input.webhookSecret) }),
  };
  const conn = existing
    ? await prisma.channelConnection.update({ where: { id: existing.id }, data })
    : await prisma.channelConnection.create({ data: { ...data, outletId: req.outletId!, provider: PROVIDER } });
  await audit(req, existing ? "channel.update" : "channel.create", "ChannelConnection", conn.id, {
    enabled: input.enabled,
    baseUrl: input.baseUrl,
    apiKeyChanged: Boolean(input.apiKey),
    webhookSecretChanged: Boolean(input.webhookSecret),
  });
  res.json({ connection: presentConnection(conn) });
});

/** Check the hub answers with these credentials. */
channelsRouter.post("/connection/test", async (req, res) => {
  const conn = await mustConn(req.outletId!);
  try {
    await adapterFor(conn).ping();
  } catch (e) {
    return res.json({ ok: false, error: (e as Error).message });
  }
  res.json({ ok: true });
});

channelsRouter.post("/connection/store", async (req, res) => {
  const { open } = parse(z.object({ open: z.boolean() }), req.body);
  const conn = await mustConn(req.outletId!);
  if (open && !conn.enabled) throw conflict("Switch the connection on first");
  const updated = await setStoreOpen(conn, open);
  await audit(req, open ? "channel.store_open" : "channel.store_close", "ChannelConnection", conn.id);
  res.json({ connection: presentConnection(updated) });
});

channelsRouter.post("/connection/menu-sync", async (req, res) => {
  const conn = await mustConn(req.outletId!);
  const result = await syncMenu(conn);
  await audit(req, "channel.menu_sync", "ChannelConnection", conn.id, result);
  res.json({ ok: true, ...result });
});

/** Put status updates that gave up back in the queue. */
channelsRouter.post("/connection/retry-failed", async (req, res) => {
  const conn = await mustConn(req.outletId!);
  const count = await retryFailedPushes(req.businessId!, conn.id);
  kickOutbox();
  res.json({ retried: count });
});

/** Menu items with the id each is published under and whether channels see it as available. */
channelsRouter.get("/items", async (req, res) => {
  const [menu, maps, items] = await Promise.all([
    buildChannelMenu(req.outletId!),
    prisma.channelItemMap.findMany({ where: { outletId: req.outletId! } }),
    prisma.menuItem.findMany({ select: { id: true, name: true, category: { select: { name: true } } }, orderBy: { name: "asc" } }),
  ]);
  const custom = new Map(maps.map((m) => [m.menuItemId, m.externalId]));
  const published = new Map(menu.map((m) => [m.externalId, m]));
  res.json(
    items.map((i) => {
      const externalId = custom.get(i.id) ?? i.id;
      const m = published.get(externalId);
      return { menuItemId: i.id, name: i.name, category: i.category.name, externalId, custom: custom.has(i.id), published: Boolean(m), available: m?.available ?? false, price: m?.price ?? null };
    }),
  );
});

/** Set (or clear, with externalId null) the id a channel uses for a menu item. */
channelsRouter.put("/items/:menuItemId", async (req, res) => {
  const { externalId } = parse(z.object({ externalId: z.string().trim().min(1).max(100).nullable() }), req.body);
  const menuItemId = param(req, "menuItemId");
  if (!(await prisma.menuItem.findUnique({ where: { id: menuItemId }, select: { id: true } }))) throw notFound("Menu item");
  const key = { outletId_menuItemId: { outletId: req.outletId!, menuItemId } };
  if (externalId === null || externalId === menuItemId) {
    await prisma.channelItemMap.deleteMany({ where: { outletId: req.outletId!, menuItemId } });
  } else {
    const taken = await prisma.channelItemMap.findUnique({ where: { outletId_externalId: { outletId: req.outletId!, externalId } } });
    if (taken && taken.menuItemId !== menuItemId) throw conflict(`"${externalId}" is already used for another item`);
    await prisma.channelItemMap.upsert({ where: key, create: { outletId: req.outletId!, menuItemId, externalId }, update: { externalId } });
  }
  await audit(req, "channel.item_map", "MenuItem", menuItemId, { externalId });
  res.json({ menuItemId, externalId: externalId ?? menuItemId });
});

/** Recent channel orders (accepted, rejected, cancelled) with our bill's status. */
channelsRouter.get("/orders", async (req, res) => {
  const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
  const rows = await prisma.channelOrder.findMany({ where: { outletId: req.outletId! }, orderBy: { createdAt: "desc" }, take: limit, omit: { payload: true } });
  const ids = rows.map((r) => r.orderId).filter((x): x is string => Boolean(x));
  const orders = new Map(
    (await prisma.order.findMany({ where: { id: { in: ids }, outletId: req.outletId! }, select: { id: true, invoiceNumber: true, status: true, grandTotal: true } })).map((o) => [o.id, o]),
  );
  res.json(rows.map((r) => ({ ...r, order: r.orderId ? (orders.get(r.orderId) ?? null) : null })));
});

/** Staff tell the channel by hand, e.g. "handed to the rider" (DISPATCHED). */
channelsRouter.post("/orders/:orderId/status", async (req, res) => {
  const { status, reason } = parse(z.object({ status: z.enum(CHANNEL_PUSH_STATUSES).exclude(["CANCELLED"]), reason: z.string().max(200).optional() }), req.body);
  const order = await prisma.order.findFirst({ where: { id: param(req, "orderId"), outletId: req.outletId! }, select: { id: true, status: true } });
  if (!order) throw notFound("Order");
  if (order.status === "CANCELLED") throw conflict("Order was cancelled");
  const queued = await prisma.$transaction((tx) => queueChannelStatus(tx, order.id, status, reason));
  if (!queued) throw badRequest("This order didn't come from a channel");
  kickOutbox();
  await audit(req, "channel.status", "Order", order.id, { status });
  res.json({ queued: true });
});

/**
 * Hub webhooks (public, signature-checked per connection). Mounted before the JSON body
 * parser: the signature is over the raw body.
 */
export const channelWebhooksRouter = Router();
channelWebhooksRouter.post("/channels/hub/:connectionId/webhook", express.raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const result = await handleHubWebhook(param(req, "connectionId"), raw, req.headers, req.ip);
  res.status(result.status).json(result.body);
});
