import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { font, radius, space, useTheme } from "../theme";
import { Sheet } from "./Sheet";
import { AppText, Button } from "./ui";

const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "clear", "0", "back"] as const;

/** Large numeric keypad for the 4–6 digit staff PIN. */
export function PinPad({
  visible,
  title = "Enter your PIN",
  error,
  busy,
  onSubmit,
  onClose,
}: {
  visible: boolean;
  title?: string;
  error?: string | null;
  busy?: boolean;
  onSubmit: (pin: string) => void;
  onClose: () => void;
}) {
  const t = useTheme();
  const [pin, setPin] = useState("");

  useEffect(() => {
    if (visible) setPin("");
  }, [visible]);
  useEffect(() => {
    if (error) setPin("");
  }, [error]);

  const press = (k: (typeof KEYS)[number]) => {
    void Haptics.selectionAsync();
    if (k === "back") setPin((p) => p.slice(0, -1));
    else if (k === "clear") setPin("");
    else setPin((p) => (p.length < 6 ? p + k : p));
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={title}>
      <View style={{ paddingHorizontal: space.lg, gap: space.md }}>
        <View style={styles.dots} accessibilityLabel={`${pin.length} digits entered`}>
          {Array.from({ length: Math.max(4, pin.length) }).map((_, i) => (
            <View
              key={i}
              style={[styles.dot, { borderColor: t.text, backgroundColor: i < pin.length ? t.text : "transparent" }]}
            />
          ))}
        </View>
        {error ? (
          <AppText color={t.danger} style={{ textAlign: "center", fontWeight: "700" }}>
            {error}
          </AppText>
        ) : null}
        <View style={styles.grid}>
          {KEYS.map((k) => (
            <Pressable
              key={k}
              onPress={() => press(k)}
              accessibilityLabel={k === "back" ? "Delete" : k === "clear" ? "Clear" : k}
              style={({ pressed }) => [
                styles.key,
                { backgroundColor: pressed ? t.surfaceAlt : t.surface, borderColor: t.border },
              ]}
            >
              {k === "back" ? (
                <Ionicons name="backspace-outline" size={28} color={t.text} />
              ) : k === "clear" ? (
                <Text style={{ color: t.textMuted, fontSize: font.md, fontWeight: "700" }}>CLEAR</Text>
              ) : (
                <Text style={{ color: t.text, fontSize: 28, fontWeight: "700" }}>{k}</Text>
              )}
            </Pressable>
          ))}
        </View>
        <Button title="Confirm" loading={busy} disabled={pin.length < 4} onPress={() => onSubmit(pin)} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  dots: { flexDirection: "row", justifyContent: "center", gap: space.md, paddingVertical: space.sm },
  dot: { width: 18, height: 18, borderRadius: 9, borderWidth: 2 },
  grid: { flexDirection: "row", flexWrap: "wrap", justifyContent: "space-between", rowGap: space.sm },
  key: {
    width: "31.5%",
    height: 64,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
