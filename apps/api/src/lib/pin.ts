import { bcrypt } from "./bcrypt-pool";
import { platformPrisma } from "../db";
import { HttpError } from "./http";

/**
 * Staff PIN check with a lockout (Phase 2.6, reused for manager approvals in Phase 3.3):
 * 5 wrong PINs lock that person's PIN for 15 minutes, so nobody can try all 10,000 4-digit
 * PINs. `onLocked` runs once when the lock starts (e.g. notify the managers).
 */
export const PIN_MAX_FAILED = 5;
const PIN_LOCK_MS = 15 * 60_000;

export interface PinUser {
  id: string;
  pinHash: string | null;
  pinFailedAttempts: number;
  pinLockedUntil: Date | null;
}

export async function verifyPin(user: PinUser, pin: string | undefined, opts: { label: string; onLocked?: () => Promise<void> }) {
  if (!user.pinHash) throw new HttpError(400, `${opts.label} has no PIN set`, { code: "NO_PIN" });
  if (user.pinLockedUntil && user.pinLockedUntil > new Date()) {
    const mins = Math.ceil((user.pinLockedUntil.getTime() - Date.now()) / 60_000);
    throw new HttpError(423, `Too many wrong PINs. Try again in ${mins} min or ask your manager.`, { code: "PIN_LOCKED" });
  }
  if (!pin) throw new HttpError(400, "PIN is required", { code: "PIN_REQUIRED" });
  if (await bcrypt.compare(pin, user.pinHash)) {
    if (user.pinFailedAttempts) await platformPrisma.user.update({ where: { id: user.id }, data: { pinFailedAttempts: 0, pinLockedUntil: null } });
    return;
  }
  const failed = user.pinFailedAttempts + 1;
  const lock = failed >= PIN_MAX_FAILED;
  await platformPrisma.user.update({
    where: { id: user.id },
    data: lock ? { pinFailedAttempts: 0, pinLockedUntil: new Date(Date.now() + PIN_LOCK_MS) } : { pinFailedAttempts: failed },
  });
  if (lock) {
    await opts.onLocked?.();
    throw new HttpError(423, "Too many wrong PINs. The PIN is locked for 15 minutes; the manager has been told.", { code: "PIN_LOCKED" });
  }
  throw new HttpError(403, `Incorrect PIN (${PIN_MAX_FAILED - failed} tries left)`, { code: "WRONG_PIN" });
}
