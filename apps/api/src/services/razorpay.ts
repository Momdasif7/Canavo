import crypto from "node:crypto";
import { env } from "../env";

export const razorpayEnabled = () => Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);

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
    const auth = Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString("base64");
    const res = await fetch("https://api.razorpay.com/v1/payments/qr_codes", {
      method: "POST",
      headers: { authorization: `Basic ${auth}`, "content-type": "application/json" },
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

/** Verify X-Razorpay-Signature: HMAC-SHA256 of the raw request body. */
export function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined): boolean {
  if (!env.RAZORPAY_WEBHOOK_SECRET || !signature) return false;
  const expected = crypto.createHmac("sha256", env.RAZORPAY_WEBHOOK_SECRET).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
