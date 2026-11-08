"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { ArrowCounterClockwise, ArrowUUpLeft, CaretLeft, CaretRight, CloudArrowUp, FileXls, HandCoins, MagnifyingGlass, Prohibit, Wallet } from "@phosphor-icons/react";
import { ORDER_CHANNELS, ORDER_CHANNEL_LABELS, REFUND_REASON_LABELS, formatINR, type OrderChannel } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { addDaysISO, todayISO } from "@/lib/dates";
import { ORDER_TYPE_LABELS, PAYMENT_MODE_LABELS, formatDateTime, formatTime } from "@/lib/format";
import { listQueue, subscribeQueue, type QueuedOrder } from "@/lib/offline";
import type { CreditNote, Order, OrderStatus, OrderType } from "@/lib/types";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useDebouncedValue } from "@/hooks/useDebounced";
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
import { RefundDialog } from "@/components/bills/RefundDialog";
import { useApproval } from "@/components/providers/ApprovalProvider";
import { CodBadge, codPartnerName, isCodPending } from "@/components/bills/CodBadge";
import { ChannelBadge } from "@/components/bills/ChannelBadge";
import { KitchenStatus } from "@/components/bills/KitchenStatus";
import { DownloadButton } from "@/components/reports/ExportButtons";
import {
  BILLS_PAGE_SIZE,
  BillSummaryStrip,
  MAX_BILL_RANGE_DAYS,
  RangePicker,
  apiQuery,
  daysInRange,
  filtersFromQuery,
  filtersToQuery,
  matchPreset,
  presetDates,
  rangeLabel,
  type BillFilterState,
  type BillPaymentFilter,
  type BillSummary,
} from "@/components/bills/BillFilters";
import { PaymentDialog, codEligible, orderBalance } from "@/components/pos/PaymentDialog";
import { extraTaxRows } from "@/components/pos/CartPanel";

const statusTone = { OPEN: "warning", PAID: "success", CANCELLED: "danger" } as const;

export default function BillsPage() {
  const { outletId, outlet, me } = useSession();
  // Phase 6: the channel filter only matters to hotels taking online / aggregator orders.
  const channelsOn = Boolean(me?.modules?.includes("CHANNELS"));
  const tz = outlet?.timezone;
  const today = todayISO(tz);
  const [filters, setFilters] = useState<BillFilterState>(() => ({ ...presetDates("today", today), status: "", paymentMode: "", orderType: "", search: "", cod: false }));
  /** URL read once on mount (deep links such as /bills?search=<phone>, refresh, back) */
  const [ready, setReady] = useState(false);
  const [search, setSearch] = useState("");
  const debounced = useDebouncedValue(search.trim(), 300);
  const [customOpen, setCustomOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    const f = filtersFromQuery(new URLSearchParams(window.location.search), today);
    setFilters(f);
    setSearch(f.search);
    setCustomOpen(matchPreset(f.from, f.to, today) === "custom");
    setReady(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply the search once typing has settled (the debounced value caught up with the box).
  useEffect(() => {
    if (ready && debounced === search.trim()) setFilters((f) => (f.search === debounced ? f : { ...f, search: debounced }));
  }, [debounced, search, ready]);

  // Keep the filters in the URL (refresh / back keep them) without adding history entries.
  useEffect(() => {
    if (!ready) return;
    const qs = filtersToQuery(filters, today);
    const next = `${window.location.pathname}${qs ? `?${qs}` : ""}`;
    if (next !== `${window.location.pathname}${window.location.search}`) window.history.replaceState(window.history.state, "", next);
  }, [filters, ready, today]);

  const patch = (p: Partial<BillFilterState>) => setFilters((f) => ({ ...f, ...p }));
  const query = useMemo(() => apiQuery(filters), [filters]);
  const searching = !!filters.search;
  const rangeTooLong = daysInRange(filters.from, filters.to) > MAX_BILL_RANGE_DAYS;
  const key = outletId && ready && !rangeTooLong ? `bills:${outletId}:${JSON.stringify(query)}` : null;

  // Pages: the first request (and every refresh) loads everything shown so far, "Load more" appends.
  const loaded = useRef<{ key: string | null; count: number }>({ key: null, count: BILLS_PAGE_SIZE });
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const bills = useApiQuery<Order[]>(key, async () => {
    if (loaded.current.key !== key) loaded.current = { key, count: BILLS_PAGE_SIZE };
    const limit = Math.min(200, Math.max(BILLS_PAGE_SIZE, loaded.current.count));
    const rows = await api.get<Order[]>("/orders", { query: { ...query, limit, offset: 0 } });
    setHasMore(rows.length >= limit);
    return rows;
  });
  const summary = useApiQuery<BillSummary>(key ? `bills-summary:${key}` : null, () => api.get<BillSummary>("/orders/summary", { query }));

  const loadMore = async () => {
    const current = bills.data ?? [];
    setLoadingMore(true);
    try {
      const rows = await api.get<Order[]>("/orders", { query: { ...query, limit: BILLS_PAGE_SIZE, offset: current.length } });
      if (loaded.current.key !== key) return;
      bills.setData((prev) => {
        const seen = new Set((prev ?? []).map((o) => o.id));
        const merged = [...(prev ?? []), ...rows.filter((o) => !seen.has(o.id))];
        loaded.current.count = merged.length;
        return merged;
      });
      setHasMore(rows.length >= BILLS_PAGE_SIZE);
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setLoadingMore(false);
    }
  };

  const reloadAll = () => {
    void bills.reload();
    void summary.reload();
  };
  useSocketEvent("order:created", reloadAll);
  useSocketEvent("order:paid", reloadAll);
  // COD switched / partner collected or handed over the cash
  useSocketEvent("delivery:updated", reloadAll);
  // Events sent while the socket was down are not replayed: reload on (re)connect (QA Phase 9).
  useSocketEvent("connect", reloadAll);

  const all = bills.data ?? [];
  const list = filters.cod ? all.filter(isCodPending) : all;
  const multiDay = searching || filters.from !== filters.to;

  // Previous / Next shift the selected day — or the whole range by its length.
  const span = daysInRange(filters.from, filters.to);
  const shift = (dir: -1 | 1) => {
    const from = addDaysISO(filters.from, dir * span);
    const to = addDaysISO(filters.to, dir * span);
    patch({ from, to });
    setCustomOpen(matchPreset(from, to, today) === "custom");
  };
  const nextDisabled = addDaysISO(filters.to, span) > today;

  const choosePreset = (p: ReturnType<typeof matchPreset>) => {
    if (p === "custom") return setCustomOpen(true);
    setCustomOpen(false);
    patch(presetDates(p, today));
  };

  const anyFilter =
    filters.status || filters.paymentMode || filters.orderType || filters.channel || filters.search || filters.cod || filters.from !== today || filters.to !== today;
  const clearFilters = () => {
    setSearch("");
    setCustomOpen(false);
    setFilters({ ...presetDates("today", today), status: "", paymentMode: "", orderType: "", channel: "", search: "", cod: false });
  };

  const exportName = `bills_${searching ? "search" : filters.from}${!searching && filters.to !== filters.from ? `_${filters.to}` : ""}.xlsx`;

  return (
    <PageContainer>
      <PageHeader
        title="Bills"
        subtitle={searching ? `Search results for “${filters.search}” · all dates` : rangeLabel(filters.from, filters.to, today)}
        actions={
          <>
            <Button variant="outline" size="sm" icon={<CaretLeft size={18} />} onClick={() => shift(-1)} disabled={searching} title={span > 1 ? `Previous ${span} days` : undefined}>
              Previous day
            </Button>
            <Button variant="outline" size="sm" onClick={() => shift(1)} disabled={searching || nextDisabled} title={span > 1 ? `Next ${span} days` : undefined}>
              Next day <CaretRight size={18} />
            </Button>
            <DownloadButton path="/orders/export" query={query} filename={exportName} icon={<FileXls size={20} />}>
              Export Excel
            </DownloadButton>
          </>
        }
      />

      <OfflineQueueCard />

      <div className="mb-4">
        <RangePicker
          from={filters.from}
          to={filters.to}
          today={today}
          customOpen={customOpen}
          disabled={searching}
          onPreset={choosePreset}
          onCustom={(from, to) => patch({ from, to })}
        />
        {searching && <p className="mt-2 text-xs text-muted">Searching all dates — clear the search to filter by date.</p>}
      </div>

      {summary.data && !rangeTooLong && <BillSummaryStrip summary={summary.data} />}

      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
          <Input
            wrapperClassName="min-w-[220px] flex-1 basis-full sm:basis-auto"
            type="search"
            placeholder="Search invoice no., phone or name"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            prefix={<MagnifyingGlass size={18} />}
          />
          <Select
            aria-label="Payment mode"
            value={filters.cod ? "COD" : filters.paymentMode}
            onChange={(e) => patch({ paymentMode: e.target.value as BillPaymentFilter | "" })}
            wrapperClassName="w-[calc(50%-6px)] sm:w-40"
            disabled={filters.cod}
          >
            <option value="">All payments</option>
            <option value="CASH">Cash</option>
            <option value="UPI">UPI</option>
            <option value="CARD">Card</option>
            <option value="KHATA">Khata</option>
            {channelsOn && <option value="ONLINE">Paid online</option>}
            <option value="COD">Cash on Delivery</option>
          </Select>
          {channelsOn && (
            <Select
              aria-label="Channel"
              value={filters.channel ?? ""}
              onChange={(e) => patch({ channel: e.target.value as OrderChannel | "" })}
              wrapperClassName="w-[calc(50%-6px)] sm:w-40"
            >
              <option value="">All channels</option>
              {ORDER_CHANNELS.map((c) => (
                <option key={c} value={c}>
                  {ORDER_CHANNEL_LABELS[c]}
                </option>
              ))}
            </Select>
          )}
          <Select
            aria-label="Order type"
            value={filters.orderType}
            onChange={(e) => patch({ orderType: e.target.value as OrderType | "" })}
            wrapperClassName="w-[calc(50%-6px)] sm:w-40"
          >
            <option value="">All order types</option>
            {(Object.keys(ORDER_TYPE_LABELS) as OrderType[]).map((t) => (
              <option key={t} value={t}>
                {ORDER_TYPE_LABELS[t]}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Status"
            value={filters.cod ? "OPEN" : filters.status}
            onChange={(e) => patch({ status: e.target.value as OrderStatus | "" })}
            wrapperClassName="w-[calc(50%-6px)] sm:w-40"
            disabled={filters.cod}
          >
            <option value="">All statuses</option>
            <option value="PAID">Paid</option>
            <option value="OPEN">Unpaid</option>
            <option value="CANCELLED">Cancelled</option>
          </Select>
          <button
            type="button"
            aria-pressed={filters.cod}
            onClick={() => patch({ cod: !filters.cod })}
            className={clsx(
              "inline-flex min-h-[44px] items-center gap-1.5 rounded-full border px-4 text-sm font-semibold transition-colors",
              filters.cod
                ? "border-amber-500 bg-amber-50 text-amber-900 dark:border-amber-400 dark:bg-amber-500/15 dark:text-amber-100"
                : "border-line bg-surface text-fg hover:bg-surface-2",
            )}
            data-testid="cod-pending-chip"
          >
            <HandCoins size={18} weight={filters.cod ? "fill" : "regular"} /> COD pending
          </button>
          {anyFilter && (
            <button type="button" onClick={clearFilters} className="min-h-[44px] px-1 text-sm font-semibold text-primary hover:underline" data-testid="clear-filters">
              Clear filters
            </button>
          )}
        </div>
        {rangeTooLong ? (
          <div className="p-4">
            <Alert>Pick at most {MAX_BILL_RANGE_DAYS} days.</Alert>
          </div>
        ) : bills.loading && !bills.data ? (
          <LoadingState />
        ) : bills.error ? (
          <ErrorState message={bills.error} onRetry={reloadAll} />
        ) : list.length === 0 ? (
          <EmptyState
            title={filters.cod ? "No COD pending" : "No bills"}
            description={
              filters.cod
                ? "Unpaid Cash on Delivery bills for these dates will appear here."
                : searching
                  ? "Try a different search."
                  : anyFilter && (filters.status || filters.paymentMode || filters.orderType || filters.channel)
                    ? "No bills match these filters."
                    : "Bills raised in this period will appear here."
            }
          />
        ) : (
          <>
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
                    <Td className="tabular whitespace-nowrap text-muted">{multiDay ? formatDateTime(o.createdAt) : formatTime(o.createdAt)}</Td>
                    <Td>
                      {ORDER_TYPE_LABELS[o.orderType]}
                      {o.tableLabel && <span className="text-muted"> · T{o.tableLabel}</span>}
                      <ChannelBadge channel={o.channel} className="ml-2" />
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
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 text-sm text-muted">
              <span>
                Showing {list.length}
                {summary.data && !filters.cod ? ` of ${summary.data.count}` : ""} bill{list.length === 1 ? "" : "s"}
              </span>
              {hasMore && (
                <Button variant="outline" size="sm" loading={loadingMore} onClick={() => void loadMore()} data-testid="load-more">
                  Load more
                </Button>
              )}
            </div>
          </>
        )}
      </Card>

      <BillDrawer orderId={selected} onClose={() => setSelected(null)} onChanged={reloadAll} />
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
          <p className="text-sm text-muted">Bills raised offline on this device. Unnumbered ones get their invoice number once synced.</p>
        </div>
        <Button variant="secondary" size="sm" loading={syncing} disabled={!online} onClick={() => void sync()}>
          Sync now
        </Button>
      </div>
      <ul className="divide-y divide-line">
        {queue.map((q) => (
          <li key={q.clientOrderId} className="flex flex-wrap items-center gap-3 px-5 py-3 text-sm">
            <span className="tabular text-muted">{formatDateTime(q.createdAt)}</span>
            {/* The server's number wins once synced (it falls back to its own counter if the device's is taken). */}
            {(q.invoiceNumber ?? q.order.offlineInvoiceNumber) && <span className="tabular font-semibold">{q.invoiceNumber ?? q.order.offlineInvoiceNumber}</span>}
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
  const { can, me } = useSession();
  const toast = useToast();
  const withApproval = useApproval();
  const order = useApiQuery<Order>(orderId ? `order:${orderId}` : null, () => api.get<Order>(`/orders/${orderId}`));
  const creditNotes = useApiQuery<CreditNote[]>(orderId ? `credit-notes:${orderId}` : null, () => api.get<CreditNote[]>(`/orders/${orderId}/credit-notes`));
  const [refundOpen, setRefundOpen] = useState(false);
  // Voids and refunds: order:cancel as before, or a cashier with a manager's PIN when approvals are on (Phase 3.3).
  const canVoid = can("order:cancel") || (Boolean(me?.features?.APPROVAL_PINS) && can("payment:collect"));
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [collecting, setCollecting] = useState(false);
  const [switchingCod, setSwitchingCod] = useState(false);
  const o = order.data?.id === orderId ? order.data : undefined;
  // Stable object: PaymentDialog resets its form whenever `checkout` changes identity.
  const collectCheckout = useMemo(() => (collecting && o ? { kind: "online" as const, order: o } : null), [collecting, o]);
  // Live food progress: the kitchen moved one of this bill's tickets.
  useSocketEvent("kot:updated", (k: { orderId?: string | null }) => {
    if (orderId && k?.orderId === orderId) void order.reload();
  });

  const cancel = async () => {
    if (!o) return;
    setCancelling(true);
    try {
      await withApproval((approval) => api.post(`/orders/${o.id}/cancel`, { reason: reason.trim(), approval }));
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
            <ChannelBadge channel={o.channel} />
            {o.channelOrderId && <span className="text-muted">#{o.channelOrderId}</span>}
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

          {o.kots && (
            <div>
              <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">Kitchen status</h3>
              <KitchenStatus kots={o.kots} cancelled={o.status === "CANCELLED"} />
            </div>
          )}

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
            {o.status === "PAID" && canVoid && (o.refundedAmount ?? 0) < o.grandTotal && (
              <Button variant="outline" icon={<ArrowUUpLeft size={20} />} onClick={() => setRefundOpen(true)}>
                Refund
              </Button>
            )}
            {o.status !== "CANCELLED" && canVoid && !(o.refundedAmount ?? 0) && (
              <Button variant="outline" className="text-red-600" icon={<Prohibit size={20} />} onClick={() => setCancelOpen(true)}>
                Cancel bill
              </Button>
            )}
          </div>

          {(creditNotes.data ?? []).length > 0 && (
            <div>
              <h3 className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">Refunds (credit notes)</h3>
              <ul className="space-y-1 text-sm">
                {creditNotes.data!.map((cn) => (
                  <li key={cn.id} className="flex items-center justify-between gap-2">
                    <span>
                      <span className="font-semibold">{cn.number}</span>
                      <span className="text-muted">
                        {" "}
                        · {formatDateTime(cn.createdAt)} · {REFUND_REASON_LABELS[cn.reason as keyof typeof REFUND_REASON_LABELS] ?? cn.reason} · {cn.refundMode.toLowerCase()}
                        {cn.items.length > 0 && ` · ${cn.items.map((l) => `${l.quantity}× ${l.name}`).join(", ")}`}
                      </span>
                    </span>
                    <span className="tabular font-semibold text-red-600 dark:text-red-300">−{formatINR(cn.amount)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

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
            description={
              o.status === "PAID"
                ? "This bill is already paid. Cancelling voids it: hand the cash back — the drawer's expected cash goes down by the cash paid. To give back only part of it, or keep the bill, use Refund (credit note)."
                : undefined
            }
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

          <RefundDialog
            order={o}
            credited={creditNotes.data ?? []}
            open={refundOpen}
            onClose={() => setRefundOpen(false)}
            onDone={(cn) => {
              setRefundOpen(false);
              toast(`Credit note ${cn.number}: refunded ${formatINR(cn.amount)}`, "success");
              void order.reload();
              void creditNotes.reload();
              onChanged();
            }}
          />

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
