"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import clsx from "clsx";
import { ArrowRight, Moped, ShoppingBag } from "@phosphor-icons/react";
import { checkDeliveryArea, formatINR, PINCODE_RE } from "@canavo/shared";
import { ApiError, errorMessage } from "@/lib/api";
import { publicCall, type DeliveryQuote, type OutletPage } from "@/lib/storefront";
import type { LatLng } from "@/components/delivery/map/DeliveryMap";
import { DeliveryPin } from "@/components/storefront/DeliveryPin";
import { forgetPhoneToken, PhoneVerify, savedPhoneToken } from "@/components/storefront/PhoneVerify";
import type { Cart } from "@/components/storefront/StoreMenu";
import { useToast } from "@/components/providers/ToastProvider";
import { Input, Select, Textarea } from "@/components/ui/Input";
import { Spinner } from "@/components/ui/Spinner";
import { BottomSheet } from "./BottomSheet";
import { Stepper } from "./OnlineMenu";

type OrderType = "TAKEAWAY" | "DELIVERY";
type Pay = "COUNTER" | "COD" | "UPI";
const PAY_LABEL: Record<Pay, string> = { COUNTER: "Pay at the counter", COD: "Cash on delivery", UPI: "Pay now with UPI" };
const CUSTOMER_KEY = "canavo.customer";

/** Pickup / delivery slots every 15 minutes from 20 minutes from now (phone's local time). */
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

/** "2 items | ₹340 · View cart" bar at the bottom of the phone screen. */
export function FloatingCartBar({ cart, onOpen }: { cart: Cart; onOpen: () => void }) {
  if (!cart.count) return null;
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 px-3 lg:hidden" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
      <button
        type="button"
        onClick={onOpen}
        data-testid="cart-bar"
        className="mx-auto flex h-14 w-full max-w-xl items-center justify-between gap-3 rounded-2xl bg-primary px-4 font-bold text-primary-fg shadow-xl hover:bg-primary-600"
      >
        <span className="tabular-nums">
          {cart.count} item{cart.count === 1 ? "" : "s"} | {formatINR(cart.total)}
        </span>
        <span className="flex items-center gap-1.5">
          View cart <ArrowRight size={18} weight="bold" />
        </span>
      </button>
    </div>
  );
}

/** Cart lines with steppers and per-item kitchen notes. */
export function CartItems({ cart, compact = false }: { cart: Cart; compact?: boolean }) {
  return (
    <ul className="divide-y divide-line">
      {cart.lines.map((l) => (
        <li key={l.key} className="py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-semibold text-fg">{l.name}</p>
              <p className="text-sm tabular-nums text-muted">{formatINR(l.unitPrice * l.quantity)}</p>
            </div>
            <Stepper size="sm" value={l.quantity} label={l.name} onMinus={() => cart.setQty(l.key, l.quantity - 1)} onPlus={() => cart.setQty(l.key, l.quantity + 1)} plusDisabled={l.quantity >= 20} />
          </div>
          {!compact && (
            <input
              aria-label={`Note for ${l.name}`}
              placeholder="Note for the kitchen (optional)"
              maxLength={120}
              value={l.notes ?? ""}
              onChange={(e) => cart.setNotes(l.key, e.target.value)}
              className="mt-2 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg placeholder:text-muted focus:border-primary focus:outline-none"
            />
          )}
        </li>
      ))}
    </ul>
  );
}

/** Desktop: the cart beside the menu. */
export function CartPanel({ cart, onCheckout, canOrder }: { cart: Cart; onCheckout: () => void; canOrder: boolean }) {
  return (
    <aside className="sticky top-4 hidden rounded-3xl border border-line bg-surface p-5 lg:block" aria-label="Your cart">
      <h2 className="text-lg font-extrabold text-fg">Your cart</h2>
      {cart.count === 0 ? (
        <div className="py-10 text-center text-muted">
          <ShoppingBag size={40} className="mx-auto opacity-50" aria-hidden />
          <p className="mt-2 text-sm">{canOrder ? "Add dishes from the menu." : "Ordering is closed right now."}</p>
        </div>
      ) : (
        <>
          <div className="max-h-[50vh] overflow-y-auto">
            <CartItems cart={cart} compact />
          </div>
          <div className="mt-3 flex justify-between border-t border-line pt-3 font-bold text-fg">
            <span>Item total</span>
            <span className="tabular-nums">{formatINR(cart.total)}</span>
          </div>
          <button type="button" onClick={onCheckout} className="mt-4 flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-primary font-extrabold text-primary-fg hover:bg-primary-600">
            Checkout <ArrowRight size={18} weight="bold" />
          </button>
        </>
      )}
    </aside>
  );
}

/** Cart & checkout: order type, time, contact, OTP, address (map or typed), payment, place order. */
export function CheckoutSheet({ open, onClose, slug, page, cart, reload }: { open: boolean; onClose: () => void; slug: string; page: OutletPage; cart: Cart; reload: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [orderType, setOrderType] = useState<OrderType>(!page.takeaway && page.delivery ? "DELIVERY" : "TAKEAWAY");
  const [when, setWhen] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [landmark, setLandmark] = useState("");
  const [pincode, setPincode] = useState("");
  const [area, setArea] = useState("");
  const [zoneId, setZoneId] = useState("");
  const [payment, setPayment] = useState<Pay | "">("");
  const [notes, setNotes] = useState("");
  const [placing, setPlacing] = useState(false);
  const [phoneToken, setPhoneToken] = useState<string | null>(null);
  const [pin, setPin] = useState<LatLng | null>(null);
  const [quote, setQuote] = useState<DeliveryQuote | null>(null);
  const [pickArea, setPickArea] = useState(false);
  const slots = useMemo(() => (open ? timeSlots() : []), [open]);

  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(CUSTOMER_KEY) ?? "{}") as { name?: string; phone?: string; address?: string; landmark?: string; pincode?: string };
      setName(saved.name ?? "");
      setPhone(saved.phone ?? "");
      setAddress(saved.address ?? "");
      setLandmark(saved.landmark ?? "");
      setPincode(saved.pincode ?? "");
    } catch {
      /* ignore */
    }
  }, []);
  // A verified number stays verified in this tab; a different number needs a new code.
  useEffect(() => {
    setPhoneToken(/^[6-9]\d{9}$/.test(phone.trim()) ? savedPhoneToken(slug, phone.trim()) : null);
  }, [phone, slug]);

  const payOptions = useMemo<Pay[]>(() => {
    const opts: Pay[] = [];
    if (orderType === "TAKEAWAY" && page.payments.COUNTER) opts.push("COUNTER");
    if (orderType === "DELIVERY" && page.payments.COD) opts.push("COD");
    if (page.payments.UPI) opts.push("UPI");
    return opts;
  }, [page, orderType]);
  useEffect(() => {
    if (payment && !payOptions.includes(payment)) setPayment("");
    if (!payment && payOptions.length === 1) setPayment(payOptions[0]);
  }, [payOptions, payment]);

  const delivery = orderType === "DELIVERY";
  const addressMode = page.deliveryMode?.mode === "ADDRESS" ? page.deliveryMode : null;
  // MAP mode: pin when the outlet's location is known and the map works; otherwise the area picker.
  const usePin = delivery && !addressMode && Boolean(page.location) && !pickArea;
  const zone = usePin ? (quote?.deliverable ? (quote.zone ?? undefined) : undefined) : page.zones.find((z) => z.id === zoneId);
  const fee = !delivery ? null : addressMode ? addressMode.fee : (zone?.fee ?? null);
  const minOrder = Math.max(page.minOrder, delivery ? (addressMode ? addressMode.minOrder : (zone?.minOrder ?? 0)) : 0);
  const pinOk = !pincode.trim() || PINCODE_RE.test(pincode.trim());
  const areaCheck =
    delivery && addressMode && (addressMode.areas.length || addressMode.pincodes.length) && (pincode.trim().length === 6 || area || address.trim().length >= 5)
      ? checkDeliveryArea(addressMode, { address, landmark, area, pincode: pinOk ? pincode : "" })
      : null;
  const phoneOk = /^[6-9]\d{9}$/.test(phone.trim());
  const problems = [
    name.trim().length < 2 && "Enter your name",
    !phoneOk && "Enter a 10-digit mobile number",
    phoneOk && page.verifyPhone && !phoneToken && "Verify your mobile number with the code we text you",
    delivery && address.trim().length < 5 && "Enter your delivery address",
    delivery && addressMode && !pinOk && "Enter a 6-digit PIN code",
    areaCheck && !areaCheck.ok && areaCheck.message,
    usePin && !pin && "Put the pin on the map where we should deliver",
    usePin && pin && !quote && "Checking delivery…",
    usePin && quote && !quote.deliverable && (quote.message ?? "We don't deliver there"),
    delivery && !addressMode && !usePin && page.zones.length > 0 && !zoneId && "Choose your area",
    !payment && "Choose how to pay",
    cart.total < minOrder && `Minimum order is ${formatINR(minOrder)}`,
  ].filter(Boolean) as string[];

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
        items: cart.lines.map((l) => ({ menuItemId: l.menuItemId, variantId: l.variantId, addonIds: l.addonIds, quantity: l.quantity, notes: l.notes?.trim() || undefined })),
        delivery: delivery
          ? {
              address: address.trim(),
              landmark: landmark.trim() || undefined,
              ...(addressMode
                ? { pincode: pincode.trim() || undefined, area: area || undefined }
                : usePin && pin
                  ? { latitude: Number(pin.lat.toFixed(6)), longitude: Number(pin.lng.toFixed(6)) }
                  : { zoneId: zoneId || undefined }),
            }
          : undefined,
      });
      try {
        localStorage.setItem(CUSTOMER_KEY, JSON.stringify({ name: name.trim(), phone: phone.trim(), address: address.trim(), landmark: landmark.trim(), pincode: pincode.trim() }));
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
      }
      toast(errorMessage(e), "error");
      reload();
    } finally {
      setPlacing(false);
    }
  };

  const types = [page.takeaway && { value: "TAKEAWAY" as const, label: "Takeaway", icon: <ShoppingBag size={20} /> }, page.delivery && { value: "DELIVERY" as const, label: "Delivery", icon: <Moped size={20} /> }].filter(
    Boolean,
  ) as { value: OrderType; label: string; icon: React.ReactNode }[];
  const sectionCls = "rounded-2xl border border-line p-4";
  const extras = [page.outlet.gstEnabled && !page.outlet.pricesIncludeTax && "GST", page.outlet.packagingCharge > 0 && "packaging", "offers"].filter(Boolean).join(", ");

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      wide
      title="Your order"
      footer={
        cart.count > 0 ? (
          <div className="space-y-2">
            {problems.length > 0 && (
              <p className="text-sm font-semibold text-amber-800 dark:text-amber-300" role="status">
                {problems[0]}
              </p>
            )}
            <button
              type="button"
              disabled={placing || problems.length > 0}
              onClick={() => void place()}
              data-testid="place-order"
              className="flex h-14 w-full items-center justify-between rounded-2xl bg-primary px-5 font-extrabold text-primary-fg hover:bg-primary-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span className="tabular-nums">{formatINR(cart.total + (fee ?? 0) + page.outlet.packagingCharge)}</span>
              <span className="flex items-center gap-2">
                {placing && <Spinner className="h-4 w-4" />} Place order <ArrowRight size={18} weight="bold" />
              </span>
            </button>
          </div>
        ) : undefined
      }
    >
      {cart.count === 0 ? (
        <p className="py-10 text-center text-muted">Your cart is empty.</p>
      ) : (
        <div className="space-y-4">
          <div className={sectionCls}>
            <CartItems cart={cart} />
          </div>

          {types.length > 1 && (
            <div role="radiogroup" aria-label="Order type" className="grid grid-cols-2 gap-2">
              {types.map((t) => (
                <button
                  key={t.value}
                  type="button"
                  role="radio"
                  aria-checked={orderType === t.value}
                  onClick={() => setOrderType(t.value)}
                  className={clsx(
                    "flex h-12 items-center justify-center gap-2 rounded-xl border-2 font-bold",
                    orderType === t.value ? "border-primary bg-primary/5 text-primary" : "border-line text-fg",
                  )}
                >
                  {t.icon} {t.label}
                </button>
              ))}
            </div>
          )}

          <div className={clsx(sectionCls, "space-y-3")}>
            <Select label={delivery ? "Delivery time" : "Pickup time"} value={when} onChange={(e) => setWhen(e.target.value)}>
              <option value="">As soon as possible</option>
              {slots.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </Select>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input label="Your name" autoComplete="name" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
              <Input label="Mobile number" inputMode="numeric" autoComplete="tel-national" maxLength={10} value={phone} onChange={(e) => setPhone(e.target.value.replace(/\D/g, ""))} />
            </div>
            {page.verifyPhone && <PhoneVerify slug={slug} phone={phone.trim()} token={phoneToken} onVerified={setPhoneToken} />}
          </div>

          {delivery && (
            <div className={clsx(sectionCls, "space-y-3")} data-testid="delivery-address">
              <p className="font-bold text-fg">Delivery address</p>
              <Textarea label="House / flat, street, area" autoComplete="street-address" rows={2} maxLength={500} value={address} onChange={(e) => setAddress(e.target.value)} />
              <div className={clsx("grid gap-3", addressMode && "sm:grid-cols-2")}>
                <Input label="Landmark (optional)" maxLength={200} value={landmark} onChange={(e) => setLandmark(e.target.value)} />
                {addressMode && (
                  <Input
                    label={addressMode.pincodes.length && !addressMode.areas.length ? "PIN code" : "PIN code (optional)"}
                    inputMode="numeric"
                    autoComplete="postal-code"
                    maxLength={6}
                    value={pincode}
                    onChange={(e) => setPincode(e.target.value.replace(/\D/g, ""))}
                    error={!pinOk && pincode.length === 6 ? "Enter a 6-digit PIN code" : null}
                  />
                )}
              </div>
              {addressMode && addressMode.areas.length > 0 && (
                <Select label="Area" value={area} onChange={(e) => setArea(e.target.value)}>
                  <option value="">Choose your area</option>
                  {addressMode.areas.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </Select>
              )}
              {areaCheck && !areaCheck.ok && (
                <p className="rounded-xl bg-red-50 px-3 py-2 text-sm font-semibold text-red-800 dark:bg-red-500/15 dark:text-red-200" role="alert">
                  {areaCheck.message}
                </p>
              )}
              {addressMode && (
                <p className="text-sm text-muted">
                  {addressMode.fee ? `Delivery ${formatINR(addressMode.fee)}` : "Free delivery"} · about {addressMode.etaMinutes} min
                </p>
              )}
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
              {!addressMode && !usePin && page.zones.length > 0 && (
                <Select label="Area" value={zoneId} onChange={(e) => setZoneId(e.target.value)}>
                  <option value="">Choose your area</option>
                  {page.zones.map((z) => (
                    <option key={z.id} value={z.id}>
                      {z.name} · {z.fee ? `delivery ${formatINR(z.fee)}` : "free delivery"} · ~{z.etaMinutes} min
                    </option>
                  ))}
                </Select>
              )}
            </div>
          )}

          <fieldset className={sectionCls}>
            <legend className="px-1 font-bold text-fg">Payment</legend>
            <div className="space-y-2">
              {payOptions.map((p) => (
                <label key={p} className={clsx("flex min-h-[48px] cursor-pointer items-center gap-3 rounded-xl border px-3", payment === p ? "border-primary bg-primary/5" : "border-line")}>
                  <input type="radio" name="pay" checked={payment === p} onChange={() => setPayment(p)} className="h-5 w-5 accent-primary" />
                  <span className="font-semibold text-fg">{PAY_LABEL[p]}</span>
                </label>
              ))}
              {payOptions.length === 0 && <p className="text-sm text-muted">No payment option for {delivery ? "delivery" : "takeaway"} — please call us.</p>}
            </div>
          </fieldset>

          <Input label="Note for the restaurant (optional)" maxLength={200} value={notes} onChange={(e) => setNotes(e.target.value)} />

          <dl className={clsx(sectionCls, "space-y-1.5 text-sm")} aria-label="Bill summary">
            <div className="flex justify-between text-fg">
              <dt>Item total</dt>
              <dd className="tabular-nums">{formatINR(cart.total)}</dd>
            </div>
            {delivery && (
              <div className="flex justify-between text-fg">
                <dt>Delivery fee</dt>
                <dd className="tabular-nums">{fee === null ? "—" : fee ? formatINR(fee) : "Free"}</dd>
              </div>
            )}
            {page.outlet.packagingCharge > 0 && (
              <div className="flex justify-between text-fg">
                <dt>Packaging</dt>
                <dd className="tabular-nums">{formatINR(page.outlet.packagingCharge)}</dd>
              </div>
            )}
            <p className="pt-1 text-xs text-muted">
              {extras ? `${extras[0].toUpperCase()}${extras.slice(1)} are worked out when you place the order.` : ""}
              {page.needsConfirmation ? " The restaurant confirms your order before cooking." : ""}
            </p>
          </dl>
        </div>
      )}
    </BottomSheet>
  );
}
