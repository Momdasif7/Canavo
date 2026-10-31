import React, { useCallback, useEffect, useState } from "react";
import { Image, View } from "react-native";
import { Screen } from "../src/components/Screen";
import { AppText, Card, ErrorState, Loading, Notice, Row } from "../src/components/ui";
import { endpoints, errorMessage } from "../src/lib/api";
import { mediaUrl } from "../src/lib/media";
import type { Outlet } from "../src/lib/types";
import { space, useTheme } from "../src/theme";
import { withAccess } from "../src/auth/RequireAccess";
import { useSignedIn } from "../src/auth/AuthContext";

function Line({ label, value }: { label: string; value: string | null | undefined }) {
  const t = useTheme();
  return (
    <Row style={{ justifyContent: "space-between", minHeight: 40, borderBottomWidth: 1, borderBottomColor: t.border }}>
      <AppText variant="muted">{label}</AppText>
      <AppText style={{ fontWeight: "700", flexShrink: 1, textAlign: "right" }}>{value || "—"}</AppText>
    </Row>
  );
}

/** Read-only outlet details (settings:view). Changes are made on the web dashboard. */
function OutletInfo() {
  const { outlet: current, allowed } = useSignedIn();
  const [outlet, setOutlet] = useState<Outlet | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setOutlet(await endpoints.currentOutlet());
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, current?.id]);

  if (!outlet && error) return <Screen edges={[]} scroll={false}><ErrorState message={error} onRetry={load} /></Screen>;
  if (!outlet) return <Screen edges={[]} scroll={false}><Loading /></Screen>;
  const gst = outlet.gstEnabled !== false;
  const logo = mediaUrl(outlet.logoUrl);

  return (
    <Screen edges={[]}>
      <Card style={{ gap: space.xs }}>
        {logo ? <Image source={{ uri: logo }} style={{ width: 64, height: 64, borderRadius: 12 }} resizeMode="cover" accessibilityLabel="Outlet logo" /> : null}
        <AppText variant="h2">{outlet.name}</AppText>
        {outlet.legalName ? <AppText variant="muted">{outlet.legalName}</AppText> : null}
        <AppText>{outlet.address}</AppText>
      </Card>
      <Card style={{ gap: 2 }}>
        <Line label="Phone" value={outlet.phone ? `+91 ${outlet.phone}` : null} />
        <Line label="GST" value={gst ? (outlet.compositionScheme ? "Composition scheme" : "Registered") : "Not registered"} />
        {gst ? <Line label="GSTIN" value={outlet.gstin} /> : null}
        <Line label="FSSAI" value={outlet.fssai} />
        <Line label="Prices" value={outlet.pricesIncludeTax ? "Include tax" : "Plus tax"} />
        <Line label="Service charge" value={outlet.serviceChargeEnabled ? `${outlet.serviceChargePercent}%` : "Off"} />
        <Line label="Round off" value={outlet.roundOff ? "On" : "Off"} />
        <Line label="Invoice prefix" value={outlet.invoicePrefix} />
        <Line label="UPI ID" value={outlet.upiVpa} />
        <Line label="Attendance geofence" value={`${outlet.geofenceMeters} m`} />
        <Line label="Max orders per delivery partner" value={String(outlet.maxDeliveriesPerPartner ?? 2)} />
        <Line label="Show item photos on POS" value={outlet.posShowImages === false ? "Off" : "On"} />
      </Card>
      <View>
        <Notice
          kind="info"
          message={allowed("settings:outlet") ? "Edit outlet and GST settings on the CANAVO web dashboard." : "Ask your manager to change outlet details."}
        />
      </View>
    </Screen>
  );
}

export default withAccess(["settings:view"], OutletInfo);
