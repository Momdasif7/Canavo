import express, { Router } from "express";
import jwt from "jsonwebtoken";
import { platformPrisma, prisma } from "../db";
import { env } from "../env";
import { badRequest, notFound, param, unauthorized } from "../lib/http";
import { buildReceipt, getOrder, settleIfPaid } from "../services/billing";
import { renderReceiptPdf } from "../services/pdf";
import { hasOwnRazorpay, verifyWebhookSignature } from "../services/razorpay";
import { emitToOutlet } from "../realtime";
import { runForBusiness, runForOutlet } from "../lib/tenant";
import { decrypt } from "../lib/crypto";
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
  payload: {
    qr_code?: { entity: { id: string } };
    payment?: { entity: { id: string; amount: number; vpa?: string; contact?: string } };
    refund?: { entity: { id: string; payment_id: string; amount: number; status: string } };
  };
}

/** Which account a webhook delivery came through: one store's own Razorpay, or the platform's shared account. */
type WebhookScope = { businessId: string } | { platform: true };

/**
 * Per-store Razorpay webhook (Settings → Integrations → Razorpay shows the URL). The unguessable key picks
 * the store; the signature is checked with THAT store's webhook secret; payments and refunds are looked up
 * inside that store only (row-level security), so store A's webhook can never settle store B's bills.
 * Mounted before the JSON body parser: the signature covers the raw body.
 */
publicRouter.post("/webhooks/razorpay/:businessKey", express.raw({ type: "application/json" }), async (req, res) => {
  const key = param(req, "businessKey");
  const integration = /^[A-Za-z0-9_-]{20,64}$/.test(key)
    ? await platformPrisma.businessIntegration.findUnique({ where: { webhookKey: key }, select: { businessId: true, kind: true, enabled: true, secrets: true } })
    : null;
  let secret = "";
  const enc = (integration?.secrets as { webhookSecret?: string } | null)?.webhookSecret;
  if (integration?.kind === "RAZORPAY" && integration.enabled && enc) {
    try {
      secret = decrypt(enc);
    } catch {
      secret = "";
    }
  }
  // Unknown key, disabled store or no webhook secret: the same answer as a bad signature (no probing).
  if (!Buffer.isBuffer(req.body) || !verifyWebhookSignature(req.body, req.header("x-razorpay-signature"), secret)) throw unauthorized("Bad signature");
  res.json(await handleRazorpayEvent(req.body, { businessId: integration!.businessId }));
});

/**
 * The platform's own Razorpay account (env RAZORPAY_WEBHOOK_SECRET), kept for stores that collect through
 * the shared account (RAZORPAY_SHARED_ACCOUNT) and for QR codes created before a store added its own keys.
 * It never settles payments of a store that has its own Razorpay account.
 */
publicRouter.post("/webhooks/razorpay", express.raw({ type: "application/json" }), async (req, res) => {
  // express.raw only fills a Buffer for JSON bodies; anything else can't carry a valid signature.
  if (!Buffer.isBuffer(req.body) || !verifyWebhookSignature(req.body, req.header("x-razorpay-signature"), env.RAZORPAY_WEBHOOK_SECRET)) throw unauthorized("Bad signature");
  res.json(await handleRazorpayEvent(req.body, { platform: true }));
});

async function handleRazorpayEvent(raw: Buffer, scope: WebhookScope) {
  let event: RazorpayQrWebhook;
  try {
    event = JSON.parse(raw.toString("utf8")) as RazorpayQrWebhook;
  } catch {
    throw badRequest("Body is not JSON");
  }
  if (!event || typeof event !== "object" || typeof event.event !== "string") throw badRequest("Not a Razorpay event");
  if (event.event === "refund.processed" || event.event === "refund.failed") return refundEvent(event, scope);
  if (event.event !== "qr_code.credited") return { ignored: event.event };

  const qrId = event.payload?.qr_code?.entity?.id;
  const rzpPayment = event.payload?.payment?.entity;
  if (!qrId || !rzpPayment) return { ignored: "missing payload" };

  // A store's webhook looks only inside that store (RLS); the platform webhook looks everywhere, then
  // refuses stores that use their own account.
  const find = () => prisma.payment.findUnique({ where: { gatewayRef: qrId }, include: { order: { include: { outlet: { select: { businessId: true } } } } } });
  const payment = "businessId" in scope ? await runForBusiness(scope.businessId, find) : await find();
  if (!payment || ("businessId" in scope && payment.order.outlet.businessId !== scope.businessId)) return { ignored: "unknown qr" };
  if ("platform" in scope && (await hasOwnRazorpay(payment.order.outlet.businessId))) return { ignored: "store uses its own Razorpay account" };
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
        meta: { razorpayPaymentId: rzpPayment.id, amount: rzpPayment.amount, account: "businessId" in scope ? "store" : "platform" },
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
async function refundEvent(event: RazorpayQrWebhook, scope: WebhookScope) {
  const refund = event.payload?.refund?.entity;
  if (!refund?.id) return { ignored: "missing payload" };
  const request = await platformPrisma.channelRequest.findFirst({ where: { refundRef: { contains: refund.id } }, include: { outlet: { select: { businessId: true } } } });
  if (!request) return { ignored: "unknown refund" };
  const businessId = request.outlet.businessId;
  if ("businessId" in scope ? businessId !== scope.businessId : await hasOwnRazorpay(businessId)) return { ignored: "unknown refund" };
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
