import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { passwordProblems } from "@canavo/shared";
import { platformPrisma } from "../db";
import { env, isProd } from "../env";
import { badRequest } from "../lib/http";
import { forceLogout, sha256 } from "../lib/tokens";
import { sendMail, smtpConfigured } from "./mailer";
import { sendSms } from "./sms";
import { smsFor } from "./integrations";

/**
 * One-time password links (Phase 2.2). The platform and owners never type or see a
 * user's password: they send a link, and the user sets the password themselves.
 *  - RESET: "forgot password" or sent by an admin; valid 30 minutes.
 *  - INVITE: a new account's first password; valid 72 hours.
 * The link carries the token in the URL fragment (#token=…), so it never reaches
 * server logs or Referer headers. Sending a new link cancels older unused ones.
 * Password links work across hotels, so this service uses the platform client.
 */
export type PasswordLinkPurpose = "RESET" | "INVITE";
const TTL_MS: Record<PasswordLinkPurpose, number> = { RESET: 30 * 60_000, INVITE: 72 * 60 * 60_000 };
const db = platformPrisma;

export interface LinkUser {
  id: string;
  name: string;
  email: string | null;
  phone: string;
}

export interface LinkDelivery {
  channel: "email" | "sms" | "none";
  /** Development only (never in production): the link itself, for testing without email/SMS */
  devLink?: string;
  expiresAt: Date;
}

/** SMS alerts set up for this business (its own MSG91 account, else the platform's). */
export const smsConfigured = async (businessId?: string) => Boolean(await smsFor("alert", businessId));

export async function createPasswordLink(userId: string, purpose: PasswordLinkPurpose, requestedBy?: string) {
  const raw = crypto.randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + TTL_MS[purpose]);
  await db.$transaction(async (tx) => {
    await tx.passwordResetToken.updateMany({ where: { userId, usedAt: null }, data: { usedAt: new Date() } });
    await tx.passwordResetToken.create({ data: { userId, tokenHash: sha256(raw), purpose, expiresAt, requestedBy } });
  });
  const url = `${env.WEB_APP_URL.replace(/\/$/, "")}/reset-password#token=${raw}`;
  return { url, expiresAt };
}

/**
 * Email if the user has an address and email is set up, otherwise SMS; in development the link is
 * logged and returned. A hotel's staff get it through the hotel's own email / SMS account when it
 * connected one (Settings → Integrations), else through the platform's; platform users always
 * through the platform's.
 */
export async function sendPasswordLink(user: LinkUser, purpose: PasswordLinkPurpose, requestedBy?: string): Promise<LinkDelivery> {
  const { url, expiresAt } = await createPasswordLink(user.id, purpose, requestedBy);
  const invite = purpose === "INVITE";
  const validFor = invite ? "72 hours" : "30 minutes";
  const businessId = (await db.user.findUnique({ where: { id: user.id }, select: { businessId: true } }))?.businessId ?? undefined;
  if (user.email && (await smtpConfigured(businessId))) {
    await sendMail({
      to: user.email,
      subject: invite ? "Set your CANAVO password" : "Reset your CANAVO password",
      html:
        `<p>Hello ${escapeHtml(user.name)},</p>` +
        `<p>${invite ? "Your CANAVO account is ready. Set your password to sign in:" : "Use this link to set a new CANAVO password:"}</p>` +
        `<p><a href="${url}">${invite ? "Set my password" : "Reset my password"}</a></p>` +
        `<p>The link works once and expires in ${validFor}. If you didn't ask for this, ignore this email; your password stays the same.</p>`,
    }, businessId);
    return { channel: "email", expiresAt };
  }
  if (await smsConfigured(businessId)) {
    await sendSms(user.phone, `CANAVO: ${invite ? "set" : "reset"} your password (valid ${validFor}, one use): ${url}`, businessId);
    return { channel: "sms", expiresAt };
  }
  if (isProd) {
    // Unreachable with the production config check (D13); never log a live link in production.
    console.error(`[password-link] no email or SMS configured; link for user ${user.id} not delivered`);
    return { channel: "none", expiresAt };
  }
  console.info(`[password-link:dev] ${purpose} link for ${user.email ?? user.phone}: ${url}`);
  return { channel: "none", devLink: url, expiresAt };
}

/** Set the password from a link. Signs the user out everywhere and clears any login lockout. */
export async function consumePasswordLink(raw: string, password: string) {
  const row = await db.passwordResetToken.findUnique({
    where: { tokenHash: sha256(raw) },
    include: { user: { select: { id: true, name: true, email: true, phone: true, status: true } } },
  });
  if (!row || row.usedAt || row.expiresAt < new Date() || row.user.status !== "ACTIVE") {
    throw badRequest("This link has expired or was already used. Ask for a new one.");
  }
  const problems = passwordProblems(password, [row.user.name, row.user.email, row.user.phone]);
  if (problems.length) throw badRequest(problems.join(". "));
  const passwordHash = await bcrypt.hash(password, 10);
  const claimed = await db.$transaction(async (tx) => {
    // Single use even under a double submit: only one request flips usedAt.
    const r = await tx.passwordResetToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } });
    if (!r.count) return false;
    await tx.user.update({ where: { id: row.userId }, data: { passwordHash, failedLogins: 0, lockedUntil: null } });
    return true;
  });
  if (!claimed) throw badRequest("This link has expired or was already used. Ask for a new one.");
  await forceLogout(row.userId);
  return { userId: row.userId, purpose: row.purpose };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
