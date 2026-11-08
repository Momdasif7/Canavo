"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import {
  ArrowsLeftRight,
  BellRinging,
  CheckCircle,
  ForkKnife,
  Intersect,
  PencilSimple,
  Plus,
  Receipt,
  Timer,
  Trash,
  Users,
} from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { PAYMENT_MODE_LABELS } from "@/lib/format";
import type { KotStatus, Order } from "@/lib/types";
import type { FloorTable, SessionBillResult, SessionItem, TableSessionDetail } from "@/lib/types-service";
import { useSession } from "@/components/providers/SessionProvider";
import { useSocketEvent } from "@/components/providers/SocketProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { useNow } from "@/hooks/useNow";
import { Sheet, Dialog } from "@/components/ui/Dialog";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Alert, ErrorState, LoadingState } from "@/components/ui/States";
import { MenuPickerDialog, type PickedLine } from "@/components/pos/MenuPickerDialog";
import { PaymentDialog } from "@/components/pos/PaymentDialog";
import { ReceiptActions } from "@/components/bills/ReceiptActions";
import { BillDialog } from "./BillDialog";
import { minutesLabel, useStaffOptions } from "./common";

const KOT_TONE: Record<KotStatus, "info" | "primary" | "success" | "neutral"> = { RECEIVED: "info", PREPARING: "primary", READY: "success", SERVED: "neutral" };

interface PayJob {
  order: Order;
  label: string;
  suggestedSplit?: number[];
  advance?: number;
}

/** Running-tab panel for an occupied table. */
export function TabPanel({
  sessionId,
  floorTables,
  onClose,
  onChanged,
}: {
  sessionId: string | null;
  /** Current floor (for transfer/merge pickers) */
  floorTables: FloorTable[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const { can } = useSession();
  const toast = useToast();
  const now = useNow(30_000);
  const [s, setS] = useState<TableSessionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<null | "add" | "bill" | "transfer" | "merge" | "edit">(null);
  const [voiding, setVoiding] = useState<SessionItem | null>(null);
  const [payQueue, setPayQueue] = useState<PayJob[]>([]);
  const [receiptFor, setReceiptFor] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!sessionId) return;
    try {
      setS(await api.get<TableSessionDetail>(`/tables/sessions/${sessionId}`));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [sessionId]);

  useEffect(() => {
    setS(null);
    setPayQueue([]);
    void load();
  }, [load]);

  useSocketEvent<{ tableIds: string[]; sessionId?: string; action: string }>("table:updated", (e) => {
    if (!s) return;
    if (e.sessionId === s.id || e.tableIds.some((id) => id === s.tableId || s.mergedTableIds.includes(id))) void load();
  });
  // Events sent while the socket was down are not replayed: reload on (re)connect (QA Phase 9).
  useSocketEvent("connect", () => s && void load());

  const tableIds = useMemo(() => (s ? [s.tableId, ...s.mergedTableIds] : []), [s]);
  const primaryTable = floorTables.find((t) => t.id === s?.tableId);
  const attention = primaryTable?.status === "NEEDS_ATTENTION";

  /** KOT rounds, in firing order; items not yet fired go last. */
  const rounds = useMemo(() => {
    if (!s) return [];
    const map = new Map<string, { kotNumber?: number; status?: KotStatus; items: SessionItem[] }>();
    for (const i of s.items) {
      const k = i.kotId ?? "pending";
      const r = map.get(k) ?? { kotNumber: i.kotNumber, status: i.kotStatus, items: [] };
      r.items.push(i);
      map.set(k, r);
    }
    return [...map.values()];
  }, [s]);

  const run = async (key: string, fn: () => Promise<TableSessionDetail | void>, ok?: string) => {
    setBusy(key);
    try {
      const next = await fn();
      if (next) setS(next);
      if (ok) toast(ok, "success");
      onChanged();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(null);
    }
  };

  const addItems = async (lines: PickedLine[]) => {
    if (!s) return;
    const res = await api.post<{ session: TableSessionDetail }>(`/tables/sessions/${s.id}/items`, {
      items: lines.map((l) => ({ menuItemId: l.itemId, variantId: l.variantId, addonIds: l.addonIds, quantity: l.quantity, notes: l.notes.trim() || undefined, seat: l.seat })),
    });
    setS(res.session);
    setDialog(null);
    toast(`Sent ${lines.reduce((n, l) => n + l.quantity, 0)} item(s) to the kitchen`, "success");
    onChanged();
  };

  const billed = (r: SessionBillResult, parts?: number) => {
    setDialog(null);
    setS(r.session);
    onChanged();
    const jobs = r.orders
      .filter((o) => o.order.status === "OPEN")
      .map((o, idx) => ({
        order: o.order,
        label: o.group,
        suggestedSplit: parts && r.equalSplit ? r.equalSplit : undefined,
        advance: idx === 0 && r.advancePaid > 0 ? r.advancePaid : undefined,
      }));
    toast(`${r.orders.length} bill${r.orders.length === 1 ? "" : "s"} created`, "success");
    setPayQueue(jobs);
  };

  const collect = async (orderId: string) => {
    try {
      const order = await api.get<Order>(`/orders/${orderId}`);
      const noPaymentsYet = s ? s.orders.every((o) => o.payments.every((p) => p.status !== "SUCCESS")) : false;
      setPayQueue([{ order, label: order.invoiceNumber, advance: noPaymentsYet && s?.advancePaid ? s.advancePaid : undefined }]);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const afterPaid = async () => {
    const rest = payQueue.slice(1);
    setPayQueue(rest);
    if (!s) return;
    const next = await api.get<TableSessionDetail>(`/tables/sessions/${s.id}`).catch(() => null);
    if (next) setS(next);
    onChanged();
    if (!rest.length && next?.status === "CLOSED") {
      toast(`Table ${next.label} is free — tab closed`, "success");
      onClose();
    }
  };

  const head = payQueue[0];
  const open = !!sessionId;

  return (
    <>
      <Sheet
        open={open}
        onClose={onClose}
        width="max-w-2xl"
        title={
          s ? (
            <span className="flex items-center gap-2">
              Table {s.label}
              {s.status === "CLOSED" && <Badge>Closed</Badge>}
              {attention && <Badge tone="danger">Needs attention</Badge>}
            </span>
          ) : (
            "Table"
          )
        }
        footer={
          s && s.status === "OPEN" ? (
            <div className="flex w-full flex-wrap items-center gap-2">
              <div className="mr-auto text-sm">
                <span className="text-muted">Unbilled </span>
                <strong className="tabular text-lg">{formatINR(s.unbilledEstimate.grandTotal)}</strong>
                <span className="text-muted"> · Total {formatINR(s.estimate.grandTotal)}</span>
              </div>
              {s.readyToClose && (
                <Button
                  variant="secondary"
                  icon={<CheckCircle size={20} />}
                  loading={busy === "close"}
                  onClick={() =>
                    run(
                      "close",
                      async () => {
                        const r = await api.post<TableSessionDetail>(`/tables/sessions/${s.id}/close`);
                        onClose();
                        return r;
                      },
                      `Table ${s.label} closed`,
                    )
                  }
                >
                  Close tab
                </Button>
              )}
              <Button variant="outline" icon={<Plus size={20} />} onClick={() => setDialog("add")}>
                Add items
              </Button>
              {can("order:create") && (
                <Button icon={<Receipt size={20} />} onClick={() => setDialog("bill")} disabled={!s.unbilledCount}>
                  Bill
                </Button>
              )}
            </div>
          ) : undefined
        }
      >
        {!s ? (
          error ? (
            <ErrorState message={error} onRetry={load} />
          ) : (
            <LoadingState />
          )
        ) : (
          <div className="space-y-5">
            {/* Summary */}
            <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
              <span className="flex items-center gap-1.5">
                <Users size={18} className="text-muted" /> <strong>{s.guests}</strong> guests
              </span>
              <span className="flex items-center gap-1.5">
                <Timer size={18} className="text-muted" /> {minutesLabel(Math.max(0, Math.floor((now - new Date(s.openedAt).getTime()) / 60_000)))}
              </span>
              <span className="flex items-center gap-1.5">
                <ForkKnife size={18} className="text-muted" /> {s.waiter?.name ?? "No waiter"}
              </span>
              {s.customerName && (
                <span>
                  {s.customerName}
                  {s.customerPhone && <span className="text-muted"> · {s.customerPhone}</span>}
                </span>
              )}
              {s.advancePaid > 0 && <Badge tone="info">Advance {formatINR(s.advancePaid)}</Badge>}
            </div>

            {s.status === "OPEN" && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" icon={<PencilSimple size={18} />} onClick={() => setDialog("edit")}>
                  Guests / waiter
                </Button>
                <Button size="sm" variant="outline" icon={<ArrowsLeftRight size={18} />} onClick={() => setDialog("transfer")}>
                  Transfer
                </Button>
                <Button size="sm" variant="outline" icon={<Intersect size={18} />} onClick={() => setDialog("merge")}>
                  Merge
                </Button>
                <Button
                  size="sm"
                  variant={attention ? "danger" : "outline"}
                  icon={<BellRinging size={18} />}
                  loading={busy === "attention"}
                  onClick={() =>
                    run(
                      "attention",
                      async () => {
                        await api.patch(`/tables/${s.tableId}/status`, { status: attention ? "OCCUPIED" : "NEEDS_ATTENTION" });
                      },
                      attention ? "Attention cleared" : "Marked as needing attention",
                    )
                  }
                >
                  {attention ? "Clear attention" : "Needs attention"}
                </Button>
              </div>
            )}

            {/* Items by KOT round */}
            <section aria-label="Items">
              {rounds.length === 0 ? (
                <div className="rounded-xl border border-dashed border-line p-8 text-center text-sm text-muted">
                  Nothing ordered yet.{s.status === "OPEN" && " Use Add items above to start the order."}
                </div>
              ) : (
                <div className="space-y-3">
                  {rounds.map((r, idx) => (
                    <div key={idx} className="overflow-hidden rounded-xl border border-line">
                      <div className="flex items-center gap-2 bg-surface-2 px-3 py-2 text-sm">
                        <strong>{r.kotNumber ? `KOT #${r.kotNumber}` : "Not fired"}</strong>
                        <span className="text-muted">Round {idx + 1}</span>
                        {r.status && (
                          <Badge tone={KOT_TONE[r.status]} className="ml-auto">
                            {r.status.toLowerCase()}
                          </Badge>
                        )}
                      </div>
                      <ul className="divide-y divide-line">
                        {r.items.map((i) => (
                          <li key={i.id} className={clsx("flex items-start gap-2 px-3 py-2", i.billedOrderId && "opacity-60")}>
                            <span className="tabular w-8 shrink-0 font-bold text-primary">{i.quantity}×</span>
                            <div className="min-w-0 flex-1">
                              <p className="font-semibold leading-tight">{i.name}</p>
                              {i.addons.length > 0 && <p className="text-xs text-muted">+ {i.addons.join(", ")}</p>}
                              <p className="text-xs text-muted">
                                {i.seat ? <span className="font-semibold text-secondary dark:text-green-300">Seat {i.seat}</span> : "Shared"}
                                {i.notes && <span> · {i.notes}</span>}
                              </p>
                            </div>
                            {i.billedOrderId && <Badge tone="success">Billed</Badge>}
                            <span className="tabular text-sm font-semibold">{formatINR(i.amount)}</span>
                            {!i.billedOrderId && s.status === "OPEN" && can("order:cancel") && (
                              <IconButton label={`Void ${i.name}`} className="-my-2 text-red-600" onClick={() => setVoiding(i)}>
                                <Trash size={18} />
                              </IconButton>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* Bills */}
            {s.orders.length > 0 && (
              <section aria-label="Bills">
                <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">Bills</h3>
                <ul className="divide-y divide-line rounded-xl border border-line">
                  {s.orders.map((o) => {
                    const paid = o.payments.filter((p) => p.status === "SUCCESS").reduce((a, p) => a + p.amount, 0);
                    return (
                      <li key={o.id} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
                        <span className="font-semibold">{o.invoiceNumber}</span>
                        <Badge tone={o.status === "PAID" ? "success" : o.status === "OPEN" ? "warning" : "danger"}>{o.status.toLowerCase()}</Badge>
                        <span className="text-xs text-muted">{[...new Set(o.payments.filter((p) => p.status === "SUCCESS").map((p) => PAYMENT_MODE_LABELS[p.mode]))].join(" + ")}</span>
                        <span className="tabular ml-auto font-bold">{formatINR(o.grandTotal)}</span>
                        {o.status === "OPEN" && paid > 0 && <span className="tabular text-xs text-muted">paid {formatINR(paid)}</span>}
                        <Button size="sm" variant="ghost" onClick={() => setReceiptFor(o.id)}>
                          Receipt
                        </Button>
                        {o.status === "OPEN" && can("payment:collect") && (
                          <Button size="sm" variant="secondary" onClick={() => void collect(o.id)}>
                            Collect
                          </Button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </div>
        )}
      </Sheet>

      {s && (
        <>
          <MenuPickerDialog open={dialog === "add"} title={`Add to Table ${s.label}`} confirmLabel="Send to kitchen" seats={s.guests} onClose={() => setDialog(null)} onConfirm={addItems} />
          <BillDialog session={s} open={dialog === "bill"} onClose={() => setDialog(null)} onBilled={billed} />
          <TransferDialog
            open={dialog === "transfer"}
            session={s}
            tables={floorTables.filter((t) => !t.session && !tableIds.includes(t.id))}
            onClose={() => setDialog(null)}
            onDone={(next) => {
              setS(next);
              setDialog(null);
              onChanged();
              toast(`Moved to Table ${next.label}`, "success");
            }}
          />
          <MergeDialog
            open={dialog === "merge"}
            session={s}
            tables={floorTables.filter((t) => !tableIds.includes(t.id))}
            onClose={() => setDialog(null)}
            onDone={(next) => {
              setS(next);
              setDialog(null);
              onChanged();
              toast(`Merged — now Table ${next.label}`, "success");
            }}
          />
          <EditSessionDialog
            open={dialog === "edit"}
            session={s}
            onClose={() => setDialog(null)}
            onDone={(next) => {
              setS(next);
              setDialog(null);
              onChanged();
            }}
          />
          <ConfirmDialog
            open={!!voiding}
            title={voiding ? `Void ${voiding.quantity}× ${voiding.name}?` : "Void item"}
            description="The kitchen ticket will show it as voided."
            confirmLabel="Void item"
            reason={{ label: "Reason", placeholder: "e.g. customer changed mind", minLength: 3 }}
            onClose={() => setVoiding(null)}
            onConfirm={async (reason) => {
              if (!voiding) return;
              try {
                setS(await api.del<TableSessionDetail>(`/tables/sessions/${s.id}/items/${voiding.id}`, { body: { reason } }));
              } catch (e) {
                throw new Error(errorMessage(e));
              }
              toast("Item voided", "success");
              onChanged();
            }}
          />
        </>
      )}

      {head && (
        <PaymentDialog
          checkout={{ kind: "online", order: head.order }}
          advance={head.advance}
          suggestedSplit={head.suggestedSplit}
          onClose={() => {
            toast(payQueue.length > 1 ? `${payQueue.length} bills left unpaid — collect them from the tab` : `${head.order.invoiceNumber} kept unpaid — collect it from the tab`, "info");
            setPayQueue([]);
            void load();
          }}
          onPaidOnline={() => {
            toast(`${head.order.invoiceNumber} paid`, "success");
            void afterPaid();
          }}
          onPaidOffline={() => toast("Table bills can't be settled offline", "error")}
        />
      )}

      <Dialog open={!!receiptFor} onClose={() => setReceiptFor(null)} title="Receipt" size="md">
        {receiptFor && <ReceiptActions orderId={receiptFor} customerPhone={s?.customerPhone} />}
      </Dialog>
    </>
  );
}

function TransferDialog({
  open,
  session,
  tables,
  onClose,
  onDone,
}: {
  open: boolean;
  session: TableSessionDetail;
  tables: FloorTable[];
  onClose: () => void;
  onDone: (s: TableSessionDetail) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [open]);
  const move = async (t: FloorTable) => {
    setBusy(t.id);
    setError(null);
    try {
      onDone(await api.post<TableSessionDetail>(`/tables/sessions/${session.id}/transfer`, { toTableId: t.id }));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title={`Move Table ${session.label} to…`} size="md">
      {error && (
        <div className="mb-3">
          <Alert>{error}</Alert>
        </div>
      )}
      {tables.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted">No free tables right now.</p>
      ) : (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {tables.map((t) => (
            <Button key={t.id} variant="outline" className="flex-col !py-2" onClick={() => void move(t)} loading={busy === t.id} disabled={!!busy}>
              <span className="text-lg font-extrabold">{t.label}</span>
              <span className="text-xs text-muted">{t.capacity} seats</span>
            </Button>
          ))}
        </div>
      )}
    </Dialog>
  );
}

function MergeDialog({
  open,
  session,
  tables,
  onClose,
  onDone,
}: {
  open: boolean;
  session: TableSessionDetail;
  tables: FloorTable[];
  onClose: () => void;
  onDone: (s: TableSessionDetail) => void;
}) {
  const [sel, setSel] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setSel([]);
    setError(null);
  }, [open]);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(await api.post<TableSessionDetail>(`/tables/sessions/${session.id}/merge`, { tableIds: sel }));
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
      title={`Merge into Table ${session.label}`}
      description="Selected tables join this tab. Occupied tables bring their items and bills along."
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy} disabled={!sel.length}>
            Merge {sel.length || ""}
          </Button>
        </>
      }
    >
      {error && (
        <div className="mb-3">
          <Alert>{error}</Alert>
        </div>
      )}
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
        {tables.map((t) => {
          const on = sel.includes(t.id);
          return (
            <button
              key={t.id}
              type="button"
              aria-pressed={on}
              onClick={() => setSel((x) => (on ? x.filter((y) => y !== t.id) : [...x, t.id]))}
              className={clsx("flex min-h-[64px] flex-col items-center justify-center rounded-xl border-2 font-semibold", on ? "border-primary bg-primary-50 dark:bg-primary/15" : "border-line")}
            >
              <span className="text-lg font-extrabold">{t.label}</span>
              <span className="text-xs text-muted">{t.session ? `Occupied · ${formatINR(t.session.runningTotal)}` : `${t.capacity} seats`}</span>
            </button>
          );
        })}
      </div>
    </Dialog>
  );
}

function EditSessionDialog({ open, session, onClose, onDone }: { open: boolean; session: TableSessionDetail; onClose: () => void; onDone: (s: TableSessionDetail) => void }) {
  const staff = useStaffOptions();
  const [guests, setGuests] = useState(session.guests);
  const [waiterId, setWaiterId] = useState(session.waiterId ?? "");
  const [name, setName] = useState(session.customerName ?? "");
  const [phone, setPhone] = useState(session.customerPhone ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setGuests(session.guests);
    setWaiterId(session.waiterId ?? "");
    setName(session.customerName ?? "");
    setPhone(session.customerPhone ?? "");
    setError(null);
  }, [open, session]);
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      onDone(
        await api.patch<TableSessionDetail>(`/tables/sessions/${session.id}`, {
          guests,
          ...(staff && staff.length > 1 && { waiterId: waiterId || null }),
          customerName: name.trim() || null,
          customerPhone: phone || null,
        }),
      );
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
      title="Edit tab"
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} loading={busy}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {error && <Alert>{error}</Alert>}
        <Input label="Guests" type="number" min={1} max={100} value={guests} onChange={(e) => setGuests(Math.max(1, Math.min(100, Math.floor(Number(e.target.value) || 1))))} />
        {staff && staff.length > 1 && (
          <Select label="Waiter" value={waiterId} onChange={(e) => setWaiterId(e.target.value)}>
            <option value="">—</option>
            {staff.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        )}
        <Input label="Customer name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
        <Input label="Customer phone" inputMode="numeric" maxLength={10} value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))} />
      </div>
    </Dialog>
  );
}

