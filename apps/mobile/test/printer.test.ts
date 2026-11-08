/** Bluetooth ESC/POS printer: control-character stripping, disconnect → reconnect, fallback to the system dialog. */
import { Platform, PermissionsAndroid } from "react-native";

const mockBt = {
  BluetoothManager: {
    connect: jest.fn(async (_a: string) => undefined),
    isBluetoothEnabled: jest.fn(async () => true),
    enableBluetooth: jest.fn(async () => undefined),
    scanDevices: jest.fn(async () => JSON.stringify({ paired: [JSON.stringify({ name: "RPP02N", address: "AA:BB" })], found: [{ address: "AA:BB" }, { address: "CC:DD" }] })),
  },
  BluetoothEscposPrinter: {
    printText: jest.fn(async (_t: string, _o: object) => undefined),
    cutPaper: jest.fn(async () => undefined),
  },
};
jest.mock("@vardrz/react-native-bluetooth-escpos-printer", () => mockBt, { virtual: false });
jest.mock("expo-print", () => ({ printAsync: jest.fn(async () => undefined) }));

beforeAll(() => {
  Object.defineProperty(Platform, "OS", { get: () => "android" });
  Object.defineProperty(Platform, "Version", { get: () => 34 });
  jest.spyOn(PermissionsAndroid, "requestMultiple").mockImplementation(async (perms) =>
    Object.fromEntries(perms.map((p) => [p, PermissionsAndroid.RESULTS.GRANTED])) as never,
  );
});
beforeEach(() => jest.clearAllMocks());

import { createBluetoothPrinter, escposText } from "../src/printing/bluetooth";

describe("escposText", () => {
  it("drops C0/C1 control characters (ESC p drawer kick, GS V cut, NUL) and spells the rupee sign", () => {
    const evil = "Paneer\u001bp\u0000\u0019ú Tikka\u001dV\u0001 \u0085note\u007f";
    const out = escposText([evil, "Total ₹250"]);
    expect(out).toBe("Paneerpú TikkaV note\nTotal Rs250\n\n\n");
    // eslint-disable-next-line no-control-regex
    expect(out.replace(/\n/g, "")).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });
  it("keeps Devanagari / accented text", () => {
    expect(escposText(["पनीर टिक्का", "Crème brûlée"])).toBe("पनीर टिक्का\nCrème brûlée\n\n\n");
  });
});

describe("Bluetooth printer", () => {
  it("scans paired + found devices without duplicates", async () => {
    const p = createBluetoothPrinter()!;
    expect(await p.scan()).toEqual([
      { name: "RPP02N", address: "AA:BB" },
      { name: "CC:DD", address: "CC:DD" },
    ]);
  });

  it("connects once, prints sanitised text and cuts", async () => {
    const p = createBluetoothPrinter()!;
    await p.connect("AA:BB");
    await p.connect("AA:BB");
    expect(mockBt.BluetoothManager.connect).toHaveBeenCalledTimes(1);
    await p.printLines(["Hello\u001bp"], 58);
    expect(mockBt.BluetoothEscposPrinter.printText).toHaveBeenCalledWith("Hellop\n\n\n", expect.anything()); // ESC dropped, "p" is inert text
    expect(mockBt.BluetoothEscposPrinter.cutPaper).toHaveBeenCalled();
  });

  it("printer switched off after connecting → reconnects once and the bill still prints", async () => {
    const p = createBluetoothPrinter()!;
    await p.connect("AA:BB");
    mockBt.BluetoothEscposPrinter.printText.mockRejectedValueOnce(new Error("Connection lost"));
    await p.printLines(["Bill"], 58);
    expect(mockBt.BluetoothManager.connect).toHaveBeenCalledTimes(2);
    expect(mockBt.BluetoothEscposPrinter.printText).toHaveBeenCalledTimes(2);
  });

  it("printer still off → error surfaces, and the next print reconnects instead of failing forever", async () => {
    const p = createBluetoothPrinter()!;
    await p.connect("AA:BB");
    mockBt.BluetoothEscposPrinter.printText.mockRejectedValueOnce(new Error("Connection lost"));
    mockBt.BluetoothManager.connect.mockRejectedValueOnce(new Error("Unable to connect"));
    await expect(p.printLines(["Bill"], 58)).rejects.toThrow("Unable to connect");
    // printer back on: connect() no longer short-circuits on the stale cached address
    await p.connect("AA:BB");
    expect(mockBt.BluetoothManager.connect).toHaveBeenCalledTimes(3);
    await p.printLines(["Bill"], 58);
    expect(mockBt.BluetoothEscposPrinter.printText).toHaveBeenLastCalledWith("Bill\n\n\n", expect.anything());
  });

  it("a printer without a cutter is fine", async () => {
    const p = createBluetoothPrinter()!;
    await p.connect("AA:BB");
    mockBt.BluetoothEscposPrinter.cutPaper.mockRejectedValueOnce(new Error("unsupported"));
    await expect(p.printLines(["x"], 80)).resolves.toBeUndefined();
  });

  it("Bluetooth permission denied → clear error", async () => {
    (PermissionsAndroid.requestMultiple as jest.Mock).mockResolvedValueOnce({});
    const p = createBluetoothPrinter()!;
    await expect(p.scan()).rejects.toThrow("Bluetooth permission is needed");
  });
});
