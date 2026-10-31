/**
 * OpenStreetMap Nominatim geocoding for the delivery map.
 *
 * Usage policy (https://operations.osmfoundation.org/policies/nominatim/):
 * at most 1 request per second, identify the application (we send a Referer
 * naming "CANAVO POS"), and no auto-complete style hammering — callers debounce
 * typing by at least 600 ms and this module spaces requests ≥ 1.1 s apart.
 */

const BASE = "https://nominatim.openstreetmap.org";
const MIN_GAP_MS = 1100;

export interface GeoResult {
  lat: number;
  lng: number;
  /** Full address as Nominatim formats it */
  label: string;
}

let last = 0;
let chain: Promise<unknown> = Promise.resolve();

/** Run `fn` no sooner than MIN_GAP_MS after the previous Nominatim request. */
function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = last + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    last = Date.now();
    return fn();
  });
  chain = run.catch(() => undefined);
  return run;
}

/**
 * Browsers don't let pages set the Referer header directly; a same-origin
 * `referrer` URL plus the "unsafe-url" policy makes the browser send it, so
 * Nominatim sees which application is calling.
 */
function request(url: string, signal?: AbortSignal): Promise<unknown> {
  return throttled(async () => {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const res = await fetch(url, {
      signal,
      headers: { Accept: "application/json", "Accept-Language": "en-IN,en" },
      referrer: `${window.location.origin}/pos?client=CANAVO%20POS`,
      referrerPolicy: "unsafe-url",
    });
    if (!res.ok) throw new Error(res.status === 429 ? "Map search is busy — try again in a moment" : `Map search failed (${res.status})`);
    return res.json();
  });
}

interface NominatimPlace {
  lat: string;
  lon: string;
  display_name: string;
}

const toResult = (p: NominatimPlace): GeoResult | null => {
  const lat = Number(p.lat);
  const lng = Number(p.lon);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng, label: p.display_name } : null;
};

/** Address search, limited to India. */
export async function searchAddress(q: string, signal?: AbortSignal): Promise<GeoResult[]> {
  const url = `${BASE}/search?format=json&countrycodes=in&limit=6&addressdetails=0&q=${encodeURIComponent(q)}`;
  const data = (await request(url, signal)) as NominatimPlace[];
  return (Array.isArray(data) ? data : []).map(toResult).filter((r): r is GeoResult => !!r);
}

/** Address of a point (reverse geocoding). */
export async function reverseGeocode(lat: number, lng: number, signal?: AbortSignal): Promise<GeoResult | null> {
  const url = `${BASE}/reverse?format=json&zoom=18&lat=${lat.toFixed(6)}&lon=${lng.toFixed(6)}`;
  const data = (await request(url, signal)) as Partial<NominatimPlace> & { error?: string };
  if (!data || data.error || !data.display_name) return null;
  return { lat, lng, label: data.display_name };
}

/** Great-circle distance in km (for display before the server quote arrives). */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
