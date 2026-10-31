import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { AppText } from "../components/ui";
import { inrShort } from "../lib/format";
import { space, useTheme } from "../theme";

const CHART_H = 120;

/**
 * Deliveries per day: one series, one hue, recessive baseline. Tap a bar to
 * read it; only the selected bar (default: last) is labelled.
 */
export function DayBars({ days }: { days: { date: string; deliveries: number; collected: number }[] }) {
  const t = useTheme();
  const [selected, setSelected] = useState(days.length - 1);
  useEffect(() => setSelected(days.length - 1), [days.length]);
  const max = Math.max(1, ...days.map((d) => d.deliveries));
  const sel = days[selected];
  const many = days.length > 10;
  const label = (date: string) => {
    const d = new Date(`${date}T00:00:00`);
    return many ? String(d.getDate()) : d.toLocaleDateString("en-IN", { weekday: "narrow" });
  };

  return (
    <View style={{ gap: space.sm }}>
      <AppText variant="small" accessibilityLiveRegion="polite">
        {sel
          ? `${new Date(`${sel.date}T00:00:00`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short" })}: ${sel.deliveries} deliver${sel.deliveries === 1 ? "y" : "ies"} · ${inrShort(sel.collected)} collected`
          : ""}
      </AppText>
      <View style={[styles.plot, { borderBottomColor: t.border, gap: many ? 2 : 6 }]}>
        {days.map((d, i) => {
          const h = d.deliveries > 0 ? Math.max(4, Math.round((d.deliveries / max) * CHART_H)) : 0;
          const active = i === selected;
          return (
            <Pressable
              key={d.date}
              onPress={() => setSelected(i)}
              style={styles.slot}
              hitSlop={{ top: 8, bottom: 8 }}
              accessibilityRole="button"
              accessibilityLabel={`${d.date}: ${d.deliveries} deliveries`}
            >
              {active ? (
                <AppText variant="small" style={{ fontWeight: "800" }} numberOfLines={1}>
                  {d.deliveries}
                </AppText>
              ) : null}
              <View style={{ width: many ? "80%" : "60%", height: h, backgroundColor: t.primary, opacity: active ? 1 : 0.55, borderTopLeftRadius: 4, borderTopRightRadius: 4 }} />
            </Pressable>
          );
        })}
      </View>
      <View style={{ flexDirection: "row", gap: many ? 2 : 6 }}>
        {days.map((d, i) => (
          <AppText key={d.date} variant="small" style={{ flex: 1, textAlign: "center", fontSize: many ? 9 : 13, fontWeight: i === selected ? "800" : "400" }}>
            {!many || i % 5 === 0 || i === days.length - 1 ? label(d.date) : ""}
          </AppText>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  plot: { height: CHART_H + 22, flexDirection: "row", alignItems: "flex-end", borderBottomWidth: 1 },
  slot: { flex: 1, height: "100%", alignItems: "center", justifyContent: "flex-end", gap: 4 },
});
