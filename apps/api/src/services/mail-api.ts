/**
 * Platform email over HTTPS (Brevo / Resend) for hosts that block outgoing SMTP ports — e.g. Render's
 * free plan. Chosen with MAIL_API_PROVIDER + MAIL_API_KEY; the sender is SMTP_FROM ("Name <address>").
 */
import { env } from "../env";
import type { Mail } from "./mailer";

export type MailApiProvider = "brevo" | "resend";

const BASE: Record<MailApiProvider, string> = { brevo: "https://api.brevo.com", resend: "https://api.resend.com" };

/** "CANAVO <a@b.co>" → { name: "CANAVO", email: "a@b.co" }; a bare address has no name. */
export function parseFrom(from: string): { name?: string; email: string } {
  const m = from.match(/^\s*(.*?)\s*<\s*([^>\s]+)\s*>\s*$/);
  if (m) return { ...(m[1] && { name: m[1].replace(/^"|"$/g, "") }), email: m[2]! };
  return { email: from.trim() };
}

/** The provider's request for one email (pure — unit-tested). */
export function mailApiRequest(provider: MailApiProvider, apiKey: string, from: string, mail: Mail, baseUrl = BASE[provider]): { url: string; headers: Record<string, string>; body: object } {
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

export const mailApiConfigured = () => Boolean(env.MAIL_API_PROVIDER && env.MAIL_API_KEY);

/** Send through the provider; throws with the provider's short reason (never the key) on failure. */
export async function sendViaMailApi(mail: Mail, from: string): Promise<{ messageId?: string }> {
  const provider = env.MAIL_API_PROVIDER as MailApiProvider;
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
