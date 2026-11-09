import React, { useCallback, useEffect, useState } from "react";
import { Alert, View } from "react-native";
import { api, endpoints, errorMessage, type FaceStatus } from "../lib/api";
import { formatDate } from "../lib/format";
import { AppText, Button, Card, Notice } from "../components/ui";
import { space } from "../theme";
import { SelfieCapture } from "./SelfieCapture";

/**
 * Gap 7 (CLOCK_IN_FACE_MATCH): the staff member's own consent under the DPDP Act. Shows the notice, records explicit
 * consent to its version together with a reference photo, and lets them retake it or withdraw (which deletes the
 * photo). Saying no changes nothing: clock-in keeps working with PIN + selfie. Hidden when the business has the
 * feature off and the person never consented.
 */
export function FaceCheckCard() {
  const [s, setS] = useState<FaceStatus | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setS(await endpoints.faceStatus());
    } catch {
      setS(null); // module off / offline: nothing to show
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const enrol = async (uri: string) => {
    if (!s) return;
    setBusy(true);
    setError(null);
    try {
      const url = await api.uploadImage(uri, "face-reference.jpg");
      await endpoints.faceConsent(s.version, url);
      setCapturing(false);
      await load();
    } catch (e) {
      setError(errorMessage(e, "Could not save your reference photo"));
      setCapturing(false);
    } finally {
      setBusy(false);
    }
  };

  const withdraw = () =>
    Alert.alert("Withdraw consent?", "Your reference photo is deleted. You can still clock in with your PIN and selfie.", [
      { text: "Keep", style: "cancel" },
      {
        text: "Withdraw",
        style: "destructive",
        onPress: async () => {
          try {
            await endpoints.faceWithdraw();
            await load();
          } catch (e) {
            setError(errorMessage(e));
          }
        },
      },
    ]);

  if (!s || (!s.enabled && !s.consentAt)) return null;
  const outdated = Boolean(s.consentAt) && !s.consented;

  return (
    <Card style={{ gap: space.sm }}>
      <AppText variant="h3">Face check at clock-in</AppText>
      {s.consented ? (
        <>
          <AppText variant="muted">
            On since {formatDate(s.consentAt!)}. Your clock-in selfie is compared with your reference photo by a manager. Selfies are
            deleted after {s.retentionDays} days.
          </AppText>
          <View style={{ flexDirection: "row", gap: space.sm }}>
            <Button title="Retake photo" icon="camera-outline" variant="secondary" size="md" style={{ flex: 1 }} onPress={() => setCapturing(true)} disabled={!s.enabled} />
            <Button title="Withdraw" icon="close-circle-outline" variant="ghost" size="md" style={{ flex: 1 }} onPress={withdraw} />
          </View>
        </>
      ) : (
        <>
          {outdated ? <Notice kind="warning" message="The notice has changed. Read it and agree again to keep face check on." /> : null}
          <AppText>{s.notice}</AppText>
          <Button title="I agree · take reference photo" icon="happy-outline" onPress={() => setCapturing(true)} disabled={!s.enabled} />
          {outdated ? <Button title="Withdraw instead" variant="ghost" size="md" onPress={withdraw} /> : <AppText variant="muted">Optional. If you don&apos;t agree, nothing changes.</AppText>}
        </>
      )}
      {error ? <Notice kind="error" message={error} /> : null}
      <SelfieCapture
        visible={capturing}
        busy={busy}
        title="Reference photo"
        actionLabel="Take reference photo"
        busyLabel="Saving…"
        onCapture={(uri) => void enrol(uri)}
        onCancel={() => setCapturing(false)}
      />
    </Card>
  );
}
