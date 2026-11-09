/**
 * Gap 7 (P2, approved): clock-in face check under the DPDP Act 2023. Design: docs/qa/known-gaps.md §7.
 *
 * - Opt-in per business (feature CLOCK_IN_FACE_MATCH, off by default) AND per staff member (explicit consent to
 *   FACE_CONSENT_VERSION, recorded with its version; withdrawing deletes the reference photo).
 * - The server never computes or stores a face embedding / template. It keeps the reference photo and the
 *   clock-in selfie (images the staff member took), plus the on-device verdict `{matched, score}` when the app
 *   has a matcher. Managed Expo SDK 51 has no on-device face-recognition module (see known-gaps.md), so today the
 *   app sends no verdict and every face-checked clock-in goes to the manager review queue (side-by-side photos +
 *   liveness-lite prompt).
 * - A doubtful result never blocks clock-in: it flags the record (FACE_MISMATCH) and tells the managers.
 * - Selfies are purged after SELFIE_RETENTION_DAYS (purgeOldSelfies, hourly job).
 */
import path from "node:path";
import { unlink } from "node:fs/promises";
import { FACE_CONSENT_VERSION, SELFIE_RETENTION_DAYS, type FaceCheckState } from "@canavo/shared";
import { platformPrisma } from "../db";
import { featureOn } from "../lib/tenant";
import { storageDir } from "./storage";

/** At or above this on-device score a match is accepted without review (only used when the app sends a verdict). */
export const FACE_MATCH_THRESHOLD = 0.75;

export interface FaceUser {
  faceRefPhotoUrl: string | null;
  faceConsentAt: Date | null;
  faceConsentVersion: string | null;
}

/** The staff member agreed to the current notice and has a reference photo, and the business turned the feature on. */
export function faceCheckApplies(user: FaceUser): boolean {
  return featureOn("CLOCK_IN_FACE_MATCH") && Boolean(user.faceConsentAt && user.faceRefPhotoUrl) && user.faceConsentVersion === FACE_CONSENT_VERSION;
}

/** Initial state of a face-checked clock-in. No verdict → manager review; a weak / failed verdict → MISMATCH (flagged). */
export function initialFaceCheck(faceMatch: { matched: boolean; score: number } | undefined): FaceCheckState {
  if (!faceMatch) return "PENDING_REVIEW";
  return faceMatch.matched && faceMatch.score >= FACE_MATCH_THRESHOLD ? "MATCHED" : "MISMATCH";
}

/** Fields that erase a staff member's face-check data (consent withdrawn, staff deactivated). */
export const FACE_ERASE = { faceRefPhotoUrl: null, faceConsentAt: null, faceConsentVersion: null } as const;

/** Delete a locally stored upload (our own /uploads/files/<name> URL). Cloudinary files are left to its retention rules. */
export async function removeLocalUpload(url: string | null | undefined): Promise<boolean> {
  if (!url) return false;
  try {
    const m = /^\/uploads\/files\/([a-zA-Z0-9_-]{8,64}\.(?:jpg|png|webp))$/.exec(new URL(url).pathname);
    if (!m) return false;
    await unlink(path.join(storageDir("uploads"), m[1]));
    return true;
  } catch {
    return false;
  }
}

/** Retention: clock-in selfies older than SELFIE_RETENTION_DAYS are removed (URL cleared, local file deleted). All businesses. */
export async function purgeOldSelfies(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - SELFIE_RETENTION_DAYS * 86_400_000);
  const old = await platformPrisma.staffAttendance.findMany({
    where: { clockInSelfieUrl: { not: null }, clockInAt: { lt: cutoff } },
    select: { id: true, clockInSelfieUrl: true },
    take: 1000,
  });
  if (!old.length) return 0;
  // Reference photos are still in use: never delete a file a user's enrolment points at.
  const refs = new Set(
    (await platformPrisma.user.findMany({ where: { faceRefPhotoUrl: { in: old.map((o) => o.clockInSelfieUrl!) } }, select: { faceRefPhotoUrl: true } })).map((u) => u.faceRefPhotoUrl),
  );
  await platformPrisma.staffAttendance.updateMany({ where: { id: { in: old.map((o) => o.id) } }, data: { clockInSelfieUrl: null } });
  for (const o of old) if (!refs.has(o.clockInSelfieUrl)) await removeLocalUpload(o.clockInSelfieUrl);
  return old.length;
}
