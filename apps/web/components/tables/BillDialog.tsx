"use client";

import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Plus } from "@phosphor-icons/react";
import { equalSplitPreview } from "./split";
import { formatINR, indianPhone, type BillSplitMode, type SessionBillInput } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { useApproval } from "@/components/providers/ApprovalProvider";
import type { SessionBillResult, TableSessionDetail } from "@/lib/types-service";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { Alert } from "@/components/ui/States";

const MODES: { value: BillSplitMode; label: string }[] = [
  { value: "FULL", label: "Full" },
  { value: "BY_SEAT", label: "By seat" },
  { value: "BY_ITEMS", label: "By items" },
  { value: "EQUAL", label: "Equal" },
];

/**
 * Raise bill(s) for the unbilled items of a running tab.
 * Returns the created orders (one per seat/group) to collect payment for.
 */
export function BillDialog({
  session,
  open,
  onClose,
  onBilled,
}: {
  session: TableSessionDetail;
  open: boolean;
  onClose: () => void;
  onBilled: (r: SessionBillResult, parts?: number) => void;
}) {
  const withApproval = useApproval();
  const unbilled = useMemo(() => session.items.filter((i) => !i.billedOrderId), [session.items]);
  const seats = useMemo(() => [...new Set(unbilled.map((i) => i.seat).filter((s): s is number => s !== null))].sort((a, b) => a - b), [unbilled]);
  const hasShared = unbilled.some((i) => i.seat === null);

  const [mode, setMode] = useState<BillSplitMode>("FULL");
  const [seatSel, setSeatSel] = useState<number[]>([]);
  /** BY_ITEMS: item id → bill number (0 = not now) */
  const [assign, setAssign] = useState<Record<string, number>>({});
  const [bills, setBills] = useState(2);
  const [parts, setParts] = useState(2);
  const [discountType, setDiscountType] = useState<"FLAT" | "PERCENT">("FLAT");
  const [discount, setDiscount] = useState("");
  const [coupon, setCoupon] = useState("");
  const [points, setPoints] = useState("");
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMode("FULL");
    setSeatSel(seats);
    setAssign(Object.fromEntries(unbilled.map((i) => [i.id, 1])));
    setBills(2);
    setParts(Math.max(2, Math.min(50, session.guests)));
    setDiscount("");
    setCoupon("");
    setPoints("");
    setPhone(session.customerPhone ?? "");
    setName(session.customerName ?? "");
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const groups = useMemo(() => {
    const out: string[][] = Array.from({ length: bills }, () => []);
    for (const i of unbilled) {
      const n = assign[i.id] ?? 0;
      if (n > 0 && n <= bills) out[n - 1].push(i.id);
    }
    return out.filter((g) => g.length);
  }, [assign, bills, unbilled]);

  const billCount = mode === "BY_SEAT" ? (seatSel.length === seats.length ? seats.length + (hasShared ? 1 : 0) : seatSel.length) : mode === "BY_ITEMS" ? groups.length : 1;
  const multi = billCount > 1;
  const est = session.unbilledEstimate.grandTotal;

  const submit = async () => {
    setError(null);
    if (phone && !indianPhone.safeParse(phone).success) return setError("Enter a valid 10-digit mobile number");
    if (mode === "BY_SEAT" && !seatSel.length) return setError("Select at least one seat");
    if (mode === "BY_ITEMS" && !groups.length) return setError("Assign items to at least one bill");
    const n = Number(discount);
    const body: SessionBillInput = {
      mode,
      interState: false,
      seats: mode === "BY_SEAT" && seatSel.length !== seats.length ? seatSel : undefined,
      groups: mode === "BY_ITEMS" ? groups : undefined,
      parts: mode === "EQUAL" ? parts : undefined,
      discount: discount.trim() && n > 0 ? (discountType === "FLAT" ? { type: "FLAT", value: Math.round(n * 100) } : { type: "PERCENT", value: Math.min(100, n) }) : undefined,
      couponCode: !multi && coupon.trim() ? coupon.trim().toUpperCase() : undefined,
      redeemPoints: !multi && Number(points) > 0 ? Math.floor(Number(points)) : undefined,
      customerPhone: phone || undefined,
      customerName: name.trim() || undefined,
    };
    setBusy(true);
    try {
      const res = await withApproval((approval) => api.post<SessionBillResult>(`/tables/sessions/${session.id}/bill`, { ...body, approval }));
      onBilled(res, mode === "EQUAL" ? parts : undefined);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      dismissible={!busy}
      title={`Bill · Table ${session.label}`}
      description={`${unbilled.length} unbilled item${unbilled.length === 1 ? "" : "s"} · est. ${formatINR(est)}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="lg" onClick={submit} loading={busy} disabled={!unbilled.length}>
            {billCount > 1 ? `Create ${billCount} bills` : "Create bill"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Segmented className="w-full" value={mode} onChange={setMode} options={MODES} />

        {mode === "FULL" && <p className="text-sm text-muted">One bill for everything on the table.</p>}

        {mode === "BY_SEAT" &&
          (seats.length === 0 ? (
            <Alert tone="warning">No items were tagged with a seat. Add items with a seat number, or bill by items instead.</Alert>
          ) : (
            <div>
              <p className="mb-2 text-sm text-muted">One bill per selected seat{hasShared ? "; untagged items form a “Shared” bill when all seats are selected" : ""}.</p>
              <div className="flex flex-wrap gap-2">
                {seats.map((s) => {
                  const on = seatSel.includes(s);
                  const amt = unbilled.filter((i) => i.seat === s).reduce((a, i) => a + i.amount, 0);
                  return (
                    <label key={s} className={clsx("flex min-h-tap cursor-pointer items-center gap-2 rounded-xl border px-3", on ? "border-primary bg-primary-50 dark:bg-primary/15" : "border-line")}>
                      <input type="checkbox" checked={on} onChange={() => setSeatSel((x) => (on ? x.filter((y) => y !== s) : [...x, s].sort((a, b) => a - b)))} className="h-5 w-5 accent-primary" />
                      <span className="font-semibold">Seat {s}</span>
                      <span className="tabular text-xs text-muted">{formatINR(amt)}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}

        {mode === "BY_ITEMS" && (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-sm text-muted">Pick which bill each item goes on (“—” leaves it on the tab).</p>
              <Button size="sm" variant="outline" icon={<Plus size={16} />} onClick={() => setBills((b) => Math.min(10, b + 1))}>
                Add bill
              </Button>
            </div>
            <ul className="divide-y divide-line rounded-xl border border-line">
              {unbilled.map((i) => (
                <li key={i.id} className="flex items-center gap-2 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-sm">
                    <strong className="tabular">{i.quantity}×</strong> {i.name}
                    {i.seat && <span className="text-xs text-muted"> · Seat {i.seat}</span>}
                  </span>
                  <span className="tabular text-sm font-semibold">{formatINR(i.amount)}</span>
                  <div className="flex gap-1" role="radiogroup" aria-label={`Bill for ${i.name}`}>
                    {Array.from({ length: bills + 1 }, (_, n) => n).map((n) => (
                      <button
                        key={n}
                        type="button"
                        role="radio"
                        aria-checked={(assign[i.id] ?? 0) === n}
                        onClick={() => setAssign((a) => ({ ...a, [i.id]: n }))}
                        className={clsx(
                          "h-9 min-w-9 rounded-lg border px-2 text-xs font-bold",
                          (assign[i.id] ?? 0) === n ? "border-secondary bg-secondary text-white" : "border-line hover:border-secondary/60",
                        )}
                      >
                        {n === 0 ? "—" : n}
                      </button>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted">
              {groups.map((g, idx) => `Bill ${idx + 1}: ${formatINR(unbilled.filter((i) => g.includes(i.id)).reduce((a, i) => a + i.amount, 0))}`).join(" · ")}
            </p>
          </div>
        )}

        {mode === "EQUAL" && (
          <div className="flex flex-wrap items-end gap-3">
            <Input
              label="Split between"
              type="number"
              min={2}
              max={50}
              value={parts}
              onChange={(e) => setParts(Math.max(2, Math.min(50, Math.floor(Number(e.target.value) || 2))))}
              wrapperClassName="w-32"
            />
            <p className="pb-3 text-sm text-muted">
              ≈ <strong className="tabular text-fg">{equalSplitPreview(est, parts).map((a) => formatINR(a)).filter((v, i, arr) => arr.indexOf(v) === i).join(" / ")}</strong> each (exact
              amounts after promotions)
            </p>
          </div>
        )}

        <fieldset className="grid gap-3 border-t border-line pt-4 sm:grid-cols-2">
          <div className="flex items-end gap-2">
            <Input
              label="Discount"
              inputMode="decimal"
              value={discount}
              onChange={(e) => setDiscount(e.target.value.replace(/[^\d.]/g, ""))}
              wrapperClassName="flex-1"
              disabled={multi && discountType === "FLAT"}
            />
            <Segmented
              size="sm"
              value={discountType}
              onChange={setDiscountType}
              options={[
                { value: "FLAT", label: "₹" },
                { value: "PERCENT", label: "%" },
              ]}
            />
          </div>
          <Input label="Coupon" value={coupon} onChange={(e) => setCoupon(e.target.value.toUpperCase())} disabled={multi} className="font-mono uppercase" />
          <Input label="Customer phone" inputMode="numeric" maxLength={10} value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))} />
          <Input label="Customer name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
          <Input label="Redeem points" inputMode="numeric" value={points} onChange={(e) => setPoints(e.target.value.replace(/\D/g, ""))} disabled={multi || !phone} hint={!phone ? "Needs the customer's phone" : undefined} />
          {multi && <p className="self-center text-xs text-muted">Flat discounts, coupons and points apply to a single bill — bill groups one at a time to use them.</p>}
        </fieldset>
      </div>
    </Dialog>
  );
}
