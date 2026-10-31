"use client";

import dynamic from "next/dynamic";
import { NavigationArrow } from "@phosphor-icons/react";
import type { LeafletMapProps, LatLng, MapZone } from "./LeafletMap";

export type { LatLng, MapZone };

/** Leaflet touches `window` on import: load it in the browser only. */
export const DeliveryMap = dynamic(() => import("./LeafletMap"), {
  ssr: false,
  loading: () => <div className="h-full min-h-[160px] w-full animate-pulse rounded-xl bg-surface-2" aria-label="Loading map" />,
}) as React.ComponentType<LeafletMapProps>;

/** Turn-by-turn directions (Google Maps) to a point. */
export const navigateLink = (p: LatLng) => `https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lng}`;

/** Small read-only map of a delivery pin with a Navigate link. */
export function DeliveryPinMap({ pin, outlet, height = 160, label }: { pin: LatLng; outlet?: LatLng | null; height?: number; label?: string }) {
  return (
    <div className="space-y-1.5" data-testid="delivery-pin-map">
      <DeliveryMap value={pin} outlet={outlet} height={height} />
      <div className="flex items-center gap-2 text-xs">
        <span className="tabular min-w-0 flex-1 truncate text-muted">{label ?? `${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}`}</span>
        <a
          href={navigateLink(pin)}
          target="_blank"
          rel="noreferrer"
          className="flex shrink-0 items-center gap-1 rounded-lg border border-sky-500 px-2 py-1 font-semibold text-sky-700 hover:bg-sky-50 dark:text-sky-300 dark:hover:bg-sky-500/10"
        >
          <NavigationArrow size={14} weight="fill" /> Navigate
        </a>
      </div>
    </div>
  );
}
