import crypto from "node:crypto";
import type { Request } from "express";
import type { ChannelRequest, Outlet, Prisma } from "@prisma/client";
import {
  deliveryAreaAllowed,
  deliveryAreaRefusal,
  distanceMeters,
  PINCODE_RE,
  effectiveGstRate,
  formatINR,
  normalizeBrand,
  normalizeModules,
  storefrontSettingsSchema,
  type OnlineOrderInput,
  type QrOrderInput,
  type StorefrontSettings,
} from "@canavo/shared";
import { platformPrisma, prisma } from "../db";
import { conflict, badRequest, notFound, HttpError } from "../lib/http";
import { kickOutbox, outboxEmitOutlet, outboxTask } from "../lib/outbox";
import { hhmmToMinutes, zonedParts } from "../lib/time";
import { featureOn, moduleEnabled, runForOutlet } from "../lib/tenant";
import { emitToOutlet } from "../realtime";
import { currentSlotMenu } from "../routes/menu";
import { cancelOrderInTx } from "./order-cancel";
import { addItemsToSession, findOpenSession, openSession } from "../routes/tables";
import { getOrder } from "./billing";
import { createChannelOrder, systemRequest } from "./channel-orders";
import { notify, outletManagers, outletStaff } from "./notify";
import { createUpiQr, refundPayment, type GatewayRefund } from "./razorpay";
import { createCreditNote } from "./credit-notes";
import { onOrderCancelledService, selectZone } from "./service-context";
import { phoneTokenValid } from "./storefront-otp";
import { resolveItemTax } from "./tax";
import { lastKotNumberToday } from "./kot-number";
import { emitTheatre, fireSeatKots, readTheatreSettings } from "./theatre-kot";

/**
 * Phase 6.3 / 6.4 (CHANNELS): QR table ordering and the outlet's online ordering page.
 * Public endpoints have no login and no tenant: the outlet is found from an unguessable
 * table token or the outlet's public slug, and everything else runs inside runForOutlet.
 */

export const newPublicToken = () => crypto.randomBytes(18).toString("base64url");

export function readSettings(outlet: { storefront: Prisma.JsonValue }): StorefrontSettings {
  const raw = outlet.storefront && typeof outlet.storefront === "object" && !Array.isArray(outlet.storefront) ? outlet.storefront : {};
  const parsed = storefrontSettingsSchema.safeParse(raw);
  return parsed.success ? parsed.data : storefrontSettingsSchema.parse({});
}

const inWindow = (now: number, from: string, to: string) => {
  const f = hhmmToMinutes(from);
  const t = hhmmToMinutes(to);
  return f <= t ? now >= f && now < t : now >= f || now < t;
};

/** Inside the outlet's accepting hours (no hours set = always). */
export function acceptingNow(s: StorefrontSettings, timezone: string, at = new Date()) {
  if (!s.acceptFrom || !s.acceptTo) return true;
  return inWindow(zonedParts(at, timezone).minutes, s.acceptFrom, s.acceptTo);
}

/** The business's brand accent when CHANNELS is on (false = the business can't take public orders). */
async function channelsOn(businessId: string): Promise<false | { accent: string; theatre: boolean }> {
  const b = await platformPrisma.business.findUnique({ where: { id: businessId }, select: { status: true, modules: true, brand: true } });
  const modules = b ? normalizeModules(b.modules) : [];
  if (!(b && b.status === "ACTIVE" && modules.includes("CHANNELS"))) return false;
  return { accent: normalizeBrand(b.brand).accent, theatre: modules.includes("THEATRE") };
}

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;

/**
 * Table + outlet from a QR token. Unknown token, or a business without CHANNELS: not found.
 * A cinema seat (THEATRE) follows the theatre's own switch (seat ordering) instead of dine-in QR
 * ordering, and is not found when the business doesn't have THEATRE.
 */
export async function tableByToken(token: string) {
  if (!TOKEN_RE.test(token)) throw notFound("Table");
  const table = await platformPrisma.diningTable.findUnique({ where: { qrToken: token } });
  if (!table) throw notFound("Table");
  const outlet = await platformPrisma.outlet.findUniqueOrThrow({ where: { id: table.outletId } });
  const brand = await channelsOn(outlet.businessId);
  if (!brand) throw notFound("Table");
  const settings = readSettings(outlet);
  const seat = table.seatRow !== null;
  if (seat) {
    if (!brand.theatre || (!readTheatreSettings(outlet).seatOrdering && !settings.menuView)) throw notFound("Table");
  } else if (!settings.qrOrdering && !settings.menuView) throw notFound("Table");
  return { table, outlet, settings, accent: brand.accent, seat };
}

/** Outlet from its public slug; refuses when CHANNELS is off or the page is switched off entirely. */
export async function outletBySlug(slug: string) {
  if (!/^[a-z0-9-]{3,40}$/.test(slug)) throw notFound("Outlet");
  const outlet = await platformPrisma.outlet.findUnique({ where: { publicSlug: slug } });
  const brand = outlet ? await channelsOn(outlet.businessId) : false;
  if (!outlet || !brand) throw notFound("Outlet");
  const settings = readSettings(outlet);
  if (!settings.onlineOrdering && !settings.menuView) throw notFound("Outlet");
  return { outlet, settings, accent: brand.accent };
}

export const outletBrand = (o: Outlet, accent?: string) => ({
  name: o.name,
  /** Business brand colour (customer pages use it as their accent) */
  accent: accent ?? null,
  address: o.address,
  phone: o.phone,
  logoUrl: o.logoUrl,
  pricesIncludeTax: o.pricesIncludeTax,
  gstEnabled: o.gstEnabled && !o.compositionScheme,
  packagingCharge: o.packagingCharge,
});

// ---------------------------------------------------------------------------
// Digital menu
// ---------------------------------------------------------------------------

export interface PublicMenuItem {
  id: string;
  name: string;
  description: string;
  categoryId: string;
  foodType: string;
  imageUrl: string | null;
  price: number;
  gstRate: number;
  available: boolean;
  unavailableReason: string | null;
  variants: { id: string; name: string; price: number; available: boolean }[];
  addons: { id: string; name: string; price: number }[];
}

/**
 * The menu as a customer sees it (call inside the outlet's tenant context): hidden items and
 * items not served in the current meal slot are left out; out-of-stock (manual or automatic)
 * and outside-serving-hours items are listed but greyed out (`available: false`).
 */
export async function publicMenu(outletId: string, timezone: string) {
  const slotView = moduleEnabled("CANTEEN") ? await currentSlotMenu(outletId) : null;
  const [categories, rows] = await Promise.all([
    prisma.menuCategory.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true, parentId: true, sortOrder: true } }),
    prisma.menuItem.findMany({ include: { variants: true, addons: true, overrides: { where: { outletId } } }, orderBy: { name: "asc" } }),
  ]);
  const taxes = await resolveItemTax(rows);
  const autoStock = featureOn("AUTO_STOCK_OUT");
  const now = zonedParts(new Date(), timezone).minutes;
  const items: PublicMenuItem[] = [];
  for (const item of rows) {
    const ov = item.overrides[0];
    const status = ov?.status ?? item.status;
    if (status === "HIDDEN") continue;
    if (slotView && slotView.onSomeSlot.has(item.id) && !slotView.prices.has(item.id)) continue;
    let reason: string | null = null;
    if (status === "OUT_OF_STOCK" || (autoStock && ov?.stockOut)) reason = "Out of stock";
    else if (item.availableFrom && item.availableTo && !inWindow(now, item.availableFrom, item.availableTo)) {
      reason = `Served ${item.availableFrom}–${item.availableTo}`;
    }
    const stockOutVariants = autoStock ? (ov?.stockOutVariantIds ?? []) : [];
    items.push({
      id: item.id,
      name: item.name,
      description: item.description,
      categoryId: item.categoryId,
      foodType: item.foodType,
      imageUrl: item.imageUrl,
      price: slotView?.prices.get(item.id) ?? ov?.price ?? item.price,
      gstRate: effectiveGstRate(taxes.get(item.id)!),
      available: !reason,
      unavailableReason: reason,
      variants: item.variants.map((v) => ({ id: v.id, name: v.name, price: v.price, available: !stockOutVariants.includes(v.id) })),
      addons: item.addons.map((a) => ({ id: a.id, name: a.name, price: a.price })),
    });
  }
  const used = new Set(items.map((i) => i.categoryId));
  for (const c of categories) if (used.has(c.id) && c.parentId) used.add(c.parentId);
  return { categories: categories.filter((c) => used.has(c.id)), items };
}

/**
 * "Bestseller" badges on the customer menu: the outlet's most-sold items over the last 30 days
 * (paid orders; at least 5 sold). Call inside the tenant context.
 */
export async function bestsellerIds(outletId: string, limit = 6): Promise<string[]> {
  // QA Phase 13 perf-3: a 30-day sum over every paid line ran on each customer page view (~140 ms on a busy
  // outlet, the slowest part of the online menu). A ranking that moves slowly: cached per outlet for 10 minutes.
  const key = `${outletId}|${limit}`;
  const hit = bestsellerCache.get(key);
  if (hit && hit.until > Date.now()) return hit.ids;
  const ids = await computeBestsellers(outletId, limit);
  if (process.env.NODE_ENV !== "test") {
    if (bestsellerCache.size > 5000) bestsellerCache.clear();
    bestsellerCache.set(key, { ids, until: Date.now() + 10 * 60_000 });
  }
  return ids;
}
const bestsellerCache = new Map<string, { ids: string[]; until: number }>();

async function computeBestsellers(outletId: string, limit: number): Promise<string[]> {
  const rows = await prisma.orderItem.groupBy({
    by: ["menuItemId"],
    where: { order: { outletId, status: "PAID", createdAt: { gte: new Date(Date.now() - 30 * 86_400_000) } } },
    _sum: { quantity: true },
    orderBy: { _sum: { quantity: "desc" } },
    take: limit,
  });
  return rows.filter((r) => (r._sum.quantity ?? 0) >= 5).map((r) => r.menuItemId);
}

export interface CartLine {
  menuItemId: string;
  variantId?: string;
  addonIds: string[];
  quantity: number;
  notes?: string;
  name: string;
  unitPrice: number;
}

/** Check a public cart against the live menu; prices come from the menu, never the client. */
export function checkCart(menu: { items: PublicMenuItem[] }, items: QrOrderInput["items"]): CartLine[] {
  const byId = new Map(menu.items.map((i) => [i.id, i]));
  return items.map((line) => {
    const item = byId.get(line.menuItemId);
    if (!item) throw badRequest("An item in your cart is no longer on the menu");
    if (!item.available) throw badRequest(`${item.name}: ${(item.unavailableReason ?? "not available").toLowerCase()}`);
    const variant = line.variantId ? item.variants.find((v) => v.id === line.variantId) : undefined;
    if (line.variantId && !variant) throw badRequest(`Choose a size for ${item.name} again`);
    if (variant && !variant.available) throw badRequest(`${item.name} (${variant.name}) is out of stock`);
    const addons = [...new Set(line.addonIds)].map((id) => {
      const a = item.addons.find((x) => x.id === id);
      if (!a) throw badRequest(`Choose the add-ons for ${item.name} again`);
      return a;
    });
    return {
      menuItemId: item.id,
      variantId: variant?.id,
      addonIds: addons.map((a) => a.id),
      quantity: line.quantity,
      notes: line.notes || undefined,
      name: [item.name, variant && `(${variant.name})`, addons.length ? `+ ${addons.map((a) => a.name).join(", ")}` : null].filter(Boolean).join(" "),
      unitPrice: (variant?.price ?? item.price) + addons.reduce((s, a) => s + a.price, 0),
    };
  });
}

const cartTotal = (lines: CartLine[]) => lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
const asLines = (json: Prisma.JsonValue) => json as unknown as CartLine[];

// ---------------------------------------------------------------------------
// Staff alerts
// ---------------------------------------------------------------------------

async function tableStaff(outletId: string, waiterId: string | null) {
  const waiters = waiterId ? [waiterId] : await outletStaff(outletId, ["WAITER"]);
  return [...waiters, ...(await outletStaff(outletId, ["CASHIER"]))];
}

async function alertNewRequest(outletId: string, request: ChannelRequest, where: string, waiterId: string | null) {
  try {
    const lines = asLines(request.items);
    const count = lines.reduce((n, l) => n + l.quantity, 0);
    const to = request.channel === "QR" ? await tableStaff(outletId, waiterId) : [...(await outletStaff(outletId, ["CASHIER"])), ...(await outletManagers(outletId))];
    await notify(
      to,
      `New ${request.channel === "QR" ? "QR" : "online"} order · ${where}`,
      `${count} item${count === 1 ? "" : "s"} · ${formatINR(request.total)} — accept or reject it on the ${request.channel === "QR" ? "Tables" : "POS"} screen`,
      "channel.order",
      { outletId, link: request.channel === "QR" ? "/tables" : "/pos" },
    );
  } catch (e) {
    console.warn("[storefront] new-order alert failed (ignored):", (e as Error).message);
  }
}

const emitRequest = (outletId: string, id: string, action: string) => emitToOutlet(outletId, "channel:request", { id, action });

// ---------------------------------------------------------------------------
// QR table ordering (6.3)
// ---------------------------------------------------------------------------

export async function placeQrOrder(token: string, input: QrOrderInput, ip?: string) {
  const { table, outlet, settings, seat } = await tableByToken(token);
  if (seat) throw badRequest("Seat orders need a delivery time"); // routed to placeSeatOrder
  return runForOutlet(outlet.id, async () => {
    if (!settings.qrOrdering) throw conflict("This table doesn't take orders from the QR code — please ask a waiter");
    if (!table.active) throw conflict("This table isn't in use right now — please ask a waiter");
    if (!acceptingNow(settings, outlet.timezone)) throw conflict("We're not taking orders right now");
    const lines = checkCart(await publicMenu(outlet.id, outlet.timezone), input.items);
    if (input.notes) lines[0] = { ...lines[0], notes: [lines[0].notes, `Note: ${input.notes}`].filter(Boolean).join(" · ").slice(0, 200) };
    const session = await findOpenSession(outlet.id, table.id);
    const request = await prisma.channelRequest.create({
      data: {
        outletId: outlet.id,
        channel: "QR",
        tableId: table.id,
        sessionId: session?.id,
        items: lines as unknown as Prisma.InputJsonValue,
        customerName: input.customerName || undefined,
        customerPhone: input.customerPhone,
        notes: input.notes,
        total: cartTotal(lines),
        publicToken: newPublicToken(),
        ip,
      },
    });
    if (!settings.qrNeedsConfirmation) {
      try {
        return await acceptRequest(await systemRequest(outlet.id, outlet.businessId, ip), request);
      } catch (e) {
        // Straight-to-kitchen failed: the guest sees the error, so leave no stray request behind.
        await prisma.channelRequest.delete({ where: { id: request.id } }).catch(() => undefined);
        throw e;
      }
    }
    emitRequest(outlet.id, request.id, "new");
    void alertNewRequest(outlet.id, request, `Table ${table.label}`, table.waiterId);
    return request;
  });
}

const STAGE_BY_KOT: Record<string, number> = { RECEIVED: 0, PREPARING: 1, READY: 2, SERVED: 3 };

/** Customer-facing stage from a request and its KOTs. */
function stageOf(status: string, kots: { status: string }[], cancelled = false) {
  if (status === "REJECTED" || cancelled) return "cancelled";
  if (status === "PENDING") return "waiting";
  if (!kots.length) return "confirmed";
  const min = Math.min(...kots.map((k) => STAGE_BY_KOT[k.status] ?? 0));
  const max = Math.max(...kots.map((k) => STAGE_BY_KOT[k.status] ?? 0));
  if (min >= 3) return "served";
  if (min >= 2) return "ready";
  if (max >= 1) return "preparing";
  return "received";
}

/** The table's QR orders of the current visit (open tab, or the last few hours if none). */
export async function tableOrders(token: string) {
  const { table, outlet } = await tableByToken(token);
  return runForOutlet(outlet.id, async () => {
    const session = await findOpenSession(outlet.id, table.id);
    const requests = await prisma.channelRequest.findMany({
      where: {
        tableId: table.id,
        createdAt: { gte: new Date(Date.now() - 4 * 3600_000) },
        OR: [{ sessionId: null }, ...(session ? [{ sessionId: session.id }] : [])],
      },
      orderBy: { createdAt: "desc" },
      take: 20,
    });
    const kots = await prisma.kotTicket.findMany({ where: { id: { in: requests.flatMap((r) => r.kotIds) } }, select: { id: true, status: true } });
    const kotById = new Map(kots.map((k) => [k.id, k]));
    return requests.map((r) => ({
        id: r.id,
        createdAt: r.createdAt,
        stage: stageOf(r.status, r.kotIds.map((id) => kotById.get(id)).filter((k): k is NonNullable<typeof k> => Boolean(k))),
        rejectReason: r.rejectReason,
        total: r.total,
      items: asLines(r.items).map((l) => ({ name: l.name, quantity: l.quantity })),
    }));
  });
}

/** "Call waiter" / "Ask for bill" from the table's QR page. */
export async function callFromTable(token: string, kind: "WAITER" | "BILL") {
  const { table, outlet } = await tableByToken(token);
  if (!table.active) throw conflict("This table isn't in use right now");
  await runForOutlet(outlet.id, async () => {
    const to = await tableStaff(outlet.id, table.waiterId);
    const recipients = to.length ? to : await outletManagers(outlet.id);
    await notify(
      recipients,
      kind === "WAITER" ? `Table ${table.label}: guest is calling` : `Table ${table.label}: bill please`,
      kind === "WAITER" ? "A guest asked for a waiter from the table QR code" : "A guest asked for the bill from the table QR code",
      kind === "WAITER" ? "table.call" : "table.bill",
      { outletId: outlet.id, link: "/tables" },
    );
  });
}

// ---------------------------------------------------------------------------
// Accept / reject (staff, or automatically when confirmation is off)
// ---------------------------------------------------------------------------

/**
 * Accept a pending request. QR: its items go onto the table's running tab (a tab is opened
 * when there is none) and KOTs fire. Online: the bill's KOTs fire.
 */
export async function acceptRequest(req: Request, request: ChannelRequest) {
  const outletId = request.outletId;
  const claimed = await prisma.channelRequest.updateMany({
    where: { id: request.id, status: "PENDING" },
    data: { status: "ACCEPTED", decidedById: req.user?.id, decidedAt: new Date() },
  });
  if (!claimed.count) throw conflict("Someone already handled this order");
  try {
    if (request.seatTiming) {
      // THEATRE: the bill exists since the guest ordered (UPI up front); the kitchen gets it once paid.
      await prisma.$transaction(async (tx) => {
        await fireSeatKots(tx, request.id);
        await emitTheatre(tx, outletId, { requestId: request.id, action: "accepted" });
      });
      kickOutbox();
      emitRequest(outletId, request.id, "accepted");
      return prisma.channelRequest.findUniqueOrThrow({ where: { id: request.id } });
    }
    let data: Prisma.ChannelRequestUpdateInput;
    if (request.channel === "QR") {
      if (!request.tableId) throw badRequest("QR order without a table");
      let session = await findOpenSession(outletId, request.tableId);
      if (!session) {
        try {
          session = await openSession(req, request.tableId, { guests: 1, customerName: request.customerName ?? undefined, customerPhone: request.customerPhone ?? undefined });
        } catch (e) {
          // Opened by someone else a moment ago.
          session = await findOpenSession(outletId, request.tableId);
          if (!session) throw e;
        }
      }
      const kots = await addItemsToSession(
        req,
        session,
        asLines(request.items).map((l) => ({ menuItemId: l.menuItemId, variantId: l.variantId, addonIds: l.addonIds, quantity: l.quantity, notes: l.notes })),
      );
      data = { sessionId: session.id, kotIds: kots.map((k) => k.id) };
    } else {
      if (!request.orderId) throw badRequest("Online order without a bill");
      const kots = await fireOrderKots(outletId, request.orderId);
      data = { kotIds: kots.map((k) => k.id) };
    }
    const updated = await prisma.channelRequest.update({ where: { id: request.id }, data });
    emitRequest(outletId, request.id, "accepted");
    return updated;
  } catch (e) {
    await prisma.channelRequest.update({ where: { id: request.id }, data: { status: "PENDING", decidedById: null, decidedAt: null } });
    throw e;
  }
}

/** Reject a pending request. An online order's bill is cancelled with the reason. */
export async function rejectRequest(req: Request, request: ChannelRequest, reason: string) {
  const claimed = await prisma.channelRequest.updateMany({
    where: { id: request.id, status: "PENDING" },
    data: { status: "REJECTED", rejectReason: reason, decidedById: req.user?.id, decidedAt: new Date() },
  });
  if (!claimed.count) throw conflict("Someone already handled this order");
  if (request.orderId) await withdrawOnlineOrder(req, request, `${request.seatTiming ? "Seat order" : "Online order"} rejected: ${reason}`);
  emitRequest(request.outletId, request.id, "rejected");
  if (request.seatTiming) {
    await prisma.$transaction((tx) => emitTheatre(tx, request.outletId, { requestId: request.id, action: "rejected" }));
    kickOutbox();
  }
  return prisma.channelRequest.findUniqueOrThrow({ where: { id: request.id } });
}

/**
 * Cancel an accepted online order before the kitchen started on it (every KOT still "received",
 * delivery not picked up). Same money handling as a rejection: a Razorpay UPI payment is refunded.
 */
export async function cancelAcceptedOnline(req: Request, request: ChannelRequest, reason: string) {
  if (request.channel !== "ONLINE" || !request.orderId) throw badRequest("Only online orders can be cancelled here");
  if (request.status !== "ACCEPTED") throw conflict(request.status === "PENDING" ? "Reject the order instead" : "This order was already cancelled");
  const order = await getOrder(request.orderId, request.outletId);
  if (order.kots.some((k) => k.status !== "RECEIVED")) throw conflict("The kitchen has started on this order — it can't be cancelled here");
  if (order.delivery && ["OUT_FOR_DELIVERY", "DELIVERED"].includes(order.delivery.status)) throw conflict("The order is already out for delivery");
  if (order.status === "CANCELLED") throw conflict("This bill is already cancelled");
  const claimed = await prisma.channelRequest.updateMany({
    where: { id: request.id, status: "ACCEPTED" },
    data: { status: "REJECTED", rejectReason: reason, decidedById: req.user?.id, decidedAt: new Date() },
  });
  if (!claimed.count) throw conflict("Someone already handled this order");
  await withdrawOnlineOrder(req, request, `Online order cancelled: ${reason}`);
  emitRequest(request.outletId, request.id, "rejected");
  return prisma.channelRequest.findUniqueOrThrow({ where: { id: request.id } });
}

/**
 * Take back an online order the outlet won't make (already claimed as REJECTED by the caller).
 * - Not paid through Razorpay: the bill is voided as before (staff void flow unchanged).
 * - Paid in full (the usual UPI-prepaid case): a GST invoice was issued, so the bill stays as
 *   issued and a full credit note (refund mode UPI, items restocked) reverses it; its delivery
 *   is cancelled and any kitchen tickets not yet started are withdrawn.
 * - Partly paid by UPI: the bill is voided (no invoice yet), the UPI part refunded.
 * Then every successful Razorpay UPI payment on the bill is refunded through the gateway, and the
 * outcome recorded on the request. Without keys (dev) or when Razorpay refuses, the refund is
 * marked MANUAL / FAILED and the outlet's managers are told to do it in the Razorpay dashboard.
 */
async function withdrawOnlineOrder(req: Request, request: ChannelRequest, reason: string) {
  const outletId = request.outletId;
  const order = await getOrder(request.orderId!, outletId);
  const upi = order.payments.filter((p) => p.mode === "UPI" && p.status === "SUCCESS" && p.gatewayRef);
  const upiTotal = upi.reduce((s, p) => s + p.amount, 0);
  let creditNoteId: string | null = null;

  if (upiTotal > 0 && order.status === "PAID") {
    const remaining = order.grandTotal - order.refundedAmount;
    const amount = Math.min(upiTotal, remaining);
    const note = await createCreditNote(
      req,
      order.id,
      amount >= remaining
        ? { reason: "OTHER", note: reason.slice(0, 300), refundMode: "UPI", items: order.items.map((i) => ({ orderItemId: i.id, quantity: i.quantity })), restock: true }
        : { reason: "OTHER", note: reason.slice(0, 300), refundMode: "UPI", amount, restock: false },
      { systemRefund: true },
    );
    creditNoteId = note.id;
    await prisma.$transaction(async (tx) => {
      await onOrderCancelledService(tx, order.id);
      // Nothing was cooked: take the tickets off the kitchen screen.
      await tx.kotTicket.deleteMany({ where: { orderId: order.id, status: "RECEIVED" } });
    });
    emitToOutlet(outletId, "order:cancelled", { id: order.id });
    emitToOutlet(outletId, "order:refunded", { id: order.id, creditNote: note.number });
  } else if (order.status !== "CANCELLED") {
    await prisma.$transaction((tx) => cancelOrderInTx(tx, req, order, reason));
    emitToOutlet(outletId, "order:cancelled", { id: order.id });
  }
  if (upiTotal <= 0) return;

  let left = creditNoteId ? Math.min(upiTotal, order.grandTotal - order.refundedAmount) : upiTotal;
  const results: (GatewayRefund & { amount: number })[] = [];
  for (const p of upi) {
    const amount = Math.min(p.amount, left);
    if (amount <= 0) break;
    left -= amount;
    results.push({ ...(await refundPayment(p.reference, amount, { orderId: order.id, invoiceNumber: order.invoiceNumber })), amount });
  }
  const worst = (["FAILED", "MANUAL", "PENDING", "PROCESSED"] as const).find((st) => results.some((r) => r.status === st)) ?? "MANUAL";
  const refundAmount = results.reduce((s, r) => s + r.amount, 0);
  await prisma.channelRequest.update({
    where: { id: request.id },
    data: {
      refundStatus: worst,
      refundRef: results.map((r) => r.id).filter(Boolean).join(",") || null,
      refundAmount,
      creditNoteId,
      refundError: results.map((r) => r.error).filter(Boolean).join("; ").slice(0, 500) || null,
    },
  });
  if (worst === "MANUAL" || worst === "FAILED") {
    try {
      await notify(
        await outletManagers(outletId),
        `Refund ${formatINR(refundAmount)} by hand · ${order.invoiceNumber}`,
        `The online order was ${reason.startsWith("Online order cancelled") ? "cancelled" : "rejected"} after the customer paid by UPI. ${
          worst === "MANUAL" ? "Refund pending — do it in the Razorpay dashboard." : "Razorpay didn't take the refund — do it in the Razorpay dashboard."
        }`,
        "channel.refund",
        { outletId, link: "/pos" },
      );
    } catch (e) {
      console.warn("[storefront] refund alert failed (ignored):", (e as Error).message);
    }
  }
}

/** Fire one KOT per kitchen station for a bill created without KOTs (online order accepted). */
export async function fireOrderKots(outletId: string, orderId: string) {
  if (!moduleEnabled("KOT")) return [];
  const order = await prisma.order.findFirstOrThrow({ where: { id: orderId, outletId }, include: { items: true } });
  if (await prisma.kotTicket.count({ where: { orderId } })) return prisma.kotTicket.findMany({ where: { orderId } });
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: outletId }, select: { timezone: true } });
  const stations = new Map(
    (await prisma.menuItem.findMany({ where: { id: { in: order.items.map((i) => i.menuItemId) } }, select: { id: true, kitchenStation: true } })).map((m) => [m.id, m.kitchenStation]),
  );
  const byStation = new Map<string, typeof order.items>();
  for (const i of order.items) {
    const st = stations.get(i.menuItemId) ?? "MAIN";
    byStation.set(st, [...(byStation.get(st) ?? []), i]);
  }
  const kots = await prisma.$transaction(async (tx) => {
    let kotNumber = await lastKotNumberToday(tx, outletId, outlet.timezone);
    const created = [];
    for (const [station, items] of byStation) {
      created.push(
        await tx.kotTicket.create({
          data: {
            orderId,
            outletId,
            station,
            kotNumber: ++kotNumber,
            items: items.map((i) => ({ name: i.name, quantity: i.quantity, addons: ((i.addons as { name: string }[] | null) ?? []).map((a) => a.name), notes: i.notes ?? null })),
          },
        }),
      );
    }
    const summary = { id: order.id, invoiceNumber: order.invoiceNumber, orderType: order.orderType, tableLabel: order.tableLabel, notes: order.notes, status: order.status };
    await outboxEmitOutlet(tx, outletId, "kot:new", created.map((k) => ({ ...k, order: summary })));
    const where = order.orderType === "DELIVERY" ? "Delivery" : "Takeaway";
    await outboxTask(tx, "kitchen.alert", { outletId, kotIds: created.map((k) => k.id), label: `Online ${where} · ${order.invoiceNumber}` });
    return created;
  });
  kickOutbox();
  return kots;
}

// ---------------------------------------------------------------------------
// Online ordering page (6.4)
// ---------------------------------------------------------------------------

const PAYMENT_LABEL = { COUNTER: "Pay at counter", COD: "Cash on delivery", UPI: "UPI prepaid" } as const;

export function deliveryAvailable(outlet: Outlet, settings: StorefrontSettings) {
  return settings.delivery && outlet.deliveryEnabled && moduleEnabled("DELIVERY");
}

export async function placeOnlineOrder(slug: string, input: OnlineOrderInput, ip?: string) {
  const { outlet, settings } = await outletBySlug(slug);
  return runForOutlet(outlet.id, async () => {
    if (!settings.onlineOrdering) throw conflict("Online ordering is switched off right now");
    if (!acceptingNow(settings, outlet.timezone)) throw conflict("We're not taking orders right now");
    const delivery = input.orderType === "DELIVERY";
    if (delivery && !deliveryAvailable(outlet, settings)) throw badRequest("Delivery isn't available — choose takeaway");
    if (!delivery && !settings.takeaway) throw badRequest("Takeaway isn't available — choose delivery");
    if (delivery && !input.delivery) throw badRequest("Enter your delivery address");
    if (settings.verifyPhoneOtp && !phoneTokenValid(input.phoneToken, outlet.id, input.customerPhone)) {
      throw new HttpError(403, "Verify your mobile number with the OTP first", { code: "PHONE_NOT_VERIFIED" });
    }
    let deliveryInput = input.delivery;
    const addressOnly = outlet.deliveryAddressMode === "ADDRESS";
    if (delivery && deliveryInput && addressOnly) {
      // No map: typed address + PIN code; the chosen area joins the address the rider reads.
      const { area, ...rest } = deliveryInput;
      if (!rest.pincode) throw badRequest("Enter the 6-digit PIN code of your delivery address");
      if (!deliveryAreaAllowed(outlet.deliveryAreas, { pincode: rest.pincode, area, address: rest.address })) throw badRequest(deliveryAreaRefusal(outlet.deliveryAreas, rest.pincode));
      const address = area && !rest.address.toLowerCase().includes(area.toLowerCase()) ? `${rest.address}, ${area}`.slice(0, 500) : rest.address;
      deliveryInput = { ...rest, address, zoneId: undefined, latitude: undefined, longitude: undefined };
    } else if (delivery && deliveryInput) {
      const { area: _area, ...rest } = deliveryInput;
      deliveryInput = rest;
    }
    if (delivery && deliveryInput && !addressOnly && deliveryInput.latitude !== undefined && deliveryInput.longitude !== undefined) {
      // A map pin: the server picks the zone from the distance (the client's zone choice is ignored).
      const quote = await deliveryQuote(outlet, deliveryInput.latitude, deliveryInput.longitude);
      if (quote.outletLocation) {
        if (!quote.zone) throw badRequest(quote.message!);
        deliveryInput = { ...deliveryInput, zoneId: quote.zone.id };
      } else {
        // Outlet location not set: fall back to the area the customer chose.
        if (!deliveryInput.zoneId && quote.zones > 0) throw badRequest("Choose your area");
        deliveryInput = { ...deliveryInput, latitude: undefined, longitude: undefined };
      }
    }
    const payOk =
      (input.payment === "COUNTER" && !delivery && settings.payAtCounter) ||
      (input.payment === "COD" && delivery && settings.cashOnDelivery) ||
      (input.payment === "UPI" && settings.upiPrepaid);
    if (!payOk) throw badRequest("Choose another way to pay");

    const lines = checkCart(await publicMenu(outlet.id, outlet.timezone), input.items);
    if (cartTotal(lines) < settings.minOrder) throw badRequest(`Minimum order is ${formatINR(settings.minOrder)}`);
    if (delivery && addressOnly && cartTotal(lines) < outlet.deliveryMinOrder) throw badRequest(`Minimum order for delivery is ${formatINR(outlet.deliveryMinOrder)}`);

    let timeNote = "ASAP";
    if (input.pickupAt) {
      const at = new Date(input.pickupAt);
      if (at.getTime() < Date.now() - 60_000 || at.getTime() > Date.now() + 24 * 3600_000) throw badRequest("Choose a time within the next 24 hours");
      const p = zonedParts(at, outlet.timezone);
      timeNote = `${delivery ? "Deliver" : "Pickup"} at ${String(Math.floor(p.minutes / 60)).padStart(2, "0")}:${String(p.minutes % 60).padStart(2, "0")}`;
    }
    const publicToken = newPublicToken();
    const { order } = await createChannelOrder(
      outlet.id,
      "ONLINE",
      {
        orderType: input.orderType,
        customerName: input.customerName,
        customerPhone: input.customerPhone,
        interState: false,
        couponCode: input.couponCode || undefined,
        items: lines.map((l) => ({ menuItemId: l.menuItemId, variantId: l.variantId, addonIds: l.addonIds, quantity: l.quantity, notes: l.notes })),
        notes: ["Online", timeNote, PAYMENT_LABEL[input.payment], input.notes].filter(Boolean).join(" · ").slice(0, 300),
        delivery: delivery ? { ...deliveryInput!, source: "IN_APP", cod: input.payment === "COD" } : undefined,
      },
      { ip, channelOrderId: publicToken, skipKot: settings.onlineNeedsConfirmation },
    );
    const pending = settings.onlineNeedsConfirmation;
    const request = await prisma.channelRequest.create({
      data: {
        outletId: outlet.id,
        channel: "ONLINE",
        status: pending ? "PENDING" : "ACCEPTED",
        decidedAt: pending ? undefined : new Date(),
        orderId: order.id,
        items: lines as unknown as Prisma.InputJsonValue,
        kotIds: pending ? [] : (await prisma.kotTicket.findMany({ where: { orderId: order.id }, select: { id: true } })).map((k) => k.id),
        customerName: input.customerName,
        customerPhone: input.customerPhone,
        notes: input.notes,
        total: order.grandTotal,
        publicToken,
        payment: input.payment,
        ip,
      },
    });
    if (input.payment === "UPI") await requestUpi(outlet, order.id);
    emitRequest(outlet.id, request.id, pending ? "new" : "accepted");
    if (pending) void alertNewRequest(outlet.id, request, `${delivery ? "Delivery" : "Takeaway"} ${order.invoiceNumber}`, null);
    return { token: publicToken };
  });
}

/**
 * Delivery zone and fee for a map pin (inside the tenant context): the smallest active zone
 * whose radius covers the distance from the outlet. `outletLocation: false` = the outlet's
 * position isn't set, so the customer has to choose an area instead.
 */
export async function deliveryQuote(outlet: Outlet, lat: number, lng: number) {
  const zones = await prisma.deliveryZone.findMany({ where: { outletId: outlet.id, active: true }, orderBy: { radiusKm: "asc" } });
  if (outlet.latitude == null || outlet.longitude == null) return { outletLocation: false as const, zones: zones.length, zone: null, distanceKm: null, message: "Choose your area" };
  const distanceKm = Math.round((distanceMeters({ latitude: outlet.latitude, longitude: outlet.longitude }, { latitude: lat, longitude: lng }) / 1000) * 100) / 100;
  const zone = selectZone(zones, distanceKm);
  const max = zones.length ? Math.max(...zones.map((z) => z.radiusKm)) : 0;
  return {
    outletLocation: true as const,
    zones: zones.length,
    distanceKm,
    zone: zone ? { id: zone.id, name: zone.name, fee: zone.fee, minOrder: zone.minOrder, etaMinutes: zone.etaMinutes } : null,
    message: zone ? null : zones.length ? `Sorry, we don't deliver there — that's ${distanceKm} km away and we deliver within ${max} km` : "Sorry, we don't deliver to this address",
  };
}

/** Address-only delivery quote: flat fee, minimum order, ETA and the allowed-area check for a PIN code / area. */
export function addressQuote(outlet: Outlet, to: { pincode?: string; area?: string; address?: string }) {
  const pinBad = to.pincode !== undefined && to.pincode !== "" && !PINCODE_RE.test(to.pincode);
  const checked = Boolean(to.pincode || to.area);
  const allowed = !pinBad && (!checked || deliveryAreaAllowed(outlet.deliveryAreas, to));
  return {
    mode: "ADDRESS" as const,
    outletLocation: false,
    deliverable: allowed,
    distanceKm: null,
    zone: null,
    fee: outlet.deliveryFlatFee,
    minOrder: outlet.deliveryMinOrder,
    etaMinutes: outlet.deliveryEtaMinutes,
    message: pinBad ? "Enter a 6-digit PIN code" : allowed ? null : deliveryAreaRefusal(outlet.deliveryAreas, to.pincode),
  };
}

/**
 * A fresh UPI QR for what's still due on an online / seat order (inside the tenant context): the
 * store's own Razorpay account, the platform's shared one, or a plain UPI intent (mock) to confirm by hand.
 */
export async function issueUpi(outlet: Outlet, orderId: string) {
  const order = await getOrder(orderId, outlet.id);
  if (order.status !== "OPEN") throw conflict(order.status === "PAID" ? "Already paid" : "This order was cancelled");
  const paid = order.payments.filter((p) => p.status === "SUCCESS").reduce((s, p) => s + p.amount, 0);
  const due = order.grandTotal - paid;
  if (due <= 0) throw conflict("Nothing to pay");
  await prisma.payment.updateMany({ where: { orderId, mode: "UPI", status: "PENDING" }, data: { status: "FAILED" } });
  const qr = await createUpiQr({ amount: due, orderId, invoiceNumber: order.invoiceNumber, payeeName: outlet.name, vpa: outlet.upiVpa });
  const payment = await prisma.payment.create({ data: { orderId, mode: "UPI", amount: due, status: "PENDING", gatewayRef: qr.gatewayRef, qrPayload: qr.qrPayload } });
  return { payment, qr };
}

export async function requestUpi(outlet: Outlet, orderId: string) {
  return (await issueUpi(outlet, orderId)).payment;
}

/** Online order by its public token (inside the tenant context). */
export async function findOnlineRequest(outletId: string, token: string) {
  if (!TOKEN_RE.test(token)) throw notFound("Order");
  const request = await prisma.channelRequest.findUnique({ where: { publicToken: token } });
  if (!request || request.outletId !== outletId || request.channel !== "ONLINE" || !request.orderId) throw notFound("Order");
  return request;
}

/** What the customer's confirmation page shows. */
export async function onlineOrderView(outlet: Outlet, request: ChannelRequest) {
  const order = await getOrder(request.orderId!, outlet.id);
  const paid = order.payments.filter((p) => p.status === "SUCCESS").reduce((s, p) => s + p.amount, 0);
  const upi = order.payments.filter((p) => p.mode === "UPI" && p.status === "PENDING").at(-1);
  return {
    invoiceNumber: order.invoiceNumber,
    createdAt: order.createdAt,
    orderType: order.orderType,
    stage: stageOf(request.status, order.kots, order.status === "CANCELLED"),
    rejectReason: request.rejectReason,
    payment: request.payment,
    status: order.status,
    customerName: order.customerName,
    items: order.items.map((i) => ({ name: i.name, quantity: i.quantity, total: i.total })),
    subtotal: order.subtotal,
    discount: order.discount + order.promoDiscount,
    tax: order.cgst + order.sgst + order.igst + order.cess + order.otherTaxes,
    charges: order.chargesBreakup,
    grandTotal: order.grandTotal,
    balance: Math.max(0, order.grandTotal - paid),
    upi: upi && order.status === "OPEN" ? { amount: upi.amount, qrPayload: upi.qrPayload } : null,
    delivery: order.delivery ? { status: order.delivery.status } : null,
    refund: request.refundStatus ? { status: request.refundStatus, amount: request.refundAmount ?? 0 } : null,
  };
}
