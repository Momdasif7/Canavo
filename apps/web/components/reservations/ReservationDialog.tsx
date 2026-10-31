"use client";

import { useEffect, useMemo, useState } from "react";
import { ForkKnife, Trash } from "@phosphor-icons/react";
import { formatINR, indianPhone, type ReservationCreateInput } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { parseRupees, rupeesInput } from "@/lib/format";
import type { Menu } from "@/lib/types";
import type { DiningTable, PreOrderLine, Reservation } from "@/lib/types-service";
import { Dialog } from "@/components/ui/Dialog";
import { Button, IconButton } from "@/components/ui/Button";
import { Input, Select, Textarea } from "@/components/ui/Input";
import { Alert } from "@/components/ui/States";
import { MenuPickerDialog, useMenu, type PickedLine } from "@/components/pos/MenuPickerDialog";
import { makeLine } from "@/components/pos/cart";

const pad = (n: number) => String(n).padStart(2, "0");
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const localTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Rebuild picker lines (with names/prices) from stored pre-order items. */
export function linesFromPreOrder(items: PreOrderLine[], menu: Menu | null): PickedLine[] {
  if (!menu) return [];
  return items.flatMap((i, idx) => {
    const item = menu.items.find((m) => m.id === i.menuItemId);
    if (!item) return [];
    const l = makeLine(item, i.variantId ?? undefined, i.addonIds ?? []);
    return [{ ...l, key: `${l.key}#${idx}`, quantity: i.quantity, notes: i.notes ?? "" }];
  });
}

export function ReservationDialog({
  reservation,
  defaultDate,
  tables,
  onClose,
  onSaved,
}: {
  /** undefined = new, null = closed */
  reservation: Reservation | null | undefined;
  defaultDate: string;
  tables: DiningTable[];
  onClose: () => void;
  onSaved: (r: Reservation) => void;
}) {
  const open = reservation !== null;
  const { menu } = useMenu();
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [party, setParty] = useState("2");
  const [date, setDate] = useState(defaultDate);
  const [time, setTime] = useState("19:30");
  const [duration, setDuration] = useState("90");
  const [tableId, setTableId] = useState("");
  const [notes, setNotes] = useState("");
  const [advance, setAdvance] = useState("");
  const [lines, setLines] = useState<PickedLine[]>([]);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const r = reservation;
    const at = r ? new Date(r.reservedFor) : null;
    setName(r?.customerName ?? "");
    setPhone(r?.customerPhone ?? "");
    setParty(String(r?.partySize ?? 2));
    setDate(at ? localDate(at) : defaultDate);
    setTime(at ? localTime(at) : "19:30");
    setDuration(String(r?.durationMin ?? 90));
    setTableId(r?.tableId ?? "");
    setNotes(r?.notes ?? "");
    setAdvance(r?.advancePaid ? rupeesInput(r.advancePaid) : "");
    setLines(r ? linesFromPreOrder(r.preOrderItems, menu) : []);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reservation]);

  // Menu may arrive after the dialog opens when editing.
  useEffect(() => {
    if (open && reservation && menu && !lines.length && reservation.preOrderItems.length) setLines(linesFromPreOrder(reservation.preOrderItems, menu));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [menu]);

  const partySize = Math.max(1, Math.floor(Number(party) || 1));
  const sortedTables = useMemo(() => [...tables].sort((a, b) => a.capacity - b.capacity || a.label.localeCompare(b.label, undefined, { numeric: true })), [tables]);
  const preTotal = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);

  const submit = async () => {
    setError(null);
    if (!name.trim()) return setError("Enter the guest's name");
    if (!indianPhone.safeParse(phone).success) return setError("Enter a valid 10-digit mobile number");
    const at = new Date(`${date}T${time}`);
    if (!Number.isFinite(at.getTime())) return setError("Choose a valid date and time");
    const body: ReservationCreateInput = {
      customerName: name.trim(),
      customerPhone: phone,
      partySize,
      reservedFor: at.toISOString(),
      durationMin: Math.max(15, Math.min(600, Math.floor(Number(duration) || 90))),
      tableId: tableId || null,
      notes: notes.trim() || undefined,
      advancePaid: parseRupees(advance) ?? 0,
      preOrderItems: lines.map((l) => ({ menuItemId: l.itemId, variantId: l.variantId, addonIds: l.addonIds, quantity: l.quantity, notes: l.notes.trim() || undefined })),
    };
    setBusy(true);
    try {
      const saved = reservation
        ? await api.patch<Reservation>(`/reservations/${reservation.id}`, { ...body, notes: notes.trim() || null })
        : await api.post<Reservation>("/reservations", body);
      onSaved(saved);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog
        open={open && !picking}
        onClose={onClose}
        size="lg"
        dismissible={!busy}
        title={reservation ? `Edit reservation · ${reservation.customerName}` : "New reservation"}
        footer={
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button onClick={submit} loading={busy}>
              {reservation ? "Save changes" : "Book table"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {error && <Alert>{error}</Alert>}
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Guest name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
            <Input label="Mobile" inputMode="numeric" maxLength={10} value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))} />
            <Input label="Party size" type="number" min={1} max={100} value={party} onChange={(e) => setParty(e.target.value)} />
            <Input label="Duration (min)" type="number" min={15} max={600} step={15} value={duration} onChange={(e) => setDuration(e.target.value)} />
            <Input label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
            <Input label="Time" type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </div>
          <Select label="Table" value={tableId} onChange={(e) => setTableId(e.target.value)} hint="Too-small tables and double bookings are rejected — merge tables when seating large groups.">
            <option value="">Assign when seating</option>
            {sortedTables.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label} · {t.capacity} seats{t.capacity < partySize ? " (too small)" : ""}
              </option>
            ))}
          </Select>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="Advance paid" prefix="₹" inputMode="decimal" value={advance} onChange={(e) => setAdvance(e.target.value.replace(/[^\d.]/g, ""))} hint="Recorded as a payment on the final bill" />
          </div>
          <Textarea label="Notes" value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} placeholder="Occasion, seating preference…" />
          <div className="rounded-xl border border-line p-3">
            <div className="flex items-center gap-2">
              <ForkKnife size={18} className="text-muted" />
              <span className="font-semibold">Pre-order</span>
              {lines.length > 0 && <span className="tabular text-sm text-muted">· {formatINR(preTotal)}</span>}
              <Button size="sm" variant="outline" className="ml-auto" onClick={() => setPicking(true)}>
                {lines.length ? "Edit dishes" : "Add dishes"}
              </Button>
            </div>
            {lines.length > 0 ? (
              <ul className="mt-2 divide-y divide-line text-sm">
                {lines.map((l) => (
                  <li key={l.key} className="flex items-center gap-2 py-1.5">
                    <span className="tabular font-bold text-primary">{l.quantity}×</span>
                    <span className="flex-1 truncate">
                      {l.name}
                      {l.variantName && <span className="text-muted"> ({l.variantName})</span>}
                      {l.notes && <span className="text-muted"> · {l.notes}</span>}
                    </span>
                    <IconButton label={`Remove ${l.name}`} className="min-h-[36px] min-w-[36px] text-red-600" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                      <Trash size={16} />
                    </IconButton>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-sm text-muted">Optional — fired to the kitchen when the party is seated.</p>
            )}
          </div>
        </div>
      </Dialog>
      <MenuPickerDialog
        open={picking}
        title="Pre-order dishes"
        confirmLabel="Use these dishes"
        initial={lines}
        ignoreServingWindow
        onClose={() => setPicking(false)}
        onConfirm={(ls) => {
          setLines(ls);
          setPicking(false);
        }}
      />
    </>
  );
}
