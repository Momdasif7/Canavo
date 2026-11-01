// Background jobs for the platform module. Register with registerJob(name, everyMs, fn).
import { purgeExpiredIdempotencyKeys } from "./lib/idempotency";
import { prisma } from "./db";
import { registerJob } from "./jobs";
import { moduleEnabled, runForOutlet } from "./lib/tenant";
import { localParts } from "./routes/reports";
import { createBackup, listBackups, pruneBackups } from "./services/backup";
import { isDue, sendSchedule } from "./services/report-schedules";

const HOUR = 60 * 60_000;
const BACKUP_TZ = "Asia/Kolkata";

/** Send every report schedule that is due (daily after 22:00 outlet time, weekly on Mondays). */
export async function runDueSchedules(now = new Date()) {
  const schedules = await prisma.reportSchedule.findMany({ where: { active: true } });
  if (!schedules.length) return 0;
  const outlets = new Map((await prisma.outlet.findMany({ select: { id: true, timezone: true } })).map((o) => [o.id, o.timezone]));
  let sent = 0;
  for (const s of schedules) {
    const tz = outlets.get(s.outletId);
    if (!tz || !isDue(s, now, tz)) continue;
    try {
      // Reports must only see the schedule's own business.
      const delivered = await runForOutlet(s.outletId, async () => {
        if (!moduleEnabled("REPORTS")) return false;
        await sendSchedule(s, now);
        return true;
      });
      if (delivered) sent++;
    } catch (e) {
      console.error(`[job:report-schedules] schedule ${s.id} failed`, e);
    }
  }
  return sent;
}

/** One automatic backup per (IST) day, keeping the newest BACKUP_RETENTION. */
export async function runDailyBackup(now = new Date()) {
  const today = localParts(now, BACKUP_TZ).date;
  const existing = await listBackups();
  if (existing.some((b) => b.kind === "auto" && localParts(b.createdAt, BACKUP_TZ).date === today)) return null;
  const result = await createBackup("auto");
  await pruneBackups();
  return result;
}

export function registerJobs(): void {
  registerJob("report-schedules", HOUR, async () => {
    await runDueSchedules();
  });
  registerJob("idempotency-keys:purge", HOUR, async () => {
    await purgeExpiredIdempotencyKeys();
  });
  registerJob("daily-backup", HOUR, async () => {
    await runDailyBackup();
  });
}
