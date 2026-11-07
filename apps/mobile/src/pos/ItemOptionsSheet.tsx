import React, { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { Sheet } from "../components/Sheet";
import { AppText, Button, Row, VegMark } from "../components/ui";
import { inr } from "../lib/format";
import type { MenuItem, PricedOption } from "../lib/types";
import { radius, space, TAP, useTheme } from "../theme";
import { isVariantOut, ranOut } from "./stock";

/** Pick a size (variant) and add-ons before adding an item to the cart. */
export function ItemOptionsSheet({
  item,
  onClose,
  onAdd,
}: {
  item: MenuItem | null;
  onClose: () => void;
  onAdd: (item: MenuItem, variant: PricedOption | null, addons: PricedOption[], qty: number) => void;
}) {
  const t = useTheme();
  const [variant, setVariant] = useState<PricedOption | null>(null);
  const [addons, setAddons] = useState<PricedOption[]>([]);
  const [qty, setQty] = useState(1);

  useEffect(() => {
    // First size that's in stock (sizes in unavailableVariantIds can't be billed).
    setVariant(item ? item.variants.find((v) => !isVariantOut(item, v.id)) ?? null : null);
    setAddons([]);
    setQty(1);
    // Reset only when a different item opens; a menu refresh passes a new object for the same item.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id]);

  // The chosen size ran out while the sheet was open (menu refreshed): move to one still in stock.
  useEffect(() => {
    if (item && variant && isVariantOut(item, variant.id)) setVariant(item.variants.find((v) => !isVariantOut(item, v.id)) ?? null);
  }, [item, variant]);

  if (!item) return null;
  const reason = ranOut(item);
  // Every size out → nothing to add (the grid normally blocks the item already).
  const noSize = item.variants.length > 0 && !variant;
  const unit = (variant?.price ?? item.price) + addons.reduce((s, a) => s + a.price, 0);
  const toggleAddon = (a: PricedOption) =>
    setAddons((cur) => (cur.some((x) => x.id === a.id) ? cur.filter((x) => x.id !== a.id) : [...cur, a]));

  return (
    <Sheet visible={!!item} onClose={onClose}>
      <ScrollView contentContainerStyle={{ paddingHorizontal: space.lg, gap: space.md }}>
        <Row>
          <VegMark type={item.foodType} size={18} />
          <AppText variant="h2" style={{ flex: 1 }}>
            {item.name}
          </AppText>
        </Row>
        {item.description ? <AppText variant="muted">{item.description}</AppText> : null}

        {item.variants.length ? (
          <View style={{ gap: space.sm }}>
            <AppText variant="h3">Size</AppText>
            {item.variants.map((v) => {
              const on = variant?.id === v.id;
              const out = isVariantOut(item, v.id);
              return (
                <Pressable
                  key={v.id}
                  onPress={() => setVariant(v)}
                  disabled={out}
                  accessibilityRole="radio"
                  accessibilityState={{ checked: on, disabled: out }}
                  accessibilityLabel={out ? `${v.name}, out of stock${reason ? `, ${reason}` : ""}` : undefined}
                  style={[styles.option, { borderColor: on ? t.primary : t.border, backgroundColor: t.surface, opacity: out ? 0.55 : 1 }]}
                >
                  <Ionicons name={out ? "close-circle-outline" : on ? "radio-button-on" : "radio-button-off"} size={22} color={out ? t.danger : on ? t.primary : t.textMuted} />
                  <View style={{ flex: 1 }}>
                    <AppText style={{ fontWeight: "600" }}>{v.name}</AppText>
                    {out ? (
                      <AppText variant="small" color={t.danger} numberOfLines={2}>
                        Out of stock{reason ? ` · ${reason}` : ""}
                      </AppText>
                    ) : null}
                  </View>
                  <AppText variant="price">{inr(v.price)}</AppText>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        {item.addons.length ? (
          <View style={{ gap: space.sm }}>
            <AppText variant="h3">Add-ons</AppText>
            {item.addons.map((a) => {
              const on = addons.some((x) => x.id === a.id);
              return (
                <Pressable
                  key={a.id}
                  onPress={() => toggleAddon(a)}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: on }}
                  style={[styles.option, { borderColor: on ? t.primary : t.border, backgroundColor: t.surface }]}
                >
                  <Ionicons name={on ? "checkbox" : "square-outline"} size={22} color={on ? t.primary : t.textMuted} />
                  <AppText style={{ flex: 1, fontWeight: "600" }}>{a.name}</AppText>
                  <AppText variant="price">+{inr(a.price)}</AppText>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        <Row style={{ justifyContent: "space-between", marginTop: space.sm }}>
          <Row>
            <Pressable onPress={() => setQty((q) => Math.max(1, q - 1))} style={[styles.qtyBtn, { borderColor: t.border }]} accessibilityLabel="Decrease quantity">
              <Ionicons name="remove" size={24} color={t.text} />
            </Pressable>
            <AppText variant="h2" style={{ minWidth: 36, textAlign: "center" }}>
              {qty}
            </AppText>
            <Pressable onPress={() => setQty((q) => Math.min(99, q + 1))} style={[styles.qtyBtn, { borderColor: t.border }]} accessibilityLabel="Increase quantity">
              <Ionicons name="add" size={24} color={t.text} />
            </Pressable>
          </Row>
          <Button
            title={noSize ? "Out of stock" : `Add · ${inr(unit * qty)}`}
            disabled={noSize}
            onPress={() => onAdd(item, variant, addons, qty)}
            style={{ flex: 1, marginLeft: space.md }}
          />
        </Row>
      </ScrollView>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  option: {
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    minHeight: TAP,
    paddingHorizontal: space.md,
    borderRadius: radius.md,
    borderWidth: 1.5,
  },
  qtyBtn: { width: TAP, height: TAP, borderRadius: radius.md, borderWidth: 1, alignItems: "center", justifyContent: "center" },
});
