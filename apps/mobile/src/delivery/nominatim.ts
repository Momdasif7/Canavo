/**
 * OpenStreetMap Nominatim search / reverse geocoding (no API key). Usage
 * policy: ≤1 request/second, identify the app, cache where possible — the
 * picker debounces typing and only reverse-geocodes when the pin settles.
 */
import type { LatLng } from "./leafletHtml";

const BASE = "https://nominatim.openstreetmap.org";
const HEADERS = { Accept: "application/json", "Accept-Language": "en-IN,en", "User-Agent": "CANAVO-POS/1.0 (in.canavo.app)" };

export interface Place extends LatLng {
  id: string;
  /** Short first line, e.g. "MG Road" */
  title: string;
  /** Full address */
  address: string;
}

interface NominatimRow {
  place_id: number;
  lat: string;
  lon: string;
  display_name: string;
  name?: string;
  address?: Record<string, string>;
}

/** Readable address from Nominatim parts (house, road, area, city, PIN), falling back to display_name. */
export function formatAddress(row: Pick<NominatimRow, "display_name" | "address">): string {
  const a = row.address;
  if (!a) return row.display_name;
  const parts = [
    [a.house_number, a.building ?? a.amenity].filter(Boolean).join(" "),
    a.road,
    a.neighbourhood ?? a.suburb ?? a.quarter,
    a.city_district,
    a.city ?? a.town ?? a.village ?? a.county,
    a.postcode,
  ].filter((p) => p && p.trim());
  const uniq = parts.filter((p, i) => parts.indexOf(p) === i);
  return uniq.length >= 2 ? uniq.join(", ") : row.display_name;
}

const toPlace = (r: NominatimRow): Place => ({
  id: String(r.place_id),
  lat: Number(r.lat),
  lng: Number(r.lon),
  title: r.name || r.display_name.split(",")[0],
  address: formatAddress(r),
});

// React Native's URLSearchParams polyfill is incomplete (no set/get), so build query strings by hand.
const qs = (o: Record<string, string>) =>
  Object.entries(o)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

/** Query string for a search (India only; biased to ~25 km around `near`). */
export function searchUrl(q: string, near?: LatLng | null, limit = 6): string {
  const p: Record<string, string> = { q, format: "jsonv2", addressdetails: "1", countrycodes: "in", limit: String(limit) };
  if (near) {
    const d = 0.25;
    p.viewbox = [near.lng - d, near.lat + d, near.lng + d, near.lat - d].map((n) => n.toFixed(4)).join(",");
  }
  return `${BASE}/search?${qs(p)}`;
}

export const reverseUrl = (p: LatLng) =>
  `${BASE}/reverse?${qs({ lat: p.lat.toFixed(6), lon: p.lng.toFixed(6), format: "jsonv2", addressdetails: "1", zoom: "18" })}`;

export async function searchPlaces(q: string, near?: LatLng | null, signal?: AbortSignal): Promise<Place[]> {
  const res = await fetch(searchUrl(q, near), { headers: HEADERS, signal });
  if (!res.ok) throw new Error(`Search failed (${res.status})`);
  return ((await res.json()) as NominatimRow[]).map(toPlace).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
}

export async function reverseGeocode(p: LatLng, signal?: AbortSignal): Promise<string | null> {
  const res = await fetch(reverseUrl(p), { headers: HEADERS, signal });
  if (!res.ok) return null;
  const row = (await res.json()) as NominatimRow & { error?: string };
  return row.error ? null : formatAddress(row);
}
