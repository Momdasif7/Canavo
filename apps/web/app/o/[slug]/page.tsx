"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import clsx from "clsx";
import { formatINR } from "@canavo/shared";
import { ApiError, errorMessage } from "@/lib/api";
import { publicCall, type DeliveryQuote, type OutletPage } from "@/lib/storefront";
import type { LatLng } from "@/components/delivery/map/DeliveryMap";
import { DeliveryPin } from "@/components/storefront/DeliveryPin";
import { forgetPhoneToken, PhoneVerify, savedPhoneToken } from "@/components/storefront/PhoneVerify";
import { useToast } from "@/components/providers/ToastProvider";
import { CartBar, CartLines, StoreHeader, StoreMenu, useCart } from "@/components/storefront/StoreMenu";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Input, Select, Textarea } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { Alert, ErrorState, LoadingState } from "@/components/ui/States";

type OrderType = "TAKEAWAY" | "DELIVERY";
type Pay = "COUNTER" | "COD" | "UPI";
const PAY_LABEL: Record<Pay, string> = { COUNTER: "Pay at the counter", COD: "Cash on delivery", UPI: "Pay now with UPI" };

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

/** Phase 6.4: the outlet's own online ordering page (takeaway / delivery) and digital menu. */
export default function OnlineOrderPage() {
  const { slug } = useParams<{ slug: string }>();
  const router = useRouter();
  const toast = useToast();
  const [page, setPage] = useState<OutletPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [orderType, setOrderType] = useState<OrderType>("TAKEAWAY");
  const [when, setWhen] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [address, setAddress] = useState("");
  const [landmark, setLandmark] = useState("");
  const [zoneId, setZoneId] = useState("");
  const [payment, setPayment] = useState<Pay | "">("");
  const [notes, setNotes] = useState("");
  const [placing, setPlacing] = useState(false);
  const [phoneToken, setPhoneToken] = useState<string | null>(null);
  const [pin, setPin] = useState<LatLng | null>(null);
  const [quote, setQuote] = useState<DeliveryQuote | null>(null);
  const [pickArea, setPickArea] = useState(false);
  const cart = useCart(`canavo.onlinecart.${slug}`);
  const { prune } = cart;
  const slots = useMemo(() => (open ? timeSlots() : []), [open]);

  const load = useCallback(async () => {
    try {
      const p = await publicCall<OutletPage>("GET", `/public/o/${slug}`);
      setPage(p);
      setError(null);
      document.title = p.outlet.name;
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
      const saved = JSON.parse(localStorage.getItem("canavo.customer") ?? "{}") as { name?: string; phone?: string; address?: string };
      setName(saved.name ?? "");
      setPhone(saved.phone ?? "");
      setAddress(saved.address ?? "");
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

  if (error && !page) return <main className="mx-auto max-w-md p-6"><ErrorState message={error} onRetry={load} /></main>;
  if (!page) return <LoadingState label="Opening the menu…" />;

  // Map pin when the outlet's location is known and the map works; otherwise the area picker.
  const usePin = orderType === "DELIVERY" && Boolean(page.location) && !pickArea;
  const zone = usePin ? (quote?.deliverable ? (quote.zone ?? undefined) : undefined) : page.zones.find((z) => z.id === zoneId);
  const phoneOk = /^[6-9]\d{9}$/.test(phone.trim());
  const belowMin = cart.total < page.minOrder || (orderType === "DELIVERY" && zone ? cart.total < zone.minOrder : false);
  const problems = [
    name.trim().length < 2 && "Enter your name",
    !phoneOk && "Enter a 10-digit mobile number",
    phoneOk && page.verifyPhone && !phoneToken && "Verify your mobile number with the code we text you",
    orderType === "DELIVERY" && address.trim().length < 5 && "Enter your delivery address",
    usePin && !pin && "Put the pin on the map where we should deliver",
    usePin && pin && !quote && "Checking delivery…",
    usePin && quote && !quote.deliverable && (quote.message ?? "We don't deliver there"),
    orderType === "DELIVERY" && !usePin && page.zones.length > 0 && !zoneId && "Choose your area",
    !payment && "Choose how to pay",
    belowMin && `Minimum order is ${formatINR(Math.max(page.minOrder, zone?.minOrder ?? 0))}`,
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
        delivery:
          orderType === "DELIVERY"
            ? {
                address: address.trim(),
                landmark: landmark.trim() || undefined,
                ...(usePin && pin ? { latitude: Number(pin.lat.toFixed(6)), longitude: Number(pin.lng.toFixed(6)) } : { zoneId: zoneId || undefined }),
              }
            : undefined,
      });
      try {
        localStorage.setItem("canavo.customer", JSON.stringify({ name: name.trim(), phone: phone.trim(), address: address.trim() }));
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
      void load();
    } finally {
      setPlacing(false);
    }
  };

  const types = [page.takeaway && { value: "TAKEAWAY" as const, label: "Takeaway" }, page.delivery && { value: "DELIVERY" as const, label: "Delivery" }].filter(Boolean) as { value: OrderType; label: string }[];

  return (
    <main className="min-h-screen">
      <StoreHeader brand={page.outlet} />
      <div className="mx-auto max-w-3xl space-y-2 px-4 pt-3">
        {page.notice && <Alert tone="info">{page.notice}</Alert>}
        {page.ordering && (
          <p className="text-sm text-muted">
            {types.map((t) => t.label).join(" · ")}
            {page.hours && ` · Orders ${page.hours.from}–${page.hours.to}`}
            {page.minOrder > 0 && ` · Minimum ${formatINR(page.minOrder)}`}
          </p>
        )}
      </div>

      <StoreMenu menu={page} brand={page.outlet} cart={cart} canOrder={page.ordering} />
      {page.ordering && <CartBar cart={cart} onOpen={() => setOpen(true)} label="Checkout" />}

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Checkout"
        footer={
          <div className="w-full space-y-2">
            {problems.length > 0 && cart.count > 0 && <p className="text-sm text-muted">{problems[0]}</p>}
            <Button block size="lg" loading={placing} disabled={!cart.count || problems.length > 0} onClick={() => void place()}>
              Place order · {formatINR(cart.total)}
            </Button>
          </div>
        }
      >
        {cart.count === 0 ? (
          <p className="py-6 text-center text-muted">Your cart is empty.</p>
        ) : (
          <div className="space-y-4">
            <CartLines cart={cart} />
            {types.length > 1 && <Segmented value={orderType} onChange={setOrderType} options={types} className="w-full" />}
            <Select label={orderType === "DELIVERY" ? "Delivery time" : "Pickup time"} value={when} onChange={(e) => setWhen(e.target.value)}>
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
            {orderType === "DELIVERY" && (
              <>
                <Textarea label="Delivery address" autoComplete="street-address" rows={2} maxLength={500} value={address} onChange={(e) => setAddress(e.target.value)} />
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
            <fieldset>
              <legend className="mb-2 text-sm font-semibold text-fg">Payment</legend>
              <div className="space-y-2">
                {payOptions.map((p) => (
                  <label key={p} className={clsx("flex min-h-tap items-center gap-3 rounded-xl border px-3", payment === p ? "border-primary bg-primary/5" : "border-line")}>
                    <input type="radio" name="pay" checked={payment === p} onChange={() => setPayment(p)} className="h-4 w-4 accent-primary" />
                    <span className="font-medium">{PAY_LABEL[p]}</span>
                  </label>
                ))}
                {payOptions.length === 0 && <p className="text-sm text-muted">No payment option for {orderType === "DELIVERY" ? "delivery" : "takeaway"} — please call us.</p>}
              </div>
            </fieldset>
            <Input label="Note for the restaurant (optional)" maxLength={200} value={notes} onChange={(e) => setNotes(e.target.value)} />
            <p className="text-xs text-muted">
              Item total {formatINR(cart.total)}. {page.outlet.gstEnabled && !page.outlet.pricesIncludeTax ? "GST, " : ""}
              {page.outlet.packagingCharge > 0 ? "packaging, " : ""}
              {orderType === "DELIVERY" ? (zone ? `delivery fee ${formatINR(zone.fee)} and ` : "delivery fee and ") : ""}any offers are worked out when you place the order.
              {page.needsConfirmation ? " The restaurant confirms your order before cooking." : ""}
            </p>
          </div>
        )}
      </Dialog>
    </main>
  );
}
