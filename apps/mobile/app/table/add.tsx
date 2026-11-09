import React, { useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import type { SessionItemInput } from "@canavo/shared";
import { useSignedIn } from "../../src/auth/AuthContext";
import { Screen } from "../../src/components/Screen";
import { Sheet } from "../../src/components/Sheet";
import { AppText, Button, Chip, ErrorState, Input, Loading, Notice, Row, VegMark } from "../../src/components/ui";
import { endpoints, errorMessage } from "../../src/lib/api";
import { inr } from "../../src/lib/format";
import type { MenuItem, PricedOption } from "../../src/lib/types";
import { useOffline } from "../../src/offline/OfflineContext";
import { lineKey } from "../../src/pos/CartContext";
import { MenuGrid } from "../../src/pos/MenuGrid";
import { useCatalog } from "../../src/pos/useCatalog";
import { isItemOut, isLineOut, isStockError, ranOut } from "../../src/pos/stock";
import { font, radius, space, TAP, useTheme } from "../../src/theme";
import { withAccess } from "../../src/auth/RequireAccess";

interface RoundLine {
  key: string;
  item: MenuItem;
  variant: PricedOption | null;
  addons: PricedOption[];
  quantity: number;
  seat: number | null;
  notes: string;
  unitPrice: number;
}

/**
 * Waiter's "add to tab" mode: the POS menu grid, but items go into a round
 * for this table (optionally tagged with a seat) and "Send to kitchen" fires
 * the KOTs. The global POS cart is untouched.
 */
function AddToTab() {
  const { sessionId, label, guests } = useLocalSearchParams<{ sessionId: string; label?: string; guests?: string }>();
  const t = useTheme();
  const { outlet } = useSignedIn();
  const { online } = useOffline();
  const { menu, outlet: settings, loading, error, reload } = useCatalog(outlet?.id ?? null);
  const seatCount = Math.max(1, Math.min(Number(guests) || 4, 20));
  const [seat, setSeat] = useState<number | null>(null);
  const [lines, setLines] = useState<RoundLine[]>([]);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const qtyByItem = useMemo(() => {
    const m = new Map<string, number>();
    lines.forEach((l) => m.set(l.item.id, (m.get(l.item.id) ?? 0) + l.quantity));
    return m;
  }, [lines]);
  // Round lines against the latest menu, so items that ran out since they were added are flagged.
  const byId = useMemo(() => new Map((menu?.items ?? []).map((i) => [i.id, i])), [menu]);
  const view = useMemo(() => lines.map((l) => ({ ...l, item: byId.get(l.item.id) ?? l.item })), [lines, byId]);
  const outCount = view.filter(isLineOut).length;
  const count = lines.reduce((s, l) => s + l.quantity, 0);
  const total = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);

  const add = (item: MenuItem, variant: PricedOption | null, addons: PricedOption[], qty: number) => {
    const key = `${lineKey(item.id, variant?.id ?? null, addons.map((a) => a.id))}|s${seat ?? "-"}`;
    setLines((cur) => {
      const existing = cur.find((l) => l.key === key);
      if (existing) return cur.map((l) => (l.key === key ? { ...l, quantity: Math.min(999, l.quantity + qty) } : l));
      const unitPrice = (variant?.price ?? item.price) + addons.reduce((s, a) => s + a.price, 0);
      return [...cur, { key, item, variant, addons, quantity: qty, seat, notes: "", unitPrice }];
    });
  };

  const changeQty = (key: string, delta: number) =>
    setLines((cur) => cur.map((l) => (l.key === key ? { ...l, quantity: l.quantity + delta } : l)).filter((l) => l.quantity > 0));
  const setNotes = (key: string, notes: string) => setLines((cur) => cur.map((l) => (l.key === key ? { ...l, notes } : l)));

  const send = async () => {
    if (!sessionId || !lines.length) return;
    setSending(true);
    setSendError(null);
    try {
      const items: SessionItemInput[] = lines.map((l) => ({
        menuItemId: l.item.id,
        variantId: l.variant?.id,
        addonIds: l.addons.map((a) => a.id),
        quantity: l.quantity,
        notes: l.notes.trim() || undefined,
        seat: l.seat ?? undefined,
      }));
      await endpoints.addSessionItems(sessionId, items);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setReviewOpen(false);
      router.back();
    } catch (e) {
      setSendError(errorMessage(e));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      // Ran out since the menu loaded: refetch so the grid and the round show it.
      if (isStockError(e)) void reload();
    } finally {
      setSending(false);
    }
  };

  const title = `Add to ${label ? `table ${label}` : "tab"}`;
  if (loading && !menu) return <Screen edges={[]} scroll={false}><Stack.Screen options={{ title }} /><Loading label="Loading menu…" /></Screen>;
  if (!menu) return <Screen edges={[]} scroll={false}><Stack.Screen options={{ title }} /><ErrorState message={error ?? "Menu unavailable"} onRetry={reload} /></Screen>;

  return (
    <Screen edges={["bottom"]} scroll={false}>
      <Stack.Screen options={{ title }} />
      <MenuGrid
        menu={menu}
        qtyByItem={qtyByItem}
        onAdd={add}
        showImages={settings?.posShowImages !== false}
        header={
          <View style={{ gap: space.sm }}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm, paddingRight: space.lg }}>
              <Chip label="Shared" selected={seat == null} onPress={() => setSeat(null)} />
              {Array.from({ length: seatCount }, (_, i) => i + 1).map((n) => (
                <Chip key={n} label={`Seat ${n}`} selected={seat === n} onPress={() => setSeat(n)} />
              ))}
              <Chip label="+ seat" onPress={() => setSeat((s) => (s ?? seatCount) + 1)} />
            </ScrollView>
            {!online ? <Notice kind="warning" message="Offline — items can be sent once you're back online." /> : null}
          </View>
        }
      />
      {count > 0 ? (
        <Pressable
          onPress={() => setReviewOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={`Review round, ${count} items`}
          style={({ pressed }) => [styles.bar, { backgroundColor: t.success, opacity: pressed ? 0.9 : 1 }]}
        >
          <View style={styles.count}>
            <AppText style={{ color: t.success, fontWeight: "900" }}>{count}</AppText>
          </View>
          <AppText style={{ color: "#fff", fontSize: font.xl, fontWeight: "900", flex: 1 }}>{inr(total)}</AppText>
          <AppText style={{ color: "#fff", fontWeight: "800", fontSize: font.lg }}>Review & send</AppText>
          <Ionicons name="chevron-up" size={22} color="#fff" />
        </Pressable>
      ) : null}

      <Sheet visible={reviewOpen} onClose={() => setReviewOpen(false)} title="New round" maxHeight="92%">
        <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.sm, paddingBottom: space.lg }} keyboardShouldPersistTaps="handled">
          {view.map((l) => {
            const out = isLineOut(l);
            const reason = out ? ranOut(l.item) : null;
            return (
              <View key={l.key} style={[styles.line, { backgroundColor: out ? t.dangerBg : t.surface, borderColor: out ? t.danger : t.border }]}>
                <Row>
                  <VegMark type={l.item.foodType} size={14} />
                  <View style={{ flex: 1 }}>
                    <AppText style={{ fontWeight: "700" }} numberOfLines={2}>
                      {l.item.name}
                      {l.variant ? ` (${l.variant.name})` : ""}
                    </AppText>
                    <AppText variant="small">
                      {l.seat ? `Seat ${l.seat}` : "Shared"}
                      {l.addons.length ? ` · + ${l.addons.map((a) => a.name).join(", ")}` : ""}
                    </AppText>
                    {out ? (
                      <AppText variant="small" color={t.danger} style={{ fontWeight: "700" }} numberOfLines={2}>
                        {isItemOut(l.item) ? "Out of stock" : `${l.variant?.name ?? "This size"} is out of stock`}
                        {reason ? ` · ${reason}` : ""}
                      </AppText>
                    ) : null}
                  </View>
                  <Pressable onPress={() => changeQty(l.key, -1)} style={[styles.qty, { borderColor: t.border }]} accessibilityLabel={`One less ${l.item.name}`}>
                    <Ionicons name={l.quantity === 1 ? "trash-outline" : "remove"} size={22} color={l.quantity === 1 ? t.danger : t.text} />
                  </Pressable>
                  <AppText variant="h3" style={{ minWidth: 28, textAlign: "center" }}>
                    {l.quantity}
                  </AppText>
                  <Pressable onPress={() => changeQty(l.key, 1)} style={[styles.qty, { borderColor: t.primary, backgroundColor: t.primary }]} accessibilityLabel={`One more ${l.item.name}`}>
                    <Ionicons name="add" size={22} color={t.primaryText} />
                  </Pressable>
                </Row>
                <Input placeholder="Note for kitchen (e.g. less spicy)" value={l.notes} onChangeText={(v) => setNotes(l.key, v)} maxLength={200} style={{ minHeight: 44, fontSize: font.md }} />
              </View>
            );
          })}
          {sendError ? <Notice kind="error" message={sendError} /> : null}
          {outCount ? (
            <Notice kind="warning" message={`${outCount === 1 ? "1 item is" : `${outCount} items are`} out of stock. Remove ${outCount === 1 ? "it" : "them"} to send this round.`} />
          ) : null}
          <Button title={`Send to kitchen · ${count} item${count === 1 ? "" : "s"}`} icon="flame-outline" size="xl" variant="success" loading={sending} disabled={!online} onPress={send} />
        </ScrollView>
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: "absolute",
    left: space.md,
    right: space.md,
    bottom: space.md,
    minHeight: 64,
    borderRadius: radius.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    elevation: 8,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  count: { width: 34, height: 34, borderRadius: 17, backgroundColor: "#fff", alignItems: "center", justifyContent: "center" },
  line: { borderWidth: 1, borderRadius: radius.md, padding: space.md, gap: space.sm },
  qty: { width: TAP - 8, height: TAP - 8, borderRadius: radius.md, borderWidth: 1, alignItems: "center", justifyContent: "center" },
});

export default withAccess(["table:serve"], AddToTab);
