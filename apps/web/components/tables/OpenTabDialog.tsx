"use client";

import { useEffect, useState } from "react";
import { Minus, Plus } from "@phosphor-icons/react";
import { indianPhone } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import type { FloorTable, TableSessionDetail } from "@/lib/types-service";
import { Dialog } from "@/components/ui/Dialog";
import { Button, IconButton } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { Alert } from "@/components/ui/States";
import { useStaffOptions } from "./common";

export function OpenTabDialog({ table, onClose, onOpened }: { table: FloorTable | null; onClose: () => void; onOpened: (s: TableSessionDetail) => void }) {
  const staff = useStaffOptions();
  const [guests, setGuests] = useState(2);
  const [waiterId, setWaiterId] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!table) return;
    setGuests(Math.min(2, table.capacity));
    setWaiterId(table.waiterId ?? "");
    setName(table.upcomingReservation?.customerName ?? "");
    setPhone("");
    setError(null);
  }, [table]);

  if (!table) return null;

  const submit = async () => {
    if (phone && !indianPhone.safeParse(phone).success) {
      setError("Enter a valid 10-digit mobile number");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const s = await api.post<TableSessionDetail>(`/tables/${table.id}/open`, {
        guests,
        waiterId: waiterId || undefined,
        customerName: name.trim() || undefined,
        customerPhone: phone || undefined,
      });
      onOpened(s);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      dismissible={!busy}
      title={`Open tab · Table ${table.label}`}
      description={`Seats ${table.capacity}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy}>
            Open tab
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        {table.upcomingReservation && (
          <Alert tone="info">
            Reserved for {table.upcomingReservation.customerName} (party of {table.upcomingReservation.partySize}) in {table.upcomingReservation.minutesAway} min. Seat
            reservations from the Reservations page to carry over pre-orders and advance.
          </Alert>
        )}
        <div>
          <p className="mb-1.5 text-sm font-semibold">Guests</p>
          <div className="flex items-center gap-2">
            <IconButton label="Fewer guests" className="border border-line" onClick={() => setGuests((g) => Math.max(1, g - 1))}>
              <Minus size={18} />
            </IconButton>
            <span className="tabular w-10 text-center text-2xl font-extrabold" aria-label="Guests" data-testid="guests">
              {guests}
            </span>
            <IconButton label="More guests" className="border border-line" onClick={() => setGuests((g) => Math.min(100, g + 1))}>
              <Plus size={18} />
            </IconButton>
            {guests > table.capacity && <span className="text-xs font-semibold text-amber-700 dark:text-amber-300">More than the table seats</span>}
          </div>
        </div>
        {staff && staff.length > 1 && (
          <Select label="Waiter" value={waiterId} onChange={(e) => setWaiterId(e.target.value)}>
            <option value="">—</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Input label="Customer name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
          <Input label="Phone" inputMode="numeric" maxLength={10} value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))} />
        </div>
      </div>
    </Dialog>
  );
}
