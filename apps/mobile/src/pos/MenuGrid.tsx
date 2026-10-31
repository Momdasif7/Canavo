import React, { useMemo, useState } from "react";
import { FlatList, Image, Pressable, ScrollView, StyleSheet, TextInput, useWindowDimensions, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { AppText, Chip, EmptyState, VegMark } from "../components/ui";
import { inr } from "../lib/format";
import { mediaUrl } from "../lib/media";
import type { Menu, MenuItem, PricedOption } from "../lib/types";
import { font, radius, space, useTheme } from "../theme";
import { ItemOptionsSheet } from "./ItemOptionsSheet";

/**
 * Searchable, category-filtered menu tiles. Used by the POS (Bill tab) and
 * by the waiter's "add to tab" screen. Items with sizes/add-ons open the
 * options sheet; others are added with one tap. With `showImages` (outlet
 * setting `posShowImages`) tiles carry the item photo in a fixed-ratio strip.
 */
export function MenuGrid({
  menu,
  qtyByItem,
  onAdd,
  header,
  bottomPadding = 120,
  showImages = true,
}: {
  menu: Menu;
  qtyByItem: Map<string, number>;
  onAdd: (item: MenuItem, variant: PricedOption | null, addons: PricedOption[], qty: number) => void;
  header?: React.ReactNode;
  bottomPadding?: number;
  /** Show menu photos on the tiles (outlet `posShowImages`, default on) */
  showImages?: boolean;
}) {
  const t = useTheme();
  const { width } = useWindowDimensions();
  const columns = width >= 700 ? 4 : width >= 380 ? 3 : 2;
  const [category, setCategory] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [optionsFor, setOptionsFor] = useState<MenuItem | null>(null);

  const [brokenImages, setBrokenImages] = useState<Set<string>>(() => new Set());

  const visibleItems = useMemo(() => menu.items.filter((i) => i.status !== "HIDDEN"), [menu]);
  // Photo strip only when some item has a photo; items without one get a placeholder so rows stay even.
  const photos = showImages && visibleItems.some((i) => !!i.imageUrl);
  const categories = useMemo(() => {
    const used = new Set(visibleItems.map((i) => i.categoryId));
    return menu.categories.filter((c) => used.has(c.id));
  }, [menu, visibleItems]);
  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return visibleItems.filter((i) => (q ? i.name.toLowerCase().includes(q) : !category || i.categoryId === category));
  }, [visibleItems, category, query]);

  const add = (item: MenuItem, variant: PricedOption | null = null, addons: PricedOption[] = [], qty = 1) => {
    onAdd(item, variant, addons, qty);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  };

  const onTapItem = (item: MenuItem) => {
    if (item.status !== "AVAILABLE") return;
    if (item.variants.length || item.addons.length) setOptionsFor(item);
    else add(item);
  };

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.header}>
        <View style={[styles.search, { backgroundColor: t.surface, borderColor: t.border }]}>
          <Ionicons name="search" size={20} color={t.textMuted} />
          <TextInput
            value={query}
            onChangeText={setQuery}
            placeholder="Search menu"
            placeholderTextColor={t.textMuted}
            style={{ flex: 1, color: t.text, fontSize: font.lg, minHeight: 48 }}
            returnKeyType="search"
          />
          {query ? (
            <Pressable onPress={() => setQuery("")} hitSlop={12} accessibilityLabel="Clear search">
              <Ionicons name="close-circle" size={22} color={t.textMuted} />
            </Pressable>
          ) : null}
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm, paddingRight: space.lg }}>
          <Chip label="All" selected={!category} onPress={() => setCategory(null)} />
          {categories.map((c) => (
            <Chip key={c.id} label={c.name} selected={category === c.id} onPress={() => setCategory(c.id)} />
          ))}
        </ScrollView>
        {header}
      </View>

      <FlatList
        key={columns}
        data={items}
        numColumns={columns}
        keyExtractor={(i) => i.id}
        contentContainerStyle={{ padding: space.md, paddingBottom: bottomPadding }}
        columnWrapperStyle={{ gap: space.sm }}
        keyboardShouldPersistTaps="handled"
        ItemSeparatorComponent={() => <View style={{ height: space.sm }} />}
        ListEmptyComponent={<EmptyState icon="fast-food-outline" title="No items" message={query ? "Try a different search." : "Nothing in this category."} />}
        renderItem={({ item }) => {
          const qty = qtyByItem.get(item.id) ?? 0;
          const out = item.status !== "AVAILABLE";
          const hasOptions = item.variants.length > 0 || item.addons.length > 0;
          const fromPrice = item.variants.length ? Math.min(...item.variants.map((v) => v.price)) : item.price;
          const slot = timeSlot(item.availableFrom, item.availableTo);
          const photo = photos && !brokenImages.has(item.id) ? mediaUrl(item.imageUrl) : null;
          const qtyBadge = qty ? (
            <View style={[styles.badge, { backgroundColor: t.primary }]}>
              <AppText style={{ color: "#fff", fontWeight: "800", fontSize: 13 }} numberOfLines={1}>
                {qty > 99 ? "99+" : qty}
              </AppText>
            </View>
          ) : null;
          return (
            <Pressable
              onPress={() => onTapItem(item)}
              disabled={out}
              accessibilityRole="button"
              accessibilityLabel={`${item.name}, ${item.variants.length > 1 ? "from " : ""}${inr(fromPrice)}${hasOptions ? ", has options" : ""}${slot ? `, served ${slot}` : ""}${out ? ", out of stock" : ""}`}
              style={({ pressed }) => [
                styles.tile,
                {
                  flex: 1 / columns,
                  // flex basis 0 + minWidth 0 keeps long names / prices from widening a column.
                  minWidth: 0,
                  backgroundColor: t.surface,
                  borderColor: qty ? t.primary : t.border,
                  borderWidth: qty ? 2 : 1,
                  opacity: out ? 0.55 : pressed ? 0.8 : 1,
                },
              ]}
            >
              {photos ? (
                <View style={[styles.photo, { backgroundColor: t.surfaceAlt }]}>
                  {photo ? (
                    <Image
                      source={{ uri: photo }}
                      style={StyleSheet.absoluteFill}
                      resizeMode="cover"
                      onError={() => setBrokenImages((cur) => new Set(cur).add(item.id))}
                      accessibilityIgnoresInvertColors
                    />
                  ) : (
                    <Ionicons name="fast-food-outline" size={26} color={t.textMuted} />
                  )}
                  <View style={styles.photoVeg}>
                    <VegMark type={item.foodType} size={14} />
                  </View>
                  {qtyBadge ? <View style={styles.photoBadge}>{qtyBadge}</View> : null}
                </View>
              ) : (
                <View style={styles.topRow}>
                  <VegMark type={item.foodType} />
                  <View style={{ flex: 1 }} />
                  {qtyBadge}
                </View>
              )}
              <AppText style={{ fontWeight: "700", fontSize: font.md }} numberOfLines={2}>
                {item.name}
              </AppText>
              {slot ? (
                <View style={styles.slot}>
                  <Ionicons name="time-outline" size={12} color={t.textMuted} />
                  <AppText variant="small" numberOfLines={1} style={{ flexShrink: 1, fontSize: 12 }}>
                    {slot}
                  </AppText>
                </View>
              ) : null}
              <View style={{ flex: 1 }} />
              <AppText
                variant="price"
                style={{ fontSize: font.md + 1 }}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.75}
              >
                {item.variants.length > 1 ? "from " : ""}
                {inr(fromPrice)}
              </AppText>
              {out || hasOptions ? (
                <View style={styles.tags}>
                  {out ? (
                    <View style={[styles.tag, { backgroundColor: t.dangerBg, borderColor: t.danger }]}>
                      <AppText style={[styles.tagText, { color: t.danger }]} numberOfLines={1}>
                        OUT OF STOCK
                      </AppText>
                    </View>
                  ) : (
                    <View style={[styles.tag, { backgroundColor: t.surfaceAlt, borderColor: t.border }]}>
                      <AppText style={[styles.tagText, { color: t.textMuted }]} numberOfLines={1}>
                        OPTIONS
                      </AppText>
                    </View>
                  )}
                </View>
              ) : null}
            </Pressable>
          );
        }}
      />

      <ItemOptionsSheet
        item={optionsFor}
        onClose={() => setOptionsFor(null)}
        onAdd={(item, v, a, q) => {
          add(item, v, a, q);
          setOptionsFor(null);
        }}
      />
    </View>
  );
}

/** "07:00"–"11:30" → "7–11:30 AM"; one side only → "from 7 AM" / "until 11:30 AM". */
export function timeSlot(from: string | null | undefined, to: string | null | undefined): string | null {
  const fmt = (v: string | null | undefined) => {
    const m = v ? /^(\d{1,2}):(\d{2})/.exec(v) : null;
    if (!m) return null;
    const h = Number(m[1]);
    const min = m[2];
    return { text: `${h % 12 || 12}${min === "00" ? "" : `:${min}`}`, ampm: h < 12 ? "AM" : "PM" };
  };
  const a = fmt(from);
  const b = fmt(to);
  if (a && b) return a.ampm === b.ampm ? `${a.text}–${b.text} ${b.ampm}` : `${a.text} ${a.ampm}–${b.text} ${b.ampm}`;
  if (a) return `from ${a.text} ${a.ampm}`;
  if (b) return `until ${b.text} ${b.ampm}`;
  return null;
}

const styles = StyleSheet.create({
  header: { paddingHorizontal: space.md, paddingTop: space.md, gap: space.sm },
  search: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
  },
  tile: { minHeight: 128, borderRadius: radius.md, padding: space.sm + 2, gap: 4, overflow: "hidden" },
  topRow: { flexDirection: "row", alignItems: "center", minHeight: 26 },
  // Bleeds to the tile edges (cancels the tile padding); fixed ratio keeps rows even.
  photo: {
    marginTop: -(space.sm + 2),
    marginHorizontal: -(space.sm + 2),
    marginBottom: 2,
    aspectRatio: 16 / 10,
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  photoVeg: { position: "absolute", left: 6, top: 6, backgroundColor: "#fff", borderRadius: 3, padding: 2 },
  photoBadge: { position: "absolute", right: 6, top: 6 },
  badge: { minWidth: 26, height: 26, borderRadius: 13, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 },
  slot: { flexDirection: "row", alignItems: "center", gap: 3, minWidth: 0 },
  tags: { flexDirection: "row", flexWrap: "wrap", gap: 4 },
  tag: { borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: 5, paddingVertical: 1, maxWidth: "100%" },
  tagText: { fontSize: 10, fontWeight: "900", letterSpacing: 0.3 },
});
