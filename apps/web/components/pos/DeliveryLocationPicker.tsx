"use client";

import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { CaretDown, Crosshair, MagnifyingGlass, MapTrifold, X } from "@phosphor-icons/react";
import { reverseGeocode, searchAddress, type GeoResult } from "@/lib/geocode";
import { useDebouncedValue } from "@/hooks/useDebounced";
import { Spinner } from "@/components/ui/Spinner";
import { DeliveryMap, type LatLng, type MapZone } from "@/components/delivery/map/DeliveryMap";
import { deliveryCoords, type DeliveryMeta } from "./cart";

const fieldCls =
  "min-h-[40px] w-full rounded-xl border border-line bg-surface px-3 text-sm focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30";

/** Nominatim labels end with ", India" — drop it, the address is local. */
const tidy = (label: string) => label.replace(/,\s*India$/i, "").slice(0, 500);

/**
 * Exact delivery spot for the POS: address search (Nominatim), click / drag the
 * pin, "use my location", outlet + delivery zones on an OpenStreetMap map.
 * Reverse-geocodes the pin and fills the address when it is empty, or asks first.
 */
export function DeliveryLocationPicker({
  delivery,
  onChange,
  outlet,
  zones,
  activeZoneId,
}: {
  delivery: DeliveryMeta;
  onChange: (patch: Partial<DeliveryMeta>) => void;
  outlet: LatLng | null;
  zones: MapZone[];
  activeZoneId?: string | null;
}) {
  const pin = deliveryCoords(delivery);
  const [open, setOpen] = useState(true);
  const [query, setQuery] = useState("");
  const [typed, setTyped] = useState(false);
  const [results, setResults] = useState<GeoResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const [geoError, setGeoError] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  /** Address found for the pin while the cashier already typed one: ask before replacing */
  const [offer, setOffer] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState(0);
  const latest = useRef(delivery);
  latest.current = delivery;
  const reverseCtrl = useRef<AbortController | null>(null);

  // Collapsed by default on small screens (the cart is short there) unless a pin is already set.
  useEffect(() => {
    if (!window.matchMedia("(min-width: 768px)").matches && !deliveryCoords(latest.current)) setOpen(false);
  }, []);

  // ----- Address search (debounced ≥ 600 ms; the geocode module spaces requests ≥ 1 s) -----
  const q = useDebouncedValue(query.trim(), 700);
  useEffect(() => {
    if (!typed || q.length < 3) {
      setResults(null);
      setSearchError(null);
      return;
    }
    const ctrl = new AbortController();
    setSearching(true);
    setSearchError(null);
    searchAddress(q, ctrl.signal)
      .then((r) => !ctrl.signal.aborted && setResults(r))
      .catch((e) => {
        if (ctrl.signal.aborted) return;
        setResults(null);
        setSearchError(e instanceof Error ? e.message : "Map search failed");
      })
      .finally(() => !ctrl.signal.aborted && setSearching(false));
    return () => ctrl.abort();
  }, [q, typed]);

  useEffect(() => () => reverseCtrl.current?.abort(), []);

  const offerAddress = (label: string) => {
    const addr = tidy(label);
    const current = latest.current.address.trim();
    if (!current) {
      onChange({ address: addr });
      setOffer(null);
    } else if (current !== addr) setOffer(addr);
  };

  /** Pin set by click / drag / location: reverse-geocode it for the address. */
  const pick = (p: LatLng, label?: string) => {
    onChange({ useCoords: true, lat: p.lat.toFixed(6), lng: p.lng.toFixed(6) });
    setGeoError(null);
    reverseCtrl.current?.abort();
    if (label) return offerAddress(label);
    const ctrl = new AbortController();
    reverseCtrl.current = ctrl;
    setResolving(true);
    reverseGeocode(p.lat, p.lng, ctrl.signal)
      .then((r) => !ctrl.signal.aborted && r && offerAddress(r.label))
      .catch(() => undefined)
      .finally(() => !ctrl.signal.aborted && setResolving(false));
  };

  const choose = (r: GeoResult) => {
    setResults(null);
    setTyped(false);
    setQuery(tidy(r.label));
    pick({ lat: r.lat, lng: r.lng }, r.label);
    setFocusKey((k) => k + 1);
    setOpen(true);
  };

  const useMyLocation = () => {
    if (!navigator.geolocation) return setGeoError("Location isn't available on this device");
    setLocating(true);
    setGeoError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        pick({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setFocusKey((k) => k + 1);
        setOpen(true);
      },
      (err) => {
        setLocating(false);
        setGeoError(err.code === err.PERMISSION_DENIED ? "Location permission denied" : "Couldn't get this device's location");
      },
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  const clearPin = () => {
    onChange({ useCoords: false, lat: "", lng: "" });
    setOffer(null);
  };

  return (
    <div className="space-y-2 rounded-xl border border-line p-2" data-testid="delivery-location">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex min-h-[36px] min-w-0 flex-1 items-center gap-1.5 rounded-lg px-1 text-left text-sm font-semibold hover:bg-surface-2"
        >
          <MapTrifold size={18} className="shrink-0 text-primary" />
          {pin ? (
            <span className="min-w-0 truncate">
              Pinned <span className="tabular text-xs font-normal text-muted">{pin.lat.toFixed(5)}, {pin.lng.toFixed(5)}</span>
            </span>
          ) : (
            <span className="truncate">Pin the exact location</span>
          )}
          {resolving && <Spinner className="h-3 w-3 shrink-0" />}
          <CaretDown size={14} className={clsx("ml-auto shrink-0 transition-transform", open && "rotate-180")} />
        </button>
        <button
          type="button"
          onClick={useMyLocation}
          disabled={locating}
          className="flex min-h-[36px] shrink-0 items-center gap-1 rounded-lg border border-line px-2 text-xs font-semibold hover:bg-surface-2 disabled:opacity-60"
          title="Use this device's location"
        >
          {locating ? <Spinner className="h-3.5 w-3.5" /> : <Crosshair size={16} />} Use my location
        </button>
        {pin && (
          <button type="button" onClick={clearPin} aria-label="Clear pin" title="Clear pin" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-muted hover:bg-surface-2">
            <X size={16} />
          </button>
        )}
      </div>

      <div className="relative">
        <MagnifyingGlass size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
        <input
          type="search"
          aria-label="Search address on map"
          placeholder="Search address, area or landmark…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setTyped(true);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && results) {
              e.stopPropagation();
              setResults(null);
            }
            if (e.key === "Enter" && results?.[0]) {
              e.preventDefault();
              choose(results[0]);
            }
          }}
          className={clsx(fieldCls, "pl-9 pr-8")}
        />
        {searching && <Spinner className="absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />}
        {results && (
          <ul
            className="absolute inset-x-0 top-full z-[1000] mt-1 max-h-60 overflow-y-auto rounded-xl border border-line bg-surface py-1 text-sm shadow-lg"
            role="listbox"
            aria-label="Address results"
          >
            {results.length === 0 ? (
              <li className="px-3 py-2 text-muted">No places found — drop the pin on the map instead.</li>
            ) : (
              results.map((r) => (
                <li key={`${r.lat},${r.lng},${r.label}`}>
                  <button type="button" role="option" aria-selected={false} onClick={() => choose(r)} className="w-full px-3 py-2 text-left hover:bg-surface-2">
                    {tidy(r.label)}
                  </button>
                </li>
              ))
            )}
          </ul>
        )}
      </div>
      {searchError && <p className="text-xs font-medium text-red-600">{searchError}</p>}
      {geoError && <p className="text-xs font-medium text-red-600">{geoError}</p>}

      {offer && (
        <div className="space-y-1.5 rounded-lg border border-sky-200 bg-sky-50 px-2.5 py-2 text-xs text-sky-900 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-100" role="status">
          <p>
            Address at the pin: <strong>{offer}</strong>
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className="rounded-lg bg-sky-600 px-2.5 py-1 font-semibold text-white hover:bg-sky-700"
              onClick={() => {
                onChange({ address: offer });
                setOffer(null);
              }}
            >
              Use this address
            </button>
            <button type="button" className="rounded-lg border border-sky-300 px-2.5 py-1 font-semibold hover:bg-sky-100 dark:border-sky-500/40 dark:hover:bg-sky-500/20" onClick={() => setOffer(null)}>
              Keep mine
            </button>
          </div>
        </div>
      )}

      {open && (
        <>
          <DeliveryMap value={pin} outlet={outlet} zones={zones} activeZoneId={activeZoneId} onPick={(p) => pick(p)} focusKey={focusKey} height={230} />
          <p className="text-[11px] text-muted">Tap the map or drag the red pin to the exact door. {outlet ? "Circles show the delivery zones." : "Outlet location isn't set — zones can't be drawn."}</p>
        </>
      )}
    </div>
  );
}
