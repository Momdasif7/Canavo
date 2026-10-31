import React, { useCallback, useEffect, useMemo, useState } from "react";
import { FlatList, Pressable, RefreshControl, StyleSheet, TextInput, View } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { useSignedIn } from "../auth/AuthContext";
import { AppText, Button, Chip, EmptyState, ErrorState, Loading, Notice, Row } from "../components/ui";
import { ApiError, endpoints, errorMessage } from "../lib/api";
import { useSocketEvent } from "../lib/socket";
import type { InventoryItem, LowStockAlerts } from "../lib/types";
import { font, radius, space, TAP, useTheme } from "../theme";
import { BarcodeScanner } from "./BarcodeScanner";
import { fmtQty, StockActionSheet } from "./StockActionSheet";

type Filter = "ALL" | "LOW";

/**
 * Stock list for the active outlet: search, low-stock filter and highlight,
 * live low-stock alerts, barcode scan → item, quick adjust / wastage, and
 * links to the stock count (audit) and purchase receiving screens.
 */
export function StockScreen() {
  const t = useTheme();
  const { allowed, outlet } = useSignedIn();
  const canManage = allowed("inventory:manage");
  const [items, setItems] = useState<InventoryItem[] | null>(null);
  const [alerts, setAlerts] = useState<LowStockAlerts | null>(null);
  const [liveAlert, setLiveAlert] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("ALL");
  const [selected, setSelected] = useState<InventoryItem | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [list, a] = await Promise.all([endpoints.inventoryItems(), endpoints.inventoryAlerts()]);
      setItems(list.items);
      setAlerts(a);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    setItems(null);
    void load();
  }, [load, outlet?.id]);

  useSocketEvent("inventory:low", (p) => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    setLiveAlert(p.items.map((i) => `${i.name}: ${fmtQty(i.quantity)} ${i.unit}`).join(" · "));
    void load();
  });

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (items ?? []).filter(
      (i) =>
        (filter === "ALL" || i.lowStock) &&
        (!q || i.name.toLowerCase().includes(q) || i.category.toLowerCase().includes(q) || i.sku?.toLowerCase() === q || i.barcode === q),
    );
  }, [items, query, filter]);

  const onCode = async (code: string) => {
    setScanError(null);
    try {
      const item = await endpoints.inventoryLookup(code);
      setScanning(false);
      setSelected(item);
    } catch (e) {
      setScanError(e instanceof ApiError && e.status === 404 ? `No item with barcode/SKU “${code}”.` : errorMessage(e));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  if (!items && error) return <ErrorState message={error} onRetry={load} />;
  if (!items) return <Loading label="Loading stock…" />;

  const lowCount = alerts?.count ?? items.filter((i) => i.lowStock).length;

  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: space.md, paddingTop: space.md, gap: space.sm }}>
        {liveAlert ? (
          <Pressable onPress={() => setLiveAlert(null)} accessibilityRole="button" accessibilityLabel="Dismiss alert">
            <Notice kind="error" title="Low stock alert" message={liveAlert} />
          </Pressable>
        ) : null}
        {lowCount ? (
          <Pressable onPress={() => setFilter("LOW")} accessibilityRole="button">
            <Notice
              kind="warning"
              title={`${lowCount} item${lowCount === 1 ? "" : "s"} low on stock`}
              message={`${alerts?.outOfStock ? `${alerts.outOfStock} out of stock. ` : ""}Tap to see them.`}
            />
          </Pressable>
        ) : null}
        {toast ? (
          <Pressable onPress={() => setToast(null)}>
            <Notice kind="success" message={toast} />
          </Pressable>
        ) : null}
        <Row>
          <Button title="Scan" icon="barcode-outline" style={{ flex: 1 }} onPress={() => { setScanError(null); setScanning(true); }} />
          {canManage ? (
            <>
              <Button title="Count" icon="clipboard-outline" variant="secondary" style={{ flex: 1 }} onPress={() => router.push("/inventory/audit")} />
              <Button title="Receive" icon="cube-outline" variant="secondary" style={{ flex: 1 }} onPress={() => router.push("/inventory/purchases")} />
            </>
          ) : null}
        </Row>
        <View style={[styles.search, { backgroundColor: t.surface, borderColor: t.border }]}>
          <Ionicons name="search" size={20} color={t.textMuted} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search items, category, SKU"
            placeholderTextColor={t.textMuted}
            style={{ flex: 1, color: t.text, fontSize: font.lg, minHeight: 48 }}
          />
          {query ? (
            <Pressable onPress={() => setQuery("")} hitSlop={12} accessibilityLabel="Clear search">
              <Ionicons name="close-circle" size={22} color={t.textMuted} />
            </Pressable>
          ) : null}
        </View>
        <Row>
          <Chip label={`All (${items.length})`} selected={filter === "ALL"} onPress={() => setFilter("ALL")} />
          <Chip label={`Low stock (${items.filter((i) => i.lowStock).length})`} selected={filter === "LOW"} onPress={() => setFilter("LOW")} />
        </Row>
      </View>
      <FlatList
        data={visible}
        keyExtractor={(i) => i.id}
        contentContainerStyle={{ padding: space.md, gap: space.sm, paddingBottom: space.xl * 2 }}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={async () => {
              setRefreshing(true);
              await load();
              setRefreshing(false);
            }}
            colors={[t.primary]}
            tintColor={t.primary}
          />
        }
        ListEmptyComponent={<EmptyState icon="cube-outline" title={filter === "LOW" ? "Nothing low on stock" : "No items"} message={query ? "Try another search." : undefined} />}
        renderItem={({ item: i }) => {
          const out = i.quantity <= 0;
          const tone = i.lowStock ? (out ? t.danger : t.warning) : t.text;
          return (
            <Pressable
              onPress={() => setSelected(i)}
              accessibilityRole="button"
              accessibilityLabel={`${i.name}, ${fmtQty(i.quantity)} ${i.unit}${i.lowStock ? ", low stock" : ""}`}
              style={({ pressed }) => [
                styles.row,
                {
                  backgroundColor: i.lowStock ? (out ? t.dangerBg : t.warningBg) : t.surface,
                  borderColor: i.lowStock ? tone : t.border,
                  opacity: pressed ? 0.85 : 1,
                },
              ]}
            >
              <View style={{ flex: 1, gap: 2 }}>
                <AppText style={{ fontWeight: "700", fontSize: font.lg }} numberOfLines={1}>
                  {i.name}
                </AppText>
                <AppText variant="small">
                  {i.category} · reorder at {fmtQty(i.reorderLevel)} {i.unit}
                </AppText>
              </View>
              <View style={{ alignItems: "flex-end" }}>
                <AppText style={{ fontSize: font.xl, fontWeight: "900", fontVariant: ["tabular-nums"] }} color={tone}>
                  {fmtQty(i.quantity)}
                </AppText>
                <AppText variant="small">{i.unit}</AppText>
              </View>
              {i.lowStock ? <Ionicons name="alert-circle" size={22} color={tone} /> : null}
            </Pressable>
          );
        }}
      />
      <StockActionSheet
        item={selected}
        canManage={canManage}
        onClose={() => setSelected(null)}
        onDone={(msg) => {
          setSelected(null);
          setToast(msg);
          void load();
        }}
      />
      <BarcodeScanner
        visible={scanning}
        onClose={() => setScanning(false)}
        onCode={onCode}
        hint={scanError ?? undefined}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  search: { flexDirection: "row", alignItems: "center", gap: space.sm, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space.md },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: TAP + 12, borderWidth: 1.5, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm },
});
