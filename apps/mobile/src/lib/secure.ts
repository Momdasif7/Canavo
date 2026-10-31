import * as SecureStore from "expo-secure-store";
import { randomUUID } from "expo-crypto";

const KEYS = {
  access: "canavo.accessToken",
  refresh: "canavo.refreshToken",
  accessExp: "canavo.accessExpiresAt",
  outletId: "canavo.outletId",
  deviceId: "canavo.deviceId",
} as const;

export interface StoredSession {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: number;
}

export async function readSession(): Promise<StoredSession | null> {
  const [accessToken, refreshToken, exp] = await Promise.all([
    SecureStore.getItemAsync(KEYS.access),
    SecureStore.getItemAsync(KEYS.refresh),
    SecureStore.getItemAsync(KEYS.accessExp),
  ]);
  if (!accessToken || !refreshToken) return null;
  return { accessToken, refreshToken, accessExpiresAt: Number(exp) || 0 };
}

export async function writeSession(s: StoredSession): Promise<void> {
  await Promise.all([
    SecureStore.setItemAsync(KEYS.access, s.accessToken),
    SecureStore.setItemAsync(KEYS.refresh, s.refreshToken),
    SecureStore.setItemAsync(KEYS.accessExp, String(s.accessExpiresAt)),
  ]);
}

export async function clearSession(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(KEYS.access),
    SecureStore.deleteItemAsync(KEYS.refresh),
    SecureStore.deleteItemAsync(KEYS.accessExp),
  ]);
}

export const readOutletId = () => SecureStore.getItemAsync(KEYS.outletId);
export const writeOutletId = (id: string) => SecureStore.setItemAsync(KEYS.outletId, id);

/** Stable per-install id, sent with OTP verify so sessions are attributable to a device. */
export async function getDeviceId(): Promise<string> {
  const existing = await SecureStore.getItemAsync(KEYS.deviceId);
  if (existing) return existing;
  const id = randomUUID();
  await SecureStore.setItemAsync(KEYS.deviceId, id);
  return id;
}
