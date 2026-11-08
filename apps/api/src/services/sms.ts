import { env } from "../env";
import { currentBusinessId } from "../lib/tenant";
import { isUsable, loadIntegration, redactor } from "./integrations";

/**
 * SMS through MSG91. Each store may use its own MSG91 account (Settings → Integrations → SMS: auth key,
 * DLT sender id, OTP / alert flow template ids); otherwise the platform's env MSG91_* account is used.
 *  - Staff login OTP and password links are PLATFORM messages (sent before / outside any store): always
 *    the platform account (`scope: "platform"`, or no business context at all).
 *  - Customer OTP on a store's online-ordering page and staff alerts are the store's messages: its own
 *    account when it has the matching template, else the platform's.
 */
export interface SmsOptions {
  scope?: "business" | "platform";
  businessId?: string;
}

interface Msg91Account {
  authKey: string;
  otpTemplateId?: string;
  alertTemplateId?: string;
  source: "store" | "platform";
}

const base = () => env.MSG91_BASE_URL.replace(/\/+$/, "");

async function account(opts: SmsOptions, need: "otp" | "alert"): Promise<Msg91Account | null> {
  const businessId = opts.scope === "platform" ? undefined : (opts.businessId ?? currentBusinessId());
  if (businessId) {
    const i = await loadIntegration("SMS", businessId);
    if (i && isUsable(i)) {
      const c = i.config as { otpTemplateId?: string; alertTemplateId?: string };
      const a: Msg91Account = { authKey: i.secret("authKey"), otpTemplateId: c.otpTemplateId || undefined, alertTemplateId: c.alertTemplateId || undefined, source: "store" };
      if (a.authKey && (need === "otp" ? a.otpTemplateId : a.alertTemplateId)) return a;
    }
  }
  if (!env.MSG91_AUTH_KEY) return null;
  return { authKey: env.MSG91_AUTH_KEY, otpTemplateId: env.MSG91_TEMPLATE_ID, alertTemplateId: env.MSG91_ALERT_TEMPLATE_ID, source: "platform" };
}

/** MSG91's error, without the auth key (some gateways echo request headers). */
async function failure(what: string, res: Response, authKey: string) {
  return new Error(redactor(authKey)(`${what}: ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`));
}

async function postOtp(a: Msg91Account, phone: string, code: string) {
  const res = await fetch(`${base()}/api/v5/otp`, {
    method: "POST",
    headers: { authkey: a.authKey, "content-type": "application/json" },
    body: JSON.stringify({ template_id: a.otpTemplateId, mobile: `91${phone}`, otp: code }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw await failure("MSG91 failed", res, a.authKey);
}

async function postFlow(a: Msg91Account, to: string, message: string) {
  const res = await fetch(`${base()}/api/v5/flow`, {
    method: "POST",
    headers: { authkey: a.authKey, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ template_id: a.alertTemplateId, short_url: "0", recipients: [{ mobiles: to, message }] }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw await failure("MSG91 flow failed", res, a.authKey);
  // MSG91 answers 200 with {type:"error"} for a bad key / template.
  const body = (await res.json().catch(() => ({}))) as { type?: string; message?: string };
  if (body.type === "error") throw new Error(redactor(a.authKey)(`MSG91: ${String(body.message ?? "error").slice(0, 200)}`));
}

/** Send an OTP via MSG91. Returns false when SMS is not configured (dev mode). */
export async function sendOtpSms(phone: string, code: string, opts: SmsOptions = {}): Promise<boolean> {
  const a = await account(opts, "otp");
  if (!a?.otpTemplateId) {
    console.info(`[sms:dev] OTP for ${phone}: ${code}`);
    return false;
  }
  await postOtp(a, phone, code);
  return true;
}

/** Normalise an Indian mobile number to 91XXXXXXXXXX. */
export function msisdn(phone: string): string | null {
  const digits = phone.replace(/\D/g, "").replace(/^0+/, "");
  if (/^[6-9]\d{9}$/.test(digits)) return `91${digits}`;
  if (/^91[6-9]\d{9}$/.test(digits)) return digits;
  return null;
}

/**
 * Send a transactional SMS alert through the MSG91 Flow API. The DLT-approved flow template
 * (the store's alert template, or MSG91_ALERT_TEMPLATE_ID) must have a `##message##` variable.
 * Returns false (and logs) when SMS is not configured.
 */
export async function sendSms(phone: string, text: string, opts: SmsOptions = {}): Promise<boolean> {
  const to = msisdn(phone);
  if (!to) {
    console.warn(`[sms] invalid phone number ${phone}`);
    return false;
  }
  const message = text.slice(0, 300);
  const a = await account(opts, "alert");
  if (!a?.alertTemplateId) {
    console.info(`[sms:dev] to ${to}: ${message}`);
    return false;
  }
  await postFlow(a, to, message);
  return true;
}

/** "Test" for a store's MSG91 account: one real SMS to the owner's phone. Never throws. */
export async function testStoreSms(cfg: { authKey: string; otpTemplateId?: string; alertTemplateId?: string }, phone: string): Promise<{ ok: boolean; message: string }> {
  const to = msisdn(phone);
  if (!to) return { ok: false, message: "Enter a 10-digit Indian mobile number" };
  const a: Msg91Account = { ...cfg, source: "store" };
  try {
    if (a.alertTemplateId) await postFlow(a, to, "CANAVO test message: your store's SMS settings work.");
    else await postOtp(a, to.slice(2), String(Math.floor(100000 + Math.random() * 900000)));
    return { ok: true, message: `MSG91 accepted a test SMS to ${to.slice(0, 2)}••••••${to.slice(-4)}` };
  } catch (e) {
    return { ok: false, message: redactor(cfg.authKey)(e instanceof Error ? (e.name === "TimeoutError" ? "MSG91 did not answer in 10 s" : e.message) : "error").slice(0, 200) };
  }
}
