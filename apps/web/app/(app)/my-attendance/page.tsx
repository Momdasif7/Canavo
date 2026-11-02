"use client";

import { useMemo, useState } from "react";
import clsx from "clsx";
import { CaretLeft, CaretRight, PaperPlaneTilt } from "@phosphor-icons/react";
import { leaveRequestSchema } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { todayISO } from "@/lib/dates";
import type { AttendanceCalendar, CalendarStatus, LeaveRequest } from "@/lib/types";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useToast } from "@/components/providers/ToastProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Input, Select, Textarea } from "@/components/ui/Input";
import { Alert, EmptyState, ErrorState, LoadingState } from "@/components/ui/States";

const LEAVE_TYPES: { value: LeaveRequest["type"]; label: string }[] = [
  { value: "CASUAL", label: "Casual leave" },
  { value: "SICK", label: "Sick leave" },
  { value: "UNPAID", label: "Unpaid leave" },
  { value: "HALF_DAY", label: "Half day" },
];
const TYPE_LABEL = Object.fromEntries(LEAVE_TYPES.map((t) => [t.value, t.label])) as Record<LeaveRequest["type"], string>;
const STATUS_TONE = { PENDING: "warning", APPROVED: "success", REJECTED: "danger" } as const;
const DAY_STYLE: Record<CalendarStatus, string> = {
  PRESENT: "bg-secondary/15 text-secondary-700 dark:text-green-200",
  HALF_DAY: "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-200",
  LEAVE: "bg-sky-100 text-sky-800 dark:bg-sky-500/15 dark:text-sky-200",
  ABSENT: "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-300",
  UPCOMING: "text-muted",
};
const DAY_LABEL: Record<CalendarStatus, string> = { PRESENT: "Present", HALF_DAY: "Half day", LEAVE: "Leave", ABSENT: "Absent", UPCOMING: "" };

const shiftMonth = (month: string, by: number) => {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + by, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
};

/**
 * Staff & attendance → My attendance & leave: every employee who clocks in (cashier, kitchen,
 * delivery, inventory, waiter…) sees their own month and asks for leave from the web, as they
 * already can in the mobile app. Managers review requests under Attendance → Leave requests.
 */
export default function MyAttendancePage() {
  const toast = useToast();
  const [month, setMonth] = useState(todayISO().slice(0, 7));
  const calendar = useApiQuery(`my-calendar:${month}`, () => api.get<AttendanceCalendar>("/attendance/calendar", { query: { month } }));
  const leaves = useApiQuery("my-leaves", () => api.get<LeaveRequest[]>("/attendance/leaves"));
  const [form, setForm] = useState({ fromDate: todayISO(), toDate: todayISO(), type: "CASUAL" as LeaveRequest["type"], reason: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totals = useMemo(() => {
    const t: Partial<Record<CalendarStatus, number>> = {};
    for (const d of calendar.data?.days ?? []) t[d.status] = (t[d.status] ?? 0) + 1;
    return t;
  }, [calendar.data]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = leaveRequestSchema.safeParse({ ...form, reason: form.reason.trim() });
    if (!parsed.success) return setError(parsed.error.issues[0]?.message === "toDate must be on or after fromDate" ? "The end date must be on or after the start date" : (parsed.error.issues[0]?.message ?? "Check the dates"));
    setSaving(true);
    setError(null);
    try {
      await api.post("/attendance/leaves", parsed.data, { outletId: null });
      toast("Leave request sent to your manager", "success");
      setForm((f) => ({ ...f, reason: "" }));
      await leaves.reload();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const firstWeekday = calendar.data ? new Date(`${calendar.data.days[0]!.date}T00:00:00Z`).getUTCDay() : 0;

  return (
    <PageContainer>
      <PageHeader title="My attendance & leave" subtitle="Your days this month and your leave requests. Your manager is notified when you ask for leave." />
      <div className="grid gap-5 xl:grid-cols-[1fr_420px]">
        <Card>
          <CardHeader
            title={new Date(`${month}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" })}
            subtitle={`${totals.PRESENT ?? 0} present · ${totals.HALF_DAY ?? 0} half day · ${totals.LEAVE ?? 0} leave · ${totals.ABSENT ?? 0} absent`}
            action={
              <div className="flex gap-1">
                <IconButton label="Previous month" onClick={() => setMonth((m) => shiftMonth(m, -1))}>
                  <CaretLeft size={20} />
                </IconButton>
                <IconButton label="Next month" onClick={() => setMonth((m) => shiftMonth(m, 1))} disabled={month >= todayISO().slice(0, 7)}>
                  <CaretRight size={20} />
                </IconButton>
              </div>
            }
          />
          <div className="p-4">
            {calendar.loading && !calendar.data ? (
              <LoadingState />
            ) : calendar.error ? (
              <ErrorState message={calendar.error} onRetry={calendar.reload} />
            ) : (
              <div className="grid grid-cols-7 gap-1.5 text-center text-xs">
                {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
                  <div key={d} className="py-1 font-semibold text-muted">
                    {d}
                  </div>
                ))}
                {Array.from({ length: firstWeekday }, (_, i) => (
                  <div key={`pad-${i}`} />
                ))}
                {calendar.data!.days.map((d) => (
                  <div key={d.date} className={clsx("flex min-h-[56px] flex-col items-center justify-center rounded-lg border border-line", DAY_STYLE[d.status])}>
                    <span className="text-sm font-bold">{Number(d.date.slice(8))}</span>
                    <span>{DAY_LABEL[d.status]}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Card>

        <div className="space-y-5">
          <Card>
            <CardHeader title="Ask for leave" />
            <form onSubmit={submit} className="space-y-4 p-5">
              {error && <Alert>{error}</Alert>}
              <div className="grid gap-3 sm:grid-cols-2">
                <Input label="From" type="date" min={todayISO()} value={form.fromDate} onChange={(e) => setForm((f) => ({ ...f, fromDate: e.target.value, toDate: f.toDate < e.target.value ? e.target.value : f.toDate }))} />
                <Input label="To" type="date" min={form.fromDate} value={form.toDate} onChange={(e) => setForm((f) => ({ ...f, toDate: e.target.value }))} />
              </div>
              <Select label="Type" value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as LeaveRequest["type"] }))}>
                {LEAVE_TYPES.map((t) => (
                  <option key={t.value} value={t.value}>
                    {t.label}
                  </option>
                ))}
              </Select>
              <Textarea label="Reason (optional)" maxLength={500} value={form.reason} onChange={(e) => setForm((f) => ({ ...f, reason: e.target.value }))} />
              <Button type="submit" icon={<PaperPlaneTilt size={20} />} loading={saving}>
                Send request
              </Button>
            </form>
          </Card>

          <Card>
            <CardHeader title="My leave requests" />
            {leaves.loading && !leaves.data ? (
              <LoadingState />
            ) : !leaves.data?.length ? (
              <EmptyState title="No leave requests yet" />
            ) : (
              <ul className="divide-y divide-line text-sm">
                {leaves.data.map((l) => (
                  <li key={l.id} className="flex flex-wrap items-center gap-2 px-5 py-3">
                    <span className="min-w-0 flex-1">
                      <span className="font-semibold">{TYPE_LABEL[l.type]}</span> · {l.fromDate === l.toDate ? l.fromDate : `${l.fromDate} → ${l.toDate}`}
                      {l.reason && <span className="block text-xs text-muted">{l.reason}</span>}
                      <span className="block text-xs text-muted">Asked {formatDateTime(l.createdAt)}</span>
                    </span>
                    <Badge tone={STATUS_TONE[l.status]}>{l.status.toLowerCase()}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </PageContainer>
  );
}
