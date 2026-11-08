"use client";

import { CloudArrowUp, HandCoins, HourglassMedium, Moped, Plus } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { PAYMENT_MODE_LABELS } from "@/lib/format";
import type { Order } from "@/lib/types";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { ReceiptActions } from "@/components/bills/ReceiptActions";
import { codPartnerName } from "@/components/bills/CodBadge";
import { orderBalance } from "./PaymentDialog";

export type Success =
  | { kind: "online"; order: Order; change: number }
  /** Cash on Delivery: nothing paid yet, the delivery partner collects at the door */
  | { kind: "cod"; order: Order }
  /** invoiceNumber: final number from this browser's offline series (OFFLINE_INVOICE_SERIES), else null */
  | { kind: "offline"; clientOrderId: string; invoiceNumber?: string | null; total: number; change: number; modes: string[] };

function AnimatedCheck({ tone = "green" }: { tone?: "green" | "amber" }) {
  return (
    <div className={`mx-auto flex h-20 w-20 animate-pop-in items-center justify-center rounded-full ${tone === "green" ? "bg-secondary" : "bg-amber-500"}`}>
      <svg viewBox="0 0 24 24" className="h-11 w-11" fill="none" stroke="white" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M5 12.5l4.5 4.5L19 7.5" strokeDasharray="48" className="animate-draw-check" />
      </svg>
    </div>
  );
}

export function SuccessPanel({ success, onNewBill }: { success: Success | null; onNewBill: () => void }) {
  if (!success) return null;
  if (success.kind === "cod") return <CodSuccess order={success.order} onNewBill={onNewBill} />;
  const paidModes =
    success.kind === "online"
      ? [...new Set(success.order.payments.filter((p) => p.status === "SUCCESS").map((p) => PAYMENT_MODE_LABELS[p.mode]))]
      : success.modes;
  const total = success.kind === "online" ? success.order.grandTotal : success.total;

  return (
    <Dialog
      open
      onClose={onNewBill}
      size="md"
      title={success.kind === "online" ? `Paid · ${success.order.invoiceNumber}` : success.invoiceNumber ? `Saved offline · ${success.invoiceNumber}` : "Saved offline"}
      footer={<NewBillButton onClick={onNewBill} />}
    >
      <div className="mb-5 space-y-3 text-center">
        <AnimatedCheck tone={success.kind === "online" ? "green" : "amber"} />
        <p className="tabular text-3xl font-extrabold">{formatINR(total)}</p>
        <p className="text-sm text-muted">Paid by {paidModes.join(" + ") || "—"}</p>
        {success.change > 0 && (
          <p className="inline-block rounded-xl bg-secondary-50 px-4 py-2 text-lg font-bold text-secondary-700 dark:bg-secondary/20 dark:text-green-200">
            Return change: <span className="tabular">{formatINR(success.change)}</span>
          </p>
        )}
        {success.kind === "online" && <DeliveryAssignment order={success.order} />}
      </div>

      {success.kind === "online" && ((success.order.appliedOffers?.length ?? 0) > 0 || (success.order.chargesBreakup?.length ?? 0) > 0) && (
        <ul className="mb-4 space-y-1 rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm" aria-label="Promotions and charges">
          {success.order.appliedOffers?.map((a, i) => (
            <li key={`o${i}`} className="flex justify-between gap-3 text-secondary-700 dark:text-green-300">
              <span className="truncate">{a.label}</span>
              <span className="tabular font-semibold">−{formatINR(a.amount)}</span>
            </li>
          ))}
          {success.order.chargesBreakup?.map((c, i) => (
            <li key={`c${i}`} className="flex justify-between gap-3">
              <span className="truncate text-muted">{c.label}</span>
              <span className="tabular font-semibold">{formatINR(c.amount)}</span>
            </li>
          ))}
        </ul>
      )}

      {success.kind === "online" ? (
        <ReceiptActions orderId={success.order.id} customerPhone={success.order.customerPhone} autoFocusPrint />
      ) : (
        <div className="flex items-start gap-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
          <CloudArrowUp size={24} className="shrink-0" />
          <p>
            <strong>Not sent to the kitchen yet.</strong> The bill is saved on this device and reaches the kitchen automatically when the
            connection is back — tell the kitchen directly if it&apos;s urgent.{" "}
            {success.invoiceNumber ? (
              <>
                Bill number <strong data-testid="offline-invoice-number">{success.invoiceNumber}</strong> is final; the receipt is issued on sync and you
                can reprint it from Bills afterwards.
              </>
            ) : (
              <>The invoice number and receipt are issued then; you can reprint it from Bills afterwards.</>
            )}
          </p>
        </div>
      )}
    </Dialog>
  );
}

/** Who the delivery went to — auto-assigned to an on-duty partner, or waiting for one to clock in. */
export function DeliveryAssignment({ order }: { order: Order }) {
  if (order.orderType !== "DELIVERY" || !order.delivery) return null;
  const agent = order.delivery.agent;
  return agent ? (
    <p className="flex items-center justify-center gap-2 rounded-xl bg-sky-50 px-3 py-2 text-sm font-semibold text-sky-900 dark:bg-sky-500/15 dark:text-sky-100" data-testid="delivery-assignment">
      <Moped size={18} weight="fill" className="shrink-0" /> Assigned to {agent.name}
    </p>
  ) : (
    <p className="flex items-center justify-center gap-2 rounded-xl bg-amber-50 px-3 py-2 text-sm font-semibold text-amber-900 dark:bg-amber-500/15 dark:text-amber-100" data-testid="delivery-assignment">
      <HourglassMedium size={18} weight="fill" className="shrink-0" /> Waiting for a partner — will auto-assign when one clocks in
    </p>
  );
}

function NewBillButton({ onClick }: { onClick: () => void }) {
  return (
    <Button size="lg" icon={<Plus size={22} />} onClick={onClick} className="min-w-[200px]">
      New bill
    </Button>
  );
}

/** COD placed: the bill is unpaid on purpose — the receipt can still be printed / shared. */
function CodSuccess({ order, onNewBill }: { order: Order; onNewBill: () => void }) {
  const due = orderBalance(order);
  const partner = codPartnerName(order);
  return (
    <Dialog open onClose={onNewBill} size="md" title={`Cash on Delivery · ${order.invoiceNumber}`} footer={<NewBillButton onClick={onNewBill} />}>
      <div className="mb-5 space-y-3 text-center" data-testid="cod-success">
        <div className="mx-auto flex h-20 w-20 animate-pop-in items-center justify-center rounded-full bg-amber-500 text-white">
          <HandCoins size={44} weight="fill" />
        </div>
        <p className="tabular text-3xl font-extrabold">{formatINR(due)}</p>
        <p className="font-semibold">
          Bill {order.invoiceNumber} · Cash on Delivery · <span className="tabular">{formatINR(due)}</span> to collect by {partner}
        </p>
        <p className="text-sm text-muted">No payment taken now. The bill shows as unpaid until {partner} collects the cash at the door.</p>
        <DeliveryAssignment order={order} />
      </div>
      <ReceiptActions orderId={order.id} customerPhone={order.customerPhone} autoFocusPrint />
    </Dialog>
  );
}
