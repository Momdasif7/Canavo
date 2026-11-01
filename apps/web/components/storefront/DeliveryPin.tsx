"use client";

import { Component, useEffect, useState, type ReactNode } from "react";
import { Crosshair } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { errorMessage } from "@/lib/api";
import { publicCall, type DeliveryQuote, type OutletPage } from "@/lib/storefront";
import { DeliveryMap, type LatLng } from "@/components/delivery/map/DeliveryMap";
import { Button } from "@/components/ui/Button";

/** If Leaflet / the tiles fail to load, fall back to choosing an area. */
class MapBoundary extends Component<{ onError: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch() {
    this.props.onError();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * Delivery location on the online checkout: "Use my location" (browser geolocation) or tap / drag
 * the pin on an OpenStreetMap map. The server quotes the zone and fee for the pin (and refuses
 * addresses outside every zone). `onFallback` switches the checkout to the area picker.
 */
export function DeliveryPin({
  slug,
  page,
  pin,
  onPin,
  quote,
  onQuote,
  onFallback,
}: {
  slug: string;
  page: OutletPage;
  pin: LatLng | null;
  onPin: (p: LatLng) => void;
  quote: DeliveryQuote | null;
  onQuote: (q: DeliveryQuote | null) => void;
  onFallback: () => void;
}) {
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [focusKey, setFocusKey] = useState(0);

  // Quote the pin (debounced while dragging).
  useEffect(() => {
    if (!pin) return;
    let live = true;
    setQuoting(true);
    const t = window.setTimeout(async () => {
      try {
        const q = await publicCall<DeliveryQuote>("GET", `/public/o/${slug}/delivery-quote?lat=${pin.lat.toFixed(6)}&lng=${pin.lng.toFixed(6)}`);
        if (!live) return;
        onQuote(q);
        if (!q.outletLocation) onFallback();
      } catch (e) {
        if (live) onQuote({ outletLocation: true, deliverable: false, distanceKm: null, zone: null, message: errorMessage(e) });
      } finally {
        if (live) setQuoting(false);
      }
    }, 350);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin?.lat, pin?.lng, slug]);

  const locate = () => {
    if (!("geolocation" in navigator)) {
      setGeoError("Your browser can't share your location — tap the map instead.");
      return;
    }
    setLocating(true);
    setGeoError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        onPin({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setFocusKey((k) => k + 1);
      },
      (err) => {
        setLocating(false);
        setGeoError(err.code === err.PERMISSION_DENIED ? "Location permission denied — tap the map to place the pin." : "Couldn't find your location — tap the map to place the pin.");
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 60_000 },
    );
  };

  return (
    <div className="space-y-2" data-testid="delivery-pin">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex-1 text-sm font-semibold text-fg">Delivery location</p>
        <Button size="sm" variant="outline" icon={<Crosshair size={18} />} loading={locating} onClick={locate}>
          Use my location
        </Button>
      </div>
      <MapBoundary onError={onFallback}>
        <DeliveryMap
          value={pin}
          outlet={page.location}
          zones={page.zones.map((z) => ({ id: z.id, name: z.name, radiusKm: z.radiusKm }))}
          activeZoneId={quote?.zone?.id ?? null}
          onPick={onPin}
          focusKey={focusKey}
          height={220}
        />
      </MapBoundary>
      <p className="text-xs text-muted">{pin ? "Drag the pin or tap the map to fix the exact spot." : "Tap the map where we should deliver, or use your location."}</p>
      {geoError && <p className="text-sm text-amber-700 dark:text-amber-300">{geoError}</p>}
      {pin && quote && !quoting && (
        <p
          className={quote.deliverable ? "rounded-xl bg-secondary/10 p-2 text-sm font-medium text-secondary dark:text-green-300" : "rounded-xl bg-red-50 p-2 text-sm font-medium text-red-700 dark:bg-red-500/15 dark:text-red-300"}
          data-testid="delivery-quote"
          aria-live="polite"
        >
          {quote.deliverable && quote.zone
            ? `${quote.zone.name}${quote.distanceKm != null ? ` · ${quote.distanceKm} km` : ""} · ${quote.zone.fee ? `delivery fee ${formatINR(quote.zone.fee)}` : "free delivery"} · ~${quote.zone.etaMinutes} min`
            : quote.message}
        </p>
      )}
      {pin && quoting && <p className="text-sm text-muted">Checking delivery…</p>}
      <button type="button" className="text-sm font-semibold text-primary underline-offset-2 hover:underline" onClick={onFallback}>
        Can&apos;t use the map? Choose your area instead
      </button>
    </div>
  );
}
