import crypto from "node:crypto";
import { platformPrisma } from "../db";
import { env } from "../env";
import { currentBusinessId } from "../lib/tenant";
import { isUsable, loadIntegration, redactor } from "./integrations";

/**
 * Razorpay account used for a business:
 *  - "business": the store's own keys (Settings → Integrations → Razorpay) — the normal case;
 *  - "platform": the env RAZORPAY_* keys, ONLY when RAZORPAY_SHARED_ACCOUNT=true (a platform that
 *    deliberately collects for its stores);
 *  - null: no gateway → plain UPI QR to the outlet's UPI ID, confirmed by the cashier. Money never
 *    lands in the platform's account by accident.
 */
export interface RazorpayAccount {
  keyId: string;
  keySecret: string;
  webhookSecret: string;
  source: "business" | "platform";
}

export async function razorpayAccount(businessId = currentBusinessId()): Promise<RazorpayAccount | null> {
  const own = businessId ? await loadIntegration("RAZORPAY", businessId) : null;
  if (own && isUsable(own)) {
    return { keyId: String(own.config.keyId), keySecret: own.secret("keySecret"), webhookSecret: own.secret("webhookSecret"), source: "business" };
  }
  return platformAccount();
}

/** The platform's own account, if the platform allows stores to share it. */
export function platformAccount(): RazorpayAccount | null {
  if (!env.RAZORPAY_SHARED_ACCOUNT || !env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) return null;
  return { keyId: env.RAZORPAY_KEY_ID, keySecret: env.RAZORPAY_KEY_SECRET, webhookSecret: env.RAZORPAY_WEBHOOK_SECRET ?? "", source: "platform" };
}

export const razorpayEnabled = async (businessId = currentBusinessId()) => Boolean(await razorpayAccount(businessId));

/** Does this business collect through its OWN Razorpay account (then the platform webhook must not settle its payments)? */
export async function hasOwnRazorpay(businessId: string): Promise<boolean> {
  const row = await platformPrisma.businessIntegration.findFirst({ where: { businessId, kind: "RAZORPAY" } });
  return Boolean(row && row.enabled && (row.config as { keyId?: string } | null)?.keyId);
}

const apiBase = () => env.RAZORPAY_BASE_URL.replace(/\/+$/, "");
const authHeaders = (a: RazorpayAccount) => ({
  authorization: `Basic ${Buffer.from(`${a.keyId}:${a.keySecret}`).toString("base64")}`,
  "content-type": "application/json",
});

/** "Test connection": a harmless authenticated read. Never throws; the message never contains the keys. */
export async function testRazorpayKeys(keyId: string, keySecret: string): Promise<{ ok: boolean; message: string }> {
  const redact = redactor(keySecret);
  try {
    const res = await fetch(`${apiBase()}/v1/payments?count=1`, {
      headers: authHeaders({ keyId, keySecret, webhookSecret: "", source: "business" }),
      signal: AbortSignal.timeout(10_000),
      redirect: "manual",
    });
    if (res.ok) return { ok: true, message: `Razorpay accepted the keys (${keyId.startsWith("rzp_live_") ? "live" : "test"} mode)` };
    if (res.status === 401) return { ok: false, message: "Razorpay rejected the key id / key secret" };
    return { ok: false, message: `Razorpay answered ${res.status}` };
  } catch (e) {
    return { ok: false, message: redact(`Couldn't reach Razorpay: ${e instanceof Error ? (e.name === "TimeoutError" ? "no answer in 10 s" : e.message) : "error"}`).slice(0, 200) };
  }
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
  /** Defaults to the current business's account */
  account?: RazorpayAccount | null;
}): Promise<UpiQr> {
  const account = opts.account === undefined ? await razorpayAccount() : opts.account;
  if (account) {
    const res = await fetch(`${apiBase()}/v1/payments/qr_codes`, {
      method: "POST",
      headers: authHeaders(account),
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
    // Only the status and Razorpay's own description — never the request (it carries the keys).
    if (!res.ok) throw new Error(redactor(account.keySecret)(`Razorpay QR failed: ${res.status} ${(await res.text()).slice(0, 300)}`));
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
export async function refundPayment(
  gatewayPaymentRef: string | null | undefined,
  amount: number,
  notes: Record<string, string> = {},
  accountArg?: RazorpayAccount | null,
): Promise<GatewayRefund> {
  const account = accountArg === undefined ? await razorpayAccount() : accountArg;
  if (!account) return { id: null, status: "MANUAL", error: "Razorpay isn't set up" };
  if (!isGatewayPaymentRef(gatewayPaymentRef)) return { id: null, status: "MANUAL", error: "Not a Razorpay payment" };
  try {
    const res = await fetch(`${apiBase()}/v1/payments/${encodeURIComponent(gatewayPaymentRef)}/refund`, {
      method: "POST",
      headers: authHeaders(account),
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
      return { id: null, status: "FAILED", error: redactor(account.keySecret)(`Razorpay refused the refund: ${msg}`).slice(0, 300) };
    }
    const r = JSON.parse(text) as { id: string; status?: string };
    return { id: r.id, status: r.status === "processed" ? "PROCESSED" : r.status === "failed" ? "FAILED" : "PENDING" };
  } catch (e) {
    return { id: null, status: "FAILED", error: redactor(account.keySecret)(`Couldn't reach Razorpay: ${(e as Error).message}`).slice(0, 300) };
  }
}

/** Verify X-Razorpay-Signature: HMAC-SHA256 of the raw request body with the account's webhook secret. */
export function verifyWebhookSignature(rawBody: Buffer, signature: string | undefined, secret: string | undefined): boolean {
  if (!secret || !signature) return false;
  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
