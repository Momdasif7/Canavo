/** Push registration: permission granted / denied, token upload, channel ids (incl. urgent), skips. */
import { Platform } from "react-native";
import * as SecureStore from "expo-secure-store";
import { mockFetch, tokens } from "./helpers";

const mockN = {
  getPermissionsAsync: jest.fn(async () => ({ status: "undetermined" })),
  requestPermissionsAsync: jest.fn(async () => ({ status: "granted" })),
  getExpoPushTokenAsync: jest.fn(async (_o: object) => ({ data: "ExponentPushToken[abc]" })),
  setNotificationChannelAsync: jest.fn(async (_id: string, _c: object) => null),
  setNotificationHandler: jest.fn(),
  scheduleNotificationAsync: jest.fn(async (_r: object) => "local-1"),
  dismissNotificationAsync: jest.fn(async () => undefined),
  AndroidImportance: { MAX: 5, DEFAULT: 3 },
  AndroidNotificationVisibility: { PUBLIC: 1 },
};
jest.mock("expo-notifications", () => mockN);
const mockDevice = { isDevice: true };
jest.mock("expo-device", () => ({ __esModule: true, get isDevice() { return mockDevice.isDevice; } }));
const mockConstants = { expoConfig: { extra: { eas: { projectId: "proj-123" } } as Record<string, unknown> }, easConfig: null };
jest.mock("expo-constants", () => ({ __esModule: true, default: mockConstants }));

// required (not imported) so the mock objects above exist when the modules load
const { api } = require("../src/lib/api") as typeof import("../src/lib/api");
const { ANDROID_CHANNEL_NORMAL, ANDROID_CHANNEL_URGENT, channelForKind } = require("../src/notifications/links") as typeof import("../src/notifications/links");
const { playAlertSound, registerForPush, unregisterPush } = require("../src/notifications/push") as typeof import("../src/notifications/push");

let os = "android";
beforeAll(async () => {
  Object.defineProperty(Platform, "OS", { get: () => os });
  await api.setTokens(tokens);
});
beforeEach(() => {
  jest.clearAllMocks();
  os = "android";
  mockDevice.isDevice = true;
  mockConstants.expoConfig.extra = { eas: { projectId: "proj-123" } };
});

describe("registerForPush", () => {
  it("granted → creates both Android channels, uploads the token, remembers it", async () => {
    const calls = mockFetch(() => ({ status: 201, body: {} }));
    const r = await registerForPush();
    expect(r).toEqual({ ok: true, token: "ExponentPushToken[abc]" });
    expect(mockN.setNotificationChannelAsync.mock.calls.map((c) => c[0])).toEqual(["urgent", "default"]);
    expect(mockN.setNotificationChannelAsync.mock.calls[0][1]).toMatchObject({ importance: 5, sound: "default" });
    expect(mockN.getExpoPushTokenAsync).toHaveBeenCalledWith({ projectId: "proj-123" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: "POST", path: "/notifications/devices", body: { token: "ExponentPushToken[abc]", platform: "android" } });
    expect(calls[0].headers.Authorization).toBe("Bearer acc-1");
    expect(await SecureStore.getItemAsync("canavo.pushToken")).toBe("ExponentPushToken[abc]");
  });

  it("denied → no token requested, nothing uploaded", async () => {
    const calls = mockFetch(() => ({ status: 201, body: {} }));
    mockN.requestPermissionsAsync.mockResolvedValueOnce({ status: "denied" });
    expect(await registerForPush()).toEqual({ ok: false, reason: "denied" });
    expect(mockN.getExpoPushTokenAsync).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("already granted → no prompt", async () => {
    mockFetch(() => ({ status: 201, body: {} }));
    mockN.getPermissionsAsync.mockResolvedValueOnce({ status: "granted" });
    await registerForPush();
    expect(mockN.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it("emulator / missing EAS project id → skipped quietly (channels still created)", async () => {
    mockDevice.isDevice = false;
    expect(await registerForPush()).toEqual({ ok: false, reason: "simulator" });
    expect(mockN.setNotificationChannelAsync).toHaveBeenCalled();
    mockDevice.isDevice = true;
    mockConstants.expoConfig.extra = {};
    expect(await registerForPush()).toEqual({ ok: false, reason: "no-project-id" });
  });

  it("token upload fails (offline) → reported as error, not thrown", async () => {
    mockFetch(() => "network");
    const r = await registerForPush();
    expect(r).toMatchObject({ ok: false, reason: "error" });
  });

  it("iOS → platform ios, no Android channels", async () => {
    os = "ios";
    const calls = mockFetch(() => ({ status: 201, body: {} }));
    await registerForPush();
    expect(mockN.setNotificationChannelAsync).not.toHaveBeenCalled();
    expect(calls[0].body).toMatchObject({ platform: "ios" });
  });

  it("logout unregisters the remembered token", async () => {
    await SecureStore.setItemAsync("canavo.pushToken", "ExponentPushToken[abc]");
    const calls = mockFetch(() => ({ status: 204 }));
    await unregisterPush();
    expect(calls[0]).toMatchObject({ method: "DELETE", path: "/notifications/devices/ExponentPushToken%5Babc%5D" });
    expect(await SecureStore.getItemAsync("canavo.pushToken")).toBeNull();
  });
});

describe("channels", () => {
  it("urgent kinds ring on the urgent channel, the rest on default", () => {
    expect(ANDROID_CHANNEL_URGENT).toBe("urgent");
    expect(ANDROID_CHANNEL_NORMAL).toBe("default");
    for (const k of ["kot.new", "order.ready", "delivery.assigned", "delivery", "table.attention", "payment.received", "channel.order", "channel.order.new"])
      expect([k, channelForKind(k)]).toEqual([k, "urgent"]);
    for (const k of ["stock.low", "leave.requested", "attendance.late", "report.daily", "", null, undefined])
      expect([k, channelForKind(k)]).toEqual([k, "default"]);
  });

  it("in-app urgent alert posts a local notification on the urgent channel (only with permission)", async () => {
    jest.useFakeTimers();
    mockN.getPermissionsAsync.mockResolvedValueOnce({ status: "granted" });
    await playAlertSound("kot.new", "New KOT", "Table 4");
    expect(mockN.scheduleNotificationAsync.mock.calls[0][0]).toMatchObject({ trigger: { channelId: "urgent" } });
    mockN.getPermissionsAsync.mockResolvedValueOnce({ status: "denied" });
    await playAlertSound("kot.new", "New KOT", "Table 4");
    expect(mockN.scheduleNotificationAsync).toHaveBeenCalledTimes(1);
    jest.useRealTimers();
  });
});
