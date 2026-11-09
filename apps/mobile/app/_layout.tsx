import React from "react";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { AuthProvider } from "../src/auth/AuthContext";
import { NotificationsProvider } from "../src/notifications/NotificationsContext";
import { OfflineProvider } from "../src/offline/OfflineContext";
import { CartProvider } from "../src/pos/CartContext";
import { useTheme } from "../src/theme";
// Gap 3: defines the background location task at startup (the OS may wake the app headless to run it).
import "../src/delivery/backgroundLocation";

function RootStack() {
  const t = useTheme();
  return (
    <>
      <StatusBar style="auto" />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: t.surface },
          headerTintColor: t.text,
          headerTitleStyle: { fontWeight: "700" },
          contentStyle: { backgroundColor: t.bg },
        }}
      >
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="login" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="attendance" options={{ title: "Attendance" }} />
        <Stack.Screen name="staff-attendance" options={{ title: "Staff attendance" }} />
        <Stack.Screen name="printer" options={{ title: "Printer settings" }} />
        <Stack.Screen name="outlet-info" options={{ title: "Outlet info" }} />
        <Stack.Screen name="payment/[orderId]" options={{ title: "Payment" }} />
        <Stack.Screen name="receipt/[orderId]" options={{ headerShown: false, gestureEnabled: false }} />
        <Stack.Screen name="offline-saved" options={{ headerShown: false, gestureEnabled: false }} />
        <Stack.Screen name="cod/[orderId]" options={{ headerShown: false, gestureEnabled: false }} />
        <Stack.Screen name="table/[sessionId]" options={{ title: "Table" }} />
        <Stack.Screen name="table/add" options={{ title: "Add items" }} />
        <Stack.Screen name="delivery-board" options={{ title: "Delivery board" }} />
        <Stack.Screen name="delivery-partners/index" options={{ title: "Delivery partners" }} />
        <Stack.Screen name="delivery-partners/[agentId]" options={{ title: "Partner" }} />
        <Stack.Screen name="inventory/index" options={{ title: "Inventory" }} />
        <Stack.Screen name="inventory/audit" options={{ title: "Stock count" }} />
        <Stack.Screen name="inventory/purchases" options={{ title: "Receive purchases" }} />
        <Stack.Screen name="customers/index" options={{ title: "Customers" }} />
        <Stack.Screen name="customers/[id]" options={{ title: "Customer" }} />
        <Stack.Screen name="notifications" options={{ title: "Notifications" }} />
      </Stack>
    </>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <AuthProvider>
          <NotificationsProvider>
            <OfflineProvider>
              <CartProvider>
                <RootStack />
              </CartProvider>
            </OfflineProvider>
          </NotificationsProvider>
        </AuthProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
