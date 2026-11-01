"use client";

import { useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { Bank, Briefcase, Gift, CheckCircle, CreditCard, HandCoins, Money, Notebook, Plus, QrCode, SplitHorizontal, Ticket, Trash, Wallet, WifiSlash } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { api, errorMessage, isNetworkError } from "@/lib/api";
import { PAYMENT_MODE_LABELS, parseRupees, rupeesInput } from "@/lib/format";
import type { QueuedPayment } from "@/lib/offline";
import type { Order, PaymentMode, PaymentResult } from "@/lib/types";
import { useHotkeys } from "@/hooks/useHotkeys";
import { Dialog } from "@/components/ui/Dialog";
import { Button, IconButton } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Alert } from "@/components/ui/States";
import { useSession } from "@/components/providers/SessionProvider";
import { UpiQrPanel } from "./UpiQrPanel";

export type Checkout =
  | { kind: "online"; order: Order }
  | { kind: "offline"; total: number; customerPhone?: string };

type Tab = "CASH" | "UPI" | "CARD" | "SPLIT" | "KHATA" | "GIFT" | "WALLET" | "TOKEN" | "COD";

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "CASH", label: "Cash", icon: <Money size={22} /> },
  { id: "UPI", label: "UPI", icon: <QrCode size={22} /> },
  { id: "CARD", label: "Card", icon: <CreditCard size={22} /> },
  { id: "SPLIT", label: "Split", icon: <SplitHorizontal size={22} /> },
  { id: "KHATA", label: "Khata", icon: <Notebook size={22} /> },
  { id: "GIFT", label: "Gift card", icon: <Gift size={22} /> },
  { id: "WALLET", label: "Wallet", icon: <Wallet size={22} /> },
  { id: "TOKEN", label: "Meal token", icon: <Ticket size={22} /> },
];

/** Canteen member on the bill (Phase 5.2): wallet and meal tokens. */
interface MemberMoney {
  walletBalance: number;
  tokens: { id: string; mealSlotId: string | null; balance: number; value: number }[];
}

/**
 * Modes the counter can't pick by hand: the company's share is added at billing; tokens / gift cards
 * have their own tabs; "Paid online" is recorded by the channel that took the money (Phase 6).
 */
const SPLIT_HIDDEN: PaymentMode[] = ["GIFT_CARD", "CORPORATE", "MEAL_TOKEN", "ONLINE"];

interface SplitRow {
  id: number;
  mode: PaymentMode;
  amount: string;
}

export const orderBalance = (order: Order) =>
  order.balance ?? Math.max(0, order.grandTotal - order.payments.filter((p) => p.status === "SUCCESS").reduce((s, p) => s + p.amount, 0));

/** A delivery bill that can still be switched to Cash on Delivery (open, run not finished). */
export const codEligible = (order: Order) =>
  order.orderType === "DELIVERY" && order.status === "OPEN" && !!order.delivery && order.delivery.status !== "DELIVERED" && order.delivery.status !== "CANCELLED";

/** Suggested notes for the cash tender buttons. */
export function cashSuggestions(amount: number): number[] {
  const rupees = Math.ceil(amount / 100);
  const out = new Set<number>();
  for (const step of [10, 50, 100, 500, 2000]) {
    const v = Math.ceil(rupees / step) * step;
    if (v * 100 > amount) out.add(v * 100);
  }
  return [...out].sort((a, b) => a - b).slice(0, 4);
}

export function PaymentDialog({
  checkout,
  onClose,
  onPaidOnline,
  onPaidOffline,
  onWentOffline,
  onCod,
  advance,
  suggestedSplit,
}: {
  checkout: Checkout | null;
  /** Advance taken at reservation time — offered as an "ADVANCE" payment on this bill */
  advance?: number;
  /** Pre-filled split amounts (e.g. equal split of a table bill) */
  suggestedSplit?: number[];
  onClose: () => void;
  onPaidOnline: (order: Order, change: number) => void;
  onPaidOffline: (payments: QueuedPayment[], tendered: number | undefined, change: number) => void;
  /** Network dropped while recording payment for an online order */
  onWentOffline?: () => void;
  /**
   * Offer "Cash on Delivery" for eligible delivery bills: marks the bill COD
   * (POST /orders/:id/cod) and hands back the updated order. Omit to hide COD.
   */
  onCod?: (order: Order) => void;
}) {
  const [tab, setTab] = useState<Tab>("CASH");
  const [tendered, setTendered] = useState("");
  const [reference, setReference] = useState("");
  // Phase 3.8: card details, tip, gift card
  const [cardLast4, setCardLast4] = useState("");
  const [authCode, setAuthCode] = useState("");
  const [tip, setTip] = useState("");
  const [giftCode, setGiftCode] = useState("");
  const [gift, setGift] = useState<{ balance: number; usable: boolean; message: string | null } | null>(null);
  const [giftRestMode, setGiftRestMode] = useState<PaymentMode>("CASH");
  const [memberMoney, setMemberMoney] = useState<MemberMoney | null>(null);
  const [restMode, setRestMode] = useState<PaymentMode>("CASH");
  const [tokenCount, setTokenCount] = useState(1);
  const { me } = useSession();
  const [split, setSplit] = useState<SplitRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Latest server copy of the order (changes after an advance is recorded) */
  const [current, setCurrent] = useState<Order | null>(null);
  const [advanceMode, setAdvanceMode] = useState<PaymentMode>("UPI");
  const [advanceApplied, setAdvanceApplied] = useState(false);

  const offline = checkout?.kind === "offline";
  const liveOrder = checkout?.kind === "online" ? (current?.id === checkout.order.id ? current : checkout.order) : null;
  const amount = checkout ? (liveOrder ? orderBalance(liveOrder) : checkout.kind === "offline" ? checkout.total : 0) : 0;
  const phone = checkout ? (checkout.kind === "online" ? checkout.order.customerPhone : checkout.customerPhone) : undefined;
  const advanceDue = !offline && advance && advance > 0 && !advanceApplied ? Math.min(advance, amount) : 0;
  const codOffered = !!onCod && !!liveOrder && codEligible(liveOrder);
  const codPartner = liveOrder?.delivery?.agent?.name ?? "the delivery partner";

  useEffect(() => {
    if (!checkout) return;
    const due = checkout.kind === "online" ? orderBalance(checkout.order) : checkout.total;
    setCurrent(null);
    setAdvanceApplied(false);
    setTendered("");
    setReference("");
    setCardLast4("");
    setAuthCode("");
    setTip("");
    setGiftCode("");
    setGift(null);
    setError(null);
    setMemberMoney(null);
    setRestMode("CASH");
    setTokenCount(1);
    if (suggestedSplit && suggestedSplit.length > 1) {
      setTab("SPLIT");
      setSplit(suggestedSplit.map((a, i) => ({ id: i + 1, mode: "CASH" as PaymentMode, amount: rupeesInput(a) })));
    } else {
      setTab("CASH");
      setSplit([
        { id: 1, mode: "CASH", amount: rupeesInput(due) },
        { id: 2, mode: "UPI", amount: "" },
      ]);
    }
    // Reset only when a new checkout opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkout]);

  // Canteen member on the bill: load their wallet and meal tokens (Phase 5.2).
  const memberId = checkout?.kind === "online" && me?.modules?.includes("CANTEEN") ? checkout.order.customerId : null;
  useEffect(() => {
    if (!memberId) return;
    let cancelled = false;
    api
      .get<MemberMoney>(`/canteen/members/${memberId}`)
      .then((m) => !cancelled && setMemberMoney({ walletBalance: m.walletBalance, tokens: m.tokens }))
      .catch(() => !cancelled && setMemberMoney(null));
    return () => {
      cancelled = true;
    };
  }, [memberId, checkout]);

  /** Record the reservation advance as a payment (reference "ADVANCE"). */
  const applyAdvance = async () => {
    if (checkout?.kind !== "online" || !advanceDue || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.post<PaymentResult>(`/orders/${checkout.order.id}/payments`, {
        payments: [{ mode: advanceMode, amount: advanceDue, reference: "ADVANCE" }],
      });
      setAdvanceApplied(true);
      setCurrent(res.order);
      if (res.paid) onPaidOnline(res.order, 0);
      else {
        const left = res.balance;
        setSplit((rows) => (rows.length ? rows.map((r, i) => (i === 0 ? { ...r, amount: rupeesInput(left) } : { ...r, amount: "" })) : rows));
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const tenderedPaise = parseRupees(tendered);
  const change = tenderedPaise !== null ? tenderedPaise - amount : 0;
  const splitTotal = split.reduce((s, r) => s + (parseRupees(r.amount) ?? 0), 0);
  const splitRemaining = amount - splitTotal;
  const suggestions = useMemo(() => cashSuggestions(amount), [amount]);

  const tipPaise = !offline && (tab === "CASH" || tab === "CARD") ? (parseRupees(tip) ?? 0) : 0;
  const giftUse = gift?.usable ? Math.min(gift.balance, amount) : 0;
  // Meal tokens for this bill's slot first, then any-slot tokens (same order as the server).
  const slotId = liveOrder?.mealSlotId ?? null;
  const tokenAcc = memberMoney?.tokens.find((t) => t.balance > 0 && slotId && t.mealSlotId === slotId) ?? memberMoney?.tokens.find((t) => t.balance > 0 && t.mealSlotId === null);
  const tokenCover = tokenAcc ? (tokenCount >= tokenAcc.balance ? tokenAcc.value : Math.round(tokenAcc.value / tokenAcc.balance) * tokenCount) : 0;
  const tokenUse = Math.min(tokenCover, amount);
  const walletUse = Math.min(memberMoney?.walletBalance ?? 0, amount);
  const corporatePaid = (liveOrder?.payments ?? []).filter((p) => p.mode === "CORPORATE" && p.status === "SUCCESS");
  const tabs = TABS.filter((t) => {
    if (t.id === "GIFT") return Boolean(me?.features?.GIFT_CARDS) && !offline;
    if (t.id === "WALLET") return !offline && !!memberMoney;
    if (t.id === "TOKEN") return !offline && !!tokenAcc;
    return true;
  });

  const checkGift = async () => {
    setGift(null);
    try {
      const c = await api.get<{ balance: number; active: boolean; expired: boolean }>(`/gift-cards/code/${encodeURIComponent(giftCode.trim())}`);
      const problem = !c.active ? "This card is blocked" : c.expired ? "This card has expired" : c.balance <= 0 ? "No balance left" : null;
      setGift({ balance: c.balance, usable: !problem, message: problem });
    } catch (e) {
      setGift({ balance: 0, usable: false, message: errorMessage(e) });
    }
  };

  /** Payments for the active tab, or an error string. */
  const build = (): { payments: QueuedPayment[]; tendered?: number } | string => {
    switch (tab) {
      case "CASH":
        if (tenderedPaise !== null && tenderedPaise < amount + tipPaise) return "Cash received is less than the amount due";
        return { payments: [{ mode: "CASH", amount, ...(tipPaise > 0 && { tip: tipPaise }) }], tendered: tenderedPaise ?? amount + tipPaise };
      case "CARD":
        if (cardLast4 && !/^\d{4}$/.test(cardLast4)) return "Enter the card's last 4 digits";
        return {
          payments: [{ mode: "CARD", amount, ...(tipPaise > 0 && { tip: tipPaise }), ...(cardLast4 && { cardLast4 }), ...(authCode.trim() && { authCode: authCode.trim() }) }],
        };
      case "GIFT": {
        if (!gift?.usable) return "Check the gift card first";
        const rest = amount - giftUse;
        return {
          payments: [
            { mode: "GIFT_CARD", amount: giftUse, giftCardCode: giftCode.trim() },
            ...(rest > 0 ? [{ mode: giftRestMode, amount: rest }] : []),
          ],
          ...(rest > 0 && giftRestMode === "CASH" && { tendered: rest }),
        };
      }
      case "WALLET": {
        if (walletUse <= 0) return "The wallet is empty";
        const rest = amount - walletUse;
        return {
          payments: [{ mode: "WALLET", amount: walletUse }, ...(rest > 0 ? [{ mode: restMode, amount: rest }] : [])],
          ...(rest > 0 && restMode === "CASH" && { tendered: rest }),
        };
      }
      case "TOKEN": {
        if (!tokenAcc || tokenUse <= 0) return "No meal tokens for this meal";
        const rest = amount - tokenUse;
        return {
          payments: [{ mode: "MEAL_TOKEN", amount: tokenUse, tokens: tokenCount }, ...(rest > 0 ? [{ mode: restMode, amount: rest }] : [])],
          ...(rest > 0 && restMode === "CASH" && { tendered: rest }),
        };
      }
      case "UPI":
        return { payments: [{ mode: "UPI", amount }] };
      case "COD":
        return "Cash on Delivery takes no payment now";
      case "KHATA":
        if (!phone) return "Khata needs a customer phone number on the bill";
        return { payments: [{ mode: "KHATA", amount }] };
      case "SPLIT": {
        const rows = split.map((r) => ({ mode: r.mode, amount: parseRupees(r.amount) ?? 0 })).filter((r) => r.amount > 0);
        if (!rows.length) return "Add at least one payment";
        if (splitRemaining !== 0) return `Split must add up to ${formatINR(amount)}`;
        if (rows.some((r) => r.mode === "KHATA") && !phone) return "Khata needs a customer phone number on the bill";
        return { payments: rows };
      }
    }
  };

  const confirm = async () => {
    if (!checkout || busy) return;
    if (tab === "UPI" && !offline) return; // QR flow confirms itself
    if (tab === "COD") return void markCod();
    const built = build();
    if (typeof built === "string") {
      setError(built);
      return;
    }
    const cashPart = built.payments.filter((p) => p.mode === "CASH").reduce((s, p) => s + p.amount + (p.tip ?? 0), 0);
    const changeDue = built.tendered !== undefined ? built.tendered - cashPart : 0;
    if (checkout.kind === "offline") {
      onPaidOffline(built.payments, built.tendered, changeDue);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const payload = {
        payments: built.payments.map((p) => (tab === "CARD" && reference.trim() ? { ...p, reference: reference.trim() } : p)),
        tendered: built.tendered,
      };
      const res = await api.post<PaymentResult>(`/orders/${checkout.order.id}/payments`, payload);
      setCurrent(res.order);
      if (res.paid) onPaidOnline(res.order, res.change);
      else setError(`Recorded. ${formatINR(res.balance)} still due.`);
    } catch (e) {
      if (isNetworkError(e)) onWentOffline?.();
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  /** No payment now: the delivery partner collects the balance in cash at the door. */
  const markCod = async () => {
    if (checkout?.kind !== "online" || !onCod || busy) return;
    setBusy(true);
    setError(null);
    try {
      const order = await api.post<Order>(`/orders/${checkout.order.id}/cod`, {});
      setCurrent(order);
      onCod(order);
    } catch (e) {
      if (isNetworkError(e)) onWentOffline?.();
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const upiPaid = async () => {
    if (checkout?.kind !== "online") return;
    try {
      onPaidOnline(await api.get<Order>(`/orders/${checkout.order.id}`), 0);
    } catch {
      onPaidOnline(checkout.order, 0);
    }
  };

  useHotkeys({ F10: () => void confirm() }, !!checkout);

  if (!checkout) return null;
  const title = checkout.kind === "online" ? `Payment · ${checkout.order.invoiceNumber}` : "Payment (offline)";

  return (
    <Dialog
      open
      onClose={onClose}
      size="md"
      dismissible={!busy}
      title={title}
      footer={
        tab === "UPI" && !offline ? (
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button size="lg" variant="secondary" onClick={confirm} loading={busy} className="min-w-[200px]" data-testid="payment-confirm">
              {tab === "COD" ? "Confirm COD" : offline ? "Save offline" : "Collect"} <span className="tabular">{formatINR(amount)}</span>
              <kbd className="ml-1 hidden rounded bg-white/20 px-1.5 text-xs lg:inline">F10</kbd>
            </Button>
          </>
        )
      }
    >
      <div className="mb-4 flex items-baseline justify-between">
        <span className="text-sm font-semibold text-muted">Amount due</span>
        <span className="tabular text-3xl font-extrabold">{formatINR(amount)}</span>
      </div>

      {advanceDue > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200">
          <span className="flex-1">
            Advance of <strong className="tabular">{formatINR(advanceDue)}</strong> was paid at booking.
          </span>
          <select
            aria-label="Advance paid via"
            value={advanceMode}
            onChange={(e) => setAdvanceMode(e.target.value as PaymentMode)}
            className="min-h-[40px] rounded-lg border border-line bg-surface px-2 text-sm font-semibold text-fg"
          >
            {(["UPI", "CASH", "CARD"] as PaymentMode[]).map((m) => (
              <option key={m} value={m}>
                {PAYMENT_MODE_LABELS[m]}
              </option>
            ))}
          </select>
          <Button size="sm" variant="secondary" onClick={applyAdvance} loading={busy}>
            Apply advance
          </Button>
        </div>
      )}

      {corporatePaid.length > 0 && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-sm text-sky-900 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200" data-testid="corporate-share">
          <Briefcase size={18} className="shrink-0" />
          <span>
            {corporatePaid[0]!.reference ?? "The company"} pays <strong className="tabular">{formatINR(corporatePaid.reduce((s, p) => s + p.amount, 0))}</strong> (billed monthly) · the
            employee pays the amount due.
          </span>
        </div>
      )}

      {offline && (
        <div className="mb-4">
          <Alert tone="warning">
            <span className="flex items-center gap-2">
              <WifiSlash size={18} /> No connection. The bill will be saved on this device and synced automatically.
            </span>
          </Alert>
        </div>
      )}

      {codOffered && (
        <button
          type="button"
          aria-pressed={tab === "COD"}
          onClick={() => {
            setTab("COD");
            setError(null);
          }}
          className={clsx(
            "mb-2 flex w-full items-center gap-3 rounded-xl border-2 px-4 py-3 text-left transition-colors",
            tab === "COD"
              ? "border-amber-500 bg-amber-50 text-amber-900 dark:border-amber-400 dark:bg-amber-500/15 dark:text-amber-100"
              : "border-dashed border-amber-400/70 bg-surface text-fg hover:bg-amber-50 dark:hover:bg-amber-500/10",
          )}
          data-testid="cod-option"
        >
          <HandCoins size={30} weight={tab === "COD" ? "fill" : "duotone"} className="shrink-0 text-amber-600 dark:text-amber-300" />
          <span className="min-w-0 flex-1">
            <span className="block font-bold">Cash on Delivery (COD)</span>
            <span className="block text-sm text-muted">
              No payment now — {codPartner} collects <strong className="tabular text-fg">{formatINR(amount)}</strong> in cash at the door
            </span>
          </span>
          {tab === "COD" && <CheckCircle size={24} weight="fill" className="shrink-0 text-amber-600 dark:text-amber-300" />}
        </button>
      )}

      <div role="tablist" className={clsx("mb-4 grid gap-1.5", tabs.length > 6 ? "grid-cols-4" : tabs.length > 5 ? "grid-cols-3 sm:grid-cols-6" : "grid-cols-5")}>
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => {
              setTab(t.id);
              setError(null);
            }}
            className={clsx(
              "flex min-h-[64px] flex-col items-center justify-center gap-1 rounded-xl border text-sm font-semibold transition-colors",
              tab === t.id ? "border-primary bg-primary text-white" : "border-line bg-surface text-fg hover:border-primary/60",
            )}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {error && (
        <div className="mb-3">
          <Alert>{error}</Alert>
        </div>
      )}

      {tab === "COD" && liveOrder && (
        <div className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
          <p>
            The bill stays <strong>unpaid</strong> until {codPartner} collects <strong className="tabular">{formatINR(amount)}</strong> in cash and marks it delivered.
          </p>
          {!liveOrder.delivery?.agentId && <p className="font-semibold">Waiting for a partner — will auto-assign when one clocks in.</p>}
          {liveOrder.payments.some((p) => p.status === "PENDING") && <p>The pending UPI QR for this bill will be cancelled.</p>}
        </div>
      )}

      {tab === "CASH" && (
        <div className="space-y-3">
          <Input
            label="Cash received"
            inputMode="decimal"
            placeholder={rupeesInput(amount)}
            value={tendered}
            onChange={(e) => setTendered(e.target.value.replace(/[^\d.]/g, ""))}
            prefix="₹"
            className="tabular text-lg font-bold"
            data-autofocus
            onKeyDown={(e) => e.key === "Enter" && void confirm()}
          />
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => setTendered(rupeesInput(amount))}>
              Exact
            </Button>
            {suggestions.map((s) => (
              <Button key={s} variant="outline" size="sm" className="tabular" onClick={() => setTendered(rupeesInput(s))}>
                {formatINR(s)}
              </Button>
            ))}
          </div>
          <div
            className={clsx(
              "flex items-baseline justify-between rounded-xl px-4 py-3",
              change < 0 ? "bg-red-50 text-red-700 dark:bg-red-500/10 dark:text-red-200" : "bg-secondary-50 text-secondary-700 dark:bg-secondary/20 dark:text-green-200",
            )}
          >
            <span className="font-semibold">{change < 0 ? "Short by" : "Change to return"}</span>
            <span className="tabular text-2xl font-extrabold">{formatINR(Math.abs(change))}</span>
          </div>
        </div>
      )}

      {tab === "UPI" &&
        (offline ? (
          <p className="text-sm text-muted">
            Dynamic QR needs a connection. Show the outlet&apos;s printed UPI QR and record the payment once you see it on the merchant app.
          </p>
        ) : (
          <UpiQrPanel key={amount} orderId={checkout.order.id} onPaid={upiPaid} />
        ))}

      {tab === "CARD" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Input
            label="Card last 4 digits (optional)"
            inputMode="numeric"
            maxLength={4}
            value={cardLast4}
            onChange={(e) => setCardLast4(e.target.value.replace(/\D/g, ""))}
            prefix={<CreditCard size={18} />}
            disabled={offline}
          />
          <Input
            label="Approval code (optional)"
            maxLength={20}
            value={authCode}
            onChange={(e) => setAuthCode(e.target.value.toUpperCase())}
            prefix={<Bank size={18} />}
            disabled={offline}
            hint={offline ? "Card details can be added later from Bills." : "From the card machine slip; used to match the bank settlement."}
          />
        </div>
      )}

      {!offline && (tab === "CASH" || tab === "CARD") && (
        <Input
          label="Tip (optional)"
          inputMode="decimal"
          prefix="₹"
          value={tip}
          onChange={(e) => setTip(e.target.value.replace(/[^\d.]/g, ""))}
          wrapperClassName="mt-3 max-w-[200px]"
          hint="On top of the bill. Not part of sales; no GST."
        />
      )}

      {tab === "GIFT" && (
        <div className="space-y-3">
          <div className="flex items-end gap-2">
            <Input
              label="Gift card code"
              wrapperClassName="flex-1"
              value={giftCode}
              onChange={(e) => {
                setGiftCode(e.target.value.toUpperCase());
                setGift(null);
              }}
              placeholder="GC-XXXXX-XXXXX"
            />
            <Button variant="outline" disabled={giftCode.trim().length < 6} onClick={() => void checkGift()}>
              Check
            </Button>
          </div>
          {gift && !gift.usable && <Alert>{gift.message}</Alert>}
          {gift?.usable && (
            <div className="space-y-2 text-sm">
              <p>
                Balance <strong className="tabular">{formatINR(gift.balance)}</strong> · uses <strong className="tabular">{formatINR(giftUse)}</strong>
              </p>
              {amount - giftUse > 0 && (
                <label className="flex items-center gap-2">
                  Pay the rest ({formatINR(amount - giftUse)}) by
                  <select value={giftRestMode} onChange={(e) => setGiftRestMode(e.target.value as PaymentMode)} className="rounded-lg border border-line bg-surface px-2 py-1 font-semibold">
                    {(["CASH", "UPI", "CARD"] as PaymentMode[]).map((m) => (
                      <option key={m} value={m}>
                        {PAYMENT_MODE_LABELS[m]}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          )}
        </div>
      )}

      {(tab === "WALLET" || tab === "TOKEN") && memberMoney && (
        <div className="space-y-2 text-sm">
          {tab === "WALLET" ? (
            <p>
              Wallet balance <strong className="tabular">{formatINR(memberMoney.walletBalance)}</strong> · uses <strong className="tabular">{formatINR(walletUse)}</strong>
            </p>
          ) : (
            tokenAcc && (
              <div className="flex flex-wrap items-center gap-2">
                <span>
                  {tokenAcc.balance} token{tokenAcc.balance === 1 ? "" : "s"} left · use
                </span>
                <select
                  aria-label="Tokens to use"
                  value={tokenCount}
                  onChange={(e) => setTokenCount(Number(e.target.value))}
                  className="rounded-lg border border-line bg-surface px-2 py-1 font-semibold"
                >
                  {Array.from({ length: Math.min(tokenAcc.balance, 10) }, (_, i) => i + 1).map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
                <span>
                  covers <strong className="tabular">{formatINR(tokenUse)}</strong>
                </span>
              </div>
            )
          )}
          {amount - (tab === "WALLET" ? walletUse : tokenUse) > 0 && (
            <label className="flex items-center gap-2">
              Pay the rest ({formatINR(amount - (tab === "WALLET" ? walletUse : tokenUse))}) by
              <select value={restMode} onChange={(e) => setRestMode(e.target.value as PaymentMode)} className="rounded-lg border border-line bg-surface px-2 py-1 font-semibold">
                {(["CASH", "UPI", "CARD"] as PaymentMode[]).map((m) => (
                  <option key={m} value={m}>
                    {PAYMENT_MODE_LABELS[m]}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}

      {tab === "KHATA" && (
        <div className="space-y-2 text-sm">
          {phone ? (
            <p>
              Add <strong className="tabular">{formatINR(amount)}</strong> to the credit account of <strong>+91 {phone}</strong>.
            </p>
          ) : (
            <Alert tone="warning">Khata (credit) needs a customer phone number on the bill. Close this dialog, add the customer, and charge again.</Alert>
          )}
        </div>
      )}

      {tab === "SPLIT" && (
        <div className="space-y-2">
          {split.map((row) => (
            <div key={row.id} className="flex items-center gap-2">
              <select
                aria-label="Payment mode"
                value={row.mode}
                onChange={(e) => setSplit((rows) => rows.map((r) => (r.id === row.id ? { ...r, mode: e.target.value as PaymentMode } : r)))}
                className="min-h-tap w-32 rounded-xl border border-line bg-surface px-3 font-semibold"
              >
                {(Object.keys(PAYMENT_MODE_LABELS) as PaymentMode[]).filter((m) => !SPLIT_HIDDEN.includes(m) && (m !== "WALLET" || (!!memberMoney && !offline))).map((m) => (
                  <option key={m} value={m}>
                    {PAYMENT_MODE_LABELS[m]}
                  </option>
                ))}
              </select>
              <Input
                wrapperClassName="flex-1"
                aria-label="Amount"
                inputMode="decimal"
                prefix="₹"
                className="tabular font-bold"
                value={row.amount}
                onChange={(e) => setSplit((rows) => rows.map((r) => (r.id === row.id ? { ...r, amount: e.target.value.replace(/[^\d.]/g, "") } : r)))}
              />
              <Button
                variant="outline"
                size="sm"
                disabled={splitRemaining <= 0}
                onClick={() =>
                  setSplit((rows) =>
                    rows.map((r) => (r.id === row.id ? { ...r, amount: rupeesInput((parseRupees(r.amount) ?? 0) + splitRemaining) } : r)),
                  )
                }
              >
                Rest
              </Button>
              <IconButton label="Remove" disabled={split.length <= 1} onClick={() => setSplit((rows) => rows.filter((r) => r.id !== row.id))}>
                <Trash size={20} />
              </IconButton>
            </div>
          ))}
          <div className="flex items-center justify-between pt-1">
            <Button
              variant="ghost"
              size="sm"
              icon={<Plus size={18} />}
              onClick={() => setSplit((rows) => [...rows, { id: Date.now(), mode: "CARD", amount: splitRemaining > 0 ? rupeesInput(splitRemaining) : "" }])}
            >
              Add payment
            </Button>
            <span className={clsx("tabular text-sm font-bold", splitRemaining === 0 ? "text-secondary dark:text-green-300" : "text-red-600")}>
              {splitRemaining === 0 ? "Balanced" : splitRemaining > 0 ? `${formatINR(splitRemaining)} remaining` : `${formatINR(-splitRemaining)} over`}
            </span>
          </div>
          {!offline && <p className="text-xs text-muted">UPI in a split is recorded as received (no QR).</p>}
        </div>
      )}
    </Dialog>
  );
}
