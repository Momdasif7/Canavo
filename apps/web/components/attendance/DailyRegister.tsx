"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { ArrowCounterClockwise, CheckCircle, FloppyDisk, LockSimple, MapPin, PencilSimple, Plus, UserCheck } from "@phosphor-icons/react";
import { ROLE_LABELS } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { addDaysISO, todayISO } from "@/lib/dates";
import { titleCase } from "@/lib/format";
import type { AttendanceEntryInput, AttendanceRegister, AttendanceStatus, RegisterRow, RegisterSaveResult } from "@/lib/types";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Alert, EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { AddAttendanceDialog } from "./AddAttendanceDialog";
import { DEFAULT_SHIFT, STATUS_META, STATUS_ORDER, StatusPicker, TimeField, needsTimes, toHHMM } from "./shared";

interface Draft {
  status: AttendanceStatus | null;
  clockIn: string;
  clockOut: string;
  note: string;
}

function baselineOf(row: RegisterRow, tz?: string): Draft {
  const timed = row.records.find((r) => needsTimes(r.status));
  const first = row.records[0];
  return {
    status: row.status,
    clockIn: timed ? toHHMM(timed.clockInAt, tz) : "",
    clockOut: timed?.clockOutAt ? toHHMM(timed.clockOutAt, tz) : "",
    note: first?.note ?? "",
  };
}

function isDirty(d: Draft | undefined, b: Draft): boolean {
  if (!d || d.status === null) return false;
  if (d.status !== b.status) return true;
  if (d.note.trim() !== b.note.trim()) return true;
  return needsTimes(d.status) && (d.clockIn !== b.clockIn || d.clockOut !== b.clockOut);
}

const shiftOf = (row: RegisterRow) => row.user.shift ?? DEFAULT_SHIFT;

export function DailyRegister({ onSaved }: { onSaved?: () => void }) {
  const { outletId, outlet, me } = useSession();
  const toast = useToast();
  const tz = outlet?.timezone;
  const today = todayISO(tz);
  const [date, setDate] = useState(today);
  const [pendingDate, setPendingDate] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [skipped, setSkipped] = useState<{ userId: string; name: string; reason: string }[]>([]);
  const [saving, setSaving] = useState(false);
  const [showErrors, setShowErrors] = useState(false);
  const [adding, setAdding] = useState(false);
  /** Drafts to keep across the next reload (rows the API skipped). */
  const keepRef = useRef<Record<string, Draft>>({});

  const register = useApiQuery<AttendanceRegister>(outletId && date <= today ? `register:${outletId}:${date}` : null, () =>
    api.get<AttendanceRegister>("/attendance/register", { query: { date } }),
  );
  const rows = useMemo(() => (register.data?.date === date ? register.data.staff : []), [register.data, date]);
  const baselines = useMemo(() => Object.fromEntries(rows.map((r) => [r.user.id, baselineOf(r, tz)])), [rows, tz]);

  // Reset drafts to the server state whenever fresh data arrives.
  useEffect(() => {
    if (!register.data) return;
    const next: Record<string, Draft> = {};
    for (const r of register.data.staff) next[r.user.id] = keepRef.current[r.user.id] ?? baselineOf(r, tz);
    keepRef.current = {};
    setDrafts(next);
    setShowErrors(false);
  }, [register.data, tz]);

  const dirtyIds = rows.filter((r) => r.canMark && isDirty(drafts[r.user.id], baselines[r.user.id])).map((r) => r.user.id);
  const dirtyCount = dirtyIds.length;
  const invalidIds = new Set(dirtyIds.filter((id) => needsTimes(drafts[id]?.status) && !drafts[id]?.clockIn));

  // Warn before leaving the page with unsaved marks.
  useEffect(() => {
    if (!dirtyCount) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirtyCount]);

  const changeDate = (d: string) => {
    if (!d || d === date) return;
    const next = d > today ? today : d;
    if (dirtyCount) setPendingDate(next);
    else {
      setSkipped([]);
      setDate(next);
    }
  };

  const update = useCallback((row: RegisterRow, patch: Partial<Draft>) => {
    setDrafts((prev) => {
      const cur = prev[row.user.id] ?? { status: null, clockIn: "", clockOut: "", note: "" };
      const next = { ...cur, ...patch };
      if (patch.status && needsTimes(patch.status)) {
        const shift = shiftOf(row);
        if (!next.clockIn) next.clockIn = shift.startTime;
        if (!next.clockOut) next.clockOut = shift.endTime;
      }
      return { ...prev, [row.user.id]: next };
    });
  }, []);

  /** Unmarked rows the user may mark → Present with their shift times. */
  const markAllPresent = () => {
    setDrafts((prev) => {
      const next = { ...prev };
      for (const r of rows) {
        if (!r.canMark || next[r.user.id]?.status) continue;
        const shift = shiftOf(r);
        next[r.user.id] = { status: "PRESENT", clockIn: shift.startTime, clockOut: shift.endTime, note: next[r.user.id]?.note ?? "" };
      }
      return next;
    });
  };

  const clearChanges = () => {
    setDrafts(Object.fromEntries(rows.map((r) => [r.user.id, baselines[r.user.id]])));
    setSkipped([]);
    setShowErrors(false);
  };

  const save = async () => {
    if (!dirtyCount) return;
    if (invalidIds.size) {
      setShowErrors(true);
      toast("Enter the clock-in time for Present / Half day rows", "error");
      return;
    }
    const entries: AttendanceEntryInput[] = dirtyIds.map((id) => {
      const d = drafts[id];
      const status = d.status as AttendanceStatus;
      return {
        userId: id,
        status,
        ...(needsTimes(status) && { clockIn: d.clockIn, ...(d.clockOut && { clockOut: d.clockOut }) }),
        ...(d.note.trim() && { note: d.note.trim() }),
      };
    });
    setSaving(true);
    try {
      const res = await api.post<RegisterSaveResult>("/attendance/register", { date, entries });
      const names = Object.fromEntries(rows.map((r) => [r.user.id, r.user.name]));
      setSkipped(res.skipped.map((s) => ({ ...s, name: names[s.userId] ?? "Employee" })));
      keepRef.current = Object.fromEntries(res.skipped.filter((s) => drafts[s.userId]).map((s) => [s.userId, drafts[s.userId]]));
      if (res.saved) toast(`Saved attendance for ${res.saved} ${res.saved === 1 ? "person" : "people"}`, "success");
      if (res.skipped.length) toast(`${res.skipped.length} not saved — see the reasons above the list`, "error");
      await register.reload();
      onSaved?.();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setSaving(false);
    }
  };

  // Summary of the register as currently shown (unsaved marks included).
  const counts = useMemo(() => {
    const c: Record<AttendanceStatus | "NONE", number> = { PRESENT: 0, HALF_DAY: 0, ABSENT: 0, LEAVE: 0, NONE: 0 };
    for (const r of rows) {
      const s = r.canMark ? (drafts[r.user.id]?.status ?? null) : r.status;
      c[s ?? "NONE"]++;
    }
    return c;
  }, [rows, drafts]);
  const unmarkedMarkable = rows.filter((r) => r.canMark && !drafts[r.user.id]?.status).length;

  return (
    <Card>
      {/* Toolbar */}
      <div className="flex flex-wrap items-end gap-3 border-b border-line p-4">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="register-date" className="text-sm font-semibold text-fg">
            Date
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <input
              id="register-date"
              type="date"
              value={date}
              max={today}
              onChange={(e) => changeDate(e.target.value)}
              className="min-h-tap rounded-xl border border-line bg-surface px-3.5 text-[15px] text-fg focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            <div className="inline-flex rounded-xl border border-line bg-surface-2 p-1">
              {[
                { label: "Yesterday", value: addDaysISO(today, -1) },
                { label: "Today", value: today },
              ].map((q) => (
                <button
                  key={q.label}
                  type="button"
                  onClick={() => changeDate(q.value)}
                  className={clsx(
                    "min-h-[38px] rounded-lg px-3 text-sm font-semibold transition-colors",
                    date === q.value ? "bg-surface text-fg shadow-sm" : "text-muted hover:text-fg",
                  )}
                >
                  {q.label}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 lg:ml-auto">
          <Button variant="outline" icon={<Plus size={18} weight="bold" />} onClick={() => setAdding(true)}>
            Add attendance
          </Button>
          <Button variant="secondary" icon={<UserCheck size={20} />} disabled={!unmarkedMarkable || saving} onClick={markAllPresent}>
            Mark all present <span className="hidden sm:inline">(shift times)</span>
          </Button>
        </div>
      </div>

      {/* Summary */}
      {rows.length > 0 && (
        <div className="flex flex-wrap gap-2 border-b border-line px-4 py-3" aria-label="Register summary">
          {STATUS_ORDER.map((s) => (
            <span key={s} className="inline-flex items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 py-1.5 text-sm">
              <span className={clsx("h-3 w-3 rounded", STATUS_META[s].solid)} />
              {STATUS_META[s].label}
              <strong className="tabular" data-testid={`count-${s}`}>
                {counts[s]}
              </strong>
            </span>
          ))}
          <span className="inline-flex items-center gap-2 rounded-xl border border-dashed border-line px-3 py-1.5 text-sm text-muted">
            Not marked{" "}
            <strong className="tabular text-fg" data-testid="count-NONE">
              {counts.NONE}
            </strong>
          </span>
        </div>
      )}

      {skipped.length > 0 && (
        <div className="border-b border-line p-4">
          <Alert tone="warning">
            <p className="mb-1 font-bold">
              {skipped.length} {skipped.length === 1 ? "entry was" : "entries were"} not saved
            </p>
            <ul className="list-disc space-y-0.5 pl-5">
              {skipped.map((s) => (
                <li key={s.userId}>
                  <strong>{s.name}</strong>: {s.reason}
                </li>
              ))}
            </ul>
          </Alert>
        </div>
      )}

      {/* Rows */}
      {date > today ? (
        <ErrorState message="Attendance can't be marked for a future date." />
      ) : register.loading && !rows.length ? (
        <LoadingState label="Loading register…" />
      ) : register.error ? (
        <ErrorState message={register.error} onRetry={register.reload} />
      ) : !rows.length ? (
        <EmptyState title="No employees in this outlet" description="Add staff and assign them to this outlet to mark attendance." />
      ) : (
        <ul className={clsx("divide-y divide-line", register.loading && "opacity-60")}>
          {rows.map((row) => (
            <RegisterRowItem
              key={row.user.id}
              row={row}
              draft={drafts[row.user.id]}
              dirty={dirtyIds.includes(row.user.id)}
              invalid={showErrors && invalidIds.has(row.user.id)}
              skippedReason={skipped.find((s) => s.userId === row.user.id)?.reason}
              isMe={row.user.id === me?.id}
              tz={tz}
              disabled={saving}
              onChange={(patch) => update(row, patch)}
            />
          ))}
        </ul>
      )}

      {/* Save bar */}
      {rows.length > 0 && (
        <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 rounded-b-2xl border-t border-line bg-surface/95 px-4 py-3 backdrop-blur">
          <p className="text-sm text-muted">
            {dirtyCount ? (
              <>
                <strong className="text-fg">{dirtyCount}</strong> unsaved {dirtyCount === 1 ? "change" : "changes"}
              </>
            ) : (
              "No unsaved changes"
            )}
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" icon={<ArrowCounterClockwise size={18} />} disabled={!dirtyCount || saving} onClick={clearChanges}>
              Clear changes
            </Button>
            <Button icon={<FloppyDisk size={20} />} loading={saving} disabled={!dirtyCount} onClick={save}>
              Save{dirtyCount ? ` (${dirtyCount})` : ""}
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={!!pendingDate}
        title="Discard unsaved changes?"
        description={`You have ${dirtyCount} unsaved ${dirtyCount === 1 ? "change" : "changes"} for ${date}. Switching to ${pendingDate} will discard them.`}
        confirmLabel="Discard and switch"
        onConfirm={() => {
          if (pendingDate) {
            setSkipped([]);
            setDate(pendingDate);
          }
        }}
        onClose={() => setPendingDate(null)}
      />

      <AddAttendanceDialog
        open={adding}
        initialDate={date}
        onClose={() => setAdding(false)}
        onSaved={(d) => {
          if (d === date) {
            // Keep the user's other unsaved marks; only refresh server state for the saved date.
            keepRef.current = Object.fromEntries(dirtyIds.map((id) => [id, drafts[id]]));
            void register.reload();
          }
          onSaved?.();
        }}
      />
    </Card>
  );
}

function RegisterRowItem({
  row,
  draft,
  dirty,
  invalid,
  skippedReason,
  isMe,
  tz,
  disabled,
  onChange,
}: {
  row: RegisterRow;
  draft: Draft | undefined;
  dirty: boolean;
  invalid: boolean;
  skippedReason?: string;
  isMe: boolean;
  tz?: string;
  disabled: boolean;
  onChange: (patch: Partial<Draft>) => void;
}) {
  const { user } = row;
  const status = row.canMark ? (draft?.status ?? null) : row.status;
  const first = row.records[0];

  return (
    <li
      data-testid={`register-row-${user.id}`}
      data-name={user.name}
      className={clsx(
        "flex flex-col gap-3 px-4 py-3.5 lg:flex-row lg:items-center lg:gap-4",
        dirty && "bg-primary-50/60 dark:bg-primary/10",
        !row.canMark && "bg-surface-2/40",
      )}
    >
      {/* Who */}
      <div className="min-w-0 lg:w-72 lg:shrink-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-fg">{user.name}</span>
          {isMe && <Badge>You</Badge>}
          {user.status !== "ACTIVE" && <Badge tone="warning">{titleCase(user.status)}</Badge>}
          {dirty && <Badge tone="primary">Unsaved</Badge>}
        </div>
        <p className="text-xs text-muted">
          {ROLE_LABELS[user.role]} · {user.shift ? `${user.shift.name} ${user.shift.startTime}–${user.shift.endTime}` : "No shift"}
        </p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {row.records.map((r) =>
            r.source === "SELF" ? (
              <span key={r.id} className="contents">
                <Badge tone="neutral">
                  {r.clockInDistance >= 0 && <MapPin size={12} weight="fill" />}
                  {needsTimes(r.status) || !r.editedAt
                    ? `Clocked in by self ${toHHMM(r.clockInAt, tz)}${r.clockOutAt ? `–${toHHMM(r.clockOutAt, tz)}` : " · on shift"}${r.clockInDistance >= 0 ? " (GPS)" : ""}`
                    : "Own clock-in overridden"}
                </Badge>
                {r.editedAt && (
                  <Badge tone="info">
                    <PencilSimple size={12} weight="bold" />
                    Edited by {r.markedBy?.name ?? "manager"}
                  </Badge>
                )}
              </span>
            ) : (
              <Badge key={r.id} tone="primary">
                <PencilSimple size={12} weight="bold" />
                Marked by {r.markedBy?.name ?? "manager"}
              </Badge>
            ),
          )}
          {row.leave && (
            <span title={row.leave.reason || undefined}>
              <Badge tone="info">Approved leave · {titleCase(row.leave.type)}</Badge>
            </span>
          )}
          {first?.note && !row.canMark && <span className="text-xs italic text-muted">“{first.note}”</span>}
        </div>
        {skippedReason && <p className="mt-1 text-xs font-semibold text-red-600 dark:text-red-400">Not saved: {skippedReason}</p>}
      </div>

      {/* Marking */}
      {row.canMark ? (
        <div className="flex flex-1 flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">Status</span>
            <StatusPicker label={`Status for ${user.name}`} value={status} disabled={disabled} onChange={(s) => onChange({ status: s })} />
          </div>
          {needsTimes(status) ? (
            <div className="flex gap-2">
              <TimeField label="In" value={draft?.clockIn ?? ""} disabled={disabled} invalid={invalid} onChange={(v) => onChange({ clockIn: v })} />
              <TimeField label="Out" value={draft?.clockOut ?? ""} disabled={disabled} onChange={(v) => onChange({ clockOut: v })} />
            </div>
          ) : (
            <p className="hidden min-h-[42px] w-[280px] items-center text-xs text-muted sm:flex">{status ? "No times needed" : "Pick a status"}</p>
          )}
          <label className="flex min-w-[180px] flex-1 flex-col gap-1">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">Note</span>
            <input
              type="text"
              value={draft?.note ?? ""}
              maxLength={300}
              disabled={disabled}
              placeholder="Optional"
              aria-label={`Note for ${user.name}`}
              onChange={(e) => onChange({ note: e.target.value })}
              className="min-h-[42px] w-full rounded-xl border border-line bg-surface px-3 text-[15px] text-fg placeholder:text-muted/70 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-50"
            />
          </label>
        </div>
      ) : (
        <div className="flex flex-1 flex-wrap items-center gap-3">
          {status ? (
            <Badge tone={STATUS_META[status].tone}>
              <CheckCircle size={14} weight="fill" />
              {STATUS_META[status].label}
            </Badge>
          ) : (
            <Badge>Not marked</Badge>
          )}
          <span className="inline-flex items-center gap-1.5 text-xs text-muted">
            <LockSimple size={14} />
            {isMe ? "You can't mark your own attendance — clock in from the app or ask the owner." : "Only the business owner can mark managers."}
          </span>
        </div>
      )}
    </li>
  );
}
