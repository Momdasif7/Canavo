import crypto from "node:crypto";
import { env } from "../env";
import { HttpError } from "../lib/http";
import { currentBusinessId } from "../lib/tenant";
import { RAZORPAY_NOT_CONNECTED, razorpayFor, redact, upiDevMock, type RazorpayCreds } from "./integrations";

/**
 * Razorpay for the current business: its OWN account (Settings → Integrations), so money
 * settles into the store's account. There is no platform payment account to fall back to.
 */
export const razorpayEnabled = async (businessId = currentBusinessId()) => Boolean(await razorpayFor(businessId));

/** Can this business show UPI QRs / take online UPI? Its own Razorpay, or the dev-only mock. */
export const upiAvailable = async (businessId = currentBusinessId()) => (await razorpayEnabled(businessId)) || upiDevMock();

const apiBase = () => env.RAZORPAY_BASE_URL.replace(/\/+$/, "");
const basic = (c: RazorpayCreds) => Buffer.from(`${c.keyId}:${c.keySecret}`).toString("base64");
const authHeaders = (c: RazorpayCreds) => ({ authorization: `Basic ${basic(c)}`, "content-type": "application/json" });
const secretsOf = (c: RazorpayCreds) => [c.keyId, c.keySecret, c.webhookSecret, basic(c)];

/** A Razorpay error for people and logs: status + its description only, keys stripped (never the raw body). */
async function rzpError(res: Response, c: RazorpayCreds): Promise<string> {
  const text = await res.text().catch(() => "");
  let msg = "";
  try {
    msg = (JSON.parse(text) as { error?: { description?: string } }).error?.description ?? "";
  } catch {
    /* not JSON */
  }
  return redact(`${res.status}${msg ? ` ${msg}` : ""}`, secretsOf(c)).slice(0, 200);
}

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
 * Create a single-use, fixed-amount UPI QR for a bill with the store's Razorpay account.
 * Without one: refused (409 RAZORPAY_NOT_CONNECTED) — except in development / tests, where a
 * mock UPI intent string is returned and confirmed by the cashier or /dev-simulate.
 */
export async function createUpiQr(opts: {
  amount: number;
  orderId: string;
  invoiceNumber: string;
  payeeName: string;
  vpa?: string | null;
}): Promise<UpiQr> {
  const creds = await razorpayFor();
  if (creds) {
    const res = await fetch(`${apiBase()}/v1/payments/qr_codes`, {
      method: "POST",
      headers: authHeaders(creds),
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
      signal: AbortSignal.timeout(15_000),
    }).catch((e: Error) => {
      throw new HttpError(502, redact(`Couldn't reach Razorpay: ${e.name === "TimeoutError" ? "no answer in 15 s" : e.message}`, secretsOf(creds)).slice(0, 200));
    });
    if (!res.ok) throw new HttpError(502, `Razorpay couldn't create the QR: ${await rzpError(res, creds)}`);
    const qr = (await res.json()) as { id: string; image_url: string };
    return { gatewayRef: qr.id, qrPayload: qr.image_url, imageUrl: qr.image_url, mock: false };
  }
  // No platform fallback: a store without its own Razorpay has no UPI QR (development mock aside).
  if (!upiDevMock()) throw new HttpError(409, RAZORPAY_NOT_CONNECTED, { code: "RAZORPAY_NOT_CONNECTED" });

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
 * Refund (part of) a captured Razorpay payment back to the customer's UPI, through the store's
 * own account. Never throws: the caller records the outcome and tells a manager when it has to
 * be done by hand.
 */
export async function refundPayment(gatewayPaymentRef: string | null | undefined, amount: number, notes: Record<string, string> = {}): Promise<GatewayRefund> {
  const creds = await razorpayFor();
  if (!creds) return { id: null, status: "MANUAL", error: "Razorpay isn't set up" };
  if (!isGatewayPaymentRef(gatewayPaymentRef)) return { id: null, status: "MANUAL", error: "Not a Razorpay payment" };
  try {
    const res = await fetch(`${apiBase()}/v1/payments/${encodeURIComponent(gatewayPaymentRef)}/refund`, {
      method: "POST",
      headers: authHeaders(creds),
      body: JSON.stringify({ amount, speed: "normal", notes }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return { id: null, status: "FAILED", error: `Razorpay refused the refund: ${await rzpError(res, creds)}`.slice(0, 300) };
    const r = (await res.json()) as { id: string; status?: string };
    return { id: r.id, status: r.status === "processed" ? "PROCESSED" : r.status === "failed" ? "FAILED" : "PENDING" };
  } catch (e) {
    return { id: null, status: "FAILED", error: redact(`Couldn't reach Razorpay: ${(e as Error).message}`, secretsOf(creds)).slice(0, 300) };
  }
}

/**
 * "Test connection": an authenticated, harmless read (the latest payment, count=1).
 * A short message for the owner; never the provider's raw body.
 */
export async function testRazorpay(creds: RazorpayCreds): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(`${apiBase()}/v1/payments?count=1`, { headers: authHeaders(creds), signal: AbortSignal.timeout(10_000) });
    if (res.ok) return { ok: true, message: `Connected (${creds.keyId.startsWith("rzp_live_") ? "live" : "test"} mode)` };
    if (res.status === 401) return { ok: false, message: "Razorpay refused the key ID or secret" };
    return { ok: false, message: `Razorpay answered ${await rzpError(res, creds)}` };
  } catch (e) {
    return { ok: false, message: (e as Error).name === "TimeoutError" ? "Razorpay did not answer in 10 s" : "Couldn't reach Razorpay" };
  }
}

/** Verify X-Razorpay-Signature: HMAC-SHA256 of the raw request body (default: the platform webhook secret). */
export function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined, secret = env.RAZORPAY_WEBHOOK_SECRET): boolean {
  if (!secret || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
