/**
 * Staff attendance register (managers / owners, `attendance:manage`):
 * request shapes and the pure draft logic behind the Daily register screen.
 *
 * No React Native imports, so the same request specs and rules can be run from
 * a node script against the real API. `src/lib/api.ts` executes these specs.
 */
import type { RequestSpec } from "../delivery/portal";
import type { AttendanceRegister, AttendanceRegisterRow, ManualStatus, RegisterRecord, RegisterSaveResult } from "../lib/types";

// ---------- Request specs ----------
export interface RegisterEntry {
  userId: string;
  status: ManualStatus;
  clockIn?: string;
  clockOut?: string;
  note?: string;
}

export interface RecordPatch {
  status?: ManualStatus;
  clockIn?: string;
  clockOut?: string | null;
  note?: string | null;
}

export const registerRequests = {
  /** Omit `date` to get today's register (outlet time); the response says which date it is. */
  register: (date?: string): RequestSpec<AttendanceRegister> => ({ method: "GET", path: "/attendance/register", query: { date } }),
  save: (date: string, entries: RegisterEntry[]): RequestSpec<RegisterSaveResult> => ({
    method: "POST",
    path: "/attendance/register",
    body: { date, entries },
  }),
  manual: (date: string, entry: RegisterEntry): RequestSpec<RegisterRecord> => ({
    method: "POST",
    path: "/attendance/manual",
    body: { date, ...entry },
  }),
  update: (id: string, patch: RecordPatch): RequestSpec<RegisterRecord> => ({ method: "PATCH", path: `/attendance/${id}`, body: patch }),
  remove: (id: string): RequestSpec<void> => ({ method: "DELETE", path: `/attendance/${id}` }),
};

// ---------- Labels ----------
export const STATUS_ORDER: readonly ManualStatus[] = ["PRESENT", "HALF_DAY", "ABSENT", "LEAVE"];
export const STATUS_SHORT: Record<ManualStatus, string> = { PRESENT: "P", HALF_DAY: "HD", ABSENT: "A", LEAVE: "L" };
export const STATUS_LABEL: Record<ManualStatus, string> = { PRESENT: "Present", HALF_DAY: "Half day", ABSENT: "Absent", LEAVE: "Leave" };
export const needsTimes = (s: ManualStatus | null) => s === "PRESENT" || s === "HALF_DAY";

/** Used when an employee has no shift. */
export const DEFAULT_SHIFT = { startTime: "09:00", endTime: "18:00" };

// ---------- Time helpers ----------
export const OUTLET_TZ = "Asia/Kolkata";

/** HH:MM (24 h) of an instant in the outlet's time zone; device time if Intl lacks time zones. */
export function hhmmAt(iso: string, timeZone = OUTLET_TZ): string {
  const d = new Date(iso);
  try {
    const s = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
    if (/^\d{2}:\d{2}$/.test(s)) return s;
  } catch {
    // fall through
  }
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "09:05" → "9:05 AM" */
export function displayTime(hhmm: string | null | undefined): string {
  if (!hhmm) return "—";
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

export const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** True when clock-out is the next day (earlier than or equal to clock-in). */
export const isOvernight = (clockIn: string | null, clockOut: string | null) =>
  !!clockIn && !!clockOut && toMinutes(clockOut) <= toMinutes(clockIn);

// ---------- Draft model ----------
export interface RowDraft {
  status: ManualStatus | null;
  clockIn: string | null;
  clockOut: string | null;
  note: string;
}

/** The record the server corrects on save (the day's first one). */
export const primaryRecord = (row: AttendanceRegisterRow): RegisterRecord | null => row.records[0] ?? null;

/** What is actually recorded today (ignores approved leave without a record). */
export function recordedDraft(row: AttendanceRegisterRow): RowDraft {
  const r = primaryRecord(row);
  if (!r) return { status: null, clockIn: null, clockOut: null, note: "" };
  const timed = needsTimes(r.status);
  return {
    status: r.status,
    clockIn: timed ? hhmmAt(r.clockInAt) : null,
    clockOut: timed && r.clockOutAt ? hhmmAt(r.clockOutAt) : null,
    note: r.note ?? "",
  };
}

export const shiftTimes = (row: AttendanceRegisterRow) => ({
  startTime: row.user.shift?.startTime ?? DEFAULT_SHIFT.startTime,
  endTime: row.user.shift?.endTime ?? DEFAULT_SHIFT.endTime,
});

/** The starting draft: the record, or approved leave preselected (L, or HD for a half-day leave). */
export function initialDraft(row: AttendanceRegisterRow): RowDraft {
  const rec = recordedDraft(row);
  if (rec.status || !row.leave || !row.canMark) return rec;
  if (row.leave.type === "HALF_DAY") {
    const s = shiftTimes(row);
    return { status: "HALF_DAY", clockIn: s.startTime, clockOut: null, note: "Half-day leave" };
  }
  return { status: "LEAVE", clockIn: null, clockOut: null, note: "" };
}

/** Pick a status; Present / Half day get shift times unless times are already set. */
export function withStatus(row: AttendanceRegisterRow, d: RowDraft, status: ManualStatus): RowDraft {
  if (!needsTimes(status)) return { ...d, status, clockIn: null, clockOut: null };
  const s = shiftTimes(row);
  const rec = recordedDraft(row);
  const clockIn = d.clockIn ?? rec.clockIn ?? s.startTime;
  const clockOut = d.clockIn ? d.clockOut : rec.clockIn ? rec.clockOut : status === "PRESENT" ? s.endTime : null;
  return { ...d, status, clockIn, clockOut };
}

/** True when saving this draft would change what the server has. */
export function isChanged(row: AttendanceRegisterRow, d: RowDraft): boolean {
  if (!row.canMark || !d.status) return false;
  const rec = recordedDraft(row);
  if (d.status !== rec.status) return true;
  if (d.note.trim() !== rec.note.trim()) return true;
  return needsTimes(d.status) && (d.clockIn !== rec.clockIn || d.clockOut !== rec.clockOut);
}

/** Problem that blocks saving this draft, if any. */
export function draftError(d: RowDraft): string | null {
  if (needsTimes(d.status) && !d.clockIn) return "Enter the clock-in time";
  if (d.note.trim().length > 300) return "Note is too long (max 300)";
  return null;
}

export function toEntry(userId: string, d: RowDraft): RegisterEntry {
  const note = d.note.trim();
  return {
    userId,
    status: d.status!,
    ...(needsTimes(d.status) && d.clockIn ? { clockIn: d.clockIn } : {}),
    ...(needsTimes(d.status) && d.clockOut ? { clockOut: d.clockOut } : {}),
    ...(note ? { note } : {}),
  };
}

export type Drafts = Record<string, RowDraft>;

export const initialDrafts = (reg: AttendanceRegister): Drafts =>
  Object.fromEntries(reg.staff.map((row) => [row.user.id, initialDraft(row)]));

/** "Mark all present": every markable row without a status gets Present with shift times. */
export function markAllPresent(reg: AttendanceRegister, drafts: Drafts): { drafts: Drafts; count: number } {
  const next = { ...drafts };
  let count = 0;
  for (const row of reg.staff) {
    const d = next[row.user.id];
    if (!row.canMark || !d || d.status) continue;
    const s = shiftTimes(row);
    next[row.user.id] = { ...d, status: "PRESENT", clockIn: s.startTime, clockOut: s.endTime };
    count++;
  }
  return { drafts: next, count };
}

/** Entries for `POST /attendance/register`: changed rows only. */
export function changedEntries(reg: AttendanceRegister, drafts: Drafts): RegisterEntry[] {
  return reg.staff.filter((row) => drafts[row.user.id] && isChanged(row, drafts[row.user.id])).map((row) => toEntry(row.user.id, drafts[row.user.id]));
}

export type SummaryKey = ManualStatus | "NONE";

/** Summary chip counts for the drafts as shown on screen. */
export function summarize(reg: AttendanceRegister, drafts: Drafts): Record<SummaryKey, number> {
  const out: Record<SummaryKey, number> = { PRESENT: 0, HALF_DAY: 0, ABSENT: 0, LEAVE: 0, NONE: 0 };
  for (const row of reg.staff) out[drafts[row.user.id]?.status ?? row.status ?? "NONE"]++;
  return out;
}

/** "Self clock-in 09:07 (GPS) · out 18:02", "Marked by Ravi" … for one record. */
export function describeRecord(r: RegisterRecord): string {
  const parts: string[] = [];
  if (needsTimes(r.status)) {
    const inAt = hhmmAt(r.clockInAt);
    parts.push(r.source === "SELF" ? `Self clock-in ${inAt} (GPS)` : `${STATUS_LABEL[r.status]} from ${inAt}`);
    parts.push(r.clockOutAt ? `out ${hhmmAt(r.clockOutAt)}` : "still clocked in");
  } else {
    parts.push(STATUS_LABEL[r.status]);
  }
  if (r.markedBy) parts.push(`${r.source === "SELF" ? "Edited" : "Marked"} by ${r.markedBy.name}`);
  return parts.join(" · ");
}

/** Shift dates by whole days (YYYY-MM-DD, calendar arithmetic in UTC). */
export function shiftDate(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
