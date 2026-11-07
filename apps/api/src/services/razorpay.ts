import crypto from "node:crypto";
import { env } from "../env";

export const razorpayEnabled = () => Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);

const apiBase = () => env.RAZORPAY_BASE_URL.replace(/\/+$/, "");
const authHeaders = () => ({
  authorization: `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString("base64")}`,
  "content-type": "application/json",
});

export interface UpiQr {
  /** Razorpay qr_code id, or a mock id */
  gatewayRef: string;
  /** Content to render as a QR (UPI intent string) */
  qrPayload: string;
  /** Hosted QR image (Razorpay only) */
  imageUrl?: string;
  mock: boolean;
}

/**
 * Create a single-use, fixed-amount UPI QR for a bill.
 * Without Razorpay keys, falls back to a plain UPI intent string for the
 * outlet's VPA; confirmation then has to come from /payments/dev/simulate
 * or manual cashier confirmation.
 */
export async function createUpiQr(opts: {
  amount: number;
  orderId: string;
  invoiceNumber: string;
  payeeName: string;
  vpa?: string | null;
}): Promise<UpiQr> {
  if (razorpayEnabled()) {
    const res = await fetch(`${apiBase()}/v1/payments/qr_codes`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        type: "upi_qr",
        name: opts.payeeName.slice(0, 40),
        usage: "single_use",
        fixed_amount: true,
        payment_amount: opts.amount,
        description: `Bill ${opts.invoiceNumber}`,
        close_by: Math.floor(Date.now() / 1000) + 15 * 60,
        notes: { orderId: opts.orderId, invoiceNumber: opts.invoiceNumber },
      }),
    });
    if (!res.ok) throw new Error(`Razorpay QR failed: ${res.status} ${await res.text()}`);
    const qr = (await res.json()) as { id: string; image_url: string };
    return { gatewayRef: qr.id, qrPayload: qr.image_url, imageUrl: qr.image_url, mock: false };
  }

  const ref = `mock_${crypto.randomBytes(8).toString("hex")}`;
  const params = new URLSearchParams({
    pa: opts.vpa || "canavo@upi",
    pn: opts.payeeName,
    am: (opts.amount / 100).toFixed(2),
    tr: ref,
    tn: `Bill ${opts.invoiceNumber}`,
    cu: "INR",
  });
  return { gatewayRef: ref, qrPayload: `upi://pay?${params.toString()}`, mock: true };
}

export interface GatewayRefund {
  /** Razorpay refund id (rfnd_…); null when nothing was sent to Razorpay */
  id: string | null;
  /**
   * PROCESSED: money is on its way back. PENDING: Razorpay is still processing it.
   * MANUAL: not refundable through the API here (no keys, or a dev / simulated payment) — refund it
   * in the Razorpay dashboard. FAILED: Razorpay refused; refund it by hand.
   */
  status: "PROCESSED" | "PENDING" | "MANUAL" | "FAILED";
  error?: string;
}

/** A real Razorpay payment id (the webhook stores it as Payment.reference). */
export const isGatewayPaymentRef = (ref: string | null | undefined): ref is string => Boolean(ref && /^pay_[A-Za-z0-9]+$/.test(ref));

/**
 * Refund (part of) a captured Razorpay payment back to the customer's UPI. Never throws: the
 * caller records the outcome and tells a manager when it has to be done by hand.
 */
export async function refundPayment(gatewayPaymentRef: string | null | undefined, amount: number, notes: Record<string, string> = {}): Promise<GatewayRefund> {
  if (!razorpayEnabled()) return { id: null, status: "MANUAL", error: "Razorpay isn't set up" };
  if (!isGatewayPaymentRef(gatewayPaymentRef)) return { id: null, status: "MANUAL", error: "Not a Razorpay payment" };
  try {
    const res = await fetch(`${apiBase()}/v1/payments/${encodeURIComponent(gatewayPaymentRef)}/refund`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ amount, speed: "normal", notes }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    if (!res.ok) {
      let msg = `${res.status}`;
      try {
        msg = (JSON.parse(text) as { error?: { description?: string } }).error?.description ?? msg;
      } catch {
        /* not JSON */
      }
      return { id: null, status: "FAILED", error: `Razorpay refused the refund: ${msg}`.slice(0, 300) };
    }
    const r = JSON.parse(text) as { id: string; status?: string };
    return { id: r.id, status: r.status === "processed" ? "PROCESSED" : r.status === "failed" ? "FAILED" : "PENDING" };
  } catch (e) {
    return { id: null, status: "FAILED", error: `Couldn't reach Razorpay: ${(e as Error).message}`.slice(0, 300) };
  }
}

/** Verify X-Razorpay-Signature: HMAC-SHA256 of the raw request body. */
export function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!env.RAZORPAY_WEBHOOK_SECRET || !signature) return false;
  const expected = crypto.createHmac("sha256", env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
