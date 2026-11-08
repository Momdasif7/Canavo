"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { QRCodeSVG } from "qrcode.react";
import { Armchair, ArrowsClockwise, FilmSlate, PencilSimple, Plus, Printer, QrCode, Trash } from "@phosphor-icons/react";
import { seatBulkSchema } from "@canavo/shared";
import { errorMessage } from "@/lib/api";
import { publicPageUrl } from "@/lib/storefront";
import { clock, parseRows, seatPart, theatreApi, type Screen, type Seat } from "@/lib/theatre";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Dialog } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { Alert, EmptyState, ErrorState, LoadingState } from "@/components/ui/States";

/** Cinema → Screens & seats: screens, bulk seat creation, the seat map, seat / screen QR codes. */
export default function TheatreScreensPage() {
  const { outletId, outlet } = useSession();
  const toast = useToast();
  const tz = outlet?.timezone;
  const q = useApiQuery<Screen[]>(outletId ? `theatre-screens:${outletId}` : null, theatreApi.screens);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Screen | "new" | null>(null);
  const [adding, setAdding] = useState(false);
  const [seat, setSeat] = useState<Seat | null>(null);
  const [rotating, setRotating] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const screens = useMemo(() => [...(q.data ?? [])].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)), [q.data]);
  const selected = screens.find((s) => s.id === selectedId) ?? screens[0] ?? null;
  useEffect(() => {
    if (!selectedId && screens[0]) setSelectedId(screens[0].id);
  }, [screens, selectedId]);

  const replace = (s: Screen) => q.setData((list) => (list ? (list.some((x) => x.id === s.id) ? list.map((x) => (x.id === s.id ? s : x)) : [...list, s]) : [s]));

  return (
    <PageContainer>
      <PageHeader
        title="Screens & seats"
        subtitle="Each seat gets its own QR code. Guests scan it, order and pay by UPI; runners bring the food to the seat."
        actions={
          <Button icon={<Plus size={20} />} onClick={() => setEditing("new")}>
            Add screen
          </Button>
        }
      />
      {q.loading && !q.data ? (
        <LoadingState label="Loading screens…" />
      ) : q.error && !q.data ? (
        <ErrorState message={q.error} onRetry={q.reload} />
      ) : !screens.length ? (
        <Card>
          <EmptyState
            title="No screens yet"
            description="Add your first screen (e.g. “Screen 1”), then add its seats in one go: rows A–M, seats 1–20."
            action={
              <Button icon={<Plus size={20} />} onClick={() => setEditing("new")}>
                Add screen
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[300px_minmax(0,1fr)]">
          <nav aria-label="Screens" className="space-y-2">
            {screens.map((s) => {
              const on = s.id === selected?.id;
              const show = s.currentShow ?? s.nextShow;
              return (
                <button
                  key={s.id}
                  type="button"
                  aria-current={on ? "true" : undefined}
                  onClick={() => setSelectedId(s.id)}
                  className={clsx(
                    "flex w-full items-start gap-3 rounded-2xl border p-3 text-left transition-colors",
                    on ? "border-primary bg-primary-50 dark:bg-primary/10" : "border-line bg-surface hover:border-primary/50",
                  )}
                >
                  <span className={clsx("flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-sm font-extrabold", on ? "bg-primary text-primary-fg" : "bg-surface-2 text-fg")}>{s.code}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-bold text-fg">{s.name}</span>
                    <span className="block text-sm text-muted">
                      {s.seatCount} seat{s.seatCount === 1 ? "" : "s"} · {s.rows.length} row{s.rows.length === 1 ? "" : "s"}
                    </span>
                    {show && (
                      <span className="mt-0.5 block truncate text-xs text-muted">
                        {s.currentShow ? "Now: " : "Next: "}
                        {show.title} · {clock(show.startsAt, tz)}
                      </span>
                    )}
                  </span>
                </button>
              );
            })}
            <Link href="/theatre/showtimes" className="flex min-h-tap items-center justify-center gap-2 rounded-2xl border border-dashed border-line text-sm font-semibold text-muted hover:text-fg">
              <FilmSlate size={18} /> Manage showtimes
            </Link>
          </nav>

          {selected && (
            <Card className="min-w-0">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
                <div>
                  <h2 className="flex items-center gap-2 text-xl font-extrabold">
                    {selected.name} <Badge tone="primary">{selected.code}</Badge>
                  </h2>
                  <p className="text-sm text-muted">
                    {selected.seatCount} seats · seat labels look like <strong className="text-fg">{selected.code}-F12</strong>
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" icon={<PencilSimple size={18} />} onClick={() => setEditing(selected)}>
                    Rename
                  </Button>
                  <Button size="sm" variant="danger" icon={<Trash size={18} />} onClick={() => setDeleting(true)}>
                    Delete
                  </Button>
                </div>
              </div>
              <div className="flex flex-wrap gap-2 border-b border-line px-5 py-3">
                <Button icon={<Plus size={20} />} onClick={() => setAdding(true)}>
                  Add seats
                </Button>
                <Link
                  href={`/theatre/print/${selected.id}`}
                  aria-disabled={!selected.seatCount}
                  className={clsx(
                    "inline-flex min-h-tap items-center gap-2 rounded-xl border border-line bg-surface px-4 text-[15px] font-semibold hover:bg-surface-2",
                    !selected.seatCount && "pointer-events-none opacity-50",
                  )}
                >
                  <Printer size={20} /> Print seat QR codes
                </Link>
                <Link href={`/theatre/print/${selected.id}?kind=poster`} className="inline-flex min-h-tap items-center gap-2 rounded-xl border border-line bg-surface px-4 text-[15px] font-semibold hover:bg-surface-2">
                  <QrCode size={20} /> Screen QR poster
                </Link>
                <Button variant="ghost" icon={<ArrowsClockwise size={20} />} onClick={() => setRotating(true)}>
                  New screen QR
                </Button>
              </div>
              <div className="p-5">
                <SeatMap screen={selected} onSeat={setSeat} />
              </div>
            </Card>
          )}
        </div>
      )}

      <ScreenDialog
        screen={editing}
        count={screens.length}
        onClose={() => setEditing(null)}
        onSaved={(s) => {
          replace(s);
          setSelectedId(s.id);
          setEditing(null);
          toast(editing === "new" ? `${s.name} added — now add its seats` : "Screen renamed", "success");
          if (editing === "new") setAdding(true);
        }}
      />
      {selected && (
        <SeatsDialog
          open={adding}
          screen={selected}
          onClose={() => setAdding(false)}
          onDone={(msg) => {
            setAdding(false);
            toast(msg, "success");
            void q.reload();
          }}
        />
      )}
      <SeatDialog
        seat={seat}
        screen={selected}
        onClose={() => setSeat(null)}
        onRemoved={() => {
          setSeat(null);
          void q.reload();
        }}
      />
      <ConfirmDialog
        open={rotating}
        tone="primary"
        title={`New screen QR for ${selected?.name ?? ""}?`}
        description="The printed screen poster stops working. Seat codes are not affected. Print the new poster after this."
        confirmLabel="Make new code"
        onClose={() => setRotating(false)}
        onConfirm={async () => {
          try {
            replace(await theatreApi.rotateScreenQr(selected!.id));
            toast("New screen QR — print the poster again", "success");
          } catch (e) {
            throw new Error(errorMessage(e));
          }
        }}
      />
      <ConfirmDialog
        open={deleting}
        title={`Delete ${selected?.name ?? "this screen"}?`}
        description="Its seats and their QR codes stop working. Screens with a seat order in progress can't be deleted."
        confirmLabel="Delete screen"
        onClose={() => setDeleting(false)}
        onConfirm={async () => {
          try {
            await theatreApi.deleteScreen(selected!.id);
            q.setData((list) => list?.filter((x) => x.id !== selected!.id));
            setSelectedId(null);
            toast("Screen deleted", "success");
          } catch (e) {
            throw new Error(errorMessage(e));
          }
        }}
      />
    </PageContainer>
  );
}

/** Seat grid, screen at the top like a booking app. */
function SeatMap({ screen, onSeat }: { screen: Screen; onSeat: (s: Seat) => void }) {
  if (!screen.rows.length)
    return <EmptyState title="No seats yet" description="Use “Add seats” to create rows of seats in one go. Each seat gets its own QR code." />;
  const maxSeat = Math.max(...screen.rows.flatMap((r) => r.seats.map((s) => s.seatNumber)));
  return (
    <div className="overflow-x-auto" data-testid="seat-map">
      <div className="mx-auto w-fit min-w-full">
        <div className="mx-auto mb-6 max-w-xl">
          <div className="h-2 rounded-t-full bg-gradient-to-b from-primary/60 to-primary/10" />
          <p className="mt-1 text-center text-xs font-bold uppercase tracking-[0.3em] text-muted">Screen this way</p>
        </div>
        <div className="space-y-1.5">
          {screen.rows.map((r) => {
            const byNum = new Map(r.seats.map((s) => [s.seatNumber, s]));
            return (
              <div key={r.row} className="flex items-center gap-1">
                <span className="w-7 shrink-0 text-center text-sm font-extrabold text-muted">{r.row}</span>
                {Array.from({ length: maxSeat }, (_, i) => i + 1).map((n) => {
                  const s = byNum.get(n);
                  return s ? (
                    <button
                      key={n}
                      type="button"
                      onClick={() => onSeat(s)}
                      title={s.label}
                      aria-label={`Seat ${seatPart(s.label)}${s.active ? "" : " (not in use)"}`}
                      className={clsx(
                        "flex h-7 w-7 shrink-0 items-center justify-center rounded-t-lg rounded-b-sm border text-[11px] font-bold tabular-nums transition-colors",
                        s.active ? "border-primary/40 bg-primary-50 text-primary-700 hover:bg-primary hover:text-primary-fg dark:bg-primary/15 dark:text-primary-200" : "border-dashed border-line bg-surface-2 text-muted line-through",
                      )}
                    >
                      {n}
                    </button>
                  ) : (
                    <span key={n} className="h-7 w-7 shrink-0" aria-hidden />
                  );
                })}
                <span className="w-7 shrink-0 text-center text-sm font-extrabold text-muted">{r.row}</span>
              </div>
            );
          })}
        </div>
        <p className="mt-4 flex items-center gap-2 text-xs text-muted">
          <Armchair size={16} /> Tap a seat to see its QR code or remove it. Gaps are skipped seats or gangways.
        </p>
      </div>
    </div>
  );
}

function ScreenDialog({ screen, count, onClose, onSaved }: { screen: Screen | "new" | null; count: number; onClose: () => void; onSaved: (s: Screen) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!screen) return;
    setName(screen === "new" ? `Screen ${count + 1}` : screen.name);
    setError(null);
  }, [screen, count]);
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      onSaved(screen === "new" ? await theatreApi.createScreen({ name: name.trim(), sortOrder: count }) : await theatreApi.updateScreen(screen!.id, { name: name.trim() }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open={!!screen}
      onClose={onClose}
      size="sm"
      title={screen === "new" ? "Add screen" : "Rename screen"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} disabled={!name.trim()} onClick={() => void save()}>
            {screen === "new" ? "Add screen" : "Save"}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) void save();
        }}
        className="space-y-3"
      >
        <Input label="Name" autoFocus maxLength={40} value={name} onChange={(e) => setName(e.target.value)} hint="Shown to guests: “Screen 2 · F12”." />
        {error && <Alert>{error}</Alert>}
      </form>
    </Dialog>
  );
}

/** Bulk-add seats: rows A–M, seats 1–20, minus a skip list. */
function SeatsDialog({ open, screen, onClose, onDone }: { open: boolean; screen: Screen; onClose: () => void; onDone: (msg: string) => void }) {
  const [rows, setRows] = useState("A-M");
  const [from, setFrom] = useState("1");
  const [to, setTo] = useState("20");
  const [skip, setSkip] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const rowList = parseRows(rows);
  const skipList = skip
    .toUpperCase()
    .split(/[,\s]+/)
    .filter(Boolean);
  const parsed = seatBulkSchema.safeParse({ rows: rowList ?? [], from: Number(from), to: Number(to), skip: skipList });
  const problem = !rowList ? "Rows: letters like A-M or A, B, C" : !parsed.success ? parsed.error.issues[0]?.message : null;
  const existing = new Set(screen.rows.flatMap((r) => r.seats.map((s) => seatPart(s.label))));
  let fresh = 0;
  if (parsed.success) {
    for (const r of parsed.data.rows) for (let n = parsed.data.from; n <= parsed.data.to; n++) if (!parsed.data.skip.includes(`${r}${n}`) && !existing.has(`${r}${n}`)) fresh++;
  }

  const save = async () => {
    if (!parsed.success) return;
    setBusy(true);
    setError(null);
    try {
      const r = await theatreApi.addSeats(screen.id, parsed.data);
      onDone(`${r.created} seat${r.created === 1 ? "" : "s"} added${r.skipped ? ` · ${r.skipped} already there or skipped` : ""} · ${r.total} in ${screen.name}`);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Add seats to ${screen.name}`}
      description="Every row gets the same seat numbers. Seats that already exist are kept as they are."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={busy} disabled={!!problem || fresh === 0} onClick={() => void save()}>
            Add {fresh || ""} seat{fresh === 1 ? "" : "s"}
          </Button>
        </>
      }
    >
      <div className="space-y-4" data-testid="seat-bulk-form">
        <Input label="Rows" value={rows} onChange={(e) => setRows(e.target.value)} hint="A-M, or a list: A, B, C, F-H" maxLength={120} />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Seats from" inputMode="numeric" value={from} onChange={(e) => setFrom(e.target.value.replace(/\D/g, ""))} maxLength={3} />
          <Input label="to" inputMode="numeric" value={to} onChange={(e) => setTo(e.target.value.replace(/\D/g, ""))} maxLength={3} />
        </div>
        <Input label="Leave out (optional)" placeholder="e.g. A1, A2, F13" value={skip} onChange={(e) => setSkip(e.target.value)} hint="Gangways, broken seats, wheelchair spaces." />
        {problem ? (
          <Alert tone="warning">{problem}</Alert>
        ) : (
          <p className="rounded-xl bg-surface-2 p-3 text-sm">
            <strong>{fresh}</strong> new seat{fresh === 1 ? "" : "s"}: rows {rowList![0]}
            {rowList!.length > 1 ? `–${rowList![rowList!.length - 1]}` : ""} × seats {from}–{to}
            {skipList.length ? `, without ${skipList.length} left out` : ""}. Labels look like{" "}
            <strong>
              {screen.code}-{rowList![0]}
              {from}
            </strong>
            .
          </p>
        )}
        {error && <Alert>{error}</Alert>}
      </div>
    </Dialog>
  );
}

function SeatDialog({ seat, screen, onClose, onRemoved }: { seat: Seat | null; screen: Screen | null; onClose: () => void; onRemoved: () => void }) {
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  if (!seat || !screen) return null;
  const url = publicPageUrl(`/t/${seat.qrToken}?c=1`);
  return (
    <>
      <Dialog
        open
        size="sm"
        onClose={onClose}
        title={`Seat ${seatPart(seat.label)} · ${screen.name}`}
        description={seat.active ? `Label ${seat.label}` : "Not in use (it has order history, so it was switched off instead of deleted)."}
        footer={
          <>
            <a href={url} target="_blank" rel="noreferrer" className="mr-auto inline-flex min-h-[40px] items-center px-2 text-sm font-semibold text-primary hover:underline">
              Open guest page
            </a>
            {seat.active && (
              <Button variant="danger" size="sm" icon={<Trash size={18} />} onClick={() => setConfirm(true)}>
                Remove seat
              </Button>
            )}
          </>
        }
      >
        <div className="flex flex-col items-center gap-2 rounded-2xl bg-white p-4 text-black">
          <QRCodeSVG value={url} size={180} level="M" marginSize={1} />
          <p className="text-4xl font-black tracking-tight">{seatPart(seat.label)}</p>
          <p className="text-sm text-neutral-600">{screen.name} · scan to order food to your seat</p>
        </div>
      </Dialog>
      <ConfirmDialog
        open={confirm}
        title={`Remove seat ${seatPart(seat.label)}?`}
        description="Its QR code stops working. A seat with order history is switched off instead."
        confirmLabel="Remove seat"
        onClose={() => setConfirm(false)}
        onConfirm={async () => {
          try {
            await theatreApi.deleteSeat(seat.id);
            toast(`Seat ${seatPart(seat.label)} removed`, "success");
            onRemoved();
          } catch (e) {
            throw new Error(errorMessage(e));
          }
        }}
      />
    </>
  );
}
