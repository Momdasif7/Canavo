"use client";

import clsx from "clsx";
import { Clock, Gift, HandCoins, MapPin, Moped, Prohibit, Sparkle, Ticket, UserCircleGear, Wallet, Warning, X } from "@phosphor-icons/react";
import { formatINR, type LoyaltyTierName } from "@canavo/shared";
import type { ActiveOffer, CustomerLookupResult, DeliveryAgent, DeliveryQuote } from "@/lib/types-service";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { Toggle } from "@/components/ui/Input";
import type { LatLng } from "@/components/delivery/map/DeliveryMap";
import { partnerOptionLabel } from "@/components/delivery/common";
import { DeliveryLocationPicker } from "./DeliveryLocationPicker";
import type { CartMeta, DeliveryMeta, DeliverySource } from "./cart";

const fieldCls =
  "min-h-[44px] w-full rounded-xl border border-line bg-surface px-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60";

const TIER_STYLE: Record<LoyaltyTierName, string> = {
  BRONZE: "bg-amber-100 text-amber-900 border-amber-300 dark:bg-amber-900/30 dark:text-amber-200 dark:border-amber-700",
  SILVER: "bg-slate-100 text-slate-800 border-slate-300 dark:bg-slate-500/20 dark:text-slate-200 dark:border-slate-500",
  GOLD: "bg-yellow-100 text-yellow-900 border-yellow-400 dark:bg-yellow-500/20 dark:text-yellow-200 dark:border-yellow-600",
  PLATINUM: "bg-indigo-100 text-indigo-900 border-indigo-300 dark:bg-indigo-500/20 dark:text-indigo-200 dark:border-indigo-500",
};

export function TierBadge({ tier }: { tier: LoyaltyTierName }) {
  return <span className={clsx("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide", TIER_STYLE[tier])}>{tier}</span>;
}

/** POS customer card from GET /customers/lookup. */
export function CustomerCard({ lookup, loading }: { lookup: CustomerLookupResult | null; loading: boolean }) {
  if (loading)
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Spinner className="h-4 w-4" /> Looking up customer…
      </div>
    );
  if (!lookup) return null;
  if (!lookup.found)
    return (
      <p className="rounded-xl border border-dashed border-line px-3 py-2 text-sm text-muted" data-testid="customer-card">
        New customer — they&apos;ll join loyalty with this bill.
      </p>
    );
  return (
    <div className="space-y-1.5 rounded-xl border border-line bg-surface-2 px-3 py-2" data-testid="customer-card">
      <div className="flex items-center gap-2">
        <span className="truncate font-bold">{lookup.name || `+91 ${lookup.phone}`}</span>
        {lookup.tier && <TierBadge tier={lookup.tier} />}
        {lookup.visitCount ? <span className="ml-auto shrink-0 text-xs text-muted">{lookup.visitCount} visits</span> : null}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <span className="flex items-center gap-1">
          <Gift size={14} className="text-primary" />
          <strong className="tabular">{lookup.points ?? 0}</strong> pts
          {(lookup.redeemablePoints ?? 0) > 0 && <span className="text-muted">· worth {formatINR(lookup.redeemableValue ?? 0)}</span>}
        </span>
        <span className={clsx("flex items-center gap-1", (lookup.khataBalance ?? 0) > 0 && "font-semibold text-red-600 dark:text-red-300")}>
          <Wallet size={14} /> Khata {formatINR(lookup.khataBalance ?? 0)}
          {lookup.khataLimit ? <span className="font-normal text-muted">/ {formatINR(lookup.khataLimit)}</span> : null}
        </span>
      </div>
      {lookup.blocked && (
        <p className="flex items-center gap-1.5 rounded-lg bg-red-50 px-2 py-1 text-xs font-semibold text-red-700 dark:bg-red-500/15 dark:text-red-200" role="alert">
          <Prohibit size={14} weight="bold" /> Customer is blocked — no khata, coupons or points.
        </p>
      )}
    </div>
  );
}

/** Coupon code + loyalty points redemption. */
export function PromoFields({
  meta,
  onMeta,
  lookup,
  maxPoints,
  couponError,
  pointsError,
  disabledReason,
}: {
  meta: CartMeta;
  onMeta: (patch: Partial<CartMeta>) => void;
  lookup: CustomerLookupResult | null;
  /** Max points usable on this bill (null = unknown) */
  maxPoints: number | null;
  couponError?: string | null;
  pointsError?: string | null;
  /** e.g. offline */
  disabledReason?: string | null;
}) {
  const canRedeem = !!lookup?.found && !lookup.blocked && (lookup.redeemablePoints ?? 0) >= (lookup.loyalty?.minRedeemPoints ?? 0) && (lookup.redeemablePoints ?? 0) > 0;
  const redeeming = meta.redeemPoints.trim() !== "";
  const pointValue = lookup?.loyalty?.pointValuePaise ?? 0;
  const pts = Math.floor(Number(meta.redeemPoints) || 0);

  return (
    <div className="space-y-2">
      <div>
        <div className="flex items-center gap-2">
          <Ticket size={20} className="shrink-0 text-muted" />
          <input
            aria-label="Coupon code"
            placeholder="Coupon code"
            maxLength={30}
            value={meta.couponCode}
            disabled={!!disabledReason}
            onChange={(e) => onMeta({ couponCode: e.target.value.toUpperCase().replace(/\s/g, "") })}
            className={clsx(fieldCls, "min-h-[40px] font-mono uppercase", couponError && "border-red-500")}
          />
          {meta.couponCode && (
            <button type="button" aria-label="Remove coupon" onClick={() => onMeta({ couponCode: "" })} className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2">
              <X size={18} />
            </button>
          )}
        </div>
        {couponError && (
          <p className="mt-1 flex items-start gap-1 pl-7 text-xs font-medium text-red-600 dark:text-red-300" role="alert" data-testid="coupon-warning">
            <Warning size={14} weight="fill" className="mt-px shrink-0" />
            {couponError}
          </p>
        )}
      </div>
      {canRedeem && (
        <div className="rounded-xl border border-line p-2">
          <Toggle
            checked={redeeming}
            disabled={!!disabledReason}
            onChange={(on) => onMeta({ redeemPoints: on ? String(Math.max(0, Math.min(lookup!.redeemablePoints ?? 0, maxPoints ?? lookup!.redeemablePoints ?? 0))) : "" })}
            label="Redeem points"
            description={`${lookup!.redeemablePoints} available · ₹${(pointValue / 100).toFixed(2)} each · min ${lookup!.loyalty.minRedeemPoints}`}
          />
          {redeeming && (
            <div className="mt-1 flex items-center gap-2">
              <input
                aria-label="Points to redeem"
                inputMode="numeric"
                value={meta.redeemPoints}
                onChange={(e) => onMeta({ redeemPoints: e.target.value.replace(/\D/g, "") })}
                className={clsx(fieldCls, "tabular min-h-[40px] w-28 text-right font-semibold", pointsError && "border-red-500")}
              />
              <span className="text-sm text-muted">= {formatINR(pts * pointValue)}</span>
              {maxPoints !== null && (
                <button
                  type="button"
                  className="ml-auto rounded-lg border border-line px-2.5 py-1.5 text-xs font-bold hover:bg-surface-2"
                  onClick={() => onMeta({ redeemPoints: String(Math.max(0, Math.min(lookup!.redeemablePoints ?? 0, maxPoints))) })}
                >
                  Max {Math.max(0, Math.min(lookup!.redeemablePoints ?? 0, maxPoints))}
                </button>
              )}
            </div>
          )}
          {pointsError && (
            <p className="mt-1 flex items-start gap-1 text-xs font-medium text-red-600 dark:text-red-300" role="alert" data-testid="points-warning">
              <Warning size={14} weight="fill" className="mt-px shrink-0" />
              {pointsError}
            </p>
          )}
        </div>
      )}
      {/* Points problem for a customer who can't redeem (e.g. not found / blocked) still needs to be visible */}
      {pointsError && !canRedeem && (
        <p className="flex items-start gap-1 text-xs font-medium text-red-600 dark:text-red-300" role="alert" data-testid="points-warning">
          <Warning size={14} weight="fill" className="mt-px shrink-0" />
          {pointsError}
        </p>
      )}
      {disabledReason && <p className="text-xs text-muted">{disabledReason}</p>}
    </div>
  );
}

const SOURCES: { value: DeliverySource; label: string }[] = [
  { value: "PHONE", label: "Phone" },
  { value: "WALK_IN", label: "Walk-in" },
  { value: "IN_APP", label: "App" },
  { value: "AGGREGATOR", label: "Aggregator" },
];

export function DeliveryFields({
  delivery,
  onChange,
  quote,
  quoteLoading,
  quoteError,
  agents,
  codAvailable,
  codAmount,
  outlet,
}: {
  delivery: DeliveryMeta;
  onChange: (patch: Partial<DeliveryMeta>) => void;
  quote: DeliveryQuote | null;
  quoteLoading: boolean;
  quoteError: string | null;
  agents: DeliveryAgent[] | null;
  /** Cash on Delivery can be chosen (online only — offline bills can't be COD) */
  codAvailable: boolean;
  /** Bill total the partner would collect */
  codAmount: number;
  /** Outlet position (map marker, zone centre) */
  outlet: LatLng | null;
}) {
  const manualZone = !delivery.useCoords || quote?.needsCoordinates;
  /** Outlet takes addresses without a map: PIN code instead of the pin / zone */
  const addressOnly = quote?.addressMode === "ADDRESS";
  const onDuty = (agents ?? []).filter((a) => a.clockedIn);
  const available = (agents ?? []).filter((a) => a.available);
  const chosen = agents?.find((a) => a.id === delivery.agentId);

  return (
    <div className="space-y-2" aria-label="Delivery details">
      <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-muted">
        <Moped size={16} /> Delivery
      </p>
      <textarea
        aria-label="Delivery address"
        placeholder="Delivery address (house, street, area)"
        rows={2}
        maxLength={500}
        value={delivery.address}
        onChange={(e) => onChange({ address: e.target.value })}
        className={clsx(fieldCls, "py-2")}
      />
      {addressOnly ? (
        <div className="grid grid-cols-[1fr_7.5rem] gap-2">
          <input aria-label="Landmark" placeholder="Landmark (optional)" maxLength={200} value={delivery.landmark} onChange={(e) => onChange({ landmark: e.target.value })} className={fieldCls} />
          <input
            aria-label="PIN code"
            placeholder="PIN code"
            inputMode="numeric"
            maxLength={6}
            value={delivery.pincode ?? ""}
            onChange={(e) => onChange({ pincode: e.target.value.replace(/\D/g, ""), useCoords: false, zoneId: "" })}
            className={fieldCls}
          />
        </div>
      ) : (
        <input aria-label="Landmark" placeholder="Landmark (optional)" maxLength={200} value={delivery.landmark} onChange={(e) => onChange({ landmark: e.target.value })} className={fieldCls} />
      )}
      {!addressOnly && (
        <DeliveryLocationPicker delivery={delivery} onChange={onChange} outlet={outlet} zones={quote?.zones ?? []} activeZoneId={quote?.zone?.id ?? (manualZone ? delivery.zoneId : null)} />
      )}
      {!addressOnly && manualZone && quote && quote.zones.length > 0 && (
        <select aria-label="Delivery zone" value={delivery.zoneId} onChange={(e) => onChange({ zoneId: e.target.value })} className={fieldCls}>
          <option value="">Choose zone…</option>
          {quote.zones.map((z) => (
            <option key={z.id} value={z.id}>
              {z.name} · {formatINR(z.fee)} · ~{z.etaMinutes} min{z.minOrder ? ` · min ${formatINR(z.minOrder)}` : ""}
            </option>
          ))}
        </select>
      )}
      <QuoteChip quote={quote} loading={quoteLoading} error={quoteError} zoneId={delivery.zoneId} pincode={delivery.pincode ?? ""} />
      <div className="grid grid-cols-2 gap-2">
        <select aria-label="Delivery partner" value={delivery.agentId} onChange={(e) => onChange({ agentId: e.target.value })} className={fieldCls}>
          <option value="">Auto-assign (next available)</option>
          {/* Unavailable partners stay selectable (greyed): the API refuses cashiers and asks managers to confirm. */}
          {(agents ?? []).map((a) => (
            <option key={a.id} value={a.id} className={a.available ? undefined : "text-muted"}>
              {partnerOptionLabel(a)}
            </option>
          ))}
        </select>
        <select aria-label="Order source" value={delivery.source} onChange={(e) => onChange({ source: e.target.value as DeliverySource })} className={fieldCls}>
          {SOURCES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <p
        className={clsx(
          "flex items-start gap-1.5 text-xs",
          delivery.agentId
            ? chosen && !chosen.available
              ? "text-amber-700 dark:text-amber-300"
              : "text-muted"
            : available.length
              ? "text-secondary-700 dark:text-green-300"
              : "text-amber-700 dark:text-amber-300",
        )}
        data-testid="partner-availability"
      >
        <UserCircleGear size={16} className="mt-px shrink-0" />
        <span>
          {agents === null
            ? "Checking delivery partners…"
            : delivery.agentId
              ? `${chosen?.name ?? "Partner"} chosen${chosen && !chosen.available ? ` — ${chosen.reason?.toLowerCase() ?? "can't take orders right now"}; managers can assign anyway` : ""}`
              : available.length
                ? `${available.length} partner${available.length === 1 ? "" : "s"} available at the outlet — goes to the next available`
                : onDuty.length
                  ? "No partner free right now — the order waits and is auto-assigned when a partner is back at the outlet"
                  : "No partner on duty — the order waits and is auto-assigned when one clocks in"}
        </span>
      </p>
      <input aria-label="Delivery notes" placeholder="Rider notes (optional)" maxLength={300} value={delivery.notes} onChange={(e) => onChange({ notes: e.target.value })} className={fieldCls} />
      {codAvailable && (
        <div
          className={clsx(
            "rounded-xl border px-3",
            delivery.cod ? "border-amber-400 bg-amber-50 dark:border-amber-500/50 dark:bg-amber-500/10" : "border-line",
          )}
          data-testid="cod-toggle"
        >
          <Toggle
            checked={delivery.cod}
            onChange={(cod) => onChange({ cod })}
            label={
              <span className="flex items-center gap-1.5">
                <HandCoins size={18} weight={delivery.cod ? "fill" : "regular"} className="text-amber-600 dark:text-amber-300" /> Cash on Delivery
              </span>
            }
            description={
              <>
                No payment now — {chosen?.name ?? "the delivery partner"} collects{" "}
                <span className="tabular font-semibold">{formatINR(codAmount)}</span> in cash at the door
              </>
            }
          />
        </div>
      )}
    </div>
  );
}

function QuoteChip({ quote, loading, error, zoneId, pincode }: { quote: DeliveryQuote | null; loading: boolean; error: string | null; zoneId: string; pincode: string }) {
  if (loading)
    return (
      <p className="flex items-center gap-2 text-xs text-muted">
        <Spinner className="h-3 w-3" /> Checking delivery zone…
      </p>
    );
  if (error) return <p className="text-xs font-medium text-red-600">{error}</p>;
  if (!quote) return null;
  if (!quote.deliveryEnabled) return <p className="text-xs font-medium text-red-600">Delivery is switched off for this outlet.</p>;
  if (quote.addressMode === "ADDRESS") {
    if (pincode.length === 6 && !quote.deliverable)
      return (
        <p className="rounded-lg bg-red-50 px-2.5 py-1.5 text-xs font-semibold text-red-700 dark:bg-red-500/15 dark:text-red-200" role="alert">
          {quote.message ?? "Outside our delivery areas"}
        </p>
      );
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-sky-50 px-2.5 py-1.5 text-xs font-semibold text-sky-900 dark:bg-sky-500/15 dark:text-sky-200" data-testid="delivery-quote">
        <span className="flex items-center gap-1">
          <MapPin size={14} weight="fill" /> {pincode.length === 6 ? `PIN ${pincode} · we deliver` : "Address only — enter the PIN code"}
        </span>
        <span>Fee {formatINR(quote.fee ?? 0)}</span>
        <span className="flex items-center gap-1">
          <Clock size={14} /> ~{quote.etaMinutes ?? 30} min
        </span>
        {(quote.minOrder ?? 0) > 0 && <span>Min order {formatINR(quote.minOrder ?? 0)}</span>}
      </div>
    );
  }
  const zone = quote.zone ?? quote.zones.find((z) => z.id === zoneId) ?? null;
  if (quote.distanceKm !== undefined && !quote.deliverable)
    return (
      <p className="rounded-lg bg-red-50 px-2.5 py-1.5 text-xs font-semibold text-red-700 dark:bg-red-500/15 dark:text-red-200" role="alert">
        {quote.distanceKm} km away — outside all delivery zones
      </p>
    );
  if (!zone) return quote.needsCoordinates ? <p className="text-xs text-muted">Pick a zone or enter coordinates for the fee.</p> : null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg bg-sky-50 px-2.5 py-1.5 text-xs font-semibold text-sky-900 dark:bg-sky-500/15 dark:text-sky-200" data-testid="delivery-quote">
      <span className="flex items-center gap-1">
        <MapPin size={14} weight="fill" /> {zone.name}
        {quote.distanceKm !== undefined && ` · ${quote.distanceKm} km`}
      </span>
      <span>Fee {formatINR(zone.fee)}</span>
      <span className="flex items-center gap-1">
        <Clock size={14} /> ~{zone.etaMinutes} min
      </span>
      {zone.minOrder > 0 && <span>Min order {formatINR(zone.minOrder)}</span>}
    </div>
  );
}

/** `datetime-local` value for a Date, in the browser's local time. */
export function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function PreOrderField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const min = toLocalInput(new Date(Date.now() + 5 * 60_000));
  const quick = [30, 60, 120].map((m) => ({ m, v: toLocalInput(new Date(Math.ceil((Date.now() + m * 60_000) / 300_000) * 300_000)) }));
  return (
    <div className="space-y-2">
      <label className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-muted" htmlFor="pos-scheduled-for">
        <Clock size={16} /> Pre-order for
      </label>
      <input id="pos-scheduled-for" type="datetime-local" aria-label="Pre-order time" min={min} value={value} onChange={(e) => onChange(e.target.value)} className={fieldCls} />
      <div className="flex gap-2">
        {quick.map((q) => (
          <button key={q.m} type="button" onClick={() => onChange(q.v)} className="rounded-lg border border-line px-2.5 py-1.5 text-xs font-bold hover:bg-surface-2">
            +{q.m >= 60 ? `${q.m / 60}h` : `${q.m}m`}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted">The kitchen ticket is held until shortly before this time.</p>
    </div>
  );
}

export function OffersBanner({ offers }: { offers: ActiveOffer[] }) {
  if (!offers.length) return null;
  return (
    <div className="scrollbar-thin flex items-center gap-2 overflow-x-auto border-b border-line bg-primary-50/60 px-3 py-2 dark:bg-primary/10" aria-label="Active offers">
      <Sparkle size={18} weight="fill" className="shrink-0 text-primary" />
      {offers.map((o) => (
        <span key={o.id} title={o.name} className="shrink-0">
          <Badge tone="primary" className="py-1 text-[12px]">
            {o.summary}
          </Badge>
        </span>
      ))}
    </div>
  );
}
