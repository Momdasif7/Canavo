"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { CaretLeft, CaretRight, Clock, PencilSimple, Plus, Trash } from "@phosphor-icons/react";
import { showTimeSchema } from "@canavo/shared";
import { ApiError, errorMessage } from "@/lib/api";
import { addDaysISO, todayISO } from "@/lib/dates";
import { clock, theatreApi, zonedIso, zonedParts, type Screen, type ShowTime } from "@/lib/theatre";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useNow } from "@/hooks/useNow";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Dialog } from "@/components/ui/Dialog";
import { Input, Select } from "@/components/ui/Input";
import { Alert, EmptyState, ErrorState, LoadingState } from "@/components/ui/States";

/** Day timeline: 08:00 → 02:00 next day (late shows run past midnight). */
const DAY_START_H = 8;
const DAY_HOURS = 18;

const STATUS_TONE: Record<ShowTime["status"], "info" | "success" | "warning" | "neutral"> = { UPCOMING: "info", RUNNING: "success", INTERVAL: "warning", ENDED: "neutral" };
const STATUS_LABEL: Record<ShowTime["status"], string> = { UPCOMING: "Upcoming", RUNNING: "Running", INTERVAL: "Interval", ENDED: "Ended" };

type Draft = { id?: string; screenId: string; title: string; date: string; start: string; interval: string; end: string; cutoff: string };

/** Cinema → Showtimes: a day view per screen; add, edit and delete shows. */
export default function ShowtimesPage() {
  const { outletId, outlet } = useSession();
  const tz = outlet?.timezone ?? "Asia/Kolkata";
  const toast = useToast();
  const [date, setDate] = useState(() => todayISO(tz));
  const screens = useApiQuery<Screen[]>(outletId ? `theatre-screens:${outletId}` : null, theatreApi.screens);
  const shows = useApiQuery<ShowTime[]>(outletId ? `theatre-shows:${outletId}:${date}` : null, () => theatreApi.showtimes(date));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [deleting, setDeleting] = useState<ShowTime | null>(null);
  const now = useNow(30_000);

  const list = useMemo(() => [...(screens.data ?? [])].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)), [screens.data]);
  const byScreen = useMemo(() => {
    const m = new Map<string, ShowTime[]>();
    for (const s of shows.data ?? []) m.set(s.screenId, [...(m.get(s.screenId) ?? []), s].sort((a, b) => a.startsAt.localeCompare(b.startsAt)));
    return m;
  }, [shows.data]);

  const dayStart = new Date(zonedIso(date, `${String(DAY_START_H).padStart(2, "0")}:00`, tz)).getTime();
  const span = DAY_HOURS * 3600_000;
  const pct = (iso: string) => Math.min(100, Math.max(0, ((new Date(iso).getTime() - dayStart) / span) * 100));
  const nowPct = now >= dayStart && now <= dayStart + span ? ((now - dayStart) / span) * 100 : null;

  const newDraft = (screenId: string): Draft => {
    // After the screen's last show of the day (plus 20 min to clean), else 10:00.
    const last = byScreen.get(screenId)?.at(-1);
    const start = last ? zonedParts(new Date(new Date(last.endsAt).getTime() + 20 * 60_000).toISOString(), tz).time : "10:00";
    return { screenId, title: last?.title ?? "", date, start, interval: "", end: "", cutoff: "15" };
  };
  const editDraft = (s: ShowTime): Draft => ({
    id: s.id,
    screenId: s.screenId,
    title: s.title,
    date: zonedParts(s.startsAt, tz).date,
    start: zonedParts(s.startsAt, tz).time,
    interval: s.intervalAt ? zonedParts(s.intervalAt, tz).time : "",
    end: zonedParts(s.endsAt, tz).time,
    cutoff: String(s.orderCutoffMin),
  });

  const loading = (screens.loading && !screens.data) || (shows.loading && !shows.data);
  const error = screens.error ?? shows.error;

  return (
    <PageContainer>
      <PageHeader
        title="Showtimes"
        subtitle="Shows decide when seat ordering is open, when interval orders go to the kitchen, and when ordering closes."
        actions={
          <Button icon={<Plus size={20} />} disabled={!list.length} onClick={() => list[0] && setDraft(newDraft(list[0].id))}>
            Add show
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <IconButton label="Previous day" onClick={() => setDate(addDaysISO(date, -1))}>
          <CaretLeft size={20} />
        </IconButton>
        <Input aria-label="Day" type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="min-h-[44px]" />
        <IconButton label="Next day" onClick={() => setDate(addDaysISO(date, 1))}>
          <CaretRight size={20} />
        </IconButton>
        {date !== todayISO(tz) && (
          <Button variant="ghost" size="sm" onClick={() => setDate(todayISO(tz))}>
            Today
          </Button>
        )}
        <span className="text-sm font-semibold text-muted">{new Date(`${date}T12:00:00`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "long" })}</span>
      </div>

      {loading ? (
        <LoadingState label="Loading shows…" />
      ) : error && !screens.data ? (
        <ErrorState message={error} onRetry={() => void Promise.all([screens.reload(), shows.reload()])} />
      ) : !list.length ? (
        <Card>
          <EmptyState title="No screens yet" description="Add a screen and its seats first." action={<Link href="/theatre" className="font-semibold text-primary">Screens &amp; seats</Link>} />
        </Card>
      ) : (
        <div className="space-y-4">
          <Card className="overflow-x-auto p-4" data-testid="showtimes-timeline">
            <div className="min-w-[760px]">
              <div className="relative ml-28 h-6 text-[11px] font-semibold text-muted">
                {Array.from({ length: DAY_HOURS / 2 + 1 }, (_, i) => DAY_START_H + i * 2).map((h) => (
                  <span key={h} className="absolute -translate-x-1/2" style={{ left: `${((h - DAY_START_H) / DAY_HOURS) * 100}%` }}>
                    {String(h % 24).padStart(2, "0")}:00
                  </span>
                ))}
              </div>
              {list.map((sc) => (
                <div key={sc.id} className="flex items-center gap-2 border-t border-line py-2">
                  <span className="w-[104px] shrink-0 truncate text-sm font-bold">
                    {sc.name} <span className="text-xs text-muted">{sc.code}</span>
                  </span>
                  <div className="relative h-14 flex-1 rounded-xl bg-surface-2">
                    {nowPct !== null && <span className="absolute inset-y-0 z-10 w-0.5 bg-red-500" style={{ left: `${nowPct}%` }} title="Now" aria-hidden />}
                    {(byScreen.get(sc.id) ?? []).map((s) => (
                      <button
                        key={s.id}
                        type="button"
                        onClick={() => setDraft(editDraft(s))}
                        className={clsx(
                          "absolute inset-y-1 overflow-hidden rounded-lg border px-2 text-left text-xs",
                          s.status === "ENDED" ? "border-line bg-surface text-muted" : "border-primary/40 bg-primary-50 text-fg hover:border-primary dark:bg-primary/15",
                        )}
                        style={{ left: `${pct(s.startsAt)}%`, width: `${Math.max(1.5, pct(s.endsAt) - pct(s.startsAt))}%` }}
                        title={`${s.title} · ${clock(s.startsAt, tz)}–${clock(s.endsAt, tz)}`}
                      >
                        <span className="block truncate font-bold">{s.title}</span>
                        <span className="block truncate text-muted">
                          {clock(s.startsAt, tz)}–{clock(s.endsAt, tz)}
                        </span>
                        {s.intervalAt && (
                          <span
                            className="absolute inset-y-0 w-1 bg-amber-500/80"
                            style={{ left: `${((new Date(s.intervalAt).getTime() - new Date(s.startsAt).getTime()) / (new Date(s.endsAt).getTime() - new Date(s.startsAt).getTime())) * 100}%` }}
                            aria-hidden
                          />
                        )}
                      </button>
                    ))}
                  </div>
                  <IconButton label={`Add show on ${sc.name}`} onClick={() => setDraft(newDraft(sc.id))}>
                    <Plus size={20} />
                  </IconButton>
                </div>
              ))}
              <p className="mt-2 flex items-center gap-3 text-xs text-muted">
                <span className="inline-flex items-center gap-1">
                  <span className="h-3 w-1 bg-amber-500" /> Interval
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="h-3 w-0.5 bg-red-500" /> Now
                </span>
                Tap a show to edit it.
              </p>
            </div>
          </Card>

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {list.map((sc) => {
              const day = byScreen.get(sc.id) ?? [];
              return (
                <Card key={sc.id} className="min-w-0">
                  <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
                    <h2 className="font-bold">
                      {sc.name} <span className="text-sm font-semibold text-muted">· {day.length} show{day.length === 1 ? "" : "s"}</span>
                    </h2>
                    <Button size="sm" variant="outline" icon={<Plus size={16} />} onClick={() => setDraft(newDraft(sc.id))}>
                      Add
                    </Button>
                  </div>
                  {day.length === 0 ? (
                    <p className="px-4 py-8 text-center text-sm text-muted">No shows on this day</p>
                  ) : (
                    <ul className="divide-y divide-line">
                      {day.map((s) => (
                        <li key={s.id} className="flex items-start gap-3 px-4 py-3">
                          <div className="min-w-0 flex-1">
                            <p className="flex flex-wrap items-center gap-2 font-bold">
                              <span className="truncate">{s.title}</span>
                              <Badge tone={STATUS_TONE[s.status]}>{STATUS_LABEL[s.status]}</Badge>
                            </p>
                            <p className="tabular text-sm text-fg">
                              {clock(s.startsAt, tz)} – {clock(s.endsAt, tz)}
                            </p>
                            <p className="flex flex-wrap gap-x-3 text-xs text-muted">
                              <span>{s.intervalAt ? `Interval ${clock(s.intervalAt, tz)}` : "No interval"}</span>
                              <span className="inline-flex items-center gap-1">
                                <Clock size={12} /> Orders close {clock(s.closesAt, tz)}
                              </span>
                            </p>
                          </div>
                          <IconButton label={`Edit ${s.title}`} onClick={() => setDraft(editDraft(s))}>
                            <PencilSimple size={18} />
                          </IconButton>
                          <IconButton label={`Delete ${s.title}`} onClick={() => setDeleting(s)}>
                            <Trash size={18} />
                          </IconButton>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>
              );
            })}
          </div>
        </div>
      )}

      <ShowDialog
        draft={draft}
        screens={list}
        shows={shows.data ?? []}
        tz={tz}
        onClose={() => setDraft(null)}
        onSaved={(s, created) => {
          setDraft(null);
          toast(created ? `${s.title} added` : `${s.title} updated`, "success");
          const d = zonedParts(s.startsAt, tz).date;
          if (d !== date) setDate(d);
          else void shows.reload();
          void screens.reload();
        }}
        onDelete={(id) => {
          const s = shows.data?.find((x) => x.id === id);
          if (s) {
            setDraft(null);
            setDeleting(s);
          }
        }}
      />
      <ConfirmDialog
        open={!!deleting}
        title={`Delete ${deleting?.title ?? "this show"}?`}
        description={deleting ? `${clock(deleting.startsAt, tz)}–${clock(deleting.endsAt, tz)}. Orders already placed for it stay on the runner board.` : undefined}
        confirmLabel="Delete show"
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          try {
            await theatreApi.deleteShow(deleting!.id);
            shows.setData((l) => l?.filter((x) => x.id !== deleting!.id));
            toast("Show deleted", "success");
          } catch (e) {
            throw new Error(errorMessage(e));
          }
        }}
      />
    </PageContainer>
  );
}

/** Times later than the start roll over to the next day (a 22:30 show ends at 01:10). */
function instants(d: Draft, tz: string) {
  const startsAt = zonedIso(d.date, d.start, tz);
  const after = (t: string) => {
    const iso = zonedIso(d.date, t, tz);
    return new Date(iso).getTime() <= new Date(startsAt).getTime() ? zonedIso(addDaysISO(d.date, 1), t, tz) : iso;
  };
  return { startsAt, intervalAt: d.interval ? after(d.interval) : null, endsAt: d.end ? after(d.end) : "" };
}

function ShowDialog({
  draft,
  screens,
  shows,
  tz,
  onClose,
  onSaved,
  onDelete,
}: {
  draft: Draft | null;
  screens: Screen[];
  /** Shows of the day on screen, to spot an overlap before saving */
  shows: ShowTime[];
  tz: string;
  onClose: () => void;
  onSaved: (s: ShowTime, created: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const [d, setD] = useState<Draft | null>(draft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    setD(draft);
    setError(null);
    setTouched(false);
  }, [draft]);
  if (!d) return null;
  const set = (patch: Partial<Draft>) => setD({ ...d, ...patch });

  const times = d.start && d.end ? instants(d, tz) : null;
  const body = times ? { screenId: d.screenId, title: d.title, startsAt: times.startsAt, intervalAt: times.intervalAt, endsAt: times.endsAt, orderCutoffMin: Number(d.cutoff || 0) } : null;
  const parsed = body ? showTimeSchema.safeParse(body) : null;
  const clash =
    times && times.endsAt
      ? shows.find((x) => x.screenId === d.screenId && x.id !== d.id && new Date(x.startsAt) < new Date(times.endsAt) && new Date(x.endsAt) > new Date(times.startsAt))
      : undefined;
  const clashText = (x: ShowTime) => `This overlaps “${x.title}” (${clock(x.startsAt, tz)}–${clock(x.endsAt, tz)}) on ${screens.find((sc) => sc.id === x.screenId)?.name ?? "this screen"}. Pick another time or screen.`;
  const problem = !d.title.trim()
    ? "Enter the movie / show name"
    : !d.start || !d.end
      ? "Enter the start and end times"
      : parsed && !parsed.success
        ? parsed.error.issues[0]?.message
        : clash
          ? clashText(clash)
          : null;
  const durationMin = times ? Math.round((new Date(times.endsAt).getTime() - new Date(times.startsAt).getTime()) / 60_000) : null;

  const save = async () => {
    setTouched(true);
    if (problem || !parsed?.success) return;
    setBusy(true);
    setError(null);
    try {
      const { screenId, ...rest } = parsed.data;
      const s = d.id ? await theatreApi.updateShow(d.id, rest) : await theatreApi.createShow({ screenId, ...rest });
      onSaved(s, !d.id);
    } catch (e) {
      // The API names the other show with UTC timestamps: keep the title, drop the raw times.
      setError(e instanceof ApiError && e.status === 409 ? `${e.message.replace(/\s*\([^)]*\d{4}-\d{2}-\d{2}T[^)]*\)/, "")}. Pick another time or screen.`.replace("..", ".") : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={d.id ? "Edit show" : "Add show"}
      footer={
        <>
          {d.id && (
            <Button variant="ghost" className="mr-auto text-red-600" icon={<Trash size={18} />} onClick={() => onDelete(d.id!)}>
              Delete
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} onClick={() => void save()}>
            {d.id ? "Save" : "Add show"}
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        data-testid="show-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Select label="Screen" value={d.screenId} disabled={!!d.id} onChange={(e) => set({ screenId: e.target.value })}>
          {screens.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        <Input label="Movie / show" autoFocus={!d.id} maxLength={120} value={d.title} onChange={(e) => set({ title: e.target.value })} placeholder="e.g. Kalki 2898 AD (Telugu)" />
        <Input label="Date" type="date" value={d.date} onChange={(e) => set({ date: e.target.value })} wrapperClassName="max-w-xs" />
        <div className="grid grid-cols-3 gap-3">
          <Input label="Starts" type="time" value={d.start} onChange={(e) => set({ start: e.target.value })} />
          <Input label="Interval" type="time" value={d.interval} onChange={(e) => set({ interval: e.target.value })} hint="Optional" />
          <Input label="Ends" type="time" value={d.end} onChange={(e) => set({ end: e.target.value })} />
        </div>
        <Input
          label="Stop seat orders (minutes before the end)"
          inputMode="numeric"
          maxLength={3}
          value={d.cutoff}
          onChange={(e) => set({ cutoff: e.target.value.replace(/\D/g, "") })}
          wrapperClassName="max-w-xs"
          hint={times?.endsAt ? `Ordering closes at ${clock(new Date(new Date(times.endsAt).getTime() - Number(d.cutoff || 0) * 60_000).toISOString(), tz)}` : "Default 15"}
        />
        {durationMin !== null && durationMin > 0 && !problem && (
          <p className="text-sm text-muted">
            {Math.floor(durationMin / 60)} h {durationMin % 60} min{times && zonedParts(times.endsAt, tz).date !== d.date ? " · ends after midnight" : ""}
            {times?.intervalAt ? ` · interval at ${clock(times.intervalAt, tz)}` : ""}
          </p>
        )}
        {(touched || clash) && problem && <Alert tone="warning">{problem}</Alert>}
        {error && <Alert>{error}</Alert>}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
