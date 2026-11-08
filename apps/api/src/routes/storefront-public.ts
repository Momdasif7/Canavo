import { Router, type Request } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { customerOtpRequestSchema, customerOtpVerifySchema, onlineOrderSchema, publicDeliveryQuoteSchema, qrOrderSchema, seatOrderSchema, tableCallSchema } from "@canavo/shared";
import { prisma } from "../db";
import { env } from "../env";
import { badRequest, conflict, param, parse, publicApiUrl } from "../lib/http";
import { moduleEnabled, runForOutlet } from "../lib/tenant";
import { activeOffers } from "../services/promotions";
import { describer } from "./offers";
import { receiptToken } from "./orders";
import {
  acceptingNow,
  addressQuote,
  bestsellerIds,
  callFromTable,
  deliveryAvailable,
  deliveryQuote,
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
import { requestCustomerOtp, verifyCustomerOtp } from "../services/storefront-otp";
import { placeSeatOrder, screenByToken, seatOrders, seatPage, seatUpi } from "../services/theatre";

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
storefrontPublicRouter.use(["/public/t", "/public/o", "/public/s"], limiter(5, 600, ip));
// Placing orders: per table / page and IP, so one phone can't flood a kitchen (refused orders don't count).
const qrOrderLimiter = limiter(10, 6, (req) => `qr:${req.params.token}:${ip(req)}`, false);
const qrCallLimiter = limiter(5, 4, (req) => `call:${req.params.token}:${ip(req)}`);
const onlineOrderLimiter = limiter(10, 5, (req) => `online:${req.params.slug}:${ip(req)}`, false);
// Phone OTP: per phone number (any outlet) and per IP, so nobody can SMS-bomb a number.
const phoneOf = (req: Request) => (typeof req.body?.phone === "string" ? req.body.phone.trim().slice(0, 15) : "none");
const otpPhoneLimiter = limiter(15, 5, (req) => `otp:phone:${phoneOf(req)}`);
const otpIpLimiter = limiter(15, 15, (req) => `otp:ip:${ip(req)}`);
const otpVerifyLimiter = limiter(15, 20, (req) => `otp:verify:${ip(req)}`);

// ---------- QR table ordering ----------

storefrontPublicRouter.get("/public/t/:token", async (req, res) => {
  const { table, outlet, settings, accent, seat } = await tableByToken(param(req, "token"));
  const [menu, bestsellers] = await runForOutlet(outlet.id, () => Promise.all([publicMenu(outlet.id, outlet.timezone), bestsellerIds(outlet.id)]));
  if (seat) {
    // THEATRE seat: the show window decides (not the dine-in hours); always UPI up front.
    const page = await runForOutlet(outlet.id, () => seatPage(table, outlet));
    return res.json({
      outlet: outletBrand(outlet, accent),
      table: { label: table.label },
      ordering: page.ordering,
      notice: page.notice,
      needsConfirmation: settings.qrNeedsConfirmation,
      bestsellers,
      hours: null,
      theatre: page.theatre,
      ...menu,
    });
  }
  const open = acceptingNow(settings, outlet.timezone);
  res.json({
    outlet: outletBrand(outlet, accent),
    table: { label: table.label },
    ordering: settings.qrOrdering && table.active && open,
    notice: !settings.qrOrdering ? "Menu only — please order with your waiter" : !table.active ? "This table isn't in use right now" : !open ? "We're not taking orders right now" : null,
    needsConfirmation: settings.qrNeedsConfirmation,
    bestsellers,
    hours: settings.acceptFrom && settings.acceptTo ? { from: settings.acceptFrom, to: settings.acceptTo } : null,
    ...menu,
  });
});

storefrontPublicRouter.post("/public/t/:token/orders", qrOrderLimiter, async (req, res) => {
  const token = param(req, "token");
  if ((await tableByToken(token)).seat) {
    // THEATRE seat: timing + mandatory UPI prepay → { id, token, status, timing, pickupToken, total, upi }
    return res.status(201).json(await placeSeatOrder(token, parse(seatOrderSchema, req.body), req.ip));
  }
  const input = parse(qrOrderSchema, req.body);
  const r = await placeQrOrder(token, input, req.ip);
  res.status(201).json({ id: r.id, status: r.status });
});

storefrontPublicRouter.get("/public/t/:token/orders", async (req, res) => {
  const token = param(req, "token");
  const t = await tableByToken(token);
  if (t.seat) return res.json(await seatOrders(t.table, t.outlet));
  res.json(await tableOrders(token));
});

/** THEATRE: a fresh UPI QR for an unpaid seat order (the first one expired). */
storefrontPublicRouter.post("/public/t/:token/orders/:orderToken/upi", qrOrderLimiter, async (req, res) => {
  res.status(201).json(await seatUpi(param(req, "token"), param(req, "orderToken")));
});

/** THEATRE: the screen poster QR — pick a row and a seat, then go to /t/<seat token>. */
storefrontPublicRouter.get("/public/s/:screenToken", async (req, res) => {
  res.json(await screenByToken(param(req, "screenToken")));
});

storefrontPublicRouter.post("/public/t/:token/call", qrCallLimiter, async (req, res) => {
  const { kind } = parse(tableCallSchema, req.body);
  await callFromTable(param(req, "token"), kind);
  res.status(201).json({ ok: true });
});

// ---------- Online ordering page ----------

storefrontPublicRouter.get("/public/o/:slug", async (req, res) => {
  const { outlet, settings, accent } = await outletBySlug(param(req, "slug"));
  const addressOnly = outlet.deliveryAddressMode === "ADDRESS";
  const data = await runForOutlet(outlet.id, async () => {
    const delivery = deliveryAvailable(outlet, settings);
    const offers = moduleEnabled("OFFERS") ? await activeOffers(outlet.id, new Date(), outlet.timezone) : [];
    const describe = offers.length ? await describer() : null;
    const offerRows = offers.length ? await prisma.offer.findMany({ where: { id: { in: offers.slice(0, 6).map((o) => o.id) } } }) : [];
    return {
      menu: await publicMenu(outlet.id, outlet.timezone),
      bestsellers: await bestsellerIds(outlet.id),
      delivery,
      zones:
        delivery && !addressOnly
          ? await prisma.deliveryZone.findMany({ where: { outletId: outlet.id, active: true }, select: { id: true, name: true, radiusKm: true, fee: true, minOrder: true, etaMinutes: true }, orderBy: { radiusKm: "asc" } })
          : [],
      /** Offers running now (applied automatically to the bill) */
      offers: offers.slice(0, 6).flatMap((o) => {
        const row = offerRows.find((r) => r.id === o.id);
        return row && describe ? [{ id: o.id, name: o.name, summary: describe(row) }] : [];
      }),
    };
  });
  const open = acceptingNow(settings, outlet.timezone);
  res.json({
    outlet: outletBrand(outlet, accent),
    ordering: settings.onlineOrdering && open,
    notice: !settings.onlineOrdering ? "Online ordering is off — here's our menu" : !open ? "We're not taking orders right now" : null,
    hours: settings.acceptFrom && settings.acceptTo ? { from: settings.acceptFrom, to: settings.acceptTo } : null,
    timezone: outlet.timezone,
    minOrder: settings.minOrder,
    takeaway: settings.takeaway,
    delivery: data.delivery,
    /** MAP: map pin + zones; ADDRESS: typed address + PIN code, flat fee (no map) */
    deliveryMode: addressOnly ? "ADDRESS" : "MAP",
    deliveryFlat: data.delivery && addressOnly ? { fee: outlet.deliveryFlatFee, minOrder: outlet.deliveryMinOrder, etaMinutes: outlet.deliveryEtaMinutes, areas: outlet.deliveryAreas } : null,
    zones: data.zones,
    offers: data.offers,
    bestsellers: data.bestsellers,
    payments: {
      COUNTER: settings.payAtCounter,
      COD: settings.cashOnDelivery && data.delivery,
      UPI: settings.upiPrepaid,
    },
    needsConfirmation: settings.onlineNeedsConfirmation,
    verifyPhone: settings.verifyPhoneOtp,
    /** Map centre / zone circles for the delivery pin */
    location: data.delivery && !addressOnly && outlet.latitude != null && outlet.longitude != null ? { lat: outlet.latitude, lng: outlet.longitude } : null,
    ...data.menu,
  });
});

/** Text a 6-digit code to the customer's phone (outlets with "Verify customer phone by OTP"). */
storefrontPublicRouter.post("/public/o/:slug/otp/request", otpIpLimiter, otpPhoneLimiter, async (req, res) => {
  const { outlet, settings } = await outletBySlug(param(req, "slug"));
  const { phone } = parse(customerOtpRequestSchema, req.body);
  if (!settings.onlineOrdering) throw conflict("Online ordering is switched off right now");
  res.json(await runForOutlet(outlet.id, () => requestCustomerOtp(outlet.id, phone, req.ip)));
});

/** Check the code → a short-lived signed token the order request carries. */
storefrontPublicRouter.post("/public/o/:slug/otp/verify", otpVerifyLimiter, async (req, res) => {
  const { outlet } = await outletBySlug(param(req, "slug"));
  const { phone, code } = parse(customerOtpVerifySchema, req.body);
  res.json(await runForOutlet(outlet.id, () => verifyCustomerOtp(outlet.id, phone, code)));
});

/**
 * Delivery fee and ETA: the zone for a map pin (refuses addresses outside every zone), or — for
 * outlets that take addresses without a map — the flat fee and the allowed-area check.
 */
storefrontPublicRouter.get("/public/o/:slug/delivery-quote", async (req, res) => {
  const { outlet, settings } = await outletBySlug(param(req, "slug"));
  const q = parse(publicDeliveryQuoteSchema, req.query);
  const addressOnly = outlet.deliveryAddressMode === "ADDRESS";
  if (!addressOnly && (q.lat === undefined || q.lng === undefined)) throw badRequest("Put the pin on the map where we should deliver");
  if (!deliveryAvailable(outlet, settings)) throw conflict("Delivery isn't available — choose takeaway");
  if (addressOnly) return res.json(addressQuote(outlet, q));
  const { lat, lng } = q;
  const quote = await runForOutlet(outlet.id, () => deliveryQuote(outlet, lat!, lng!));
  res.json({ ...quote, mode: "MAP", deliverable: Boolean(quote.zone), fee: quote.zone?.fee ?? null, etaMinutes: quote.zone?.etaMinutes ?? null, minOrder: quote.zone?.minOrder ?? null });
});

storefrontPublicRouter.post("/public/o/:slug/orders", onlineOrderLimiter, async (req, res) => {
  const input = parse(onlineOrderSchema, req.body);
  res.status(201).json(await placeOnlineOrder(param(req, "slug"), input, req.ip));
});

storefrontPublicRouter.get("/public/o/:slug/orders/:token", async (req, res) => {
  const { outlet, accent } = await outletBySlug(param(req, "slug"));
  const view = await runForOutlet(outlet.id, async () => {
    const request = await findOnlineRequest(outlet.id, param(req, "token"));
    return { request, view: await onlineOrderView(outlet, request) };
  });
  res.json({
    outlet: outletBrand(outlet, accent),
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
