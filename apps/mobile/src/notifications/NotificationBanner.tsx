import React, { useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { AppText } from "../components/ui";
import type { NotificationEvent } from "../lib/types";
import { font, radius, space, TAP, useTheme } from "../theme";

type IconName = keyof typeof Ionicons.glyphMap;

export function iconForKind(kind: string | undefined | null): IconName {
  const k = kind ?? "";
  if (k.startsWith("kot")) return "restaurant";
  if (k.startsWith("inventory")) return "cube";
  if (k.startsWith("delivery")) return "bicycle";
  if (k.startsWith("table") || k.startsWith("reservation")) return "grid";
  if (k.startsWith("attendance")) return "time";
  if (k.startsWith("leave")) return "calendar";
  if (k.startsWith("order") || k.startsWith("payment")) return "receipt";
  return "notifications";
}

const VISIBLE_MS = 5000;
const URGENT_VISIBLE_MS = 8000;

/** In-app toast for a live notification. Tap opens it; swipe-free "×" dismisses; auto-hides. */
export function NotificationBanner({
  n,
  urgent,
  onPress,
  onDismiss,
}: {
  n: NotificationEvent;
  urgent: boolean;
  onPress: () => void;
  onDismiss: () => void;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const y = useRef(new Animated.Value(-160)).current;
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;

  useEffect(() => {
    Animated.spring(y, { toValue: 0, useNativeDriver: true, friction: 8 }).start();
    const timer = setTimeout(() => {
      Animated.timing(y, { toValue: -160, duration: 200, useNativeDriver: true }).start(() => dismissRef.current());
    }, urgent ? URGENT_VISIBLE_MS : VISIBLE_MS);
    return () => clearTimeout(timer);
  }, [y, urgent]);

  const accent = urgent ? t.primary : t.info;
  return (
    <Animated.View pointerEvents="box-none" style={[styles.wrap, { top: insets.top + space.sm, transform: [{ translateY: y }] }]}>
      <Pressable
        onPress={onPress}
        accessibilityRole="alert"
        accessibilityLabel={`${n.title}. ${n.body}. Tap to open.`}
        style={({ pressed }) => [
          styles.card,
          { backgroundColor: t.surface, borderColor: accent, borderLeftColor: accent, opacity: pressed ? 0.92 : 1 },
        ]}
      >
        <View style={[styles.icon, { backgroundColor: accent }]}>
          <Ionicons name={iconForKind(n.kind)} size={22} color="#fff" />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <AppText style={{ fontWeight: "900", fontSize: font.md }} numberOfLines={1}>
            {n.title}
          </AppText>
          <AppText variant="small" numberOfLines={2} style={{ color: t.text }}>
            {n.body}
          </AppText>
        </View>
        <Pressable onPress={onDismiss} hitSlop={10} style={styles.close} accessibilityRole="button" accessibilityLabel="Dismiss">
          <Ionicons name="close" size={22} color={t.textMuted} />
        </Pressable>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: "absolute", left: space.md, right: space.md, zIndex: 1000, elevation: 1000 },
  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: 68,
    padding: space.md,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderLeftWidth: 6,
    elevation: 10,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
  },
  icon: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  close: { width: TAP - 12, height: TAP - 12, alignItems: "center", justifyContent: "center" },
});
