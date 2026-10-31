"use client";

import { useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/api";
import type { AttendanceRecord, AttendanceStatus } from "@/lib/types";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Alert } from "@/components/ui/States";
import { DEFAULT_SHIFT, StatusPicker, TimeField, needsTimes, toHHMM } from "./shared";

/** Edit one attendance record (PATCH /attendance/:id): status, in/out times, note. */
export function EditAttendanceDialog({
  record,
  shift,
  onClose,
  onSaved,
}: {
  record: AttendanceRecord | null;
  shift?: { startTime: string; endTime: string } | null;
  onClose: () => void;
  onSaved: (updated: AttendanceRecord) => void;
}) {
  const { outlet } = useSession();
  const toast = useToast();
  const tz = outlet?.timezone;
  const [status, setStatus] = useState<AttendanceStatus>("PRESENT");
  const [clockIn, setClockIn] = useState("");
  const [clockOut, setClockOut] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!record) return;
    const timed = needsTimes(record.status);
    setStatus(record.status);
    setClockIn(timed ? toHHMM(record.clockInAt, tz) : "");
    setClockOut(timed && record.clockOutAt ? toHHMM(record.clockOutAt, tz) : "");
    setNote(record.note ?? "");
    setError(null);
    setBusy(false);
  }, [record, tz]);

  const pickStatus = (s: AttendanceStatus) => {
    setStatus(s);
    if (needsTimes(s)) {
      const sh = shift ?? DEFAULT_SHIFT;
      if (!clockIn) setClockIn(sh.startTime);
      if (!clockOut) setClockOut(sh.endTime);
    }
  };

  const missingIn = needsTimes(status) && !clockIn;

  const save = async () => {
    if (!record || missingIn) return;
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { status, note: note.trim() || null };
      if (needsTimes(status)) {
        body.clockIn = clockIn;
        body.clockOut = clockOut || null;
      }
      const updated = await api.patch<AttendanceRecord>(`/attendance/${record.id}`, body);
      toast("Attendance updated", "success");
      onSaved({ ...record, ...updated, user: record.user });
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={!!record}
      onClose={onClose}
      dismissible={!busy}
      title="Edit attendance"
      description={record ? `${record.user?.name ?? "Employee"} · ${record.workDate}` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={save} loading={busy} disabled={missingIn}>
            Save changes
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error && <Alert>{error}</Alert>}
        {record?.source === "SELF" && (
          <Alert tone="info">This is the employee&apos;s own clock-in{record.clockInDistance >= 0 ? ` (GPS, ${record.clockInDistance} m from the outlet)` : ""}. Your change is recorded as an edit.</Alert>
        )}
        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-semibold text-fg">Status</span>
          <StatusPicker value={status} onChange={pickStatus} />
        </div>
        {needsTimes(status) && (
          <div className="flex flex-wrap gap-3">
            <TimeField label="Clock in" value={clockIn} onChange={setClockIn} invalid={missingIn} />
            <TimeField label="Clock out" value={clockOut} onChange={setClockOut} />
            <p className="basis-full text-xs text-muted">Outlet time. Clear clock-out to mark the shift as still open; an earlier clock-out means the next day.</p>
          </div>
        )}
        <Input label="Note" value={note} maxLength={300} placeholder="Reason for the change" onChange={(e) => setNote(e.target.value)} />
      </div>
    </Dialog>
  );
}
