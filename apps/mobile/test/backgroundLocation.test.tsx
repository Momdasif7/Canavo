/**
 * Gap 3 — background location while on a delivery run: the task queues fixes and uploads batches, stops when the
 * server says so; battery-aware options; the hook only runs between pickup and return, on duty, where the outlet
 * allows it; disclosure before the OS prompt; refusal falls back to foreground-only.
 */
import { act, renderHook } from "@testing-library/react-native";
import { mockFetch, tokens } from "./helpers";

const mockLoc = {
  startLocationUpdatesAsync: jest.fn(async (_task: string, _o: object) => undefined),
  stopLocationUpdatesAsync: jest.fn(async () => undefined),
  hasStartedLocationUpdatesAsync: jest.fn(async () => false),
  requestForegroundPermissionsAsync: jest.fn(async (): Promise<object> => ({ status: "granted" })),
  requestBackgroundPermissionsAsync: jest.fn(async (): Promise<object> => ({ status: "granted" })),
  getBackgroundPermissionsAsync: jest.fn(async (): Promise<object> => ({ status: "granted" })),
  Accuracy: { Low: 2, Balanced: 3, High: 4 },
  ActivityType: { OtherNavigation: 4 },
};
jest.mock("expo-location", () => mockLoc);

const Battery = require("expo-battery") as { getBatteryLevelAsync: jest.Mock; isLowPowerModeEnabledAsync: jest.Mock };
const { api } = require("../src/lib/api") as typeof import("../src/lib/api");
const bgl = require("../src/delivery/backgroundLocation") as typeof import("../src/delivery/backgroundLocation");
const { useBackgroundLocation } = require("../src/delivery/useBackgroundLocation") as typeof import("../src/delivery/useBackgroundLocation");
const db = require("../src/lib/db") as typeof import("../src/lib/db");

const fix = (lat: number, agoS: number) => ({ coords: { latitude: lat, longitude: 80.2, accuracy: 12, altitude: null, altitudeAccuracy: null, heading: null, speed: null }, timestamp: Date.now() - agoS * 1000 });
const flush = async () => {
  for (let i = 0; i < 6; i++) await act(async () => void (await Promise.resolve()));
};
const tasks = (globalThis as unknown as { __TASKS__: Map<string, (a: object) => Promise<void>> }).__TASKS__;

beforeAll(async () => {
  await api.setTokens(tokens);
});
beforeEach(async () => {
  jest.clearAllMocks();
  await db.clearLocations();
  await bgl.writeChoice(null);
});

describe("background task", () => {
  it("is defined at module load under its fixed name", () => {
    expect(tasks.has(bgl.BACKGROUND_LOCATION_TASK)).toBe(true);
  });

  it("queues the OS fixes and uploads them as one batch with timestamps (background: true)", async () => {
    const calls = mockFetch(() => ({ status: 200, body: { accepted: 2, stop: false } }));
    await tasks.get(bgl.BACKGROUND_LOCATION_TASK)!({ data: { locations: [fix(13.01, 60), fix(13.02, 30)] }, error: null });
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe("/delivery/me/location/batch");
    expect(calls[0].body).toMatchObject({ background: true, points: [{ lat: 13.01, accuracy: 12 }, { lat: 13.02 }] });
    expect(typeof (calls[0].body as { points: { at: string }[] }).points[0].at).toBe("string");
    expect(await db.peekLocations(50)).toHaveLength(0);
  });

  it("offline: keeps the points and sends them with the next wake-up (offline batching)", async () => {
    let online = false;
    const calls = mockFetch(() => (online ? { status: 200, body: { stop: false } } : "network"));
    await bgl.handleLocations([fix(13.01, 90) as never]);
    expect(await db.peekLocations(50)).toHaveLength(1);
    online = true;
    await bgl.handleLocations([fix(13.02, 30) as never]);
    const last = calls[calls.length - 1].body as { points: unknown[] };
    expect(last.points).toHaveLength(2);
    expect(await db.peekLocations(50)).toHaveLength(0);
  });

  it("server says stop (off duty / run over / setting off) → stops the task and drops the queue", async () => {
    mockLoc.hasStartedLocationUpdatesAsync.mockResolvedValue(true);
    mockFetch(() => ({ status: 409, body: { error: "You are not clocked in", details: { code: "OFF_DUTY", stop: true } } }));
    await bgl.handleLocations([fix(13.01, 5) as never]);
    expect(mockLoc.stopLocationUpdatesAsync).toHaveBeenCalledWith(bgl.BACKGROUND_LOCATION_TASK);
    expect(await db.peekLocations(50)).toHaveLength(0);
    mockLoc.hasStartedLocationUpdatesAsync.mockResolvedValue(false);
  });

  it("back at the outlet (200 with stop:true) → stops", async () => {
    mockLoc.hasStartedLocationUpdatesAsync.mockResolvedValueOnce(true);
    mockFetch(() => ({ status: 200, body: { accepted: 1, backNow: true, stop: true } }));
    await bgl.handleLocations([fix(13.0, 1) as never]);
    expect(mockLoc.stopLocationUpdatesAsync).toHaveBeenCalled();
  });

  it("caps the offline queue so a long dead zone can't fill the phone", async () => {
    mockFetch(() => "network");
    await bgl.handleLocations(Array.from({ length: db.LOCATION_QUEUE_MAX + 30 }, (_, i) => fix(13 + i / 1000, 1) as never));
    expect((await db.peekLocations(1000)).length).toBe(db.LOCATION_QUEUE_MAX);
  });
});

describe("battery-aware options + foreground service", () => {
  it("normal: Balanced every 30 s / 50 m; low battery or low-power mode: Low every 2 min / 200 m", async () => {
    expect(bgl.trackingOptions("normal")).toEqual({ accuracy: 3, timeInterval: 30_000, distanceInterval: 50 });
    expect(bgl.trackingOptions("saver")).toEqual({ accuracy: 2, timeInterval: 120_000, distanceInterval: 200 });
    Battery.getBatteryLevelAsync.mockResolvedValueOnce(0.15);
    expect(await bgl.batteryMode()).toBe("saver");
    Battery.isLowPowerModeEnabledAsync.mockResolvedValueOnce(true);
    expect(await bgl.batteryMode()).toBe("saver");
    expect(await bgl.batteryMode()).toBe("normal");
  });

  it("starts with an Android foreground-service notification and pausing allowed", async () => {
    await bgl.startBackgroundLocation("Delivering 1 order");
    expect(mockLoc.startLocationUpdatesAsync).toHaveBeenCalledWith(
      bgl.BACKGROUND_LOCATION_TASK,
      expect.objectContaining({
        accuracy: 3,
        timeInterval: 30_000,
        pausesUpdatesAutomatically: true,
        showsBackgroundLocationIndicator: true,
        foregroundService: expect.objectContaining({ notificationTitle: "Delivering 1 order" }),
      }),
    );
  });
});

describe("useBackgroundLocation (when it runs, disclosure, fallback)", () => {
  const onRun = { allowed: true, onDuty: true, onRun: true, label: "Delivering 1 order" };

  it("outlet setting off / off duty / not on a run → never asks, never starts", async () => {
    for (const p of [{ ...onRun, allowed: false }, { ...onRun, onDuty: false }, { ...onRun, onRun: false }]) {
      const { result, unmount } = renderHook(() => useBackgroundLocation(p));
      await flush();
      expect(result.current.mode).toBe("off");
      unmount();
    }
    expect(mockLoc.requestBackgroundPermissionsAsync).not.toHaveBeenCalled();
    expect(mockLoc.startLocationUpdatesAsync).not.toHaveBeenCalled();
  });

  it("on a run: prominent disclosure first; Continue → OS prompts → task starts", async () => {
    const { result } = renderHook(() => useBackgroundLocation(onRun));
    await flush();
    expect(result.current.mode).toBe("asking");
    expect(mockLoc.requestBackgroundPermissionsAsync).not.toHaveBeenCalled(); // not before the disclosure
    await act(async () => result.current.accept());
    await flush();
    expect(mockLoc.requestForegroundPermissionsAsync).toHaveBeenCalled();
    expect(mockLoc.requestBackgroundPermissionsAsync).toHaveBeenCalled();
    expect(result.current.mode).toBe("background");
    expect(mockLoc.startLocationUpdatesAsync).toHaveBeenCalledTimes(1);
  });

  it("iOS 'While using' only / Android refuses 'Allow all the time' → foreground-only, no task", async () => {
    mockLoc.requestBackgroundPermissionsAsync.mockResolvedValueOnce({ status: "denied" });
    const { result } = renderHook(() => useBackgroundLocation(onRun));
    await flush();
    await act(async () => result.current.accept());
    await flush();
    expect(result.current.mode).toBe("foreground-only");
    expect(mockLoc.startLocationUpdatesAsync).not.toHaveBeenCalled();
  });

  it("'Not now' is remembered (no nagging) and can be changed later", async () => {
    const { result, unmount } = renderHook(() => useBackgroundLocation(onRun));
    await flush();
    await act(async () => result.current.decline());
    expect(result.current.mode).toBe("foreground-only");
    unmount();
    const again = renderHook(() => useBackgroundLocation(onRun));
    await flush();
    expect(again.result.current.mode).toBe("foreground-only");
    await act(async () => again.result.current.enable());
    expect(again.result.current.mode).toBe("asking");
  });

  it("status not known yet (offline at launch) → a running task is left alone", async () => {
    mockLoc.hasStartedLocationUpdatesAsync.mockResolvedValue(true);
    const { result } = renderHook(() => useBackgroundLocation({ ...onRun, onDuty: false, onRun: false, ready: false }));
    await flush();
    expect(result.current.mode).toBe("off");
    expect(mockLoc.stopLocationUpdatesAsync).not.toHaveBeenCalled();
    mockLoc.hasStartedLocationUpdatesAsync.mockResolvedValue(false);
  });

  it("run ends (back at the outlet) or clock-out → the task is stopped", async () => {
    await bgl.writeChoice("accepted");
    const { result, rerender } = renderHook((p: typeof onRun) => useBackgroundLocation(p), { initialProps: onRun });
    await flush();
    expect(result.current.mode).toBe("background");
    mockLoc.hasStartedLocationUpdatesAsync.mockResolvedValue(true);
    rerender({ ...onRun, onRun: false });
    await flush();
    expect(result.current.mode).toBe("off");
    expect(mockLoc.stopLocationUpdatesAsync).toHaveBeenCalledTimes(1);
    mockLoc.hasStartedLocationUpdatesAsync.mockResolvedValue(false);
  });
});
