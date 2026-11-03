import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import type { Role } from "@canavo/shared";
import { env } from "../env";
import { platformPrisma, prisma } from "../db";
import { unauthorized } from "./http";

export const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface AccessClaims {
  sub: string;
  role: Role;
  tv: number;
  /** Session (refresh-token family) id: revoking the session ends this access token too */
  sid?: string;
}

/** Where a session was started, for the "signed-in devices" list. */
export interface SessionMeta {
  deviceId?: string;
  ip?: string;
  userAgent?: string;
}

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export function signAccess(user: { id: string; role: Role; tokenVersion: number }, sid?: string) {
  const claims: AccessClaims = { sub: user.id, role: user.role, tv: user.tokenVersion, ...(sid && { sid }) };
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, { expiresIn: ACCESS_TTL_SECONDS });
}

export function verifyAccess(token: string): AccessClaims {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessClaims;
  } catch {
    throw unauthorized("Invalid or expired token");
  }
}

/** Refresh tokens are opaque random strings; only their hash is stored. */
async function createRefresh(userId: string, familyId: string, meta: SessionMeta = {}) {
  const raw = crypto.randomBytes(48).toString("base64url");
  const row = await prisma.refreshToken.create({
    data: {
      userId,
      familyId,
      deviceId: meta.deviceId,
      ip: meta.ip,
      userAgent: meta.userAgent?.slice(0, 300),
      tokenHash: sha256(raw),
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });
  return { raw, id: row.id };
}

export async function issueSession(user: { id: string; role: Role; tokenVersion: number }, meta: SessionMeta = {}) {
  const sid = crypto.randomUUID();
  const refresh = await createRefresh(user.id, sid, meta);
  return { accessToken: signAccess(user, sid), refreshToken: refresh.raw, expiresIn: ACCESS_TTL_SECONDS };
}

/**
 * Rotate a refresh token. Presenting an already-rotated token means it was
 * stolen (or replayed), so the whole token family is revoked.
 */
export async function rotateRefresh(raw: string) {
  const row = await prisma.refreshToken.findUnique({
    where: { tokenHash: sha256(raw) },
    include: { user: true },
  });
  if (!row) throw unauthorized("Invalid refresh token");
  const reuse = async () => {
    await prisma.refreshToken.updateMany({
      where: { familyId: row.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    return unauthorized("Refresh token reuse detected; please log in again");
  };
  if (row.revokedAt) throw await reuse();
  if (row.expiresAt < new Date() || row.user.status !== "ACTIVE") {
    throw unauthorized("Session expired");
  }
  // Claim the token atomically: of two concurrent refreshes with the same token only one
  // rotates, the other counts as a replay.
  const claimed = await prisma.refreshToken.updateMany({ where: { id: row.id, revokedAt: null }, data: { revokedAt: new Date() } });
  if (claimed.count === 0) throw await reuse();
  const next = await createRefresh(row.userId, row.familyId, {
    deviceId: row.deviceId ?? undefined,
    ip: row.ip ?? undefined,
    userAgent: row.userAgent ?? undefined,
  });
  await prisma.refreshToken.update({ where: { id: row.id }, data: { replacedBy: next.id } });
  return {
    accessToken: signAccess(row.user, row.familyId),
    refreshToken: next.raw,
    expiresIn: ACCESS_TTL_SECONDS,
  };
}

/**
 * Invalidate every session for a user (role change, suspension, termination, new password).
 * Callers have already checked they may act on this user; the platform client lets the
 * Super Admin sign out an owner (owners' rows are outside the platform RLS scope).
 */
export async function forceLogout(userId: string) {
  await platformPrisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } });
    await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  });
}

/** Is the session still live (its newest refresh token unrevoked and unexpired)? */
export async function sessionActive(sid: string) {
  return Boolean(await prisma.refreshToken.findFirst({ where: { familyId: sid, revokedAt: null, expiresAt: { gt: new Date() } }, select: { id: true } }));
}

/** The user's live sessions (one per login), newest activity first. */
export async function listSessions(userId: string) {
  const live = await prisma.refreshToken.findMany({
    where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
    select: { familyId: true, deviceId: true, ip: true, userAgent: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  const starts = await prisma.refreshToken.groupBy({
    by: ["familyId"],
    where: { familyId: { in: live.map((t) => t.familyId) } },
    _min: { createdAt: true },
  });
  const startedAt = new Map(starts.map((s) => [s.familyId, s._min.createdAt]));
  return live.map((t) => ({
    id: t.familyId,
    deviceId: t.deviceId,
    ip: t.ip,
    userAgent: t.userAgent,
    signedInAt: startedAt.get(t.familyId) ?? t.createdAt,
    lastActiveAt: t.createdAt, // the token is rotated on every refresh (about every 15 min while in use)
  }));
}

/** End one session of a user (no-op if it isn't theirs). */
export async function revokeSession(userId: string, sid: string) {
  const r = await prisma.refreshToken.updateMany({ where: { userId, familyId: sid, revokedAt: null }, data: { revokedAt: new Date() } });
  return r.count > 0;
}

/** End every session of a user except one. */
export async function revokeOtherSessions(userId: string, keepSid?: string) {
  const r = await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null, ...(keepSid && { familyId: { not: keepSid } }) },
    data: { revokedAt: new Date() },
  });
  return r.count;
}
