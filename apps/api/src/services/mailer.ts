import path from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import nodemailer, { type Transporter } from "nodemailer";
import { currentBusinessId } from "../lib/tenant";
import { platformSmtp, redact, smtpConnectTarget, smtpFor, SmtpBlockedError, type Resolve, type SmtpCreds } from "./integrations";
import { storageDir } from "./storage";

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface Mail {
  to: string | string[];
  subject: string;
  html: string;
  attachments?: MailAttachment[];
}

/** The platform (.env) transport is reused; a store's is built per send from its saved settings. */
let platformTransporter: Transporter | undefined;

/** Is email set up for this business (its own server, or the platform's)? */
export const smtpConfigured = async (businessId = currentBusinessId()) => Boolean(await smtpFor(businessId));

async function transportFor(c: SmtpCreds, resolve?: Resolve): Promise<Transporter> {
  if (c.source === "platform") {
    return (platformTransporter ??= nodemailer.createTransport({
      host: c.host,
      port: c.port,
      secure: c.secure,
      auth: c.user ? { user: c.user, pass: c.pass } : undefined,
    }));
  }
  // Owner-supplied server: connect only to a checked public address (SSRF guard), short timeouts.
  const target = await smtpConnectTarget(c, resolve);
  return nodemailer.createTransport({
    host: target.host,
    port: c.port,
    secure: c.secure,
    auth: c.user ? { user: c.user, pass: c.pass } : undefined,
    ...(target.servername && { tls: { servername: target.servername } }),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  });
}

/**
 * Send an email with the business's own mail server, else the platform's (SMTP_*).
 * Without either, the email (HTML + attachments + meta.json) is written to
 * storage/outbox/<timestamp>-<slug>/ instead.
 */
export async function sendMail(mail: Mail, businessId = currentBusinessId()): Promise<{ delivered: boolean; outboxPath?: string; messageId?: string }> {
  const smtp = await smtpFor(businessId);
  if (smtp) {
    try {
      const info = await (await transportFor(smtp)).sendMail({ from: smtp.from, ...mail });
      console.info(`[mail] sent "${mail.subject}" to ${[mail.to].flat().join(", ")} via ${smtp.source} server (${info.messageId})`);
      return { delivered: true, messageId: info.messageId };
    } catch (e) {
      // Never let a provider message carrying the password reach logs or callers.
      throw new Error(`Email not sent: ${redact((e as Error).message, [smtp.pass])}`.slice(0, 300));
    }
  }
  const from = platformSmtp()?.from ?? "CANAVO Reports <reports@canavo.local>";
  const slug = mail.subject.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 50);
  const dir = path.join(storageDir("outbox"), `${new Date().toISOString().replace(/[:.]/g, "-")}-${slug}`);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "email.html"), mail.html);
  for (const a of mail.attachments ?? []) await writeFile(path.join(dir, path.basename(a.filename)), a.content);
  await writeFile(
    path.join(dir, "meta.json"),
    JSON.stringify({ from, to: mail.to, subject: mail.subject, attachments: (mail.attachments ?? []).map((a) => a.filename), createdAt: new Date() }, null, 2),
  );
  console.info(`[mail:outbox] SMTP not configured — wrote "${mail.subject}" for ${[mail.to].flat().join(", ")} to ${dir}`);
  return { delivered: false, outboxPath: dir };
}

/**
 * "Test connection" for a store's mail server: connect and log in (nodemailer verify()), no email
 * sent. Messages are generic on purpose: the button can't be used to map hosts or ports.
 */
export async function testSmtp(c: SmtpCreds, resolve?: Resolve): Promise<{ ok: boolean; message: string }> {
  let transport: Transporter;
  try {
    transport = await transportFor(c, resolve);
  } catch (e) {
    if (e instanceof SmtpBlockedError) return { ok: false, message: e.message };
    return { ok: false, message: "Couldn't connect to the mail server" };
  }
  try {
    await transport.verify();
    return { ok: true, message: "Connected and signed in" };
  } catch (e) {
    const code = (e as { code?: string; responseCode?: number }).code;
    const responseCode = (e as { responseCode?: number }).responseCode;
    if (code === "EAUTH" || responseCode === 535) return { ok: false, message: "The mail server refused the user name or password" };
    if (code === "ETIMEDOUT" || code === "ECONNECTION" || code === "ESOCKET" || code === "ECONNREFUSED") return { ok: false, message: "Couldn't connect to the mail server. Check the server name, port and secure setting" };
    if (code === "ETLS") return { ok: false, message: "Secure connection failed. Try port 465 with Secure on, or 587 with it off" };
    return { ok: false, message: "The mail server didn't accept the connection" };
  } finally {
    transport.close?.();
  }
}
