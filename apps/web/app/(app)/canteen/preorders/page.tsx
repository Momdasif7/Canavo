"use client";

import { useState } from "react";
import { Plus, Trash } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { ApiError, api, errorMessage } from "@/lib/api";
import { formatDateTime, formatTime } from "@/lib/format";
import type { Menu } from "@/lib/types";
import { PAY_MODES, tomorrowISO, type CanteenPreorder, type PreordersResponse } from "@/lib/types-meals";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Dialog } from "@/components/ui/Dialog";
import { Input, Select } from "@/components/ui/Input";
import { Alert, EmptyState, ErrorState, LoadingState } from "@/components/ui/States";

type Line = { menuItemId: string; quantity: number };

/** Canteen → Pre-orders: book meals for a day + slot before the cutoff, see them by slot, hand over or cancel. */
export default function PreordersPage() {
  const toast = useToast();
  const { can } = useSession();
  const [date, setDate] = useState(tomorrowISO());
  const q = useApiQuery(`canteen-preorders-${date}`, () => api.get<PreordersResponse>("/canteen/preorders", { query: { date } }));
  const menu = useApiQuery("menu-all", () => api.get<Menu>("/menu"));

  const [slotId, setSlotId] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [pick, setPick] = useState("");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [payMode, setPayMode] = useState<string>("LATER");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lateAsk, setLateAsk] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<CanteenPreorder | null>(null);
  const [refundMode, setRefundMode] = useState<string>("CASH");
  const [cancelReason, setCancelReason] = useState("");
  const [cancelError, setCancelError] = useState<string | null>(null);

  const cancel = async () => {
    if (!cancelling) return;
    setBusy(true);
    setCancelError(null);
    try {
      const paid = cancelling.status === "PAID" && cancelling.grandTotal > 0;
      await api.post(`/canteen/preorders/${cancelling.id}/cancel`, { reason: cancelReason.trim(), refundMode: paid ? refundMode : undefined });
      toast("Pre-order cancelled", "success");
      setCancelling(null);
      setCancelReason("");
      void q.reload();
    } catch (e) {
      setCancelError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const book = async (override = false) => {
    setBusy(true);
    setError(null);
    try {
      const order = await api.post<{ id: string; grandTotal: number; invoiceNumber: string }>("/canteen/preorders", {
        date,
        slotId,
        items: lines,
        customerName: customerName.trim() || undefined,
        customerPhone: customerPhone.trim() || undefined,
        override: override || undefined,
      });
      if (payMode !== "LATER" && order.grandTotal > 0) await api.post(`/orders/${order.id}/payments`, { payments: [{ mode: payMode, amount: order.grandTotal }] });
      toast(`Booked · ${order.invoiceNumber}`, "success");
      setLines([]);
      setCustomerName("");
      setCustomerPhone("");
      void q.reload();
    } catch (e) {
      const d = e instanceof ApiError ? (e.details as { code?: string; canOverride?: boolean } | undefined) : undefined;
      if (d?.code === "PREORDER_CLOSED" && d.canOverride) setLateAsk(errorMessage(e));
      else setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const serve = async (p: CanteenPreorder) => {
    try {
      await api.post(`/canteen/preorders/${p.id}/serve`, {});
      toast("Handed over", "success");
      void q.reload();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  if (q.error && !q.data) return <ErrorState message={q.error} onRetry={q.reload} />;
  const data = q.data;
  const items = (menu.data?.items ?? []).filter((i) => i.status === "AVAILABLE");
  const nameOf = (id: string) => items.find((i) => i.id === id)?.name ?? "Item";

  return (
    <PageContainer>
      <PageHeader
        title="Pre-orders"
        subtitle="Meals booked ahead for a day and slot. Bookings close at each slot's cutoff the day before; meal-plan meals appear here once sent to the kitchen."
        actions={<Input aria-label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />}
      />
      {!data ? (
        <LoadingState />
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="space-y-5">
            {data.slots.length === 0 && (
              <Card>
                <EmptyState title="No meal slots" description="Add meal slots first (Canteen → Meal slots)." />
              </Card>
            )}
            {data.slots.map((s) => {
              const list = data.preorders.filter((p) => p.mealSlotId === s.id);
              const live = list.filter((p) => p.status !== "CANCELLED" && !p.refunded);
              return (
                <Card key={s.id}>
                  <CardHeader
                    title={`${s.name} · ${s.startTime}–${s.endTime}`}
                    subtitle={`${live.length} pre-order${live.length === 1 ? "" : "s"}${s.cutoffAt ? ` · booking closes ${formatDateTime(s.cutoffAt)}` : " · no pre-orders for this slot"}`}
                  />
                  {list.length === 0 ? (
                    <p className="px-5 py-4 text-sm text-muted">Nothing booked.</p>
                  ) : (
                    <ul className="divide-y divide-line">
                      {list.map((p) => {
                        const gone = p.status === "CANCELLED" || p.refunded;
                        return (
                          <li key={p.id} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
                            <div className="min-w-0 flex-1">
                              <p className="font-semibold">
                                {p.customerName ?? p.customerPhone ?? "Walk-in"} <span className="font-mono text-xs text-muted">{p.invoiceNumber}</span>
                              </p>
                              <p className="text-muted">{p.items.map((i) => `${i.quantity} × ${i.name}`).join(", ")}</p>
                            </div>
                            {p.subscriptionId && <Badge tone="info">Meal plan</Badge>}
                            {gone ? (
                              <Badge tone="danger">Cancelled</Badge>
                            ) : p.servedAt ? (
                              <Badge tone="success">Served {formatTime(p.servedAt)}</Badge>
                            ) : p.status === "PAID" ? (
                              <Badge tone="success">Paid {p.grandTotal > 0 ? formatINR(p.grandTotal) : ""}</Badge>
                            ) : (
                              <Badge tone="warning">Due {formatINR(p.grandTotal - p.amountPaid)}</Badge>
                            )}
                            {!gone && !p.servedAt && (
                              <>
                                <Button size="sm" variant="outline" onClick={() => void serve(p)}>
                                  Hand over
                                </Button>
                                {(can("order:cancel") || can("canteen:manage")) && (
                                  <Button size="sm" variant="ghost" onClick={() => setCancelling(p)}>
                                    Cancel
                                  </Button>
                                )}
                              </>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </Card>
              );
            })}
          </div>

          <Card className="h-fit">
            <CardHeader title={`Book for ${date}`} />
            <div className="space-y-4 p-5">
              {error && <Alert>{error}</Alert>}
              <Select label="Slot" value={slotId} onChange={(e) => setSlotId(e.target.value)}>
                <option value="">Choose a slot</option>
                {data.slots
                  .filter((s) => s.cutoffAt)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} ({s.startTime})
                    </option>
                  ))}
              </Select>
              <div className="flex items-end gap-2">
                <Select label="Item" wrapperClassName="flex-1" value={pick} onChange={(e) => setPick(e.target.value)}>
                  <option value="">Choose an item</option>
                  {items.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.name}
                    </option>
                  ))}
                </Select>
                <Button
                  variant="outline"
                  icon={<Plus size={18} />}
                  disabled={!pick}
                  onClick={() => {
                    setLines((ls) => (ls.some((l) => l.menuItemId === pick) ? ls.map((l) => (l.menuItemId === pick ? { ...l, quantity: l.quantity + 1 } : l)) : [...ls, { menuItemId: pick, quantity: 1 }]));
                    setPick("");
                  }}
                >
                  Add
                </Button>
              </div>
              {lines.length > 0 && (
                <ul className="divide-y divide-line rounded-xl border border-line text-sm">
                  {lines.map((l) => (
                    <li key={l.menuItemId} className="flex items-center gap-2 px-3 py-1.5">
                      <span className="flex-1">{nameOf(l.menuItemId)}</span>
                      <Input
                        aria-label="Quantity"
                        wrapperClassName="w-20"
                        type="number"
                        min={1}
                        value={l.quantity}
                        onChange={(e) => setLines((ls) => ls.map((x) => (x.menuItemId === l.menuItemId ? { ...x, quantity: Math.max(1, Number(e.target.value) || 1) } : x)))}
                      />
                      <Button size="sm" variant="ghost" aria-label="Remove" icon={<Trash size={16} />} onClick={() => setLines((ls) => ls.filter((x) => x.menuItemId !== l.menuItemId))} />
                    </li>
                  ))}
                </ul>
              )}
              <Input label="Name (optional)" maxLength={100} value={customerName} onChange={(e) => setCustomerName(e.target.value)} />
              <Input label="Mobile (optional)" inputMode="numeric" maxLength={10} value={customerPhone} onChange={(e) => setCustomerPhone(e.target.value.replace(/\D/g, ""))} />
              {can("payment:collect") && (
                <Select label="Paid by" value={payMode} onChange={(e) => setPayMode(e.target.value)}>
                  <option value="LATER">Pay at pickup</option>
                  {PAY_MODES.map((m) => (
                    <option key={m.value} value={m.value}>
                      {m.label}
                    </option>
                  ))}
                </Select>
              )}
              <Button block loading={busy} disabled={!slotId || !lines.length} onClick={() => void book()}>
                Book
              </Button>
            </div>
          </Card>
        </div>
      )}

      <ConfirmDialog
        open={lateAsk !== null}
        title="Booking is closed"
        description={`${lateAsk ?? ""} As a manager you can still book it; the kitchen may already have planned.`}
        confirmLabel="Book anyway"
        tone="primary"
        onConfirm={async () => {
          setLateAsk(null);
          await book(true);
        }}
        onClose={() => setLateAsk(null)}
      />
      <Dialog
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        title="Cancel this pre-order?"
        footer={
          <Button variant="danger" loading={busy} disabled={cancelReason.trim().length < 3} onClick={() => void cancel()}>
            Cancel pre-order
          </Button>
        }
      >
        <div className="space-y-4">
          {cancelError && <Alert>{cancelError}</Alert>}
          {cancelling?.status === "PAID" && cancelling.grandTotal > 0 && (
            <Select label={`It's paid: ${formatINR(cancelling.grandTotal)} goes back by credit note as`} value={refundMode} onChange={(e) => setRefundMode(e.target.value)}>
              {PAY_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </Select>
          )}
          <Input label="Reason" maxLength={200} value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} />
        </div>
      </Dialog>
    </PageContainer>
  );
}
