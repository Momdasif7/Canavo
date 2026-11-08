"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { FilmSlate, FloppyDisk } from "@phosphor-icons/react";
import { errorMessage } from "@/lib/api";
import { theatreApi, type TheatreSettings } from "@/lib/theatre";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Input, Toggle } from "@/components/ui/Input";
import { Alert, ErrorState, LoadingState } from "@/components/ui/States";

/** Settings → Online ordering: cinema seat ordering (THEATRE module). Owners and managers with table:manage edit it. */
export function TheatreSettingsCard() {
  const { outletId, can } = useSession();
  const toast = useToast();
  const editable = can("table:manage");
  const q = useApiQuery<TheatreSettings>(outletId ? `theatre-settings:${outletId}` : null, theatreApi.settings);
  const [s, setS] = useState<TheatreSettings | null>(null);
  const [lead, setLead] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!q.data) return;
    setS(q.data);
    setLead(String(q.data.intervalLeadMin));
  }, [q.data]);

  const header = (
    <CardHeader
      title={
        <span className="flex items-center gap-2">
          <FilmSlate size={20} className="text-primary" /> Cinema seat ordering
        </span>
      }
      subtitle="Guests scan the QR on their seat and order food during the movie. They pay by UPI first, then choose: now, at the interval, or collect at the counter."
      action={
        <Link href="/theatre" className="inline-flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-xl border border-line px-3 text-sm font-semibold hover:bg-surface-2">
          Screens &amp; seat QR codes
        </Link>
      }
    />
  );
  if (q.loading && !q.data)
    return (
      <Card>
        {header}
        <LoadingState label="Loading…" />
      </Card>
    );
  if (q.error && !q.data)
    return (
      <Card>
        {header}
        <ErrorState message={q.error} onRetry={q.reload} />
      </Card>
    );
  if (!s) return null;
  const set = (patch: Partial<TheatreSettings>) => setS({ ...s, ...patch });
  const leadNum = Number(lead);
  const leadBad = lead.trim() === "" || !Number.isInteger(leadNum) || leadNum < 0 || leadNum > 60;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const r = await theatreApi.saveSettings({ ...s, intervalLeadMin: leadNum });
      q.setData(r);
      toast("Cinema settings saved", "success");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card data-testid="theatre-settings">
      {header}
      <div className="space-y-4 px-5 py-4">
        <div className="divide-y divide-line">
          <Toggle
            checked={s.seatOrdering}
            disabled={!editable}
            onChange={(v) => set({ seatOrdering: v })}
            label="Take orders from seat QR codes"
            description="Off: seat codes show the menu only. Ordering opens 30 minutes before a show and closes at the show's cut-off."
          />
          <Toggle
            checked={s.deliverDuringShow}
            disabled={!editable}
            onChange={(v) => set({ deliverDuringShow: v })}
            label="Deliver to the seat during the show"
            description="Offers “Deliver to my seat now”. Off: guests can only choose the interval or the counter."
          />
          <Toggle
            checked={s.counterPickup}
            disabled={!editable}
            onChange={(v) => set({ counterPickup: v })}
            label="Collect at the counter"
            description="Offers “I'll collect at the counter” with a pickup token number."
          />
        </div>
        <Input
          label="Send interval orders to the kitchen (minutes before the interval)"
          inputMode="numeric"
          value={lead}
          disabled={!editable}
          maxLength={2}
          onChange={(e) => setLead(e.target.value.replace(/\D/g, ""))}
          error={leadBad ? "0 to 60 minutes" : null}
          hint="So the food is ready when the interval starts. Interval ordering closes at this point too."
          wrapperClassName="max-w-md"
        />
        {error && <Alert>{error}</Alert>}
        {editable ? (
          <div className="flex justify-end">
            <Button icon={<FloppyDisk size={20} />} loading={saving} disabled={leadBad} onClick={() => void save()}>
              Save
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted">Only owners and managers can change these.</p>
        )}
      </div>
    </Card>
  );
}
