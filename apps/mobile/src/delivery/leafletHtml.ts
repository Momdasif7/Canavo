/**
 * Self-contained Leaflet + OpenStreetMap page for react-native-webview. No
 * Google key needed, works in Expo Go. Pure string builder (node-testable).
 *
 * Messages page → app (window.ReactNativeWebView.postMessage, JSON):
 *   { type: "ready" } | { type: "pin", lat, lng } (tap / drag end) | { type: "error", message }
 * App → page (injectJavaScript):
 *   window.canavoSetPin(lat, lng, fly)
 */
export interface LatLng {
  lat: number;
  lng: number;
}

export interface MapZone {
  name: string;
  radiusKm: number;
  active?: boolean;
}

export interface LeafletOptions {
  /** Start position (falls back to the outlet, then to central India) */
  center?: LatLng | null;
  zoom?: number;
  outlet?: (LatLng & { name?: string }) | null;
  zones?: MapZone[];
  pin?: LatLng | null;
  /** false = read-only mini map: no pan / zoom / tap */
  interactive?: boolean;
  dark?: boolean;
}

const LEAFLET_VERSION = "1.9.4";
export const LEAFLET_CSS = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.css`;
export const LEAFLET_JS = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist/leaflet.js`;
const INDIA: LatLng = { lat: 20.5937, lng: 78.9629 };

const ZONE_COLORS = ["#2D6A4F", "#1565C0", "#B26A00", "#7B1FA2", "#C62828"];

export const validLatLng = (p: Partial<LatLng> | null | undefined): p is LatLng =>
  !!p && typeof p.lat === "number" && typeof p.lng === "number" && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;

/** JS call that moves the pin (for WebView.injectJavaScript). */
export const setPinScript = (p: LatLng, fly = true) =>
  `window.canavoSetPin && window.canavoSetPin(${Number(p.lat)}, ${Number(p.lng)}, ${fly ? "true" : "false"}); true;`;

export function leafletHtml(o: LeafletOptions): string {
  const interactive = o.interactive !== false;
  const outlet = validLatLng(o.outlet) ? o.outlet : null;
  const pin = validLatLng(o.pin) ? o.pin : null;
  const center = (validLatLng(o.center) && o.center) || pin || outlet || INDIA;
  const zoom = o.zoom ?? (pin || outlet ? 15 : 5);
  const zones = outlet ? (o.zones ?? []).filter((z) => z.active !== false && z.radiusKm > 0) : [];
  // JSON.stringify output is safe inside <script> once "<" is escaped.
  const data = JSON.stringify({
    center,
    zoom,
    outlet: outlet ? { lat: outlet.lat, lng: outlet.lng, name: outlet.name ?? "Outlet" } : null,
    zones: zones.map((z, i) => ({ name: z.name, radiusM: z.radiusKm * 1000, color: ZONE_COLORS[i % ZONE_COLORS.length] })),
    pin,
    interactive,
  }).replace(/</g, "\\u003c");
  const bg = o.dark ? "#1A1A2E" : "#F1EFEA";
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
<link rel="stylesheet" href="${LEAFLET_CSS}" />
<style>
  html, body, #map { margin: 0; padding: 0; height: 100%; width: 100%; background: ${bg}; }
  .leaflet-control-attribution { font-size: 9px; }
  ${o.dark ? ".leaflet-tile { filter: brightness(0.75) contrast(1.1) saturate(0.8); }" : ""}
  .outlet-dot { width: 18px; height: 18px; border-radius: 9px; background: #FF6B35; border: 3px solid #fff; box-shadow: 0 1px 4px rgba(0,0,0,.45); }
</style>
</head><body>
<div id="map"></div>
<script src="${LEAFLET_JS}"></script>
<script>
(function () {
  var D = ${data};
  function post(m) { try { window.ReactNativeWebView && window.ReactNativeWebView.postMessage(JSON.stringify(m)); } catch (e) {} }
  if (!window.L) { post({ type: "error", message: "Map could not load (no internet?)" }); return; }
  var map = L.map("map", {
    zoomControl: D.interactive, dragging: D.interactive, touchZoom: D.interactive, doubleClickZoom: D.interactive,
    scrollWheelZoom: D.interactive, boxZoom: false, keyboard: false, tap: D.interactive, attributionControl: true
  }).setView([D.center.lat, D.center.lng], D.zoom);
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: "&copy; OpenStreetMap" }).addTo(map);
  var bounds = [];
  if (D.outlet) {
    D.zones.forEach(function (z) {
      var c = L.circle([D.outlet.lat, D.outlet.lng], { radius: z.radiusM, color: z.color, weight: 2, fillOpacity: 0.06, interactive: false }).addTo(map);
      if (D.interactive) c.bindTooltip(z.name, { sticky: true });
      bounds.push(c.getBounds());
    });
    L.marker([D.outlet.lat, D.outlet.lng], {
      icon: L.divIcon({ className: "", html: '<div class="outlet-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
      interactive: false, keyboard: false
    }).addTo(map);
  }
  var pin = null;
  function setPin(lat, lng, fly) {
    if (!pin) {
      pin = L.marker([lat, lng], { draggable: D.interactive, autoPan: true }).addTo(map);
      pin.on("dragend", function () { var p = pin.getLatLng(); post({ type: "pin", lat: p.lat, lng: p.lng }); });
    } else pin.setLatLng([lat, lng]);
    if (fly) map.setView([lat, lng], Math.max(map.getZoom(), 16));
  }
  window.canavoSetPin = setPin;
  if (D.pin) setPin(D.pin.lat, D.pin.lng, false);
  else if (D.interactive && bounds.length) {
    var b = bounds[bounds.length - 1];
    map.fitBounds(b, { padding: [16, 16] });
  }
  if (!D.interactive && D.pin && D.outlet) {
    map.fitBounds(L.latLngBounds([[D.pin.lat, D.pin.lng], [D.outlet.lat, D.outlet.lng]]), { padding: [24, 24], maxZoom: 16 });
  }
  if (D.interactive) {
    map.on("click", function (e) { setPin(e.latlng.lat, e.latlng.lng, false); post({ type: "pin", lat: e.latlng.lat, lng: e.latlng.lng }); });
  }
  post({ type: "ready" });
})();
</script>
</body></html>`;
}
