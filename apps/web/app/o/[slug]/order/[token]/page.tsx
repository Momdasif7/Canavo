"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import clsx from "clsx";
import { QRCodeSVG } from "qrcode.react";
import { CheckCircle, FilePdf, XCircle } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { errorMessage } from "@/lib/api";
import { formatTime } from "@/lib/format";
import { publicCall, REFUND_LABEL, STAGE_LABEL, type OnlineOrderView, type OrderStage } from "@/lib/storefront";
import { useToast } from "@/components/providers/ToastProvider";
import { StoreHeader } from "@/components/storefront/StoreMenu";
import { Button } from "@/components/ui/Button";
import { ErrorState, LoadingState } from "@/components/ui/States";

const STEPS: OrderStage[] = ["waiting", "received", "preparing", "ready"];
const stepIndex = (s: OrderStage) => (s === "confirmed" ? 1 : s === "served" ? 3 : STEPS.indexOf(s));

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

  if (error && !view) return <main className="mx-auto max-w-md p-6"><ErrorState message={error} onRetry={load} /></main>;
  if (!view) return <LoadingState label="Loading your order…" />;

  const cancelled = view.stage === "cancelled";
  const current = stepIndex(view.stage);
  const pickup = view.orderType === "TAKEAWAY";

  return (
    <main className="min-h-screen pb-10">
      <StoreHeader brand={view.outlet} />
      <div className="mx-auto max-w-xl space-y-4 px-4 pt-4">
        <section className="rounded-2xl border border-line bg-surface p-4 text-center" aria-live="polite">
          {cancelled ? <XCircle size={48} className="mx-auto text-red-600" weight="fill" /> : <CheckCircle size={48} className="mx-auto text-secondary" weight="fill" />}
          <h2 className="mt-2 text-xl font-bold text-fg">{cancelled ? "Order not accepted" : view.stage === "ready" ? (pickup ? "Ready for pickup" : "Ready — on its way soon") : "Order placed"}</h2>
          <p className="text-sm text-muted">
            Order {view.invoiceNumber} · {formatTime(view.createdAt)}
          </p>
          {cancelled && view.rejectReason && <p className="mt-2 text-sm text-red-600 dark:text-red-400">{view.rejectReason}</p>}
          {cancelled && view.refund ? (
            <p className="mt-3 rounded-xl bg-surface-2 p-3 text-sm text-fg" data-testid="refund-status">
              <span className="font-semibold">Refund {formatINR(view.refund.amount)}:</span> {REFUND_LABEL[view.refund.status]}
            </p>
          ) : (
            cancelled && view.payment === "UPI" && view.balance < view.grandTotal && <p className="mt-2 text-sm text-muted">Your UPI payment will be refunded by the restaurant.</p>
          )}
          {!cancelled && (
            <ol className="mt-4 grid grid-cols-4 gap-1 text-xs font-semibold">
              {STEPS.map((s, i) => (
                <li key={s} className="flex flex-col items-center gap-1">
                  <span className={clsx("h-2 w-full rounded-full", i <= current ? "bg-secondary" : "bg-line")} />
                  <span className={i <= current ? "text-fg" : "text-muted"}>{s === "waiting" ? "Placed" : s === "received" ? "Accepted" : STAGE_LABEL[s]}</span>
                </li>
              ))}
            </ol>
          )}
          {!cancelled && view.stage === "waiting" && <p className="mt-3 text-sm text-muted">{STAGE_LABEL.waiting}…</p>}
          {view.delivery && !cancelled && <p className="mt-2 text-sm text-muted">Delivery: {view.delivery.status.replace(/_/g, " ").toLowerCase()}</p>}
        </section>

        {view.upi && !cancelled && (
          <section className="rounded-2xl border border-line bg-surface p-4 text-center">
            <h2 className="font-bold text-fg">Pay {formatINR(view.upi.amount)} with UPI</h2>
            <p className="text-sm text-muted">Scan with any UPI app, or tap the button on this phone.</p>
            {view.upi.qrPayload.startsWith("upi://") ? (
              <>
                <div className="mx-auto mt-3 w-fit rounded-xl bg-white p-3">
                  <QRCodeSVG value={view.upi.qrPayload} size={200} />
                </div>
                <a href={view.upi.qrPayload} className="mt-3 inline-flex min-h-tap items-center justify-center rounded-xl bg-primary px-5 font-semibold text-primary-fg">
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
        {view.status === "PAID" && !cancelled && (
          <p className="rounded-xl bg-secondary/10 p-3 text-center text-sm font-semibold text-secondary dark:text-green-300">Paid — thank you!</p>
        )}

        <section className="rounded-2xl border border-line bg-surface p-4">
          <h2 className="mb-2 font-bold text-fg">Your order</h2>
          <ul className="divide-y divide-line text-sm">
            {view.items.map((i, n) => (
              <li key={n} className="flex justify-between gap-3 py-2">
                <span>
                  {i.quantity} × {i.name}
                </span>
                <span className="tabular-nums">{formatINR(i.total)}</span>
              </li>
            ))}
          </ul>
          <dl className="mt-2 space-y-1 border-t border-line pt-2 text-sm">
            {view.discount > 0 && (
              <div className="flex justify-between text-secondary">
                <dt>Discount</dt>
                <dd>−{formatINR(view.discount)}</dd>
              </div>
            )}
            {view.charges.map((c) => (
              <div key={c.label} className="flex justify-between text-muted">
                <dt>{c.label}</dt>
                <dd>{formatINR(c.amount)}</dd>
              </div>
            ))}
            {view.tax > 0 && (
              <div className="flex justify-between text-muted">
                <dt>GST{view.outlet.pricesIncludeTax ? " (included)" : ""}</dt>
                <dd>{formatINR(view.tax)}</dd>
              </div>
            )}
            <div className="flex justify-between text-base font-bold text-fg">
              <dt>Total</dt>
              <dd>{formatINR(view.grandTotal)}</dd>
            </div>
          </dl>
          <p className="mt-2 text-sm text-muted">
            {view.payment === "COUNTER" ? "Pay at the counter when you collect." : view.payment === "COD" ? "Pay cash to the delivery partner." : view.payment === "UPI" ? (view.status === "PAID" ? "Paid by UPI." : "Pay by UPI using the QR above.") : null}
          </p>
          {view.receiptUrl && (
            <a href={view.receiptUrl} target="_blank" rel="noreferrer" className="mt-3 inline-flex min-h-tap items-center gap-2 rounded-xl border border-line px-4 font-semibold text-fg hover:bg-surface-2">
              <FilePdf size={20} /> Download receipt
            </a>
          )}
        </section>

        <p className="text-center text-sm">
          <Link href={`/o/${slug}`} className="font-semibold text-primary underline-offset-2 hover:underline">
            Back to the menu
          </Link>
          {view.outlet.phone && (
            <>
              {" · "}
              <a href={`tel:${view.outlet.phone}`} className="font-semibold text-primary underline-offset-2 hover:underline">
                Call {view.outlet.name}
              </a>
            </>
          )}
        </p>
      </div>
    </main>
  );
}
