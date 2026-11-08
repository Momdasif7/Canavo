/**
 * Delivery partner location: permission denied / limited (iOS approximate) / granted, background →
 * foreground, location services off (e.g. battery saver), report failures. The hooks are
 * foreground-only by design (no background task): they must degrade, never crash.
 */
import { act, renderHook } from "@testing-library/react-native";
import { mockFetch, tokens } from "./helpers";

type Cb = (loc: { coords: { latitude: number; longitude: number; accuracy: number | null } }) => void;
const mockWatch: { cb: Cb | null; remove: jest.Mock } = { cb: null, remove: jest.fn() };
const mockLoc = {
  requestForegroundPermissionsAsync: jest.fn(async (): Promise<object> => ({ status: "granted", granted: true })),
  watchPositionAsync: jest.fn(async (_o: object, cb: Cb) => {
    mockWatch.cb = cb;
    return { remove: mockWatch.remove };
  }),
  Accuracy: { High: 4, Balanced: 3 },
};
jest.mock("expo-location", () => mockLoc);

const { api } = require("../src/lib/api") as typeof import("../src/lib/api");
const { useLiveLocation, usePresenceLocation, LOCATION_POST_MS } = require("../src/delivery/useLiveLocation") as typeof import("../src/delivery/useLiveLocation");

const fix = (lat: number, lng: number) => ({ coords: { latitude: lat, longitude: lng, accuracy: 12 } });
const flush = () => act(async () => void (await Promise.resolve()));

beforeAll(async () => {
  await api.setTokens(tokens);
});
beforeEach(() => {
  jest.clearAllMocks();
  mockWatch.cb = null;
});
afterEach(() => jest.useRealTimers());

describe("useLiveLocation (out-for-delivery tracking)", () => {
  it("granted → posts the first fix at once, then every 30 s; stops on unmount", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
    const calls = mockFetch(() => ({ status: 200, body: { remainingKm: 2.4 } }));
    const { result, unmount } = renderHook(() => useLiveLocation(["d1"]));
    await flush();
    await flush();
    expect(result.current.sharing).toBe(true);
    await act(async () => mockWatch.cb!(fix(12.97, 77.59)));
    await flush();
    expect(calls.filter((c) => c.path.includes("/location"))).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ lat: 12.97, lng: 77.59 });
    await act(async () => void (await jest.advanceTimersByTimeAsync(LOCATION_POST_MS)));
    expect(calls).toHaveLength(2);
    expect(result.current.remainingKm.d1).toBe(2.4);
    unmount();
    expect(mockWatch.remove).toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(LOCATION_POST_MS * 3);
    expect(calls).toHaveLength(2);
  });

  it("denied → not sharing, explains why, nothing posted", async () => {
    mockLoc.requestForegroundPermissionsAsync.mockResolvedValueOnce({ status: "denied", granted: false });
    const calls = mockFetch(() => ({ status: 200, body: {} }));
    const { result } = renderHook(() => useLiveLocation(["d1"]));
    await flush();
    await flush();
    expect(result.current.sharing).toBe(false);
    expect(result.current.error).toMatch(/Allow location/);
    expect(mockLoc.watchPositionAsync).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("iOS 'approximate location' (granted, reduced accuracy) still shares", async () => {
    mockLoc.requestForegroundPermissionsAsync.mockResolvedValueOnce({ status: "granted", granted: true, ios: { scope: "whenInUse", accuracy: "reduced" } });
    const calls = mockFetch(() => ({ status: 200, body: { remainingKm: null } }));
    const { result } = renderHook(() => useLiveLocation(["d1"]));
    await flush();
    await flush();
    await act(async () => mockWatch.cb!(fix(12.9, 77.5)));
    await flush();
    expect(result.current.sharing).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("location services off / battery saver (watch fails) → error shown, no crash", async () => {
    mockLoc.watchPositionAsync.mockRejectedValueOnce(new Error("Location services are disabled"));
    const { result } = renderHook(() => useLiveLocation(["d1"]));
    await flush();
    await flush();
    expect(result.current).toMatchObject({ sharing: false, error: "Location services are disabled" });
  });

  it("report fails (offline) → keeps watching and shows the error", async () => {
    mockFetch(() => "network");
    const { result } = renderHook(() => useLiveLocation(["d1"]));
    await flush();
    await flush();
    await act(async () => mockWatch.cb!(fix(1, 1)));
    await flush();
    await flush();
    expect(result.current.sharing).toBe(true);
    expect(result.current.error).toMatch(/reach the server/);
    expect(mockWatch.remove).not.toHaveBeenCalled();
  });

  it("no active deliveries → no permission prompt, no watch", async () => {
    const { result } = renderHook(() => useLiveLocation([]));
    await flush();
    expect(result.current.sharing).toBe(false);
    expect(mockLoc.requestForegroundPermissionsAsync).not.toHaveBeenCalled();
  });
});

describe("usePresenceLocation (back-at-outlet presence)", () => {
  it("denied → permission 'denied'; retry after granting in settings starts watching", async () => {
    mockLoc.requestForegroundPermissionsAsync.mockResolvedValueOnce({ status: "denied", granted: false });
    mockFetch(() => ({ status: 200, body: { backNow: false, atOutlet: false } }));
    const { result } = renderHook(() => usePresenceLocation(true));
    await flush();
    await flush();
    expect(result.current.permission).toBe("denied");
    expect(mockLoc.watchPositionAsync).not.toHaveBeenCalled();
    await act(async () => result.current.retry());
    await flush();
    await flush();
    expect(result.current.permission).toBe("granted");
    expect(mockLoc.watchPositionAsync).toHaveBeenCalledTimes(1);
  });

  it("background → foreground: the same watch resumes reporting; throttled to 20 s / 15 m; onBack fires", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
    let back = false;
    const calls = mockFetch(() => ({ status: 200, body: { backNow: back, atOutlet: back } }));
    const onBack = jest.fn();
    renderHook(() => usePresenceLocation(true, onBack));
    await flush();
    await flush();
    await act(async () => mockWatch.cb!(fix(12.97, 77.59)));
    await flush();
    expect(calls).toHaveLength(1);
    // tiny jitter right after → not due yet
    await act(async () => mockWatch.cb!(fix(12.97001, 77.59001)));
    await flush();
    expect(calls).toHaveLength(1);

    // App backgrounded: the OS stops delivering fixes; nothing is torn down or re-requested.
    await act(async () => void (await jest.advanceTimersByTimeAsync(60_000)));
    const sentWhileAway = calls.length; // standing-still re-sends of the last fix only
    expect(mockLoc.requestForegroundPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(mockWatch.remove).not.toHaveBeenCalled();

    // Foreground again and back at the outlet: next fix reports immediately (moved > 15 m).
    back = true;
    await act(async () => mockWatch.cb!(fix(12.98, 77.6)));
    await flush();
    await flush();
    expect(calls.length).toBe(sentWhileAway + 1);
    expect(onBack).toHaveBeenCalledWith(expect.objectContaining({ backNow: true }));
  });

  it("clocked out → stops watching", async () => {
    mockFetch(() => ({ status: 200, body: { backNow: false } }));
    const { rerender } = renderHook(({ on }) => usePresenceLocation(on), { initialProps: { on: true } });
    await flush();
    await flush();
    rerender({ on: false });
    expect(mockWatch.remove).toHaveBeenCalled();
  });
});
