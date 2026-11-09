/**
 * Platform email over HTTPS for hosts that block outgoing SMTP ports — e.g. Render's free plan.
 * MAIL_API_PROVIDER = brevo | resend (MAIL_API_KEY) or gmail (GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET /
 * GMAIL_REFRESH_TOKEN, OAuth scope gmail.send). The sender is SMTP_FROM ("Name <address>").
 */
import MailComposer from "nodemailer/lib/mail-composer";
import { env } from "../env";
import type { Mail } from "./mailer";

export type MailApiProvider = "brevo" | "resend" | "gmail";

const BASE: Record<MailApiProvider, string> = { brevo: "https://api.brevo.com", resend: "https://api.resend.com", gmail: "https://gmail.googleapis.com" };

/** "CANAVO <a@b.co>" → { name: "CANAVO", email: "a@b.co" }; a bare address has no name. */
export function parseFrom(from: string): { name?: string; email: string } {
  const m = from.match(/^\s*(.*?)\s*<\s*([^>\s]+)\s*>\s*$/);
  if (m) return { ...(m[1] && { name: m[1].replace(/^"|"$/g, "") }), email: m[2]! };
  return { email: from.trim() };
}

/** The provider's request for one email (pure — unit-tested). */
export function mailApiRequest(provider: Exclude<MailApiProvider, "gmail">, apiKey: string, from: string, mail: Mail, baseUrl = BASE[provider]): { url: string; headers: Record<string, string>; body: object } {
  const to = [mail.to].flat();
  const files = (mail.attachments ?? []).map((a) => ({ name: a.filename, content: a.content.toString("base64") }));
  if (provider === "brevo") {
    return {
      url: `${baseUrl.replace(/\/+$/, "")}/v3/smtp/email`,
      headers: { "api-key": apiKey, "content-type": "application/json", accept: "application/json" },
      body: {
        sender: parseFrom(from),
        to: to.map((email) => ({ email })),
        subject: mail.subject,
        htmlContent: mail.html,
        ...(files.length && { attachment: files }),
      },
    };
  }
  return {
    url: `${baseUrl.replace(/\/+$/, "")}/emails`,
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: {
      from,
      to,
      subject: mail.subject,
      html: mail.html,
      ...(files.length && { attachments: files.map((f) => ({ filename: f.name, content: f.content })) }),
    },
  };
}

export const mailApiConfigured = () =>
  env.MAIL_API_PROVIDER === "gmail"
    ? Boolean(env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET && env.GMAIL_REFRESH_TOKEN)
    : Boolean(env.MAIL_API_PROVIDER && env.MAIL_API_KEY);

/** RFC 822 message (with attachments) as base64url, the form the Gmail API sends. */
export async function gmailRaw(from: string, mail: Mail): Promise<string> {
  const msg = new MailComposer({ from, to: mail.to, subject: mail.subject, html: mail.html, attachments: mail.attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })) });
  const buf: Buffer = await new Promise((resolve, reject) => msg.compile().build((err, b) => (err ? reject(err) : resolve(b))));
  return buf.toString("base64url");
}

let gmailToken: { value: string; expiresAt: number } | undefined;
/** Short-lived access token from the stored refresh token (cached until a minute before expiry). */
async function gmailAccessToken(): Promise<string> {
  if (gmailToken && gmailToken.expiresAt > Date.now() + 60_000) return gmailToken.value;
  const res = await fetch(env.GMAIL_TOKEN_URL ?? "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.GMAIL_CLIENT_ID!, client_secret: env.GMAIL_CLIENT_SECRET!, refresh_token: env.GMAIL_REFRESH_TOKEN!, grant_type: "refresh_token" }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string };
  if (!res.ok || !j.access_token) throw new Error(`gmail token refresh failed (${res.status})${j.error ? `: ${j.error}` : ""}`);
  gmailToken = { value: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 };
  return gmailToken.value;
}

/** Send through the provider; throws with the provider's short reason (never the key) on failure. */
export async function sendViaMailApi(mail: Mail, from: string): Promise<{ messageId?: string }> {
  const provider = env.MAIL_API_PROVIDER as MailApiProvider;
  if (provider === "gmail") {
    const res = await fetch(`${(env.MAIL_API_BASE_URL ?? BASE.gmail).replace(/\/+$/, "")}/gmail/v1/users/me/messages/send`, {
      method: "POST",
      headers: { authorization: `Bearer ${await gmailAccessToken()}`, "content-type": "application/json" },
      body: JSON.stringify({ raw: await gmailRaw(from, mail) }),
      signal: AbortSignal.timeout(20_000),
    });
    const j = (await res.json().catch(() => ({}))) as { id?: string; error?: { message?: string } };
    if (!res.ok) throw new Error(`gmail email failed (${res.status})${j.error?.message ? `: ${j.error.message.slice(0, 160)}` : ""}`);
    return { messageId: j.id };
  }
  const req = mailApiRequest(provider, env.MAIL_API_KEY!, from, mail, env.MAIL_API_BASE_URL ?? BASE[provider]);
  const res = await fetch(req.url, { method: "POST", headers: req.headers, body: JSON.stringify(req.body), signal: AbortSignal.timeout(15_000) });
  const text = await res.text();
  let json: { messageId?: string; id?: string; message?: string } = {};
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (!res.ok) throw new Error(`${provider} email failed (${res.status})${json.message ? `: ${String(json.message).slice(0, 160)}` : ""}`);
  return { messageId: json.messageId ?? json.id };
}
