"use client";

/**
 * Leaflet map for delivery locations. Client-only — load it through
 * `DeliveryMap` (next/dynamic, ssr: false), never import it directly.
 */
import "leaflet/dist/leaflet.css";
import { useEffect, useMemo, useRef } from "react";
import L from "leaflet";
import { Circle, MapContainer, Marker, TileLayer, Tooltip, useMap, useMapEvents } from "react-leaflet";

export interface LatLng {
  lat: number;
  lng: number;
}

export interface MapZone {
  id: string;
  name: string;
  radiusKm: number;
}

export interface LeafletMapProps {
  /** Delivery pin */
  value: LatLng | null;
  /** Outlet position (marker + zone centre) */
  outlet?: LatLng | null;
  /** Delivery zones, drawn as circles of radiusKm around the outlet */
  zones?: MapZone[];
  /** Zone the pin falls in (highlighted) */
  activeZoneId?: string | null;
  /** Click / drag sets the pin; omit for a read-only map */
  onPick?: (p: LatLng) => void;
  /** Bumped when the view should re-centre on `value` (e.g. a search result was chosen) */
  focusKey?: number;
  height?: number;
  className?: string;
}

const INDIA: LatLng = { lat: 20.5937, lng: 78.9629 };

/** Inline SVG pins (Leaflet's default PNG icons don't resolve through the bundler). */
const pinIcon = (color: string, glyph: string) =>
  L.divIcon({
    className: "canavo-pin",
    html: `<svg xmlns="http://www.w3.org/2000/svg" width="30" height="40" viewBox="0 0 30 40" aria-hidden="true"><path d="M15 39s13-13.6 13-24A13 13 0 0 0 2 15c0 10.4 13 24 13 24z" fill="${color}" stroke="#fff" stroke-width="2"/><text x="15" y="20" text-anchor="middle" font-size="13" font-family="system-ui, sans-serif" font-weight="700" fill="#fff">${glyph}</text></svg>`,
    iconSize: [30, 40],
    iconAnchor: [15, 39],
    tooltipAnchor: [0, -34],
  });

const ZONE_COLORS = ["#16a34a", "#0284c7", "#d97706", "#7c3aed", "#db2777"];

function ClickToPick({ onPick }: { onPick?: (p: LatLng) => void }) {
  useMapEvents({
    click: (e) => onPick?.({ lat: e.latlng.lat, lng: e.latlng.lng }),
  });
  return null;
}

/** Re-centre on the pin when asked, and keep tiles correct when the container resizes (collapsible panel). */
function ViewController({ value, outlet, focusKey }: { value: LatLng | null; outlet?: LatLng | null; focusKey?: number }) {
  const map = useMap();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (value) map.setView([value.lat, value.lng], Math.max(map.getZoom(), 16), { animate: true });
    // Only when explicitly asked to focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusKey]);
  useEffect(() => {
    const el = map.getContainer();
    const ro = new ResizeObserver(() => map.invalidateSize());
    ro.observe(el);
    const t = window.setTimeout(() => map.invalidateSize(), 150);
    return () => {
      ro.disconnect();
      window.clearTimeout(t);
    };
  }, [map]);
  // Fit outlet + pin on first paint when both exist.
  useEffect(() => {
    if (value && outlet) map.fitBounds(L.latLngBounds([value.lat, value.lng], [outlet.lat, outlet.lng]).pad(0.35), { maxZoom: 16 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

export default function LeafletMap({ value, outlet, zones = [], activeZoneId, onPick, focusKey, height = 240, className }: LeafletMapProps) {
  const deliveryIcon = useMemo(() => pinIcon("#ef4444", "●"), []);
  const outletIcon = useMemo(() => pinIcon("#ff6b35", "C"), []);
  const center = value ?? outlet ?? INDIA;
  const zoom = value ? 15 : outlet ? 13 : 5;
  const readOnly = !onPick;

  return (
    <div className={className} style={{ height }} data-testid="delivery-map">
      <MapContainer
        center={[center.lat, center.lng]}
        zoom={zoom}
        scrollWheelZoom={!readOnly}
        dragging
        attributionControl
        style={{ height: "100%", width: "100%" }}
        className="canavo-map rounded-xl"
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
          maxZoom={19}
        />
        {outlet &&
          [...zones]
            .sort((a, b) => b.radiusKm - a.radiusKm)
            .map((z, i) => {
              const active = z.id === activeZoneId;
              const color = ZONE_COLORS[i % ZONE_COLORS.length];
              return (
                <Circle
                  key={z.id}
                  center={[outlet.lat, outlet.lng]}
                  radius={z.radiusKm * 1000}
                  pathOptions={{ color, weight: active ? 3 : 1.5, fillOpacity: active ? 0.12 : 0.04, dashArray: active ? undefined : "4 6" }}
                  // Clicks inside a zone still drop the pin.
                  eventHandlers={onPick ? { click: (e) => onPick({ lat: e.latlng.lat, lng: e.latlng.lng }) } : undefined}
                >
                  <Tooltip sticky>
                    {z.name} · {z.radiusKm} km
                  </Tooltip>
                </Circle>
              );
            })}
        {outlet && (
          <Marker position={[outlet.lat, outlet.lng]} icon={outletIcon} interactive>
            <Tooltip>Outlet</Tooltip>
          </Marker>
        )}
        {value && (
          <Marker
            position={[value.lat, value.lng]}
            icon={deliveryIcon}
            draggable={!readOnly}
            eventHandlers={
              onPick
                ? {
                    dragend: (e) => {
                      const p = (e.target as L.Marker).getLatLng();
                      onPick({ lat: p.lat, lng: p.lng });
                    },
                  }
                : undefined
            }
          >
            <Tooltip>{readOnly ? "Delivery location" : "Drag to the exact spot"}</Tooltip>
          </Marker>
        )}
        {!readOnly && <ClickToPick onPick={onPick} />}
        <ViewController value={value} outlet={outlet} focusKey={focusKey} />
      </MapContainer>
    </div>
  );
}
