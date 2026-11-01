"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePromotionPreview } from "@/hooks/usePromotionPreview";
import { WifiSlash } from "@phosphor-icons/react";
import { indianPhone, type OrderCreateInput } from "@canavo/shared";
import { api, errorMessage, isNetworkError } from "@/lib/api";
import { enqueueOrder, loadMenu, type QueuedPayment } from "@/lib/offline";
import { PAYMENT_MODE_LABELS, formatINR } from "@/lib/format";
import type { Menu, MenuItem, Order } from "@/lib/types";
import type { ActiveOffer, CustomerLookupResult, DeliveryAgent, DeliveryQuote, PromotionPreview } from "@/lib/types-service";
import { useSession } from "@/components/providers/SessionProvider";
import { useConnectivity } from "@/components/providers/ConnectivityProvider";
import { useSocketEvent } from "@/components/providers/SocketProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { useApproval } from "@/components/providers/ApprovalProvider";
import { useHotkeys } from "@/hooks/useHotkeys";
import { useDebouncedValue } from "@/hooks/useDebounced";
import { ErrorState, LoadingState } from "@/components/ui/States";
import { ItemPicker } from "@/components/pos/ItemPicker";
import { MenuBrowser } from "@/components/pos/MenuBrowser";
import { CartPanel, allowedOrderTypes, type CartTotals } from "@/components/pos/CartPanel";
import { CustomerCard, DeliveryFields, OffersBanner, PreOrderField, PromoFields } from "@/components/pos/PosExtras";
import { PaymentDialog, orderBalance, type Checkout } from "@/components/pos/PaymentDialog";
import { SuccessPanel, type Success } from "@/components/pos/SuccessPanel";
import { confirmForceAssign, partnerUnavailable } from "@/components/delivery/common";
import {
  EMPTY_META,
  addLine,
  clearSavedCart,
  deliveryCoords,
  freeBadge,
  isBlankCart,
  lineStockWarning,
  loadSavedCart,
  makeLine,
  metaError,
  parseDiscount,
  previewBill,
  reconcileFreeLines,
  saveCart,
  toOrderInput,
  toPreviewInput,
  type CartLine,
  type CartMeta,
  type DeliveryMeta,
} from "@/components/pos/cart";

const validPhone = (p: string) => indianPhone.safeParse(p).success;

export default function PosPage() {
  const { outletId, outlet, can, me, reloadOutlet } = useSession();
  // A manager changing GST / pricing on any device refreshes this screen's outlet settings.
  useSocketEvent("outlet:updated", () => void reloadOutlet());
  const { online } = useConnectivity();
  const toast = useToast();
  const withApproval = useApproval();

  // ----- Menu -----
  const [menu, setMenu] = useState<Menu | null>(null);
  const [menuError, setMenuError] = useState<string | null>(null);
  const [fromCache, setFromCache] = useState(false);

  const fetchMenu = useCallback(async () => {
    if (!outletId) return;
    try {
      const res = await loadMenu(outletId);
      setMenu(res.data);
      setFromCache(res.fromCache);
      setMenuError(null);
    } catch (e) {
      setMenuError(errorMessage(e));
    }
  }, [outletId]);

  useEffect(() => {
    setMenu(null);
    void fetchMenu();
  }, [fetchMenu]);

  useEffect(() => {
    if (online && fromCache) void fetchMenu();
  }, [online, fromCache, fetchMenu]);

  useSocketEvent("menu:changed", () => void fetchMenu());

  // ----- Active offers banner -----
  const [offers, setOffers] = useState<ActiveOffer[]>([]);
  const offersEnabled = !me?.modules || me.modules.includes("OFFERS");
  const fetchOffers = useCallback(async () => {
    // The Offers module may be off for this business (API answers 403): no banner then.
    if (!outletId || !offersEnabled) return;
    try {
      setOffers((await api.get<{ offers: ActiveOffer[] }>("/offers/active")).offers);
    } catch {
      /* banner is optional */
    }
  }, [outletId, offersEnabled]);
  useEffect(() => {
    void fetchOffers();
    const id = window.setInterval(() => void fetchOffers(), 5 * 60_000);
    return () => window.clearInterval(id);
  }, [fetchOffers]);
  useSocketEvent("offers:changed", () => void fetchOffers());

  // ----- Cart -----
  const [picker, setPicker] = useState<MenuItem | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [lines, setLines] = useState<CartLine[]>([]);
  const [meta, setMeta] = useState<CartMeta>(EMPTY_META);
  /** Offers whose auto-added free line the cashier deleted: not re-added until the cart is cleared */
  const [dismissedOffers, setDismissedOffers] = useState<string[]>([]);
  const [phoneError, setPhoneError] = useState<string | undefined>();
  const { error: discountError } = parseDiscount(meta);
  const blocker = metaError(meta);
  const qtyByItem = useMemo(() => {
    const m = new Map<string, number>();
    lines.forEach((l) => m.set(l.itemId, (m.get(l.itemId) ?? 0) + l.quantity));
    return m;
  }, [lines]);

  // One client UUID per bill attempt: re-charging an unchanged cart is idempotent server-side.
  // Flipping the COD toggle keeps the same bill (it's marked COD after creation if needed).
  // Kept with the saved cart, so charging a restored cart again returns the same bill.
  const attemptKey = useMemo(() => JSON.stringify([lines, { ...meta, delivery: { ...meta.delivery, cod: false } }]), [lines, meta]);
  const attempt = useRef<{ key: string; id: string | null }>({ key: "", id: null });
  const [attemptStamp, setAttemptStamp] = useState(0);
  const clientOrderIdFor = (key: string) => {
    if (attempt.current.key !== key || !attempt.current.id) {
      attempt.current = { key, id: crypto.randomUUID() };
      setAttemptStamp((n) => n + 1);
    }
    return attempt.current.id!;
  };

  const selectItem = useCallback((item: MenuItem) => {
    if (item.variants.length || item.addons.length) setPicker(item);
    else setLines((ls) => addLine(ls, makeLine(item)));
  }, []);

  /** Deleting an auto-added free line dismisses that offer until the cart is cleared. */
  const removeLine = useCallback(
    (key: string) => {
      const line = lines.find((l) => l.key === key);
      if (line?.free) setDismissedOffers((d) => (d.includes(line.free!.offerId) ? d : [...d, line.free!.offerId]));
      setLines((ls) => ls.filter((l) => l.key !== key));
    },
    [lines],
  );

  const patchMeta = useCallback((patch: Partial<CartMeta>) => {
    setMeta((m) => ({ ...m, ...patch }));
    if ("customerPhone" in patch) setPhoneError(undefined);
  }, []);
  const patchDelivery = useCallback((patch: Partial<DeliveryMeta>) => setMeta((m) => ({ ...m, delivery: { ...m.delivery, ...patch } })), []);

  // ----- Customer lookup -----
  const [lookup, setLookup] = useState<CustomerLookupResult | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const phone = useDebouncedValue(meta.customerPhone.trim(), 300);
  const canLookup = can("customer:view");
  useEffect(() => {
    setLookup(null);
    if (!validPhone(phone) || !online || !canLookup) return;
    let cancelled = false;
    setLookingUp(true);
    api
      .get<CustomerLookupResult>("/customers/lookup", { query: { phone } })
      .then((res) => {
        if (cancelled) return;
        setLookup(res);
        if (res.found && res.name) setMeta((m) => (m.customerPhone.trim() === phone && !m.customerName.trim() ? { ...m, customerName: res.name ?? "" } : m));
      })
      .catch(() => !cancelled && setLookup(null))
      .finally(() => !cancelled && setLookingUp(false));
    return () => {
      cancelled = true;
    };
  }, [phone, online, canLookup]);

  // Points only make sense for the looked-up customer.
  // (Cleared once the lookup answers "not found" or the phone is removed — not while a restored cart is still looking up.)
  useEffect(() => {
    if (meta.redeemPoints && ((lookup && !lookup.found) || !meta.customerPhone.trim())) setMeta((m) => ({ ...m, redeemPoints: "" }));
  }, [lookup, meta.redeemPoints, meta.customerPhone]);

  // ----- Delivery quote & agents -----
  const isDelivery = meta.orderType === "DELIVERY";
  /** Cash on Delivery chosen in the cart (offline bills can't be COD — they stay unpaid as usual) */
  const codActive = isDelivery && online && meta.delivery.cod;
  const coords = deliveryCoords(meta.delivery);
  const coordKey = useDebouncedValue(coords ? `${coords.lat},${coords.lng}` : "", 400);
  const [quote, setQuote] = useState<DeliveryQuote | null>(null);
  const [quoteLoading, setQuoteLoading] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [agents, setAgents] = useState<DeliveryAgent[] | null>(null);
  const [agentsStamp, setAgentsStamp] = useState(0);
  useEffect(() => {
    if (!isDelivery || !online) return;
    let cancelled = false;
    const [lat, lng] = coordKey ? coordKey.split(",") : [undefined, undefined];
    setQuoteLoading(true);
    setQuoteError(null);
    api
      .get<DeliveryQuote>("/delivery/quote", { query: { lat, lng } })
      .then((q) => !cancelled && setQuote(q))
      .catch((e) => !cancelled && setQuoteError(errorMessage(e)))
      .finally(() => !cancelled && setQuoteLoading(false));
    return () => {
      cancelled = true;
    };
  }, [isDelivery, coordKey, online]);
  // Who's on duty decides auto-assignment: refresh while the delivery form is open.
  useEffect(() => {
    if (!isDelivery || !online) return;
    let cancelled = false;
    api
      .get<DeliveryAgent[]>("/delivery/agents")
      .then((a) => !cancelled && setAgents(a))
      .catch(() => !cancelled && setAgents((cur) => cur ?? []));
    const id = window.setTimeout(() => setAgentsStamp((n) => n + 1), 60_000);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [isDelivery, online, agentsStamp]);
  useSocketEvent("delivery:updated", () => isDelivery && setAgentsStamp((n) => n + 1));

  // ----- Local bill (offline fallback) -----
  const localCharges = useMemo(() => {
    const out: { label: string; amount: number }[] = [];
    if ((meta.orderType === "TAKEAWAY" || isDelivery) && outlet?.packagingCharge) out.push({ label: "Packaging", amount: outlet.packagingCharge });
    if (isDelivery && quote) {
      const zone = coords ? quote.zone : quote.zones.find((z) => z.id === meta.delivery.zoneId);
      if (zone?.fee) out.push({ label: "Delivery fee", amount: zone.fee });
    }
    return out;
  }, [meta.orderType, isDelivery, outlet?.packagingCharge, quote, coords, meta.delivery.zoneId]);
  const localBill = useMemo(() => previewBill(lines, outlet, meta, localCharges), [lines, outlet, meta, localCharges]);
  /** Auto-added offer lines are discounted in the local estimate too (the server does the same when billed) */
  const localApplied = useMemo(
    () =>
      lines
        .filter((l) => l.free)
        .map((l) => ({ kind: "OFFER", label: freeBadge(l.free!), amount: Math.round((l.unitPrice * l.quantity * Math.min(100, l.free!.percent)) / 100) })),
    [lines],
  );

  // ----- Server promotions preview -----
  const phoneTyped = meta.customerPhone.trim();
  /** Totals can be exact only when every detail the server prices on is complete */
  const exactDetails = !blocker && (!phoneTyped || validPhone(phoneTyped));
  // The preview runs even while details are incomplete (the server reports them as warnings),
  // so free-item suggestions and coupon feedback appear as soon as items are added.
  const previewInput = useMemo<OrderCreateInput | null>(() => (discountError ? null : toPreviewInput(lines, meta, validPhone)), [lines, meta, discountError]);
  // Tax-relevant outlet settings are part of the key, so toggling GST re-prices an open cart.
  const settingsStamp = outlet
    ? [outlet.gstEnabled, outlet.pricesIncludeTax, outlet.compositionScheme, outlet.serviceChargeEnabled, outlet.serviceChargePercent, outlet.packagingCharge, outlet.roundOff].join("|")
    : "";
  const previewKey = previewInput ? JSON.stringify({ settings: settingsStamp, body: previewInput }) : null;
  const main = usePromotionPreview(previewKey, online);

  // Free-item suggestions must be computed for the cart *without* the auto-added lines,
  // so each suggestion carries the full number of free units the cart earns.
  const baseLines = useMemo(() => lines.filter((l) => !l.free), [lines]);
  const hasFree = baseLines.length !== lines.length;
  const baseKey = useMemo(() => {
    if (!hasFree || discountError) return null;
    const input = toPreviewInput(baseLines, meta, validPhone);
    return input ? JSON.stringify({ settings: settingsStamp, body: input }) : null;
  }, [hasFree, baseLines, meta, discountError, settingsStamp]);
  const probe = usePromotionPreview(baseKey, online);
  const suggestionSource = !online
    ? null
    : hasFree
      ? probe.result && probe.result.key === baseKey
        ? probe.result.data
        : null
      : main.result && main.result.key === previewKey
        ? main.result.data
        : null;

  useEffect(() => {
    if (!menu) return;
    // Only free lines left (the qualifying items were removed): drop them.
    if (hasFree && !baseLines.length) return setLines((ls) => ls.filter((l) => !l.free));
    if (!suggestionSource) return; // offline / waiting: leave the cart as it is
    setLines((ls) => reconcileFreeLines(ls, suggestionSource.suggestions ?? [], dismissedOffers, menu.items) ?? ls);
  }, [suggestionSource, dismissedOffers, menu, hasFree, baseLines.length]);

  const currentErr = main.error && main.error.key === previewKey ? main.error.message : null;
  // Keep showing the last server totals while a newer preview is pending (avoids flicker).
  const pending = main.pending;
  const fresh = !!main.result && main.result.key === previewKey;
  // Never reuse totals priced under different outlet settings (e.g. right after GST is switched off).
  const previewSettings = main.result ? (JSON.parse(main.result.key) as { settings: string }).settings : null;
  const usable = online && !!previewKey && !!main.result && !currentErr && (fresh || (pending && previewSettings === settingsStamp));
  const serverPreview = usable && exactDetails ? main.result!.data : null;
  // Coupon / points problems come back as warnings while the rest of the bill is still priced.
  const warnings = usable ? (main.result!.data.warnings ?? []) : [];
  const couponWarnings = warnings.filter((w) => /coupon/i.test(w));
  const pointsWarnings = warnings.filter((w) => !/coupon/i.test(w) && /point/i.test(w));
  const otherWarnings = exactDetails ? warnings.filter((w) => !couponWarnings.includes(w) && !pointsWarnings.includes(w)) : [];
  // Older APIs answer 400 for coupon / points problems instead.
  const couponError = couponWarnings.join(" · ") || (currentErr && /coupon/i.test(currentErr) ? currentErr : null) || null;
  const pointsError = pointsWarnings.join(" · ") || (currentErr && !couponError && /point/i.test(currentErr) ? currentErr : null) || null;
  /** Charging with a rejected coupon / points would fail at the server: fix it first */
  const promoBlocker = online && meta.couponCode.trim() && couponError ? "Fix or remove the coupon to charge" : online && pointsError && meta.redeemPoints.trim() ? "Fix the points to redeem" : null;
  /** Lines whose item / size ran out (e.g. a restored cart, or the bill was refused): line key → warning */
  const stockWarnings = useMemo(() => {
    const m = new Map<string, string>();
    if (!menu) return m;
    for (const l of lines) {
      const w = lineStockWarning(l, menu.items);
      if (w) m.set(l.key, w);
    }
    return m;
  }, [lines, menu]);
  const stockBlocker = stockWarnings.size ? "Remove the out-of-stock items to charge" : null;
  const chargeBlocker = blocker ?? stockBlocker ?? promoBlocker;

  // GST: never show tax rows for an outlet that isn't GST registered or a plain BILL — including
  // the local fallback, a stale outlet and the first render before the outlet has loaded.
  const docType = serverPreview?.bill.documentType ?? (outlet ? localBill.documentType : usable ? main.result!.data.bill.documentType : "BILL");
  const showTax = docType === "TAX_INVOICE" && outlet?.gstEnabled !== false;
  const shownDocType = showTax ? "TAX_INVOICE" : docType === "BILL_OF_SUPPLY" && outlet?.gstEnabled !== false ? "BILL_OF_SUPPLY" : "BILL";
  const noTax = { cgst: 0, sgst: 0, igst: 0, cess: 0, otherTaxes: 0, taxDetails: [] };

  const totals: CartTotals = serverPreview
    ? {
        source: "server",
        documentType: shownDocType,
        subtotal: serverPreview.bill.subtotal,
        discount: serverPreview.bill.discount,
        serviceCharge: serverPreview.bill.serviceCharge,
        charges: serverPreview.charges,
        cgst: serverPreview.bill.cgst,
        sgst: serverPreview.bill.sgst,
        igst: serverPreview.bill.igst,
        cess: serverPreview.bill.cess,
        otherTaxes: serverPreview.bill.otherTaxes,
        taxDetails: serverPreview.bill.taxDetails,
        roundOff: serverPreview.bill.roundOff,
        grandTotal: serverPreview.bill.grandTotal,
        applied: serverPreview.applied,
        ...(showTax ? {} : noTax),
      }
    : {
        source: "local",
        documentType: shownDocType,
        subtotal: localBill.subtotal,
        discount: localBill.discount,
        serviceCharge: localBill.serviceCharge,
        charges: localCharges,
        cgst: localBill.cgst,
        sgst: localBill.sgst,
        igst: localBill.igst,
        cess: localBill.cess,
        otherTaxes: localBill.otherTaxes,
        taxDetails: localBill.taxDetails,
        roundOff: localBill.roundOff,
        grandTotal: localBill.grandTotal,
        applied: localApplied,
        ...(showTax ? {} : noTax),
      };
  const previewNote = !online
    ? "Offline — estimated locally, no promotions"
    : blocker
      ? "Estimated locally — complete the order details for exact totals"
      : currentErr && !couponError && !pointsError
        ? currentErr
        : couponError || pointsError
          ? "Fix the promotion to see exact totals"
          : null;

  // Max points: maxRedeemPercent of the pre-tax, post-discount bill (before points).
  const maxPoints = useMemo(() => {
    if (!lookup?.found || !lookup.loyalty) return null;
    const base = serverPreview ? serverPreview.bill.subtotal - serverPreview.bill.discount + serverPreview.pointsValue : localBill.subtotal - localBill.discount;
    return Math.max(0, Math.floor((base * lookup.loyalty.maxRedeemPercent) / 100 / lookup.loyalty.pointValuePaise));
  }, [lookup, serverPreview, localBill]);

  // ----- Checkout -----
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [success, setSuccess] = useState<Success | null>(null);
  const [charging, setCharging] = useState(false);
  const pendingInput = useRef<{ input: OrderCreateInput; previewTotal: number } | null>(null);

  const userId = me?.id ?? null;
  const resetBill = useCallback(() => {
    setLines([]);
    setMeta((m) => ({ ...EMPTY_META, orderType: m.orderType }));
    setDismissedOffers([]);
    setPhoneError(undefined);
    setSuccess(null);
    setCheckout(null);
    setLookup(null);
    pendingInput.current = null;
    if (userId && outletId) clearSavedCart(userId, outletId);
    searchRef.current?.focus();
  }, [userId, outletId]);

  // ----- Keep the in-progress bill across navigation / reloads (per user + outlet) -----
  const cartOwner = userId && outletId ? `${userId}:${outletId}` : null;
  const [hydratedFor, setHydratedFor] = useState<string | null>(null);
  useEffect(() => {
    // A cart belongs to one user in one outlet: restore theirs (or start fresh) on mount / switch.
    setQuote(null);
    setAgents(null);
    setSuccess(null);
    setCheckout(null);
    setLookup(null);
    setPhoneError(undefined);
    pendingInput.current = null;
    const saved = userId && outletId ? loadSavedCart(userId, outletId) : null;
    setLines(saved?.lines ?? []);
    setMeta(saved?.meta ?? EMPTY_META);
    setDismissedOffers(saved?.dismissedOffers ?? []);
    attempt.current = saved?.attempt ?? { key: "", id: null };
    setHydratedFor(userId && outletId ? `${userId}:${outletId}` : null);
  }, [userId, outletId]);

  useEffect(() => {
    if (!cartOwner || hydratedFor !== cartOwner || !userId || !outletId) return;
    // Charged: the bill is done — never bring it back.
    if (success) return clearSavedCart(userId, outletId);
    if (isBlankCart(lines, meta, dismissedOffers)) return clearSavedCart(userId, outletId);
    saveCart({ userId, outletId, lines, meta, dismissedOffers, attempt: attempt.current.key === attemptKey ? attempt.current : undefined });
  }, [cartOwner, hydratedFor, userId, outletId, success, lines, meta, dismissedOffers, attemptKey, attemptStamp]);

  const charge = async () => {
    if (!lines.length || charging || checkout || success || discountError || chargeBlocker) return;
    const p = meta.customerPhone.trim();
    if (p) {
      const res = indianPhone.safeParse(p);
      if (!res.success) {
        setPhoneError(res.error.issues[0].message);
        return;
      }
    }
    const clientOrderId = clientOrderIdFor(attemptKey);
    // Offline bills are priced locally without promotions, so don't send coupon/points.
    const input = toOrderInput(lines, meta, clientOrderId, online, codActive);
    pendingInput.current = { input: toOrderInput(lines, meta, clientOrderId, false), previewTotal: localBill.grandTotal };

    if (!online) {
      setCheckout({ kind: "offline", total: localBill.grandTotal, customerPhone: input.customerPhone });
      return;
    }
    setCharging(true);
    try {
      let order: Order;
      // A discount above the outlet's limit asks for a manager's PIN, then retries (APPROVAL_PINS).
      const create = (body: typeof input) => withApproval((approval) => api.post<Order>("/orders", { ...body, approval }));
      try {
        order = await create(input);
      } catch (e) {
        // The chosen partner can't take another order: managers / owners may assign anyway.
        const blocked = partnerUnavailable(e);
        if (!blocked?.canForce || !input.delivery || !confirmForceAssign(blocked.message)) throw e;
        order = await create({ ...input, delivery: { ...input.delivery, forceAssign: true } });
      }
      if (serverPreview && order.grandTotal !== serverPreview.bill.grandTotal) {
        toast(`Final total ${formatINR(order.grandTotal)} differs from the preview (${formatINR(serverPreview.bill.grandTotal)})`, "info");
      }
      // Re-charging an earlier unpaid attempt returns that bill as it was: mark it COD now.
      if (codActive && order.status === "OPEN" && !order.delivery?.cod) {
        try {
          order = await api.post<Order>(`/orders/${order.id}/cod`, {});
        } catch (e) {
          toast(`Could not mark ${order.invoiceNumber} as Cash on Delivery: ${errorMessage(e)}`, "error");
        }
      }
      if (order.orderType === "DELIVERY" && order.delivery && !input.delivery?.agentId) {
        toast(
          order.delivery.agent
            ? `${order.invoiceNumber}: auto-assigned to ${order.delivery.agent.name}`
            : `${order.invoiceNumber}: waiting — will be auto-assigned when a partner is back at the outlet`,
          order.delivery.agent ? "success" : "info",
        );
      }
      if (order.status === "PAID") setSuccess({ kind: "online", order, change: 0 });
      else if (codActive && order.delivery?.cod) setSuccess({ kind: "cod", order });
      else setCheckout({ kind: "online", order });
    } catch (e) {
      if (isNetworkError(e)) setCheckout({ kind: "offline", total: localBill.grandTotal, customerPhone: input.customerPhone });
      else {
        toast(errorMessage(e), "error");
        // "Vada Pav is out of stock (Pav buns ran out)": refresh the menu so the line gets flagged.
        if (/out of stock/i.test(errorMessage(e))) void fetchMenu();
      }
    } finally {
      setCharging(false);
    }
  };

  const closeCheckout = () => {
    if (checkout?.kind === "online") {
      const o = checkout.order;
      const where =
        o.orderType === "DELIVERY"
          ? can("bills:view")
            ? "collect it from Bills, or mark it Cash on Delivery there"
            : "choose Cash on Delivery to have the partner collect it"
          : can("bills:view")
            ? "collect it later from Bills"
            : "collect it later";
      toast(`Bill ${o.invoiceNumber} kept unpaid — ${where}`, "info");
    }
    setCheckout(null);
  };

  const paidOnline = (order: Order, change: number) => {
    setCheckout(null);
    setSuccess({ kind: "online", order, change });
  };

  /** Marked Cash on Delivery from the payment dialog: nothing paid now. */
  const placedCod = (order: Order) => {
    setCheckout(null);
    setSuccess({ kind: "cod", order });
  };

  const paidOffline = async (payments: QueuedPayment[], tendered: number | undefined, change: number) => {
    const pending = pendingInput.current;
    if (!pending || !outletId) return;
    const createdAt = new Date().toISOString();
    try {
      await enqueueOrder({
        clientOrderId: pending.input.clientOrderId!,
        outletId,
        order: { ...pending.input, createdAt },
        payments,
        tendered,
        previewTotal: pending.previewTotal,
        createdAt,
      });
      setCheckout(null);
      setSuccess({
        kind: "offline",
        clientOrderId: pending.input.clientOrderId!,
        total: payments.reduce((s, x) => s + x.amount, 0),
        change,
        modes: [...new Set(payments.map((x) => PAYMENT_MODE_LABELS[x.mode]))],
      });
      toast("No connection — bill saved on this device. It will reach the kitchen (KOT) automatically when the connection is back.", "info");
    } catch {
      toast("Could not save the bill on this device (storage unavailable)", "error");
    }
  };

  /** Connection dropped after the bill was created: queue it (same clientOrderId) so sync settles it. */
  const wentOffline = () => {
    if (checkout?.kind !== "online") return;
    setCheckout({ kind: "offline", total: orderBalance(checkout.order), customerPhone: checkout.order.customerPhone ?? undefined });
  };

  // ----- Shortcuts -----
  useHotkeys({
    F2: () => resetBill(),
    "/": () => searchRef.current?.focus(),
    F10: () => {
      if (success) document.querySelector<HTMLButtonElement>("[data-print-button]")?.click();
      else if (!checkout) void charge();
    },
  });

  if (!outletId) return <ErrorState message="You are not assigned to any outlet." />;
  if (menuError && !menu) return <ErrorState message={menuError} onRetry={fetchMenu} />;
  if (!menu) return <LoadingState label="Loading menu…" />;

  const details = (
    <>
      <CustomerCard lookup={lookup} loading={lookingUp} />
      {isDelivery && (
        <DeliveryFields
          delivery={meta.delivery}
          onChange={patchDelivery}
          quote={quote}
          quoteLoading={quoteLoading}
          quoteError={quoteError}
          agents={agents}
          codAvailable={online}
          codAmount={totals.grandTotal}
          outlet={outlet?.latitude != null && outlet?.longitude != null ? { lat: outlet.latitude, lng: outlet.longitude } : null}
        />
      )}
      {meta.orderType === "PRE_ORDER" && <PreOrderField value={meta.scheduledFor} onChange={(scheduledFor) => patchMeta({ scheduledFor })} />}
    </>
  );
  const hasDetails = lookingUp || !!lookup || isDelivery || meta.orderType === "PRE_ORDER";

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      {/* Menu side */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {(!online || fromCache) && (
          <div className="flex items-center gap-2 bg-red-600 px-4 py-2 text-sm font-semibold text-white">
            <WifiSlash size={18} />
            {online ? "Showing saved menu — reconnecting…" : "Offline — bills are saved on this device and sync automatically"}
          </div>
        )}
        <MenuBrowser menu={menu} qtyByItem={qtyByItem} onSelect={selectItem} timezone={outlet?.timezone} searchRef={searchRef} header={<OffersBanner offers={offers} />} />
      </div>

      {/* Cart side */}
      <div className="h-[60vh] shrink-0 border-t border-line md:h-auto md:w-[380px] md:border-l md:border-t-0 xl:w-[430px]">
        <CartPanel
          orderTypes={allowedOrderTypes(me?.modules)}
          lines={lines}
          stockWarnings={stockWarnings}
          meta={meta}
          totals={totals}
          previewing={!!previewKey && online && pending}
          previewNote={previewNote}
          notices={otherWarnings}
          discountError={discountError}
          phoneError={phoneError}
          serviceChargePercent={outlet?.serviceChargePercent ?? 0}
          charging={charging}
          chargeBlocker={chargeBlocker}
          codOrder={codActive}
          details={hasDetails ? details : undefined}
          promotions={
            <PromoFields
              meta={meta}
              onMeta={patchMeta}
              lookup={lookup}
              maxPoints={maxPoints}
              couponError={couponError}
              pointsError={pointsError}
              disabledReason={online ? null : "Coupons and points need a connection."}
            />
          }
          onMeta={patchMeta}
          onQty={(key, qty) => (qty <= 0 ? removeLine(key) : setLines((ls) => ls.map((l) => (l.key === key ? { ...l, quantity: Math.min(999, qty) } : l))))}
          onNotes={(key, notes) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, notes } : l)))}
          onRemove={removeLine}
          onClear={resetBill}
          onCharge={() => void charge()}
        />
      </div>

      <ItemPicker item={picker} onClose={() => setPicker(null)} onAdd={(line) => setLines((ls) => addLine(ls, line))} />
      <PaymentDialog checkout={checkout} onClose={closeCheckout} onPaidOnline={paidOnline} onPaidOffline={paidOffline} onWentOffline={wentOffline} onCod={can("payment:collect") ? placedCod : undefined} />
      <SuccessPanel success={success} onNewBill={resetBill} />
    </div>
  );
}
