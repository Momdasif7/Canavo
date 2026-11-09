import path from "node:path";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { writeFile, mkdir } from "node:fs/promises";
import nodemailer, { type Transporter } from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { env, isProd } from "../env";
import { isInternalHost } from "../lib/safe-url";
import { currentBusinessId } from "../lib/tenant";
import { isUsable, loadIntegration, redactor, type LoadedIntegration } from "./integrations";
import { storageDir } from "./storage";
import { mailApiConfigured, sendViaMailApi } from "./mail-api";

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

export interface MailOptions {
  /**
   * "platform": CANAVO's own mail (password links, platform alerts) — always the env SMTP_* account.
   * "business" (default): the store's own SMTP (Settings → Integrations → Email) when it has one,
   * else the platform account.
   */
  scope?: "business" | "platform";
  /** Defaults to the current business context */
  businessId?: string;
}

let platformTransporter: Transporter | undefined;
/** One transporter per store, rebuilt when its settings change. */
const storeTransporters = new Map<string, { version: string; t: Transporter }>();

/** Platform email is set up: SMTP, or an HTTPS email API (Brevo / Resend). */
export const smtpConfigured = () => Boolean(env.SMTP_HOST) || mailApiConfigured();

/** Ports a store may point its SMTP at in production (no probing other services through "Test"). */
export const SMTP_PORTS = [25, 465, 587, 2525];

/** null when the host/port may be used, else the reason (shown to the owner). */
export function smtpHostError(host: string, port: number, production = isProd): string | null {
  const h = host.trim().toLowerCase();
  if (!h || h.length > 253 || !/^[a-z0-9.-]+$|^[0-9a-f:]+$/.test(h)) return "Enter the SMTP server name only, e.g. smtp.gmail.com (no http://, no port)";
  if (production && isInternalHost(h)) return "The SMTP server must be a public mail server, not an internal address";
  if (production && !SMTP_PORTS.includes(port)) return `SMTP port must be one of ${SMTP_PORTS.join(", ")}`;
  return null;
}

/**
 * Connection options for a store's SMTP. In production the host is resolved here and refused when it
 * points into the internal network (DNS rebinding); the connection then goes to the checked address,
 * with the name kept for the TLS certificate check.
 */
export async function storeSmtpOptions(
  i: LoadedIntegration,
  production = isProd,
  resolve: (host: string) => Promise<string[]> = async (host) => (await lookup(host, { all: true })).map((a) => a.address),
): Promise<SMTPTransport.Options> {
  const c = i.config as { host: string; port?: number; secure?: boolean; user?: string };
  const port = Number(c.port ?? 587);
  const reason = smtpHostError(c.host, port, production);
  if (reason) throw new Error(reason);
  let connectHost = c.host;
  if (production) {
    const addrs = isIP(c.host) ? [c.host] : await resolve(c.host);
    if (!addrs.length || addrs.some((a) => isInternalHost(a))) throw new Error("The SMTP server resolves to an internal network address");
    connectHost = addrs[0]!;
  }
  return {
    host: connectHost,
    port,
    secure: c.secure ?? port === 465,
    auth: c.user ? { user: c.user, pass: i.secret("password") } : undefined,
    ...(!isIP(c.host) && { tls: { servername: c.host } }),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  };
}

export const storeFrom = (i: LoadedIntegration) => {
  const c = i.config as { fromEmail: string; fromName?: string };
  return c.fromName ? `"${c.fromName.replace(/["\\\r\n]/g, "")}" <${c.fromEmail}>` : c.fromEmail;
};

async function storeTransporter(i: LoadedIntegration): Promise<Transporter> {
  const version = i.updatedAt.toISOString();
  const cached = storeTransporters.get(i.businessId);
  if (cached && cached.version === version) return cached.t;
  cached?.t.close();
  const t = nodemailer.createTransport(await storeSmtpOptions(i));
  storeTransporters.set(i.businessId, { version, t });
  return t;
}

/**
 * Send an email via SMTP (the store's own account or the platform's). Without any SMTP the email
 * (HTML + attachments + meta.json) is written to storage/outbox/<timestamp>-<slug>/ instead.
 */
export async function sendMail(mail: Mail, opts: MailOptions = {}): Promise<{ delivered: boolean; outboxPath?: string; messageId?: string; via?: "store" | "platform" }> {
  const businessId = opts.scope === "platform" ? undefined : (opts.businessId ?? currentBusinessId());
  const store = businessId ? await loadIntegration("SMTP", businessId) : null;
  if (store && isUsable(store)) {
    const redact = redactor(store.secret("password"));
    try {
      const info = await (await storeTransporter(store)).sendMail({ from: storeFrom(store), ...mail });
      console.info(`[mail] sent "${mail.subject}" via the store's SMTP (${info.messageId})`);
      return { delivered: true, messageId: info.messageId, via: "store" };
    } catch (e) {
      storeTransporters.delete(store.businessId);
      // The store's server refused: report it without anything secret (the caller logs / shows it).
      throw new Error(redact(`Store SMTP failed: ${e instanceof Error ? e.message : "error"}`).slice(0, 300));
    }
  }
  const from = env.SMTP_FROM ?? "CANAVO Reports <reports@canavo.local>";
  if (mailApiConfigured()) {
    const { messageId } = await sendViaMailApi(mail, from);
    console.info(`[mail] sent "${mail.subject}" to ${[mail.to].flat().join(", ")} via ${env.MAIL_API_PROVIDER} (${messageId ?? "no id"})`);
    return { delivered: true, messageId, via: "platform" };
  }
  if (env.SMTP_HOST) {
    platformTransporter ??= nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
    const info = await platformTransporter.sendMail({ from, ...mail });
    console.info(`[mail] sent "${mail.subject}" to ${[mail.to].flat().join(", ")} (${info.messageId})`);
    return { delivered: true, messageId: info.messageId, via: "platform" };
  }
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

/** "Test connection" for a store's SMTP: connect + log in, and optionally send a test email. Never throws. */
export async function testStoreSmtp(i: LoadedIntegration, to?: string): Promise<{ ok: boolean; message: string }> {
  const redact = redactor(i.secret("password"));
  let t: Transporter | undefined;
  try {
    t = nodemailer.createTransport(await storeSmtpOptions(i));
    await t.verify();
    if (to) {
      await t.sendMail({ from: storeFrom(i), to, subject: "CANAVO test email", html: "<p>Your store's email settings work. Reports and notifications will be sent from this address.</p>" });
      return { ok: true, message: `Connected and sent a test email to ${to}` };
    }
    return { ok: true, message: "Connected and logged in to the SMTP server" };
  } catch (e) {
    return { ok: false, message: redact(e instanceof Error ? e.message : "SMTP error").slice(0, 200) };
  } finally {
    t?.close();
  }
}
