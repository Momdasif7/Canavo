import React, { useEffect, useMemo, useState } from "react";
import { Alert, Pressable, ScrollView, StyleSheet, View } from "react-native";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { randomUUID } from "expo-crypto";
import { useSignedIn } from "../../src/auth/AuthContext";
import { Screen } from "../../src/components/Screen";
import { Sheet } from "../../src/components/Sheet";
import { AppText, Button, ErrorState, Loading, Notice } from "../../src/components/ui";
import { ApiError, endpoints, errorMessage } from "../../src/lib/api";
import type { OfflinePaymentMode } from "../../src/lib/db";
import { formatDate, inr } from "../../src/lib/format";
import { useOffline } from "../../src/offline/OfflineContext";
import { posFeatures } from "../../src/auth/access";
import { billFor, isIndianMobile, toOrderInput, useCart } from "../../src/pos/CartContext";
import { CartSheet } from "../../src/pos/CartSheet";
import { codAvailable, isCod } from "../../src/pos/cod";
import { MenuGrid } from "../../src/pos/MenuGrid";
import { withForceConfirm } from "../../src/delivery/forceAssign";
import { useActiveOffers, useCustomerLookup, usePromotionPreview } from "../../src/pos/usePromotions";
import { freeTargets } from "../../src/pos/freeItems";
import { buildProvisionalReceipt, setLastOfflineReceipt } from "../../src/pos/offlineReceipt";
import { useCatalog } from "../../src/pos/useCatalog";
import { brand, font, radius, space, useTheme } from "../../src/theme";
import { withAccess } from "../../src/auth/RequireAccess";

function Bill() {
  const t = useTheme();
  const { me, outlet: outletRef, access, allowed } = useSignedIn();
  const { online, enqueue } = useOffline();
  const cart = useCart();
  const { menu, outlet, loading, error, cachedAt, reload } = useCatalog(outletRef?.id ?? null);
  // Gated on /auth/me effective permissions + modules (customers, offers, delivery, pre-orders, tables).
  const canCollect = allowed("payment:collect");
  // COD = "no payment now" → same permission as POST /orders/:id/cod.
  const features = useMemo(() => ({ ...posFeatures(access), cod: canCollect }), [access, canCollect]);
  const canLookup = features.customers;

  const [cartOpen, setCartOpen] = useState(false);
  const [charging, setCharging] = useState(false);
  const [chargeError, setChargeError] = useState<string | null>(null);
  const [offlinePay, setOfflinePay] = useState<string | null>(null); // clientOrderId awaiting cash/card choice

  const offers = useActiveOffers(features.offers ? outletRef?.id ?? null : null, online);
  const lookup = useCustomerLookup(cart.state.customerPhone, online, canLookup && cartOpen);
  // Runs while billing (not only with the cart open) so Buy-X-Get-Y free items appear as soon as the cart qualifies.
  const { preview, error: previewError, loading: previewLoading, suggestions, fresh } = usePromotionPreview(
    cart.state,
    online,
    outlet ? [outlet.gstEnabled, outlet.pricesIncludeTax, outlet.compositionScheme, outlet.serviceChargeEnabled, outlet.serviceChargePercent, outlet.roundOff].join("|") : "",
  );

  // A module switched off while a delivery / pre-order cart was open → fall back to takeaway.
  const { orderType } = cart.state;
  const { setOrderType } = cart;
  useEffect(() => {
    if ((orderType === "DELIVERY" && !features.delivery) || (orderType === "PRE_ORDER" && !features.preOrder)) setOrderType("TAKEAWAY");
  }, [orderType, features.delivery, features.preOrder, setOrderType]);

  // Free items: add / resize / remove the auto-added lines to match what the cart qualifies for.
  const { syncFree, refreshItems, hydrated } = cart;
  useEffect(() => {
    if (fresh && menu) syncFree(freeTargets(suggestions, menu));
  }, [fresh, suggestions, menu, syncFree]);

  // A restored bill is re-priced against the current menu (removed items dropped).
  useEffect(() => {
    if (menu && hydrated) refreshItems(menu);
  }, [menu, hydrated, refreshItems]);

  // Refresh the menu when the connection comes back after billing offline.
  useEffect(() => {
    if (online && cachedAt) void reload();
  }, [online, cachedAt, reload]);

  const qtyByItem = useMemo(() => {
    const m = new Map<string, number>();
    cart.state.lines.forEach((l) => m.set(l.item.id, (m.get(l.item.id) ?? 0) + l.quantity));
    return m;
  }, [cart.state.lines]);

  const bill = useMemo(() => billFor(cart.state, outlet), [cart.state, outlet]);
  const displayTotal = preview?.bill.grandTotal ?? bill?.grandTotal ?? 0;

  /** Checks the server would reject anyway, with friendlier wording. */
  const validate = (): string | null => {
    const s = cart.state;
    if (lookup.customer?.blocked) return "This customer is blocked.";
    if (s.orderType === "DELIVERY") {
      if (!online) return "Delivery orders need a connection.";
      if (!isIndianMobile(s.customerPhone)) return "Enter the customer's 10-digit mobile number.";
      if (!s.customerName.trim()) return "Enter the customer's name.";
      if (s.delivery.address.trim().length < 5) return "Enter the delivery address.";
    }
    if (s.orderType === "PRE_ORDER") {
      if (!online) return "Pre-orders need a connection.";
      if (!s.scheduledFor) return "Pick when the customer wants the order.";
      if (new Date(s.scheduledFor).getTime() <= Date.now() + 60_000) return "Pre-order time must be in the future.";
    }
    return null;
  };

  const charge = async () => {
    if (!bill || !outletRef) return;
    setChargeError(null);
    const invalid = validate();
    if (invalid) {
      setChargeError(invalid);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      return;
    }
    const clientOrderId = randomUUID();
    if (!online) {
      setOfflinePay(clientOrderId);
      return;
    }
    setCharging(true);
    try {
      const input = toOrderInput(cart.state, { clientOrderId });
      const wantCod = !!input.delivery?.cod && features.cod && codAvailable(cart.state.orderType, online);
      if (input.delivery) input.delivery.cod = wantCod;
      // Chosen partner at the limit / on a run → 409; managers may confirm "Assign anyway?".
      const order = await withForceConfirm((force) =>
        endpoints.createOrder(force && input.delivery ? { ...input, delivery: { ...input.delivery, forceAssign: true } } : input),
      );
      if (!order) return;
      cart.clear();
      setCartOpen(false);
      if (wantCod || isCod(order)) {
        void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        router.push({ pathname: "/cod/[orderId]", params: { orderId: order.id } });
      } else router.push({ pathname: "/payment/[orderId]", params: { orderId: order.id } });
    } catch (e) {
      // Lost connection mid-request: queue it (simple bills only). clientOrderId makes this safe even if the server got it.
      const queueable = cart.state.orderType === "TAKEAWAY" || cart.state.orderType === "DINE_IN";
      if (e instanceof ApiError && e.isNetwork && queueable) setOfflinePay(clientOrderId);
      else setChargeError(errorMessage(e));
    } finally {
      setCharging(false);
    }
  };

  const saveOffline = async (mode: OfflinePaymentMode) => {
    if (!offlinePay || !bill || !outlet || !outletRef) return;
    const createdAt = new Date().toISOString();
    const payload = toOrderInput(cart.state, { clientOrderId: offlinePay, createdAt, offline: true });
    try {
      await enqueue({ clientOrderId: offlinePay, outletId: outletRef.id, payload, paymentMode: mode, grandTotal: bill.grandTotal, createdAt });
      setLastOfflineReceipt(
        buildProvisionalReceipt({
          clientOrderId: offlinePay,
          lines: cart.state.lines,
          bill,
          outlet,
          orderType: cart.state.orderType,
          tableLabel: cart.state.tableLabel,
          cashierName: me.name,
          paymentMode: mode,
          createdAt,
        }),
      );
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      cart.clear();
      setOfflinePay(null);
      setCartOpen(false);
      router.push({ pathname: "/offline-saved", params: { total: String(bill.grandTotal), mode } });
    } catch (e) {
      setOfflinePay(null);
      setChargeError(errorMessage(e, "Could not save the bill on this phone"));
    }
  };

  if (loading && !menu) return <Screen scroll={false}><Loading label="Loading menu…" /></Screen>;
  if (error && !menu) return <Screen scroll={false}><ErrorState message={error} onRetry={reload} /></Screen>;
  if (!menu) return <Screen scroll={false}><Loading /></Screen>;

  return (
    <Screen scroll={false}>
      <MenuGrid
        menu={menu}
        qtyByItem={qtyByItem}
        onAdd={(item, v, a, q) => cart.add(item, v, a, q)}
        showImages={outlet?.posShowImages !== false}
        header={
          <>
            {offers.length ? (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm, paddingRight: space.lg }}>
                {offers.map((o) => (
                  <Pressable
                    key={o.id}
                    onPress={() => Alert.alert(o.name, o.summary)}
                    accessibilityRole="button"
                    accessibilityLabel={`Offer: ${o.name}`}
                    style={[styles.offer, { backgroundColor: t.successBg, borderColor: brand.forest }]}
                  >
                    <Ionicons name="gift" size={16} color={t.success} />
                    <AppText style={{ fontWeight: "800", fontSize: font.sm }} color={t.success} numberOfLines={1}>
                      {o.name}
                    </AppText>
                  </Pressable>
                ))}
              </ScrollView>
            ) : null}
            {cachedAt ? <Notice kind="warning" message={`Using menu saved on ${formatDate(new Date(cachedAt).toISOString())}.`} /> : null}
          </>
        }
      />

      {cart.count > 0 ? (
        <Pressable
          onPress={() => setCartOpen(true)}
          accessibilityRole="button"
          accessibilityLabel={`View cart, ${cart.count} items`}
          style={({ pressed }) => [styles.cartBar, { backgroundColor: t.primary, opacity: pressed ? 0.9 : 1 }]}
        >
          <View style={styles.cartCount}>
            <AppText style={{ color: t.primary, fontWeight: "900" }}>{cart.count}</AppText>
          </View>
          <AppText style={{ color: "#fff", fontSize: font.xl, fontWeight: "900", flex: 1 }}>{bill ? inr(displayTotal) : ""}</AppText>
          <AppText style={{ color: "#fff", fontWeight: "800", fontSize: font.lg }}>View cart</AppText>
          <Ionicons name="chevron-up" size={22} color="#fff" />
        </Pressable>
      ) : null}

      <CartSheet
        visible={cartOpen && !offlinePay}
        onClose={() => setCartOpen(false)}
        bill={bill}
        preview={preview}
        previewError={previewError}
        previewLoading={previewLoading}
        lookup={lookup}
        outlet={outlet}
        charging={charging}
        error={chargeError}
        online={online}
        features={features}
        onCharge={charge}
      />
      <Sheet visible={!!offlinePay} onClose={() => setOfflinePay(null)} title="Save bill offline">
        <View style={{ paddingHorizontal: space.lg, gap: space.md }}>
          <AppText variant="muted">
            No connection. Collect {bill ? inr(bill.grandTotal) : "the amount"} now — the bill syncs automatically when you're back online, and its kitchen ticket reaches the kitchen screen then. UPI QR needs a connection.
          </AppText>
          <Button title="Cash received" icon="cash-outline" size="xl" variant="success" onPress={() => saveOffline("CASH")} />
          <Button title="Card received" icon="card-outline" size="lg" variant="secondary" onPress={() => saveOffline("CARD")} />
        </View>
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  offer: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: 36,
    maxWidth: 240,
    paddingHorizontal: space.md,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
  cartBar: {
    position: "absolute",
    left: space.md,
    right: space.md,
    bottom: space.md,
    minHeight: 64,
    borderRadius: radius.lg,
    flexDirection: "row",
    alignItems: "center",
    gap: space.md,
    paddingHorizontal: space.lg,
    elevation: 8,
    shadowColor: "#000",
    shadowOpacity: 0.25,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  cartCount: { width: 34, height: 34, borderRadius: 17, backgroundColor: "#fff", alignItems: "center", justifyContent: "center" },
});

export default withAccess(["order:create"], Bill);
