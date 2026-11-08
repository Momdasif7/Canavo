"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import clsx from "clsx";
import { QRCodeSVG } from "qrcode.react";
import { ArrowLeft, Bag, CheckCircle, CookingPot, FilePdf, HandCoins, Moped, Phone, Receipt, Storefront, XCircle } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { errorMessage } from "@/lib/api";
import { formatTime } from "@/lib/format";
import { publicCall, REFUND_LABEL, STAGE_LABEL, type OnlineOrderView, type OrderStage } from "@/lib/storefront";
import { useToast } from "@/components/providers/ToastProvider";
import { BrandStyle, StoreHeader } from "@/components/storefront/StoreMenu";
import { Button } from "@/components/ui/Button";
import { ErrorState, LoadingState } from "@/components/ui/States";

interface TrackStep {
  label: string;
  hint: string;
  icon: React.ReactNode;
}

/** Steps of the live tracker and how far the order got. */
function tracker(view: OnlineOrderView): { steps: TrackStep[]; current: number } {
  const pickup = view.orderType === "TAKEAWAY";
  const base: TrackStep[] = [
    { label: "Order placed", hint: view.stage === "waiting" ? "Waiting for the restaurant to accept" : "We've got your order", icon: <Receipt size={18} weight="bold" /> },
    { label: "Accepted", hint: "The restaurant confirmed it", icon: <CheckCircle size={18} weight="bold" /> },
    { label: "Being prepared", hint: "The kitchen is cooking", icon: <CookingPot size={18} weight="bold" /> },
  ];
  const steps = pickup
    ? [...base, { label: "Ready for pickup", hint: "Collect it at the counter", icon: <Bag size={18} weight="bold" /> }]
    : [...base, { label: "Out for delivery", hint: "On the way to you", icon: <Moped size={18} weight="bold" /> }, { label: "Delivered", hint: "Enjoy your meal!", icon: <HandCoins size={18} weight="bold" /> }];
  const stage: Record<OrderStage, number> = { waiting: 0, confirmed: 1, received: 1, preparing: 2, ready: 3, served: 3, cancelled: 0 };
  let current = stage[view.stage];
  if (!pickup) {
    const d = view.delivery?.status;
    if (d === "OUT_FOR_DELIVERY") current = 3;
    else if (d === "DELIVERED") current = 4;
    else current = Math.min(current, 2);
  }
  return { steps, current };
}

/** Phase 6.4: order confirmation with live status, UPI payment and the receipt once paid. */
export default function OnlineOrderStatusPage() {
  const { slug, token } = useParams<{ slug: string; token: string }>();
  const toast = useToast();
  const [view, setView] = useState<OnlineOrderView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renewing, setRenewing] = useState(false);

  const load = useCallback(async () => {
    try {
      setView(await publicCall<OnlineOrderView>("GET", `/public/o/${slug}/orders/${token}`));
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [slug, token]);
  useEffect(() => {
    void load();
  }, [load]);
  const finished = view && (view.stage === "cancelled" || (view.status === "PAID" && ["ready", "served"].includes(view.stage)));
  useEffect(() => {
    if (finished) return;
    const id = window.setInterval(() => document.visibilityState === "visible" && void load(), view?.upi ? 4_000 : 8_000);
    return () => window.clearInterval(id);
  }, [load, finished, view?.upi]);

  const renewUpi = async () => {
    setRenewing(true);
    try {
      await publicCall("POST", `/public/o/${slug}/orders/${token}/upi`);
      await load();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setRenewing(false);
    }
  };

  if (error && !view)
    return (
      <main className="mx-auto max-w-md p-6">
        <ErrorState message={error} onRetry={load} />
      </main>
    );
  if (!view) return <LoadingState label="Loading your order…" />;

  const cancelled = view.stage === "cancelled";
  const pickup = view.orderType === "TAKEAWAY";
  const { steps, current } = tracker(view);
  const done = current === steps.length - 1;
  const headline = cancelled ? "Order not accepted" : done ? (pickup ? "Ready for pickup!" : "Delivered!") : view.stage === "waiting" ? "Order placed" : steps[current].label;

  return (
    <main className="min-h-screen bg-bg pb-10">
      <BrandStyle accent={view.outlet.accent} />
      <StoreHeader brand={view.outlet} />
      <div className="mx-auto max-w-xl space-y-4 px-4 pt-4">
        <section className={clsx("overflow-hidden rounded-3xl border shadow-sm", cancelled ? "border-red-200 bg-surface dark:border-red-500/30" : "border-line bg-surface")} aria-live="polite">
          <div className={clsx("px-5 pb-5 pt-6 text-center", cancelled ? "bg-red-50 dark:bg-red-500/10" : "bg-gradient-to-b from-primary-50 to-transparent dark:from-primary/10")}>
            {cancelled ? (
              <XCircle size={56} className="mx-auto text-red-600" weight="fill" />
            ) : (
              <span className="mx-auto flex h-16 w-16 animate-pop-in items-center justify-center rounded-full bg-secondary text-white shadow-lg shadow-secondary/30">
                <svg viewBox="0 0 24 24" className="h-9 w-9" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M5 12.5l4.5 4.5L19 7.5" strokeDasharray="48" className="animate-draw-check" />
                </svg>
              </span>
            )}
            <h2 className="mt-3 text-2xl font-extrabold tracking-tight text-fg" data-testid="order-headline">
              {headline}
            </h2>
            <p className="mt-0.5 text-sm text-muted">
              Order {view.invoiceNumber} · {formatTime(view.createdAt)} · {pickup ? "Pickup" : "Delivery"}
            </p>
            {cancelled && view.rejectReason && <p className="mt-2 text-sm font-medium text-red-700 dark:text-red-300">{view.rejectReason}</p>}
            {cancelled && view.refund ? (
              <p className="mt-3 rounded-xl bg-surface p-3 text-sm text-fg" data-testid="refund-status">
                <span className="font-semibold">Refund {formatINR(view.refund.amount)}:</span> {REFUND_LABEL[view.refund.status]}
              </p>
            ) : (
              cancelled && view.payment === "UPI" && view.balance < view.grandTotal && <p className="mt-2 text-sm text-muted">Your UPI payment will be refunded by the restaurant.</p>
            )}
          </div>
          {!cancelled && (
            <ol className="px-5 pb-5" aria-label="Order status">
              {steps.map((s, i) => {
                const reached = i <= current;
                const now = i === current && !done;
                return (
                  <li key={s.label} className="relative flex gap-3 pb-4 last:pb-0">
                    {i < steps.length - 1 && <span className={clsx("absolute left-[17px] top-9 h-[calc(100%-2rem)] w-0.5", i < current ? "bg-secondary" : "bg-line")} aria-hidden />}
                    <span
                      className={clsx(
                        "relative z-10 flex h-9 w-9 shrink-0 items-center justify-center rounded-full border-2",
                        reached ? "border-secondary bg-secondary text-white" : "border-line bg-surface text-muted",
                        now && "ring-4 ring-secondary/20",
                      )}
                    >
                      {s.icon}
                    </span>
                    <div className="pt-1">
                      <p className={clsx("font-bold", reached ? "text-fg" : "text-muted")}>
                        {s.label}
                        {now && <span className="ml-2 inline-block h-2 w-2 animate-pulse rounded-full bg-secondary align-middle" aria-hidden />}
                      </p>
                      {(now || (done && i === current)) && <p className="text-sm text-muted">{i === 0 && view.stage === "waiting" ? STAGE_LABEL.waiting : s.hint}</p>}
                    </div>
                  </li>
                );
              })}
            </ol>
          )}
        </section>

        {view.upi && !cancelled && (
          <section className="rounded-3xl border border-primary/30 bg-surface p-5 text-center shadow-sm">
            <h2 className="text-lg font-extrabold text-fg">Pay {formatINR(view.upi.amount)} with UPI</h2>
            <p className="text-sm text-muted">Scan with any UPI app, or tap the button on this phone.</p>
            {view.upi.qrPayload.startsWith("upi://") ? (
              <>
                <div className="mx-auto mt-3 w-fit rounded-2xl bg-white p-3 shadow-sm">
                  <QRCodeSVG value={view.upi.qrPayload} size={200} />
                </div>
                <a href={view.upi.qrPayload} className="mt-3 inline-flex min-h-tap items-center justify-center rounded-xl bg-primary px-6 font-bold text-primary-fg">
                  Open UPI app
                </a>
              </>
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={view.upi.qrPayload} alt="UPI QR code" className="mx-auto mt-3 w-56 rounded-xl bg-white p-2" />
            )}
            <div className="mt-2">
              <Button variant="ghost" size="sm" loading={renewing} onClick={() => void renewUpi()}>
                QR expired? Get a new one
              </Button>
            </div>
          </section>
        )}
        {view.status === "PAID" && !cancelled && <p className="rounded-2xl bg-secondary-50 p-3 text-center text-sm font-bold text-secondary-700 dark:bg-green-500/15 dark:text-green-300">Paid — thank you!</p>}

        <section className="rounded-3xl border border-line bg-surface p-5 shadow-sm">
          <h2 className="mb-2 text-xs font-extrabold uppercase tracking-wider text-muted">Your order</h2>
          <ul className="divide-y divide-line text-sm">
            {view.items.map((i, n) => (
              <li key={n} className="flex justify-between gap-3 py-2">
                <span>
                  <span className="font-semibold">{i.quantity} ×</span> {i.name}
                </span>
                <span className="tabular-nums">{formatINR(i.total)}</span>
              </li>
            ))}
          </ul>
          <dl className="mt-2 space-y-1 border-t border-dashed border-line pt-2 text-sm">
            <div className="flex justify-between text-muted">
              <dt>Item total</dt>
              <dd className="tabular-nums">{formatINR(view.subtotal)}</dd>
            </div>
            {view.discount > 0 && (
              <div className="flex justify-between text-secondary dark:text-green-300">
                <dt>Discount</dt>
                <dd className="tabular-nums">−{formatINR(view.discount)}</dd>
              </div>
            )}
            {view.charges.map((c) => (
              <div key={c.label} className="flex justify-between text-muted">
                <dt>{c.label}</dt>
                <dd className="tabular-nums">{formatINR(c.amount)}</dd>
              </div>
            ))}
            {view.tax > 0 && (
              <div className="flex justify-between text-muted">
                <dt>GST{view.outlet.pricesIncludeTax ? " (included)" : ""}</dt>
                <dd className="tabular-nums">{formatINR(view.tax)}</dd>
              </div>
            )}
            <div className="flex justify-between pt-1 text-base font-extrabold text-fg">
              <dt>Total</dt>
              <dd className="tabular-nums">{formatINR(view.grandTotal)}</dd>
            </div>
          </dl>
          <p className="mt-3 flex items-center gap-2 rounded-xl bg-surface-2 p-2.5 text-sm text-fg">
            {view.payment === "COD" ? <HandCoins size={18} /> : <Storefront size={18} />}
            {view.payment === "COUNTER" ? "Pay at the counter when you collect." : view.payment === "COD" ? "Pay cash to the delivery partner." : view.payment === "UPI" ? (view.status === "PAID" ? "Paid by UPI." : "Pay by UPI using the QR above.") : null}
          </p>
          {view.receiptUrl && (
            <a href={view.receiptUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex min-h-tap items-center gap-2 rounded-xl border border-line px-4 font-semibold text-fg hover:bg-surface-2">
              <FilePdf size={20} /> Download receipt
            </a>
          )}
        </section>

        <div className="grid gap-2 sm:grid-cols-2">
          <Link href={`/o/${slug}`} className="inline-flex min-h-tap items-center justify-center gap-2 rounded-xl border border-line bg-surface font-semibold text-fg hover:bg-surface-2">
            <ArrowLeft size={18} /> Back to the menu
          </Link>
          {view.outlet.phone && (
            <a href={`tel:${view.outlet.phone}`} className="inline-flex min-h-tap items-center justify-center gap-2 rounded-xl border border-line bg-surface font-semibold text-fg hover:bg-surface-2">
              <Phone size={18} /> Call {view.outlet.name}
            </a>
          )}
        </div>
      </div>
    </main>
  );
}
