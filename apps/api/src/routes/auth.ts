import crypto from "node:crypto";
import { Router } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { FEATURE_KEYS, featureEnabled, normalizeFeatures, newPasswordSchema, passwordProblems,
  otpRequestSchema,
  otpVerifySchema,
  passwordLoginSchema,
  refreshSchema,
  effectivePermissions,
  normalizeModules,
} from "@canavo/shared";
import { platformPrisma, prisma } from "../db";
import { isProd } from "../env";
import { badRequest, notFound, parse, unauthorized, HttpError } from "../lib/http";
import { issueSession, listSessions, revokeOtherSessions, revokeSession, rotateRefresh, sha256, type SessionMeta } from "../lib/tokens";
import { consumePasswordLink, sendPasswordLink } from "../services/password-links";
import type { Request } from "express";
import { sendOtpSms } from "../services/sms";
import { authenticate } from "../middleware/auth";

export const authRouter = Router();

const MAX_FAILED = 5;
const LOCK_MS = 15 * 60 * 1000;
const OTP_TTL_MS = 5 * 60 * 1000;

const ipLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 50, standardHeaders: "draft-8", legacyHeaders: false });
authRouter.use(["/login", "/otp"], ipLimiter);
// Password links: few legitimate requests, so a tight limit (also slows enumeration and SMS/email abuse).
const linkLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: "draft-8", legacyHeaders: false });
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
  await prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null } });
  res.json(await issueSession(user, sessionMeta(req)));
});

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
  const sent = await sendOtpSms(phone, code);
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
  await prisma.$transaction(async (tx) => {
    await tx.otpCode.update({ where: { id: otp.id }, data: { consumed: true } });
    await tx.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null } });
  });
  res.json(await issueSession(user, sessionMeta(req, deviceId)));
});

authRouter.post("/refresh", async (req, res) => {
  const { refreshToken } = parse(refreshSchema, req.body);
  res.json(await rotateRefresh(refreshToken));
});

authRouter.post("/logout", async (req, res) => {
  const { refreshToken } = parse(refreshSchema, req.body);
  const row = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(refreshToken) } });
  if (row) {
    await prisma.refreshToken.updateMany({
      where: { familyId: row.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }
  res.status(204).end();
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
      outlets: { select: { outlet: { select: { id: true, name: true, businessId: true } } } },
    },
  });
  const platformAdmin = user.role === "SUPER_ADMIN" && !user.businessId;
  const outletSelect = { id: true, name: true, businessId: true, business: { select: { name: true } } } as const;
  const outlets = (
    platformAdmin
      ? [] // the platform admin works only in the platform console, never inside a hotel
      : await platformPrisma.outlet.findMany({ where: { id: { in: req.user!.outletIds } }, select: outletSelect, orderBy: { name: "asc" } })
  ).map((o) => ({ id: o.id, name: o.name, businessId: o.businessId, businessName: o.business.name }));

  // Which business is this session acting in?
  const businessId = user.businessId ?? null;
  const business = businessId
    ? await platformPrisma.business.findUnique({ where: { id: businessId }, select: { id: true, name: true, status: true, modules: true, features: true } })
    : null;
  const modules = business ? normalizeModules(business.modules) : null;
  // Effective flags only (on AND the required modules enabled), so clients can gate UI directly
  const features = business
    ? Object.fromEntries(FEATURE_KEYS.filter((k) => featureEnabled(normalizeFeatures(business.features), k, modules)).map((k) => [k, true]))
    : {};
  const { outlets: _assigned, ...profile } = user;
  res.json({
    ...profile,
    platformAdmin,
    business: business ? { id: business.id, name: business.name, status: business.status, modules } : null,
    modules,
    features,
    outlets,
    permissions: effectivePermissions(user.role, modules),
  });
});

async function assertBusinessActive(businessId: string | null) {
  if (!businessId) return;
  const b = await platformPrisma.business.findUnique({ where: { id: businessId }, select: { status: true } });
  if (b?.status !== "ACTIVE") throw new HttpError(403, "This business account is suspended. Contact your CANAVO administrator.");
}
