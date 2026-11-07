"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import clsx from "clsx";
import { CheckCircle, Crosshair, HandCoins, MapPin, MapTrifold, Moped, NavigationArrow, Phone, Package, SealCheck, WarningOctagon, WhatsappLogo, X } from "@phosphor-icons/react";
import { formatINR, type DeliveryStatusValue } from "@canavo/shared";
import { ApiError, api, errorMessage } from "@/lib/api";
import type { Delivery } from "@/lib/types-service";
import type { DeliveryCompleteResult, DeliverySummary } from "@/lib/types-delivery";
import { useSession } from "@/components/providers/SessionProvider";
import { useSocketEvent } from "@/components/providers/SocketProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { useNow } from "@/hooks/useNow";
import { Badge } from "@/components/ui/Badge";
import { Button, IconButton } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Toggle } from "@/components/ui/Input";
import { ErrorState, LoadingState } from "@/components/ui/States";
import { EtaCountdown, IssueList, STATUS_LABEL, directionsLink, splitNotes } from "./common";
import { DeliveryPinMap } from "./map/DeliveryMap";
import { ReportIssueDialog } from "./partner/ReportIssueDialog";
import { OffDutyBanner, useDuty } from "./partner/duty";
import { RunStatusBanner, useRun } from "./partner/run";

/** Partner's status steps before the door: accept, then pick up (= out for delivery). */
const AGENT_NEXT: Partial<Record<DeliveryStatusValue, { to: DeliveryStatusValue; label: string }>> = {
  PENDING: { to: "ACCEPTED", label: "Accept" },
  ACCEPTED: { to: "OUT_FOR_DELIVERY", label: "Picked up — out for delivery" },
  PREPARING: { to: "OUT_FOR_DELIVERY", label: "Picked up — out for delivery" },
};

const STATUS_TONE: Partial<Record<DeliveryStatusValue, "info" | "primary" | "warning">> = {
  PENDING: "info",
  ACCEPTED: "primary",
  PREPARING: "primary",
  OUT_FOR_DELIVERY: "warning",
};

/** Cash collected → hand-over link shown after a delivery is completed. */
interface Done {
  invoice: string;
  customer: string;
  cash: number;
  waLink?: string;
  /** The delivered update already went to the customer through the WhatsApp provider */
  autoSent?: boolean;
}

/** Delivery partner portal: assigned runs by ETA with one big action each. No payment options — cash or already paid. */
export function MyDeliveries() {
  const toast = useToast();
  const run = useRun();
  const now = useNow(30_000);
  const [list, setList] = useState<Delivery[] | null>(null);
  const [summary, setSummary] = useState<DeliverySummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Delivery | null>(null);
  const [done, setDone] = useState<Done | null>(null);
  const [reporting, setReporting] = useState<Delivery | null>(null);
  const [sharing, setSharing] = useState(false);
  const watchId = useRef<number | null>(null);
  const lastSent = useRef(0);
  /** Sharing was switched on automatically at pick-up: a denied permission turns it off quietly */
  const autoShared = useRef(false);

  const load = useCallback(async () => {
    try {
      const [mine, sum] = await Promise.all([api.get<Delivery[]>("/delivery/mine", { query: { view: "active" } }), api.get<DeliverySummary>("/delivery/mine/summary").catch(() => null)]);
      setList(mine);
      if (sum) setSummary(sum);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), 60_000);
    return () => window.clearInterval(id);
  }, [load]);
  useSocketEvent("delivery:updated", () => void load());
  useSocketEvent("order:paid", () => void load());

  const outForDelivery = (list ?? []).filter((d) => d.status === "OUT_FOR_DELIVERY");

  // Live location while sharing: post at most every 20s for each run that's on the road.
  useEffect(() => {
    if (!sharing || typeof navigator === "undefined" || !navigator.geolocation) return;
    watchId.current = navigator.geolocation.watchPosition(
      (pos) => {
        if (Date.now() - lastSent.current < 20_000) return;
        lastSent.current = Date.now();
        for (const d of outForDelivery) {
          void api.post(`/delivery/${d.id}/location`, { lat: pos.coords.latitude, lng: pos.coords.longitude }).catch(() => undefined);
        }
      },
      () => {
        if (!autoShared.current) toast("Location permission denied", "error");
        autoShared.current = false;
        setSharing(false);
      },
      { enableHighAccuracy: true, maximumAge: 10_000 },
    );
    return () => {
      if (watchId.current !== null) navigator.geolocation.clearWatch(watchId.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sharing, outForDelivery.map((d) => d.id).join(",")]);

  const replace = (d: Delivery) => setList((l) => l?.map((x) => (x.id === d.id ? { ...x, ...d } : x)) ?? l);
  const remove = (id: string) => setList((l) => l?.filter((x) => x.id !== id) ?? l);

  const advance = async (d: Delivery, to: DeliveryStatusValue) => {
    setBusy(d.id);
    try {
      const res = await api.patch<Delivery>(`/delivery/${d.id}/status`, { status: to });
      replace(res);
      void run.reload();
      toast(`${res.order.invoiceNumber}: ${STATUS_LABEL[to]}${res.customerMessage?.autoSent ? " · Customer notified on WhatsApp" : ""}`, "success");
      if (to === "OUT_FOR_DELIVERY" && !sharing && typeof navigator !== "undefined" && navigator.geolocation) {
        autoShared.current = true;
        setSharing(true);
      }
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(null);
    }
  };

  /** One tap at the door: cash collected (amount due) or simply delivered (already paid). Throws so the confirm dialog can show it. */
  const complete = async (d: Delivery) => {
    const due = d.amountDue ?? 0;
    setBusy(d.id);
    try {
      const res = await api.post<DeliveryCompleteResult>(`/delivery/${d.id}/complete`, { cashCollected: due });
      remove(d.id);
      void run.reload();
      setDone({ invoice: res.order.invoiceNumber, customer: d.customerName, cash: res.cashCollected, waLink: res.customerMessage?.waLink, autoSent: !!res.customerMessage?.autoSent });
      toast(res.cashCollected > 0 ? `${res.order.invoiceNumber} delivered · ${formatINR(res.cashCollected)} cash collected` : `${res.order.invoiceNumber} delivered`, "success");
      void load();
    } catch (e) {
      // 409: the amount due changed (customer paid online, bill edited…) — refresh so the card shows the new amount.
      if (e instanceof ApiError && e.status === 409) void load();
      throw new Error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  if (!list) return error ? <ErrorState message={error} onRetry={load} /> : <LoadingState label="Loading your deliveries…" />;

  const confirmDue = confirming?.amountDue ?? 0;

  return (
    <div className="mx-auto max-w-2xl space-y-3">
      <OffDutyBanner />
      <RunStatusBanner />
      {done && <DoneBanner done={done} onClose={() => setDone(null)} />}
      <TodayStrip summary={summary} />
      {list.length > 0 && typeof navigator !== "undefined" && "geolocation" in navigator && (
        <div className="rounded-2xl border border-line bg-surface px-4 py-1">
          <Toggle
            checked={sharing}
            onChange={(v) => {
              autoShared.current = false;
              setSharing(v);
            }}
            label={
              <span className="flex items-center gap-1.5">
                <Crosshair size={18} /> Share live location
              </span>
            }
            description="Sent to the outlet while you're out for delivery"
          />
        </div>
      )}
      {error && <ErrorState message={error} onRetry={load} />}
      {list.length === 0 ? (
        <NoDeliveries />
      ) : (
        list.map((d) => (
          <DeliveryCard
            key={d.id}
            d={d}
            now={now}
            busy={busy === d.id}
            onAdvance={(to) => void advance(d, to)}
            onComplete={() => {
              if ((d.amountDue ?? 0) > 0) setConfirming(d);
              else void complete(d).catch((e: unknown) => toast(errorMessage(e), "error"));
            }}
            onReport={() => setReporting(d)}
          />
        ))
      )}

      <ConfirmDialog
        open={!!confirming}
        tone="primary"
        title={confirming ? `Did you collect ${formatINR(confirmDue)} cash from ${confirming.customerName}?` : ""}
        description="Confirm only when the cash is in your hand. It's added to your cash to hand over."
        confirmLabel="Yes — cash collected & delivered"
        onClose={() => setConfirming(null)}
        onConfirm={async () => {
          if (confirming) await complete(confirming);
        }}
      />
      <ReportIssueDialog
        delivery={reporting}
        onClose={() => setReporting(null)}
        onReported={(res) => {
          setReporting(null);
          replace(res);
          toast("Outlet notified — they'll call you", "success");
        }}
      />
    </div>
  );
}

function DeliveryCard({
  d,
  now,
  busy,
  onAdvance,
  onComplete,
  onReport,
}: {
  d: Delivery;
  now: number;
  busy: boolean;
  onAdvance: (to: DeliveryStatusValue) => void;
  onComplete: () => void;
  onReport: () => void;
}) {
  const next = AGENT_NEXT[d.status];
  const atDoor = d.status === "OUT_FOR_DELIVERY";
  const due = d.amountDue ?? 0;
  const { issues, other } = splitNotes(d.notes);
  const btn = "flex min-h-[52px] items-center justify-center gap-2 rounded-xl border border-line px-3 font-semibold hover:bg-surface-2 active:bg-surface-2";
  const { outlet } = useSession();
  const [showMap, setShowMap] = useState(false);
  const pin = d.latitude != null && d.longitude != null ? { lat: d.latitude, lng: d.longitude } : null;
  return (
    <article className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm" data-testid="partner-delivery" data-invoice={d.order.invoiceNumber}>
      <header className="flex flex-wrap items-center gap-2 border-b border-line bg-surface-2 px-4 py-2.5">
        <Badge tone={STATUS_TONE[d.status] ?? "neutral"}>{STATUS_LABEL[d.status]}</Badge>
        <strong className="font-mono text-base">{d.order.invoiceNumber}</strong>
        {d.cod && (
          <Badge tone="warning">
            <HandCoins size={14} weight="fill" aria-hidden /> COD
          </Badge>
        )}
        <span className="ml-auto">
          <EtaCountdown etaAt={d.etaAt} now={now} className="!px-2 !py-1 !text-sm" />
        </span>
      </header>

      <div className="space-y-3 px-4 py-3">
        {/* Money first: the one thing the partner must not get wrong */}
        {due > 0 ? (
          <div
            className="rounded-xl border-2 border-amber-400 bg-amber-50 px-3 py-2.5 text-amber-900 dark:border-amber-500/60 dark:bg-amber-500/15 dark:text-amber-100"
            data-testid="cod-collect-badge"
          >
            <p className="tabular flex items-center gap-2 text-2xl font-extrabold leading-tight">
              <HandCoins size={30} weight="fill" className="shrink-0" />
              Collect {formatINR(due)} cash
            </p>
            {(d.amountPaid ?? 0) > 0 && <p className="mt-0.5 text-sm font-semibold">{formatINR(d.amountPaid ?? 0)} already paid · collect only the balance</p>}
          </div>
        ) : (
          <p className="flex items-center gap-2 rounded-xl bg-secondary-50 px-3 py-2.5 text-xl font-extrabold text-secondary-700 dark:bg-secondary/25 dark:text-green-200" data-testid="prepaid-badge">
            <SealCheck size={26} weight="fill" /> PAID ✓ <span className="text-sm font-semibold">nothing to collect</span>
          </p>
        )}

        <div className="flex items-center gap-3">
          <p className="min-w-0 flex-1 truncate text-lg font-bold">{d.customerName}</p>
          <a href={`tel:${d.customerPhone}`} className={clsx(btn, "shrink-0 border-secondary text-secondary dark:text-green-300")} aria-label={`Call ${d.customerName}`}>
            <Phone size={22} weight="fill" /> Call
          </a>
        </div>

        <div className="flex items-start gap-3">
          <p className="flex min-w-0 flex-1 items-start gap-1.5">
            <MapPin size={20} className="mt-0.5 shrink-0 text-primary" weight="fill" />
            <span className="min-w-0">
              <span className="block">{d.address}</span>
              {d.landmark && <span className="block text-sm text-muted">Near {d.landmark}</span>}
              {d.distanceKm != null && <span className="block text-sm font-semibold text-muted">{d.distanceKm} km from outlet</span>}
            </span>
          </p>
          <a href={directionsLink(d)} target="_blank" rel="noreferrer" className={clsx(btn, "shrink-0 border-sky-500 text-sky-700 dark:text-sky-300")}>
            <NavigationArrow size={22} weight="fill" /> Navigate
          </a>
        </div>
        {pin && (
          <div>
            <button type="button" onClick={() => setShowMap((v) => !v)} aria-expanded={showMap} className="flex items-center gap-1.5 text-sm font-semibold text-sky-700 hover:underline dark:text-sky-300">
              <MapTrifold size={18} /> {showMap ? "Hide map" : "Show exact spot on map"}
            </button>
            {showMap && (
              <div className="mt-2">
                <DeliveryPinMap pin={pin} outlet={outlet?.latitude != null && outlet?.longitude != null ? { lat: outlet.latitude, lng: outlet.longitude } : null} height={200} />
              </div>
            )}
          </div>
        )}

        {d.order.items && d.order.items.length > 0 && (
          <ul className="space-y-1 rounded-xl bg-surface-2 px-3 py-2 text-sm" aria-label="Items">
            {d.order.items.map((i, idx) => (
              <li key={idx}>
                <span className="font-semibold">
                  {i.quantity}× {i.name}
                </span>
                {i.notes && <span className="block text-xs text-amber-800 dark:text-amber-300">Kitchen note: {i.notes}</span>}
              </li>
            ))}
          </ul>
        )}
        {d.order.notes && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm dark:bg-amber-500/10">Order note: {d.order.notes}</p>}
        {other.length > 0 && <p className="whitespace-pre-line rounded-lg bg-amber-50 px-3 py-2 text-sm dark:bg-amber-500/10">{other.join("\n")}</p>}
        <IssueList issues={issues} />

        {atDoor ? (
          <Button size="lg" block variant="secondary" className="!min-h-[64px] text-xl" loading={busy} onClick={onComplete} data-testid="complete-delivery">
            <CheckCircle size={26} weight="fill" />
            {due > 0 ? "Cash collected & delivered" : "Delivered"}
          </Button>
        ) : (
          next && (
            <Button size="lg" block variant="primary" className="!min-h-[64px] text-xl" loading={busy} onClick={() => onAdvance(next.to)}>
              {next.to === "OUT_FOR_DELIVERY" ? <Package size={26} /> : <Moped size={26} />}
              {next.label}
            </Button>
          )
        )}
        <div className="grid grid-cols-2 gap-2">
          <a href={`https://wa.me/91${d.customerPhone}`} target="_blank" rel="noreferrer" className={btn}>
            <WhatsappLogo size={20} /> WhatsApp
          </a>
          <button type="button" onClick={onReport} className={clsx(btn, "text-red-700 dark:text-red-300")}>
            <WarningOctagon size={20} /> Report a problem
          </button>
        </div>
      </div>
    </article>
  );
}

/** Just delivered: what happened to the cash + the WhatsApp status update for the customer. */
function DoneBanner({ done, onClose }: { done: Done; onClose: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-secondary/40 bg-secondary-50 px-4 py-3 dark:bg-secondary/20" role="status" data-testid="delivered-banner">
      <CheckCircle size={28} weight="fill" className="mt-0.5 shrink-0 text-secondary dark:text-green-300" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <p className="font-bold">
          {done.invoice} delivered to {done.customer}
        </p>
        {done.cash > 0 && (
          <p className="text-sm font-semibold">
            {formatINR(done.cash)} cash added to your{" "}
            <Link href="/delivery/cash" className="text-primary underline">
              cash to hand over
            </Link>
          </p>
        )}
        {done.autoSent ? (
          <p className="flex items-center gap-1.5 text-sm font-semibold text-green-700 dark:text-green-300" data-testid="wa-auto-sent">
            <WhatsappLogo size={18} weight="fill" /> Customer notified on WhatsApp
          </p>
        ) : done.waLink && (
          <a
            href={done.waLink}
            target="_blank"
            rel="noreferrer"
            className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-green-600 px-4 text-sm font-bold text-white hover:bg-green-700"
            data-testid="wa-status-link"
          >
            <WhatsappLogo size={20} weight="fill" /> Send delivered update on WhatsApp
          </a>
        )}
      </div>
      <IconButton label="Dismiss" onClick={onClose} className="-mr-2 -mt-1">
        <X size={20} />
      </IconButton>
    </div>
  );
}

/** Today at a glance; "Cash in hand" opens the Cash handover page. */
function TodayStrip({ summary }: { summary: DeliverySummary | null }) {
  if (!summary) return null;
  const cod = summary.codToCollect ?? 0;
  const cell = "block px-2 py-2.5 text-center hover:bg-surface-2";
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-surface shadow-sm">
      {cod > 0 && (
        <p className="flex flex-wrap items-center gap-x-2 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm font-bold text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/15 dark:text-amber-100">
          <HandCoins size={18} weight="fill" /> Cash to collect on your runs: <span className="tabular">{formatINR(cod)}</span>
          <span className="font-semibold">
            · {summary.codOrders ?? 0} order{summary.codOrders === 1 ? "" : "s"}
          </span>
        </p>
      )}
      <div className="grid grid-cols-3 divide-x divide-line">
        <Link href="/delivery/dashboard" className={cell}>
          <span className="block text-xs font-semibold text-muted">Delivered today</span>
          <span className="tabular text-lg font-extrabold">{summary.delivered}</span>
        </Link>
        <Link href="/delivery/dashboard" className={cell}>
          <span className="block text-xs font-semibold text-muted">Cash collected</span>
          <span className="tabular text-lg font-extrabold">{formatINR(summary.collected.cash)}</span>
        </Link>
        <Link href="/delivery/cash" className={cell} data-testid="today-cash-in-hand">
          <span className="block text-xs font-semibold text-muted">Cash in hand</span>
          <span className={clsx("tabular text-lg font-extrabold", summary.cashInHand > 0 && "text-primary-700 dark:text-primary-200")}>{formatINR(summary.cashInHand)}</span>
        </Link>
      </div>
    </div>
  );
}

function NoDeliveries() {
  const duty = useDuty();
  const on = duty.status?.clockedIn;
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl border border-dashed border-line px-6 py-12 text-center" data-testid="no-deliveries">
      <span className="flex h-16 w-16 items-center justify-center rounded-full bg-surface-2 text-muted">
        <Moped size={36} weight="duotone" />
      </span>
      <p className="text-lg font-bold">No deliveries assigned</p>
      <p className="max-w-sm text-sm text-muted">You&apos;ll be notified when a new order is assigned to you.</p>
      {duty.available && on && <Badge tone="success">On duty</Badge>}
    </div>
  );
}
