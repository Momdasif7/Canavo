"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { CheckCircle, Clock, CurrencyInr, HandArrowDown, Hourglass, Storefront } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import type { PaymentStatusResponse } from "@/lib/types";
import { clock, countdown, seatPart, theatreApi, TIMING_SHORT, type BoardOrder, type RunnerBoard, type ShowTime } from "@/lib/theatre";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useNow } from "@/hooks/useNow";
import { useSession } from "@/components/providers/SessionProvider";
import { useSocketEvent, useSocketStatus } from "@/components/providers/SocketProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";

/** Fallback refresh while the socket is quiet or down. */
const POLL_MS = 15_000;

const STAGE_TONE: Record<BoardOrder["stage"], string> = {
  WAITING: "border-amber-400/70",
  PREPARING: "border-sky-400/60",
  READY: "border-secondary",
  DELIVERED: "border-line opacity-60",
};
const STAGE_LABEL: Record<BoardOrder["stage"], string> = { WAITING: "Waiting", PREPARING: "In the kitchen", READY: "Ready — take it", DELIVERED: "Delivered" };

/** WAITING covers three cases: not paid yet, paid but held for the interval, or paid and about to reach the kitchen. */
function stageLabel(o: BoardOrder, now: number) {
  if (!o.paid) return "Waiting for payment";
  if (o.stage === "WAITING") return o.releaseAt && new Date(o.releaseAt).getTime() > now ? "Held for interval" : "Sending to kitchen";
  return STAGE_LABEL[o.stage];
}

/** Cinema → Runner board: seat orders by screen and row, interval holds, the counter pickup tokens. */
export default function RunnerBoardPage() {
  const { outletId, can, outlet } = useSession();
  const tz = outlet?.timezone;
  const toast = useToast();
  const live = useSocketStatus();
  const now = useNow(1000);
  const [tab, setTab] = useState<string>("ALL");
  const [busy, setBusy] = useState<string | null>(null);
  const board = useApiQuery<RunnerBoard>(outletId ? `theatre-board:${outletId}` : null, () => theatreApi.board());
  const { reload, setData } = board;

  // Live: th1 emits theatre:updated on every stage change; KOT moves and payments change stages too.
  const timer = useRef<number | null>(null);
  const soon = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void reload(), 250);
  }, [reload]);
  useSocketEvent("theatre:updated", soon);
  useSocketEvent("kot:updated", soon);
  useSocketEvent("kot:new", soon);
  useSocketEvent("order:paid", soon);
  useSocketEvent("connect", soon);
  useEffect(() => {
    const id = window.setInterval(() => document.visibilityState === "visible" && void reload(), POLL_MS);
    const onVisible = () => document.visibilityState === "visible" && void reload();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onVisible);
    };
  }, [reload]);
  // An interval order's release time passed: fetch, so it shows as in the kitchen.
  const nextRelease = useMemo(() => {
    const all = [...(board.data?.screens.flatMap((s) => s.rows.flatMap((r) => r.orders)) ?? []), ...(board.data?.counter ?? [])];
    return all
      .filter((o) => o.stage === "WAITING" && o.releaseAt)
      .map((o) => new Date(o.releaseAt!).getTime())
      .sort((a, b) => a - b)[0];
  }, [board.data]);
  useEffect(() => {
    if (!nextRelease) return;
    const ms = nextRelease - Date.now() + 1500;
    const id = window.setTimeout(() => void reload(), Math.max(1000, Math.min(ms, 2 ** 31 - 1)));
    return () => window.clearTimeout(id);
  }, [nextRelease, reload]);

  const patch = (o: BoardOrder) =>
    setData((b) =>
      b && {
        screens: b.screens.map((s) => ({ ...s, rows: s.rows.map((r) => ({ ...r, orders: r.orders.map((x) => (x.requestId === o.requestId ? o : x)) })) })),
        counter: b.counter.map((x) => (x.requestId === o.requestId ? o : x)),
      },
    );

  const act = async (o: BoardOrder, kind: "ready" | "delivered") => {
    setBusy(o.requestId);
    try {
      patch(await (kind === "ready" ? theatreApi.ready(o.requestId) : theatreApi.delivered(o.requestId)));
      soon();
    } catch (e) {
      toast(errorMessage(e), "error");
      void reload();
    } finally {
      setBusy(null);
    }
  };

  /** Mock / no-webhook UPI: the cashier confirms the payment seen on the merchant app. */
  const confirmPaid = async (o: BoardOrder) => {
    if (!o.orderId) return;
    setBusy(o.requestId);
    try {
      const s = await api.get<PaymentStatusResponse>(`/orders/${o.orderId}/payment-status`);
      const p = s.payments.find((x) => x.mode === "UPI" && x.status === "PENDING");
      if (!p) throw new Error(s.status === "PAID" ? "Already paid" : "No UPI payment waiting on this order");
      await api.post(`/orders/${o.orderId}/payments/${p.id}/confirm`, {});
      toast(`Seat ${seatPart(o.seatLabel)}: payment confirmed`, "success");
      soon();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(null);
    }
  };

  if (board.loading && !board.data) return <LoadingState label="Loading the runner board…" />;
  if (board.error && !board.data) return <ErrorState message={board.error} onRetry={reload} />;
  const data = board.data!;
  const open = (l: BoardOrder[]) => l.filter((o) => o.stage !== "DELIVERED");
  const screens = data.screens.map((s) => ({ ...s, rows: s.rows.map((r) => ({ ...r, orders: open(r.orders).sort((a, b) => (a.seatNumber ?? 0) - (b.seatNumber ?? 0)) })).filter((r) => r.orders.length) }));
  const count = (s: (typeof screens)[number]) => s.rows.reduce((n, r) => n + r.orders.length, 0);
  const shown = tab === "ALL" ? screens : screens.filter((s) => s.id === tab);
  const counter = open(data.counter).filter((o) => tab === "ALL" || o.screenId === tab);
  const card = (o: BoardOrder, big = false) => (
    <OrderCard key={o.requestId} order={o} now={now} big={big} busy={busy === o.requestId} canPay={can("payment:collect")} onAct={act} onPaid={confirmPaid} />
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2">
        <h1 className="mr-2 text-xl font-extrabold">Runner board</h1>
        <div className="flex gap-2 overflow-x-auto" role="tablist" aria-label="Screen">
          {[{ id: "ALL", name: "All screens", n: screens.reduce((n, s) => n + count(s), 0) + open(data.counter).length }, ...screens.map((s) => ({ id: s.id, name: s.name, n: count(s) }))].map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={clsx(
                "flex min-h-tap shrink-0 items-center gap-2 rounded-xl border px-4 text-sm font-bold",
                tab === t.id ? "border-primary bg-primary text-primary-fg" : "border-line bg-surface hover:border-primary/60",
              )}
            >
              {t.name}
              <span className={clsx("rounded-full px-1.5 text-xs", tab === t.id ? "bg-black/15" : "bg-surface-2")}>{t.n}</span>
            </button>
          ))}
        </div>
        <span
          role="status"
          className={clsx(
            "ml-auto inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-bold",
            live ? "bg-green-100 text-green-800 dark:bg-green-500/15 dark:text-green-300" : "bg-amber-100 text-amber-800 dark:bg-amber-500/15 dark:text-amber-300",
          )}
          title={live ? "Orders appear instantly" : "Connection lost — checking every 15 s"}
        >
          <span className={clsx("h-2 w-2 rounded-full", live ? "bg-green-500" : "animate-pulse bg-amber-500")} />
          {live ? "Live" : "Reconnecting…"}
        </span>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto p-3 lg:grid-cols-[minmax(0,1fr)_340px] lg:overflow-hidden">
        <div className="min-h-0 space-y-4 lg:overflow-y-auto lg:pr-1" aria-label="Seat orders">
          {!data.screens.length && <EmptyState title="No screens yet" description="Set up screens and seats in Cinema → Screens & seats." />}
          {shown.map((s) => (
            <section key={s.id} className="rounded-2xl bg-surface-2 p-3" aria-label={s.name} data-testid="board-screen">
              <header className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
                <h2 className="text-lg font-extrabold">
                  {s.name} <span className="text-sm text-muted">{s.code}</span>
                </h2>
                <ShowLine show={s.currentShow} now={now} tz={tz} />
                <span className="ml-auto rounded-full bg-surface px-2.5 py-0.5 text-sm font-bold">{count(s)}</span>
              </header>
              {s.rows.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted">No seat orders</p>
              ) : (
                <div className="space-y-3">
                  {s.rows.map((r) => (
                    <div key={r.row}>
                      <p className="mb-1.5 px-1 text-xs font-extrabold uppercase tracking-wider text-muted">Row {r.row}</p>
                      <div className="grid gap-3 sm:grid-cols-2 2xl:grid-cols-3">{r.orders.map((o) => card(o))}</div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>

        <aside className="flex min-h-0 flex-col rounded-2xl bg-surface-2" aria-label="Counter pickup" data-testid="board-counter">
          <header className="flex items-center gap-2 px-4 py-3">
            <Storefront size={20} className="text-primary" />
            <h2 className="font-bold">Counter pickup</h2>
            <span className="ml-auto rounded-full bg-surface px-2.5 py-0.5 text-sm font-bold">{counter.length}</span>
          </header>
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 pb-3">
            {counter.length === 0 ? <p className="py-10 text-center text-sm text-muted">No counter orders</p> : counter.map((o) => card(o, true))}
          </div>
        </aside>
      </div>
    </div>
  );
}

function ShowLine({ show, now, tz }: { show: ShowTime | null; now: number; tz?: string }) {
  if (!show) return <span className="text-sm text-muted">No show running</span>;
  const interval = show.intervalAt ? new Date(show.intervalAt).getTime() : null;
  return (
    <span className="flex flex-wrap items-center gap-x-3 text-sm">
      <span className="font-semibold">{show.title}</span>
      {show.status === "INTERVAL" ? (
        <Badge tone="warning">Interval now</Badge>
      ) : interval && interval > now ? (
        <span className="inline-flex items-center gap-1 font-bold text-amber-700 dark:text-amber-300" data-testid="interval-countdown">
          <Hourglass size={16} /> Interval in <span className="tabular">{countdown(show.intervalAt!, now)}</span>
        </span>
      ) : null}
      <span className="text-muted">Orders close {clock(show.closesAt, tz)}</span>
    </span>
  );
}

function OrderCard({
  order: o,
  now,
  big,
  busy,
  canPay,
  onAct,
  onPaid,
}: {
  order: BoardOrder;
  now: number;
  big: boolean;
  busy: boolean;
  canPay: boolean;
  onAct: (o: BoardOrder, kind: "ready" | "delivered") => void;
  onPaid: (o: BoardOrder) => void;
}) {
  const ageMin = Math.max(0, Math.floor((now - new Date(o.createdAt).getTime()) / 60_000));
  return (
    <article className={clsx("overflow-hidden rounded-xl border-2 bg-surface shadow-sm", o.paid ? STAGE_TONE[o.stage] : "border-dashed border-red-300 dark:border-red-500/40")} data-testid="board-order" data-stage={o.stage}>
      <div className="flex items-start gap-3 px-3 pt-2.5">
        {big && o.pickupToken != null ? (
          <div className="text-center">
            <p className="text-[11px] font-bold uppercase tracking-wide text-muted">Token</p>
            <p className="tabular text-5xl font-black leading-none text-primary" data-testid="pickup-token">
              {o.pickupToken}
            </p>
          </div>
        ) : null}
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className={clsx("font-black tracking-tight", big ? "text-xl" : "text-3xl")}>{seatPart(o.seatLabel)}</span>
            <span className="text-xs font-semibold text-muted">{o.screenName}</span>
          </p>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5">
            <Badge tone={o.timing === "INTERVAL" ? "warning" : o.timing === "COUNTER" ? "info" : "primary"}>{TIMING_SHORT[o.timing]}</Badge>
            <span className={clsx("text-xs font-bold", o.stage === "READY" ? "text-secondary dark:text-green-300" : "text-muted")}>{stageLabel(o, now)}</span>
          </p>
        </div>
        <span className="tabular text-xs text-muted" title={`Ordered ${ageMin} min ago`}>
          <Clock size={12} className="mr-0.5 inline" />
          {ageMin}m
        </span>
      </div>
      {o.paid && o.stage === "WAITING" && o.releaseAt && (
        <p className="mx-3 mt-2 flex items-center gap-1.5 rounded-lg bg-amber-100 px-2 py-1 text-sm font-bold text-amber-900 dark:bg-amber-500/15 dark:text-amber-200" data-testid="release-countdown">
          <Hourglass size={16} />
          {new Date(o.releaseAt).getTime() > now ? (
            <>
              To kitchen in <span className="tabular">{countdown(o.releaseAt, now)}</span>
            </>
          ) : (
            "Going to the kitchen…"
          )}
        </p>
      )}
      <ul className="space-y-0.5 px-3 py-2">
        {o.items.map((it, i) => (
          <li key={i} className="text-[15px] font-semibold">
            <span className="tabular mr-1.5 text-primary">{it.quantity}×</span>
            {it.name}
            {it.notes && <span className="block pl-6 text-xs font-semibold text-red-600 dark:text-red-300">! {it.notes}</span>}
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2">
        <span className="text-sm font-bold tabular">{formatINR(o.total)}</span>
        {o.paid ? (
          <Badge tone="success">
            <CheckCircle size={12} weight="fill" /> Paid
          </Badge>
        ) : (
          <Badge tone="danger">Awaiting UPI</Badge>
        )}
        {!o.paid && canPay && o.orderId && (
          <Button size="sm" variant="outline" icon={<CurrencyInr size={16} />} loading={busy} onClick={() => onPaid(o)}>
            UPI received
          </Button>
        )}
        <span className="ml-auto" />
        {o.stage === "PREPARING" && (
          <Button size="sm" variant="secondary" loading={busy} onClick={() => onAct(o, "ready")}>
            Ready
          </Button>
        )}
        {o.stage === "READY" && (
          <Button size="sm" icon={<HandArrowDown size={16} />} loading={busy} onClick={() => onAct(o, "delivered")}>
            Delivered
          </Button>
        )}
        {o.paid && o.stage === "WAITING" && o.releaseAt && new Date(o.releaseAt).getTime() > now && <span className="text-xs text-muted">Kitchen gets it before the interval</span>}
      </div>
    </article>
  );
}
