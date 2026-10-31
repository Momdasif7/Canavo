import React from "react";
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View, type StyleProp, type ViewStyle } from "react-native";
import { SafeAreaView, type Edge } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { useOffline } from "../offline/OfflineContext";
import { font, space, useTheme } from "../theme";

/** Online/offline strip with the number of bills waiting to sync. */
export function OfflineBanner() {
  const { online, pendingCount, syncing, syncNow } = useOffline();
  const t = useTheme();
  if (online && pendingCount === 0) return null;
  const offline = !online;
  return (
    <Pressable
      onPress={() => online && void syncNow()}
      accessibilityRole="button"
      accessibilityLabel={offline ? "Offline" : "Sync pending bills"}
      style={[styles.banner, { backgroundColor: offline ? t.danger : t.warning }]}
    >
      <Ionicons name={offline ? "cloud-offline" : syncing ? "sync" : "cloud-upload"} size={18} color="#fff" />
      <Text style={styles.bannerText}>
        {offline ? "Offline — bills are saved on this phone" : syncing ? "Syncing bills…" : "Online"}
        {pendingCount > 0 ? ` · ${pendingCount} pending` : ""}
        {!offline && !syncing && pendingCount > 0 ? " · tap to sync" : ""}
      </Text>
    </Pressable>
  );
}

export function Screen({
  children,
  scroll = true,
  refreshing,
  onRefresh,
  edges = ["top"],
  contentStyle,
  banner = true,
}: {
  children: React.ReactNode;
  scroll?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  edges?: Edge[];
  contentStyle?: StyleProp<ViewStyle>;
  banner?: boolean;
}) {
  const t = useTheme();
  return (
    <SafeAreaView edges={edges} style={{ flex: 1, backgroundColor: t.bg }}>
      {banner ? <OfflineBanner /> : null}
      {scroll ? (
        <ScrollView
          contentContainerStyle={[styles.content, contentStyle]}
          keyboardShouldPersistTaps="handled"
          refreshControl={
            onRefresh ? (
              <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={t.primary} colors={[t.primary]} />
            ) : undefined
          }
        >
          {children}
        </ScrollView>
      ) : (
        <View style={[{ flex: 1 }, contentStyle]}>{children}</View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  content: { padding: space.lg, gap: space.lg, paddingBottom: space.xl * 2 },
  banner: { flexDirection: "row", alignItems: "center", gap: space.sm, paddingHorizontal: space.lg, paddingVertical: 10 },
  bannerText: { color: "#fff", fontWeight: "700", fontSize: font.sm, flex: 1 },
});
