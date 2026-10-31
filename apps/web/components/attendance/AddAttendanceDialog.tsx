"use client";

import { useEffect, useMemo, useState } from "react";
import { ROLE_LABELS } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { addDaysISO, todayISO } from "@/lib/dates";
import type { AttendanceRegister, AttendanceStatus } from "@/lib/types";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { Alert } from "@/components/ui/States";
import { DEFAULT_SHIFT, STATUS_META, StatusPicker, TimeField, needsTimes } from "./shared";

/**
 * Add / correct attendance for one employee on one day (POST /attendance/manual).
 * The employee list comes from the register for the chosen date, so only people
 * the current user may mark are offered.
 */
export function AddAttendanceDialog({
  open,
  onClose,
  onSaved,
  initialDate,
}: {
  open: boolean;
  onClose: () => void;
  onSaved: (date: string) => void;
  initialDate?: string;
}) {
  const { outletId, outlet } = useSession();
  const toast = useToast();
  const today = todayISO(outlet?.timezone);
  const [date, setDate] = useState(initialDate ?? today);
  const [userId, setUserId] = useState("");
  const [status, setStatus] = useState<AttendanceStatus | null>(null);
  const [clockIn, setClockIn] = useState("");
  const [clockOut, setClockOut] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDate(initialDate && initialDate <= today ? initialDate : today);
    setUserId("");
    setStatus(null);
    setClockIn("");
    setClockOut("");
    setNote("");
    setError(null);
    setBusy(false);
  }, [open, initialDate, today]);

  const validDate = !!date && date <= today;
  const register = useApiQuery<AttendanceRegister>(open && outletId && validDate ? `reg-dialog:${outletId}:${date}` : null, () =>
    api.get<AttendanceRegister>("/attendance/register", { query: { date } }),
  );
  const markable = useMemo(() => (register.data?.staff ?? []).filter((r) => r.canMark), [register.data]);
  const row = markable.find((r) => r.user.id === userId);

  // Drop a selection that isn't markable on the new date's list.
  useEffect(() => {
    if (userId && register.data && !row) setUserId("");
  }, [register.data, row, userId]);

  const pickStatus = (s: AttendanceStatus) => {
    setStatus(s);
    if (needsTimes(s)) {
      const shift = row?.user.shift ?? DEFAULT_SHIFT;
      if (!clockIn) setClockIn(shift.startTime);
      if (!clockOut) setClockOut(shift.endTime);
    }
  };

  const missingIn = needsTimes(status) && !clockIn;
  const canSave = validDate && !!row && !!status && !missingIn && !busy;

  const save = async () => {
    if (!canSave || !status) return;
    setBusy(true);
    setError(null);
    try {
      await api.post("/attendance/manual", {
        userId,
        date,
        status,
        ...(needsTimes(status) && { clockIn, ...(clockOut && { clockOut }) }),
        ...(note.trim() && { note: note.trim() }),
      });
      toast(`${row!.user.name} marked ${STATUS_META[status].label.toLowerCase()} for ${date}`, "success");
      onSaved(date);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const existing = row?.records[0];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!busy}
      title="Add attendance"
      description="Mark or correct one employee's attendance for a day."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={!canSave}>
            Save attendance
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <Alert>{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
          <Select
            label="Employee"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            disabled={register.loading || !markable.length}
            error={register.error}
            hint={!register.loading && register.data && !markable.length ? "There's nobody you can mark in this outlet." : undefined}
          >
            <option value="">{register.loading ? "Loading staff…" : "Choose employee"}</option>
            {markable.map((r) => (
              <option key={r.user.id} value={r.user.id}>
                {r.user.name} · {ROLE_LABELS[r.user.role]}
              </option>
            ))}
          </Select>
          <div className="flex flex-col gap-1.5">
            <Input label="Date" type="date" value={date} max={today} onChange={(e) => e.target.value && setDate(e.target.value)} error={date > today ? "No future dates" : null} />
            <div className="flex gap-1.5">
              <button type="button" className="text-xs font-semibold text-primary hover:underline" onClick={() => setDate(addDaysISO(today, -1))}>
                Yesterday
              </button>
              <span className="text-xs text-muted">·</span>
              <button type="button" className="text-xs font-semibold text-primary hover:underline" onClick={() => setDate(today)}>
                Today
              </button>
            </div>
          </div>
        </div>

        {row && (
          <p className="text-sm text-muted">
            Shift: {row.user.shift ? `${row.user.shift.name} ${row.user.shift.startTime}–${row.user.shift.endTime}` : "none assigned"}
            {existing && (
              <>
                {" · "}
                <span className="font-semibold text-amber-700 dark:text-amber-300">
                  Already {STATUS_META[existing.status].label.toLowerCase()} ({existing.source === "SELF" ? "own clock-in" : "manual"}) — saving corrects that record.
                </span>
              </>
            )}
            {!existing && row.leave && <> · Approved {row.leave.type.toLowerCase().replace("_", " ")} leave</>}
          </p>
        )}

        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold text-fg">Status</span>
          <StatusPicker value={status} onChange={pickStatus} />
        </div>

        {needsTimes(status) && (
          <div className="flex flex-wrap gap-3">
            <TimeField label="Clock in" value={clockIn} onChange={setClockIn} invalid={missingIn} />
            <TimeField label="Clock out" value={clockOut} onChange={setClockOut} />
            <p className="basis-full text-xs text-muted">Times are outlet time. A clock-out earlier than the clock-in counts as the next day (night shift). Leave clock-out empty if still on shift.</p>
          </div>
        )}

        <Input label="Note (optional)" value={note} maxLength={300} placeholder="e.g. Forgot phone, verified by manager" onChange={(e) => setNote(e.target.value)} />
      </div>
    </Dialog>
  );
}
