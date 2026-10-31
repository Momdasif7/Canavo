import React, { useCallback, useEffect, useState } from "react";
import { FlatList, Pressable, StyleSheet, TextInput, View } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Screen } from "../../src/components/Screen";
import { AppText, EmptyState, ErrorState, Loading, Row } from "../../src/components/ui";
import { endpoints, errorMessage } from "../../src/lib/api";
import { inr } from "../../src/lib/format";
import type { Customer } from "../../src/lib/types";
import { TierBadge } from "../../src/pos/CartExtras";
import { font, radius, space, TAP, useTheme } from "../../src/theme";
import { withAccess } from "../../src/auth/RequireAccess";

function Customers() {
  const t = useTheme();
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<Customer[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const res = await endpoints.customers(q.trim());
      setItems(res.items);
      setTotal(res.total);
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void load(query), query ? 300 : 0);
    return () => clearTimeout(timer);
  }, [query, load]);

  return (
    <Screen edges={[]} scroll={false}>
      <View style={{ padding: space.md, gap: space.sm }}>
        <View style={[styles.search, { backgroundColor: t.surface, borderColor: t.border }]}>
          <Ionicons name="search" size={20} color={t.textMuted} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Name or mobile number"
            placeholderTextColor={t.textMuted}
            style={{ flex: 1, color: t.text, fontSize: font.lg, minHeight: 48 }}
            autoCorrect={false}
          />
          {query ? (
            <Pressable onPress={() => setQuery("")} hitSlop={12} accessibilityLabel="Clear search">
              <Ionicons name="close-circle" size={22} color={t.textMuted} />
            </Pressable>
          ) : null}
        </View>
        {items ? <AppText variant="small">{total} customer{total === 1 ? "" : "s"}{query ? " found" : " · most recent first"}</AppText> : null}
      </View>
      {!items && error ? <ErrorState message={error} onRetry={() => load(query)} /> : null}
      {!items && !error ? <Loading /> : null}
      {items ? (
        <FlatList
          data={items}
          keyExtractor={(c) => c.id}
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: space.md, gap: space.sm, paddingBottom: space.xl * 2 }}
          refreshing={loading}
          onRefresh={() => load(query)}
          ListEmptyComponent={<EmptyState icon="people-outline" title="No customers" message="Customers are saved when a bill has their mobile number." />}
          renderItem={({ item: c }) => (
            <Pressable
              onPress={() => router.push({ pathname: "/customers/[id]", params: { id: c.id } })}
              accessibilityRole="button"
              style={({ pressed }) => [styles.row, { backgroundColor: t.surface, borderColor: c.blocked ? t.danger : t.border, opacity: pressed ? 0.85 : 1 }]}
            >
              <View style={{ flex: 1, gap: 2 }}>
                <Row style={{ gap: 6 }}>
                  <AppText style={{ fontWeight: "800", fontSize: font.lg, flexShrink: 1 }} numberOfLines={1}>
                    {c.name || "Customer"}
                  </AppText>
                  <TierBadge tier={c.tier} />
                </Row>
                <AppText variant="small">
                  +91 {c.phone} · {c.points} pts · {c.visitCount} visits
                </AppText>
              </View>
              {c.khataBalance > 0 ? (
                <View style={{ alignItems: "flex-end" }}>
                  <AppText variant="small">Khata</AppText>
                  <AppText style={{ fontWeight: "900" }} color={t.warning}>
                    {inr(c.khataBalance)}
                  </AppText>
                </View>
              ) : null}
              <Ionicons name="chevron-forward" size={20} color={t.textMuted} />
            </Pressable>
          )}
        />
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({
  search: { flexDirection: "row", alignItems: "center", gap: space.sm, borderWidth: 1, borderRadius: radius.md, paddingHorizontal: space.md },
  row: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: TAP + 12, borderWidth: 1.5, borderRadius: radius.md, paddingHorizontal: space.md, paddingVertical: space.sm },
});

export default withAccess(["customer:view"], Customers);
