import React, { useEffect, useRef, useState } from "react";
import { Linking, Modal, Pressable, StyleSheet, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { AppText, Button } from "../components/ui";
import { space } from "../theme";

/**
 * Front-camera selfie for clock-in (hotel feature CLOCK_IN_SELFIE). The photo is stored with
 * the attendance record for the manager; there is no face matching.
 */
export function SelfieCapture({ visible, busy, onCapture, onCancel }: { visible: boolean; busy: boolean; onCapture: (uri: string) => void; onCancel: () => void }) {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (visible && permission && !permission.granted && permission.canAskAgain) void requestPermission();
    if (!visible) setReady(false);
  }, [visible, permission, requestPermission]);

  const take = async () => {
    const photo = await camera.current?.takePictureAsync({ quality: 0.5, skipProcessing: true });
    if (photo?.uri) onCapture(photo.uri);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onCancel} statusBarTranslucent>
      <View style={{ flex: 1, backgroundColor: "#000" }}>
        {permission?.granted ? (
          <CameraView ref={camera} style={StyleSheet.absoluteFill} facing="front" onCameraReady={() => setReady(true)} />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.center, { padding: space.xl, gap: space.md }]}>
            <Ionicons name="camera-outline" size={56} color="#fff" />
            <AppText style={{ color: "#fff", textAlign: "center" }}>Your hotel asks for a selfie when you clock in. Allow camera access to continue.</AppText>
            {permission && !permission.canAskAgain ? (
              <Button title="Open Settings" variant="secondary" icon="settings-outline" onPress={() => Linking.openSettings()} />
            ) : (
              <Button title="Allow camera" icon="camera" onPress={() => void requestPermission()} />
            )}
          </View>
        )}
        <View style={[styles.top, { paddingTop: insets.top + space.sm }]}>
          <Pressable onPress={onCancel} style={styles.round} accessibilityRole="button" accessibilityLabel="Cancel">
            <Ionicons name="close" size={28} color="#fff" />
          </Pressable>
          <AppText style={{ color: "#fff", fontWeight: "800", fontSize: 18, flex: 1, textAlign: "center" }}>Selfie to clock in</AppText>
          <View style={styles.round} />
        </View>
        {permission?.granted ? (
          <View style={[styles.bottom, { paddingBottom: insets.bottom + space.lg }]}>
            <Button title={busy ? "Clocking in…" : "Take selfie"} icon="camera" loading={busy} disabled={!ready || busy} onPress={() => void take()} />
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  center: { alignItems: "center", justifyContent: "center" },
  top: { position: "absolute", top: 0, left: 0, right: 0, flexDirection: "row", alignItems: "center", paddingHorizontal: space.md },
  round: { width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.35)" },
  bottom: { position: "absolute", bottom: 0, left: 0, right: 0, paddingHorizontal: space.lg },
});
