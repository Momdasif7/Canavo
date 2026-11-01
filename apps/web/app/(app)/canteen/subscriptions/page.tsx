"use client";

import { useState } from "react";
import { MagnifyingGlass, Plus } from "@phosphor-icons/react";
import { WEEKDAY_SHORT, formatINR } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { parseRupees } from "@/lib/format";
import type { Menu } from "@/lib/types";
import { PAY_MODES, tomorrowISO, type MealSubscription, type PayMode, type SlotsResponse } from "@/lib/types-meals";
import { addDaysISO } from "@/lib/dates";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useToast } from "@/components/providers/ToastProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Input, Select } from "@/components/ui/Input";
import { Alert, EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { Table, THead, Td, Th, Tr } from "@/components/ui/Table";

type Customer = { id: string; name: string | null; phone: string };

/**
 * Canteen → Meal plans: a customer pays upfront for one meal in a slot on chosen weekdays.
 * Each day's meal goes to the kitchen at the slot's cutoff; skipped or unused meals are
 * refunded (credit note) if the plan is cancelled.
 */
export default function SubscriptionsPage() {
  const toast = useToast();
  const q = useApiQuery("canteen-subscriptions", () => api.get<MealSubscription[]>("/canteen/subscriptions"));
  const [creating, setCreating] = useState(false);
  const [skipFor, setSkipFor] = useState<MealSubscription | null>(null);
  const [cancelFor, setCancelFor] = useState<MealSubscription | null>(null);

  const act = async (path: string, done: string) => {
    try {
      await api.post(path, {});
      toast(done, "success");
      void q.reload();
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  if (q.error && !q.data) return <ErrorState message={q.error} onRetry={q.reload} />;
  if (!q.data) return <LoadingState />;

  return (
    <PageContainer>
      <PageHeader
        title="Meal plans"
        subtitle="Paid upfront on one bill (GST charged once). Each meal is sent to the kitchen at the slot's cutoff the day before and handed over from Pre-orders."
        actions={
          <Button icon={<Plus size={20} />} onClick={() => setCreating(true)}>
            New plan
          </Button>
        }
      />
      <Card>
        {q.data.length === 0 ? (
          <EmptyState title="No meal plans yet" />
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>Customer</Th>
                <Th>Meal</Th>
                <Th>Days</Th>
                <Th>Meals</Th>
                <Th>Status</Th>
                <Th />
              </tr>
            </THead>
            <tbody>
              {q.data.map((s) => (
                <Tr key={s.id}>
                  <Td>
                    <span className="font-semibold">{s.customer?.name ?? "Customer"}</span>
                    <span className="block text-xs text-muted">{s.customer?.phone}</span>
                  </Td>
                  <Td>
                    {s.menuItem.name} · {s.slot.name}
                    <span className="block text-xs text-muted">
                      {formatINR(s.pricePerMeal)} a meal{s.order && ` · bill ${s.order.invoiceNumber}`}
                    </span>
                  </Td>
                  <Td>
                    {s.daysOfWeek.map((d) => WEEKDAY_SHORT[d]).join(", ")}
                    <span className="block text-xs text-muted">
                      {s.startDate} to {s.endDate}
                      {s.skips.length > 0 && ` · skips ${s.skips.map((k) => k.date.slice(5)).join(", ")}`}
                    </span>
                  </Td>
                  <Td className="tabular">
                    {s.delivered} of {s.mealCount}
                    {s.refundedMeals > 0 && <span className="block text-xs text-muted">{s.refundedMeals} refunded</span>}
                  </Td>
                  <Td>
                    <Badge tone={s.status === "ACTIVE" ? "success" : s.status === "PAUSED" ? "warning" : "danger"}>{s.status === "ACTIVE" ? "Active" : s.status === "PAUSED" ? "Paused" : "Cancelled"}</Badge>
                  </Td>
                  <Td className="whitespace-nowrap text-right">
                    {s.status !== "CANCELLED" && (
                      <>
                        {s.status === "ACTIVE" ? (
                          <Button size="sm" variant="ghost" onClick={() => void act(`/canteen/subscriptions/${s.id}/pause`, "Plan paused")}>
                            Pause
                          </Button>
                        ) : (
                          <Button size="sm" variant="ghost" onClick={() => void act(`/canteen/subscriptions/${s.id}/resume`, "Plan resumed")}>
                            Resume
                          </Button>
                        )}{" "}
                        <Button size="sm" variant="outline" onClick={() => setSkipFor(s)}>
                          Skip a day
                        </Button>{" "}
                        <Button size="sm" variant="ghost" onClick={() => setCancelFor(s)}>
                          Cancel
                        </Button>
                      </>
                    )}
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {creating && <CreatePlanDialog onClose={() => setCreating(false)} onCreated={() => void q.reload()} />}
      {skipFor && <SkipDialog sub={skipFor} onClose={() => setSkipFor(null)} onDone={() => void q.reload()} />}
      {cancelFor && <CancelDialog sub={cancelFor} onClose={() => setCancelFor(null)} onDone={() => void q.reload()} />}
    </PageContainer>
  );
}

function CreatePlanDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const slots = useApiQuery("canteen-slots", () => api.get<SlotsResponse>("/canteen/slots"));
  const menu = useApiQuery("menu-all", () => api.get<Menu>("/menu"));
  const [phone, setPhone] = useState("");
  const [found, setFound] = useState<Customer[] | null>(null);
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [slotId, setSlotId] = useState("");
  const [menuItemId, setMenuItemId] = useState("");
  const [days, setDays] = useState<number[]>([0, 1, 2, 3, 4]);
  const [startDate, setStartDate] = useState(tomorrowISO());
  const [endDate, setEndDate] = useState(addDaysISO(tomorrowISO(), 29));
  const [price, setPrice] = useState("");
  const [paymentMode, setPaymentMode] = useState<PayMode>("CASH");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const search = async () => {
    setError(null);
    try {
      setFound((await api.get<{ items: Customer[] }>("/customers", { query: { search: phone.trim(), limit: 10 } })).items);
    } catch (e) {
      setError(errorMessage(e));
    }
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const sub = await api.post<MealSubscription>("/canteen/subscriptions", {
        customerId: customer!.id,
        slotId,
        menuItemId,
        daysOfWeek: days,
        startDate,
        endDate,
        pricePerMeal: parseRupees(price) ?? undefined,
        paymentMode,
      });
      toast(`Plan created: ${sub.mealCount} meals, bill ${sub.order?.invoiceNumber ?? ""} paid ${formatINR(sub.order?.grandTotal ?? 0)}`, "success");
      onCreated();
      onClose();
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
      size="lg"
      title="New meal plan"
      description="The whole plan is billed and paid now. Leave the price empty to use the item's price in that slot."
      footer={
        <Button loading={busy} disabled={!customer || !slotId || !menuItemId || !days.length} onClick={() => void create()}>
          Create and take payment
        </Button>
      }
    >
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        {customer ? (
          <p className="flex items-center gap-2 text-sm">
            Customer: <b>{customer.name ?? customer.phone}</b> {customer.phone}
            <Button size="sm" variant="ghost" onClick={() => setCustomer(null)}>
              Change
            </Button>
          </p>
        ) : (
          <div className="space-y-2">
            <div className="flex items-end gap-2">
              <Input label="Customer (mobile or name)" wrapperClassName="flex-1" value={phone} onChange={(e) => setPhone(e.target.value)} />
              <Button variant="outline" icon={<MagnifyingGlass size={18} />} disabled={phone.trim().length < 3} onClick={() => void search()}>
                Find
              </Button>
            </div>
            {found && (found.length === 0 ? <p className="text-sm text-muted">No customer found. Add them in Customers first.</p> : (
              <ul className="divide-y divide-line rounded-xl border border-line text-sm">
                {found.map((c) => (
                  <li key={c.id}>
                    <button type="button" className="w-full px-3 py-2 text-left hover:bg-surface-2" onClick={() => setCustomer(c)}>
                      {c.name ?? "No name"} · {c.phone}
                    </button>
                  </li>
                ))}
              </ul>
            ))}
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <Select label="Slot" value={slotId} onChange={(e) => setSlotId(e.target.value)}>
            <option value="">Choose a slot</option>
            {(slots.data?.slots ?? []).filter((s) => s.active).map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} ({s.startTime})
              </option>
            ))}
          </Select>
          <Select label="Meal" value={menuItemId} onChange={(e) => setMenuItemId(e.target.value)}>
            <option value="">Choose an item</option>
            {(menu.data?.items ?? []).filter((i) => i.status !== "HIDDEN").map((i) => (
              <option key={i.id} value={i.id}>
                {i.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <p className="mb-1.5 text-sm font-semibold">Days</p>
          <div className="flex flex-wrap gap-2">
            {WEEKDAY_SHORT.map((d, i) => (
              <label key={d} className="flex items-center gap-1.5 rounded-xl border border-line px-3 py-2 text-sm">
                <input type="checkbox" checked={days.includes(i)} onChange={() => setDays((ds) => (ds.includes(i) ? ds.filter((x) => x !== i) : [...ds, i].sort()))} />
                {d}
              </label>
            ))}
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="From" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          <Input label="To" type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          <Input label="Price per meal (₹, optional)" type="number" min={0} value={price} onChange={(e) => setPrice(e.target.value)} />
          <Select label="Paid by" value={paymentMode} onChange={(e) => setPaymentMode(e.target.value as PayMode)}>
            {PAY_MODES.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </Select>
        </div>
      </div>
    </Dialog>
  );
}

function SkipDialog({ sub, onClose, onDone }: { sub: MealSubscription; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [date, setDate] = useState(tomorrowISO());
  const [askForce, setAskForce] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const skip = async (force = false) => {
    setError(null);
    try {
      await api.post(`/canteen/subscriptions/${sub.id}/skips`, { date, force: force || undefined });
      toast(`${date} skipped`, "success");
      onDone();
      onClose();
    } catch (e) {
      const code = (e as { details?: { code?: string; canOverride?: boolean } }).details;
      if (code?.code === "MEAL_ALREADY_PLANNED" && code.canOverride) setAskForce(true);
      setError(errorMessage(e));
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title="Skip a day"
      description="The meal isn't made that day. Skipped meals are refunded only if the plan is cancelled."
      footer={
        askForce ? (
          <Button variant="danger" onClick={() => void skip(true)}>
            Skip anyway (cancel that meal)
          </Button>
        ) : (
          <Button onClick={() => void skip()}>Skip</Button>
        )
      }
    >
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Input label="Date" type="date" min={sub.startDate} max={sub.endDate} value={date} onChange={(e) => { setDate(e.target.value); setAskForce(false); }} />
        {sub.skips.length > 0 && (
          <div className="flex flex-wrap gap-2 text-sm">
            Skipped:
            {sub.skips.map((k) => (
              <button
                key={k.date}
                type="button"
                className="rounded-lg border border-line px-2 py-0.5 hover:bg-surface-2"
                title="Undo skip"
                onClick={() =>
                  void api
                    .del(`/canteen/subscriptions/${sub.id}/skips/${k.date}`)
                    .then(() => {
                      toast(`${k.date} back on`, "success");
                      onDone();
                      onClose();
                    })
                    .catch((e) => setError(errorMessage(e)))
                }
              >
                {k.date} ✕
              </button>
            ))}
          </div>
        )}
      </div>
    </Dialog>
  );
}

function CancelDialog({ sub, onClose, onDone }: { sub: MealSubscription; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [refundMode, setRefundMode] = useState<PayMode>("CASH");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refundable = Math.max(0, sub.mealCount - sub.delivered - sub.refundedMeals);

  const cancel = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.post(`/canteen/subscriptions/${sub.id}/cancel`, { refundMode });
      toast("Plan cancelled", "success");
      onDone();
      onClose();
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
      title="Cancel meal plan?"
      description={`${refundable} meal(s) not delivered are refunded (about ${formatINR(refundable * sub.pricePerMeal)} plus their GST) by credit note on the plan's bill.`}
      footer={
        <Button variant="danger" loading={busy} onClick={() => void cancel()}>
          Cancel plan
        </Button>
      }
    >
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Select label="Give the money back as" value={refundMode} onChange={(e) => setRefundMode(e.target.value as PayMode)}>
          {PAY_MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </Select>
      </div>
    </Dialog>
  );
}
