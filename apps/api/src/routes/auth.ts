import crypto from "node:crypto";
import { Router } from "express";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import {
  otpRequestSchema,
  otpVerifySchema,
  passwordLoginSchema,
  refreshSchema,
  effectivePermissions,
  normalizeModules,
} from "@canavo/shared";
import { platformPrisma, prisma } from "../db";
import { isProd } from "../env";
import { parse, unauthorized, HttpError } from "../lib/http";
import { issueSession, rotateRefresh, sha256 } from "../lib/tokens";
import { sendOtpSms } from "../services/sms";
import { authenticate } from "../middleware/auth";

export const authRouter = Router();

const MAX_FAILED = 5;
const LOCK_MS = 15 * 60 * 1000;
const OTP_TTL_MS = 5 * 60 * 1000;

const ipLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 50, standardHeaders: "draft-8", legacyHeaders: false });
authRouter.use(["/login", "/otp"], ipLimiter);

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
  res.json(await issueSession(user, req.header("x-device-id")));
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
  await prisma.$transaction([
    prisma.otpCode.update({ where: { id: otp.id }, data: { consumed: true } }),
    prisma.user.update({ where: { id: user.id }, data: { failedLogins: 0, lockedUntil: null } }),
  ]);
  res.json(await issueSession(user, deviceId ?? req.header("x-device-id")));
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
    ? await platformPrisma.business.findUnique({ where: { id: businessId }, select: { id: true, name: true, status: true, modules: true } })
    : null;
  const modules = business ? normalizeModules(business.modules) : null;
  const { outlets: _assigned, ...profile } = user;
  res.json({
    ...profile,
    platformAdmin,
    business: business ? { ...business, modules } : null,
    modules,
    outlets,
    permissions: effectivePermissions(user.role, modules),
  });
});

async function assertBusinessActive(businessId: string | null) {
  if (!businessId) return;
  const b = await platformPrisma.business.findUnique({ where: { id: businessId }, select: { status: true } });
  if (b?.status !== "ACTIVE") throw new HttpError(403, "This business account is suspended. Contact your CANAVO administrator.");
}
