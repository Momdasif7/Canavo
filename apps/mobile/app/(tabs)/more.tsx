import React, { useState } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import Constants from "expo-constants";
import { ROLE_LABELS } from "@canavo/shared";
import { moreItems } from "../../src/auth/access";
import { useSignedIn } from "../../src/auth/AuthContext";
import { BusinessLogo, useBusinessBrand } from "../../src/components/BusinessBrand";
import { Screen } from "../../src/components/Screen";
import { AppText, Button, Card, Notice, Row } from "../../src/components/ui";
import { API_URL } from "../../src/lib/config";
import { formatDate } from "../../src/lib/format";
import { useNotifications } from "../../src/notifications/NotificationsContext";
import { useOffline } from "../../src/offline/OfflineContext";
import { useCart } from "../../src/pos/CartContext";
import type { OutletRef } from "../../src/lib/types";
import { brand, font, radius, space, TAP, useTheme } from "../../src/theme";

/** Outlets grouped by business, in the order /auth/me returns them (business name, then outlet). */
function groupByBusiness(outlets: OutletRef[]): { name: string; outlets: OutletRef[] }[] {
  const groups = new Map<string, { name: string; outlets: OutletRef[] }>();
  for (const o of outlets) {
    const key = o.businessId ?? "-";
    const g = groups.get(key) ?? { name: o.businessName ?? "Outlets", outlets: [] };
    g.outlets.push(o);
    groups.set(key, g);
  }
  return [...groups.values()];
}

function NavRow({
  icon,
  label,
  detail,
  badge,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  detail?: string;
  badge?: number;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.navRow, { borderColor: t.border, backgroundColor: pressed ? t.surfaceAlt : "transparent" }]}
    >
      <Ionicons name={icon} size={24} color={t.primary} />
      <View style={{ flex: 1 }}>
        <AppText style={{ fontWeight: "700", fontSize: font.lg }}>{label}</AppText>
        {detail ? <AppText variant="small">{detail}</AppText> : null}
      </View>
      {badge ? (
        <View style={[styles.badge, { backgroundColor: t.danger }]}>
          <AppText style={{ color: "#fff", fontWeight: "800", fontSize: 12 }}>{badge > 99 ? "99+" : badge}</AppText>
        </View>
      ) : null}
      <Ionicons name="chevron-forward" size={22} color={t.textMuted} />
    </Pressable>
  );
}

export default function More() {
  const t = useTheme();
  const { me, outlet, switchOutlet, logout, access } = useSignedIn();
  const items = moreItems(access);
  const platformAdmin = !!me.platformAdmin;
  const groups = platformAdmin ? groupByBusiness(me.outlets) : [{ name: "", outlets: me.outlets }];
  const businessName = me.business?.name ?? outlet?.businessName ?? null;
  // Hotel logo + name for business users (platform admins keep the CANAVO identity).
  const hotel = useBusinessBrand();
  const { unread } = useNotifications();
  const { pendingCount, syncing, syncNow, online, lastError, failed } = useOffline();
  const cart = useCart();
  const [switching, setSwitching] = useState<string | null>(null);

  const changeOutlet = async (id: string) => {
    if (id === outlet?.id) return;
    const go = async () => {
      setSwitching(id);
      cart.clear();
      await switchOutlet(id);
      setSwitching(null);
    };
    if (cart.count) {
      Alert.alert("Switch outlet?", "The current cart will be cleared.", [
        { text: "Cancel", style: "cancel" },
        { text: "Switch", style: "destructive", onPress: go },
      ]);
    } else await go();
  };

  const confirmLogout = () => {
    const warn = pendingCount
      ? `${pendingCount} offline bill(s) haven't synced yet. They stay on this phone and sync after you sign in again.`
      : "You'll need to sign in again.";
    Alert.alert("Sign out?", warn, [
      { text: "Cancel", style: "cancel" },
      { text: "Sign out", style: "destructive", onPress: () => void logout() },
    ]);
  };

  return (
    <Screen>
      <Card style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
        <View style={[styles.avatar, { backgroundColor: brand.saffron }]}>
          <AppText style={{ color: "#fff", fontSize: 26, fontWeight: "900" }}>{me.name.slice(0, 1).toUpperCase()}</AppText>
        </View>
        <View style={{ flex: 1 }}>
          <AppText variant="h3">{me.name}</AppText>
          <AppText variant="muted">
            {platformAdmin ? (me.platformRole === "PLATFORM_SUPPORT" ? "Platform support" : "Platform admin") : (me.customRole?.name ?? ROLE_LABELS[me.role])}
            {businessName ? ` · ${businessName}` : ""}
          </AppText>
          <AppText variant="small">+91 {me.phone}{me.email ? ` · ${me.email}` : ""}</AppText>
        </View>
      </Card>

      {platformAdmin ? (
        <Notice
          kind="info"
          title="Platform admin"
          message="Pick an outlet below to work in that business. Businesses, modules and platform settings are managed on the CANAVO web console."
        />
      ) : null}

      {me.outlets.length > 1 ? (
        <Card style={{ gap: space.sm }}>
          {hotel ? (
            <Row style={{ gap: space.sm }}>
              <BusinessLogo name={hotel.name} logoUrl={hotel.logoUrl} size={36} />
              <AppText variant="h3" style={{ flex: 1 }} numberOfLines={1}>
                {hotel.name}
              </AppText>
            </Row>
          ) : null}
          <AppText variant={hotel ? "small" : "h3"} style={hotel ? { fontWeight: "800", textTransform: "uppercase" } : undefined}>
            {platformAdmin ? "Business & outlet" : "Outlet"}
          </AppText>
          {me.role === "BUSINESS_OWNER" ? <AppText variant="small">All outlets of {businessName ?? "your business"}</AppText> : null}
          {groups.map((g) => (
            <View key={g.name || "outlets"} style={{ gap: space.sm }}>
              {platformAdmin ? (
                <AppText variant="small" style={{ fontWeight: "800", textTransform: "uppercase", marginTop: space.xs }}>
                  {g.name}
                </AppText>
              ) : null}
              {g.outlets.map((o) => {
                const active = o.id === outlet?.id;
                return (
                  <Pressable
                    key={o.id}
                    onPress={() => changeOutlet(o.id)}
                    accessibilityRole="radio"
                    accessibilityState={{ checked: active }}
                    accessibilityLabel={platformAdmin && o.businessName ? `${o.businessName}, ${o.name}` : o.name}
                    style={[styles.outlet, { borderColor: active ? t.primary : t.border, backgroundColor: active ? t.surfaceAlt : t.surface }]}
                  >
                    <Ionicons name={active ? "radio-button-on" : "radio-button-off"} size={22} color={active ? t.primary : t.textMuted} />
                    <AppText style={{ flex: 1, fontWeight: "700" }}>{o.name}</AppText>
                    {switching === o.id ? <AppText variant="small">Switching…</AppText> : null}
                  </Pressable>
                );
              })}
            </View>
          ))}
        </Card>
      ) : outlet ? (
        <Card style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
          {hotel ? <BusinessLogo name={hotel.name} logoUrl={hotel.logoUrl} size={48} /> : null}
          <View style={{ flex: 1 }}>
            <AppText variant="small">{businessName && businessName !== outlet.name ? businessName : "Outlet"}</AppText>
            <AppText variant="h3">{outlet.name}</AppText>
          </View>
        </Card>
      ) : (
        <Notice kind="warning" message="No outlet assigned yet. Ask your business owner to add you to an outlet." />
      )}

      <Card style={{ paddingVertical: space.xs }}>
        <NavRow
          icon="notifications-outline"
          label="Notifications"
          detail={unread ? `${unread} unread` : "All caught up"}
          badge={unread}
          onPress={() => router.push("/notifications")}
        />
        {items.includes("delivery-board") ? (
          <NavRow icon="bicycle-outline" label="Delivery board" detail="Assign agents, track active deliveries" onPress={() => router.push("/delivery-board")} />
        ) : null}
        {items.includes("delivery-partners") ? (
          <NavRow
            icon="wallet-outline"
            label="Delivery partners"
            detail="Cash to receive, daily activity, record handovers"
            onPress={() => router.push("/delivery-partners")}
          />
        ) : null}
        {items.includes("inventory") ? (
          <NavRow icon="cube-outline" label="Inventory" detail="Stock, barcode scan, wastage, stock count" onPress={() => router.push("/inventory")} />
        ) : null}
        {items.includes("customers") ? (
          <NavRow icon="people-outline" label="Customers" detail="Loyalty, khata settle & reminders" onPress={() => router.push("/customers")} />
        ) : null}
        {items.includes("attendance") ? (
          <NavRow icon="calendar-outline" label="Attendance & leave" onPress={() => router.push("/attendance")} />
        ) : null}
        {items.includes("staff-attendance") ? (
          <NavRow
            icon="people-circle-outline"
            label="Staff attendance"
            detail="Daily register: mark present, half day, absent, leave"
            onPress={() => router.push("/staff-attendance")}
          />
        ) : null}
        {items.includes("outlet-info") ? (
          <NavRow icon="storefront-outline" label="Outlet info" detail="Address, GST, UPI ID" onPress={() => router.push("/outlet-info")} />
        ) : null}
        {items.includes("printer") ? (
          <NavRow icon="print-outline" label="Printer settings" detail="Bluetooth thermal / system print" onPress={() => router.push("/printer")} />
        ) : null}
      </Card>

      {access.permissions.includes("order:create") || pendingCount || failed.length ? (
        <Card style={{ gap: space.sm }}>
          <Row style={{ justifyContent: "space-between" }}>
            <AppText variant="h3">Offline bills</AppText>
            <AppText color={online ? t.success : t.danger} style={{ fontWeight: "800" }}>
              {online ? "Online" : "Offline"}
            </AppText>
          </Row>
          <AppText variant="muted">
            {pendingCount ? `${pendingCount} bill(s) waiting to sync.` : "Everything is synced."}
          </AppText>
          {lastError ? <Notice kind="error" message={`Last sync: ${lastError}`} /> : null}
          {failed.map((f) => (
            <Notice
              key={f.clientOrderId}
              kind="error"
              title={`Bill from ${formatDate(f.createdAt)} could not sync`}
              message={f.lastError ?? "Rejected by server"}
            />
          ))}
          <Button title="Sync now" icon="sync" variant="secondary" loading={syncing} disabled={!online} onPress={syncNow} />
        </Card>
      ) : null}

      <Button title="Sign out" icon="log-out-outline" variant="danger" onPress={confirmLogout} />
      <AppText variant="small" style={{ textAlign: "center" }}>
        CANAVO v{Constants.expoConfig?.version ?? "0.1.0"} · {API_URL}
      </AppText>
    </Screen>
  );
}

const styles = StyleSheet.create({
  badge: { minWidth: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 },
  avatar: { width: 60, height: 60, borderRadius: 30, alignItems: "center", justifyContent: "center" },
  navRow: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: TAP + 8, borderBottomWidth: StyleSheet.hairlineWidth, paddingHorizontal: space.xs },
  outlet: { flexDirection: "row", alignItems: "center", gap: space.md, minHeight: TAP, borderWidth: 1.5, borderRadius: radius.md, paddingHorizontal: space.md },
});
