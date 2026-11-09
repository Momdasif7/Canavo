"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import clsx from "clsx";
import { ArrowLeft, Bag, Clock, CurrencyInr, HandCoins, Moped, QrCode, ShoppingCartSimple, Storefront, Tag } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { ApiError, errorMessage } from "@/lib/api";
import { publicCall, type DeliveryQuote, type OutletPage } from "@/lib/storefront";
import type { LatLng } from "@/components/delivery/map/DeliveryMap";
import { DeliveryPin } from "@/components/storefront/DeliveryPin";
import { AddressOnlyFields, type TypedAddress } from "@/components/storefront/DeliveryAddress";
import { forgetPhoneToken, PhoneVerify, savedPhoneToken } from "@/components/storefront/PhoneVerify";
import { useToast } from "@/components/providers/ToastProvider";
import { BillDetails, BrandStyle, CartBar, CartLines, EmptyCart, InfoChip, MenuSkeleton, StoreHero, StoreMenu, useCart, type BillRow } from "@/components/storefront/StoreMenu";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Input, Select, Textarea } from "@/components/ui/Input";
import { Alert, ErrorState } from "@/components/ui/States";

type OrderType = "TAKEAWAY" | "DELIVERY";
type Pay = "COUNTER" | "COD" | "UPI";
type Step = "cart" | "details" | "payment";
const PAY: Record<Pay, { label: string; hint: string; icon: React.ReactNode }> = {
  COUNTER: { label: "Pay at the counter", hint: "Cash, card or UPI when you collect", icon: <Storefront size={22} /> },
  COD: { label: "Cash on delivery", hint: "Pay the delivery partner at your door", icon: <HandCoins size={22} /> },
  UPI: { label: "Pay now with UPI", hint: "Any UPI app — QR on the next screen", icon: <QrCode size={22} /> },
};
const STEPS: { id: Step; label: string }[] = [
  { id: "cart", label: "Cart" },
  { id: "details", label: "Details" },
  { id: "payment", label: "Pay" },
];
const PIN_RE = /^[1-9]\d{5}$/;

/** Today's / tomorrow's pickup slots every 15 minutes from 20 minutes from now (local time of the phone). */
function timeSlots(): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  const start = new Date(Date.now() + 20 * 60_000);
  start.setMinutes(Math.ceil(start.getMinutes() / 15) * 15, 0, 0);
  for (let i = 0; i < 32; i++) {
    const d = new Date(start.getTime() + i * 15 * 60_000);
    out.push({ value: d.toISOString(), label: d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }) + (d.getDate() !== new Date().getDate() ? " (tomorrow)" : "") });
  }
  return out;
}

const range = (vals: number[], fmt: (n: number) => string) => {
  if (!vals.length) return null;
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  return lo === hi ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`;
};

/** Phase 6.4: the outlet's own online ordering page (takeaway / delivery) and digital menu. */
export default function OnlineOrderPage() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const toast = useToast();
  const [page, setPage] = useState<OutletPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [step, setStep] = useState<Step | null>(null);
  const [orderType, setOrderType] = useState<OrderType>("TAKEAWAY");
  const [when, setWhen] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [landmark, setLandmark] = useState("");
  const [typed, setTyped] = useState<TypedAddress>({ address: "", landmark: "", pincode: "", area: "" });
  const [zoneId, setZoneId] = useState("");
  const [payment, setPayment] = useState<Pay | "">("");
  const [notes, setNotes] = useState("");
  const [coupon, setCoupon] = useState("");
  const [placing, setPlacing] = useState(false);
  const [phoneToken, setPhoneToken] = useState<string | null>(null);
  const [pin, setPin] = useState<LatLng | null>(null);
  const [quote, setQuote] = useState<DeliveryQuote | null>(null);
  const [addrQuote, setAddrQuote] = useState<DeliveryQuote | null>(null);
  const [pickArea, setPickArea] = useState(false);
  const cart = useCart(`canavo.onlinecart.${slug}`);
  const { prune } = cart;
  const slots = useMemo(() => (step ? timeSlots() : []), [step]);

  const load = useCallback(async () => {
    try {
      const p = await publicCall<OutletPage>("GET", `/public/o/${slug}`);
      setPage(p);
      setError(null);
      document.title = `${p.outlet.name} · Order online`;
      if (!p.takeaway && p.delivery) setOrderType("DELIVERY");
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [slug]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (page) prune(page);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page]);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("canavo.customer") ?? "{}") as { name?: string; phone?: string; address?: string; landmark?: string; pincode?: string };
      setName(saved.name ?? "");
      setPhone(saved.phone ?? "");
      setAddress(saved.address ?? "");
      setLandmark(saved.landmark ?? "");
      setTyped((t) => ({ ...t, address: saved.address ?? "", landmark: saved.landmark ?? "", pincode: saved.pincode ?? "" }));
    } catch {
      /* ignore */
    }
  }, []);

  const payOptions = useMemo<Pay[]>(() => {
    if (!page) return [];
    const opts: Pay[] = [];
    if (orderType === "TAKEAWAY" && page.payments.COUNTER) opts.push("COUNTER");
    if (orderType === "DELIVERY" && page.payments.COD) opts.push("COD");
    if (page.payments.UPI) opts.push("UPI");
    return opts;
  }, [page, orderType]);
  // A verified number stays verified in this tab; a different number needs a new code.
  useEffect(() => {
    setPhoneToken(/^[6-9]\d{9}$/.test(phone.trim()) ? savedPhoneToken(slug, phone.trim()) : null);
  }, [phone, slug]);
  useEffect(() => {
    if (payment && !payOptions.includes(payment)) setPayment("");
    if (!payment && payOptions.length === 1) setPayment(payOptions[0]);
  }, [payOptions, payment]);
  // An emptied cart goes back to the cart step.
  useEffect(() => {
    if (step && step !== "cart" && cart.count === 0) setStep("cart");
  }, [cart.count, step]);

  if (error && !page)
    return (
      <main className="mx-auto max-w-md p-6">
        <ErrorState message={error} onRetry={load} />
      </main>
    );
  if (!page) return <MenuSkeleton />;

  const delivery = orderType === "DELIVERY";
  const addressOnly = page.deliveryMode === "ADDRESS";
  const flat = page.deliveryFlat ?? null;
  // Map pin when the outlet's location is known and the map works; otherwise the area picker.
  const usePin = delivery && !addressOnly && Boolean(page.location) && !pickArea;
  const zone = usePin ? (quote?.deliverable ? (quote.zone ?? undefined) : undefined) : page.zones.find((z) => z.id === zoneId);
  const deliveryFee = !delivery ? 0 : addressOnly ? (flat?.fee ?? 0) : zone ? zone.fee : page.zones.length ? null : 0;
  const deliveryMin = !delivery ? 0 : addressOnly ? (flat?.minOrder ?? 0) : (zone?.minOrder ?? 0);
  const minNeeded = Math.max(page.minOrder, deliveryMin);
  const phoneOk = /^[6-9]\d{9}$/.test(phone.trim());
  const deliveryAddress = addressOnly ? typed.address : address;

  const cartProblems = [cart.count === 0 && "Your cart is empty", cart.count > 0 && cart.total < minNeeded && `Add ${formatINR(minNeeded - cart.total)} more — minimum order is ${formatINR(minNeeded)}`].filter(Boolean) as string[];
  const detailProblems = [
    name.trim().length < 2 && "Enter your name",
    !phoneOk && "Enter a 10-digit mobile number",
    phoneOk && page.verifyPhone && !phoneToken && "Verify your mobile number with the code we text you",
    delivery && deliveryAddress.trim().length < 5 && "Enter your delivery address",
    delivery && addressOnly && !PIN_RE.test(typed.pincode) && "Enter your 6-digit PIN code",
    delivery && addressOnly && PIN_RE.test(typed.pincode) && !addrQuote && "Checking delivery…",
    delivery && addressOnly && addrQuote && !addrQuote.deliverable && (addrQuote.message ?? "We don't deliver there"),
    usePin && !pin && "Put the pin on the map where we should deliver",
    usePin && pin && !quote && "Checking delivery…",
    usePin && quote && !quote.deliverable && (quote.message ?? "We don't deliver there"),
    delivery && !addressOnly && !usePin && page.zones.length > 0 && !zoneId && "Choose your area",
  ].filter(Boolean) as string[];
  const payProblems = [!payment && "Choose how to pay"].filter(Boolean) as string[];
  const allProblems = [...cartProblems, ...detailProblems, ...payProblems];

  // Bill estimate (the server prices the order; offers apply automatically).
  const tax =
    page.outlet.gstEnabled && !page.outlet.pricesIncludeTax
      ? Math.round(cart.lines.reduce((s, l) => s + (l.unitPrice * l.quantity * (page.items.find((i) => i.id === l.menuItemId)?.gstRate ?? 0)) / 100, 0))
      : 0;
  const packaging = page.outlet.packagingCharge > 0 ? page.outlet.packagingCharge : 0;
  const billRows: BillRow[] = [
    { label: "Item total", amount: cart.total },
    ...(packaging ? [{ label: "Packaging", amount: packaging }] : []),
    ...(delivery ? [{ label: "Delivery fee", amount: deliveryFee, hint: deliveryFee === null ? "Set your location to see the fee" : undefined }] : []),
    ...(page.outlet.gstEnabled ? [page.outlet.pricesIncludeTax ? { label: "GST", amount: 0, hint: "Included in the prices" } : { label: "GST (estimated)", amount: tax }] : []),
    ...(page.offers?.length ? [{ label: "Offers", amount: null, hint: "Best offer applied automatically", tone: "discount" as const }] : []),
  ];
  const estTotal = cart.total + packaging + (deliveryFee ?? 0) + tax;

  const place = async () => {
    setPlacing(true);
    try {
      const r = await publicCall<{ token: string }>("POST", `/public/o/${slug}/orders`, {
        orderType,
        customerName: name.trim(),
        customerPhone: phone.trim(),
        phoneToken: page.verifyPhone ? (phoneToken ?? undefined) : undefined,
        pickupAt: when || undefined,
        payment,
        notes: notes.trim() || undefined,
        couponCode: coupon.trim() || undefined,
        items: cart.lines.map((l) => ({ menuItemId: l.menuItemId, variantId: l.variantId, addonIds: l.addonIds, quantity: l.quantity, notes: l.notes?.trim() || undefined })),
        delivery: !delivery
          ? undefined
          : addressOnly
            ? { address: typed.address.trim(), landmark: typed.landmark.trim() || undefined, pincode: typed.pincode.trim(), area: typed.area || undefined }
            : {
                address: address.trim(),
                landmark: landmark.trim() || undefined,
                ...(usePin && pin ? { latitude: Number(pin.lat.toFixed(6)), longitude: Number(pin.lng.toFixed(6)) } : { zoneId: zoneId || undefined }),
              },
      });
      try {
        localStorage.setItem(
          "canavo.customer",
          JSON.stringify({ name: name.trim(), phone: phone.trim(), address: deliveryAddress.trim(), landmark: (addressOnly ? typed.landmark : landmark).trim(), pincode: typed.pincode.trim() }),
        );
      } catch {
        /* ignore */
      }
      cart.clear();
      router.push(`/o/${slug}/order/${r.token}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) {
        // The verification expired: ask for a new code.
        forgetPhoneToken(slug);
        setPhoneToken(null);
        setStep("details");
      }
      toast(errorMessage(e), "error");
      void load();
    } finally {
      setPlacing(false);
    }
  };

  const types = [
    page.takeaway && { value: "TAKEAWAY" as const, label: "Pickup", icon: <Bag size={18} weight="bold" /> },
    page.delivery && { value: "DELIVERY" as const, label: "Delivery", icon: <Moped size={18} weight="bold" /> },
  ].filter(Boolean) as { value: OrderType; label: string; icon: React.ReactNode }[];
  const etaChip = delivery ? (addressOnly ? (flat ? `${flat.etaMinutes} min` : null) : (range(page.zones.map((z) => z.etaMinutes), String)?.concat(" min") ?? null)) : null;
  const feeChip = delivery
    ? addressOnly
      ? flat && (flat.fee ? `${formatINR(flat.fee)} delivery` : "Free delivery")
      : page.zones.length
        ? page.zones.every((z) => z.fee === 0)
          ? "Free delivery"
          : `${range(page.zones.map((z) => z.fee), formatINR)} delivery`
        : null
    : "No delivery fee";
  const statusText = page.hours ? `Orders ${page.hours.from}–${page.hours.to}` : page.ordering ? "Taking orders" : "Not taking orders now";

  const stepIndex = step ? STEPS.findIndex((s) => s.id === step) : -1;
  const footer =
    step === "cart" ? (
      cart.count > 0 && (
        <div className="w-full space-y-2">
          {cartProblems.length > 0 && <p className="text-sm font-medium text-amber-700 dark:text-amber-300">{cartProblems[0]}</p>}
          <Button block size="lg" disabled={cartProblems.length > 0} onClick={() => setStep("details")}>
            Continue · {formatINR(estTotal)}
          </Button>
        </div>
      )
    ) : step === "details" ? (
      <div className="w-full space-y-2">
        {detailProblems.length > 0 && <p className="text-sm text-muted">{detailProblems[0]}</p>}
        <Button block size="lg" disabled={detailProblems.length > 0 || cartProblems.length > 0} onClick={() => setStep("payment")}>
          Continue to payment
        </Button>
      </div>
    ) : (
      <div className="w-full space-y-2">
        {allProblems.length > 0 && <p className="text-sm text-muted">{allProblems[0]}</p>}
        <Button block size="lg" loading={placing} disabled={allProblems.length > 0} onClick={() => void place()} data-testid="place-order">
          Place order · {formatINR(estTotal)}
        </Button>
      </div>
    );

  return (
    <main className="min-h-screen bg-bg">
      <BrandStyle accent={page.outlet.accent} />
      <StoreHero brand={page.outlet} open={page.ordering} status={statusText} tagline={page.outlet.address} offers={page.offers}>
        {page.ordering && types.length > 1 && (
          <div role="tablist" aria-label="Order type" className="grid grid-cols-2 rounded-2xl bg-surface-2 p-1">
            {types.map((t) => (
              <button
                key={t.value}
                type="button"
                role="tab"
                aria-selected={orderType === t.value}
                onClick={() => setOrderType(t.value)}
                className={clsx("flex min-h-[44px] items-center justify-center gap-2 rounded-xl text-sm font-extrabold transition-all", orderType === t.value ? "bg-surface text-primary shadow-sm" : "text-muted hover:text-fg")}
              >
                {t.icon}
                {t.label}
              </button>
            ))}
          </div>
        )}
        {page.ordering && (
          <div className="flex flex-wrap gap-2">
            {etaChip && <InfoChip icon={<Clock size={14} weight="bold" className="text-primary" />}>{etaChip}</InfoChip>}
            {feeChip && <InfoChip icon={<CurrencyInr size={14} weight="bold" className="text-primary" />}>{feeChip}</InfoChip>}
            {minNeeded > 0 && <InfoChip icon={<Tag size={14} weight="bold" className="text-primary" />}>Min order {formatINR(minNeeded)}</InfoChip>}
            {types.length === 1 && <InfoChip icon={types[0].icon}>{types[0].value === "DELIVERY" ? "Delivery only" : "Pickup only"}</InfoChip>}
          </div>
        )}
      </StoreHero>

      <div className="mx-auto max-w-6xl px-4">
        {(page.notice || !page.ordering) && (
          <div className="mt-4" data-testid="store-notice">
            <Alert tone={page.ordering ? "info" : "warning"}>
              {page.notice ?? "We're not taking orders right now"}
              {!page.ordering && page.hours && ` — we take orders ${page.hours.from}–${page.hours.to}.`}
            </Alert>
          </div>
        )}
        <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_360px] lg:gap-8">
          <div className="min-w-0">
            <StoreMenu menu={page} brand={page.outlet} cart={cart} canOrder={page.ordering} closedLabel="Ordering closed" />
          </div>
          {page.ordering && (
            <aside className="hidden lg:block" aria-label="Your cart">
              <div className="sticky top-4 mt-4 rounded-3xl border border-line bg-surface p-4 shadow-sm">
                <h2 className="flex items-center gap-2 text-lg font-extrabold text-fg">
                  <ShoppingCartSimple size={22} weight="bold" className="text-primary" /> Your cart
                </h2>
                {cart.count === 0 ? (
                  <EmptyCart />
                ) : (
                  <>
                    <div className="max-h-[40vh] overflow-y-auto">
                      <CartLines cart={cart} menu={page} notes={false} />
                    </div>
                    <div className="mt-3">
                      <BillDetails rows={billRows} total={estTotal} />
                    </div>
                    {cartProblems.length > 0 && <p className="mt-2 text-sm font-medium text-amber-700 dark:text-amber-300">{cartProblems[0]}</p>}
                    <Button block size="lg" className="mt-3" disabled={cartProblems.length > 0} onClick={() => setStep("details")}>
                      Checkout
                    </Button>
                  </>
                )}
              </div>
            </aside>
          )}
        </div>
      </div>

      {page.ordering && <CartBar cart={cart} onOpen={() => setStep("cart")} />}

      <Dialog
        open={step !== null}
        onClose={() => setStep(null)}
        leading={
          stepIndex > 0 ? (
            <button type="button" aria-label="Back" onClick={() => setStep(STEPS[stepIndex - 1].id)} className="-ml-1 flex h-8 w-8 items-center justify-center rounded-full hover:bg-surface-2">
              <ArrowLeft size={20} />
            </button>
          ) : undefined
        }
        title={step === "cart" ? "Your cart" : step === "details" ? (delivery ? "Delivery details" : "Pickup details") : "Payment"}
        description={<StepDots index={stepIndex} />}
        footer={footer || undefined}
      >
        {cart.count === 0 ? (
          <EmptyCart onBrowse={() => setStep(null)} />
        ) : step === "cart" ? (
          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3 rounded-2xl border border-line p-3">
              <p className="flex items-center gap-2 text-sm font-bold text-fg">
                {delivery ? <Moped size={18} className="text-primary" /> : <Bag size={18} className="text-primary" />}
                {delivery ? "Delivery" : "Pickup"} from {page.outlet.name}
              </p>
              {types.length > 1 && (
                <button type="button" className="shrink-0 text-sm font-semibold text-primary" onClick={() => setOrderType(delivery ? "TAKEAWAY" : "DELIVERY")}>
                  Switch to {delivery ? "pickup" : "delivery"}
                </button>
              )}
            </div>
            <CartLines cart={cart} menu={page} />
            <Textarea label="Note for the restaurant (optional)" rows={2} maxLength={200} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. less spicy, no onion" />
            <Input
              label="Coupon code (optional)"
              maxLength={30}
              autoCapitalize="characters"
              value={coupon}
              onChange={(e) => setCoupon(e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, ""))}
              hint="Applied when you place the order: one offer per bill unless the coupon combines with offers"
            />
            <BillDetails
              rows={billRows}
              total={estTotal}
              note={<>Estimate — the restaurant&apos;s bill is final; offers and taxes are worked out when you place the order.{page.needsConfirmation ? " The restaurant confirms your order before cooking." : ""}</>}
            />
          </div>
        ) : step === "details" ? (
          <div className="space-y-5">
            <section className="space-y-3">
              <h3 className="text-xs font-extrabold uppercase tracking-wider text-muted">Contact</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <Input label="Your name" autoComplete="name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
                <Input label="Mobile number" inputMode="numeric" autoComplete="tel-national" prefix={<span className="text-sm">+91</span>} maxLength={10} value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))} />
              </div>
              {page.verifyPhone && <PhoneVerify slug={slug} phone={phone.trim()} token={phoneToken} onVerified={setPhoneToken} />}
            </section>
            {delivery && (
              <section className="space-y-3">
                <h3 className="text-xs font-extrabold uppercase tracking-wider text-muted">Delivery address</h3>
                {addressOnly ? (
                  <AddressOnlyFields
                    slug={slug}
                    value={typed}
                    onChange={(p) => {
                      setTyped((t) => ({ ...t, ...p }));
                      if (p.pincode !== undefined || p.area !== undefined) setAddrQuote(null);
                    }}
                    areas={flat?.areas ?? []}
                    fee={flat?.fee ?? 0}
                    etaMinutes={flat?.etaMinutes ?? 30}
                    quote={addrQuote}
                    onQuote={setAddrQuote}
                  />
                ) : (
                  <>
                    <Textarea label="House / flat, street, area" autoComplete="street-address" rows={2} maxLength={500} value={address} onChange={(e) => setAddress(e.target.value)} />
                    <Input label="Landmark (optional)" maxLength={200} value={landmark} onChange={(e) => setLandmark(e.target.value)} />
                    {usePin && (
                      <DeliveryPin
                        slug={slug}
                        page={page}
                        pin={pin}
                        onPin={(p) => {
                          setPin(p);
                          setQuote(null);
                        }}
                        quote={quote}
                        onQuote={setQuote}
                        onFallback={() => setPickArea(true)}
                      />
                    )}
                    {!usePin && page.zones.length > 0 && (
                      <Select label="Area" value={zoneId} onChange={(e) => setZoneId(e.target.value)}>
                        <option value="">Choose your area</option>
                        {page.zones.map((z) => (
                          <option key={z.id} value={z.id}>
                            {z.name} · {z.fee ? `delivery ${formatINR(z.fee)}` : "free delivery"} · ~{z.etaMinutes} min
                          </option>
                        ))}
                      </Select>
                    )}
                  </>
                )}
              </section>
            )}
            <Select label={delivery ? "Delivery time" : "Pickup time"} value={when} onChange={(e) => setWhen(e.target.value)}>
              <option value="">As soon as possible</option>
              {slots.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
          </div>
        ) : (
          <div className="space-y-4">
            <fieldset>
              <legend className="mb-2 text-xs font-extrabold uppercase tracking-wider text-muted">Pay with</legend>
              <div className="space-y-2">
                {payOptions.map((p) => (
                  <label
                    key={p}
                    className={clsx("flex min-h-[64px] cursor-pointer items-center gap-3 rounded-2xl border-2 px-3 transition-colors", payment === p ? "border-primary bg-primary-50 dark:bg-primary/10" : "border-line hover:border-primary/40")}
                  >
                    <span className={clsx("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", payment === p ? "bg-primary text-primary-fg" : "bg-surface-2 text-fg")}>{PAY[p].icon}</span>
                    <span className="flex-1">
                      <span className="block font-bold text-fg">{PAY[p].label}</span>
                      <span className="block text-xs text-muted">{PAY[p].hint}</span>
                    </span>
                    <input type="radio" name="pay" checked={payment === p} onChange={() => setPayment(p)} className="h-5 w-5 accent-primary" />
                  </label>
                ))}
                {payOptions.length === 0 && <Alert tone="warning">No payment option for {delivery ? "delivery" : "pickup"} — please call us.</Alert>}
              </div>
            </fieldset>
            <section className="rounded-2xl border border-line p-3 text-sm">
              <p className="font-bold text-fg">
                {name || "—"} · {phone || "—"}
              </p>
              <p className="mt-0.5 text-muted">
                {delivery
                  ? [deliveryAddress, addressOnly ? typed.area : null, addressOnly ? typed.landmark : landmark, addressOnly ? typed.pincode : null].filter((x) => x && x.trim()).join(", ")
                  : `Pickup from ${page.outlet.name}`}
                {" · "}
                {when ? slots.find((s) => s.value === when)?.label : "As soon as possible"}
              </p>
              <button type="button" className="mt-1 text-sm font-semibold text-primary" onClick={() => setStep("details")}>
                Change
              </button>
            </section>
            <BillDetails rows={billRows} total={estTotal} />
          </div>
        )}
      </Dialog>
    </main>
  );
}

function StepDots({ index }: { index: number }) {
  return (
    <span className="mt-1 flex items-center gap-1.5" aria-label={`Step ${index + 1} of 3`}>
      {STEPS.map((s, i) => (
        <span key={s.id} className="flex items-center gap-1.5">
          <span className={clsx("h-1.5 rounded-full transition-all", i <= index ? "w-6 bg-primary" : "w-3 bg-line")} />
          <span className={clsx("text-[11px] font-bold uppercase", i === index ? "text-fg" : "text-muted")}>{s.label}</span>
        </span>
      ))}
    </span>
  );
}
