"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { Armchair, CaretLeft, CaretRight, CalendarPlus, PencilSimple, UserMinus, XCircle } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { addDaysISO, todayISO } from "@/lib/dates";
import { formatTime } from "@/lib/format";
import type { DiningTable, FloorResponse, PreOrder, Reservation, ReservationStatus, TableSessionDetail } from "@/lib/types-service";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useNow } from "@/hooks/useNow";
import { useSession } from "@/components/providers/SessionProvider";
import { useSocketEvent } from "@/components/providers/SocketProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Dialog } from "@/components/ui/Dialog";
import { Segmented } from "@/components/ui/Segmented";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Table, THead, Th, Td, Tr } from "@/components/ui/Table";
import { Alert, EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { ReservationDialog } from "@/components/reservations/ReservationDialog";

type Tab = "timeline" | "list" | "preorders";

const STATUS_TONE: Record<ReservationStatus, "info" | "success" | "neutral" | "danger" | "warning"> = {
  BOOKED: "info",
  SEATED: "success",
  COMPLETED: "neutral",
  CANCELLED: "danger",
  NO_SHOW: "warning",
};

const dayLabel = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" });

export default function ReservationsPage() {
  const { outletId, outlet, can } = useSession();
  const toast = useToast();
  const router = useRouter();
  const today = todayISO(outlet?.timezone);
  const [date, setDate] = useState(today);
  const [tab, setTab] = useState<Tab>("timeline");
  const [editing, setEditing] = useState<Reservation | null | undefined>(null);
  const [ending, setEnding] = useState<{ r: Reservation; kind: "cancel" | "no-show" } | null>(null);
  const [seating, setSeating] = useState<Reservation | null>(null);

  const list = useApiQuery<Reservation[]>(outletId ? `res:${outletId}:${date}` : null, () => api.get<Reservation[]>("/reservations", { query: { date } }));
  const preOrders = useApiQuery<PreOrder[]>(outletId && tab === "preorders" ? `pre:${outletId}:${date}` : null, () => api.get<PreOrder[]>("/reservations/pre-orders", { query: { date } }));
  const tables = useApiQuery<DiningTable[]>(outletId ? `tables:${outletId}` : null, () => api.get<DiningTable[]>("/tables"));

  useSocketEvent("reservation:updated", () => void list.reload());
  // Events sent while the socket was down are not replayed: reload on (re)connect (QA Phase 9).
  useSocketEvent("connect", () => void list.reload());

  const rows = useMemo(() => [...(list.data ?? [])].sort((a, b) => a.reservedFor.localeCompare(b.reservedFor)), [list.data]);
  const booked = rows.filter((r) => r.status === "BOOKED");
  const covers = booked.reduce((s, r) => s + r.partySize, 0);

  const upsert = (r: Reservation) => list.setData((l) => (l ? (l.some((x) => x.id === r.id) ? l.map((x) => (x.id === r.id ? r : x)) : [...l, r]) : [r]));

  const seat = async (r: Reservation, tableId?: string) => {
    try {
      const res = await api.post<{ reservation: Reservation; session: TableSessionDetail }>(`/reservations/${r.id}/seat`, tableId ? { tableId } : {});
      upsert(res.reservation);
      toast(`${r.customerName} seated${res.reservation.table ? ` at ${res.reservation.table.label}` : ""}`, "success");
      router.push(`/tables?session=${res.session.id}`);
    } catch (e) {
      toast(errorMessage(e), "error");
      throw e;
    }
  };

  const actions = (r: Reservation) =>
    r.status === "BOOKED" ? (
      <div className="flex flex-wrap justify-end gap-1">
        {can("table:serve") && (
          <Button size="sm" variant="secondary" icon={<Armchair size={16} />} onClick={() => (r.tableId ? void seat(r).catch(() => undefined) : setSeating(r))}>
            Seat
          </Button>
        )}
        <IconButton label={`Edit reservation of ${r.customerName}`} onClick={() => setEditing(r)}>
          <PencilSimple size={18} />
        </IconButton>
        <IconButton label={`No-show ${r.customerName}`} onClick={() => setEnding({ r, kind: "no-show" })}>
          <UserMinus size={18} />
        </IconButton>
        <IconButton label={`Cancel reservation of ${r.customerName}`} className="text-red-600" onClick={() => setEnding({ r, kind: "cancel" })}>
          <XCircle size={18} />
        </IconButton>
      </div>
    ) : r.status === "SEATED" && r.sessionId ? (
      <Button size="sm" variant="ghost" onClick={() => router.push(`/tables?session=${r.sessionId}`)}>
        Open tab
      </Button>
    ) : null;

  return (
    <PageContainer>
      <PageHeader
        title="Reservations"
        subtitle={list.data ? `${booked.length} upcoming · ${covers} covers on ${dayLabel(date)}` : undefined}
        actions={
          <Button icon={<CalendarPlus size={20} />} onClick={() => setEditing(undefined)}>
            New reservation
          </Button>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <IconButton label="Previous day" className="border border-line" onClick={() => setDate((d) => addDaysISO(d, -1))}>
          <CaretLeft size={20} />
        </IconButton>
        <input type="date" aria-label="Date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} className="min-h-tap rounded-xl border border-line bg-surface px-3 font-semibold" />
        <IconButton label="Next day" className="border border-line" onClick={() => setDate((d) => addDaysISO(d, 1))}>
          <CaretRight size={20} />
        </IconButton>
        {date !== today && (
          <Button variant="ghost" size="sm" onClick={() => setDate(today)}>
            Today
          </Button>
        )}
        <Segmented
          className="ml-auto"
          value={tab}
          onChange={setTab}
          options={[
            { value: "timeline", label: "Timeline" },
            { value: "list", label: "List" },
            { value: "preorders", label: "Pre-orders" },
          ]}
        />
      </div>

      {tab === "preorders" ? (
        <PreOrdersTable state={preOrders} />
      ) : list.loading && !list.data ? (
        <LoadingState />
      ) : list.error ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState title={`No reservations on ${dayLabel(date)}`} action={<Button onClick={() => setEditing(undefined)}>Book a table</Button>} />
        </Card>
      ) : tab === "timeline" ? (
        <Timeline rows={rows} tables={tables.data ?? []} isToday={date === today} onPick={(r) => (r.status === "BOOKED" ? setEditing(r) : undefined)} />
      ) : (
        <Card>
          <Table>
            <THead>
              <tr>
                <Th>Time</Th>
                <Th>Guest</Th>
                <Th className="text-right">Party</Th>
                <Th>Table</Th>
                <Th>Pre-order</Th>
                <Th className="text-right">Advance</Th>
                <Th>Status</Th>
                <Th />
              </tr>
            </THead>
            <tbody>
              {rows.map((r) => (
                <Tr key={r.id}>
                  <Td className="tabular whitespace-nowrap font-semibold">
                    {formatTime(r.reservedFor)}
                    <span className="block text-xs font-normal text-muted">{r.durationMin} min</span>
                  </Td>
                  <Td>
                    <p className="font-semibold">{r.customerName}</p>
                    <p className="text-xs text-muted">{r.customerPhone}</p>
                    {r.notes && <p className="max-w-xs truncate text-xs text-muted">{r.notes}</p>}
                  </Td>
                  <Td className="tabular text-right">{r.partySize}</Td>
                  <Td>{r.table ? `${r.table.label} (${r.table.capacity})` : <span className="text-muted">—</span>}</Td>
                  <Td>{r.preOrderItems.length ? <Badge tone="primary">{r.preOrderItems.reduce((n, i) => n + i.quantity, 0)} dishes</Badge> : <span className="text-muted">—</span>}</Td>
                  <Td className="tabular text-right">{r.advancePaid ? formatINR(r.advancePaid) : "—"}</Td>
                  <Td>
                    <Badge tone={STATUS_TONE[r.status]}>{r.status.replace("_", "-").toLowerCase()}</Badge>
                  </Td>
                  <Td className="text-right">{actions(r)}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}

      {tab === "timeline" && booked.length > 0 && (
        <Card className="mt-4">
          <ul className="divide-y divide-line">
            {booked.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                <span className="tabular w-14 font-bold">{formatTime(r.reservedFor)}</span>
                <span className="min-w-0 flex-1">
                  <strong>{r.customerName}</strong> <span className="text-sm text-muted">· {r.partySize} guests · {r.table ? r.table.label : "no table yet"}</span>
                  {r.advancePaid > 0 && <span className="text-sm text-muted"> · advance {formatINR(r.advancePaid)}</span>}
                </span>
                {actions(r)}
              </li>
            ))}
          </ul>
        </Card>
      )}

      <ReservationDialog
        reservation={editing}
        defaultDate={date}
        tables={tables.data ?? []}
        onClose={() => setEditing(null)}
        onSaved={(r) => {
          setEditing(null);
          upsert(r);
          toast(`Reservation for ${r.customerName} saved`, "success");
        }}
      />
      <ConfirmDialog
        open={!!ending}
        title={ending?.kind === "cancel" ? `Cancel ${ending.r.customerName}'s reservation?` : `Mark ${ending?.r.customerName ?? ""} as no-show?`}
        description={ending?.r.advancePaid ? `An advance of ${formatINR(ending.r.advancePaid)} was taken — settle it per your policy.` : undefined}
        confirmLabel={ending?.kind === "cancel" ? "Cancel reservation" : "Mark no-show"}
        reason={{ label: "Reason (optional)", required: false }}
        onClose={() => setEnding(null)}
        onConfirm={async (reason) => {
          if (!ending) return;
          try {
            upsert(await api.post<Reservation>(`/reservations/${ending.r.id}/${ending.kind}`, { reason: reason || undefined }));
          } catch (e) {
            throw new Error(errorMessage(e));
          }
        }}
      />
      <SeatDialog reservation={seating} onClose={() => setSeating(null)} onSeat={(r, tableId) => seat(r, tableId)} />
    </PageContainer>
  );
}

/** Day view: one row per table, blocks for bookings (8:00–24:00). */
function Timeline({ rows, tables, isToday, onPick }: { rows: Reservation[]; tables: DiningTable[]; isToday: boolean; onPick: (r: Reservation) => void }) {
  const now = useNow(60_000);
  const times = rows.map((r) => new Date(r.reservedFor));
  const startH = Math.min(8, ...times.map((t) => t.getHours()));
  const endH = Math.max(23, ...rows.map((r) => Math.ceil((new Date(r.reservedFor).getTime() + r.durationMin * 60_000 - new Date(r.reservedFor).setHours(0, 0, 0, 0)) / 3_600_000)));
  const span = Math.min(24, endH) - startH;
  const pct = (d: Date) => ((d.getHours() + d.getMinutes() / 60 - startH) / span) * 100;
  const usedTables = tables.filter((t) => rows.some((r) => r.tableId === t.id));
  const lanes = [...usedTables.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true })).map((t) => ({ id: t.id as string | null, label: t.label })), ...(rows.some((r) => !r.tableId) ? [{ id: null, label: "No table" }] : [])];
  const nowPct = isToday ? pct(new Date(now)) : -1;

  return (
    <Card className="overflow-x-auto p-4">
      <div className="min-w-[720px]">
        <div className="relative ml-20 h-6 text-xs text-muted">
          {Array.from({ length: span + 1 }, (_, i) => (
            <span key={i} className="absolute -translate-x-1/2" style={{ left: `${(i / span) * 100}%` }}>
              {String((startH + i) % 24).padStart(2, "0")}
            </span>
          ))}
        </div>
        {lanes.map((lane) => (
          <div key={lane.id ?? "none"} className="flex items-center border-t border-line">
            <span className="w-20 shrink-0 py-3 text-sm font-bold">{lane.label}</span>
            <div className="relative h-12 flex-1">
              {Array.from({ length: span }, (_, i) => (
                <span key={i} className="absolute inset-y-0 border-l border-line/60" style={{ left: `${(i / span) * 100}%` }} />
              ))}
              {nowPct >= 0 && nowPct <= 100 && <span className="absolute inset-y-0 z-10 w-0.5 bg-red-500" style={{ left: `${nowPct}%` }} aria-label="Now" />}
              {rows
                .filter((r) => r.tableId === lane.id)
                .map((r) => {
                  const s = new Date(r.reservedFor);
                  const e = new Date(s.getTime() + r.durationMin * 60_000);
                  const left = Math.max(0, pct(s));
                  const width = Math.max(4, Math.min(100, pct(e)) - left);
                  return (
                    <button
                      key={r.id}
                      type="button"
                      onClick={() => onPick(r)}
                      title={`${formatTime(r.reservedFor)} · ${r.customerName} (${r.partySize})`}
                      className={clsx(
                        "absolute inset-y-1 overflow-hidden truncate rounded-lg border px-2 text-left text-xs font-semibold",
                        r.status === "BOOKED" && "border-sky-400 bg-sky-100 text-sky-900 dark:bg-sky-500/20 dark:text-sky-100",
                        r.status === "SEATED" && "border-green-500 bg-green-100 text-green-900 dark:bg-green-500/20 dark:text-green-100",
                        (r.status === "CANCELLED" || r.status === "NO_SHOW") && "border-line bg-surface-2 text-muted line-through",
                        r.status === "COMPLETED" && "border-line bg-surface-2 text-muted",
                      )}
                      style={{ left: `${left}%`, width: `${width}%` }}
                    >
                      {formatTime(r.reservedFor)} {r.customerName} · {r.partySize}
                    </button>
                  );
                })}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function SeatDialog({ reservation, onClose, onSeat }: { reservation: Reservation | null; onClose: () => void; onSeat: (r: Reservation, tableId: string) => Promise<void> }) {
  const floor = useApiQuery<FloorResponse>(reservation ? `seatfloor:${reservation.id}` : null, () => api.get<FloorResponse>("/tables/floor"));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [reservation]);
  const free = (floor.data?.areas ?? []).flatMap((a) => a.tables).filter((t) => !t.session);
  return (
    <Dialog open={!!reservation} onClose={onClose} title={`Seat ${reservation?.customerName ?? ""} (${reservation?.partySize ?? ""})`} description="Choose a free table" size="md">
      {error && (
        <div className="mb-3">
          <Alert>{error}</Alert>
        </div>
      )}
      {floor.loading ? (
        <LoadingState />
      ) : free.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">No free tables.</p>
      ) : (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {free.map((t) => (
            <Button
              key={t.id}
              variant="outline"
              className={clsx("flex-col !py-2", reservation && t.capacity < reservation.partySize && "opacity-60")}
              loading={busy === t.id}
              disabled={!!busy}
              onClick={async () => {
                if (!reservation) return;
                setBusy(t.id);
                setError(null);
                try {
                  await onSeat(reservation, t.id);
                  onClose();
                } catch (e) {
                  setError(errorMessage(e));
                } finally {
                  setBusy(null);
                }
              }}
            >
              <span className="text-lg font-extrabold">{t.label}</span>
              <span className="text-xs text-muted">{t.capacity} seats</span>
            </Button>
          ))}
        </div>
      )}
    </Dialog>
  );
}

function PreOrdersTable({ state }: { state: { data: PreOrder[] | undefined; loading: boolean; error: string | null; reload: () => Promise<void> } }) {
  if (state.loading && !state.data) return <LoadingState />;
  if (state.error) return <ErrorState message={state.error} onRetry={state.reload} />;
  if (!state.data?.length)
    return (
      <Card>
        <EmptyState title="No pre-orders" description="Takeaway pre-orders are created from the POS with order type Pre-Order." />
      </Card>
    );
  return (
    <Card>
      <Table>
        <THead>
          <tr>
            <Th>For</Th>
            <Th>Bill</Th>
            <Th>Customer</Th>
            <Th>Items</Th>
            <Th>Kitchen</Th>
            <Th className="text-right">Total</Th>
            <Th>Payment</Th>
          </tr>
        </THead>
        <tbody>
          {state.data.map((o) => (
            <Tr key={o.id}>
              <Td className="tabular whitespace-nowrap font-bold">{formatTime(o.scheduledFor)}</Td>
              <Td className="whitespace-nowrap">{o.invoiceNumber}</Td>
              <Td>
                {o.customerName ?? "—"}
                {o.customerPhone && <span className="block text-xs text-muted">{o.customerPhone}</span>}
              </Td>
              <Td className="max-w-xs text-sm">{o.items.map((i) => `${i.quantity}× ${i.name}`).join(", ")}</Td>
              <Td>
                {o.kitchenReleased ? (
                  <Badge tone="success">Sent {o.kots.map((k) => k.status.toLowerCase()).filter((v, i, a) => a.indexOf(v) === i).join("/")}</Badge>
                ) : (
                  <Badge tone="info">Held until {o.releaseAt ? formatTime(o.releaseAt) : "—"}</Badge>
                )}
              </Td>
              <Td className="tabular text-right font-semibold">{formatINR(o.grandTotal)}</Td>
              <Td>
                {o.status === "PAID" ? (
                  <Badge tone="success">Paid</Badge>
                ) : o.amountPaid > 0 ? (
                  <Badge tone="warning">Part {formatINR(o.amountPaid)}</Badge>
                ) : (
                  <Badge tone="warning">Unpaid</Badge>
                )}
              </Td>
            </Tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}
