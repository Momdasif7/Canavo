import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import type { Role } from "@canavo/shared";
import { env } from "../env";
import { prisma } from "../db";
import { unauthorized } from "./http";

export const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface AccessClaims {
  sub: string;
  role: Role;
  tv: number;
}

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

export function signAccess(user: { id: string; role: Role; tokenVersion: number }) {
  const claims: AccessClaims = { sub: user.id, role: user.role, tv: user.tokenVersion };
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
async function createRefresh(userId: string, familyId: string, deviceId?: string) {
  const raw = crypto.randomBytes(48).toString("base64url");
  const row = await prisma.refreshToken.create({
    data: {
      userId,
      familyId,
      deviceId,
      tokenHash: sha256(raw),
      expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
    },
  });
  return { raw, id: row.id };
}

export async function issueSession(
  user: { id: string; role: Role; tokenVersion: number },
  deviceId?: string,
) {
  const refresh = await createRefresh(user.id, crypto.randomUUID(), deviceId);
  return { accessToken: signAccess(user), refreshToken: refresh.raw, expiresIn: ACCESS_TTL_SECONDS };
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
  if (row.revokedAt) {
    await prisma.refreshToken.updateMany({
      where: { familyId: row.familyId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw unauthorized("Refresh token reuse detected; please log in again");
  }
  if (row.expiresAt < new Date() || row.user.status !== "ACTIVE") {
    throw unauthorized("Session expired");
  }
  const next = await createRefresh(row.userId, row.familyId, row.deviceId ?? undefined);
  await prisma.refreshToken.update({
    where: { id: row.id },
    data: { revokedAt: new Date(), replacedBy: next.id },
  });
  return {
    accessToken: signAccess(row.user),
    refreshToken: next.raw,
    expiresIn: ACCESS_TTL_SECONDS,
  };
}

/** Invalidate every session for a user (role change, suspension, termination). */
export async function forceLogout(userId: string) {
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } });
    await tx.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
  });
}
