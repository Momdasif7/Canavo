"use client";

import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { ArrowCounterClockwise, CloudArrowUp, HandCoins, MagnifyingGlass, Prohibit, Wallet } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { addDaysISO, todayISO } from "@/lib/dates";
import { ORDER_TYPE_LABELS, PAYMENT_MODE_LABELS, formatDateTime, formatTime } from "@/lib/format";
import { listQueue, subscribeQueue, type QueuedOrder } from "@/lib/offline";
import type { Order, OrderStatus } from "@/lib/types";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useSocketEvent } from "@/components/providers/SocketProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { useConnectivity } from "@/components/providers/ConnectivityProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { Input, Select, Textarea } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog, Sheet } from "@/components/ui/Dialog";
import { Table, THead, Th, Td, Tr } from "@/components/ui/Table";
import { Alert, EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { ReceiptActions } from "@/components/bills/ReceiptActions";
import { CodBadge, codPartnerName, isCodPending } from "@/components/bills/CodBadge";
import { PaymentDialog, codEligible, orderBalance } from "@/components/pos/PaymentDialog";
import { extraTaxRows } from "@/components/pos/CartPanel";

const statusTone = { OPEN: "warning", PAID: "success", CANCELLED: "danger" } as const;

export default function BillsPage() {
  const { outletId, outlet } = useSession();
  const tz = outlet?.timezone;
  const [date, setDate] = useState(() => todayISO(tz));
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState<OrderStatus | "">("");
  /** "COD pending" chip: delivery bills the partner still has to collect */
  const [codOnly, setCodOnly] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  // Deep link: /bills?search=<invoice or phone> (e.g. from a customer profile)
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("search");
    if (q) setSearch(q);
  }, []);

  useEffect(() => {
    const id = setTimeout(() => setDebounced(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);

  // COD pending = unpaid delivery bills marked COD (filtered client-side on the unpaid list).
  const queryStatus = codOnly ? "OPEN" : status;
  const key = outletId ? `bills:${outletId}:${date}:${debounced}:${queryStatus}` : null;
  const bills = useApiQuery<Order[]>(key, () =>
    api.get<Order[]>("/orders", { query: { date: debounced ? undefined : date, search: debounced, status: queryStatus, limit: 200 } }),
  );

  useSocketEvent("order:created", () => void bills.reload());
  useSocketEvent("order:paid", () => void bills.reload());
  // COD switched / partner collected or handed over the cash
  useSocketEvent("delivery:updated", () => void bills.reload());

  const all = bills.data ?? [];
  const list = codOnly ? all.filter(isCodPending) : all;
  const paid = all.filter((o) => o.status === "PAID");
  const total = paid.reduce((s, o) => s + o.grandTotal, 0);

  return (
    <PageContainer>
      <PageHeader
        title="Bills"
        subtitle={debounced ? `Search results for “${debounced}”` : `${paid.length} paid · ${formatINR(total)}`}
        actions={
          <>
            <Input type="date" aria-label="Date" value={date} max={todayISO(tz)} onChange={(e) => setDate(e.target.value || todayISO(tz))} disabled={!!debounced} />
            <Button variant="outline" size="sm" onClick={() => setDate(addDaysISO(date, -1))} disabled={!!debounced}>
              Previous day
            </Button>
          </>
        }
      />

      <OfflineQueueCard />

      <Card>
        <div className="flex flex-wrap gap-3 border-b border-line p-4">
          <Input
            wrapperClassName="min-w-[240px] flex-1"
            type="search"
            placeholder="Search invoice no., phone or name"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            prefix={<MagnifyingGlass size={18} />}
          />
          <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as OrderStatus | "")} wrapperClassName="w-44" disabled={codOnly}>
            <option value="">All statuses</option>
            <option value="PAID">Paid</option>
            <option value="OPEN">Unpaid</option>
            <option value="CANCELLED">Cancelled</option>
          </Select>
          <button
            type="button"
            aria-pressed={codOnly}
            onClick={() => setCodOnly((v) => !v)}
            className={clsx(
              "inline-flex min-h-[44px] items-center gap-1.5 rounded-full border px-4 text-sm font-semibold transition-colors",
              codOnly
                ? "border-amber-500 bg-amber-50 text-amber-900 dark:border-amber-400 dark:bg-amber-500/15 dark:text-amber-100"
                : "border-line bg-surface text-fg hover:bg-surface-2",
            )}
            data-testid="cod-pending-chip"
          >
            <HandCoins size={18} weight={codOnly ? "fill" : "regular"} /> COD pending
          </button>
        </div>
        {bills.loading && !bills.data ? (
          <LoadingState />
        ) : bills.error ? (
          <ErrorState message={bills.error} onRetry={bills.reload} />
        ) : list.length === 0 ? (
          <EmptyState
            title={codOnly ? "No COD pending" : "No bills"}
            description={codOnly ? "Unpaid Cash on Delivery bills for this day will appear here." : debounced ? "Try a different search." : "Bills raised on this day will appear here."}
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>Invoice</Th>
                <Th>Time</Th>
                <Th>Type</Th>
                <Th>Customer</Th>
                <Th>Payment</Th>
                <Th className="text-right">Total</Th>
                <Th>Status</Th>
              </tr>
            </THead>
            <tbody>
              {list.map((o) => (
                <Tr key={o.id} onClick={() => setSelected(o.id)}>
                  <Td className="font-semibold">
                    {o.invoiceNumber}
                    {o.syncedOffline && <CloudArrowUp size={14} className="ml-1 inline text-muted" aria-label="Synced from offline" />}
                  </Td>
                  <Td className="tabular whitespace-nowrap text-muted">{debounced ? formatDateTime(o.createdAt) : formatTime(o.createdAt)}</Td>
                  <Td>
                    {ORDER_TYPE_LABELS[o.orderType]}
                    {o.tableLabel && <span className="text-muted"> · T{o.tableLabel}</span>}
                  </Td>
                  <Td className="text-muted">{[o.customerName, o.customerPhone].filter(Boolean).join(" · ") || "—"}</Td>
                  <Td className="text-muted">
                    {[...new Set(o.payments.filter((p) => p.status === "SUCCESS").map((p) => PAYMENT_MODE_LABELS[p.mode]))].join(" + ") || (o.delivery?.cod ? "" : "—")}
                    <CodBadge order={o} className={o.payments.some((p) => p.status === "SUCCESS") ? "ml-2" : undefined} />
                  </Td>
                  <Td className="tabular text-right font-bold">{formatINR(o.grandTotal)}</Td>
                  <Td>
                    <Badge tone={statusTone[o.status]}>{o.status === "OPEN" ? "Unpaid" : o.status === "PAID" ? "Paid" : "Cancelled"}</Badge>
                  </Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <BillDrawer orderId={selected} onClose={() => setSelected(null)} onChanged={bills.reload} />
    </PageContainer>
  );
}

function OfflineQueueCard() {
  const [queue, setQueue] = useState<QueuedOrder[]>([]);
  const { online, syncing, sync } = useConnectivity();
  useEffect(() => {
    const load = () => void listQueue().then(setQueue);
    load();
    return subscribeQueue(load);
  }, []);
  if (!queue.length) return null;
  return (
    <Card className="mb-5 border-amber-300 dark:border-amber-500/40">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
        <div>
          <h2 className="font-bold">Waiting to sync ({queue.length})</h2>
          <p className="text-sm text-muted">Bills raised offline on this device. They get invoice numbers once synced.</p>
        </div>
        <Button variant="secondary" size="sm" loading={syncing} disabled={!online} onClick={() => void sync()}>
          Sync now
        </Button>
      </div>
      <ul className="divide-y divide-line">
        {queue.map((q) => (
          <li key={q.clientOrderId} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
            <span className="tabular text-muted">{formatDateTime(q.createdAt)}</span>
            <span className="font-semibold">{q.order.items.reduce((s, i) => s + i.quantity, 0)} items</span>
            <span className="text-muted">{q.payments.map((p) => PAYMENT_MODE_LABELS[p.mode]).join(" + ")}</span>
            <span className="tabular ml-auto font-bold">{formatINR(q.previewTotal)}</span>
            {q.lastError ? <Badge tone="danger">{q.lastError}</Badge> : <Badge tone="warning">{q.serverOrderId ? "Recording payment" : "Pending"}</Badge>}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function BillDrawer({ orderId, onClose, onChanged }: { orderId: string | null; onClose: () => void; onChanged: () => void }) {
  const { can } = useSession();
  const toast = useToast();
  const order = useApiQuery<Order>(orderId ? `order:${orderId}` : null, () => api.get<Order>(`/orders/${orderId}`));
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [switchingCod, setSwitchingCod] = useState(false);
  const o = order.data?.id === orderId ? order.data : undefined;
  // Stable object: PaymentDialog resets its form whenever `checkout` changes identity.
  const collectCheckout = useMemo(() => (collecting && o ? { kind: "online" as const, order: o } : null), [collecting, o]);

  const cancel = async () => {
    if (!o) return;
    setCancelling(true);
    try {
      await api.post(`/orders/${o.id}/cancel`, { reason: reason.trim() });
      toast(`Bill ${o.invoiceNumber} cancelled`, "success");
      setCancelOpen(false);
      setReason("");
      await order.reload();
      onChanged();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setCancelling(false);
    }
  };

  /** Switch an open delivery bill to Cash on Delivery, or back to pay-at-counter. */
  const setCod = async (cod: boolean) => {
    if (!o) return;
    setSwitchingCod(true);
    try {
      await api.post<Order>(`/orders/${o.id}/cod`, cod ? {} : { cod: false });
      toast(cod ? `${o.invoiceNumber}: Cash on Delivery — ${codPartnerName(o)} collects ${formatINR(orderBalance(o))}` : `${o.invoiceNumber}: COD removed — collect payment at the counter`, "success");
      await order.reload();
      onChanged();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setSwitchingCod(false);
    }
  };

  return (
    <Sheet open={!!orderId} onClose={onClose} title={o ? o.invoiceNumber : "Bill"}>
      {!o ? (
        order.error ? <ErrorState message={order.error} onRetry={order.reload} /> : <LoadingState />
      ) : (
        <div className="space-y-5">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <Badge tone={statusTone[o.status]}>{o.status === "OPEN" ? "Unpaid" : o.status === "PAID" ? "Paid" : "Cancelled"}</Badge>
            <Badge>{ORDER_TYPE_LABELS[o.orderType]}</Badge>
            {o.tableLabel && <Badge>Table {o.tableLabel}</Badge>}
            {o.documentType === "BILL_OF_SUPPLY" && <Badge tone="info">Bill of supply</Badge>}
            {o.documentType === "BILL" && <Badge tone="info">Plain bill</Badge>}
            <CodBadge order={o} />
            <span className="text-muted">
              {formatDateTime(o.createdAt)} · {o.cashier.name}
            </span>
          </div>
          {(o.customerName || o.customerPhone) && (
            <p className="text-sm">
              Customer: <strong>{[o.customerName, o.customerPhone].filter(Boolean).join(" · ")}</strong>
            </p>
          )}
          {o.status === "CANCELLED" && <Alert>Cancelled{o.cancelReason ? `: ${o.cancelReason}` : ""}</Alert>}
          {isCodPending(o) && (
            <Alert tone="warning">
              Cash on Delivery — {codPartnerName(o)} collects <strong className="tabular">{formatINR(orderBalance(o))}</strong> in cash at the door. The bill is paid once
              the delivery is completed.
            </Alert>
          )}

          <div className="overflow-hidden rounded-xl border border-line">
            <Table>
              <THead>
                <tr>
                  <Th>Item</Th>
                  <Th className="text-right">Qty</Th>
                  <Th className="text-right">Amount</Th>
                </tr>
              </THead>
              <tbody>
                {o.items.map((i) => (
                  <tr key={i.id}>
                    <Td>
                      <span className="font-medium">{i.name}</span>
                      {i.addons.length > 0 && <span className="block text-xs text-muted">+ {i.addons.map((a) => a.name).join(", ")}</span>}
                      {i.notes && <span className="block text-xs italic text-muted">“{i.notes}”</span>}
                    </Td>
                    <Td className="tabular text-right">{i.quantity}</Td>
                    <Td className="tabular text-right font-semibold">{formatINR(i.unitPrice * i.quantity)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>

          <dl className="tabular space-y-1 text-sm">
            <Line label={o.documentType === "TAX_INVOICE" ? "Subtotal (pre-tax)" : "Subtotal"} value={formatINR(o.subtotal)} />
            {o.discount > 0 && <Line label="Discount" value={`−${formatINR(o.discount)}`} />}
            {o.serviceCharge > 0 && <Line label="Service charge" value={formatINR(o.serviceCharge)} />}
            {o.documentType === "TAX_INVOICE" && (
              <>
                {o.cgst + o.sgst > 0 && <Line label="CGST + SGST" value={`${formatINR(o.cgst)} + ${formatINR(o.sgst)}`} />}
                {o.igst > 0 && <Line label="IGST" value={formatINR(o.igst)} />}
                {extraTaxRows(o).map((r) => (
                  <Line key={r.label} label={r.label} value={formatINR(r.amount)} />
                ))}
              </>
            )}
            {o.roundOff !== 0 && <Line label="Round off" value={formatINR(o.roundOff)} />}
            <div className="flex justify-between border-t border-line pt-2 text-lg font-extrabold">
              <dt>Total</dt>
              <dd>{formatINR(o.grandTotal)}</dd>
            </div>
          </dl>

          <div>
            <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">Payments</h3>
            {o.payments.length === 0 ? (
              <p className="text-sm text-muted">No payments recorded.</p>
            ) : (
              <ul className="space-y-1 text-sm">
                {o.payments.map((p) => (
                  <li key={p.id} className="flex items-center justify-between">
                    <span>
                      {PAYMENT_MODE_LABELS[p.mode]}
                      {p.reference && <span className="text-muted"> · {p.reference}</span>}
                      {p.status !== "SUCCESS" && (
                        <Badge tone={p.status === "PENDING" ? "warning" : "neutral"} className="ml-2">
                          {p.status.toLowerCase()}
                        </Badge>
                      )}
                    </span>
                    <span className="tabular font-semibold">{formatINR(p.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
            {o.status === "OPEN" && (o.balance ?? 0) > 0 && (
              <p className="mt-2 text-sm font-semibold text-amber-700 dark:text-amber-300">Balance due: {formatINR(o.balance ?? 0)}</p>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            {o.status === "OPEN" && can("payment:collect") && (
              <Button variant="secondary" icon={<Wallet size={20} />} onClick={() => setCollecting(true)}>
                Collect payment
              </Button>
            )}
            {codEligible(o) && can("payment:collect") &&
              (o.delivery?.cod ? (
                <Button variant="outline" icon={<ArrowCounterClockwise size={20} />} loading={switchingCod} onClick={() => void setCod(false)}>
                  Undo COD (pay at counter)
                </Button>
              ) : (
                <Button variant="outline" icon={<HandCoins size={20} />} loading={switchingCod} onClick={() => void setCod(true)} data-testid="mark-cod">
                  Mark Cash on Delivery
                </Button>
              ))}
            {o.status !== "CANCELLED" && can("order:cancel") && (
              <Button variant="outline" className="text-red-600" icon={<Prohibit size={20} />} onClick={() => setCancelOpen(true)}>
                Cancel bill
              </Button>
            )}
          </div>

          {o.status !== "CANCELLED" && (
            <div className="border-t border-line pt-5">
              <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-muted">Receipt</h3>
              <ReceiptActions orderId={o.id} customerPhone={o.customerPhone} />
            </div>
          )}

          <Dialog
            open={cancelOpen}
            onClose={() => setCancelOpen(false)}
            size="sm"
            title={`Cancel ${o.invoiceNumber}?`}
            description={o.status === "PAID" ? "This bill is already paid — refund the customer separately." : undefined}
            footer={
              <>
                <Button variant="ghost" onClick={() => setCancelOpen(false)}>
                  Keep bill
                </Button>
                <Button variant="danger" loading={cancelling} disabled={reason.trim().length < 3} onClick={cancel}>
                  Cancel bill
                </Button>
              </>
            }
          >
            <Textarea label="Reason" placeholder="e.g. Customer changed order" maxLength={200} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Dialog>

          <PaymentDialog
            checkout={collectCheckout}
            onClose={() => setCollecting(false)}
            onPaidOnline={() => {
              setCollecting(false);
              toast("Payment recorded", "success");
              void order.reload();
              onChanged();
            }}
            onPaidOffline={() => setCollecting(false)}
          />
        </div>
      )}
    </Sheet>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between">
      <dt className="text-muted">{label}</dt>
      <dd className="font-semibold">{value}</dd>
    </div>
  );
}
