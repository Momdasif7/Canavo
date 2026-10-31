import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { endpoints } from "../lib/api";
import { getSocket } from "../lib/socket";
import { ANDROID_CHANNEL_NORMAL, ANDROID_CHANNEL_URGENT, channelForKind } from "./links";

/**
 * Expo push registration.
 *
 * - Permission is requested after sign-in (never on the login screen).
 * - The Expo push token needs the EAS project id (`extra.eas.projectId` in the
 *   app config, set via EAS_PROJECT_ID). Without it — or on a simulator — we
 *   skip quietly with a dev log; in-app notifications still work.
 * - The token is remembered in SecureStore so logout can unregister it.
 */
const TOKEN_KEY = "canavo.pushToken";
export const ANDROID_CHANNEL_ID = ANDROID_CHANNEL_NORMAL;

const devLog = (...args: unknown[]) => {
  if (__DEV__) console.log("[push]", ...args);
};

/** `data.canavoLocal` marks the sound-only local alert we post for an urgent in-app banner. */
const LOCAL_FLAG = "canavoLocal";

let handlerSet = false;
/**
 * Foreground presentation:
 * - our local "sound" alert for an urgent in-app banner: sound only, no system banner;
 * - a remote push while the live socket is connected: silent (the socket already
 *   showed the in-app banner, so it isn't shown twice);
 * - otherwise (socket down): show it like normal.
 */
export function configureNotificationHandler() {
  if (handlerSet || Platform.OS === "web") return;
  handlerSet = true;
  Notifications.setNotificationHandler({
    handleNotification: async (n) => {
      const data = (n.request.content.data ?? {}) as Record<string, unknown>;
      if (data[LOCAL_FLAG]) return { shouldShowAlert: false, shouldPlaySound: true, shouldSetBadge: false };
      const live = !!getSocket()?.connected;
      return { shouldShowAlert: !live, shouldPlaySound: !live, shouldSetBadge: true };
    },
  });
}

/**
 * Ring for an urgent in-app notification (KOT, order ready, delivery, table,
 * payment) via a local notification on the urgent channel — no extra audio
 * dependency. Removed from the tray right after, since the in-app banner is
 * what the user sees.
 */
export async function playAlertSound(kind: string | undefined, title: string, body: string): Promise<void> {
  if (Platform.OS === "web") return;
  try {
    const perm = await Notifications.getPermissionsAsync();
    if (perm.status !== "granted") return;
    const id = await Notifications.scheduleNotificationAsync({
      content: { title, body, sound: "default", data: { [LOCAL_FLAG]: true, kind } },
      trigger: Platform.OS === "android" ? { channelId: channelForKind(kind) } : null,
    });
    setTimeout(() => void Notifications.dismissNotificationAsync(id).catch(() => undefined), 4000);
  } catch (e) {
    devLog("Alert sound failed", e);
  }
}

export function easProjectId(): string | null {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? Constants.easConfig?.projectId ?? null;
}

/**
 * Android channels (created once; the user can tune each in system settings):
 * - "urgent": new KOTs, ready orders, deliveries, tables needing attention, payments — max importance, sound, vibration;
 * - "default": everything else (low stock, leave, attendance, reports) — normal importance.
 * Pushes without a channelId land in "default"; the API should send channelId "urgent" for urgent kinds.
 */
export async function ensureAndroidChannels() {
  if (Platform.OS !== "android") return;
  // Android 13+: creating the first channel is what lets the permission prompt appear.
  await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_URGENT, {
    name: "Urgent: orders & deliveries",
    description: "New KOTs, orders ready, delivery updates, tables needing attention, payments",
    importance: Notifications.AndroidImportance.MAX,
    vibrationPattern: [0, 400, 200, 400],
    lightColor: "#FF6B35",
    sound: "default",
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PUBLIC,
  });
  await Notifications.setNotificationChannelAsync(ANDROID_CHANNEL_NORMAL, {
    name: "General",
    description: "Low stock, leave, attendance and report alerts",
    importance: Notifications.AndroidImportance.DEFAULT,
    vibrationPattern: [0, 200],
    lightColor: "#FF6B35",
    sound: "default",
  });
}

export type PushResult =
  | { ok: true; token: string }
  | { ok: false; reason: "web" | "simulator" | "no-project-id" | "denied" | "error"; message?: string };

export async function registerForPush(): Promise<PushResult> {
  if (Platform.OS === "web") return { ok: false, reason: "web" };
  try {
    await ensureAndroidChannels();
    if (!Device.isDevice) {
      devLog("Simulator/emulator: push tokens need a real device — skipping.");
      return { ok: false, reason: "simulator" };
    }
    const projectId = easProjectId();
    if (!projectId) {
      devLog("No extra.eas.projectId in app config (set EAS_PROJECT_ID) — skipping push registration.");
      return { ok: false, reason: "no-project-id" };
    }
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== "granted") status = (await Notifications.requestPermissionsAsync()).status;
    if (status !== "granted") return { ok: false, reason: "denied" };

    const { data: token } = await Notifications.getExpoPushTokenAsync({ projectId });
    await endpoints.registerDevice(token, Platform.OS === "ios" ? "ios" : "android");
    await SecureStore.setItemAsync(TOKEN_KEY, token);
    devLog("Registered", token);
    return { ok: true, token };
  } catch (e) {
    devLog("Registration failed", e);
    return { ok: false, reason: "error", message: e instanceof Error ? e.message : String(e) };
  }
}

/** Remove this device's token from the server. Call BEFORE the session is cleared. */
export async function unregisterPush(): Promise<void> {
  const token = await SecureStore.getItemAsync(TOKEN_KEY).catch(() => null);
  if (!token) return;
  try {
    await endpoints.unregisterDevice(token);
  } catch (e) {
    devLog("Unregister failed (token stays until it is re-assigned or expires)", e);
  }
  await SecureStore.deleteItemAsync(TOKEN_KEY).catch(() => undefined);
}
