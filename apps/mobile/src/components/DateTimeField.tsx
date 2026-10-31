import React, { useState } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import DateTimePicker, { DateTimePickerAndroid, type DateTimePickerEvent } from "@react-native-community/datetimepicker";
import { Ionicons } from "@expo/vector-icons";
import { Sheet } from "./Sheet";
import { AppText, Button, Chip, Row } from "./ui";
import { font, radius, space, TAP, useTheme } from "../theme";

function atTomorrow(hour: number) {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d;
}

/** Rounded up to the next 5 minutes, `minutes` from now. */
function inMinutes(minutes: number) {
  const d = new Date(Date.now() + minutes * 60_000);
  d.setSeconds(0, 0);
  d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5);
  return d;
}

export function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/**
 * Date + time picker for pre-orders: quick chips for the common cases, and
 * the native picker (Android dialogs: date then time; iOS inline in a sheet).
 */
export function DateTimeField({
  value,
  onChange,
  label,
  minimumDate = new Date(),
  maximumDate,
}: {
  value: string | null;
  onChange: (iso: string) => void;
  label?: string;
  minimumDate?: Date;
  maximumDate?: Date;
}) {
  const t = useTheme();
  const [iosOpen, setIosOpen] = useState(false);
  const [iosDraft, setIosDraft] = useState<Date>(value ? new Date(value) : inMinutes(60));
  const current = value ? new Date(value) : inMinutes(60);

  const openNative = () => {
    if (Platform.OS === "android") {
      DateTimePickerAndroid.open({
        value: current,
        mode: "date",
        minimumDate,
        maximumDate,
        onChange: (e: DateTimePickerEvent, date?: Date) => {
          if (e.type !== "set" || !date) return;
          DateTimePickerAndroid.open({
            value: date,
            mode: "time",
            is24Hour: false,
            onChange: (e2: DateTimePickerEvent, time?: Date) => {
              if (e2.type !== "set" || !time) return;
              const merged = new Date(date);
              merged.setHours(time.getHours(), time.getMinutes(), 0, 0);
              onChange(merged.toISOString());
            },
          });
        },
      });
    } else {
      setIosDraft(current);
      setIosOpen(true);
    }
  };

  const quick: { label: string; at: () => Date }[] = [
    { label: "In 30 min", at: () => inMinutes(30) },
    { label: "In 1 hr", at: () => inMinutes(60) },
    { label: "In 2 hrs", at: () => inMinutes(120) },
    { label: "Tomorrow 9 AM", at: () => atTomorrow(9) },
    { label: "Tomorrow 1 PM", at: () => atTomorrow(13) },
  ];

  return (
    <View style={{ gap: space.sm }}>
      {label ? <AppText variant="small">{label}</AppText> : null}
      <Pressable
        onPress={openNative}
        accessibilityRole="button"
        accessibilityLabel={value ? `Scheduled for ${formatDateTime(value)}. Change` : "Pick date and time"}
        style={({ pressed }) => [
          styles.field,
          { backgroundColor: t.surface, borderColor: value ? t.primary : t.border, opacity: pressed ? 0.85 : 1 },
        ]}
      >
        <Ionicons name="calendar-outline" size={22} color={t.primary} />
        <AppText style={{ flex: 1, fontSize: font.lg, fontWeight: value ? "700" : "400" }} color={value ? t.text : t.textMuted}>
          {value ? formatDateTime(value) : "Pick date & time"}
        </AppText>
        <Ionicons name="chevron-down" size={20} color={t.textMuted} />
      </Pressable>
      <Row style={{ flexWrap: "wrap" }}>
        {quick.map((q) => (
          <Chip key={q.label} label={q.label} onPress={() => onChange(q.at().toISOString())} />
        ))}
      </Row>
      {Platform.OS === "ios" ? (
        <Sheet visible={iosOpen} onClose={() => setIosOpen(false)} title="Pre-order time">
          <View style={{ paddingHorizontal: space.lg, gap: space.md }}>
            <DateTimePicker
              value={iosDraft}
              mode="datetime"
              display="inline"
              minimumDate={minimumDate}
              maximumDate={maximumDate}
              onChange={(_e, d) => d && setIosDraft(d)}
            />
            <Button
              title="Done"
              onPress={() => {
                onChange(iosDraft.toISOString());
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
  field: {
    minHeight: TAP,
    borderWidth: 1.5,
    borderRadius: radius.md,
    paddingHorizontal: space.md,
    flexDirection: "row",
    alignItems: "center",
    gap: space.sm,
  },
});
