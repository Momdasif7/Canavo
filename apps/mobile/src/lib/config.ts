import Constants from "expo-constants";
import { absoluteUrl, normalizeBase, socketTarget } from "./url";

function resolveApiUrl(): string {
  const fromEnv = process.env.EXPO_PUBLIC_API_URL;
  const fromExtra = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl;
  const url = fromEnv || fromExtra || "http://localhost:4000";
  return normalizeBase(url);
}

/** Base URL of the CANAVO API. Set EXPO_PUBLIC_API_URL (see .env.example). */
export const API_URL = resolveApiUrl();

/** Socket.io target: the API's origin + default `/socket.io` path (a gateway prefix like `/api` is not a namespace). */
export const SOCKET_TARGET = socketTarget(API_URL);

/** Absolute URL for a server-relative path (uploads, QR images…), keeping any gateway prefix. */
export const apiAbsoluteUrl = (pathOrUrl: string) => absoluteUrl(API_URL, pathOrUrl);

export const IS_DEV = __DEV__;
