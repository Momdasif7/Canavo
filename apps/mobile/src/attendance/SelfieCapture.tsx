import React, { useEffect, useRef, useState } from "react";
import { Linking, Modal, Pressable, StyleSheet, View } from "react-native";
import { CameraView, useCameraPermissions } from "expo-camera";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { AppText, Button } from "../components/ui";
import { space } from "../theme";

/**
 * Front-camera selfie for clock-in (CLOCK_IN_SELFIE / CLOCK_IN_FACE_MATCH) and for enrolling the face-check reference
 * photo. The photo goes to the manager for review next to the reference photo. `prompt` is the liveness-lite
 * instruction ("Blink twice"): the button unlocks after a short delay so the staff member reads and follows it.
 * No face matching runs on the phone (managed Expo SDK 51 has no face-recognition module; see known-gaps.md §7).
 */
export function SelfieCapture({
  visible,
  busy,
  onCapture,
  onCancel,
  title = "Selfie to clock in",
  actionLabel = "Take selfie",
  busyLabel = "Clocking in…",
  prompt,
}: {
  visible: boolean;
  busy: boolean;
  onCapture: (uri: string) => void;
  onCancel: () => void;
  title?: string;
  actionLabel?: string;
  busyLabel?: string;
  prompt?: string | null;
}) {
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const camera = useRef<CameraView>(null);
  const [ready, setReady] = useState(false);
  const [promptRead, setPromptRead] = useState(!prompt);

  useEffect(() => {
    if (visible && permission && !permission.granted && permission.canAskAgain) void requestPermission();
    if (!visible) setReady(false);
  }, [visible, permission, requestPermission]);

  useEffect(() => {
    if (!visible || !prompt) return setPromptRead(true);
    setPromptRead(false);
    const id = setTimeout(() => setPromptRead(true), PROMPT_READ_MS);
    return () => clearTimeout(id);
  }, [visible, prompt]);

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
          <AppText style={{ color: "#fff", fontWeight: "800", fontSize: 18, flex: 1, textAlign: "center" }}>{title}</AppText>
          <View style={styles.round} />
        </View>
        {permission?.granted ? (
          <View style={[styles.bottom, { paddingBottom: insets.bottom + space.lg, gap: space.md }]}>
            {prompt ? (
              <View style={styles.prompt} accessibilityLiveRegion="polite">
                <AppText style={{ color: "#fff", fontWeight: "900", fontSize: 20, textAlign: "center" }}>{prompt}</AppText>
                <AppText style={{ color: "#fff", textAlign: "center" }}>Do this, then take the selfie. Your manager checks it.</AppText>
              </View>
            ) : null}
            <Button title={busy ? busyLabel : actionLabel} icon="camera" loading={busy} disabled={!ready || busy || !promptRead} onPress={() => void take()} />
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

/** The capture button unlocks after this long, so the liveness prompt is read first. */
export const PROMPT_READ_MS = 1500;

const styles = StyleSheet.create({
  prompt: { backgroundColor: "rgba(0,0,0,0.55)", borderRadius: 16, padding: space.md, gap: 4 },
  center: { alignItems: "center", justifyContent: "center" },
  top: { position: "absolute", top: 0, left: 0, right: 0, flexDirection: "row", alignItems: "center", paddingHorizontal: space.md },
  round: { width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(0,0,0,0.35)" },
  bottom: { position: "absolute", bottom: 0, left: 0, right: 0, paddingHorizontal: space.lg },
});
