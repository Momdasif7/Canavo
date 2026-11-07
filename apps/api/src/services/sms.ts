import { currentBusinessId } from "../lib/tenant";
import { MSG91_BASE, redact, smsFor, type SmsCreds } from "./integrations";

/** A provider failure for logs and callers: status + its message, the auth key stripped. */
async function msg91Error(res: Response, c: SmsCreds, what: string): Promise<Error> {
  const text = (await res.text().catch(() => "")).slice(0, 300);
  return new Error(redact(`${what}: ${res.status} ${text}`, [c.authKey]));
}

/**
 * Send an OTP via MSG91 with the business's own account (Settings → Integrations), else the
 * platform's. Returns false when SMS is not configured (dev mode).
 */
export async function sendOtpSms(phone: string, code: string, businessId = currentBusinessId()): Promise<boolean> {
  const c = await smsFor("otp", businessId);
  if (!c) {
    console.info(`[sms:dev] OTP for ${phone}: ${code}`);
    return false;
  }
  const res = await fetch(`${MSG91_BASE}/api/v5/otp`, {
    method: "POST",
    headers: { authkey: c.authKey, "content-type": "application/json" },
    body: JSON.stringify({ template_id: c.templateId, mobile: `91${phone}`, otp: code }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw await msg91Error(res, c, "MSG91 failed");
  return true;
}

/** Normalise an Indian mobile number to 91XXXXXXXXXX. */
export function msisdn(phone: string): string | null {
  const digits = phone.replace(/\D/g, "").replace(/^0+/, "");
  if (/^[6-9]\d{9}$/.test(digits)) return `91${digits}`;
  if (/^91[6-9]\d{9}$/.test(digits)) return digits;
  return null;
}

async function flow(c: SmsCreds, to: string, message: string): Promise<Response> {
  return fetch(`${MSG91_BASE}/api/v5/flow`, {
    method: "POST",
    headers: { authkey: c.authKey, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ template_id: c.templateId, short_url: "0", recipients: [{ mobiles: to, message }] }),
    signal: AbortSignal.timeout(15_000),
  });
}

/**
 * Send a transactional SMS alert through the MSG91 Flow API (the business's account, else the
 * platform's). The DLT-approved flow template must have a `##message##` variable.
 * Returns false (and logs) when SMS is not configured.
 */
export async function sendSms(phone: string, text: string, businessId = currentBusinessId()): Promise<boolean> {
  const to = msisdn(phone);
  if (!to) {
    console.warn(`[sms] invalid phone number ${phone}`);
    return false;
  }
  const message = text.slice(0, 300);
  const c = await smsFor("alert", businessId);
  if (!c) {
    console.info(`[sms:dev] to ${to}: ${message}`);
    return false;
  }
  const res = await flow(c, to, message);
  if (!res.ok) throw await msg91Error(res, c, "MSG91 flow failed");
  return true;
}

/**
 * "Test connection" for a store's MSG91 account: an alert SMS to a number the owner typed
 * (MSG91 has no harmless "who am I" call). Short messages only, never the provider's body.
 */
export async function testSms(c: SmsCreds, phone: string): Promise<{ ok: boolean; message: string }> {
  const to = msisdn(phone);
  if (!to) return { ok: false, message: "Enter a 10-digit Indian mobile number" };
  try {
    const res = await flow(c, to, "CANAVO test: SMS is connected.");
    const body = (await res.json().catch(() => ({}))) as { type?: string; message?: string };
    if (res.status === 401 || /auth/i.test(body.message ?? "")) return { ok: false, message: "MSG91 refused the auth key" };
    if (!res.ok || body.type === "error") return { ok: false, message: redact(`MSG91 answered ${res.status}${body.message ? `: ${body.message}` : ""}`, [c.authKey]).slice(0, 160) };
    return { ok: true, message: `Test SMS sent to ${to.slice(-10)}` };
  } catch (e) {
    return { ok: false, message: (e as Error).name === "TimeoutError" ? "MSG91 did not answer in 15 s" : "Couldn't reach MSG91" };
  }
}
