import React, { useState } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import DateTimePicker, { DateTimePickerAndroid, type DateTimePickerEvent } from "@react-native-community/datetimepicker";
import * as Haptics from "expo-haptics";
import { Ionicons } from "@expo/vector-icons";
import { Sheet } from "../components/Sheet";
import { AppText, Button } from "../components/ui";
import { font, radius, space, TAP, useTheme } from "../theme";
import { displayTime } from "./register";

const pad = (n: number) => String(n).padStart(2, "0");

function toDate(hhmm: string | null, fallback: string) {
  const [h, m] = (hhmm ?? fallback).split(":").map(Number);
  const d = new Date();
  d.setHours(h, m, 0, 0);
  return d;
}

const toHhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

/**
 * Time-of-day picker (HH:MM, outlet time). Android: the native clock dialog;
 * iOS: a spinner in a bottom sheet. Optional fields can be cleared.
 */
export function TimeField({
  label,
  value,
  onChange,
  fallback,
  placeholder = "Set time",
  clearable,
  hint,
  disabled,
}: {
  label: string;
  value: string | null;
  onChange: (hhmm: string | null) => void;
  /** Time the picker opens at when empty (e.g. the shift start) */
  fallback: string;
  placeholder?: string;
  clearable?: boolean;
  hint?: string;
  disabled?: boolean;
}) {
  const t = useTheme();
  const [iosOpen, setIosOpen] = useState(false);
  const [draft, setDraft] = useState<Date>(toDate(value, fallback));

  const set = (hhmm: string | null) => {
    void Haptics.selectionAsync();
    onChange(hhmm);
  };

  const open = () => {
    if (Platform.OS === "android") {
      DateTimePickerAndroid.open({
        value: toDate(value, fallback),
        mode: "time",
        is24Hour: false,
        onChange: (e: DateTimePickerEvent, d?: Date) => {
          if (e.type === "set" && d) set(toHhmm(d));
        },
      });
    } else {
      setDraft(toDate(value, fallback));
      setIosOpen(true);
    }
  };

  return (
    <View style={{ flex: 1, gap: 4 }}>
      <AppText variant="small">{label}</AppText>
      <View style={styles.row}>
        <Pressable
          onPress={open}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={`${label}: ${value ? displayTime(value) : "not set"}. Change`}
          style={({ pressed }) => [
            styles.field,
            { backgroundColor: t.surface, borderColor: value ? t.primary : t.border, opacity: disabled ? 0.5 : pressed ? 0.85 : 1 },
          ]}
        >
          <Ionicons name="time-outline" size={20} color={value ? t.primary : t.textMuted} />
          <AppText style={{ flex: 1, fontSize: font.lg, fontWeight: value ? "700" : "400" }} color={value ? t.text : t.textMuted}>
            {value ? displayTime(value) : placeholder}
          </AppText>
        </Pressable>
        {clearable && value && !disabled ? (
          <Pressable
            onPress={() => set(null)}
            accessibilityRole="button"
            accessibilityLabel={`Clear ${label}`}
            hitSlop={8}
            style={[styles.clear, { borderColor: t.border }]}
          >
            <Ionicons name="close" size={20} color={t.textMuted} />
          </Pressable>
        ) : null}
      </View>
      {hint ? <AppText variant="small">{hint}</AppText> : null}
      {Platform.OS === "ios" ? (
        <Sheet visible={iosOpen} onClose={() => setIosOpen(false)} title={label}>
          <View style={{ paddingHorizontal: space.lg, gap: space.md }}>
            <DateTimePicker value={draft} mode="time" display="spinner" onChange={(_e, d) => d && setDraft(d)} />
            <Button
              title="Done"
              onPress={() => {
                set(toHhmm(draft));
                setIosOpen(false);
              }}
            />
          </View>
        </Sheet>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: space.xs },
  field: {
    flex: 1,
    minHeight: TAP,
    borderWidth: 1.5,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
  clear: { width: TAP - 8, height: TAP - 8, borderRadius: radius.md, borderWidth: 1, alignItems: "center", justifyContent: "center" },
});
