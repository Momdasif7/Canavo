import { Router, type Request } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { onlineOrderSchema, qrOrderSchema, tableCallSchema } from "@canavo/shared";
import { prisma } from "../db";
import { env } from "../env";
import { conflict, param, parse, publicApiUrl } from "../lib/http";
import { runForOutlet } from "../lib/tenant";
import { receiptToken } from "./orders";
import {
  acceptingNow,
  callFromTable,
  deliveryAvailable,
  findOnlineRequest,
  onlineOrderView,
  outletBrand,
  outletBySlug,
  placeOnlineOrder,
  placeQrOrder,
  publicMenu,
  requestUpi,
  tableByToken,
  tableOrders,
} from "../services/storefront";

/**
 * Phase 6.3 / 6.4 public endpoints (no login): the QR page on a table (/t/<token>) and the
 * outlet's online ordering page (/o/<slug>). Mounted after the JSON body parser.
 */
export const storefrontPublicRouter = Router();

const ip = (req: Request) => ipKeyGenerator(req.ip ?? "unknown");
const limiter = (windowMinutes: number, limit: number, key: (req: Request) => string, countFailed = true) =>
  rateLimit({
    windowMs: windowMinutes * 60_000,
    limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: key,
    skipFailedRequests: !countFailed,
    message: { error: "Too many requests — please wait a few minutes and try again" },
  });

// Reads (menu, status polling every few seconds): generous, per IP.
storefrontPublicRouter.use(["/public/t", "/public/o"], limiter(5, 600, ip));
// Placing orders: per table / page and IP, so one phone can't flood a kitchen (refused orders don't count).
const qrOrderLimiter = limiter(10, 6, (req) => `qr:${req.params.token}:${ip(req)}`, false);
const qrCallLimiter = limiter(5, 4, (req) => `call:${req.params.token}:${ip(req)}`);
const onlineOrderLimiter = limiter(10, 5, (req) => `online:${req.params.slug}:${ip(req)}`, false);

// ---------- QR table ordering ----------

storefrontPublicRouter.get("/public/t/:token", async (req, res) => {
  const { table, outlet, settings } = await tableByToken(param(req, "token"));
  const menu = await runForOutlet(outlet.id, () => publicMenu(outlet.id, outlet.timezone));
  const open = acceptingNow(settings, outlet.timezone);
  res.json({
    outlet: outletBrand(outlet),
    table: { label: table.label },
    ordering: settings.qrOrdering && table.active && open,
    notice: !settings.qrOrdering ? "Menu only — please order with your waiter" : !table.active ? "This table isn't in use right now" : !open ? "We're not taking orders right now" : null,
    needsConfirmation: settings.qrNeedsConfirmation,
    hours: settings.acceptFrom && settings.acceptTo ? { from: settings.acceptFrom, to: settings.acceptTo } : null,
    ...menu,
  });
});

storefrontPublicRouter.post("/public/t/:token/orders", qrOrderLimiter, async (req, res) => {
  const input = parse(qrOrderSchema, req.body);
  const r = await placeQrOrder(param(req, "token"), input, req.ip);
  res.status(201).json({ id: r.id, status: r.status });
});

storefrontPublicRouter.get("/public/t/:token/orders", async (req, res) => {
  res.json(await tableOrders(param(req, "token")));
});

storefrontPublicRouter.post("/public/t/:token/call", qrCallLimiter, async (req, res) => {
  const { kind } = parse(tableCallSchema, req.body);
  await callFromTable(param(req, "token"), kind);
  res.status(201).json({ ok: true });
});

// ---------- Online ordering page ----------

storefrontPublicRouter.get("/public/o/:slug", async (req, res) => {
  const { outlet, settings } = await outletBySlug(param(req, "slug"));
  const data = await runForOutlet(outlet.id, async () => ({
    menu: await publicMenu(outlet.id, outlet.timezone),
    delivery: deliveryAvailable(outlet, settings),
    zones: deliveryAvailable(outlet, settings)
      ? await prisma.deliveryZone.findMany({ where: { outletId: outlet.id, active: true }, select: { id: true, name: true, fee: true, minOrder: true, etaMinutes: true }, orderBy: { radiusKm: "asc" } })
      : [],
  }));
  const open = acceptingNow(settings, outlet.timezone);
  res.json({
    outlet: outletBrand(outlet),
    ordering: settings.onlineOrdering && open,
    notice: !settings.onlineOrdering ? "Online ordering is off — here's our menu" : !open ? "We're not taking orders right now" : null,
    hours: settings.acceptFrom && settings.acceptTo ? { from: settings.acceptFrom, to: settings.acceptTo } : null,
    timezone: outlet.timezone,
    minOrder: settings.minOrder,
    takeaway: settings.takeaway,
    delivery: data.delivery,
    zones: data.zones,
    payments: {
      COUNTER: settings.payAtCounter,
      COD: settings.cashOnDelivery && data.delivery,
      UPI: settings.upiPrepaid,
    },
    needsConfirmation: settings.onlineNeedsConfirmation,
    ...data.menu,
  });
});

storefrontPublicRouter.post("/public/o/:slug/orders", onlineOrderLimiter, async (req, res) => {
  const input = parse(onlineOrderSchema, req.body);
  res.status(201).json(await placeOnlineOrder(param(req, "slug"), input, req.ip));
});

storefrontPublicRouter.get("/public/o/:slug/orders/:token", async (req, res) => {
  const { outlet } = await outletBySlug(param(req, "slug"));
  const view = await runForOutlet(outlet.id, async () => {
    const request = await findOnlineRequest(outlet.id, param(req, "token"));
    return { request, view: await onlineOrderView(outlet, request) };
  });
  res.json({
    outlet: outletBrand(outlet),
    ...view.view,
    receiptUrl: view.view.status === "PAID" ? `${publicApiUrl(req, env.PUBLIC_API_URL)}/public/receipts/${receiptToken(view.request.orderId!)}` : null,
  });
});

/** A new UPI QR when the first one expired. */
storefrontPublicRouter.post("/public/o/:slug/orders/:token/upi", onlineOrderLimiter, async (req, res) => {
  const { outlet, settings } = await outletBySlug(param(req, "slug"));
  const payment = await runForOutlet(outlet.id, async () => {
    const request = await findOnlineRequest(outlet.id, param(req, "token"));
    if (!settings.upiPrepaid || request.payment !== "UPI") throw conflict("UPI isn't available for this order");
    return requestUpi(outlet, request.orderId!);
  });
  res.status(201).json({ amount: payment.amount, qrPayload: payment.qrPayload });
});
