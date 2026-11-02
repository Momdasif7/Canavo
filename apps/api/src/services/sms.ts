import { env, isProd } from "../env";

/** Send an OTP via MSG91. Returns false when SMS is not configured (dev mode). */
export async function sendOtpSms(phone: string, code: string): Promise<boolean> {
  if (!env.MSG91_AUTH_KEY || !env.MSG91_TEMPLATE_ID) {
    // BUG-015: OTPs are credentials — never log them (or the number) in production.
    if (isProd) console.error("[sms] MSG91 is not configured — OTP SMS cannot be sent");
    else console.info(`[sms:dev] OTP for ${phone}: ${code}`);
    return false;
  }
  const res = await fetch("https://control.msg91.com/api/v5/otp", {
    method: "POST",
    headers: { authkey: env.MSG91_AUTH_KEY, "content-type": "application/json" },
    body: JSON.stringify({ template_id: env.MSG91_TEMPLATE_ID, mobile: `91${phone}`, otp: code }),
  });
  if (!res.ok) throw new Error(`MSG91 failed: ${res.status} ${await res.text()}`);
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
 * Send a transactional SMS alert through the MSG91 Flow API. The DLT-approved
 * flow template (MSG91_ALERT_TEMPLATE_ID) must have a `##message##` variable.
 * Returns false (and logs) when SMS is not configured.
 */
export async function sendSms(phone: string, text: string): Promise<boolean> {
  const to = msisdn(phone);
  if (!to) {
    console.warn(`[sms] invalid phone number ${phone}`);
    return false;
  }
  const message = text.slice(0, 300);
  if (!env.MSG91_AUTH_KEY || !env.MSG91_ALERT_TEMPLATE_ID) {
    console.info(`[sms:dev] to ${to}: ${message}`);
    return false;
  }
  const res = await fetch("https://control.msg91.com/api/v5/flow", {
    method: "POST",
    headers: { authkey: env.MSG91_AUTH_KEY, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ template_id: env.MSG91_ALERT_TEMPLATE_ID, short_url: "0", recipients: [{ mobiles: to, message }] }),
  });
  if (!res.ok) throw new Error(`MSG91 flow failed: ${res.status} ${await res.text()}`);
  return true;
}
