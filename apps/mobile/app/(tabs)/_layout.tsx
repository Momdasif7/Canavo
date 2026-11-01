import React from "react";
import { View } from "react-native";
import { Redirect, Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { isDeliveryPartner, visibleTabs, type TabName } from "../../src/auth/access";
import { useAuth } from "../../src/auth/AuthContext";
import { Screen } from "../../src/components/Screen";
import { AppText, Button, Loading } from "../../src/components/ui";
import { ChannelsProvider, useChannels } from "../../src/channels/ChannelsContext";
import { PartnerPresenceProvider } from "../../src/delivery/PartnerPresence";
import { useNotifications } from "../../src/notifications/NotificationsContext";
import { space, useTheme } from "../../src/theme";

type IconName = keyof typeof Ionicons.glyphMap;

const icon =
  (name: IconName) =>
  ({ color, size }: { color: string; size: number }) => <Ionicons name={name} color={color} size={size} />;

/** The CANAVO platform admin has no hotel to work in (hotel data is private): point them to the web console. */
function PlatformOnWeb() {
  const { logout } = useAuth();
  const t = useTheme();
  return (
    <Screen scroll={false}>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: space.md, padding: space.xl }}>
        <Ionicons name="desktop-outline" size={48} color={t.primary} />
        <AppText variant="h3" style={{ textAlign: "center" }}>
          The platform console is available on the web
        </AppText>
        <AppText variant="muted" style={{ textAlign: "center" }}>
          Sign in on the CANAVO web app to manage businesses, modules and owner accounts. The mobile app is for hotel staff.
        </AppText>
        <Button title="Log out" variant="secondary" icon="log-out-outline" onPress={() => void logout()} />
      </View>
    </Screen>
  );
}

export default function TabsLayout() {
  const { status, access, outlet, me } = useAuth();
  if (status === "loading") return <Loading />;
  if (status !== "signedIn") return <Redirect href="/login" />;
  if (me?.platformAdmin) return <PlatformOnWeb />;

  return (
    // Delivery partners: availability + "back at the outlet" GPS while clocked in, whichever tab is open.
    <PartnerPresenceProvider enabled={!!outlet && isDeliveryPartner(access)}>
      {/* QR / online orders waiting for staff: badge on the Online tab, buzz on any tab. */}
      <ChannelsProvider>
        <AppTabs />
      </ChannelsProvider>
    </PartnerPresenceProvider>
  );
}

function AppTabs() {
  const { access, outlet } = useAuth();
  const { unread } = useNotifications();
  const channels = useChannels();
  const t = useTheme();

  // Driven by /auth/me effective permissions (role ∩ business modules). Tabs not in the
  // list are hidden (href: null) rather than removed, so routes stay typed.
  // Outlet-scoped tabs need an outlet (e.g. a platform admin before any business has one).
  // A module-off 403 from the channels API (module switched off while the app is open) hides Online too.
  const tabs = (outlet ? visibleTabs(access) : (["index", "more"] as TabName[])).filter((n) => n !== "online" || !channels.off);
  const show = (name: TabName) => (tabs.includes(name) ? undefined : null);
  const waiting = channels.requests?.length ?? 0;

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: t.primary,
        tabBarInactiveTintColor: t.textMuted,
        tabBarStyle: { backgroundColor: t.surface, borderTopColor: t.border, height: 64, paddingBottom: 8, paddingTop: 6 },
        tabBarLabelStyle: { fontSize: 12, fontWeight: "700" },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Home", tabBarIcon: icon("home") }} />
      <Tabs.Screen
        name="bill"
        options={{ title: "Bill", tabBarIcon: icon("receipt"), href: show("bill") }}
      />
      <Tabs.Screen
        name="tables"
        options={{ title: "Tables", tabBarIcon: icon("grid"), href: show("tables") }}
      />
      <Tabs.Screen
        name="deliveries"
        options={{ title: "Deliveries", tabBarIcon: icon("bicycle"), href: show("deliveries") }}
      />
      <Tabs.Screen
        name="cash"
        options={{ title: "Cash", tabBarIcon: icon("wallet"), href: show("cash") }}
      />
      <Tabs.Screen
        name="history"
        options={{ title: "History", tabBarIcon: icon("time"), href: show("history") }}
      />
      <Tabs.Screen
        name="kot"
        options={{ title: "KOT", tabBarIcon: icon("restaurant"), href: show("kot") }}
      />
      <Tabs.Screen
        name="online"
        options={{
          title: "Online",
          tabBarIcon: icon("globe"),
          href: show("online"),
          tabBarBadge: waiting ? (waiting > 99 ? "99+" : waiting) : undefined,
        }}
      />
      <Tabs.Screen
        name="stock"
        options={{ title: "Stock", tabBarIcon: icon("cube"), href: show("stock") }}
      />
      <Tabs.Screen
        name="reports"
        options={{ title: "Reports", tabBarIcon: icon("stats-chart"), href: show("reports") }}
      />
      <Tabs.Screen
        name="more"
        options={{ title: "More", tabBarIcon: icon("menu"), tabBarBadge: unread ? (unread > 99 ? "99+" : unread) : undefined }}
      />
    </Tabs>
  );
}
