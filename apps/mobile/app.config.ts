import type { ExpoConfig, ConfigContext } from "expo/config";

const PRIMARY = "#FF6B35";

/**
 * Store versions. `version` is the user-visible version; bump `BUILD` for
 * every store upload (Android versionCode / iOS buildNumber must increase).
 * eas.json uses appVersionSource "local", so these values are what ships.
 */
const VERSION = "1.0.0";
const BUILD = 1;

/** EAS project id (from `eas init`). Needed for Expo push tokens. */
const EAS_PROJECT_ID = process.env.EAS_PROJECT_ID;

const LOCATION_WHY =
  "CANAVO uses your location to confirm you are at the outlet when you clock in or out, to pin delivery addresses, and to share your position with the outlet while you are out on a delivery.";
const CAMERA_WHY = "CANAVO uses the camera to scan barcodes on stock items and QR codes.";

export default ({ config }: ConfigContext): ExpoConfig => ({
  ...config,
  name: "CANAVO",
  slug: "canavo",
  scheme: "canavo",
  version: VERSION,
  orientation: "portrait",
  icon: "./assets/icon.png",
  userInterfaceStyle: "automatic",
  primaryColor: PRIMARY,
  backgroundColor: "#FAFAF8",
  splash: {
    image: "./assets/splash.png",
    backgroundColor: PRIMARY,
    resizeMode: "contain",
  },
  notification: {
    icon: "./assets/notification-icon.png",
    color: PRIMARY,
  },
  web: { favicon: "./assets/favicon.png" },
  assetBundlePatterns: ["**/*"],
  ios: {
    bundleIdentifier: "in.canavo.app",
    buildNumber: String(BUILD),
    supportsTablet: true,
    config: { usesNonExemptEncryption: false },
    infoPlist: {
      NSLocationWhenInUseUsageDescription: LOCATION_WHY,
      NSBluetoothAlwaysUsageDescription: "CANAVO connects to Bluetooth thermal printers to print bills and KOTs.",
      NSBluetoothPeripheralUsageDescription: "CANAVO connects to Bluetooth thermal printers to print bills and KOTs.",
      NSCameraUsageDescription: CAMERA_WHY,
      NSFaceIDUsageDescription: "CANAVO uses Face ID to confirm it is really you clocking in.",
    },
  },
  android: {
    package: "in.canavo.app",
    versionCode: BUILD,
    adaptiveIcon: { foregroundImage: "./assets/adaptive-icon.png", backgroundColor: PRIMARY },
    permissions: [
      "ACCESS_FINE_LOCATION",
      "ACCESS_COARSE_LOCATION",
      "BLUETOOTH",
      "BLUETOOTH_ADMIN",
      "BLUETOOTH_CONNECT",
      "BLUETOOTH_SCAN",
      "CAMERA",
      "USE_BIOMETRIC",
      "USE_FINGERPRINT",
      "VIBRATE",
      "POST_NOTIFICATIONS",
    ],
    // Foreground-only location: never request background location on Android.
    blockedPermissions: ["android.permission.ACCESS_BACKGROUND_LOCATION"],
  },
  plugins: [
    "expo-router",
    "expo-secure-store",
    "expo-font",
    [
      "expo-location",
      {
        locationWhenInUsePermission: LOCATION_WHY,
        isIosBackgroundLocationEnabled: false,
        isAndroidBackgroundLocationEnabled: false,
      },
    ],
    ["expo-camera", { cameraPermission: CAMERA_WHY, recordAudioAndroid: false }],
    [
      "expo-notifications",
      { icon: "./assets/notification-icon.png", color: PRIMARY },
    ],
    [
      "expo-local-authentication",
      { faceIDPermission: "CANAVO uses Face ID to confirm it is really you clocking in." },
    ],
  ],
  extra: {
    apiUrl: process.env.EXPO_PUBLIC_API_URL,
    ...(EAS_PROJECT_ID ? { eas: { projectId: EAS_PROJECT_ID } } : {}),
  },
});
