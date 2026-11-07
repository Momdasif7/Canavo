import React, { useEffect, useState } from "react";
import { Image, StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { useSignedIn } from "../auth/AuthContext";
import { mediaUrl } from "../lib/media";
import { useCurrentOutlet } from "../pos/useOutlet";
import { brand, useTheme } from "../theme";
import { AppText, Row } from "./ui";

/** "Sri Krishna Bhavan" → "SK"; one word → its first two letters. */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/**
 * The hotel's own branding for business users: name from /auth/me
 * (`me.business.name`) and the current outlet's uploaded logo
 * (GET /outlets/current → `logoUrl`). null for the platform admin, who keeps
 * the CANAVO identity.
 */
export function useBusinessBrand(): { name: string; logoUrl: string | null } | null {
  const { me, outlet } = useSignedIn();
  const current = useCurrentOutlet();
  if (me.platformAdmin) return null;
  const name = me.business?.name ?? outlet?.businessName ?? outlet?.name ?? null;
  if (!name) return null;
  return { name, logoUrl: mediaUrl(current?.logoUrl) };
}

/** Square-ish logo tile with an initials fallback (no logo, or it fails to load). */
export function BusinessLogo({ name, logoUrl, size = 44, style }: { name: string; logoUrl: string | null; size?: number; style?: StyleProp<ViewStyle> }) {
  const t = useTheme();
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [logoUrl]);
  const radius = Math.round(size * 0.22);
  const showImage = !!logoUrl && !broken;
  return (
    <View
      style={[
        styles.tile,
        { width: size, height: size, borderRadius: radius, backgroundColor: showImage ? t.surface : brand.saffron, borderColor: t.border },
        style,
      ]}
      accessibilityRole="image"
      accessibilityLabel={`${name} logo`}
    >
      {showImage ? (
        <Image source={{ uri: logoUrl! }} style={StyleSheet.absoluteFill} resizeMode="contain" onError={() => setBroken(true)} accessibilityIgnoresInvertColors />
      ) : (
        <AppText style={{ color: "#fff", fontWeight: "900", fontSize: Math.round(size * 0.4) }} numberOfLines={1}>
          {initialsOf(name)}
        </AppText>
      )}
    </View>
  );
}

/** Logo + business name in one row (home greeting). Renders nothing for the platform admin. */
export function BusinessBrandRow({ size = 28 }: { size?: number }) {
  const b = useBusinessBrand();
  if (!b) return null;
  return (
    <Row style={{ gap: 8 }}>
      <BusinessLogo name={b.name} logoUrl={b.logoUrl} size={size} />
      <AppText variant="muted" style={{ fontWeight: "700", flex: 1 }} numberOfLines={1}>
        {b.name}
      </AppText>
    </Row>
  );
}

const styles = StyleSheet.create({
  tile: { alignItems: "center", justifyContent: "center", overflow: "hidden", borderWidth: StyleSheet.hairlineWidth },
});
