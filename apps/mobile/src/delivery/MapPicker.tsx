import React, { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, FlatList, Modal, Pressable, StyleSheet, TextInput, useColorScheme, View } from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import { SafeAreaView } from "react-native-safe-area-context";
import * as Location from "expo-location";
import * as Haptics from "expo-haptics";
import { Ionicons } from "@expo/vector-icons";
import { AppText, Button, Notice, Row } from "../components/ui";
import { endpoints, errorMessage } from "../lib/api";
import { inr, inrShort } from "../lib/format";
import type { DeliveryQuote, DeliveryZone, Outlet } from "../lib/types";
import { font, radius, space, TAP, useTheme } from "../theme";
import { leafletHtml, setPinScript, validLatLng, type LatLng } from "./leafletHtml";
import { MAP_BASE_URL } from "./MiniMap";
import { reverseGeocode, searchPlaces, type Place } from "./nominatim";

const SEARCH_DEBOUNCE_MS = 700;
const REVERSE_DEBOUNCE_MS = 600;

export interface PickedLocation extends LatLng {
  /** Reverse-geocoded address (null when the lookup failed) */
  address: string | null;
  /** Replace the typed address with `address` */
  fillAddress: boolean;
}

/**
 * Full-screen map to pin the exact delivery spot: OpenStreetMap search
 * (India), tap / drag the marker, "Use my location", outlet marker and zone
 * circles, and a live quote (distance, zone, fee, ETA) for the pin.
 */
export function MapPicker({
  visible,
  initial,
  outlet: outletProp,
  addressEmpty,
  onClose,
  onConfirm,
}: {
  visible: boolean;
  initial: LatLng | null;
  /** Outlet from the POS catalog; fetched when missing */
  outlet: Outlet | null;
  /** The address box is empty → fill it from the map by default */
  addressEmpty: boolean;
  onClose: () => void;
  onConfirm: (p: PickedLocation) => void;
}) {
  const t = useTheme();
  const dark = useColorScheme() === "dark";
  const web = useRef<WebView>(null);
  const [outlet, setOutlet] = useState<Outlet | null>(outletProp);
  const [zones, setZones] = useState<DeliveryZone[] | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pin, setPin] = useState<LatLng | null>(initial);
  const pinRef = useRef(pin);
  pinRef.current = pin;
  const [address, setAddress] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [quote, setQuote] = useState<DeliveryQuote | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Place[]>([]);
  const [searching, setSearching] = useState(false);
  const [locating, setLocating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fill, setFill] = useState(addressEmpty);

  // Fresh state each time it opens.
  useEffect(() => {
    if (!visible) return;
    setPin(initial);
    setFill(addressEmpty);
    setQuery("");
    setResults([]);
    setError(null);
    setAddress(null);
    setQuote(null);
    setLoaded(false);
    let cancelled = false;
    // Outlet position + zone circles before the page is built (so it loads once).
    Promise.all([
      outletProp ? Promise.resolve(outletProp) : endpoints.currentOutlet().catch(() => null),
      endpoints.deliveryZones().catch(() => endpoints.deliveryQuote({}).then((q) => q.zones).catch(() => [] as DeliveryZone[])),
    ]).then(([o, z]) => {
      if (cancelled) return;
      setOutlet(o);
      setZones(z);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
    // Only on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const outletPos = outlet && outlet.latitude != null && outlet.longitude != null ? { lat: outlet.latitude, lng: outlet.longitude } : null;
  const html = useMemo(
    () =>
      loaded
        ? leafletHtml({
            pin: pinRef.current,
            center: pinRef.current ?? outletPos,
            outlet: outletPos ? { ...outletPos, name: outlet?.name } : null,
            zones: zones ?? [],
            interactive: true,
            dark,
          })
        : "",
    // Built once per open (pin moves go through injectJavaScript).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [loaded, dark],
  );

  // Pin moved → reverse geocode + quote (debounced).
  useEffect(() => {
    if (!visible || !pin) return;
    const ctrl = new AbortController();
    setResolving(true);
    const timer = setTimeout(async () => {
      const [addr, q] = await Promise.all([
        reverseGeocode(pin, ctrl.signal).catch(() => null),
        endpoints.deliveryQuote({ lat: pin.lat, lng: pin.lng }).catch((e) => {
          if (!ctrl.signal.aborted) setError(errorMessage(e));
          return null;
        }),
      ]);
      if (ctrl.signal.aborted) return;
      setAddress(addr);
      setQuote(q);
      setResolving(false);
    }, REVERSE_DEBOUNCE_MS);
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [pin, visible]);

  // Search as you type (debounced; Nominatim allows ~1 request/second).
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) {
      setResults([]);
      setSearching(false);
      return;
    }
    const ctrl = new AbortController();
    setSearching(true);
    const timer = setTimeout(async () => {
      try {
        const r = await searchPlaces(q, pinRef.current ?? outletPos, ctrl.signal);
        if (!ctrl.signal.aborted) setResults(r);
      } catch (e) {
        if (!ctrl.signal.aborted) setError(errorMessage(e, "Search failed"));
      } finally {
        if (!ctrl.signal.aborted) setSearching(false);
      }
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const movePin = (p: LatLng) => {
    setPin(p);
    web.current?.injectJavaScript(setPinScript(p, true));
  };

  const onMessage = (e: WebViewMessageEvent) => {
    try {
      const m = JSON.parse(e.nativeEvent.data) as { type: string; lat?: number; lng?: number; message?: string };
      if (m.type === "pin" && validLatLng({ lat: m.lat, lng: m.lng })) {
        setPin({ lat: m.lat!, lng: m.lng! });
        void Haptics.selectionAsync();
      } else if (m.type === "error") setError(m.message ?? "Map error");
    } catch {
      // Ignore anything that isn't ours.
    }
  };

  const useMyLocation = async () => {
    setLocating(true);
    setError(null);
    try {
      const perm = await Location.requestForegroundPermissionsAsync();
      if (perm.status !== "granted") throw new Error("Location permission is needed to use your position.");
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
      movePin({ lat: pos.coords.latitude, lng: pos.coords.longitude });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      setError(errorMessage(e, "Could not get your location"));
    } finally {
      setLocating(false);
    }
  };

  const pickResult = (p: Place) => {
    setResults([]);
    setQuery(p.title);
    movePin({ lat: p.lat, lng: p.lng });
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onRequestClose={onClose}>
      <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }} edges={["top", "bottom"]}>
        <Row style={[styles.header, { borderBottomColor: t.border, backgroundColor: t.surface }]}>
          <Pressable onPress={onClose} style={styles.iconBtn} accessibilityRole="button" accessibilityLabel="Close map">
            <Ionicons name="close" size={26} color={t.text} />
          </Pressable>
          <AppText variant="h3" style={{ flex: 1 }} numberOfLines={1}>
            Pin delivery location
          </AppText>
        </Row>

        <View style={{ padding: space.md, gap: space.sm, zIndex: 2 }}>
          <View style={[styles.search, { backgroundColor: t.surface, borderColor: t.border }]}>
            <Ionicons name="search" size={20} color={t.textMuted} />
            <TextInput
              value={query}
              onChangeText={setQuery}
              placeholder="Search area, street, landmark"
              placeholderTextColor={t.textMuted}
              style={{ flex: 1, color: t.text, fontSize: font.lg, minHeight: 48 }}
              returnKeyType="search"
              autoCorrect={false}
            />
            {searching ? <ActivityIndicator color={t.primary} /> : null}
            {query ? (
              <Pressable onPress={() => setQuery("")} hitSlop={12} accessibilityLabel="Clear search">
                <Ionicons name="close-circle" size={22} color={t.textMuted} />
              </Pressable>
            ) : null}
          </View>
          {results.length ? (
            <View style={[styles.results, { backgroundColor: t.surface, borderColor: t.border }]}>
              <FlatList
                data={results}
                keyExtractor={(p) => p.id}
                keyboardShouldPersistTaps="handled"
                renderItem={({ item: p }) => (
                  <Pressable
                    onPress={() => pickResult(p)}
                    style={({ pressed }) => [styles.result, { borderBottomColor: t.border, backgroundColor: pressed ? t.surfaceAlt : t.surface }]}
                    accessibilityRole="button"
                  >
                    <Ionicons name="location-outline" size={20} color={t.primary} />
                    <View style={{ flex: 1 }}>
                      <AppText style={{ fontWeight: "700" }} numberOfLines={1}>
                        {p.title}
                      </AppText>
                      <AppText variant="small" numberOfLines={2}>
                        {p.address}
                      </AppText>
                    </View>
                  </Pressable>
                )}
              />
            </View>
          ) : null}
        </View>

        <View style={{ flex: 1 }}>
          {html ? (
            <WebView
              ref={web}
              source={{ html, baseUrl: MAP_BASE_URL }}
              originWhitelist={["*"]}
              onMessage={onMessage}
              javaScriptEnabled
              setSupportMultipleWindows={false}
              style={{ flex: 1, backgroundColor: t.surfaceAlt }}
            />
          ) : (
            <View style={styles.center}>
              <ActivityIndicator color={t.primary} size="large" />
              <AppText variant="muted">Loading map…</AppText>
            </View>
          )}
          <Pressable
            onPress={useMyLocation}
            disabled={locating}
            accessibilityRole="button"
            accessibilityLabel="Use my location"
            style={[styles.locate, { backgroundColor: t.surface, borderColor: t.border }]}
          >
            {locating ? <ActivityIndicator color={t.primary} /> : <Ionicons name="locate" size={22} color={t.primary} />}
            <AppText style={{ fontWeight: "800" }}>Use my location</AppText>
          </Pressable>
          {!pin && html ? (
            <View style={[styles.tip, { backgroundColor: t.surface }]} pointerEvents="none">
              <AppText style={{ fontWeight: "700" }}>Tap the map to drop the pin</AppText>
            </View>
          ) : null}
        </View>

        <View style={[styles.panel, { backgroundColor: t.surface, borderTopColor: t.border }]}>
          {pin ? (
            <>
              <Row style={{ alignItems: "flex-start" }}>
                <Ionicons name="location" size={20} color={t.primary} style={{ marginTop: 2 }} />
                <AppText style={{ flex: 1, fontWeight: "600" }} numberOfLines={3}>
                  {resolving && !address ? "Finding the address…" : address ?? `${pin.lat.toFixed(5)}, ${pin.lng.toFixed(5)}`}
                </AppText>
              </Row>
              <QuoteLine quote={quote} loading={resolving} />
              {address ? (
                <Pressable
                  onPress={() => setFill((f) => !f)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: fill }}
                  style={styles.fill}
                >
                  <Ionicons name={fill ? "checkbox" : "square-outline"} size={24} color={fill ? t.primary : t.textMuted} />
                  <AppText style={{ flex: 1 }}>Use this as the delivery address</AppText>
                </Pressable>
              ) : null}
            </>
          ) : (
            <AppText variant="muted">Search, tap the map or use your location. Drag the pin to adjust.</AppText>
          )}
          {error ? <Notice kind="error" message={error} /> : null}
          <Button
            title="Confirm location"
            icon="checkmark-circle"
            size="lg"
            variant="success"
            disabled={!pin}
            onPress={() => pin && onConfirm({ ...pin, address, fillAddress: fill && !!address })}
          />
        </View>
      </SafeAreaView>
    </Modal>
  );
}

/** "3.2 km · Zone A · fee ₹40 · ~35 min" or "outside our delivery zones". */
export function QuoteLine({ quote, loading }: { quote: DeliveryQuote | null; loading?: boolean }) {
  const t = useTheme();
  if (!quote) return loading ? <AppText variant="small">Checking delivery zone…</AppText> : null;
  if (quote.deliveryEnabled === false) return <Notice kind="error" message="Delivery is switched off for this outlet." />;
  if (quote.distanceKm == null) return null;
  if (!quote.deliverable) {
    return (
      <AppText color={t.danger} style={{ fontWeight: "800" }}>
        {quote.distanceKm} km away — outside our delivery zones
      </AppText>
    );
  }
  return (
    <AppText color={t.success} style={{ fontWeight: "800" }}>
      {quote.distanceKm} km · {quote.zone?.name ?? "zone"} · fee {inr(quote.fee ?? 0)} · ~{quote.etaMinutes ?? "?"} min
      {quote.minOrder ? ` · min order ${inrShort(quote.minOrder)}` : ""}
    </AppText>
  );
}

const styles = StyleSheet.create({
  header: { minHeight: 56, paddingHorizontal: space.sm, borderBottomWidth: 1 },
  iconBtn: { width: TAP, height: TAP, alignItems: "center", justifyContent: "center" },
  search: { flexDirection: "row", alignItems: "center", gap: space.sm, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space.md },
  results: { position: "absolute", top: 68, left: space.md, right: space.md, maxHeight: 280, borderWidth: 1, borderRadius: radius.md, overflow: "hidden", elevation: 6 },
  result: { flexDirection: "row", alignItems: "center", gap: space.sm, padding: space.md, minHeight: TAP, borderBottomWidth: StyleSheet.hairlineWidth },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.sm },
  locate: {
    position: "absolute",
    right: space.md,
    bottom: space.md,
    minHeight: TAP,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    borderWidth: 1,
    elevation: 4,
  },
  tip: { position: "absolute", top: space.md, alignSelf: "center", paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill, elevation: 3 },
  panel: { padding: space.md, gap: space.sm, borderTopWidth: 1 },
  fill: { flexDirection: "row", alignItems: "center", gap: space.sm, minHeight: 44 },
});
