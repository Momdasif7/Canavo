import React, { useRef } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { radius, space, useTheme } from "../theme";

/**
 * Six boxes backed by one hidden TextInput, so paste and SMS autofill
 * (oneTimeCode / sms-otp) fill all digits at once.
 */
export function OtpInput({
  value,
  onChange,
  length = 6,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  length?: number;
  autoFocus?: boolean;
}) {
  const t = useTheme();
  const ref = useRef<TextInput>(null);
  return (
    <Pressable onPress={() => ref.current?.focus()} accessibilityLabel="One-time code">
      <View style={styles.row}>
        {Array.from({ length }).map((_, i) => {
          const active = i === Math.min(value.length, length - 1);
          return (
            <View
              key={i}
              style={[
                styles.box,
                { borderColor: active ? t.primary : t.border, backgroundColor: t.surface },
                active && { borderWidth: 2 },
              ]}
            >
              <Text style={[styles.digit, { color: t.text }]}>{value[i] ?? ""}</Text>
            </View>
          );
        })}
      </View>
      <TextInput
        ref={ref}
        value={value}
        onChangeText={(v) => onChange(v.replace(/\D/g, "").slice(0, length))}
        keyboardType="number-pad"
        textContentType="oneTimeCode"
        autoComplete="sms-otp"
        maxLength={length}
        autoFocus={autoFocus}
        style={styles.hidden}
        caretHidden
      />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", justifyContent: "space-between", gap: space.sm },
  box: { flex: 1, height: 60, borderRadius: radius.md, borderWidth: 1, alignItems: "center", justifyContent: "center" },
  digit: { fontSize: 26, fontWeight: "800" },
  hidden: { position: "absolute", opacity: 0, width: 1, height: 1 },
});
