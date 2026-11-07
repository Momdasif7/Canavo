"use client";

import { useState } from "react";
import { Lifebuoy } from "@phosphor-icons/react";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useToast } from "@/components/providers/ToastProvider";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Input, Select } from "@/components/ui/Input";
import { Alert, LoadingState } from "@/components/ui/States";

interface Grant {
  id: string;
  reason: string | null;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
  active: boolean;
  views: number;
  lastViewedAt: string | null;
}

interface ActivityRow {
  id: string;
  at: string;
  method: string;
  path: string;
  by: string | null;
}

/**
 * Settings → Support access (owner): let the CANAVO team look inside the hotel, read-only, for
 * a few hours, e.g. to help with a problem. End it any time; see every screen they opened.
 */
export function SupportAccessCard() {
  const toast = useToast();
  const grants = useApiQuery("support-grants", () => api.get<Grant[]>("/support-access"));
  const [hours, setHours] = useState("24");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activityFor, setActivityFor] = useState<Grant | null>(null);
  const active = grants.data?.find((g) => g.active);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await grants.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-2">
            Support access {active ? <Badge tone="warning">Allowed</Badge> : <Badge tone="neutral">Off</Badge>}
          </span>
        }
        subtitle="The CANAVO team can't see your hotel's data. If you need help, allow them to look in for a few hours: read-only, they can't change anything, and you see every screen they open."
      />
      <div className="space-y-4 p-5">
        {error && <Alert>{error}</Alert>}
        {grants.loading && !grants.data ? (
          <LoadingState />
        ) : active ? (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-amber-50 p-4 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
            <span>
              <Lifebuoy size={18} className="mr-1 inline" /> Allowed until <b>{formatDateTime(active.expiresAt)}</b>
              {active.reason && ` · “${active.reason}”`} · {active.views} screen{active.views === 1 ? "" : "s"} viewed
            </span>
            <Button
              size="sm"
              variant="danger"
              loading={busy}
              onClick={() =>
                void run(async () => {
                  await api.post(`/support-access/${active.id}/revoke`, {});
                  toast("Support access ended", "success");
                })
              }
            >
              End now
            </Button>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-[160px,1fr,auto] sm:items-end">
            <Select label="For" value={hours} onChange={(e) => setHours(e.target.value)}>
              <option value="2">2 hours</option>
              <option value="8">8 hours</option>
              <option value="24">24 hours</option>
              <option value="72">3 days</option>
            </Select>
            <Input label="Reason (optional)" maxLength={300} placeholder="e.g. Help with printer setup" value={reason} onChange={(e) => setReason(e.target.value)} />
            <Button
              loading={busy}
              onClick={() =>
                void run(async () => {
                  await api.post("/support-access", { hours: Number(hours), reason: reason.trim() || undefined });
                  setReason("");
                  toast("Support access allowed", "success");
                })
              }
            >
              Allow access
            </Button>
          </div>
        )}

        {(grants.data ?? []).length > 0 && (
          <div>
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">History</p>
            <ul className="divide-y divide-line rounded-xl border border-line text-sm">
              {grants.data!.map((g) => (
                <li key={g.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
                  <span className="min-w-0 flex-1">
                    {formatDateTime(g.createdAt)} → {g.revokedAt ? `ended ${formatDateTime(g.revokedAt)}` : formatDateTime(g.expiresAt)}
                    {g.reason && <span className="text-muted"> · {g.reason}</span>}
                  </span>
                  <Button size="sm" variant="ghost" disabled={!g.views} onClick={() => setActivityFor(g)}>
                    {g.views} viewed
                  </Button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <ActivityDialog grant={activityFor} onClose={() => setActivityFor(null)} />
    </Card>
  );
}

function ActivityDialog({ grant, onClose }: { grant: Grant | null; onClose: () => void }) {
  const rows = useApiQuery(grant ? `support-activity:${grant.id}` : null, () => api.get<ActivityRow[]>(`/support-access/${grant!.id}/activity`));
  return (
    <Dialog open={!!grant} onClose={onClose} title="What the support team opened" description="Every screen and data request, newest first.">
      {rows.loading ? (
        <LoadingState />
      ) : (
        <ul className="max-h-[60vh] divide-y divide-line overflow-auto font-mono text-xs">
          {(rows.data ?? []).map((r) => (
            <li key={r.id} className="flex gap-3 py-1.5">
              <span className="shrink-0 text-muted">{formatDateTime(r.at)}</span>
              <span className="break-all">{r.path}</span>
              {r.by && <span className="ml-auto shrink-0 font-sans text-muted">{r.by}</span>}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
