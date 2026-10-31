import React, { useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Linking, Modal, Platform, Pressable, StyleSheet, View } from "react-native";
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from "expo-camera";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import { AppText, Button, Input, Row } from "../components/ui";
import { radius, space, useTheme } from "../theme";

const BARCODE_TYPES = ["ean13", "ean8", "upc_a", "upc_e", "code128", "code39", "code93", "itf14", "qr"] as const;
/** Ignore the same code re-read within this window (the camera fires many times a second). */
const SAME_CODE_MS = 2500;

/**
 * Full-screen camera barcode scanner (expo-camera CameraView). Calls
 * `onCode` once per distinct read; the caller closes it or keeps scanning.
 * A manual entry box covers damaged labels and devices without a camera.
 */
export function BarcodeScanner({
  visible,
  onClose,
  onCode,
  title = "Scan barcode",
  hint,
}: {
  visible: boolean;
  onClose: () => void;
  onCode: (code: string) => void;
  title?: string;
  hint?: string;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [permission, requestPermission] = useCameraPermissions();
  const [torch, setTorch] = useState(false);
  const [manual, setManual] = useState("");
  const last = useRef<{ code: string; at: number } | null>(null);

  useEffect(() => {
    if (visible && permission && !permission.granted && permission.canAskAgain) void requestPermission();
  }, [visible, permission, requestPermission]);

  useEffect(() => {
    if (!visible) {
      setTorch(false);
      setManual("");
      last.current = null;
    }
  }, [visible]);

  const handle = (r: BarcodeScanningResult) => {
    const code = r.data?.trim();
    if (!code) return;
    const now = Date.now();
    if (last.current && last.current.code === code && now - last.current.at < SAME_CODE_MS) return;
    last.current = { code, at: now };
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    onCode(code);
  };

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1, backgroundColor: "#000" }}>
        {permission?.granted ? (
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            enableTorch={torch}
            barcodeScannerSettings={{ barcodeTypes: [...BARCODE_TYPES] }}
            onBarcodeScanned={visible ? handle : undefined}
          />
        ) : (
          <View style={[StyleSheet.absoluteFill, styles.center, { padding: space.xl, gap: space.md }]}>
            <Ionicons name="camera-outline" size={56} color="#fff" />
            <AppText style={{ color: "#fff", textAlign: "center" }}>
              Camera access is needed to scan barcodes. You can also type the code below.
            </AppText>
            {permission && !permission.canAskAgain ? (
              <Button title="Open Settings" variant="secondary" icon="settings-outline" onPress={() => Linking.openSettings()} />
            ) : (
              <Button title="Allow camera" icon="camera" onPress={() => void requestPermission()} />
            )}
          </View>
        )}

        <View style={[styles.top, { paddingTop: insets.top + space.sm }]}>
          <Pressable onPress={onClose} style={styles.round} accessibilityRole="button" accessibilityLabel="Close scanner">
            <Ionicons name="close" size={28} color="#fff" />
          </Pressable>
          <AppText style={{ color: "#fff", fontWeight: "800", fontSize: 18, flex: 1, textAlign: "center" }}>{title}</AppText>
          <Pressable onPress={() => setTorch((v) => !v)} style={styles.round} accessibilityRole="button" accessibilityLabel={torch ? "Torch off" : "Torch on"}>
            <Ionicons name={torch ? "flashlight" : "flashlight-outline"} size={26} color="#fff" />
          </Pressable>
        </View>

        {permission?.granted ? (
          <View style={styles.center} pointerEvents="none">
            <View style={[styles.frame, { borderColor: t.primary }]} />
            <AppText style={{ color: "#fff", marginTop: space.md, fontWeight: "700" }}>{hint ?? "Point at the barcode"}</AppText>
          </View>
        ) : null}

        <View style={[styles.bottom, { paddingBottom: insets.bottom + space.md, backgroundColor: t.bg }]}>
          <Row>
            <View style={{ flex: 1 }}>
              <Input
                placeholder="Type barcode / SKU"
                value={manual}
                onChangeText={setManual}
                autoCapitalize="characters"
                returnKeyType="search"
                onSubmitEditing={() => manual.trim() && onCode(manual.trim())}
              />
            </View>
            <Button title="Find" size="md" disabled={!manual.trim()} onPress={() => onCode(manual.trim())} />
          </Row>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  top: { position: "absolute", left: 0, right: 0, top: 0, flexDirection: "row", alignItems: "center", paddingHorizontal: space.md, gap: space.sm },
  round: { width: 52, height: 52, borderRadius: 26, backgroundColor: "rgba(0,0,0,0.45)", alignItems: "center", justifyContent: "center" },
  frame: { width: 280, height: 170, borderWidth: 4, borderRadius: radius.lg },
  bottom: { position: "absolute", left: 0, right: 0, bottom: 0, padding: space.md, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg },
});
