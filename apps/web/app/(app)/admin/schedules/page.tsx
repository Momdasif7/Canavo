"use client";

import { useState } from "react";
import { EnvelopeSimple, PaperPlaneTilt, Plus, Trash } from "@phosphor-icons/react";
import { REPORT_KEYS, reportScheduleSchema, type ReportKey } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { PageHeader } from "@/components/layout/PageHeader";
import type { ReportSchedule, SendNowResult } from "@/components/admin/types";
import { REPORT_LABELS } from "@/components/admin/labels";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { Alert, EmptyState, ErrorState, LoadingState } from "@/components/ui/States";


export default function SchedulesPage() {
  const { outletId, me } = useSession();
  const toast = useToast();
  const list = useApiQuery<ReportSchedule[]>(outletId ? `schedules:${outletId}` : null, () => api.get<ReportSchedule[]>("/admin/report-schedules"));
  const [deleting, setDeleting] = useState<ReportSchedule | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const outletName = me?.outlets.find((o) => o.id === outletId)?.name ?? "this outlet";

  const sendNow = async (s: ReportSchedule) => {
    setSending(s.id);
    try {
      const r = await api.post<SendNowResult>(`/admin/report-schedules/${s.id}/send-now`);
      toast(
        r.delivered
          ? `Emailed ${r.attachments.length} report(s) to ${s.email}`
          : `SMTP not configured — email saved to the server outbox (${r.attachments.length} attachment(s))`,
        r.delivered ? "success" : "info",
      );
      await list.reload();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setSending(null);
    }
  };

  return (
    <>
      <PageHeader title="Report schedules" subtitle={`Email Excel reports automatically for ${outletName}. Daily emails go out at 10 pm; weekly on Monday morning for the previous week.`} />
      <div className="grid gap-5 xl:grid-cols-[1fr_420px]">
        <Card className="self-start">
          <CardHeader title="Scheduled emails" />
          {list.loading && !list.data ? (
            <LoadingState />
          ) : list.error ? (
            <ErrorState message={list.error} onRetry={list.reload} />
          ) : !list.data?.length ? (
            <EmptyState title="No schedules yet" description="Create one to get reports in your inbox." />
          ) : (
            <ul className="divide-y divide-line">
              {list.data.map((s) => (
                <li key={s.id} className="flex flex-wrap items-start gap-3 px-5 py-4">
                  <EnvelopeSimple size={24} className="mt-0.5 shrink-0 text-muted" />
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2 font-semibold">
                      <span className="truncate">{s.email}</span>
                      <Badge tone={s.frequency === "DAILY" ? "primary" : "info"}>{s.frequency === "DAILY" ? "Daily" : "Weekly"}</Badge>
                      {!s.active && <Badge>Paused</Badge>}
                    </p>
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {s.reports.map((k) => (
                        <Badge key={k}>{REPORT_LABELS[k] ?? k}</Badge>
                      ))}
                    </div>
                    <p className="mt-1.5 text-xs text-muted">{s.lastSentAt ? `Last sent ${formatDateTime(s.lastSentAt)}` : "Not sent yet"}</p>
                  </div>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" icon={<PaperPlaneTilt size={18} />} loading={sending === s.id} disabled={sending !== null} onClick={() => void sendNow(s)}>
                      Send now
                    </Button>
                    <Button variant="ghost" size="sm" className="text-red-600 dark:text-red-300" icon={<Trash size={18} />} onClick={() => setDeleting(s)} aria-label={`Delete schedule for ${s.email}`}>
                      <span className="hidden sm:inline">Delete</span>
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <CreateSchedule onCreated={(s) => list.setData((l) => [s, ...(l ?? [])])} />
      </div>

      <ConfirmDialog
        open={!!deleting}
        title="Delete schedule?"
        description={deleting ? `${deleting.email} will stop receiving ${deleting.frequency.toLowerCase()} reports.` : undefined}
        confirmLabel="Delete"
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          try {
            await api.del(`/admin/report-schedules/${deleting.id}`);
          } catch (e) {
            throw new Error(errorMessage(e));
          }
          list.setData((l) => l?.filter((x) => x.id !== deleting.id));
          toast("Schedule deleted", "success");
        }}
      />
    </>
  );
}

function CreateSchedule({ onCreated }: { onCreated: (s: ReportSchedule) => void }) {
  const toast = useToast();
  const { me } = useSession();
  const [email, setEmail] = useState(me?.email ?? "");
  const [frequency, setFrequency] = useState<"DAILY" | "WEEKLY">("DAILY");
  const [reports, setReports] = useState<ReportKey[]>(["sales", "items", "gst"]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (k: ReportKey) => setReports((r) => (r.includes(k) ? r.filter((x) => x !== k) : [...r, k]));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const parsed = reportScheduleSchema.safeParse({ email: email.trim(), frequency, reports, active: true });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return setError(issue.path[0] === "reports" ? "Pick at least one report" : issue.path[0] === "email" ? "Enter a valid email address" : issue.message);
    }
    setSaving(true);
    setError(null);
    try {
      const s = await api.post<ReportSchedule>("/admin/report-schedules", parsed.data);
      onCreated(s);
      toast("Schedule created", "success");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="self-start">
      <CardHeader title="New schedule" />
      <form onSubmit={submit} className="space-y-4 p-5">
        {error && <Alert>{error}</Alert>}
        <Input label="Send to" type="email" required placeholder="owner@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
        <div>
          <p className="mb-1.5 text-sm font-semibold">Frequency</p>
          <Segmented
            value={frequency}
            onChange={setFrequency}
            options={[
              { value: "DAILY", label: "Daily (today)" },
              { value: "WEEKLY", label: "Weekly (last 7 days)" },
            ]}
          />
        </div>
        <fieldset>
          <legend className="mb-1.5 flex w-full items-center justify-between text-sm font-semibold">
            Reports
            <button
              type="button"
              className="text-xs font-semibold text-primary hover:underline"
              onClick={() => setReports(reports.length === REPORT_KEYS.length ? [] : [...REPORT_KEYS])}
            >
              {reports.length === REPORT_KEYS.length ? "Clear all" : "Select all"}
            </button>
          </legend>
          <div className="grid grid-cols-2 gap-2">
            {REPORT_KEYS.map((k) => (
              <label key={k} className="flex min-h-[44px] cursor-pointer items-center gap-2 rounded-xl border border-line px-3 text-sm font-semibold has-[:checked]:border-primary has-[:checked]:bg-primary-50 dark:has-[:checked]:bg-primary/10">
                <input type="checkbox" className="h-4 w-4 accent-[#FF6B35]" checked={reports.includes(k)} onChange={() => toggle(k)} />
                {REPORT_LABELS[k]}
              </label>
            ))}
          </div>
        </fieldset>
        <Button type="submit" block icon={<Plus size={20} />} loading={saving}>
          Create schedule
        </Button>
      </form>
    </Card>
  );
}
