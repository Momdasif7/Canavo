"use client";

import { useEffect, useState } from "react";
import { CheckCircle, MapPinLine, WarningCircle } from "@phosphor-icons/react";
import { deliveryAreaAllowed, deliveryAreaRefusal, formatINR, PINCODE_RE } from "@canavo/shared";
import { errorMessage } from "@/lib/api";
import { publicCall, type DeliveryQuote } from "@/lib/storefront";
import { Input, Select, Textarea } from "@/components/ui/Input";

export interface TypedAddress {
  address: string;
  landmark: string;
  pincode: string;
  area: string;
}

/**
 * Address-only delivery (the outlet chose "Address only (no map)"): house / street, landmark, PIN
 * code and — when the outlet lists area names — the area. No map and no location prompt. The PIN
 * code / area is checked against the outlet's allowed areas as the customer types (the server
 * checks again when the order is placed).
 */
export function AddressOnlyFields({
  slug,
  value,
  onChange,
  areas,
  fee,
  etaMinutes,
  quote,
  onQuote,
}: {
  slug: string;
  value: TypedAddress;
  onChange: (patch: Partial<TypedAddress>) => void;
  areas: string[];
  fee: number;
  etaMinutes: number;
  quote: DeliveryQuote | null;
  onQuote: (q: DeliveryQuote | null) => void;
}) {
  const [checking, setChecking] = useState(false);
  const names = areas.filter((a) => !PINCODE_RE.test(a));
  const pinOk = PINCODE_RE.test(value.pincode.trim());

  // Ask the server (debounced) once the PIN code is complete.
  useEffect(() => {
    if (!pinOk) {
      onQuote(null);
      return;
    }
    let live = true;
    setChecking(true);
    const t = window.setTimeout(async () => {
      const qs = new URLSearchParams({ pincode: value.pincode.trim(), ...(value.area && { area: value.area }), ...(value.address.trim() && { address: value.address.trim().slice(0, 400) }) });
      try {
        const q = await publicCall<DeliveryQuote>("GET", `/public/o/${slug}/delivery-quote?${qs}`);
        if (live) onQuote(q);
      } catch (e) {
        // Offline / server hiccup: fall back to the local check; the order request is checked again.
        if (live) {
          const ok = deliveryAreaAllowed(areas, value);
          onQuote({ mode: "ADDRESS", outletLocation: false, deliverable: ok, distanceKm: null, zone: null, fee, etaMinutes, message: ok ? null : deliveryAreaRefusal(areas, value.pincode) || errorMessage(e) });
        }
      } finally {
        if (live) setChecking(false);
      }
    }, 400);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.pincode, value.area, value.address, slug, pinOk]);

  return (
    <div className="space-y-3" data-testid="address-only">
      <Textarea
        label="House / flat no., building, street"
        autoComplete="street-address"
        rows={2}
        maxLength={400}
        value={value.address}
        onChange={(e) => onChange({ address: e.target.value })}
        placeholder="e.g. Flat 3B, Lakshmi Apartments, 21 Ranganathan Street"
      />
      <div className="grid grid-cols-[1fr_8.5rem] gap-3">
        <Input label="Landmark (optional)" maxLength={200} value={value.landmark} onChange={(e) => onChange({ landmark: e.target.value })} placeholder="Near…" />
        <Input
          label="PIN code"
          inputMode="numeric"
          autoComplete="postal-code"
          maxLength={6}
          value={value.pincode}
          onChange={(e) => onChange({ pincode: e.target.value.replace(/\D/g, "") })}
          error={value.pincode.length === 6 && !pinOk ? "Not a valid PIN code" : null}
        />
      </div>
      {names.length > 0 && (
        <Select label="Area" value={value.area} onChange={(e) => onChange({ area: e.target.value })}>
          <option value="">Choose your area (optional if your PIN code is listed)</option>
          {names.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </Select>
      )}
      {areas.length > 0 && (
        <p className="flex items-start gap-1.5 text-xs text-muted">
          <MapPinLine size={16} className="mt-px shrink-0" />
          We deliver to {areas.slice(0, 10).join(", ")}
          {areas.length > 10 ? ` and ${areas.length - 10} more` : ""}.
        </p>
      )}
      {pinOk && checking && <p className="text-sm text-muted">Checking delivery…</p>}
      {pinOk && !checking && quote && (
        <p
          className={
            quote.deliverable
              ? "flex items-start gap-2 rounded-xl bg-secondary-50 p-2.5 text-sm font-medium text-secondary-700 dark:bg-green-500/15 dark:text-green-300"
              : "flex items-start gap-2 rounded-xl bg-red-50 p-2.5 text-sm font-medium text-red-700 dark:bg-red-500/15 dark:text-red-300"
          }
          data-testid="delivery-quote"
          aria-live="polite"
        >
          {quote.deliverable ? <CheckCircle size={18} weight="fill" className="mt-px shrink-0" /> : <WarningCircle size={18} weight="fill" className="mt-px shrink-0" />}
          {quote.deliverable ? `We deliver here · ${fee ? `delivery fee ${formatINR(fee)}` : "free delivery"} · ~${etaMinutes} min` : quote.message}
        </p>
      )}
    </div>
  );
}
