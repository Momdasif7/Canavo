import React from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import * as Haptics from "expo-haptics";
import type { ManualStatus } from "../lib/types";
import { radius, space, useTheme, type Palette } from "../theme";
import { STATUS_LABEL, STATUS_ORDER, STATUS_SHORT } from "./register";

export function statusColors(t: Palette): Record<ManualStatus, { bg: string; soft: string }> {
  return {
    PRESENT: { bg: t.success, soft: t.successBg },
    HALF_DAY: { bg: "#7FB89A", soft: t.successBg },
    ABSENT: { bg: t.danger, soft: t.dangerBg },
    LEAVE: { bg: t.info, soft: t.surfaceAlt },
  };
}

/** Big P / HD / A / L buttons. */
export function StatusButtons({
  value,
  onChange,
  disabled,
  name,
}: {
  value: ManualStatus | null;
  onChange: (s: ManualStatus) => void;
  disabled?: boolean;
  /** Employee name for screen readers */
  name?: string;
}) {
  const t = useTheme();
  const colors = statusColors(t);
  return (
    <View style={styles.row} accessibilityRole="radiogroup">
      {STATUS_ORDER.map((s) => {
        const active = value === s;
        return (
          <Pressable
            key={s}
            disabled={disabled}
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              onChange(s);
            }}
            accessibilityRole="radio"
            accessibilityState={{ checked: active, disabled: !!disabled }}
            accessibilityLabel={name ? `${STATUS_LABEL[s]} for ${name}` : STATUS_LABEL[s]}
            style={({ pressed }) => [
              styles.btn,
              {
                backgroundColor: active ? colors[s].bg : t.surface,
                borderColor: active ? colors[s].bg : t.border,
                opacity: disabled && !active ? 0.45 : pressed ? 0.8 : 1,
              },
            ]}
          >
            <Text style={[styles.short, { color: active ? "#fff" : t.text }]}>{STATUS_SHORT[s]}</Text>
            <Text style={[styles.label, { color: active ? "#fff" : t.textMuted }]} numberOfLines={1}>
              {STATUS_LABEL[s]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", gap: space.sm },
  btn: { flex: 1, minHeight: 60, borderRadius: radius.md, borderWidth: 1.5, alignItems: "center", justifyContent: "center", paddingVertical: 6 },
  short: { fontSize: 22, fontWeight: "900" },
  label: { fontSize: 11, fontWeight: "700" },
});
