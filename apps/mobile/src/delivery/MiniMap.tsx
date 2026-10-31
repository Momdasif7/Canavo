import React, { useMemo } from "react";
import { Pressable, StyleSheet, useColorScheme, View } from "react-native";
import { WebView } from "react-native-webview";
import { Ionicons } from "@expo/vector-icons";
import { AppText } from "../components/ui";
import { radius, useTheme } from "../theme";
import { leafletHtml, validLatLng, type LatLng } from "./leafletHtml";

/** Page origin for the WebView, so OSM tile requests carry a Referer (tile usage policy). */
export const MAP_BASE_URL = "https://in.canavo.app/";

/**
 * Read-only map with the delivery pin (and the outlet when known). Tap opens
 * `onPress` (e.g. navigation in Google Maps). Renders nothing without a pin.
 */
export function MiniMap({
  pin,
  outlet,
  height = 140,
  onPress,
  label,
}: {
  pin: Partial<LatLng> | null | undefined;
  outlet?: Partial<LatLng> | null;
  height?: number;
  onPress?: () => void;
  label?: string;
}) {
  const t = useTheme();
  const dark = useColorScheme() === "dark";
  const valid = validLatLng(pin);
  const html = useMemo(
    () =>
      valid
        ? leafletHtml({ pin: pin as LatLng, outlet: validLatLng(outlet) ? outlet : null, interactive: false, zoom: 16, dark })
        : "",
    // Re-render only when the coordinates change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [valid, pin?.lat, pin?.lng, outlet?.lat, outlet?.lng, dark],
  );
  if (!valid) return null;
  return (
    <Pressable
      onPress={onPress}
      disabled={!onPress}
      accessibilityRole={onPress ? "button" : "image"}
      accessibilityLabel={label ?? "Delivery location on the map"}
      style={[styles.wrap, { height, borderColor: t.border, backgroundColor: t.surfaceAlt }]}
    >
      {/* The page is non-interactive; the overlay catches taps so the list still scrolls. */}
      <WebView
        source={{ html, baseUrl: MAP_BASE_URL }}
        originWhitelist={["*"]}
        style={{ flex: 1, backgroundColor: "transparent" }}
        scrollEnabled={false}
        nestedScrollEnabled={false}
        javaScriptEnabled
        pointerEvents="none"
        setSupportMultipleWindows={false}
      />
      <View style={StyleSheet.absoluteFill} />
      {label ? (
        <View style={[styles.label, { backgroundColor: t.surface }]}>
          <Ionicons name="location" size={14} color={t.primary} />
          <AppText variant="small" numberOfLines={1} style={{ flexShrink: 1, color: t.text, fontWeight: "700" }}>
            {label}
          </AppText>
        </View>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  wrap: { borderRadius: radius.md, borderWidth: 1, overflow: "hidden" },
  label: {
    position: "absolute",
    left: 8,
    bottom: 8,
    right: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: radius.pill,
    alignSelf: "flex-start",
  },
});
