"use client";

import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Check, FileCsv, FileXls, PencilSimple, Plus, Trash, X } from "@phosphor-icons/react";
import { ROLE_LABELS, formatINR } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { addDaysISO, currentMonth, monthLabel, todayISO } from "@/lib/dates";
import { saveBlob } from "@/lib/download";
import { formatMinutes, formatTime, titleCase } from "@/lib/format";
import { canManageAttendanceOf, isBusinessWideRole } from "@/lib/roles";
import type { AttendanceCalendar, AttendanceRecord, CalendarStatus, LeaveRequest, SalarySheet, Shift, Staff } from "@/lib/types";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { Button, IconButton } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Segmented } from "@/components/ui/Segmented";
import { Table, THead, Th, Td } from "@/components/ui/Table";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { DailyRegister } from "@/components/attendance/DailyRegister";
import { FaceReviews } from "@/components/attendance/FaceReviews";
import { AddAttendanceDialog } from "@/components/attendance/AddAttendanceDialog";
import { EditAttendanceDialog } from "@/components/attendance/EditAttendanceDialog";
import { CAL_STYLE, STATUS_META, hasTimes, sourceLabel } from "@/components/attendance/shared";

type Tab = "register" | "records" | "calendar" | "leaves" | "salary" | "face";

export default function AttendancePage() {
  const { can, me } = useSession();
  const manage = can("attendance:manage");
  const faceChecks = manage && Boolean(me?.features?.CLOCK_IN_FACE_MATCH);
  const [tab, setTab] = useState<Tab>(manage ? "register" : "records");
  /** Bumped after register / dialog saves so other tabs refetch. */
  const [version, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);
  return (
    <PageContainer>
      <PageHeader
        title="Attendance"
        actions={
          <div className="-mx-1 max-w-full overflow-x-auto px-1">
            <Segmented
              value={tab}
              onChange={setTab}
              options={[
                ...(manage ? [{ value: "register" as const, label: "Daily register" }] : []),
                { value: "records", label: "Records" },
                { value: "calendar", label: "Calendar" },
                { value: "leaves", label: "Leave requests" },
                { value: "salary", label: "Salary" },
                ...(faceChecks ? [{ value: "face" as const, label: "Face checks" }] : []),
              ]}
            />
          </div>
        }
      />
      {/* Kept mounted so unsaved marks survive a tab switch. */}
      {manage && (
        <div hidden={tab !== "register"}>
          <DailyRegister onSaved={bump} />
        </div>
      )}
      {tab === "records" && <Records version={version} onChanged={bump} />}
      {tab === "calendar" && <CalendarView version={version} />}
      {tab === "leaves" && <Leaves />}
      {tab === "salary" && <Salary version={version} />}
      {tab === "face" && faceChecks && <FaceReviews />}
    </PageContainer>
  );
}

function useStaffList() {
  const { outletId } = useSession();
  return useApiQuery<Staff[]>(outletId ? `staff:${outletId}` : null, () => api.get<Staff[]>("/staff"));
}

// ---------- Records ----------
function Records({ version, onChanged }: { version: number; onChanged: () => void }) {
  const { outletId, outlet, me, can } = useSession();
  const toast = useToast();
  const today = todayISO(outlet?.timezone);
  const [from, setFrom] = useState(addDaysISO(today, -6));
  const [to, setTo] = useState(today);
  const [userId, setUserId] = useState("");
  const [exporting, setExporting] = useState<"xlsx" | "csv" | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<AttendanceRecord | null>(null);
  const [deleting, setDeleting] = useState<AttendanceRecord | null>(null);
  const staff = useStaffList();
  // Owners see every account of the business, so "Edited by" can name them too.
  const wide = !!me && isBusinessWideRole(me.role) && can("staff:view");
  const people = useApiQuery<Staff[]>(outletId && wide ? `staff-wide:${outletId}` : null, () => api.get<Staff[]>("/staff", { query: { scope: "business" } }));
  const shifts = useApiQuery<Shift[]>(outletId ? `shifts:${outletId}` : null, () => api.get<Shift[]>("/outlets/current/shifts"));
  const valid = from <= to;
  const records = useApiQuery<AttendanceRecord[]>(outletId && valid ? `att:${outletId}:${from}:${to}:${userId}:${version}` : null, () =>
    api.get<AttendanceRecord[]>("/attendance", { query: { from, to, userId } }),
  );

  const names = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of [...(staff.data ?? []), ...(people.data ?? [])]) m.set(s.id, s.name);
    if (me) m.set(me.id, me.name);
    return m;
  }, [staff.data, people.data, me]);

  const shiftFor = (uid: string | undefined) => {
    const sid = staff.data?.find((s) => s.id === uid)?.shiftId;
    return shifts.data?.find((s) => s.id === sid) ?? null;
  };

  const exportFile = async (format: "xlsx" | "csv") => {
    setExporting(format);
    try {
      const { blob, filename } = await api.blob("/attendance/export", { query: { from, to, userId, format } }, `attendance_${from}_${to}.${format}`);
      saveBlob(blob, filename);
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setExporting(null);
    }
  };

  const remove = async (r: AttendanceRecord) => {
    await api.del(`/attendance/${r.id}`);
    records.setData((list) => list?.filter((x) => x.id !== r.id));
    toast("Attendance record deleted", "success");
    onChanged();
  };

  const mayManage = (r: AttendanceRecord) => !!me && !!r.user && canManageAttendanceOf(me, r.user);

  return (
    <Card>
      <div className="flex flex-wrap items-end gap-3 border-b border-line p-4">
        <Input label="From" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
        <Input label="To" type="date" value={to} min={from} max={today} onChange={(e) => setTo(e.target.value)} />
        <Select label="Staff" value={userId} onChange={(e) => setUserId(e.target.value)} wrapperClassName="w-full sm:w-52">
          <option value="">Everyone</option>
          {(staff.data ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        <div className="flex flex-wrap gap-2 lg:ml-auto">
          <Button icon={<Plus size={18} weight="bold" />} onClick={() => setAdding(true)}>
            Add attendance
          </Button>
          <Button variant="outline" icon={<FileXls size={20} />} loading={exporting === "xlsx"} disabled={!valid} onClick={() => exportFile("xlsx")}>
            Excel
          </Button>
          <Button variant="outline" icon={<FileCsv size={20} />} loading={exporting === "csv"} disabled={!valid} onClick={() => exportFile("csv")}>
            CSV
          </Button>
        </div>
      </div>
      {!valid ? (
        <ErrorState message="'From' must be on or before 'To'." />
      ) : records.loading && !records.data ? (
        <LoadingState />
      ) : records.error ? (
        <ErrorState message={records.error} onRetry={records.reload} />
      ) : !records.data?.length ? (
        <EmptyState title="No attendance records" description="Clock-ins and manually marked days in this range will appear here." />
      ) : (
        <Table>
          <THead>
            <tr>
              <Th>Date</Th>
              <Th>Name</Th>
              <Th>In</Th>
              <Th>Out</Th>
              <Th className="text-right">Worked</Th>
              <Th className="text-right">Late</Th>
              <Th className="text-right">Early</Th>
              <Th className="text-right">Overtime</Th>
              <Th>Status</Th>
              <Th>Source</Th>
              <Th>
                <span className="sr-only">Actions</span>
              </Th>
            </tr>
          </THead>
          <tbody>
            {records.data.map((r) => {
              const timed = hasTimes(r);
              const src = sourceLabel(r, r.markedById ? (names.get(r.markedById) ?? null) : null);
              return (
                <tr key={r.id} data-testid={`record-${r.id}`}>
                  <Td className="tabular whitespace-nowrap">{r.workDate}</Td>
                  <Td className="min-w-[150px]">
                    <span className="font-semibold">{r.user?.name}</span>
                    {r.user && <span className="block text-xs text-muted">{ROLE_LABELS[r.user.role]}</span>}
                  </Td>
                  <Td className="tabular whitespace-nowrap">{timed ? formatTime(r.clockInAt) : "—"}</Td>
                  <Td className="tabular whitespace-nowrap">{!timed ? "—" : r.clockOutAt ? formatTime(r.clockOutAt) : <Badge tone="info">On shift</Badge>}</Td>
                  <Td className="tabular text-right">{timed ? formatMinutes(r.workedMinutes) : "—"}</Td>
                  <Td className={clsx("tabular text-right", r.lateByMinutes > 0 && "font-bold text-amber-700 dark:text-amber-300")}>{r.lateByMinutes ? `${r.lateByMinutes}m` : "—"}</Td>
                  <Td className={clsx("tabular text-right", r.earlyByMinutes > 15 && "font-bold text-amber-700 dark:text-amber-300")}>{r.earlyByMinutes ? `${r.earlyByMinutes}m` : "—"}</Td>
                  <Td className={clsx("tabular text-right", r.overtimeMinutes > 0 && "font-bold text-secondary dark:text-green-300")}>
                    {r.overtimeMinutes ? formatMinutes(r.overtimeMinutes) : "—"}
                  </Td>
                  <Td>
                    {timed && !r.clockOutAt ? <span className="text-xs text-muted">Open</span> : <Badge tone={STATUS_META[r.status].tone}>{STATUS_META[r.status].label}</Badge>}
                  </Td>
                  <Td>
                    <span title={r.note || undefined}>
                      <Badge tone={src.tone}>{src.label}</Badge>
                    </span>
                    {r.note && <span className="mt-0.5 block max-w-[180px] truncate text-xs text-muted">{r.note}</span>}
                  </Td>
                  <Td className="whitespace-nowrap text-right">
                    {mayManage(r) && (
                      <div className="flex justify-end">
                        <IconButton label={`Edit ${r.user?.name ?? ""} ${r.workDate}`} onClick={() => setEditing(r)}>
                          <PencilSimple size={20} />
                        </IconButton>
                        <IconButton label={`Delete ${r.user?.name ?? ""} ${r.workDate}`} className="text-red-600 dark:text-red-400" onClick={() => setDeleting(r)}>
                          <Trash size={20} />
                        </IconButton>
                      </div>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      <AddAttendanceDialog open={adding} onClose={() => setAdding(false)} onSaved={onChanged} />
      <EditAttendanceDialog
        record={editing}
        shift={shiftFor(editing?.userId)}
        onClose={() => setEditing(null)}
        onSaved={(u) => {
          records.setData((list) => list?.map((x) => (x.id === u.id ? u : x)));
          onChanged();
        }}
      />
      <ConfirmDialog
        open={!!deleting}
        title="Delete attendance record?"
        description={
          deleting?.source === "SELF"
            ? `This removes the employee's own clock-in (${deleting.user?.name}, ${deleting.workDate}), including its GPS location. The day will count as absent unless you mark it again.`
            : deleting
              ? `${deleting.user?.name} on ${deleting.workDate} will no longer be marked ${STATUS_META[deleting.status].label.toLowerCase()}.`
              : undefined
        }
        confirmLabel="Delete"
        onConfirm={async () => {
          if (deleting) await remove(deleting);
        }}
        onClose={() => setDeleting(null)}
      />
    </Card>
  );
}

// ---------- Calendar ----------

function CalendarView({ version }: { version: number }) {
  const { outlet } = useSession();
  const staff = useStaffList();
  const [userId, setUserId] = useState("");
  const [month, setMonth] = useState(currentMonth(outlet?.timezone));

  useEffect(() => {
    if (!userId && staff.data?.length) setUserId(staff.data[0].id);
  }, [staff.data, userId]);

  const cal = useApiQuery<AttendanceCalendar>(userId && month ? `cal:${userId}:${month}:${version}` : null, () =>
    api.get<AttendanceCalendar>("/attendance/calendar", { query: { month, userId } }),
  );

  const days = cal.data?.days ?? [];
  // Monday-first grid offset.
  const offset = days.length ? (new Date(`${days[0].date}T00:00:00Z`).getUTCDay() + 6) % 7 : 0;
  const totals = days.reduce<Record<string, number>>((acc, d) => ({ ...acc, [d.status]: (acc[d.status] ?? 0) + 1 }), {});

  return (
    <Card>
      <div className="flex flex-wrap items-end gap-3 border-b border-line p-4">
        <Select label="Staff" value={userId} onChange={(e) => setUserId(e.target.value)} wrapperClassName="w-full sm:w-56">
          {(staff.data ?? []).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        <Input label="Month" type="month" value={month} max={currentMonth(outlet?.timezone)} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        <div className="flex flex-wrap gap-3 text-sm lg:ml-auto" aria-label="Legend">
          {(["PRESENT", "HALF_DAY", "LEAVE", "ABSENT"] as CalendarStatus[]).map((s) => (
            <span key={s} className="flex items-center gap-1.5">
              <span className={clsx("h-3.5 w-3.5 rounded", CAL_STYLE[s].cls)} />
              {CAL_STYLE[s].label} <strong className="tabular">{totals[s] ?? 0}</strong>
            </span>
          ))}
          <span className="flex items-center gap-1.5 text-muted">
            <span className={clsx("h-3.5 w-3.5 rounded border border-line", CAL_STYLE.UPCOMING.cls)} />
            Upcoming
          </span>
          <span className="flex items-center gap-1.5 text-muted">
            <PencilSimple size={14} weight="bold" /> Marked / edited by manager
          </span>
        </div>
      </div>
      {cal.loading || staff.loading ? (
        <LoadingState />
      ) : cal.error ? (
        <ErrorState message={cal.error} onRetry={cal.reload} />
      ) : !days.length ? (
        <EmptyState title="Pick a staff member" />
      ) : (
        <div className="p-4">
          <p className="mb-3 font-bold">{monthLabel(month)}</p>
          <div className="grid grid-cols-7 gap-1.5 text-center text-xs font-semibold uppercase text-muted">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => (
              <div key={d} className="py-1">
                {d}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-1.5">
            {Array.from({ length: offset }, (_, i) => (
              <div key={`pad-${i}`} />
            ))}
            {days.map((d) => {
              const marked = (d.records ?? []).some((r) => r.source === "MANUAL" || !!r.editedAt);
              const note = (d.records ?? []).find((r) => r.note)?.note;
              return (
                <div
                  key={d.date}
                  title={`${d.date}: ${CAL_STYLE[d.status].label}${d.workedMinutes ? ` · ${formatMinutes(d.workedMinutes)}` : ""}${d.lateByMinutes ? ` · late ${d.lateByMinutes}m` : ""}${marked ? " · marked by manager" : ""}${note ? ` · “${note}”` : ""}`}
                  data-status={d.status}
                  className={clsx("relative flex min-h-[52px] flex-col rounded-xl p-1.5 text-left sm:min-h-[64px] sm:p-2", CAL_STYLE[d.status].cls)}
                >
                  <span className="text-sm font-bold">{Number(d.date.slice(8))}</span>
                  {marked && <PencilSimple size={12} weight="bold" className="absolute right-1.5 top-1.5 opacity-80" aria-label="Marked by manager" />}
                  {d.workedMinutes > 0 && <span className="tabular mt-auto hidden text-[11px] opacity-90 sm:block">{formatMinutes(d.workedMinutes)}</span>}
                  {d.lateByMinutes > 0 && <span className="hidden text-[11px] font-semibold opacity-90 sm:block">Late {d.lateByMinutes}m</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </Card>
  );
}

// ---------- Leaves ----------
function Leaves() {
  const { outletId, me } = useSession();
  const toast = useToast();
  const leaves = useApiQuery<LeaveRequest[]>(outletId ? `leaves:${outletId}` : null, () => api.get<LeaveRequest[]>("/attendance/leaves", { query: { scope: "outlet" } }));
  const [busy, setBusy] = useState<string | null>(null);

  const review = async (l: LeaveRequest, status: "APPROVED" | "REJECTED") => {
    setBusy(l.id);
    try {
      await api.patch(`/attendance/leaves/${l.id}`, { status });
      leaves.setData((list) => list?.map((x) => (x.id === l.id ? { ...x, status } : x)));
      toast(`Leave ${status.toLowerCase()}`, "success");
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const sorted = [...(leaves.data ?? [])].sort((a, b) => Number(b.status === "PENDING") - Number(a.status === "PENDING"));
  const pending = sorted.filter((l) => l.status === "PENDING").length;

  return (
    <Card>
      <div className="border-b border-line px-5 py-4">
        <h2 className="font-bold">Leave requests</h2>
        <p className="text-sm text-muted">{pending ? `${pending} awaiting your review` : "Nothing pending"}</p>
      </div>
      {leaves.loading && !leaves.data ? (
        <LoadingState />
      ) : leaves.error ? (
        <ErrorState message={leaves.error} onRetry={leaves.reload} />
      ) : !sorted.length ? (
        <EmptyState title="No leave requests" />
      ) : (
        <Table>
          <THead>
            <tr>
              <Th>Staff</Th>
              <Th>Dates</Th>
              <Th>Type</Th>
              <Th>Reason</Th>
              <Th>Status</Th>
              <Th />
            </tr>
          </THead>
          <tbody>
            {sorted.map((l) => (
              <tr key={l.id}>
                <Td>
                  <span className="font-semibold">{l.user?.name}</span>
                  {l.user && <span className="block text-xs text-muted">{ROLE_LABELS[l.user.role]}</span>}
                </Td>
                <Td className="tabular whitespace-nowrap">{l.fromDate === l.toDate ? l.fromDate : `${l.fromDate} → ${l.toDate}`}</Td>
                <Td>{titleCase(l.type)}</Td>
                <Td className="max-w-xs text-muted">{l.reason || "—"}</Td>
                <Td>
                  <Badge tone={l.status === "APPROVED" ? "success" : l.status === "REJECTED" ? "danger" : "warning"}>{titleCase(l.status)}</Badge>
                </Td>
                <Td className="whitespace-nowrap text-right">
                  {l.status === "PENDING" && l.userId !== me?.id && (
                    <div className="flex justify-end gap-2">
                      <Button size="sm" variant="secondary" icon={<Check size={16} weight="bold" />} loading={busy === l.id} onClick={() => review(l, "APPROVED")}>
                        Approve
                      </Button>
                      <Button size="sm" variant="outline" icon={<X size={16} weight="bold" />} disabled={busy === l.id} onClick={() => review(l, "REJECTED")}>
                        Reject
                      </Button>
                    </div>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}

// ---------- Salary ----------
function Salary({ version }: { version: number }) {
  const { outletId, outlet } = useSession();
  const [month, setMonth] = useState(currentMonth(outlet?.timezone));
  const sheet = useApiQuery<SalarySheet>(outletId && month ? `salary:${outletId}:${month}:${version}` : null, () => api.get<SalarySheet>("/attendance/salary", { query: { month } }));
  const total = (sheet.data?.rows ?? []).reduce((s, r) => s + r.grossPay, 0);

  return (
    <Card>
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line p-4">
        <Input label="Month" type="month" value={month} max={currentMonth(outlet?.timezone)} onChange={(e) => e.target.value && setMonth(e.target.value)} />
        {sheet.data && (
          <div className="text-right">
            <p className="text-sm text-muted">Total payable · {monthLabel(month)}</p>
            <p className="tabular text-2xl font-extrabold">{formatINR(total)}</p>
          </div>
        )}
      </div>
      {sheet.loading && !sheet.data ? (
        <LoadingState />
      ) : sheet.error ? (
        <ErrorState message={sheet.error} onRetry={sheet.reload} />
      ) : !sheet.data?.rows.length ? (
        <EmptyState title="No staff on payroll" />
      ) : (
        <>
          <Table>
            <THead>
              <tr>
                <Th>Name</Th>
                <Th className="text-right">Salary</Th>
                <Th className="text-right">Present</Th>
                <Th className="text-right">Half days</Th>
                <Th className="text-right">Paid leave</Th>
                <Th className="text-right">Payable days</Th>
                <Th className="text-right">Overtime</Th>
                <Th className="text-right">Daily rate</Th>
                <Th className="text-right">Gross pay</Th>
              </tr>
            </THead>
            <tbody>
              {sheet.data.rows.map((r) => (
                <tr key={r.userId}>
                  <Td>
                    <span className="font-semibold">{r.name}</span>
                    <span className="block text-xs text-muted">{ROLE_LABELS[r.role]}</span>
                  </Td>
                  <Td className="tabular text-right">
                    {formatINR(r.salaryAmount)}
                    <span className="text-xs text-muted"> /{r.salaryType === "DAILY" ? "day" : "mo"}</span>
                  </Td>
                  <Td className="tabular text-right">{r.presentDays}</Td>
                  <Td className="tabular text-right">{r.halfDays}</Td>
                  <Td className="tabular text-right">{r.paidLeaveDays}</Td>
                  <Td className="tabular text-right font-semibold">{r.payableDays}</Td>
                  <Td className="tabular text-right">{formatMinutes(r.overtimeMinutes)}</Td>
                  <Td className="tabular text-right">{formatINR(r.dailyRate)}</Td>
                  <Td className="tabular text-right font-extrabold">{formatINR(r.grossPay)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="px-5 py-3 text-xs text-muted">
            Payable days = present + ½ × half days + approved casual/sick leave, over {sheet.data.daysInMonth} days. Overtime is shown for reference and not included in gross pay.
          </p>
        </>
      )}
    </Card>
  );
}
