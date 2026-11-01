import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { platformPrisma } from "../db";
import { env } from "../env";
import { decrypt, encrypt } from "../lib/crypto";
import { conflict, badRequest, unauthorized } from "../lib/http";
import { sha256 } from "../lib/tokens";
import { generateRecoveryCodes, generateTotpSecret, normalizeRecoveryCode, otpauthUri, verifyTotp } from "../lib/totp";

/**
 * Two-step login (Phase 2.1): password (or phone OTP), then a 6-digit code from an
 * authenticator app — or one of 10 single-use recovery codes. Opt-in per user; a hotel can
 * require it for owners and managers (feature flag REQUIRE_2FA).
 * Login and 2FA cross hotels (they run before a tenant is known), so this uses the platform
 * client; routes only ever pass the signed-in user's own id, or one they may manage.
 */
const db = platformPrisma;
const MFA_TTL_SECONDS = 5 * 60;
/** Separate key from access tokens, so an MFA ticket can never be used as an access token. */
const mfaKey = () => crypto.createHmac("sha256", env.JWT_ACCESS_SECRET).update("canavo:mfa-ticket").digest();

const recoveryHash = (userId: string, code: string) => sha256(`${userId}:${normalizeRecoveryCode(code)}`);

export async function twoFactorStatus(userId: string) {
  const u = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { totpEnabledAt: true } });
  const recoveryCodesLeft = u.totpEnabledAt ? await db.recoveryCode.count({ where: { userId, usedAt: null } }) : 0;
  return { enabled: Boolean(u.totpEnabledAt), enabledAt: u.totpEnabledAt, recoveryCodesLeft };
}

/** Start setup: a new secret (not active until confirmed with a code). */
export async function beginTwoFactorSetup(user: { id: string; email: string | null; phone: string }) {
  const current = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { totpEnabledAt: true } });
  if (current.totpEnabledAt) throw conflict("Two-step login is already on. Turn it off first to move it to a new phone.");
  const secret = generateTotpSecret();
  await db.user.update({ where: { id: user.id }, data: { totpSecretEnc: encrypt(secret), totpLastStep: null } });
  return { secret, otpauthUri: otpauthUri(secret, user.email ?? user.phone) };
}

async function replaceRecoveryCodes(userId: string) {
  const codes = generateRecoveryCodes();
  await db.$transaction(async (tx) => {
    await tx.recoveryCode.deleteMany({ where: { userId } });
    await tx.recoveryCode.createMany({ data: codes.map((c) => ({ userId, codeHash: recoveryHash(userId, c) })) });
  });
  return codes;
}

/** Confirm setup with a code from the app; returns the recovery codes (shown once). */
export async function enableTwoFactor(userId: string, code: string) {
  const u = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { totpSecretEnc: true, totpEnabledAt: true } });
  if (u.totpEnabledAt) throw conflict("Two-step login is already on");
  if (!u.totpSecretEnc) throw badRequest("Start the setup first");
  const step = verifyTotp(decrypt(u.totpSecretEnc), code, null);
  if (step === null) throw badRequest("That code doesn't match. Check the phone's time is automatic and try the newest code.");
  await db.user.update({ where: { id: userId }, data: { totpEnabledAt: new Date(), totpLastStep: step } });
  return replaceRecoveryCodes(userId);
}

/** Check an app code or a recovery code; each can be used once. */
export async function checkSecondFactor(userId: string, input: { code?: string; recoveryCode?: string }): Promise<"totp" | "recovery" | null> {
  const u = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { totpSecretEnc: true, totpEnabledAt: true, totpLastStep: true } });
  if (!u.totpEnabledAt || !u.totpSecretEnc) return null;
  if (input.code) {
    const step = verifyTotp(decrypt(u.totpSecretEnc), input.code, u.totpLastStep);
    if (step === null) return null;
    // Compare-and-set: two requests racing with the same code can't both pass.
    const r = await db.user.updateMany({
      where: { id: userId, OR: [{ totpLastStep: null }, { totpLastStep: { lt: step } }] },
      data: { totpLastStep: step },
    });
    return r.count ? "totp" : null;
  }
  if (input.recoveryCode) {
    const r = await db.recoveryCode.updateMany({ where: { userId, codeHash: recoveryHash(userId, input.recoveryCode), usedAt: null }, data: { usedAt: new Date() } });
    return r.count ? "recovery" : null;
  }
  return null;
}

export async function regenerateRecoveryCodes(userId: string) {
  const { enabled } = await twoFactorStatus(userId);
  if (!enabled) throw badRequest("Two-step login is off");
  return replaceRecoveryCodes(userId);
}

/** Turn off (by the user after re-checking, or reset by an owner / the platform). */
export async function disableTwoFactor(userId: string) {
  await db.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null } });
    await tx.recoveryCode.deleteMany({ where: { userId } });
  });
}

// ---------- Login ticket between the first and the second step ----------

export function signMfaTicket(user: { id: string; tokenVersion: number }) {
  return jwt.sign({ sub: user.id, tv: user.tokenVersion }, mfaKey(), { expiresIn: MFA_TTL_SECONDS, audience: "canavo-mfa" });
}

export function verifyMfaTicket(ticket: string): { sub: string; tv: number } {
  try {
    return jwt.verify(ticket, mfaKey(), { audience: "canavo-mfa" }) as { sub: string; tv: number };
  } catch {
    throw unauthorized("The sign-in step expired. Start again.");
  }
}

export const MFA_TICKET_TTL_SECONDS = MFA_TTL_SECONDS;
