import React from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, StyleSheet, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { radius, space, useTheme } from "../theme";
import { AppText } from "./ui";

/**
 * Bottom sheet built on Modal. Content is wrapped in its own
 * GestureHandlerRootView because Android modals render outside the app root
 * (needed for Swipeable rows inside the sheet).
 */
export function Sheet({
  visible,
  onClose,
  title,
  children,
  maxHeight = "88%",
}: {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  maxHeight?: `${number}%`;
}) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <KeyboardAvoidingView behavior={Platform.OS === "ios" ? "padding" : undefined} style={{ flex: 1 }}>
          <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Close" />
          <View
            style={[
              styles.sheet,
              { backgroundColor: t.bg, maxHeight, paddingBottom: Math.max(insets.bottom, space.lg) },
            ]}
          >
            <View style={[styles.handle, { backgroundColor: t.border }]} />
            {title ? (
              <AppText variant="h2" style={{ paddingHorizontal: space.lg, paddingBottom: space.sm }}>
                {title}
              </AppText>
            ) : null}
            {children}
          </View>
        </KeyboardAvoidingView>
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: "rgba(0,0,0,0.45)" },
  sheet: { borderTopLeftRadius: radius.lg + 6, borderTopRightRadius: radius.lg + 6, paddingTop: space.sm },
  handle: { alignSelf: "center", width: 44, height: 5, borderRadius: 3, marginBottom: space.md },
});
