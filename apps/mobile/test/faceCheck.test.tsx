/**
 * Gap 7 — clock-in face check (manager-review fallback on managed Expo 51): liveness-lite prompt picked and sent with
 * the selfie, the capture button waits for the prompt to be read, consent card (notice → reference photo → consent
 * with version, withdraw), and nothing but URLs + the prompt ever leaves the phone (no face template).
 */
import React from "react";
import { Alert } from "react-native";
import { act, fireEvent, render, renderHook, screen } from "@testing-library/react-native";
import { LIVENESS_PROMPTS } from "@canavo/shared";
import { mockFetch, tokens, type FakeCall } from "./helpers";

jest.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
jest.mock("react-native-safe-area-context", () => {
  const { View } = jest.requireActual("react-native");
  return { SafeAreaView: View, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) };
});
const mockCamera = { granted: true };
jest.mock("expo-camera", () => {
  const R = jest.requireActual("react");
  const { View } = jest.requireActual("react-native");
  const CameraView = R.forwardRef((p: { onCameraReady?: () => void }, ref: React.Ref<unknown>) => {
    R.useImperativeHandle(ref, () => ({ takePictureAsync: async () => ({ uri: "file:///selfie.jpg" }) }));
    R.useEffect(() => p.onCameraReady?.(), []);
    return R.createElement(View, { testID: "camera" });
  });
  return { CameraView, useCameraPermissions: () => [{ granted: mockCamera.granted, canAskAgain: true }, jest.fn()] };
});
jest.mock("expo-location", () => ({
  requestForegroundPermissionsAsync: jest.fn(async () => ({ status: "granted" })),
  hasServicesEnabledAsync: jest.fn(async () => true),
  getCurrentPositionAsync: jest.fn(async () => ({ coords: { latitude: 13, longitude: 80.2, accuracy: 8 }, mocked: false })),
  Accuracy: { Highest: 6 },
}));
jest.mock("expo-local-authentication", () => ({
  hasHardwareAsync: jest.fn(async () => false),
  isEnrolledAsync: jest.fn(async () => false),
  authenticateAsync: jest.fn(),
}));

const { api } = require("../src/lib/api") as typeof import("../src/lib/api");
const { useClock, pickLivenessPrompt } = require("../src/attendance/useClock") as typeof import("../src/attendance/useClock");
const { SelfieCapture, PROMPT_READ_MS } = require("../src/attendance/SelfieCapture") as typeof import("../src/attendance/SelfieCapture");
const { FaceCheckCard } = require("../src/attendance/FaceCheck") as typeof import("../src/attendance/FaceCheck");

const flush = async () => {
  for (let i = 0; i < 8; i++) await act(async () => void (await Promise.resolve()));
};
const status = (over: object = {}) => ({
  enabled: true,
  version: "2026-11-10",
  notice: "Your employer uses face checks at clock-in… You can say no or withdraw at any time.",
  livenessPrompts: [...LIVENESS_PROMPTS],
  retentionDays: 90,
  consented: false,
  consentAt: null,
  consentVersion: null,
  refPhotoUrl: null,
  ...over,
});

beforeAll(async () => {
  await api.setTokens(tokens);
});
beforeEach(() => jest.clearAllMocks());
afterEach(() => jest.useRealTimers());

describe("liveness-lite prompt", () => {
  it("picks one of the shared prompts", () => {
    expect(pickLivenessPrompt(() => 0)).toBe(LIVENESS_PROMPTS[0]);
    expect(pickLivenessPrompt(() => 0.9999)).toBe(LIVENESS_PROMPTS[LIVENESS_PROMPTS.length - 1]);
  });

  it("SELFIE_REQUIRED → a prompt is shown; the selfie upload is sent with it and no face data", async () => {
    let clocked: FakeCall[] = [];
    const calls = mockFetch((c) => {
      if (c.path === "/attendance/me/status") return { status: 200, body: { clockedIn: false, current: null, recent: [] } };
      if (c.path === "/uploads/image") return { status: 201, body: { url: "https://api.test/uploads/files/selfie-0001.jpg" } };
      if (c.path === "/attendance/clock-in") {
        clocked = [...clocked, c];
        return clocked.length === 1
          ? { status: 400, body: { error: "Take a selfie to clock in", details: { code: "SELFIE_REQUIRED" } } }
          : { status: 201, body: { id: "a1", faceCheck: "PENDING_REVIEW" } };
      }
      return { status: 404 };
    });
    const { result } = renderHook(() => useClock("o1"));
    await flush();
    await act(async () => result.current.clock());
    await flush();
    expect(result.current.selfieRequired).toBe(true);
    const prompt = result.current.livenessPrompt;
    expect(LIVENESS_PROMPTS as readonly string[]).toContain(prompt);
    await act(async () => result.current.submitSelfie("file:///selfie.jpg"));
    await flush();
    expect(clocked).toHaveLength(2);
    expect(clocked[1].body).toMatchObject({ selfieUrl: "https://api.test/uploads/files/selfie-0001.jpg", livenessPrompt: prompt });
    expect(clocked[1].body).not.toHaveProperty("faceMatch");
    expect(JSON.stringify(calls.map((c) => c.body))).not.toMatch(/embedding|template|descriptor/i);
    expect(result.current.lastAction).toBe("Clocked in");
  });

  it("the capture button unlocks only after the prompt had time to be read", async () => {
    jest.useFakeTimers();
    const onCapture = jest.fn();
    render(<SelfieCapture visible busy={false} prompt="Blink twice" onCapture={onCapture} onCancel={jest.fn()} />);
    expect(screen.getByText("Blink twice")).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByText("Take selfie")));
    expect(onCapture).not.toHaveBeenCalled();
    await act(async () => void jest.advanceTimersByTime(PROMPT_READ_MS));
    await act(async () => fireEvent.press(screen.getByText("Take selfie")));
    jest.useRealTimers();
    await flush();
    expect(onCapture).toHaveBeenCalledWith("file:///selfie.jpg");
  });
});

describe("FaceCheckCard (DPDP consent)", () => {
  it("feature off and never consented → hidden", async () => {
    mockFetch(() => ({ status: 200, body: status({ enabled: false }) }));
    render(<FaceCheckCard />);
    await flush();
    expect(screen.queryByText("Face check at clock-in")).toBeNull();
  });

  it("notice → I agree → reference photo uploaded → consent sent with the notice version", async () => {
    let s = status();
    const calls = mockFetch((c) => {
      if (c.path === "/attendance/face/me") return { status: 200, body: s };
      if (c.path === "/uploads/image") return { status: 201, body: { url: "https://api.test/uploads/files/ref-000001.jpg" } };
      if (c.path === "/attendance/face/consent" && c.method === "POST") {
        s = status({ consented: true, consentAt: "2026-11-10T04:00:00.000Z", consentVersion: "2026-11-10", refPhotoUrl: "https://api.test/uploads/files/ref-000001.jpg" });
        return { status: 200, body: { consented: true } };
      }
      return { status: 404 };
    });
    render(<FaceCheckCard />);
    await flush();
    expect(screen.getByText(/withdraw at any time/)).toBeTruthy();
    expect(screen.getByText(/nothing changes/)).toBeTruthy();
    await act(async () => fireEvent.press(screen.getByText("I agree · take reference photo")));
    await act(async () => fireEvent.press(screen.getByText("Take reference photo")));
    await flush();
    expect(calls.find((c) => c.path === "/attendance/face/consent")?.body).toEqual({ version: "2026-11-10", refPhotoUrl: "https://api.test/uploads/files/ref-000001.jpg" });
    expect(screen.getByText(/Selfies are\s+deleted after 90 days/)).toBeTruthy();
  });

  it("withdraw (after confirming) deletes the consent", async () => {
    const alert = jest.spyOn(Alert, "alert").mockImplementation((_t, _m, buttons) => void buttons?.find((b) => b.style === "destructive")?.onPress?.());
    let s = status({ consented: true, consentAt: "2026-11-10T04:00:00.000Z", consentVersion: "2026-11-10", refPhotoUrl: "https://api.test/uploads/files/ref-000001.jpg" });
    const calls = mockFetch((c) => {
      if (c.path === "/attendance/face/consent" && c.method === "DELETE") {
        s = status();
        return { status: 204 };
      }
      return { status: 200, body: s };
    });
    render(<FaceCheckCard />);
    await flush();
    await act(async () => fireEvent.press(screen.getByText("Withdraw")));
    await flush();
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/attendance/face/consent")).toBe(true);
    expect(screen.getByText("I agree · take reference photo")).toBeTruthy();
    alert.mockRestore();
  });

  it("notice changed since consent → asks again", async () => {
    mockFetch(() => ({ status: 200, body: status({ consented: false, consentAt: "2026-01-01T00:00:00.000Z", consentVersion: "2026-01-01", refPhotoUrl: "x" }) }));
    render(<FaceCheckCard />);
    await flush();
    expect(screen.getByText(/The notice has changed/)).toBeTruthy();
  });
});
