"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Moped, Phone, Printer, Tote } from "@phosphor-icons/react";
import { formatINR, formatPackingSlipText, type ChannelBoardOrder, type ChannelBoardStage, type ChannelPackingSlip } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { formatTime } from "@/lib/format";
import { getPaperWidth } from "@/lib/prefs";
import { printReceiptText } from "@/lib/print";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useSocketEvent } from "@/components/providers/SocketProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { ChannelBadge } from "@/components/bills/ChannelBadge";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Dialog } from "@/components/ui/Dialog";
import { Input, Toggle } from "@/components/ui/Input";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";

const COLUMNS: { stage: ChannelBoardStage; title: string; hint: string }[] = [
  { stage: "NEW", title: "New", hint: "Billed — kitchen not started" },
  { stage: "PREPARING", title: "Preparing", hint: "Kitchen is on it" },
  { stage: "PACKED", title: "Packed", hint: "Waiting for the rider" },
  { stage: "HANDED_OVER", title: "Handed over", hint: "With the rider" },
];

/** Per-device opt-out: only the counter that should print keeps this on. */
const DEVICE_PRINT_KEY = "canavo.onlineOrders.devicePrints";
const readDevicePrints = () => {
  try {
    return localStorage.getItem(DEVICE_PRINT_KEY) !== "0";
  } catch {
    return true;
  }
};

/**
 * Phase 6 — Online orders board (Billing & orders → Online orders): Zomato / Swiggy / ONDC and own
 * online-page orders arrive billed; staff pack them and hand them to the rider. Live via the
 * `channel:board` socket event.
 *
 * Auto-print: with the outlet setting on (Settings → Channels, or the toggle here), a device that has
 * this board open — and hasn't switched "This device prints" off — prints the bill, KOTs and packing
 * slip of every new order through the browser print flow (window.print). Browsers show the print
 * dialog each time; for hands-free printing run the counter browser in kiosk printing mode
 * (Chrome: --kiosk-printing) with the thermal printer as default.
 */
export function OnlineOrdersBoard() {
  const { outletId, can } = useSession();
  const toast = useToast();
  const board = useApiQuery<{ orders: ChannelBoardOrder[] }>(outletId ? `channel-board:${outletId}` : null, () => api.get("/channels/board"));
  const settings = useApiQuery<{ autoPrint: boolean }>(outletId ? `channel-board-settings:${outletId}` : null, () => api.get("/channels/board/settings"));
  const [devicePrints, setDevicePrints] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [handover, setHandover] = useState<ChannelBoardOrder | null>(null);
  const { reload, setData } = board;

  useEffect(() => setDevicePrints(readDevicePrints()), []);

  // Several events can arrive at once (new order + KOTs): reload once.
  const timer = useRef<number | null>(null);
  const reloadSoon = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void reload(), 250);
  }, [reload]);
  useEffect(() => {
    const id = window.setInterval(() => void reload(), 60_000);
    return () => window.clearInterval(id);
  }, [reload]);

  // Auto-print queue: one print job after another; each new order printed once per page load.
  const printed = useRef(new Set<string>());
  const queue = useRef<Promise<void>>(Promise.resolve());
  const autoPrint = Boolean(settings.data?.autoPrint) && devicePrints;
  const printArrival = useCallback(
    (orderId: string) => {
      if (printed.current.has(orderId)) return;
      printed.current.add(orderId);
      queue.current = queue.current.then(async () => {
        try {
          const paper = getPaperWidth();
          const { text } = await api.get<{ text: string }>(`/channels/board/${orderId}/print`, { query: { paper } });
          printReceiptText(text, paper);
        } catch (e) {
          toast(`Could not print the new order: ${errorMessage(e)}`, "error");
        }
      });
    },
    [toast],
  );

  useSocketEvent<{ orderId: string; stage: ChannelBoardStage }>("channel:board", (e) => {
    if (e.stage === "NEW" && autoPrint) printArrival(e.orderId);
    reloadSoon();
  });
  useSocketEvent("channel:rider", () => reloadSoon());
  // Events sent while the socket was down are not replayed: reload on (re)connect (QA Phase 9).
  useSocketEvent("connect", () => reloadSoon());

  const replace = (o: ChannelBoardOrder) => setData((d) => (d ? { orders: d.orders.map((x) => (x.orderId === o.orderId ? o : x)) } : d));

  const packed = async (o: ChannelBoardOrder) => {
    setBusy(o.orderId);
    try {
      replace(await api.post<ChannelBoardOrder>(`/channels/board/${o.orderId}/packed`));
      toast(`${o.invoiceNumber} packed`, "success");
    } catch (e) {
      toast(errorMessage(e), "error");
      void reload();
    } finally {
      setBusy(null);
    }
  };

  const handedOver = async (o: ChannelBoardOrder, riderName: string) => {
    setBusy(o.orderId);
    try {
      replace(await api.post<ChannelBoardOrder>(`/channels/board/${o.orderId}/handover`, riderName.trim() ? { riderName: riderName.trim() } : {}));
      toast(`${o.invoiceNumber} handed ${o.weDeliver ? "to our delivery partner" : "to the rider"}`, "success");
      setHandover(null);
    } catch (e) {
      toast(errorMessage(e), "error");
      void reload();
    } finally {
      setBusy(null);
    }
  };

  const printSlip = async (o: ChannelBoardOrder) => {
    try {
      const slip = await api.get<ChannelPackingSlip>(`/channels/board/${o.orderId}/slip`);
      const paper = getPaperWidth();
      printReceiptText(formatPackingSlipText(slip, { width: paper === 80 ? 48 : 32 }), paper);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const toggleAutoPrint = async (v: boolean) => {
    try {
      settings.setData(await api.put<{ autoPrint: boolean }>("/channels/board/settings", { autoPrint: v }));
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  const toggleDevice = (v: boolean) => {
    setDevicePrints(v);
    try {
      localStorage.setItem(DEVICE_PRINT_KEY, v ? "1" : "0");
    } catch {
      /* private mode: this page load only */
    }
  };

  if (board.loading && !board.data) return <Card><LoadingState /></Card>;
  if (board.error) return <Card><ErrorState message={board.error} onRetry={reload} /></Card>;
  const orders = board.data?.orders ?? [];
  const cancelled = orders.filter((o) => o.stage === "CANCELLED");

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-start gap-x-8 gap-y-2 p-4">
        <div className="min-w-[260px] flex-1">
          <Toggle
            checked={Boolean(settings.data?.autoPrint)}
            onChange={(v) => void toggleAutoPrint(v)}
            disabled={!can("channel:manage") || !settings.data}
            label="Print bill and KOT automatically when a channel order arrives"
            description={can("channel:manage") ? "Prints on a device that has this board open." : "Only a manager can change this."}
          />
        </div>
        {settings.data?.autoPrint && (
          <div className="min-w-[220px]">
            <Toggle checked={devicePrints} onChange={toggleDevice} label="This device prints" description="Turn off on every screen but the counter printer's." />
          </div>
        )}
      </Card>

      {orders.length === 0 ? (
        <Card>
          <EmptyState title="No online orders today" description="Orders from Zomato, Swiggy, ONDC and your online ordering page appear here as they arrive." />
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          {COLUMNS.map((col) => {
            const list = orders.filter((o) => o.stage === col.stage);
            return (
              <section key={col.stage} aria-label={col.title} className="min-w-0 space-y-3">
                <header className="flex items-baseline justify-between gap-2 px-1">
                  <h2 className="text-sm font-bold uppercase tracking-wide">
                    {col.title} <span className="text-muted">({list.length})</span>
                  </h2>
                  <span className="truncate text-xs text-muted">{col.hint}</span>
                </header>
                {list.map((o) => (
                  <OrderCard key={o.orderId} order={o} busy={busy === o.orderId} onPacked={() => void packed(o)} onHandover={() => setHandover(o)} onSlip={() => void printSlip(o)} />
                ))}
              </section>
            );
          })}
        </div>
      )}

      {cancelled.length > 0 && (
        <p className="text-sm text-muted">
          Cancelled today: {cancelled.map((o) => `${o.invoiceNumber}${o.channelOrderId ? ` (#${o.channelOrderId})` : ""}`).join(", ")}
        </p>
      )}

      <HandoverDialog order={handover} busy={busy !== null} onClose={() => setHandover(null)} onConfirm={(name) => handover && void handedOver(handover, name)} />
    </div>
  );
}

function OrderCard({ order: o, busy, onPacked, onHandover, onSlip }: { order: ChannelBoardOrder; busy: boolean; onPacked: () => void; onHandover: () => void; onSlip: () => void }) {
  const open = o.stage === "NEW" || o.stage === "PREPARING" || o.stage === "PACKED";
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <ChannelBadge channel={o.channel} />
        {o.channelOrderId && <span className="font-semibold">#{o.channelOrderId}</span>}
        {o.weDeliver && (
          <Badge tone="info">
            <Moped size={12} /> We deliver
          </Badge>
        )}
        <span className="ml-auto text-xs text-muted tabular">{formatTime(o.placedAt)}</span>
      </div>
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-semibold">{o.invoiceNumber}</span>
        {o.customerName && <span className="truncate text-muted">{o.customerName}</span>}
      </div>
      <ul className="space-y-1 text-sm">
        {o.items.map((i, n) => (
          <li key={n}>
            <span className="tabular font-semibold">{i.quantity} ×</span> {i.name}
            {i.notes && <span className="block pl-6 text-xs text-amber-700 dark:text-amber-400">! {i.notes}</span>}
          </li>
        ))}
      </ul>
      <div className="flex items-center justify-between gap-2">
        <span className="tabular font-semibold">{formatINR(o.total)}</span>
        {o.paid ? <Badge tone="success">Paid online</Badge> : <Badge tone="warning">Collect {formatINR(o.total)}</Badge>}
      </div>
      {o.rider && (
        <div className="rounded-lg bg-surface-2 px-3 py-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Moped size={16} />
            <span className="font-semibold">{o.rider.name ?? (o.weDeliver ? "Partner" : "Rider")}</span>
            {o.rider.arrived && o.stage !== "HANDED_OVER" && <Badge tone="success">At the store</Badge>}
            {o.rider.phone && (
              <a href={`tel:${o.rider.phone}`} className="inline-flex items-center gap-1 text-primary">
                <Phone size={14} /> {o.rider.phone}
              </a>
            )}
          </div>
          {(o.rider.pickupCode || o.rider.eta) && (
            <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted">
              {o.rider.pickupCode && (
                <span>
                  Pickup code <span className="font-bold text-fg">{o.rider.pickupCode}</span>
                </span>
              )}
              {o.rider.eta && <span>ETA {/^\d{4}-\d{2}-\d{2}T/.test(o.rider.eta) ? formatTime(o.rider.eta) : o.rider.eta}</span>}
            </div>
          )}
        </div>
      )}
      {(o.packedAt || o.handedOverAt) && (
        <p className="text-xs text-muted">
          {o.packedAt && <>Packed {formatTime(o.packedAt)}</>}
          {o.packedAt && o.handedOverAt && " · "}
          {o.handedOverAt && <>Handed over {formatTime(o.handedOverAt)}</>}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        {(o.stage === "NEW" || o.stage === "PREPARING") && (
          <Button size="sm" icon={<Tote size={16} />} onClick={onPacked} loading={busy}>
            Packed
          </Button>
        )}
        {open && (
          <Button size="sm" variant={o.stage === "PACKED" ? "primary" : "outline"} icon={<Check size={16} />} onClick={onHandover} disabled={busy}>
            {o.weDeliver ? "Partner picked up" : "Handed to rider"}
          </Button>
        )}
        <Button size="sm" variant="outline" icon={<Printer size={16} />} onClick={onSlip}>
          Slip
        </Button>
      </div>
    </Card>
  );
}

function HandoverDialog({ order, busy, onClose, onConfirm }: { order: ChannelBoardOrder | null; busy: boolean; onClose: () => void; onConfirm: (riderName: string) => void }) {
  const [name, setName] = useState("");
  useEffect(() => setName(order?.rider?.name ?? ""), [order]);
  return (
    <Dialog
      open={Boolean(order)}
      onClose={onClose}
      title={order?.weDeliver ? "Our partner picked it up" : "Handed to the rider"}
      description={order ? `${order.invoiceNumber}${order.channelOrderId ? ` · #${order.channelOrderId}` : ""}` : undefined}
      size="sm"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Back
          </Button>
          <Button onClick={() => onConfirm(name)} loading={busy}>
            Confirm
          </Button>
        </div>
      }
    >
      <Input label="Rider name (optional)" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus />
      {order && !order.weDeliver && order.channel !== "ONLINE" && <p className="mt-2 text-xs text-muted">We tell the app the order is on its way.</p>}
    </Dialog>
  );
}
