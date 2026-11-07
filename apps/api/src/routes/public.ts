import express, { Router } from "express";
import jwt from "jsonwebtoken";
import { platformPrisma, prisma } from "../db";
import { env } from "../env";
import { badRequest, notFound, param, unauthorized } from "../lib/http";
import { buildReceipt, getOrder, settleIfPaid } from "../services/billing";
import { renderReceiptPdf } from "../services/pdf";
import { verifyWebhookSignature } from "../services/razorpay";
import { businessForWebhook, storeRazorpay } from "../services/integrations";
import { emitToOutlet } from "../realtime";
import { runForOutlet } from "../lib/tenant";
import { alertPaymentReceived } from "../services/alerts";
import { notify, outletManagers } from "../services/notify";

export const publicRouter = Router();

/** Signed, unauthenticated receipt link shared with customers on WhatsApp. */
publicRouter.get("/public/receipts/:token", async (req, res) => {
  let oid: string;
  try {
    oid = (jwt.verify(param(req, "token"), env.RECEIPT_LINK_SECRET) as { oid: string }).oid;
  } catch {
    throw notFound("Receipt");
  }
  if (typeof oid !== "string" || !oid) throw notFound("Receipt");
  const { outletId } = await prisma.order.findUniqueOrThrow({ where: { id: oid }, select: { outletId: true } });
  const order = await getOrder(oid, outletId);
  const pdf = await renderReceiptPdf(await buildReceipt(order));
  res.type("application/pdf").setHeader("content-disposition", `inline; filename="${order.invoiceNumber}.pdf"`);
  res.send(pdf);
});

interface RazorpayQrWebhook {
  event: string;
  payload?: {
    qr_code?: { entity?: { id: string } };
    payment?: { entity: { id: string; amount: number; vpa?: string; contact?: string } };
    refund?: { entity: { id: string; payment_id: string; amount: number; status: string } };
  };
}

/**
 * Razorpay webhook. Must receive the raw body for signature verification, so
 * it is mounted before the JSON body parser.
 */
/**
 * Legacy platform webhook (RAZORPAY_WEBHOOK_SECRET): QRs created before stores had their own
 * keys (there is no platform payment account any more). It never touches a store that connected
 * its own Razorpay: that store's events come to its own URL below.
 */
publicRouter.post("/webhooks/razorpay", express.raw({ type: "application/json" }), async (req, res) => {
  // express.raw only fills a Buffer for JSON bodies; anything else can't carry a valid signature.
  if (!Buffer.isBuffer(req.body) || !verifyWebhookSignature(req.body, req.header("x-razorpay-signature"))) throw unauthorized("Bad signature");
  res.json(await razorpayEvent(parseEvent(req.body), null));
});

/**
 * Per-store webhook: /webhooks/razorpay/<store webhook id> (shown in Settings → Integrations).
 * Verified with THAT store's webhook secret, and it only ever touches that store's payments.
 */
publicRouter.post("/webhooks/razorpay/:hookId", express.raw({ type: "application/json" }), async (req, res) => {
  const businessId = await businessForWebhook(param(req, "hookId"));
  const creds = businessId ? await storeRazorpay(businessId) : null;
  // Same answer for an unknown store, a store without a webhook secret and a bad signature (no probing).
  if (!businessId || !creds?.webhookSecret || !Buffer.isBuffer(req.body) || !verifyWebhookSignature(req.body, req.header("x-razorpay-signature"), creds.webhookSecret)) {
    throw unauthorized("Bad signature");
  }
  res.json(await razorpayEvent(parseEvent(req.body), businessId));
});

function parseEvent(raw: Buffer): RazorpayQrWebhook {
  let event: RazorpayQrWebhook;
  try {
    event = JSON.parse(raw.toString("utf8")) as RazorpayQrWebhook;
  } catch {
    throw badRequest("Body is not JSON");
  }
  if (!event || typeof event !== "object" || typeof event.event !== "string") throw badRequest("Not a Razorpay event");
  return event;
}

/** Business of an outlet, or null. */
const businessOfOutlet = async (outletId: string) => (await platformPrisma.outlet.findUnique({ where: { id: outletId }, select: { businessId: true } }))?.businessId ?? null;

/**
 * Is this business's event for the webhook that received it? A store's webhook: only that store.
 * The platform webhook: only stores WITHOUT their own Razorpay (their money isn't on the platform account).
 */
async function belongsToHook(eventBusinessId: string | null, hookBusinessId: string | null): Promise<boolean> {
  if (!eventBusinessId) return false;
  if (hookBusinessId) return eventBusinessId === hookBusinessId;
  return !(await storeRazorpay(eventBusinessId));
}

/** Handle a verified Razorpay event for one store's webhook (businessId) or the platform's (null). */
async function razorpayEvent(event: RazorpayQrWebhook, hookBusinessId: string | null) {
  if (event.event === "refund.processed" || event.event === "refund.failed") return refundEvent(event, hookBusinessId);
  if (event.event !== "qr_code.credited") return { ignored: event.event };

  const qrId = event.payload?.qr_code?.entity?.id;
  const rzpPayment = event.payload?.payment?.entity;
  if (typeof qrId !== "string" || !rzpPayment || typeof rzpPayment.id !== "string" || !Number.isInteger(rzpPayment.amount)) return { ignored: "missing payload" };

  const payment = await prisma.payment.findUnique({ where: { gatewayRef: qrId }, include: { order: true } });
  if (!payment || !(await belongsToHook(await businessOfOutlet(payment.order.outletId), hookBusinessId))) return { ignored: "unknown qr" };
  if (payment.status === "SUCCESS") return { ok: true, duplicate: true };

  // Webhooks arrive without a login: act inside the order's business.
  const paid = await runForOutlet(payment.order.outletId, () => prisma.$transaction(async (tx) => {
    // Claim the payment: of concurrent deliveries of the same event only one gets past here
    // (the row lock makes the others wait and then see SUCCESS), so settling runs once.
    const claimed = await tx.payment.updateMany({
      where: { id: payment.id, status: { not: "SUCCESS" } },
      data: { status: "SUCCESS", confirmedAt: new Date(), reference: rzpPayment.id, amount: rzpPayment.amount },
    });
    if (!claimed.count) return "duplicate" as const;
    await tx.auditLog.create({
      data: {
        outletId: payment.order.outletId,
        action: "payment.webhook",
        entity: "Payment",
        entityId: payment.id,
        meta: { razorpayPaymentId: rzpPayment.id, amount: rzpPayment.amount },
      },
    });
    // Capture the payer's phone before settling so loyalty credits this customer.
    const phone = rzpPayment.contact?.replace(/^\+?91/, "");
    if (phone && /^[6-9]\d{9}$/.test(phone) && !payment.order.customerPhone) {
      await tx.order.update({ where: { id: payment.orderId }, data: { customerPhone: phone } });
    }
    return settleIfPaid(payment.orderId, tx);
  }));
  if (paid === "duplicate") return { ok: true, duplicate: true };

  emitToOutlet(payment.order.outletId, "payment:confirmed", { orderId: payment.orderId, paymentId: payment.id, paid });
  void runForOutlet(payment.order.outletId, () => alertPaymentReceived(payment.order.outletId, payment.orderId, rzpPayment.amount));
  if (paid) emitToOutlet(payment.order.outletId, "order:paid", { id: payment.orderId, invoiceNumber: payment.order.invoiceNumber });
  return { ok: true };
}

/** Razorpay refund outcome for an online order refunded automatically (Phase 6 follow-up). */
async function refundEvent(event: RazorpayQrWebhook, hookBusinessId: string | null) {
  const refund = event.payload?.refund?.entity;
  if (typeof refund?.id !== "string" || !refund.id) return { ignored: "missing payload" };
  const request = await platformPrisma.channelRequest.findFirst({
    where: { refundRef: { contains: refund.id }, ...(hookBusinessId && { outlet: { businessId: hookBusinessId } }) },
  });
  if (!request || !(await belongsToHook(await businessOfOutlet(request.outletId), hookBusinessId))) return { ignored: "unknown refund" };
  const status = event.event === "refund.processed" ? "PROCESSED" : "FAILED";
  if (request.refundStatus === status) return { ok: true, duplicate: true };
  await runForOutlet(request.outletId, async () => {
    await prisma.channelRequest.update({
      where: { id: request.id },
      data: { refundStatus: status, ...(status === "FAILED" && { refundError: "Razorpay couldn't complete the refund" }) },
    });
    if (status === "FAILED") {
      await notify(
        await outletManagers(request.outletId),
        "UPI refund failed",
        `Razorpay couldn't refund the online order of ${request.customerName ?? "a customer"} — refund it in the Razorpay dashboard.`,
        "channel.refund",
        { outletId: request.outletId, link: "/pos" },
      ).catch(() => undefined);
    }
  });
  emitToOutlet(request.outletId, "channel:request", { id: request.id, action: "refund" });
  return { ok: true };
}
