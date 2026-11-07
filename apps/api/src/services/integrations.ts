import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Prisma } from "@prisma/client";
import { platformPrisma } from "../db";
import { env } from "../env";
import { dataKey, decryptWith, encryptWith } from "../lib/crypto";
import { isInternalHost } from "../lib/safe-url";
import { currentBusinessId } from "../lib/tenant";

/**
 * Store integrations (Settings → Integrations). Each business connects its OWN accounts:
 *  - Razorpay (UPI QR, online payments, refunds, webhook) — NO platform fallback (product
 *    decision): a store's customers must never pay into the platform's account. Without its own
 *    keys a store has no UPI QR / online UPI (cash, card, khata… keep working).
 *  - Email (SMTP) — falls back to the platform SMTP_* account, then to the local outbox.
 *  - SMS (MSG91) — falls back to the platform MSG91_* account per message type.
 * Stored in Setting(scope = businessId, key = "integrations.<name>"). Every secret is encrypted
 * (AES-256-GCM, DATA_ENCRYPTION_KEY); the API returns masked hints only.
 */

export const RAZORPAY_KEY = "integrations.razorpay";
export const SMTP_KEY = "integrations.smtp";
export const SMS_KEY = "integrations.sms";
/** Index row: Setting(scope = "rzphook:<webhookId>", key = RAZORPAY_HOOK_KEY) → { businessId } */
export const RAZORPAY_HOOK_KEY = "integrations.razorpay.webhook";
export const INTEGRATION_SETTING_KEYS = [RAZORPAY_KEY, SMTP_KEY, SMS_KEY] as const;

export interface StoredRazorpay {
  keyIdEnc: string;
  keySecretEnc: string;
  webhookSecretEnc?: string;
  webhookId: string;
}
export interface StoredSmtp {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  passEnc?: string;
  from: string;
}
export interface StoredSms {
  authKeyEnc: string;
  otpTemplateId?: string;
  alertTemplateId?: string;
}

export const sealSecret = (plain: string) => encryptWith(dataKey(), plain);
export const openSecret = (enc?: string | null) => {
  if (!enc) return "";
  try {
    return decryptWith(dataKey(), enc);
  } catch {
    return "";
  }
};

/** Replace every secret (≥ 6 chars) in a provider message before it reaches a log, a response or the audit log. */
export function redact(text: string, secrets: (string | null | undefined)[]): string {
  return secrets
    .filter((s): s is string => Boolean(s && s.length >= 6))
    .reduce((t, s) => t.split(s).join("[redacted]"), text)
    .replace(/\b(Basic|Bearer)\s+[A-Za-z0-9+/=._-]{8,}/g, "$1 [redacted]")
    .replace(/(authkey|password|pass|secret|key_secret)(\s*["']?\s*[=:]\s*["']?\s*)[^\s"',&}]+/gi, "$1$2[redacted]");
}

export async function readStored<T>(businessId: string, key: string): Promise<T | null> {
  const row = await platformPrisma.setting.findUnique({ where: { scope_key: { scope: businessId, key } } });
  return (row?.value as unknown as T | undefined) ?? null;
}

export async function writeStored(businessId: string, key: string, value: object | null) {
  if (value === null) {
    await platformPrisma.setting.deleteMany({ where: { scope: businessId, key } });
    return;
  }
  const v = value as unknown as Prisma.InputJsonValue;
  await platformPrisma.setting.upsert({ where: { scope_key: { scope: businessId, key } }, create: { scope: businessId, key, value: v }, update: { value: v } });
}

// ---------------------------------------------------------------------------
// Razorpay
// ---------------------------------------------------------------------------

export interface RazorpayCreds {
  keyId: string;
  keySecret: string;
  webhookSecret?: string;
  businessId: string;
}

/** Shown wherever a UPI QR / online UPI payment is refused because the store has no Razorpay of its own. */
export const RAZORPAY_NOT_CONNECTED = "UPI QR payments need the store's own Razorpay account. The owner can connect it in Settings → Integrations.";
/** The same, for a customer on the online ordering page. */
export const RAZORPAY_NOT_CONNECTED_CUSTOMER = "Online UPI payment isn't available at this store right now. Please choose another way to pay.";

/**
 * Development / test only: without Razorpay keys a UPI QR is a mock UPI intent that staff confirm
 * by hand or with /dev-simulate. Never in production (env PAYMENTS_DEV_MOCK, default on outside
 * production). Read at call time so tests can switch it.
 */
export const upiDevMock = () => env.NODE_ENV !== "production" && env.PAYMENTS_DEV_MOCK !== false;

/** Stable, unguessable per-store id for the webhook URL (HMAC of the business id with the data key). */
export const razorpayWebhookId = (businessId: string) =>
  createHmac("sha256", dataKey()).update(`rzp-webhook:${businessId}`).digest("base64url").slice(0, 24);

export const razorpayWebhookUrl = (businessId: string) => `${env.PUBLIC_API_URL.replace(/\/$/, "")}/webhooks/razorpay/${razorpayWebhookId(businessId)}`;

export async function storeRazorpay(businessId: string): Promise<RazorpayCreds | null> {
  const s = await readStored<StoredRazorpay>(businessId, RAZORPAY_KEY);
  const keyId = openSecret(s?.keyIdEnc);
  const keySecret = openSecret(s?.keySecretEnc);
  if (!keyId || !keySecret) return null;
  return { keyId, keySecret, webhookSecret: openSecret(s?.webhookSecretEnc) || undefined, businessId };
}

/** Razorpay account of the current (or given) business — its own only; null when not connected. */
export async function razorpayFor(businessId = currentBusinessId()): Promise<RazorpayCreds | null> {
  return businessId ? storeRazorpay(businessId) : null;
}

/** Business behind a per-store webhook id, or null. */
export async function businessForWebhook(webhookId: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{24}$/.test(webhookId)) return null;
  const row = await platformPrisma.setting.findUnique({ where: { scope_key: { scope: `rzphook:${webhookId}`, key: RAZORPAY_HOOK_KEY } } });
  const businessId = (row?.value as { businessId?: string } | undefined)?.businessId;
  // Defence in depth: the id must still be the one derived from that business.
  return businessId && razorpayWebhookId(businessId) === webhookId ? businessId : null;
}

// ---------------------------------------------------------------------------
// Email (SMTP)
// ---------------------------------------------------------------------------

export interface SmtpCreds {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  source: "store" | "platform";
}

export const platformSmtp = (): SmtpCreds | null =>
  env.SMTP_HOST
    ? { host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_PORT === 465, user: env.SMTP_USER, pass: env.SMTP_PASS, from: env.SMTP_FROM, source: "platform" }
    : null;

export async function storeSmtp(businessId: string): Promise<SmtpCreds | null> {
  const s = await readStored<StoredSmtp>(businessId, SMTP_KEY);
  if (!s?.host) return null;
  return { host: s.host, port: s.port, secure: s.secure, user: s.user, pass: openSecret(s.passEnc) || undefined, from: s.from, source: "store" };
}

/** The store's own mail server, else the platform's, else null (the email goes to the local outbox). */
export async function smtpFor(businessId = currentBusinessId()): Promise<SmtpCreds | null> {
  return (businessId ? await storeSmtp(businessId) : null) ?? platformSmtp();
}

/** null when an owner-supplied mail server name may be used, else the reason. */
export function smtpHostError(host: string): string | null {
  if (isInternalHost(host)) return "Use your mail provider's public server name, not an internal address";
  return null;
}

export type Resolve = (host: string) => Promise<string[]>;
const dnsResolve: Resolve = async (host) => (await lookup(host, { all: true })).map((a) => a.address);

/**
 * Where to connect for an owner-supplied mail server: resolve the name and refuse internal
 * addresses (a public name may resolve to 10.x / 169.254.169.254 — DNS rebinding); connect to
 * the checked address and keep the name for TLS. Platform (.env) servers are trusted as-is.
 */
export async function smtpConnectTarget(c: SmtpCreds, resolve: Resolve = dnsResolve): Promise<{ host: string; servername?: string }> {
  if (c.source === "platform") return { host: c.host };
  const reason = smtpHostError(c.host);
  if (reason) throw new SmtpBlockedError(reason);
  if (isIP(c.host)) return { host: c.host };
  let addrs: string[];
  try {
    addrs = await resolve(c.host);
  } catch {
    throw new SmtpBlockedError("Mail server name not found");
  }
  if (!addrs.length || addrs.some((a) => isInternalHost(a))) throw new SmtpBlockedError("Mail server resolves to an internal network address");
  return { host: addrs[0]!, servername: c.host };
}

export class SmtpBlockedError extends Error {}

// ---------------------------------------------------------------------------
// SMS (MSG91)
// ---------------------------------------------------------------------------

export interface SmsCreds {
  authKey: string;
  templateId: string;
  source: "store" | "platform";
}

export async function storeSms(businessId: string): Promise<{ authKey: string; otpTemplateId?: string; alertTemplateId?: string } | null> {
  const s = await readStored<StoredSms>(businessId, SMS_KEY);
  const authKey = openSecret(s?.authKeyEnc);
  if (!authKey) return null;
  return { authKey, otpTemplateId: s?.otpTemplateId, alertTemplateId: s?.alertTemplateId };
}

/**
 * MSG91 account for one kind of SMS: the store's when it has a key and that template,
 * else the platform's (.env), else null (development: the text is logged instead).
 */
export async function smsFor(kind: "otp" | "alert", businessId = currentBusinessId()): Promise<SmsCreds | null> {
  const store = businessId ? await storeSms(businessId) : null;
  const storeTemplate = kind === "otp" ? store?.otpTemplateId : store?.alertTemplateId;
  if (store && storeTemplate) return { authKey: store.authKey, templateId: storeTemplate, source: "store" };
  const platformTemplate = kind === "otp" ? env.MSG91_TEMPLATE_ID : env.MSG91_ALERT_TEMPLATE_ID;
  if (env.MSG91_AUTH_KEY && platformTemplate) return { authKey: env.MSG91_AUTH_KEY, templateId: platformTemplate, source: "platform" };
  return null;
}

export const MSG91_BASE = "https://control.msg91.com";
