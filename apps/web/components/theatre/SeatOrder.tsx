"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { QRCodeSVG } from "qrcode.react";
import { ArrowLeft, Armchair, CheckCircle, Clock, CookingPot, FilmSlate, Hourglass, Storefront, XCircle } from "@phosphor-icons/react";
import { formatINR, SEAT_TIMING_LABELS, type SeatTiming } from "@canavo/shared";
import { errorMessage } from "@/lib/api";
import { publicCall } from "@/lib/storefront";
import { clock, guestStage, minutesUntil, type GuestStage, type SeatInfo, type SeatOrder, type SeatOrderPlaced, type SeatTablePage, type SeatUpi } from "@/lib/theatre";
import { useNow } from "@/hooks/useNow";
import { CartBar, CartLines, EmptyCart, StoreMenu, useCart } from "@/components/storefront/StoreMenu";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Alert } from "@/components/ui/States";

type Step = "menu" | "cart" | "timing" | "pay" | "track";

/** UPI details of orders placed from this phone, so the QR can be reopened until it's paid. */
interface SavedPay {
  key: string;
  upi: SeatUpi;
  timing: SeatTiming;
  pickupToken: number | null;
  at: number;
}
const payKey = (token: string) => `canavo.seatpay.${token}`;
function readPays(token: string): SavedPay[] {
  try {
    const list = JSON.parse(localStorage.getItem(payKey(token)) ?? "[]") as SavedPay[];
    return list.filter((p) => Date.now() - p.at < 6 * 3600_000);
  } catch {
    return [];
  }
}
function writePays(token: string, list: SavedPay[]) {
  try {
    localStorage.setItem(payKey(token), JSON.stringify(list.slice(-10)));
  } catch {
    /* ignore */
  }
}
const orderKey = (o: SeatOrder) => o.token ?? o.publicToken ?? o.id;

const TIMING_HINT: Record<SeatTiming, string> = {
  NOW: "A runner brings it to your seat as soon as it's ready.",
  INTERVAL: "Ready and brought to your seat when the interval starts.",
  COUNTER: "We give you a token number. Collect it at the food counter.",
};
const TIMING_ICON: Record<SeatTiming, React.ReactNode> = {
  NOW: <Armchair size={28} weight="duotone" />,
  INTERVAL: <Hourglass size={28} weight="duotone" />,
  COUNTER: <Storefront size={28} weight="duotone" />,
};

const STAGE_TEXT: Record<GuestStage, (o: SeatOrder) => { title: string; hint: string }> = {
  PAYMENT: () => ({ title: "Waiting for your payment", hint: "Pay by UPI to send your order to the kitchen. We check automatically." }),
  WAITING: (o) => ({ title: "Booked for the interval", hint: o.releaseAt ? `The kitchen starts it at ${clock(o.releaseAt)}, so it's ready for the interval.` : "The kitchen starts it shortly before the interval." }),
  PREPARING: () => ({ title: "Being prepared", hint: "The kitchen has your order." }),
  READY: (o) =>
    o.timing === "COUNTER" ? { title: "Ready — collect at the counter", hint: "Show your token number at the food counter." } : { title: "On its way to your seat", hint: "A runner is bringing it now." },
  DELIVERED: (o) => ({ title: o.timing === "COUNTER" ? "Collected" : "Delivered", hint: "Enjoy the movie!" }),
  CANCELLED: (o) => ({ title: "Order not accepted", hint: o.rejectReason ?? "Any payment is refunded by the cinema." }),
};

/** Why a timing can't be chosen right now (null = available). */
function timingReason(t: SeatTiming, info: SeatInfo): string | null {
  if (t === "NOW") return info.options.now ? null : "Not offered during this show here — choose the interval or the counter.";
  if (t === "INTERVAL") {
    if (info.options.interval) return null;
    if (!info.show?.intervalAt) return "This show has no interval.";
    return `Too late for the interval — the kitchen needs ${info.settings.intervalLeadMin} minutes before it.`;
  }
  return info.options.counter ? null : "Counter pickup isn't available right now.";
}

/**
 * Seat variant of the table QR page (/t/<seat token>): dark, dim and quiet for a cinema hall.
 * Menu → cart → when (now / interval / counter) → UPI → tracking. No toasts, sounds or vibration:
 * every message is inline.
 */
export function SeatOrderView({ token, page, onReload }: { token: string; page: SeatTablePage; onReload: () => Promise<void> }) {
  const info = page.theatre!;
  const show = info.show;
  const now = useNow(15_000);
  const cart = useCart(`canavo.seatcart.${token}`);
  const { prune } = cart;
  const [step, setStep] = useState<Step>("menu");
  const [orders, setOrders] = useState<SeatOrder[]>([]);
  const [pays, setPays] = useState<SavedPay[]>([]);
  const [payFor, setPayFor] = useState<string | null>(null);
  const [timing, setTiming] = useState<SeatTiming | null>(null);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [notes, setNotes] = useState("");
  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canOrder = page.ordering && Boolean(show?.orderingOpen);
  const closedLabel = !page.ordering ? (page.notice ?? "Seat ordering is off right now") : (show?.reason ?? "No show on this screen now");

  useEffect(() => setPays(readPays(token)), [token]);
  useEffect(() => {
    prune(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);
  const loadOrders = useCallback(async () => {
    try {
      setOrders(await publicCall<SeatOrder[]>("GET", `/public/t/${token}/orders`));
    } catch {
      /* keep the last list */
    }
  }, [token]);
  useEffect(() => {
    void loadOrders();
  }, [loadOrders]);
  const stages = useMemo(() => orders.map((o) => ({ o, stage: guestStage(o) })), [orders]);
  const unpaid = stages.some((s) => s.stage === "PAYMENT");
  const active = stages.some((s) => !["DELIVERED", "CANCELLED"].includes(s.stage));
  // Poll quietly: faster while a payment or an order is on its way; only when the page is visible.
  useEffect(() => {
    const id = window.setInterval(() => document.visibilityState === "visible" && void loadOrders(), unpaid ? 4_000 : active ? 8_000 : 30_000);
    return () => window.clearInterval(id);
  }, [loadOrders, unpaid, active]);
  useEffect(() => {
    const id = window.setInterval(() => document.visibilityState === "visible" && void onReload(), 120_000);
    return () => window.clearInterval(id);
  }, [onReload]);
  useEffect(() => {
    if ((step === "cart" || step === "timing") && cart.count === 0) setStep("menu");
  }, [cart.count, step]);
  // The payment went through while the QR was open: straight to tracking.
  const paying = payFor ? stages.find((s) => orderKey(s.o) === payFor) : undefined;
  useEffect(() => {
    if (step === "pay" && paying && paying.stage !== "PAYMENT") setStep("track");
  }, [step, paying]);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [step]);
  // A chosen timing that stopped being offered (interval passed, …) is cleared.
  useEffect(() => {
    if (timing && timingReason(timing, info)) setTiming(null);
  }, [timing, info]);

  const phoneBad = phone.trim() !== "" && !/^[6-9]\d{9}$/.test(phone.trim());
  const tax =
    page.outlet.gstEnabled && !page.outlet.pricesIncludeTax
      ? Math.round(cart.lines.reduce((s, l) => s + (l.unitPrice * l.quantity * (page.items.find((i) => i.id === l.menuItemId)?.gstRate ?? 0)) / 100, 0))
      : 0;

  const place = async () => {
    if (!timing) return;
    setPlacing(true);
    setError(null);
    try {
      const r = await publicCall<SeatOrderPlaced>("POST", `/public/t/${token}/orders`, {
        items: cart.lines.map((l) => ({ menuItemId: l.menuItemId, variantId: l.variantId, addonIds: l.addonIds, quantity: l.quantity, notes: l.notes?.trim() || undefined })),
        notes: notes.trim() || undefined,
        customerName: name.trim() || undefined,
        customerPhone: phone.trim() || undefined,
        timing,
      });
      const key = r.token ?? r.id ?? `local-${Date.now()}`;
      if (r.upi) {
        const next = [...readPays(token), { key, upi: r.upi, timing: r.timing ?? timing, pickupToken: r.pickupToken ?? null, at: Date.now() }];
        writePays(token, next);
        setPays(next);
      }
      cart.clear();
      setNotes("");
      setPayFor(key);
      setStep(r.upi ? "pay" : "track");
      void loadOrders();
    } catch (e) {
      setError(errorMessage(e));
      void onReload();
    } finally {
      setPlacing(false);
    }
  };

  const latest = stages[0];
  const payInfo = payFor ? pays.find((p) => p.key === payFor) : undefined;
  const openPay = (o: SeatOrder) => {
    setPayFor(orderKey(o));
    setStep("pay");
  };
  const payFallback = (o: SeatOrder) => o.upi ?? pays.find((p) => p.key === orderKey(o))?.upi;
  const payUpi = payInfo?.upi ?? paying?.o.upi ?? null;
  /** The first UPI QR expired: ask for a fresh one (same order). */
  const renewUpi = async (key: string) => {
    const upi = await publicCall<SeatUpi>("POST", `/public/t/${token}/orders/${key}/upi`);
    const list = readPays(token);
    const old = list.find((p) => p.key === key);
    const next = old ? list.map((p) => (p.key === key ? { ...p, upi, at: Date.now() } : p)) : [...list, { key, upi, timing: paying?.o.timing ?? "NOW", pickupToken: paying?.o.pickupToken ?? null, at: Date.now() }];
    writePays(token, next);
    setPays(next);
  };

  return (
    <main className="min-h-screen bg-bg pb-28 text-fg" data-testid="seat-page">
      <SeatHeader page={page} info={info} now={now} />

      {step === "menu" && (
        <div className="mx-auto max-w-2xl px-4">
          {!canOrder && <p className="mt-3 rounded-2xl border border-line bg-surface p-3 text-sm text-fg">{closedLabel}</p>}
          {stages.length > 0 && (
            <section aria-label="Your orders" className="mt-3 space-y-2">
              {stages.slice(0, 3).map(({ o, stage }) => (
                <OrderStrip key={o.id} order={o} stage={stage} onPay={payFallback(o) ? () => openPay(o) : undefined} onOpen={() => {
                  setPayFor(orderKey(o));
                  setStep("track");
                }} />
              ))}
            </section>
          )}
          <StoreMenu menu={page} brand={page.outlet} cart={cart} canOrder={canOrder} closedLabel={canOrder ? "" : "Ordering closed"} />
          {canOrder && <CartBar cart={cart} onOpen={() => setStep("cart")} label="Next" />}
          {canOrder && cart.count > 0 && (
            <div className="sticky bottom-4 hidden justify-end lg:flex">
              <Button size="lg" onClick={() => setStep("cart")}>
                {cart.count} item{cart.count === 1 ? "" : "s"} · {formatINR(cart.total)} — Next
              </Button>
            </div>
          )}
        </div>
      )}

      {step === "cart" && (
        <StepShell title="Your order" onBack={() => setStep("menu")}>
          {cart.count === 0 ? (
            <EmptyCart onBrowse={() => setStep("menu")} />
          ) : (
            <div className="space-y-4">
              <CartLines cart={cart} menu={page} />
              <Input label="Anything else?" placeholder="e.g. less spicy, extra napkins" maxLength={200} value={notes} onChange={(e) => setNotes(e.target.value)} />
              <div className="grid grid-cols-2 gap-3">
                <Input label="Name (optional)" autoComplete="name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
                <Input
                  label="Phone (optional)"
                  inputMode="numeric"
                  autoComplete="tel-national"
                  maxLength={10}
                  value={phone}
                  onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))}
                  error={phoneBad ? "10-digit mobile number" : null}
                />
              </div>
              <dl className="space-y-1 rounded-2xl border border-line bg-surface p-4 text-sm">
                <div className="flex justify-between">
                  <dt className="text-muted">Item total</dt>
                  <dd className="tabular-nums">{formatINR(cart.total)}</dd>
                </div>
                {tax > 0 && (
                  <div className="flex justify-between">
                    <dt className="text-muted">GST (estimated)</dt>
                    <dd className="tabular-nums">{formatINR(tax)}</dd>
                  </div>
                )}
                <div className="flex justify-between border-t border-dashed border-line pt-1.5 text-base font-extrabold">
                  <dt>To pay</dt>
                  <dd className="tabular-nums">{formatINR(cart.total + tax)}</dd>
                </div>
              </dl>
              <BottomBar>
                <Button block size="lg" disabled={phoneBad} onClick={() => setStep("timing")}>
                  Next: when do you want it?
                </Button>
              </BottomBar>
            </div>
          )}
        </StepShell>
      )}

      {step === "timing" && (
        <StepShell title="When do you want it?" onBack={() => setStep("cart")}>
          <div className="space-y-3" role="radiogroup" aria-label="When do you want it?" data-testid="timing-options">
            {(["NOW", "INTERVAL", "COUNTER"] as SeatTiming[]).map((t) => {
              const why = timingReason(t, info);
              const on = timing === t;
              return (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-disabled={!!why}
                  disabled={!!why}
                  onClick={() => setTiming(t)}
                  data-timing={t}
                  className={clsx(
                    "flex min-h-[88px] w-full items-start gap-4 rounded-2xl border-2 p-4 text-left",
                    why ? "cursor-not-allowed border-line bg-surface opacity-60" : on ? "border-primary bg-primary-50" : "border-line bg-surface active:bg-surface-2",
                  )}
                >
                  <span className={clsx("mt-0.5 shrink-0", on ? "text-primary" : "text-muted")}>{TIMING_ICON[t]}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-lg font-bold">{SEAT_TIMING_LABELS[t]}</span>
                    <span className="block text-sm text-muted">
                      {why ?? (t === "INTERVAL" && show?.intervalAt ? `Interval at ${clock(show.intervalAt)}. ${TIMING_HINT[t]}` : TIMING_HINT[t])}
                    </span>
                  </span>
                  <span className={clsx("mt-1 h-6 w-6 shrink-0 rounded-full border-2", on ? "border-primary bg-primary shadow-[inset_0_0_0_4px_rgb(var(--surface))]" : "border-line")} aria-hidden />
                </button>
              );
            })}
          </div>
          <p className="mt-4 text-sm text-muted">You pay now by UPI. The order goes to the kitchen once the payment is confirmed.</p>
          {error && (
            <div className="mt-3">
              <Alert>{error}</Alert>
            </div>
          )}
          <BottomBar>
            <Button block size="lg" disabled={!timing || !canOrder} loading={placing} onClick={() => void place()}>
              {timing ? `Pay ${formatINR(cart.total + tax)} by UPI` : "Choose when you want it"}
            </Button>
          </BottomBar>
        </StepShell>
      )}

      {step === "pay" && (
        <StepShell title="Pay by UPI" onBack={() => setStep("menu")}>
          {payUpi ? (
            <UpiPay
              upi={payUpi}
              timing={payInfo?.timing ?? paying?.o.timing ?? "NOW"}
              pickupToken={payInfo?.pickupToken ?? paying?.o.pickupToken ?? null}
              onRenew={payFor && !payFor.startsWith("local-") ? () => renewUpi(payFor) : undefined}
              onDone={() => setStep("track")}
            />
          ) : (
            <p className="rounded-2xl bg-surface p-4 text-sm text-muted">This payment can only be reopened on the phone that placed the order. Please ask a staff member for help.</p>
          )}
        </StepShell>
      )}

      {step === "track" && (
        <StepShell title="Your order" onBack={() => setStep("menu")}>
          {(() => {
            const sel = (payFor && stages.find((s) => orderKey(s.o) === payFor)) || latest;
            if (!sel) return <p className="rounded-2xl bg-surface p-4 text-sm text-muted">Sending your order…</p>;
            return <Tracker order={sel.o} stage={sel.stage} pay={pays.find((p) => p.key === orderKey(sel.o))} onPay={payFallback(sel.o) ? () => openPay(sel.o) : undefined} />;
          })()}
          <BottomBar>
            <Button block size="lg" variant="outline" onClick={() => setStep("menu")}>
              Order something else
            </Button>
          </BottomBar>
        </StepShell>
      )}
    </main>
  );
}

function SeatHeader({ page, info, now }: { page: SeatTablePage; info: SeatInfo; now: number }) {
  const show = info.show;
  const closesIn = show && show.orderingOpen ? new Date(show.closesAt).getTime() - now : null;
  return (
    <header className="border-b border-line bg-surface">
      <div className="mx-auto max-w-2xl px-4 py-3">
        <p className="truncate text-xs font-semibold uppercase tracking-wider text-muted">{page.outlet.name}</p>
        <p className="mt-0.5 flex items-center gap-2 text-2xl font-black tracking-tight" data-testid="seat-banner">
          <Armchair size={24} weight="duotone" className="text-primary" aria-hidden />
          {info.seat.screenName} · {info.seat.row}
          {info.seat.seatNumber}
        </p>
        {show ? (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm" data-testid="show-strip">
            <span className="inline-flex min-w-0 items-center gap-1.5 font-semibold">
              <FilmSlate size={16} className="shrink-0 text-muted" aria-hidden />
              <span className="truncate">{show.title}</span>
            </span>
            {closesIn !== null && closesIn > 0 ? (
              <span className={clsx("inline-flex items-center gap-1", closesIn < 10 * 60_000 ? "font-bold text-primary" : "text-muted")}>
                <Clock size={14} aria-hidden /> Ordering closes in {minutesUntil(show.closesAt, now)}
              </span>
            ) : (
              <span className="text-muted">{show.reason ?? "Ordering closed"}</span>
            )}
            {show.status === "INTERVAL" ? (
              <span className="text-muted">Interval now</span>
            ) : (
              show.intervalAt &&
              new Date(show.intervalAt).getTime() > now && (
                <span className="inline-flex items-center gap-1 text-muted">
                  <Hourglass size={14} aria-hidden /> Interval {clock(show.intervalAt)}
                </span>
              )
            )}
          </div>
        ) : (
          <p className="mt-1 text-sm text-muted">No show on this screen now</p>
        )}
      </div>
    </header>
  );
}

function StepShell({ title, onBack, children }: { title: string; onBack: () => void; children: React.ReactNode }) {
  return (
    <section className="mx-auto max-w-2xl px-4 pt-2">
      <div className="flex items-center gap-1">
        <button type="button" onClick={onBack} className="-ml-3 flex h-12 w-12 items-center justify-center rounded-full text-fg active:bg-surface-2" aria-label="Back">
          <ArrowLeft size={22} />
        </button>
        <h1 className="text-xl font-extrabold">{title}</h1>
      </div>
      <div className="pt-2">{children}</div>
    </section>
  );
}

function BottomBar({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg px-4 pt-3" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
      <div className="mx-auto max-w-2xl">{children}</div>
    </div>
  );
}

function UpiPay({ upi, timing, pickupToken, onRenew, onDone }: { upi: SeatUpi; timing: SeatTiming; pickupToken: number | null; onRenew?: () => Promise<void>; onDone: () => void }) {
  const isLink = upi.qrPayload.startsWith("upi://");
  const [renewing, setRenewing] = useState(false);
  const [renewError, setRenewError] = useState<string | null>(null);
  const renew = async () => {
    if (!onRenew) return;
    setRenewing(true);
    setRenewError(null);
    try {
      await onRenew();
    } catch (e) {
      setRenewError(errorMessage(e));
    } finally {
      setRenewing(false);
    }
  };
  return (
    <div className="space-y-4 text-center" data-testid="upi-pay">
      <div>
        <p className="text-sm text-muted">Amount</p>
        <p className="text-4xl font-black tabular-nums">{formatINR(upi.amount)}</p>
        <p className="mt-1 text-sm text-muted">{SEAT_TIMING_LABELS[timing]}</p>
      </div>
      {isLink && (
        <a href={upi.qrPayload} className="flex min-h-[56px] w-full items-center justify-center rounded-2xl bg-primary text-lg font-extrabold text-primary-fg">
          Pay with a UPI app on this phone
        </a>
      )}
      <div className="rounded-2xl border border-line bg-surface p-4">
        <p className="mb-3 text-sm text-muted">Or scan with another phone</p>
        {/* A dark-mode QR is hard to scan: keep it on a dim (not white-hot) light panel. */}
        <div className="mx-auto w-fit rounded-xl bg-neutral-300 p-3">
          {isLink ? (
            <QRCodeSVG value={upi.qrPayload} size={184} bgColor="#d4d4d4" fgColor="#000000" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={upi.imageUrl ?? upi.qrPayload} alt="UPI QR code" className="h-48 w-48" />
          )}
        </div>
        {upi.mock && <p className="mt-2 text-xs text-muted">Test mode: staff confirm this payment on the runner board.</p>}
        {onRenew && (
          <Button variant="ghost" size="sm" className="mt-2" loading={renewing} onClick={() => void renew()}>
            QR expired? Get a new one
          </Button>
        )}
        {renewError && <p className="mt-1 text-sm text-red-400">{renewError}</p>}
      </div>
      {pickupToken != null && (
        <p className="text-sm text-muted">
          Your counter token: <strong className="text-2xl text-fg">#{pickupToken}</strong>
        </p>
      )}
      <p className="text-sm text-muted">After paying, come back here — we check the payment automatically.</p>
      <BottomBar>
        <Button block size="lg" variant="outline" onClick={onDone}>
          I&apos;ve paid — track my order
        </Button>
      </BottomBar>
    </div>
  );
}

function stageIcon(stage: GuestStage) {
  if (stage === "CANCELLED") return <XCircle size={30} weight="fill" className="text-red-400" />;
  if (stage === "READY" || stage === "DELIVERED") return <CheckCircle size={30} weight="fill" className="text-green-400/80" />;
  if (stage === "WAITING") return <Hourglass size={30} weight="duotone" className="text-primary" />;
  if (stage === "PAYMENT") return <Clock size={30} weight="duotone" className="text-primary" />;
  return <CookingPot size={30} weight="duotone" className="text-primary" />;
}

const STEPS: { stage: GuestStage; label: string }[] = [
  { stage: "PAYMENT", label: "Paid" },
  { stage: "PREPARING", label: "Kitchen" },
  { stage: "READY", label: "Ready" },
  { stage: "DELIVERED", label: "Done" },
];
const STEP_INDEX: Record<GuestStage, number> = { PAYMENT: 0, WAITING: 1, PREPARING: 1, READY: 2, DELIVERED: 3, CANCELLED: -1 };

function Tracker({ order: o, stage, pay, onPay }: { order: SeatOrder; stage: GuestStage; pay?: SavedPay; onPay?: () => void }) {
  const text = STAGE_TEXT[stage](o);
  const token = o.pickupToken ?? pay?.pickupToken ?? null;
  const timing = o.timing ?? pay?.timing ?? null;
  const at = STEP_INDEX[stage];
  return (
    <div className="space-y-4" data-testid="seat-tracker" data-stage={stage}>
      {timing === "COUNTER" && token != null && (
        <div className="rounded-3xl border border-line bg-surface p-5 text-center">
          <p className="text-sm font-semibold uppercase tracking-widest text-muted">Your token</p>
          <p className="text-[96px] font-black leading-none tabular-nums text-primary" data-testid="guest-token">
            {token}
          </p>
          <p className="mt-1 text-sm text-muted">Show this number at the food counter</p>
        </div>
      )}
      <div className="rounded-3xl border border-line bg-surface p-5" aria-live="polite">
        <div className="flex items-start gap-3">
          {stageIcon(stage)}
          <div>
            <p className="text-xl font-extrabold" data-testid="seat-stage">
              {text.title}
            </p>
            <p className="text-sm text-muted">{text.hint}</p>
          </div>
        </div>
        {at >= 0 && (
          <ol className="mt-5 grid grid-cols-4 gap-1.5" aria-label="Progress">
            {STEPS.map((s, i) => (
              <li key={s.stage} className="text-center">
                <span className={clsx("block h-1.5 rounded-full", i < at || (i === at && stage === "DELIVERED") ? "bg-primary" : i === at ? "bg-primary/50" : "bg-surface-2")} />
                <span className={clsx("mt-1 block text-[11px] font-semibold", i <= at ? "text-fg" : "text-muted")}>{i === 1 && stage === "WAITING" ? "Interval" : s.label}</span>
              </li>
            ))}
          </ol>
        )}
        {stage === "PAYMENT" && onPay && (
          <Button block size="lg" className="mt-4" onClick={onPay}>
            Pay now
          </Button>
        )}
      </div>
      <div className="rounded-2xl border border-line bg-surface p-4 text-sm">
        <p className="mb-1 text-xs font-bold uppercase tracking-wider text-muted">{timing ? SEAT_TIMING_LABELS[timing] : "Your order"}</p>
        <ul className="space-y-0.5">
          {o.items.map((i, n) => (
            <li key={n}>
              <span className="font-semibold">{i.quantity} ×</span> {i.name}
            </li>
          ))}
        </ul>
        <p className="mt-2 font-bold tabular-nums">{formatINR(o.total)}</p>
      </div>
    </div>
  );
}

function OrderStrip({ order: o, stage, onPay, onOpen }: { order: SeatOrder; stage: GuestStage; onPay?: () => void; onOpen: () => void }) {
  const text = STAGE_TEXT[stage](o);
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-line bg-surface p-3" data-testid="seat-order-strip">
      <button type="button" onClick={onOpen} className="flex min-h-[48px] min-w-0 flex-1 items-center gap-3 text-left">
        {o.timing === "COUNTER" && o.pickupToken != null ? (
          <span className="flex h-12 min-w-12 items-center justify-center rounded-xl bg-surface-2 px-2 text-2xl font-black tabular-nums text-primary">{o.pickupToken}</span>
        ) : (
          <span className="shrink-0">{stageIcon(stage)}</span>
        )}
        <span className="min-w-0">
          <span className="block truncate font-bold">{text.title}</span>
          <span className="block truncate text-xs text-muted">{o.items.map((i) => `${i.quantity} × ${i.name}`).join(", ")}</span>
        </span>
      </button>
      {stage === "PAYMENT" && onPay && (
        <Button size="sm" onClick={onPay}>
          Pay
        </Button>
      )}
    </div>
  );
}
