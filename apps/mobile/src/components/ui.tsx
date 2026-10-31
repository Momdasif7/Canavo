import React from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  type PressableProps,
  type StyleProp,
  type TextInputProps,
  type TextProps,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { brand, font, radius, space, TAP, useTheme } from "../theme";
import type { FoodType } from "../lib/types";
import { FEATURE_OFF_MESSAGE, isFeatureOff } from "../lib/api";

// ---------- Text ----------
type TextVariant = "title" | "h2" | "h3" | "body" | "muted" | "small" | "price" | "priceLg";

export function AppText({
  variant = "body",
  style,
  color,
  ...rest
}: TextProps & { variant?: TextVariant; color?: string }) {
  const t = useTheme();
  const base: Record<TextVariant, TextStyle> = {
    title: { fontSize: font.xxl, fontWeight: "800", color: t.text },
    h2: { fontSize: font.xl, fontWeight: "700", color: t.text },
    h3: { fontSize: font.lg, fontWeight: "700", color: t.text },
    body: { fontSize: font.md, color: t.text },
    muted: { fontSize: font.md, color: t.textMuted },
    small: { fontSize: font.sm, color: t.textMuted },
    price: { fontSize: font.lg, fontWeight: "800", color: t.text, fontVariant: ["tabular-nums"] },
    priceLg: { fontSize: font.huge, fontWeight: "900", color: t.text, fontVariant: ["tabular-nums"] },
  };
  return <Text {...rest} style={[base[variant], color ? { color } : null, style]} />;
}

// ---------- Button ----------
type ButtonVariant = "primary" | "success" | "secondary" | "ghost" | "danger";

interface ButtonProps extends Omit<PressableProps, "style" | "children"> {
  title: string;
  variant?: ButtonVariant;
  loading?: boolean;
  icon?: keyof typeof Ionicons.glyphMap;
  size?: "md" | "lg" | "xl";
  style?: StyleProp<ViewStyle>;
}

export function Button({ title, variant = "primary", loading, icon, size = "lg", disabled, style, ...rest }: ButtonProps) {
  const t = useTheme();
  const palette: Record<ButtonVariant, { bg: string; fg: string; border?: string }> = {
    primary: { bg: t.primary, fg: t.primaryText },
    success: { bg: t.success, fg: "#fff" },
    danger: { bg: t.danger, fg: "#fff" },
    secondary: { bg: t.surface, fg: t.text, border: t.border },
    ghost: { bg: "transparent", fg: t.primary },
  };
  const p = palette[variant];
  const height = size === "xl" ? 72 : size === "lg" ? 56 : TAP - 4;
  const isDisabled = disabled || loading;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: !!isDisabled, busy: !!loading }}
      disabled={isDisabled}
      style={({ pressed }) => [
        styles.button,
        {
          backgroundColor: p.bg,
          minHeight: height,
          borderColor: p.border ?? "transparent",
          borderWidth: p.border ? 1 : 0,
          opacity: isDisabled ? 0.5 : pressed ? 0.85 : 1,
        },
        style,
      ]}
      {...rest}
    >
      {loading ? (
        <ActivityIndicator color={p.fg} />
      ) : (
        <>
          {icon ? <Ionicons name={icon} size={size === "xl" ? 26 : 20} color={p.fg} /> : null}
          <Text style={{ color: p.fg, fontSize: size === "xl" ? font.xl : font.lg, fontWeight: "700" }}>{title}</Text>
        </>
      )}
    </Pressable>
  );
}

// ---------- Layout ----------
export function Card({ style, children }: { style?: StyleProp<ViewStyle>; children: React.ReactNode }) {
  const t = useTheme();
  return (
    <View style={[styles.card, { backgroundColor: t.surface, borderColor: t.border }, style]}>{children}</View>
  );
}

export function Row({ style, children }: { style?: StyleProp<ViewStyle>; children: React.ReactNode }) {
  return <View style={[{ flexDirection: "row", alignItems: "center", gap: space.sm }, style]}>{children}</View>;
}

// ---------- Inputs ----------
export const Input = React.forwardRef<TextInput, TextInputProps & { label?: string; error?: string | null }>(
  function Input({ label, error, style, ...rest }, ref) {
    const t = useTheme();
    return (
      <View style={{ gap: 6 }}>
        {label ? <AppText variant="small">{label}</AppText> : null}
        <TextInput
          ref={ref}
          placeholderTextColor={t.textMuted}
          style={[
            styles.input,
            { backgroundColor: t.surface, borderColor: error ? t.danger : t.border, color: t.text },
            style,
          ]}
          {...rest}
        />
        {error ? <AppText variant="small" color={t.danger}>{error}</AppText> : null}
      </View>
    );
  },
);

export function Chip({
  label,
  selected,
  onPress,
  style,
}: {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: !!selected }}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        {
          backgroundColor: selected ? t.primary : t.surface,
          borderColor: selected ? t.primary : t.border,
          opacity: pressed ? 0.8 : 1,
        },
        style,
      ]}
    >
      <Text style={{ color: selected ? t.primaryText : t.text, fontWeight: "700", fontSize: font.md }}>{label}</Text>
    </Pressable>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const t = useTheme();
  return (
    <View style={[styles.segmented, { backgroundColor: t.surfaceAlt }]}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            onPress={() => onChange(o.value)}
            style={[styles.segment, active && { backgroundColor: t.surface, borderColor: t.border, borderWidth: 1 }]}
          >
            <Text style={{ color: active ? t.primary : t.textMuted, fontWeight: "700", fontSize: font.md }}>{o.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ---------- Indicators ----------
/** Indian food-type mark: square outline with a dot (green veg, red non-veg, yellow egg). */
export function VegMark({ type, size = 16 }: { type: FoodType; size?: number }) {
  const color = type === "VEG" ? brand.veg : type === "EGG" ? brand.egg : brand.nonVeg;
  return (
    <View
      accessibilityLabel={type === "VEG" ? "Vegetarian" : type === "EGG" ? "Contains egg" : "Non-vegetarian"}
      style={{
        width: size,
        height: size,
        borderWidth: 1.5,
        borderColor: color,
        borderRadius: 2,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "#fff",
      }}
    >
      <View style={{ width: size * 0.5, height: size * 0.5, borderRadius: size, backgroundColor: color }} />
    </View>
  );
}

export function Notice({
  kind = "info",
  title,
  message,
  style,
}: {
  kind?: "info" | "error" | "success" | "warning";
  title?: string;
  message: string;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  const map = {
    info: { bg: t.surfaceAlt, fg: t.text, icon: "information-circle" as const },
    error: { bg: t.dangerBg, fg: t.danger, icon: "alert-circle" as const },
    success: { bg: t.successBg, fg: t.success, icon: "checkmark-circle" as const },
    warning: { bg: t.warningBg, fg: t.warning, icon: "warning" as const },
  }[kind];
  return (
    <View accessibilityRole="alert" style={[styles.notice, { backgroundColor: map.bg }, style]}>
      <Ionicons name={map.icon} size={22} color={map.fg} />
      <View style={{ flex: 1, gap: 2 }}>
        {title ? <Text style={{ color: map.fg, fontWeight: "800", fontSize: font.md }}>{title}</Text> : null}
        <Text style={{ color: map.fg, fontSize: font.md }}>{message}</Text>
      </View>
    </View>
  );
}

export function Loading({ label }: { label?: string }) {
  const t = useTheme();
  return (
    <View style={styles.center}>
      <ActivityIndicator size="large" color={t.primary} />
      {label ? <AppText variant="muted">{label}</AppText> : null}
    </View>
  );
}

/** Friendly state when a business hasn't enabled the module behind a screen. */
export function FeatureOff({ title = "Not enabled for your business", message }: { title?: string; message?: string }) {
  const t = useTheme();
  return (
    <View style={[styles.center, { padding: space.xl }]} accessibilityRole="summary">
      <View style={{ width: 84, height: 84, borderRadius: 42, alignItems: "center", justifyContent: "center", backgroundColor: t.surfaceAlt }}>
        <Ionicons name="lock-closed-outline" size={40} color={t.textMuted} />
      </View>
      <AppText variant="h3" style={{ textAlign: "center" }}>
        {title}
      </AppText>
      <AppText variant="muted" style={{ textAlign: "center" }}>
        {message ?? FEATURE_OFF_MESSAGE}
      </AppText>
    </View>
  );
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  if (isFeatureOff(message)) return <FeatureOff />;
  return (
    <View style={[styles.center, { padding: space.xl }]}>
      <Notice kind="error" message={message} style={{ alignSelf: "stretch" }} />
      {onRetry ? <Button title="Try again" icon="refresh" variant="secondary" onPress={onRetry} /> : null}
    </View>
  );
}

export function EmptyState({ icon, title, message }: { icon: keyof typeof Ionicons.glyphMap; title: string; message?: string }) {
  const t = useTheme();
  return (
    <View style={[styles.center, { padding: space.xl }]}>
      <Ionicons name={icon} size={48} color={t.textMuted} />
      <AppText variant="h3">{title}</AppText>
      {message ? <AppText variant="muted" style={{ textAlign: "center" }}>{message}</AppText> : null}
    </View>
  );
}

export function Kpi({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: string }) {
  const t = useTheme();
  return (
    <Card style={{ flex: 1, minWidth: 140, gap: 4 }}>
      <AppText variant="small">{label}</AppText>
      <AppText variant="price" style={{ fontSize: font.xl }} color={accent}>
        {value}
      </AppText>
      {hint ? <AppText variant="small" color={t.textMuted}>{hint}</AppText> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  button: {
    borderRadius: radius.md,
    paddingHorizontal: space.lg,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: space.sm,
  },
  card: { borderRadius: radius.lg, borderWidth: 1, padding: space.lg },
  input: {
    minHeight: TAP,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: space.md,
    fontSize: font.lg,
  },
  chip: {
    minHeight: 44,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  segmented: { flexDirection: "row", borderRadius: radius.md, padding: 4, gap: 4 },
  segment: { flex: 1, minHeight: 44, borderRadius: radius.sm, alignItems: "center", justifyContent: "center" },
  notice: { flexDirection: "row", gap: space.sm, padding: space.md, borderRadius: radius.md, alignItems: "flex-start" },
  center: { flex: 1, alignItems: "center", justifyContent: "center", gap: space.md },
});
