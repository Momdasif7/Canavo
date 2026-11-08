import crypto from "node:crypto";
import { Router } from "express";
import { bcrypt } from "../lib/bcrypt-pool";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { FEATURE_KEYS, featureEnabled, normalizeFeatures, newPasswordSchema, passwordProblems,
  otpRequestSchema,
  type Role,
  otpVerifySchema,
  passwordLoginSchema,
  refreshSchema,
  effectivePermissions,
  isPlatformRole,
  normalizeBrand,
  normalizeModules,
  normalizeUserPreferences,
  userPreferencesUpdateSchema,
} from "@canavo/shared";
import { platformPrisma, prisma } from "../db";
import { isProd } from "../env";
import { badRequest, notFound, parse, unauthorized, HttpError } from "../lib/http";
import { disconnectSockets } from "../realtime";
import { issueSession, listSessions, revokeOtherSessions, revokeSession, rotateRefresh, sha256, type SessionMeta } from "../lib/tokens";
import { consumePasswordLink, sendPasswordLink } from "../services/password-links";
import {
  beginTwoFactorSetup,
  checkSecondFactor,
  disableTwoFactor,
  enableTwoFactor,
  MFA_TICKET_TTL_SECONDS,
  regenerateRecoveryCodes,
  signMfaTicket,
  twoFactorStatus,
  verifyMfaTicket,
} from "../services/two-factor";
import type { Request } from "express";
import { clearSessionCookies, cookieRefreshToken, readCookie, REFRESH_COOKIE, sendSession, setProbeCookie } from "../lib/session-cookies";
import { sendOtpSms } from "../services/sms";
import { authenticate, TWO_FACTOR_REQUIRED_ROLES } from "../middleware/auth";

export const authRouter = Router();

const MAX_FAILED = 5;
const LOCK_MS = 15 * 60 * 1000;
const OTP_TTL_MS = 5 * 60 * 1000;

// JSON like every other error (the default is a text/html body the apps can't show — QA BUG-007).
const tooMany = { error: "Too many attempts — please wait a few minutes and try again" };
const ipLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 50, standardHeaders: "draft-8", legacyHeaders: false, message: tooMany });
authRouter.use(["/login", "/otp", "/2fa/verify"], ipLimiter);
// Password links: few legitimate requests, so a tight limit (also slows enumeration and SMS/email abuse).
const linkLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false, message: tooMany });
authRouter.use("/password", linkLimiter);

const sessionMeta = (req: Request, deviceId?: string | null): SessionMeta => ({
  deviceId: deviceId ?? req.header("x-device-id") ?? undefined,
  ip: req.ip,
  userAgent: req.header("user-agent") ?? undefined,
});

/** Security events of hotel users are visible to their owner (businessId set), platform users' to the platform. */
async function securityAudit(req: Request, user: { id: string; businessId: string | null }, action: string, meta?: Record<string, string | number | boolean>) {
  await platformPrisma.auditLog.create({ data: { userId: user.id, businessId: user.businessId, action, entity: "User", entityId: user.id, meta, ip: req.ip } });
}

async function registerFailure(userId: string, failedLogins: number) {
  const failed = failedLogins + 1;
  await prisma.user.update({
    where: { id: userId },
    data: failed >= MAX_FAILED ? { failedLogins: 0, lockedUntil: new Date(Date.now() + LOCK_MS) } : { failedLogins: failed },
  });
}

function assertNotLocked(user: { lockedUntil: Date | null }) {
  if (user.lockedUntil && user.lockedUntil > new Date()) {
    const mins = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
    throw new HttpError(423, `Too many failed attempts. Try again in ${mins} min.`);
  }
}

authRouter.post("/login", async (req, res) => {
  const { email, password } = parse(passwordLoginSchema, req.body);
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (!user || !user.passwordHash || user.status !== "ACTIVE") throw unauthorized("Invalid email or password");
  await assertBusinessActive(user.businessId);
  assertNotLocked(user);
  if (!(await bcrypt.compare(password, user.passwordHash))) {
    await registerFailure(user.id, user.failedLogins);
    throw unauthorized("Invalid email or password");
  }
  const result = await completeFirstStep(req, user);
  if ("mfaRequired" in result) return res.json(result);
  sendSession(req, res, result);
});

/**
 * After the password / phone OTP: with two-step login on, return a short-lived ticket for
 * POST /auth/2fa/verify. The failure counter is NOT reset yet, so wrong codes still lead to
 * the lockout even for someone who knows the password.
 */
async function completeFirstStep(req: Request, user: { id: string; role: Role; tokenVersion: number; totpEnabledAt: Date | null }, deviceId?: string | null) {
  if (user.totpEnabledAt) {
    return { mfaRequired: true as const, mfaToken: signMfaTicket(user), expiresIn: MFA_TICKET_TTL_SECONDS, methods: ["totp", "recovery"] };
  }
  await platformPrisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null } });
  return issueSession(user, sessionMeta(req, deviceId));
}

authRouter.post("/otp/request", async (req, res) => {
  const { phone } = parse(otpRequestSchema, req.body);
  const user = await prisma.user.findUnique({ where: { phone } });
  // Same response whether or not the number is registered, to avoid enumeration.
  const response: Record<string, unknown> = { ok: true, expiresIn: OTP_TTL_MS / 1000 };
  if (!user || user.status !== "ACTIVE") return res.json(response);
  assertNotLocked(user);

  const recent = await prisma.otpCode.findFirst({ where: { phone }, orderBy: { createdAt: "desc" } });
  if (recent && Date.now() - recent.createdAt.getTime() < 30_000) {
    throw new HttpError(429, "Please wait 30 seconds before requesting another OTP");
  }
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  await prisma.otpCode.create({
    data: { phone, codeHash: sha256(`${phone}:${code}`), expiresAt: new Date(Date.now() + OTP_TTL_MS) },
  });
  const sent = await sendOtpSms(phone, code, { scope: "platform" });
  if (!sent && !isProd) response.devCode = code;
  res.json(response);
});

authRouter.post("/otp/verify", async (req, res) => {
  const { phone, code, deviceId } = parse(otpVerifySchema, req.body);
  const user = await prisma.user.findUnique({ where: { phone } });
  if (!user || user.status !== "ACTIVE") throw unauthorized("Invalid OTP");
  await assertBusinessActive(user.businessId);
  assertNotLocked(user);

  const otp = await prisma.otpCode.findFirst({
    where: { phone, consumed: false, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!otp || otp.codeHash !== sha256(`${phone}:${code}`)) {
    if (otp) await prisma.otpCode.update({ where: { id: otp.id }, data: { attempts: { increment: 1 }, consumed: otp.attempts + 1 >= MAX_FAILED } });
    await registerFailure(user.id, user.failedLogins);
    throw unauthorized("Invalid OTP");
  }
  await prisma.otpCode.update({ where: { id: otp.id }, data: { consumed: true } });
  const result = await completeFirstStep(req, user, deviceId);
  if ("mfaRequired" in result) return res.json(result);
  sendSession(req, res, result);
});

/** Refresh token from the body (mobile, storage-mode web) or from the httpOnly cookie (cookie-mode web, CSRF-checked). */
function presentedRefreshToken(req: Request): string {
  if (req.body?.refreshToken !== undefined) return parse(refreshSchema, req.body).refreshToken;
  const fromCookie = cookieRefreshToken(req);
  if (!fromCookie) throw unauthorized("Not signed in");
  return fromCookie;
}

authRouter.post("/refresh", async (req, res) => {
  const viaCookie = req.body?.refreshToken === undefined && Boolean(readCookie(req, REFRESH_COOKIE));
  try {
    const session = await rotateRefresh(presentedRefreshToken(req));
    if (viaCookie) req.headers["x-session-mode"] = "cookie";
    sendSession(req, res, session);
  } catch (e) {
    if (viaCookie && e instanceof HttpError && e.status === 401) clearSessionCookies(req, res);
    throw e;
  }
});

/** The web app checks it can read this cookie before using cookie sessions (D16 fallback). */
authRouter.post("/cookie-probe", (req, res) => {
  setProbeCookie(req, res);
  res.json({ ok: true });
});

authRouter.post("/logout", async (req, res) => {
  const viaCookie = req.body?.refreshToken === undefined;
  let refreshToken: string;
  try {
    refreshToken = presentedRefreshToken(req);
  } catch (e) {
    if (viaCookie) {
      clearSessionCookies(req, res);
      return res.status(204).end();
    }
    throw e;
  }
  if (viaCookie) clearSessionCookies(req, res);
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(refreshToken) } });
  if (row) {
    await prisma.refreshToken.updateMany({
      where: { familyId: row.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    disconnectSockets({ sid: row.familyId });
  }
  res.status(204).end();
});

// ---------- Two-step login (Phase 2.1) ----------

const secondFactorSchema = z
  .object({ code: z.string().trim().max(10).optional(), recoveryCode: z.string().trim().max(20).optional() })
  .refine((v) => v.code || v.recoveryCode, "Enter the 6-digit code or a recovery code");

const verifySchema = z.object({ mfaToken: z.string().min(10).max(2000), deviceId: z.string().max(200).optional() }).and(secondFactorSchema);

/** Second step of sign-in: the code from the authenticator app, or a recovery code. */
authRouter.post("/2fa/verify", async (req, res) => {
  const { mfaToken, deviceId, code, recoveryCode } = parse(verifySchema, req.body);
  const ticket = verifyMfaTicket(mfaToken);
  const user = await platformPrisma.user.findUnique({ where: { id: ticket.sub } });
  if (!user || user.status !== "ACTIVE" || user.tokenVersion !== ticket.tv) throw unauthorized("The sign-in step expired. Start again.");
  await assertBusinessActive(user.businessId);
  assertNotLocked(user);
  const method = await checkSecondFactor(user.id, { code, recoveryCode });
  if (!method) {
    await registerFailure(user.id, user.failedLogins);
    throw unauthorized(recoveryCode ? "That recovery code is wrong or already used" : "That code is wrong or already used");
  }
  if (method === "recovery") {
    const left = await platformPrisma.recoveryCode.count({ where: { userId: user.id, usedAt: null } });
    await securityAudit(req, user, "auth.2fa.recovery_code_used", { left });
  }
  await platformPrisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null } });
  sendSession(req, res, await issueSession(user, sessionMeta(req, deviceId)));
});

authRouter.get("/2fa", authenticate, async (req, res) => {
  res.json(await twoFactorStatus(req.user!.id));
});

authRouter.post("/2fa/setup", authenticate, async (req, res) => {
  const user = await platformPrisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: { id: true, email: true, phone: true } });
  res.json(await beginTwoFactorSetup(user));
});

authRouter.post("/2fa/enable", authenticate, async (req, res) => {
  const { code } = parse(z.object({ code: z.string().trim().min(6).max(10) }), req.body);
  const recoveryCodes = await enableTwoFactor(req.user!.id, code);
  await securityAudit(req, { id: req.user!.id, businessId: req.user!.businessId }, "auth.2fa.enabled");
  res.json({ recoveryCodes });
});

const disableSchema = z.object({ password: z.string().max(200).optional() }).and(secondFactorSchema);

/** Turn off: needs a current code (or recovery code), plus the password when the account has one. */
authRouter.post("/2fa/disable", authenticate, async (req, res) => {
  const { password, code, recoveryCode } = parse(disableSchema, req.body);
  const user = await platformPrisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: { id: true, businessId: true, passwordHash: true } });
  if (user.passwordHash && !(password && (await bcrypt.compare(password, user.passwordHash)))) throw badRequest("Password is wrong");
  if (!(await checkSecondFactor(user.id, { code, recoveryCode }))) throw badRequest("That code is wrong or already used");
  await disableTwoFactor(user.id);
  await securityAudit(req, user, "auth.2fa.disabled");
  res.json({ ok: true });
});

authRouter.post("/2fa/recovery-codes", authenticate, async (req, res) => {
  const { code, recoveryCode } = parse(secondFactorSchema, req.body);
  if (!(await checkSecondFactor(req.user!.id, { code, recoveryCode }))) throw badRequest("That code is wrong or already used");
  const recoveryCodes = await regenerateRecoveryCodes(req.user!.id);
  await securityAudit(req, { id: req.user!.id, businessId: req.user!.businessId }, "auth.2fa.recovery_codes_regenerated");
  res.json({ recoveryCodes });
});

// ---------- Password links (Phase 2.2) ----------

const forgotSchema = z.object({ identifier: z.string().trim().min(3).max(200) });

/** "Forgot password": same answer whether or not the account exists (no enumeration). */
authRouter.post("/password/forgot", async (req, res) => {
  const { identifier } = parse(forgotSchema, req.body);
  const digits = identifier.replace(/\D/g, "");
  const where = identifier.includes("@") ? { email: identifier.toLowerCase() } : { phone: digits.slice(-10) };
  const user = await platformPrisma.user.findFirst({ where, select: { id: true, name: true, email: true, phone: true, status: true, businessId: true } });
  if (user?.status === "ACTIVE") {
    const delivery = await sendPasswordLink(user, "RESET");
    await securityAudit(req, user, "auth.password.link_requested", { channel: delivery.channel });
  }
  res.json({ ok: true, message: "If an account matches, a reset link has been sent by email or SMS." });
});

const resetSchema = z.object({ token: z.string().min(20).max(200), password: z.string().min(1).max(200) });

authRouter.post("/password/reset", async (req, res) => {
  const { token, password } = parse(resetSchema, req.body);
  const { userId, purpose } = await consumePasswordLink(token, password);
  const user = await platformPrisma.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, businessId: true, email: true, phone: true } });
  await securityAudit(req, user, purpose === "INVITE" ? "auth.password.set_from_invite" : "auth.password.reset");
  res.json({ ok: true, login: user.email ?? user.phone });
});

const changeSchema = z.object({ currentPassword: z.string().min(1).max(200), newPassword: newPasswordSchema });

/** Signed-in user changes their own password; other devices are signed out, this one stays. */
authRouter.post("/password/change", authenticate, async (req, res) => {
  const { currentPassword, newPassword } = parse(changeSchema, req.body);
  const user = await platformPrisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: { id: true, name: true, email: true, phone: true, passwordHash: true, businessId: true } });
  if (!user.passwordHash || !(await bcrypt.compare(currentPassword, user.passwordHash))) throw badRequest("Current password is wrong");
  const problems = passwordProblems(newPassword, [user.name, user.email, user.phone]);
  if (problems.length) throw badRequest(problems.join(". "));
  await platformPrisma.user.update({ where: { id: user.id }, data: { passwordHash: await bcrypt.hash(newPassword, 10) } });
  const signedOut = await revokeOtherSessions(user.id, req.sessionId);
  await securityAudit(req, user, "auth.password.changed", { otherSessionsEnded: signedOut });
  res.json({ ok: true });
});

// ---------- Signed-in devices (Phase 2.3) ----------

authRouter.get("/sessions", authenticate, async (req, res) => {
  const sessions = await listSessions(req.user!.id);
  res.json(sessions.map((s) => ({ ...s, current: s.id === req.sessionId })));
});

authRouter.delete("/sessions/:id", authenticate, async (req, res) => {
  if (!(await revokeSession(req.user!.id, String(req.params.id)))) throw notFound("Session");
  await securityAudit(req, { id: req.user!.id, businessId: req.user!.businessId }, "auth.session.revoked");
  res.status(204).end();
});

authRouter.post("/sessions/revoke-others", authenticate, async (req, res) => {
  const count = await revokeOtherSessions(req.user!.id, req.sessionId);
  await securityAudit(req, { id: req.user!.id, businessId: req.user!.businessId }, "auth.session.revoked_others", { count });
  res.json({ count });
});

/**
 * Current user, the outlets they can work in, their business with its enabled
 * modules, and their *effective* permissions (role ∩ modules) — clients should
 * gate UI on `permissions` rather than the role.
 *
 * Platform super admins get every outlet (tagged with its business); when they
 * pass X-Outlet-Id / X-Business-Id the response reflects that business.
 */
authRouter.get("/me", authenticate, async (req, res) => {
  const user = await platformPrisma.user.findUniqueOrThrow({
    where: { id: req.user!.id },
    select: {
      id: true,
      name: true,
      phone: true,
      email: true,
      role: true,
      photoUrl: true,
      shift: true,
      businessId: true,
      totpEnabledAt: true,
      preferences: true,
      outlets: { select: { outlet: { select: { id: true, name: true, businessId: true } } } },
    },
  });
  const support = req.support ?? null;
  // In a support view the platform admin acts inside the hotel as a read-only manager of every outlet.
  // Platform support users (Phase 4.2) also work in the platform console: platformRole tells them apart.
  const platformAdmin = isPlatformRole(user.role) && !user.businessId && !support;
  const role = support ? req.user!.role : user.role;
  const outletSelect = { id: true, name: true, businessId: true, business: { select: { name: true } } } as const;
  const outlets = (
    platformAdmin
      ? [] // the platform admin works only in the platform console, never inside a hotel
      : await platformPrisma.outlet.findMany({ where: { id: { in: req.user!.outletIds } }, select: outletSelect, orderBy: { name: "asc" } })
  ).map((o) => ({ id: o.id, name: o.name, businessId: o.businessId, businessName: o.business.name }));

  // Which business is this session acting in?
  const businessId = support?.businessId ?? user.businessId ?? null;
  const business = businessId
    ? await platformPrisma.business.findUnique({ where: { id: businessId }, select: { id: true, name: true, status: true, modules: true, features: true, brand: true } })
    : null;
  const modules = business ? normalizeModules(business.modules) : null;
  // Effective flags only (on AND the required modules enabled), so clients can gate UI directly
  const features = business
    ? Object.fromEntries(FEATURE_KEYS.filter((k) => featureEnabled(normalizeFeatures(business.features), k, modules)).map((k) => [k, true]))
    : {};
  const { outlets: _assigned, totpEnabledAt, preferences, ...profile } = user;
  res.json({
    ...profile,
    role,
    platformAdmin,
    platformRole: platformAdmin ? user.role : null,
    customRole: !support && req.user!.customRoleId ? await customRoleSummary(req.user!.customRoleId) : null,
    support: support && business ? { grantId: support.grantId, businessId: business.id, businessName: business.name, expiresAt: support.expiresAt, readOnly: true } : null,
    twoFactorEnabled: Boolean(totpEnabledAt),
    // The hotel requires two-step login for this role and it isn't on yet: the app sends them to Account → Security.
    twoFactorSetupRequired: !totpEnabledAt && TWO_FACTOR_REQUIRED_ROLES.includes(user.role) && Boolean(features.REQUIRE_2FA),
    business: business ? { id: business.id, name: business.name, status: business.status, modules } : null,
    modules,
    features,
    outlets,
    permissions: effectivePermissions(role, modules, support ? null : req.user!.customPermissions),
    // Appearance: the business's brand look (CANAVO defaults outside a business) and this user's own preferences.
    brand: normalizeBrand(business?.brand),
    preferences: normalizeUserPreferences(preferences),
  });
});

// ---------- Own appearance preferences (every signed-in user, only their own row) ----------

authRouter.get("/me/preferences", authenticate, async (req, res) => {
  const user = await platformPrisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: { preferences: true } });
  res.json(normalizeUserPreferences(user.preferences));
});

/** Partial update: fields left out keep their saved value. */
authRouter.put("/me/preferences", authenticate, async (req, res) => {
  const patch = parse(userPreferencesUpdateSchema, req.body);
  const user = await platformPrisma.user.findUniqueOrThrow({ where: { id: req.user!.id }, select: { preferences: true } });
  const preferences = { ...normalizeUserPreferences(user.preferences), ...patch };
  await platformPrisma.user.update({ where: { id: req.user!.id }, data: { preferences } });
  res.json(preferences);
});

async function customRoleSummary(id: string) {
  return platformPrisma.customRole.findUnique({ where: { id }, select: { id: true, name: true, baseRole: true } });
}

async function assertBusinessActive(businessId: string | null) {
  if (!businessId) return;
  const b = await platformPrisma.business.findUnique({ where: { id: businessId }, select: { status: true } });
  if (b?.status !== "ACTIVE") throw new HttpError(403, "This business account is suspended. Contact your CANAVO administrator.");
}
