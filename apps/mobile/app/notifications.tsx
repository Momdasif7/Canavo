import React, { useState } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, StyleSheet, View } from "react-native";
import { Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useAuth } from "../src/auth/AuthContext";
import { Screen } from "../src/components/Screen";
import { AppText, Button, EmptyState, Loading, Notice, Row, Segmented } from "../src/components/ui";
import { formatDate, formatTime } from "../src/lib/format";
import type { AppNotification } from "../src/lib/types";
import { iconForKind } from "../src/notifications/NotificationBanner";
import { routeForNotification } from "../src/notifications/links";
import { useNotifications, type InboxFilter } from "../src/notifications/NotificationsContext";
import { radius, space, TAP, useTheme } from "../src/theme";

const FILTERS: { value: InboxFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "unread", label: "Unread" },
];

export default function NotificationsScreen() {
  const t = useTheme();
  const { access, me } = useAuth();
  const { items, unread, error, loading, loadingMore, hasMore, filter, push, setFilter, refresh, loadMore, markRead, markAllRead, clearRead, open } =
    useNotifications();
  const [clearing, setClearing] = useState(false);
  const hasRead = !!items?.some((n) => n.read);

  const confirmClear = () =>
    Alert.alert("Clear read notifications?", "Notifications you've already read are deleted. Unread ones stay.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clear read",
        style: "destructive",
        onPress: async () => {
          setClearing(true);
          try {
            await clearRead();
          } catch {
            Alert.alert("Could not clear", "Check your connection and try again.");
          } finally {
            setClearing(false);
          }
        },
      },
    ]);

  const outletName = (id: string | null | undefined) => (id && me?.outlets.length && me.outlets.length > 1 ? me.outlets.find((o) => o.id === id)?.name : null);

  const renderItem = ({ item: n }: { item: AppNotification }) => {
    const canOpen = !!routeForNotification(n, access);
    const where = outletName(n.outletId);
    return (
      <Pressable
        onPress={() => void open(n, { fallback: "stay" })}
        accessibilityRole="button"
        accessibilityLabel={`${n.read ? "" : "Unread. "}${n.title}. ${n.body}${canOpen ? ". Opens the related screen." : ""}`}
        style={({ pressed }) => [
          styles.row,
          { backgroundColor: n.read ? t.surface : t.surfaceAlt, borderColor: n.read ? t.border : t.primary, opacity: pressed ? 0.85 : 1 },
        ]}
      >
        <View style={[styles.icon, { backgroundColor: n.read ? t.surfaceAlt : t.primary }]}>
          <Ionicons name={iconForKind(n.kind)} size={20} color={n.read ? t.textMuted : "#fff"} />
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Row style={{ justifyContent: "space-between", alignItems: "flex-start" }}>
            <AppText style={{ fontWeight: n.read ? "600" : "800", flex: 1 }} numberOfLines={2}>
              {n.title}
            </AppText>
            <AppText variant="small">{formatTime(n.createdAt)}</AppText>
          </Row>
          <AppText variant="muted">{n.body}</AppText>
          <Row style={{ flexWrap: "wrap", gap: 6 }}>
            <AppText variant="small">{formatDate(n.createdAt)}</AppText>
            {where ? <AppText variant="small">· {where}</AppText> : null}
            {canOpen ? (
              <AppText variant="small" color={t.primary} style={{ fontWeight: "800" }}>
                · Open ›
              </AppText>
            ) : null}
          </Row>
        </View>
        {!n.read ? (
          <Pressable
            onPress={() => void markRead(n.id)}
            hitSlop={6}
            style={[styles.readBtn, { borderColor: t.border }]}
            accessibilityRole="button"
            accessibilityLabel="Mark as read"
          >
            <Ionicons name="checkmark-done" size={22} color={t.success} />
          </Pressable>
        ) : null}
      </Pressable>
    );
  };

  return (
    <Screen edges={[]} scroll={false}>
      <Stack.Screen options={{ title: unread ? `Notifications (${unread})` : "Notifications" }} />
      <View style={{ paddingHorizontal: space.md, paddingTop: space.md, gap: space.sm }}>
        <Segmented options={FILTERS.map((f) => (f.value === "unread" && unread ? { ...f, label: `Unread (${unread > 99 ? "99+" : unread})` } : f))} value={filter} onChange={setFilter} />
        <Row>
          <Button title="Mark all read" icon="checkmark-done" variant="secondary" size="md" style={{ flex: 1 }} disabled={!unread} onPress={() => void markAllRead()} />
          <Button
            title="Clear read"
            icon="trash-outline"
            variant="secondary"
            size="md"
            style={{ flex: 1 }}
            disabled={!hasRead || filter === "unread"}
            loading={clearing}
            onPress={confirmClear}
          />
        </Row>
      </View>
      {push && !push.ok && push.reason === "denied" ? (
        <Notice kind="warning" style={{ margin: space.md }} message="Push notifications are off for CANAVO. Turn them on in phone Settings to get alerts when the app is closed." />
      ) : null}
      {error && !items ? <Notice kind="error" style={{ margin: space.md }} message={error} /> : null}
      {!items && !error ? <Loading /> : null}
      {items ? (
        <FlatList
          data={items}
          keyExtractor={(n) => n.id}
          renderItem={renderItem}
          contentContainerStyle={{ padding: space.md, gap: space.sm, paddingBottom: space.xl * 2 }}
          refreshControl={<RefreshControl refreshing={loading} onRefresh={refresh} colors={[t.primary]} tintColor={t.primary} />}
          onEndReached={() => void loadMore()}
          onEndReachedThreshold={0.4}
          ListFooterComponent={
            loadingMore ? (
              <ActivityIndicator color={t.primary} style={{ margin: space.md }} />
            ) : hasMore ? (
              <Button title="Load older" variant="ghost" size="md" onPress={() => void loadMore()} />
            ) : null
          }
          ListEmptyComponent={
            <EmptyState
              icon="notifications-outline"
              title={filter === "unread" ? "All caught up" : "No notifications"}
              message={filter === "unread" ? "No unread notifications." : "Orders, deliveries, low stock and leave updates show up here."}
            />
          }
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: space.md, borderWidth: 1, borderRadius: radius.md, padding: space.md, alignItems: "flex-start" },
  icon: { width: 38, height: 38, borderRadius: 19, alignItems: "center", justifyContent: "center" },
  readBtn: { width: TAP - 8, height: TAP - 8, borderRadius: radius.md, borderWidth: 1, alignItems: "center", justifyContent: "center" },
});
