import path from "node:path";
import { writeFile, mkdir } from "node:fs/promises";
import nodemailer, { type Transporter } from "nodemailer";
import { env } from "../env";
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

let transporter: Transporter | undefined;

export const smtpConfigured = () => Boolean(env.SMTP_HOST);

/**
 * Send an email via SMTP. Without SMTP_HOST the email (HTML + attachments +
 * meta.json) is written to storage/outbox/<timestamp>-<slug>/ instead.
 */
export async function sendMail(mail: Mail): Promise<{ delivered: boolean; outboxPath?: string; messageId?: string }> {
  const from = env.SMTP_FROM ?? "CANAVO Reports <reports@canavo.local>";
  if (smtpConfigured()) {
    transporter ??= nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
    const info = await transporter.sendMail({ from, ...mail });
    console.info(`[mail] sent "${mail.subject}" to ${[mail.to].flat().join(", ")} (${info.messageId})`);
    return { delivered: true, messageId: info.messageId };
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
