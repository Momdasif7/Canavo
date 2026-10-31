import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { AppText } from "./ui";
import { inrShort } from "../lib/format";
import { space, useTheme } from "../theme";

export interface TrendPoint {
  /** YYYY-MM-DD */
  date: string;
  value: number;
  orders: number;
}

const CHART_H = 140;

/**
 * Single-series daily bar chart (one hue, recessive baseline). Tap a bar to
 * read its value — the selected (default: last) bar is labelled; the others
 * stay unlabelled so the shape reads first.
 */
export function TrendBars({ points }: { points: TrendPoint[] }) {
  const t = useTheme();
  const [selected, setSelected] = useState(points.length - 1);
  useEffect(() => setSelected(points.length - 1), [points.length]);
  const max = Math.max(1, ...points.map((p) => p.value));
  const sel = points[selected];

  return (
    <View style={{ gap: space.sm }}>
      <AppText variant="small" accessibilityLiveRegion="polite">
        {sel
          ? `${new Date(`${sel.date}T00:00:00`).toLocaleDateString("en-IN", { weekday: "long", day: "numeric", month: "short" })}: ${inrShort(sel.value)} · ${sel.orders} bills`
          : ""}
      </AppText>
      <View style={[styles.plot, { borderBottomColor: t.border }]}>
        {points.map((p, i) => {
          const h = p.value > 0 ? Math.max(4, Math.round((p.value / max) * CHART_H)) : 0;
          const active = i === selected;
          return (
            <Pressable
              key={p.date}
              onPress={() => setSelected(i)}
              style={styles.slot}
              accessibilityRole="button"
              accessibilityLabel={`${p.date}: ${inrShort(p.value)}, ${p.orders} bills`}
            >
              {active ? (
                <AppText variant="small" style={{ fontWeight: "800" }} numberOfLines={1}>
                  {inrShort(p.value)}
                </AppText>
              ) : null}
              <View
                style={{
                  width: "62%",
                  height: h,
                  backgroundColor: t.primary,
                  opacity: active ? 1 : 0.55,
                  borderTopLeftRadius: 4,
                  borderTopRightRadius: 4,
                }}
              />
            </Pressable>
          );
        })}
      </View>
      <View style={{ flexDirection: "row" }}>
        {points.map((p, i) => (
          <AppText key={p.date} variant="small" style={{ flex: 1, textAlign: "center", fontWeight: i === selected ? "800" : "400" }}>
            {new Date(`${p.date}T00:00:00`).toLocaleDateString("en-IN", { weekday: "narrow" })}
          </AppText>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  plot: { height: CHART_H + 24, flexDirection: "row", alignItems: "flex-end", borderBottomWidth: 1, gap: 2 },
  slot: { flex: 1, height: "100%", alignItems: "center", justifyContent: "flex-end", gap: 4 },
});
